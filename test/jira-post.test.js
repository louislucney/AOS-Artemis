import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { postEvidenceToIssue } from "../dist/jira/post.js";
import { loadTestRuntime, makeTempProject } from "./helpers.js";

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

function writeStatus(runtime, traceId, payload) {
  const dir = runtime.traceDir(traceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(payload), "utf-8");
}

test("postEvidenceToIssue: dryRun 且 key 为空 → 跳过解析，issue null 且不触网", async () => {
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
    const payload = await postEvidenceToIssue(runtime, { key: "", traceId: "trace-1", dryRun: true });
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.issue, null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("postEvidenceToIssue: dryRun 且未提供 key → issue null", async () => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  writeStatus(runtime, "trace-1", { status: "failed", platform: "ios" });
  const payload = await postEvidenceToIssue(runtime, {
    key: undefined,
    traceId: "trace-1",
    dryRun: true
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.issue, null);
});

test("postEvidenceToIssue: 非 dryRun 空 key 仍报无法解析", async () => {
  const dir = makeTempProject({ dotenv: JIRA_DOTENV });
  const { runtime } = await loadTestRuntime(dir, { env: {} });
  const payload = await postEvidenceToIssue(runtime, { key: "", traceId: "trace-1" });
  assert.equal(payload.ok, false);
  assert.match(payload.error, /无法解析 issue key/);
});
