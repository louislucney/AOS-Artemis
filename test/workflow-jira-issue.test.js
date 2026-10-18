import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REAL_DATA_CLAUSE } from "../dist/figma/data-policy.js";
import { readTestsDocument } from "../dist/figma/design-store.js";
import {
  detailTierOf,
  issueStepItems,
  synthesizeCasesFromIssue,
  ticketTestsPath,
  writeTicketTestsFile
} from "../dist/workflow/jira-issue.js";

let dirCounter = 0;

function tempDir() {
  dirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `aos-jira-issue-${process.pid}-${dirCounter}-`));
}

function text(textValue) {
  return { type: "text", text: textValue };
}

function paragraph(value) {
  return { type: "paragraph", content: [text(value)] };
}

function listItem(value, extra = []) {
  return { type: "listItem", content: [paragraph(value), ...extra] };
}

function bulletList(values) {
  return { type: "bulletList", content: values.map((value) => listItem(value)) };
}

function orderedList(values) {
  return { type: "orderedList", content: values.map((value) => listItem(value)) };
}

function doc(nodes) {
  return { type: "doc", version: 1, content: nodes };
}

function issue(overrides = {}) {
  return {
    key: "AOS-1",
    summary: "登录失败",
    description: {
      text: "",
      acceptanceCriteria: [],
      heuristic: true,
      raw: null
    },
    ...overrides
  };
}

test("detailTierOf: AC／≥2 列表项／≥120 非空白字符 → detailed；否则 coarse", () => {
  assert.equal(detailTierOf(issue()), "coarse");

  assert.equal(
    detailTierOf(
      issue({
        description: { text: "首页加载慢", acceptanceCriteria: [], heuristic: true, raw: doc([paragraph("首页加载慢")]) }
      })
    ),
    "coarse"
  );

  assert.equal(
    detailTierOf(
      issue({
        description: {
          text: "- 打开首页\n- 点击登录",
          acceptanceCriteria: [],
          heuristic: true,
          raw: doc([bulletList(["打开首页", "点击登录"])])
        }
      })
    ),
    "detailed"
  );

  assert.equal(
    detailTierOf(
      issue({
        description: { text: "一句话", acceptanceCriteria: ["密码错误应提示"], heuristic: true, raw: doc([paragraph("一句话")]) }
      })
    ),
    "detailed"
  );

  assert.equal(
    detailTierOf(
      issue({
        description: {
          text: "测".repeat(120),
          acceptanceCriteria: [],
          heuristic: true,
          raw: doc([paragraph("测".repeat(120))])
        }
      })
    ),
    "detailed"
  );

  assert.equal(
    detailTierOf(
      issue({
        description: {
          text: "测".repeat(119),
          acceptanceCriteria: [],
          heuristic: true,
          raw: doc([paragraph("测".repeat(119))])
        }
      })
    ),
    "coarse"
  );
});

test("issueStepItems: 有序/无序/嵌套展平；无列表/非 ADF → []", () => {
  const raw = doc([
    paragraph("背景"),
    bulletList(["一", "二"]),
    orderedList(["三"]),
    {
      type: "bulletList",
      content: [listItem("四", [bulletList(["五"])])]
    }
  ]);
  assert.deepEqual(issueStepItems(raw), ["一", "二", "三", "四", "五"]);
  assert.deepEqual(issueStepItems(doc([paragraph("无列表")])), []);
  assert.deepEqual(issueStepItems(null), []);
  assert.deepEqual(issueStepItems("not-adf"), []);
});

test("synthesizeCasesFromIssue: 预期分离 assert／无预期 explore；taskDesc 行序与命名", () => {
  const items = ["打开首页", "输入错误密码，预期：提示密码错误", "点击登录"];
  const raw = doc([bulletList(items)]);
  const cases = synthesizeCasesFromIssue(
    issue({
      description: { text: "- 打开首页\n- 输入错误密码，预期：提示密码错误\n- 点击登录", acceptanceCriteria: [], heuristic: true, raw }
    })
  );
  assert.equal(cases.length, 1);
  const entry = cases[0];
  assert.equal(entry.id, "jira-AOS-1-1");
  assert.equal(entry.name, "登录失败");
  assert.equal(entry.feature, "jira-AOS-1");
  assert.deepEqual(entry.screens, []);
  assert.deepEqual(entry.preconditions, []);
  assert.deepEqual(entry.steps, [
    "探索：打开首页",
    "执行「输入错误密码」，应出现「提示密码错误」",
    "探索：点击登录"
  ]);
  assert.deepEqual(entry.expectations, [
    { kind: "explore" },
    { kind: "assert", text: "提示密码错误" },
    { kind: "explore" }
  ]);
  assert.equal(
    entry.taskDesc,
    [
      REAL_DATA_CLAUSE,
      "用例：登录失败",
      "工单：AOS-1",
      "步骤：打开首页；输入错误密码，预期：提示密码错误；点击登录",
      "预期：提示密码错误"
    ].join("\n")
  );
});

test("synthesizeCasesFromIssue: 无列表→文本行；无文本→summary；summary 空→「验证 <KEY>」", () => {
  const fromText = synthesizeCasesFromIssue(
    issue({
      description: {
        text: "第一步\n\n第二步",
        acceptanceCriteria: [],
        heuristic: true,
        raw: doc([paragraph("第一步"), paragraph("第二步")])
      }
    })
  );
  assert.deepEqual(fromText[0].steps, ["探索：第一步", "探索：第二步"]);

  const fromSummary = synthesizeCasesFromIssue(issue());
  assert.deepEqual(fromSummary[0].steps, ["探索：登录失败"]);
  assert.equal(fromSummary[0].taskDesc.includes("步骤：登录失败"), true);

  const unnamed = synthesizeCasesFromIssue(
    issue({ summary: "", description: { text: "", acceptanceCriteria: [], heuristic: true, raw: null } })
  );
  assert.equal(unnamed[0].name, "验证 AOS-1");
});

test("ticketTestsPath/writeTicketTestsFile: 落盘 design/jira/<KEY>.tests.json、meta.source、可读回、覆盖式", () => {
  const dir = tempDir();
  const now = new Date("2026-10-18T00:00:00.000Z");
  const cases = synthesizeCasesFromIssue(
    issue({ description: { text: "- 打开首页\n- 点击登录", acceptanceCriteria: [], heuristic: true, raw: doc([bulletList(["打开首页", "点击登录"])]) } })
  );
  const jsonPath = writeTicketTestsFile(dir, issue(), cases, now);

  assert.equal(jsonPath, ticketTestsPath(dir, "AOS-1"));
  assert.equal(jsonPath, path.join(dir, "design", "jira", "AOS-1.tests.json"));

  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(parsed.meta.source, "jira:AOS-1");
  assert.equal(parsed.meta.generatedAt, "2026-10-18T00:00:00.000Z");
  assert.equal(parsed.source, "jira:AOS-1");
  assert.deepEqual(parsed.features, [{ key: "jira-AOS-1", name: "AOS-1", screens: [] }]);
  assert.equal(parsed.counts.flows, 1);
  assert.equal(parsed.flows[0].id, "jira-AOS-1-1");

  const document = readTestsDocument(dir, { testsPath: jsonPath });
  assert.equal(document.records[0].taskDesc, cases[0].taskDesc);

  const rewritten = writeTicketTestsFile(dir, issue(), [], now);
  assert.equal(rewritten, jsonPath);
  const after = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(after.counts.flows, 0);
  assert.deepEqual(after.flows, []);
});
