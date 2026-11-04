import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeAndroidLlmCase } from "../dist/web/llm/artemis-case.js";

function result(body) {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

async function traceDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-llm-case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "status.json"), "{}");
  await writeFile(path.join(dir, "data_engine.db"), "");
  return dir;
}

test("executeAndroidLlmCase: completed + test_summary → PASS", async (t) => {
  const dir = await traceDir(t);
  const calls = [];
  const proxy = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "mobile_run_task") return result({ trace_id: "trace-1" });
      return result({
        status: "completed",
        test_summary: { passed: 2, failed: 0, inconclusive: 0, unchecked: 0 }
      });
    }
  };
  const out = await executeAndroidLlmCase({
    proxy,
    traceDir: () => dir,
    testCase: { caseId: "TC-1", taskDesc: "登录成功" },
    deviceSerial: "pixel-1",
    now: () => 1_000
  });
  assert.equal(out.status, "PASS");
  assert.equal(out.traceId, "trace-1");
  assert.deepEqual(out.verification.deterministic, { passed: 2, failed: 0, skipped: 0 });
  assert.equal(calls[0].name, "mobile_run_task");
  assert.equal(calls[0].args.device_serial, "pixel-1");
});

test("executeAndroidLlmCase: failed summary → FAIL；无 summary → UNVERIFIED", async (t) => {
  const dir = await traceDir(t);
  const failedProxy = {
    async callTool(name) {
      if (name === "mobile_run_task") return result({ trace_id: "trace-2" });
      return result({
        status: "completed",
        test_summary: { passed: 0, failed: 1, inconclusive: 0, unchecked: 0 }
      });
    }
  };
  const failed = await executeAndroidLlmCase({
    proxy: failedProxy,
    traceDir: () => dir,
    testCase: { caseId: "TC-2", taskDesc: "失败" },
    deviceSerial: "pixel-1"
  });
  assert.equal(failed.status, "FAIL");

  const bareProxy = {
    async callTool(name) {
      if (name === "mobile_run_task") return result({ trace_id: "trace-3" });
      return result({ status: "completed" });
    }
  };
  const bare = await executeAndroidLlmCase({
    proxy: bareProxy,
    traceDir: () => dir,
    testCase: { caseId: "TC-3", taskDesc: "无 summary" },
    deviceSerial: "pixel-1"
  });
  assert.equal(bare.status, "UNVERIFIED");
});

test("executeAndroidLlmCase: taskDesc 进模型前脱敏；未绑定账号拒绝执行", async (t) => {
  const dir = await traceDir(t);
  const calls = [];
  const proxy = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "mobile_run_task") return result({ trace_id: "trace-5" });
      return result({ status: "completed", test_summary: { passed: 1, failed: 0 } });
    }
  };
  const previous = process.env.AOS_LLM_HOOKS_ACTIVE;
  process.env.AOS_LLM_HOOKS_ACTIVE = "1";
  try {
    const redacted = await executeAndroidLlmCase({
      proxy,
      traceDir: () => dir,
      testCase: { caseId: "TC-5", taskDesc: "用 user@example.com 登录" },
      deviceSerial: "pixel-1",
      secrets: [{ alias: "account", value: "user@example.com", kind: "account" }]
    });
    assert.equal(redacted.status, "PASS");
    assert.match(calls[0].args.task_desc, /<secret:account>/);
    assert.doesNotMatch(calls[0].args.task_desc, /user@example\.com/);
  } finally {
    if (previous === undefined) delete process.env.AOS_LLM_HOOKS_ACTIVE;
    else process.env.AOS_LLM_HOOKS_ACTIVE = previous;
  }

  const hookMissing = await executeAndroidLlmCase({
    proxy: {
      async callTool() {
        throw new Error("must not call model");
      }
    },
    traceDir: () => dir,
    testCase: { caseId: "TC-5b", taskDesc: "用账号登录" },
    deviceSerial: "pixel-1",
    secrets: [{ alias: "account", value: "user@example.com", kind: "account" }]
  });
  assert.equal(hookMissing.status, "ERROR");
  assert.equal(hookMissing.failureReason, "llm-secret-hook-unavailable");

  const blocked = await executeAndroidLlmCase({
    proxy: {
      async callTool() {
        throw new Error("must not call model");
      }
    },
    traceDir: () => dir,
    testCase: { caseId: "TC-6", taskDesc: "用 user@example.com 登录" },
    deviceSerial: "pixel-1"
  });
  assert.equal(blocked.status, "ERROR");
  assert.match(blocked.failureReason, /llm-secret-unbound/);
});

test("executeAndroidLlmCase: 取消会 stop ARTEMIS 并返回 SKIP", async (t) => {
  const dir = await traceDir(t);
  const controller = new AbortController();
  const calls = [];
  const proxy = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "mobile_run_task") {
        controller.abort();
        return result({ trace_id: "trace-4" });
      }
      return result({ status: "running" });
    }
  };
  const out = await executeAndroidLlmCase({
    proxy,
    traceDir: () => dir,
    testCase: { caseId: "TC-4", taskDesc: "取消" },
    deviceSerial: "pixel-1",
    signal: controller.signal
  });
  assert.equal(out.status, "SKIP");
  assert.equal(out.failureReason, "cancelled");
  assert.ok(calls.some((call) => call.name === "mobile_manage_task" && call.args.action === "stop"));
});
