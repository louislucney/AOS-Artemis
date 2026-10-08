import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { aosConfigure } from "../dist/tools/configure.js";
import { jiraIssueAttach, jiraIssueComment, jiraIssueGet, jiraIssueSearch } from "../dist/tools/jira.js";
import { aosStatus } from "../dist/tools/llm.js";
import { usageFamilyOf } from "../dist/usage/capture.js";
import { loadTestRuntime, makeTempProject, parseToolResult } from "./helpers.js";

const JIRA_DOTENV = [
  "JIRA_BASE_URL=https://aos-test.atlassian.net/",
  "JIRA_EMAIL=qa@example.com",
  "JIRA_API_TOKEN=token_123456"
].join("\n");

const ISSUE_PAYLOAD = {
  id: "10001",
  key: "AOS-1",
  fields: {
    summary: "登录后跳转错误",
    status: { name: "In Progress", statusCategory: { name: "进行中" } },
    issuetype: { name: "Bug" },
    labels: ["regression"],
    project: { key: "AOS", name: "AOS" },
    assignee: { displayName: "张三" },
    reporter: { displayName: "李四" },
    updated: "2026-10-01T00:00:00.000+0800",
    created: "2026-09-01T00:00:00.000+0800",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "打开 App 后应停留在登录页。" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "验收标准" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "无效凭证时提示可见" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "不进入首页" }] }] }
          ]
        }
      ]
    }
  }
};

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
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

test("jira tools: 缺配置返回可行动错误", async () => {
  const dir = makeTempProject();
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const result = await jiraIssueGet(runtime, { key: "AOS-1" });
  assert.equal(result.isError, true);
  const payload = parseToolResult(result);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /JIRA_BASE_URL/);
  assert.equal(payload.howToFix.length, 2);
});

test("jira tools: jira_issue_get 返回规范化上下文", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const stub = stubFetch(async () => jsonResponse(ISSUE_PAYLOAD));
  t.after(stub.restore);

  const result = await jiraIssueGet(runtime, { key: "AOS-1" });
  assert.equal(result.isError, false);
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.issue.key, "AOS-1");
  assert.equal(payload.issue.url, "https://aos-test.atlassian.net/browse/AOS-1");
  assert.equal(payload.issue.status, "In Progress");
  assert.deepEqual(payload.issue.description.acceptanceCriteria, [
    "无效凭证时提示可见",
    "不进入首页"
  ]);
  assert.equal(payload.issue.description.heuristic, true);
  assert.match(payload.issue.description.text, /打开 App 后应停留在登录页。/);
  assert.ok(payload.issue.description.raw);

  const call = stub.calls[0];
  assert.match(call.url, /^https:\/\/aos-test\.atlassian\.net\/rest\/api\/3\/issue\/AOS-1\?fields=/);
  assert.equal(
    call.init.headers.Authorization,
    `Basic ${Buffer.from("qa@example.com:token_123456").toString("base64")}`
  );
});

test("jira tools: 非法 key 不触网", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const stub = stubFetch(async () => jsonResponse({}));
  t.after(stub.restore);
  const result = await jiraIssueGet(runtime, { key: "not a key" });
  assert.equal(result.isError, true);
  assert.equal(parseToolResult(result).ok, false);
  assert.equal(stub.calls.length, 0);
});

test("jira tools: jira_issue_search 分页与字段透传", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const stub = stubFetch(async () =>
    jsonResponse({
      issues: [ISSUE_PAYLOAD],
      isLast: false,
      nextPageToken: "next-tok"
    })
  );
  t.after(stub.restore);

  const result = await jiraIssueSearch(runtime, {
    jql: "project = AOS ORDER BY created DESC",
    limit: 5
  });
  assert.equal(result.isError, false);
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.isLast, false);
  assert.equal(payload.nextPageToken, "next-tok");
  assert.equal(payload.issues[0].key, "AOS-1");
  assert.equal(payload.issues[0].description, undefined);

  const body = JSON.parse(stub.calls[0].init.body);
  assert.equal(body.jql, "project = AOS ORDER BY created DESC");
  assert.equal(body.maxResults, 5);
  assert.ok(body.fields.includes("summary"));
});

