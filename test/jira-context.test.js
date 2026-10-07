import assert from "node:assert/strict";
import test from "node:test";

import { adfToText } from "../dist/jira/adf.js";
import { normalizeJiraSiteUrl, validateJiraSiteUrl } from "../dist/jira/config.js";
import {
  extractAcceptanceCriteria,
  issueSummaryRow,
  normalizeIssue,
  parseIssueKey
} from "../dist/jira/context.js";

function doc(...content) {
  return { type: "doc", version: 1, content };
}

function paragraph(text) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function heading(text) {
  return { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] };
}

function bulletList(items) {
  return {
    type: "bulletList",
    content: items.map((text) => ({
      type: "listItem",
      content: [paragraph(text)]
    }))
  };
}

test("jira adf: 常用节点转纯文本", () => {
  const text = adfToText(
    doc(
      heading("需求"),
      paragraph("用户打开首页。"),
      bulletList(["看到标题", "点击按钮"]),
      { type: "codeBlock", content: [{ type: "text", text: "curl -s s" }] },
      { type: "rule" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "负责人 " },
          { type: "mention", attrs: { text: "@张三" } },
          { type: "hardBreak" },
          { type: "text", text: "结束" }
        ]
      }
    )
  );
  assert.match(text, /需求\n用户打开首页。/);
  assert.match(text, /- 看到标题\n- 点击按钮/);
  assert.match(text, /curl -s s/);
  assert.match(text, /---/);
  assert.match(text, /负责人 @张三\n结束/);
});

test("jira adf: 空值与异常输入安全", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText("not-an-object"), "");
  assert.equal(adfToText({ type: "doc" }), "");
});

test("jira ac: 标题段抽取与 AC: 行回退", () => {
  const sectioned = doc(
    paragraph("背景说明"),
    heading("验收标准"),
    bulletList(["切换账号后回到登录页", "错误提示可见"]),
    paragraph("补充说明")
  );
  assert.deepEqual(extractAcceptanceCriteria(sectioned), [
    "切换账号后回到登录页",
    "错误提示可见",
    "补充说明"
  ]);

  const inline = doc(paragraph("背景"), paragraph("AC: 离线可打开缓存页"));
  assert.deepEqual(extractAcceptanceCriteria(inline), ["离线可打开缓存页"]);

  assert.deepEqual(extractAcceptanceCriteria(doc(paragraph("无验收信息"))), []);
  assert.deepEqual(extractAcceptanceCriteria(null), []);
});

test("jira key: key 与 browse URL 解析", () => {
  assert.equal(parseIssueKey("AOS-123"), "AOS-123");
  assert.equal(parseIssueKey("aos-123"), "AOS-123");
  assert.equal(
    parseIssueKey("https://aos-test.atlassian.net/browse/AOS-42?filter=1"),
    "AOS-42"
  );
  assert.equal(parseIssueKey("https://aos-test.atlassian.net/jira/software/projects/AOS/boards/1?selectedIssue=AOS-7"), "AOS-7");
  assert.equal(parseIssueKey("not a key"), null);
  assert.equal(parseIssueKey(""), null);
});

test("jira site: 仅接受 https://*.atlassian.net 并归一化", () => {
  assert.equal(normalizeJiraSiteUrl("https://aos-test.atlassian.net/"), "https://aos-test.atlassian.net");
  assert.equal(normalizeJiraSiteUrl("https://aos-test.atlassian.net"), "https://aos-test.atlassian.net");
  assert.equal(normalizeJiraSiteUrl("http://aos-test.atlassian.net"), null);
  assert.equal(normalizeJiraSiteUrl("https://aos-test.atlassian.net/jira"), null);
  assert.equal(normalizeJiraSiteUrl("https://jira.example.com"), null);
  assert.match(validateJiraSiteUrl("https://jira.example.com"), /atlassian\.net/);
  assert.equal(validateJiraSiteUrl("https://aos-test.atlassian.net"), null);
});

test("jira issue: normalizeIssue 与摘要行契约", () => {
  const raw = {
    id: "10001",
    key: "AOS-8",
    fields: {
      summary: "支付失败",
      status: { name: "In Progress", statusCategory: { name: "进行中" } },
      issuetype: { name: "Bug" },
      labels: ["regression", 42],
      project: { key: "AOS", name: "AOS" },
      assignee: { displayName: "张三" },
      reporter: { displayName: "李四" },
      updated: "2026-10-01T00:00:00.000+0800",
      created: "2026-09-01T00:00:00.000+0800",
      description: doc(heading("验收标准"), bulletList(["金额正确"]))
    }
  };
  const expected = {
    key: "AOS-8",
    id: "10001",
    url: "https://aos-test.atlassian.net/browse/AOS-8",
    summary: "支付失败",
    status: "In Progress",
    statusCategory: "进行中",
    type: "Bug",
    labels: ["regression"],
    project: "AOS",
    assignee: "张三",
    reporter: "李四",
    updated: "2026-10-01T00:00:00.000+0800",
    created: "2026-09-01T00:00:00.000+0800"
  };
  const normalized = normalizeIssue(raw, "https://aos-test.atlassian.net");
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(normalized[key], value, `${key} 不一致`);
  }
  assert.deepEqual(normalized.description.acceptanceCriteria, ["金额正确"]);
  assert.equal(normalized.description.heuristic, true);
  assert.ok(normalized.description.raw);

  const row = issueSummaryRow(raw, "https://aos-test.atlassian.net");
  assert.equal(row.key, "AOS-8");
  assert.equal(row.status, "In Progress");
  assert.equal(row.type, "Bug");
  assert.equal(row.description, undefined);
});
