import assert from "node:assert/strict";
import test from "node:test";

import {
  adfBlockquote,
  adfBulletList,
  adfCodeBlock,
  adfDoc,
  adfToText,
  plainTextToAdf
} from "../dist/jira/adf.js";
import {
  findCommentByMarker,
  findCommentByTrace,
  traceMarker,
  upsertMarkedComment,
  upsertTraceComment,
  withTraceMarker
} from "../dist/jira/comments.js";

test("adf builders: paragraphs/lists/code/quote round-trip to text", () => {
  const doc = adfDoc([
    plainTextToAdf("第一段。\n\n第二段。").content ?? [],
    adfBulletList(["一", "二"]),
    adfCodeBlock("const x = 1;", "js"),
    adfBlockquote("引用")
  ].flat());
  const text = adfToText(doc);
  assert.match(text, /第一段。/);
  assert.match(text, /第二段。/);
  assert.match(text, /- 一\n- 二/);
  assert.match(text, /const x = 1;/);
  assert.match(text, /引用/);
});

test("withTraceMarker/findCommentByTrace: footer marker is idempotent and searchable", () => {
  const base = plainTextToAdf("失败摘要");
  const marked = withTraceMarker(base, "trace-1");
  assert.equal(adfToText(marked).includes(traceMarker("trace-1")), true);
  const again = withTraceMarker(marked, "trace-1");
  assert.equal(
    adfToText(again).split(traceMarker("trace-1")).length - 1,
    1,
    "marker appears exactly once after re-application"
  );

  const comments = [
    { id: "1", body: plainTextToAdf("其它") },
    { id: "2", body: marked }
  ];
  assert.deepEqual(findCommentByTrace(comments, "trace-1"), { id: "2" });
  assert.equal(findCommentByTrace(comments, "trace-404"), null);
});

test("upsertTraceComment: creates then updates by marker with best-effort property", async () => {
  const calls = [];
  const client = {
    getComments: async () => [],
    createComment: async (key, body) => {
      calls.push({ op: "create", key, body });
      return "100";
    },
    updateComment: async (key, id, body) => {
      calls.push({ op: "update", key, id, body });
    },
    setCommentProperty: async (key, id, prop) => {
      calls.push({ op: "property", key, id, prop });
      return false;
    }
  };
  const created = await upsertTraceComment(client, "AOS-1", {
    traceId: "trace-9",
    body: plainTextToAdf("摘要")
  });
  assert.deepEqual(created, { action: "created", commentId: "100", propertySet: false });
  assert.equal(calls[0].op, "create");
  assert.equal(calls[1].op, "property");

  const markedBody = withTraceMarker(plainTextToAdf("摘要"), "trace-9");
  const updating = {
    ...client,
    getComments: async () => [{ id: "77", body: markedBody }],
    createComment: async () => {
      throw new Error("不应新建");
    }
  };
  const updated = await upsertTraceComment(updating, "AOS-1", {
    traceId: "trace-9",
    body: plainTextToAdf("摘要 v2")
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.commentId, "77");
});

test("upsertTraceComment: 委派 upsertMarkedComment 且属性键/值不变", async () => {
  const calls = [];
  const client = {
    getComments: async () => [],
    createComment: async () => "5",
    updateComment: async () => {},
    setCommentProperty: async (key, id, prop, value) => {
      calls.push({ key, id, prop, value });
      return false;
    }
  };
  const result = await upsertTraceComment(client, "AOS-1", {
    traceId: "t-1",
    body: plainTextToAdf("x")
  });
  assert.deepEqual(result, { action: "created", commentId: "5", propertySet: false });
  assert.deepEqual(calls, [{ key: "AOS-1", id: "5", prop: "aos-trace", value: { traceId: "t-1" } }]);
});

test("findCommentByMarker: 任意 marker 命中/未命中", () => {
  const comments = [
    { id: "1", body: plainTextToAdf("其它") },
    { id: "2", body: plainTextToAdf("结论\n\nAOS-VERIFY:AOS-2") }
  ];
  assert.deepEqual(findCommentByMarker(comments, "AOS-VERIFY:AOS-2"), { id: "2" });
  assert.equal(findCommentByMarker(comments, "AOS-VERIFY:AOS-9"), null);
});

test("upsertMarkedComment: 无 marker→create＋属性；有 marker→update；property 缺省不写属性", async () => {
  const calls = [];
  const client = {
    getComments: async () => [],
    createComment: async (key, body) => {
      calls.push({ op: "create", key, body });
      return "100";
    },
    updateComment: async (key, id, body) => {
      calls.push({ op: "update", key, id, body });
    },
    setCommentProperty: async (key, id, prop, value) => {
      calls.push({ op: "property", key, id, prop, value });
      return true;
    }
  };
  const created = await upsertMarkedComment(client, "AOS-2", {
    marker: "AOS-VERIFY:AOS-2",
    body: plainTextToAdf("结论"),
    property: { key: "aos-verify", value: { issueKey: "AOS-2" } }
  });
  assert.deepEqual(created, { action: "created", commentId: "100", propertySet: true });
  assert.equal(calls[0].op, "create");
  assert.equal(adfToText(calls[0].body).includes("AOS-VERIFY:AOS-2"), true, "marker 写入正文");
  assert.equal(calls[1].prop, "aos-verify");
  assert.deepEqual(calls[1].value, { issueKey: "AOS-2" });

  const updating = {
    ...client,
    getComments: async () => [{ id: "77", body: plainTextToAdf("结论\n\nAOS-VERIFY:AOS-2") }],
    createComment: async () => {
      throw new Error("不应新建");
    }
  };
  const updated = await upsertMarkedComment(updating, "AOS-2", {
    marker: "AOS-VERIFY:AOS-2",
    body: plainTextToAdf("结论 v2")
  });
  assert.deepEqual(updated, { action: "updated", commentId: "77", propertySet: false });

  const noProperty = {
    ...client,
    setCommentProperty: async () => {
      throw new Error("property 缺省不得调用");
    }
  };
  const plain = await upsertMarkedComment(noProperty, "AOS-3", {
    marker: "AOS-VERIFY:AOS-3",
    body: plainTextToAdf("结论")
  });
  assert.deepEqual(plain, { action: "created", commentId: "100", propertySet: false });
});