test("jira tools: API 错误映射 hint", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const stub = stubFetch(async () => new Response("Unauthorized", { status: 401 }));
  t.after(stub.restore);

  const payload = parseToolResult(await jiraIssueSearch(runtime, { jql: "project = AOS" }));
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 401);
  assert.match(payload.hint, /轮换/);
});

test("jira configure: 三变量写入 .env 且仅回 masked", async () => {
  const dir = makeTempProject();
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const result = await aosConfigure(runtime, {
    apiKey: "sk-test-123",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    makeActive: false,
    jiraSite: "https://aos-test.atlassian.net/",
    jiraEmail: "qa@example.com",
    jiraApiToken: "tok_abcdef"
  });
  assert.equal(result.isError, false);
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.jira.site, "https://aos-test.atlassian.net");
  assert.equal(payload.jira.maskedToken, "****cdef");
  assert.equal(runtime.jiraConfig().configured, true);

  const envText = fs.readFileSync(path.join(dir, ".env"), "utf-8");
  assert.match(envText, /JIRA_BASE_URL=https:\/\/aos-test\.atlassian\.net\n/);
  assert.match(envText, /JIRA_EMAIL=qa@example\.com/);
  assert.match(envText, /JIRA_API_TOKEN=tok_abcdef/);
  assert.ok(!JSON.stringify(payload).includes("tok_abcdef"));
});

test("jira configure: 站点非法与部分提供均拒绝", async () => {
  const dir = makeTempProject();
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const base = {
    apiKey: "sk-test-123",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    makeActive: false
  };
  const badSite = await aosConfigure(runtime, { ...base, jiraSite: "https://jira.example.com", jiraEmail: "a@b.c", jiraApiToken: "x" });
  assert.equal(badSite.isError, true);
  assert.match(parseToolResult(badSite).error, /atlassian\.net/);
  const partial = await aosConfigure(runtime, { ...base, jiraSite: "https://aos-test.atlassian.net" });
  assert.equal(partial.isError, true);
  assert.match(parseToolResult(partial).error, /同时提供/);
});

test("jira status: 就绪与缺失两态", async () => {
  const readyDir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime: readyRuntime } = await loadTestRuntime(readyDir, { env: {} });
  const ready = parseToolResult(await aosStatus(readyRuntime));
  assert.equal(ready.jira.configured, true);
  assert.equal(ready.jira.siteUrl, "https://aos-test.atlassian.net");
  assert.equal(ready.jira.email, "qa@example.com");
  assert.equal(ready.jira.token.present, true);
  assert.equal(ready.jira.token.preview, "****3456");
  assert.deepEqual(ready.jira.missing, []);

  const bareDir = makeTempProject();
  const { runtime: bareRuntime } = await loadTestRuntime(bareDir, { env: {} });
  const bare = parseToolResult(await aosStatus(bareRuntime));
  assert.equal(bare.jira.configured, false);
  assert.equal(bare.jira.token.present, false);
  assert.equal(bare.jira.token.preview, null);
  assert.deepEqual(bare.jira.missing, ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]);
});

test("jira usage: family 归类", () => {
  assert.equal(usageFamilyOf("jira_issue_get"), "jira");
  assert.equal(usageFamilyOf("jira_issue_search"), "jira");
});

