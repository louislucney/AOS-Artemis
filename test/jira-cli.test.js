import assert from "node:assert/strict";
import test from "node:test";

import { runJiraCommand } from "../dist/jira-command.js";
import { loadTestRuntime, makeTempProject } from "./helpers.js";

const JIRA_DOTENV = [
  "JIRA_BASE_URL=https://aos-test.atlassian.net/",
  "JIRA_EMAIL=qa@example.com",
  "JIRA_API_TOKEN=token_123456"
].join("\n");

async function setup({ dotenv = JIRA_DOTENV } = {}) {
  const dir = makeTempProject({ dotenv });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  return {
    dir,
    runtime,
    run: async (argv) => {
      const logs = [];
      const errors = [];
      const code = await runJiraCommand(argv, {
        buildRuntime: async () => ({ runtime, dispose: async () => {} }),
        log: (line) => logs.push(line),
        errorLog: (line) => errors.push(line)
      });
      return { code, logs, errors };
    }
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("jira cli: issue create 字段/标签/Blocks 与 --json 输出", async (t) => {
  const { run } = await setup();
  const stub = stubFetch(async (url, init) => {
    if (url.endsWith("/rest/api/3/issue") && init.method === "POST") {
      return jsonResponse({ id: "1", key: "AOS-9" });
    }
    if (url.endsWith("/rest/api/3/issueLink") && init.method === "POST") {
      return new Response(null, { status: 201 });
    }
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const result = await run([
    "issue", "create",
    "--project-key", "AOS",
    "--summary", "登录 bug",
    "--type", "Bug",
    "--description", "步骤一\n\n期望 x",
    "--label", "regression,qa",
    "--blocks", "AOS-2,AOS-3",
    "--json"
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.issue.key, "AOS-9");
  assert.equal(payload.issue.url, "https://aos-test.atlassian.net/browse/AOS-9");
  assert.deepEqual(payload.blocks, ["AOS-2", "AOS-3"]);

  const create = stub.calls.find((call) => call.url.endsWith("/rest/api/3/issue"));
  const body = JSON.parse(create.init.body);
  assert.equal(body.fields.project.key, "AOS");
  assert.equal(body.fields.issuetype.name, "Bug");
  assert.deepEqual(body.fields.labels, ["regression", "qa"]);
  assert.equal(body.fields.description.type, "doc");
  const linkBodies = stub.calls
    .filter((call) => call.url.endsWith("/rest/api/3/issueLink"))
    .map((call) => JSON.parse(call.init.body));
  assert.deepEqual(linkBodies[0], {
    type: { name: "Blocks" },
    inwardIssue: { key: "AOS-9" },
    outwardIssue: { key: "AOS-2" }
  });
});

test("jira cli: 用法错误 exit 2", async () => {
  const { run } = await setup();
  assert.equal((await run(["issue", "create", "--project-key", "AOS"])).code, 2);
  assert.equal((await run(["issue", "frobnicate"])).code, 2);
  assert.equal(
    (await run(["issue", "create", "--project-key", "AOS", "--summary", "x", "--type", "Epic"])).code,
    2
  );
  assert.equal((await run(["bogus"])).code, 2);
});

test("jira cli: 未配置凭证 exit 1 且给出可行动指引", async () => {
  const { run } = await setup({ dotenv: "" });
  const result = await run(["issue", "transition", "AOS-1", "--to", "Done"]);
  assert.equal(result.code, 1);
  assert.ok(result.errors.some((line) => line.includes("JIRA_BASE_URL")));
});

test("jira cli: issue label 合并增删并 PUT", async (t) => {
  const { run } = await setup();
  const stub = stubFetch(async (url, init) => {
    if (url.includes("/issue/AOS-1?fields=labels")) return jsonResponse({ fields: { labels: ["a", "b"] } });
    if (url.endsWith("/issue/AOS-1") && init.method === "PUT") return new Response(null, { status: 204 });
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const result = await run(["issue", "label", "AOS-1", "--add", "b,c", "--remove", "a", "--json"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.deepEqual(payload.before, ["a", "b"]);
  assert.deepEqual(payload.after, ["b", "c"]);
  const put = stub.calls.find((call) => call.init.method === "PUT");
  assert.deepEqual(JSON.parse(put.init.body), { fields: { labels: ["b", "c"] } });
});

test("jira cli: issue transition 按目标状态名匹配；不匹配列出可用项", async (t) => {
  const { run } = await setup();
  const stub = stubFetch(async (url, init) => {
    if (url.endsWith("/issue/AOS-1/transitions") && (init.method ?? "GET") === "GET") {
      return jsonResponse({
        transitions: [
          { id: "31", name: "Start", to: { name: "In Progress" } },
          { id: "41", name: "Done", to: { name: "Done" } }
        ]
      });
    }
    if (url.endsWith("/issue/AOS-1/transitions") && init.method === "POST") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const matched = await run(["issue", "transition", "AOS-1", "--to", "in progress", "--json"]);
  assert.equal(matched.code, 0);
  const payload = JSON.parse(matched.logs[0]);
  assert.deepEqual(payload.transition, { id: "31", name: "Start", to: "In Progress" });
  const post = stub.calls.find((call) => call.init.method === "POST");
  assert.deepEqual(JSON.parse(post.init.body), { transition: { id: "31" } });

  const missing = await run(["issue", "transition", "AOS-1", "--to", "Frozen"]);
  assert.equal(missing.code, 1);
  assert.ok(missing.errors.some((line) => line.includes("In Progress、Done")));
});

test("jira cli: issue comment 纯新建与 trace 幂等更新", async (t) => {
  const { run } = await setup();
  const marked = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "旧评论" }] },
      { type: "paragraph", content: [{ type: "text", text: "AOS-TRACE:trace-1" }] }
    ]
  };
  let commentCalls = 0;
  const stub = stubFetch(async (url, init) => {
    if (url.includes("/comment?maxResults=")) return jsonResponse({ comments: [{ id: "9", body: marked }] });
    if (url.endsWith("/comment") && init.method === "POST") {
      commentCalls += 1;
      return jsonResponse({ id: "7" });
    }
    if (url.includes("/comment/9") && init.method === "PUT") return new Response(null, { status: 204 });
    if (url.includes("/properties/")) return jsonResponse({});
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const created = await run(["issue", "comment", "AOS-1", "--body", "新评论", "--json"]);
  assert.equal(created.code, 0);
  assert.equal(JSON.parse(created.logs[0]).action, "created");
  assert.equal(commentCalls, 1);

  const updated = await run(["issue", "comment", "AOS-1", "--body", "更新评论", "--trace", "trace-1", "--json"]);
  assert.equal(updated.code, 0);
  assert.equal(JSON.parse(updated.logs[0]).action, "updated");
  assert.equal(commentCalls, 1, "trace 幂等不新建");
});

test("jira cli: issue link 形状", async (t) => {
  const { run } = await setup();
  const stub = stubFetch(async (url, init) => {
    if (url.endsWith("/rest/api/3/issueLink") && init.method === "POST") {
      return new Response(null, { status: 201 });
    }
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const result = await run(["issue", "link", "--inward", "AOS-1", "--outward", "AOS-2", "--json"]);
  assert.equal(result.code, 0);
  const body = JSON.parse(stub.calls[0].init.body);
  assert.deepEqual(body, {
    type: { name: "Blocks" },
    inwardIssue: { key: "AOS-1" },
    outwardIssue: { key: "AOS-2" }
  });
});
