import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildEvidenceComment, candidateAttachments } from "../dist/jira/evidence.js";
import { jiraEvidencePost } from "../dist/tools/jira.js";
import { loadTestRuntime, makeTempProject, parseToolResult } from "./helpers.js";

const JIRA_DOTENV = [
  "JIRA_BASE_URL=https://aos-test.atlassian.net/",
  "JIRA_EMAIL=qa@example.com",
  "JIRA_API_TOKEN=token_123456"
].join("\n");

const DEVICE_UDID = "00008101-000359440C69001E";

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

function writeStatus(runtime, traceId, payload) {
  const dir = runtime.traceDir(traceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(payload), "utf-8");
}

test("buildEvidenceComment: 平台/设备/失败清单/崩溃/附件/降级 golden", () => {
  const dir = makeTempProject();
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  const shot = path.join(dir, "evidence", "step-3-post.png");
  fs.writeFileSync(shot, "png", "utf-8");
  const diffDir = path.join(dir, "evidence", "diff");
  fs.mkdirSync(diffDir, { recursive: true });
  const report = path.join(diffDir, "report.json");
  const annotated = path.join(diffDir, "annotated.png");
  fs.writeFileSync(report, "{}", "utf-8");
  fs.writeFileSync(annotated, "png", "utf-8");

  const bundle = {
    ok: true,
    traceId: "trace-1",
    status: "failed",
    error: "assert mismatch",
    failedItems: [{ itemText: "校验金额", kind: "check", evidence: "expected 42 got 41" }],
    crashes: [
      { id: "crash-a", kind: "java", package: "com.example", exceptionClass: "NPE", occurrences: 2 }
    ],
    anchor: { stepNumber: 3, query: "q", candidates: [] },
    designDiff: { ok: true, reportPath: report, error: null },
    degraded: ["anchor-skipped"],
    artifacts: [
      { kind: "screenshot", path: shot, copied: true },
      { kind: "design-diff", path: report, copied: false }
    ],
    dir: path.join(dir, "evidence")
  };
  const draft = buildEvidenceComment(bundle, {
    platform: "ios",
    deviceSerial: DEVICE_UDID,
    failureDomain: "app-defect"
  });
  assert.match(draft.text, /【AOS 失败证据】trace trace-1/);
  assert.match(draft.text, /平台: ios · 设备: 00008101/);
  assert.match(draft.text, /失败域: app-defect/);
  assert.match(draft.text, /校验金额 · 类型=check · 证据=expected 42 got 41/);
  assert.match(draft.text, /java · NPE（com.example，×2）/);
  assert.match(draft.text, /step-3-post\.png/);
  assert.match(draft.text, /annotated\.png/);
  assert.match(draft.text, /降级说明/);
  assert.deepEqual(
    candidateAttachments(bundle).map((file) => path.basename(file)),
    ["step-3-post.png", "annotated.png"]
  );
});

test("jira_evidence_post: dryRun 不触网，输出评论与附件清单", async () => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  writeStatus(runtime, "trace-1", {
    status: "failed",
    platform: "ios",
    device_serial: DEVICE_UDID,
    error: "assert mismatch"
  });
  const stub = stubFetch(async () => {
    throw new Error("dryRun 不应触网");
  });
  try {
    const payload = parseToolResult(
      await jiraEvidencePost(runtime, { key: "AOS-1", traceId: "trace-1", dryRun: true })
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.platform, "ios");
    assert.equal(payload.deviceSerial, DEVICE_UDID);
    assert.match(payload.commentText, /trace trace-1/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("jira_evidence_post: 幂等回写（既有 marker 评论走 PUT，不新建）", async (t) => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  writeStatus(runtime, "trace-2", {
    status: "failed",
    platform: "android",
    device_serial: "emulator-5554"
  });
  const existing = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "旧证据" }] },
      { type: "paragraph", content: [{ type: "text", text: "AOS-TRACE:trace-2" }] }
    ]
  };
  const stub = stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/comment?maxResults=")) return jsonResponse({ comments: [{ id: "55", body: existing }] });
    if (u.includes("/comment/55") && init.method === "PUT") return new Response(null, { status: 204 });
    if (u.includes("/properties/")) return jsonResponse({});
    return jsonResponse({}, 404);
  });
  t.after(stub.restore);

  const payload = parseToolResult(await jiraEvidencePost(runtime, { key: "AOS-1", traceId: "trace-2" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "updated");
  assert.equal(payload.commentId, "55");
  assert.equal(payload.platform, "android");
  assert.equal(payload.deviceSerial, "emulator-5554");
  assert.equal(
    stub.calls.some((call) => (call.init.method ?? "GET") === "POST"),
    false,
    "不应新建评论/上传附件"
  );
});

test("jira_evidence_post: trace 不存在返回可行动说明", async () => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const result = await jiraEvidencePost(runtime, { key: "AOS-1", traceId: "trace-none" });
  assert.equal(result.isError, true);
  const payload = parseToolResult(result);
  assert.match(payload.error, /未找到 trace trace-none/);
  assert.ok(payload.hints.length >= 1);
});