test("jira_issue_comment: dryRun 不触网；创建带 marker 页脚，属性无权限不失败", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });

  const dry = parseToolResult(
    await jiraIssueComment(runtime, { key: "AOS-1", body: "摘要", traceId: "trace-x", dryRun: true })
  );
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.idempotent, true);

  const stub = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/comment?maxResults=") && (init.method ?? "GET") === "GET") {
      return jsonResponse({ comments: [] });
    }
    if (u.endsWith("/comment") && init.method === "POST") {
      return jsonResponse({ id: "100" });
    }
    if (u.includes("/properties/")) {
      return new Response("Forbidden", { status: 403 });
    }
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const created = parseToolResult(
    await jiraIssueComment(runtime, { key: "AOS-1", body: "失败摘要\n\n第二段", traceId: "trace-x" })
  );
  assert.equal(created.ok, true);
  assert.equal(created.action, "created");
  assert.equal(created.commentId, "100");
  assert.equal(created.propertySet, false, "属性无权限不失败");
  const post = stub.calls.find((call) => call.init.method === "POST");
  assert.match(JSON.stringify(JSON.parse(post.init.body)), /AOS-TRACE:trace-x/);
});

test("jira_issue_comment: 既有 marker 评论走 PUT 更新（幂等，不再 POST）", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const existingBody = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "旧摘要" }] },
      { type: "paragraph", content: [{ type: "text", text: "AOS-TRACE:trace-y" }] }
    ]
  };
  const stub = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/comment?maxResults=")) return jsonResponse({ comments: [{ id: "77", body: existingBody }] });
    if (u.includes("/comment/77") && init.method === "PUT") return new Response(null, { status: 204 });
    if (u.includes("/properties/")) return jsonResponse({});
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const result = parseToolResult(
    await jiraIssueComment(runtime, { key: "AOS-1", body: "新摘要", traceId: "trace-y" })
  );
  assert.equal(result.action, "updated");
  assert.equal(result.commentId, "77");
  assert.equal(
    stub.calls.some((call) => (call.init.method ?? "GET") === "POST"),
    false
  );
});

test("jira_issue_attach: 去重/超限/越界均跳过；新文件 multipart 上传", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV + "\nAOS_JIRA_ATTACH_MAX_MB=1" });
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  const small = path.join(dir, "artifacts", "report.json");
  fs.writeFileSync(small, '{"ok":true}', "utf-8");
  fs.writeFileSync(path.join(dir, "artifacts", "big.bin"), Buffer.alloc(1.5 * 1024 * 1024, 1));
  const { runtime } = await loadTestRuntime(dir, { env: {} });

  const hash = createHash("sha256").update(fs.readFileSync(small)).digest("hex").slice(0, 8);
  const expectedName = `report-${hash}.json`;

  const stub = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/attachment/meta")) return jsonResponse({ enabled: true, uploadLimit: 10 * 1024 * 1024 });
    if (u.includes("fields=attachment")) {
      return jsonResponse({
        fields: {
          attachment: [{ id: "1", filename: expectedName, size: fs.readFileSync(small).byteLength }]
        }
      });
    }
    if (u.endsWith("/attachments") && init.method === "POST") return jsonResponse([{ id: "9" }]);
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const result = parseToolResult(
    await jiraIssueAttach(runtime, {
      key: "AOS-1",
      files: ["artifacts/report.json", "artifacts/big.bin", "../outside.txt"]
    })
  );
  assert.equal(result.ok, true);
  const byFile = new Map(result.results.map((entry) => [entry.file, entry]));
  assert.equal(byFile.get("artifacts/report.json").status, "skipped-duplicate");
  assert.equal(byFile.get("artifacts/big.bin").status, "skipped-too-large");
  assert.equal(byFile.get("../outside.txt").status, "rejected");
  assert.equal(
    stub.calls.some((call) => String(call.url).endsWith("/attachments")),
    false,
    "去重/超限/越界都不上传"
  );

  fs.writeFileSync(path.join(dir, "artifacts", "extra.txt"), "hello", "utf-8");
  const upload = parseToolResult(
    await jiraIssueAttach(runtime, { key: "AOS-1", files: ["artifacts/extra.txt"] })
  );
  assert.equal(upload.results[0].status, "uploaded");
  const post = stub.calls.find((call) => String(call.url).endsWith("/attachments"));
  assert.equal(post.init.headers["X-Atlassian-Token"], "no-check");
  assert.ok(post.init.body instanceof FormData);
});
