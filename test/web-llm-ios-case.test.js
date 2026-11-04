import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeIosLlmCase, iosAppUrl } from "../dist/web/llm/ios-case.js";

function result(body) {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

async function trace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-ios-llm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "run.json"),
    JSON.stringify({ steps: [{ texts: [{ text: "登录成功" }] }] })
  );
  await writeFile(path.join(dir, "status.json"), "{}");
  return dir;
}

test("executeIosLlmCase: test_summary/L1 → PASS", async (t) => {
  const dir = await trace(t);
  const proxy = {
    async callTool(name) {
      if (name === "mobile_run_task") return result({ trace_id: "ios-trace" });
      return result({
        status: "completed",
        test_summary: { passed: 1, failed: 0, inconclusive: 0, unchecked: 0 }
      });
    }
  };
  const out = await executeIosLlmCase({
    proxy,
    traceDir: () => dir,
    testCase: {
      caseId: "TC-IOS-1",
      taskDesc: "登录",
      expected: "页面显示“登录成功”"
    },
    deviceSerial: "00008110-001A"
  });
  assert.equal(out.status, "PASS");
  assert.equal(out.traceId, "ios-trace");
  assert.equal(out.artifacts.statusJsonPath, path.join(dir, "status.json"));
  assert.equal(out.verification.reference, "missing");
});

test("executeIosLlmCase: failed summary → FAIL；无 summary 但有 L1 → PASS", async (t) => {
  const dir = await trace(t);
  const failed = await executeIosLlmCase({
    proxy: {
      async callTool(name) {
        if (name === "mobile_run_task") return result({ trace_id: "ios-trace-2" });
        return result({
          status: "completed",
          test_summary: { passed: 0, failed: 1 }
        });
      }
    },
    traceDir: () => dir,
    testCase: { caseId: "TC-IOS-2", taskDesc: "失败" },
    deviceSerial: "00008110-001A"
  });
  assert.equal(failed.status, "FAIL");

  const l1 = await executeIosLlmCase({
    proxy: {
      async callTool(name) {
        if (name === "mobile_run_task") return result({ trace_id: "ios-trace-3" });
        return result({ status: "completed" });
      }
    },
    traceDir: () => dir,
    testCase: {
      caseId: "TC-IOS-3",
      taskDesc: "L1",
      expected: "页面显示“登录成功”"
    },
    deviceSerial: "00008110-001A"
  });
  assert.equal(l1.status, "PASS");
});

test("iosAppUrl：只接受 HTTP(S)，拒绝中心本地路径", () => {
  assert.equal(iosAppUrl("https://center.example/a.ipa"), "https://center.example/a.ipa");
  assert.equal(iosAppUrl("http://127.0.0.1:8080/a.ipa"), "http://127.0.0.1:8080/a.ipa");
  assert.equal(iosAppUrl("/Users/me/.artemis/web/assets/a.ipa"), null);
  assert.equal(iosAppUrl("file:///tmp/a.ipa"), null);
  assert.equal(iosAppUrl(null), null);
});

test("executeIosLlmCase：app_path 只传 HTTP(S)，中心路径拒绝", async (t) => {
  const dir = await trace(t);
  const calls = [];
  const out = await executeIosLlmCase({
    proxy: {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "mobile_run_task") return result({ trace_id: "ios-url" });
        return result({ status: "completed", test_summary: { passed: 1, failed: 0 } });
      }
    },
    traceDir: () => dir,
    testCase: { caseId: "TC-IOS-URL", taskDesc: "安装" },
    deviceSerial: "00008110-001A",
    appPackage: "com.example.app",
    appPath: "https://center.example/app.ipa"
  });
  assert.equal(out.status, "PASS");
  assert.equal(
    calls.find((call) => call.name === "mobile_run_task").args.app_path,
    "https://center.example/app.ipa"
  );

  const rejected = await executeIosLlmCase({
    proxy: { async callTool() { return result({ trace_id: "x" }); } },
    traceDir: () => dir,
    testCase: { caseId: "TC-IOS-URL-2", taskDesc: "安装" },
    deviceSerial: "00008110-001A",
    appPath: "/Users/me/app.ipa"
  });
  assert.equal(rejected.status, "ERROR");
  assert.equal(rejected.failureReason, "ios-app-path-not-remote");
});

test("executeIosLlmCase：未绑定账号 → ERROR，不发任务", async () => {
  let called = false;
  const out = await executeIosLlmCase({
    proxy: {
      async callTool() {
        called = true;
        return result({ trace_id: "x" });
      }
    },
    traceDir: () => "/tmp",
    testCase: {
      caseId: "TC-IOS-SEC-1",
      taskDesc: "用 user@example.com 登录"
    },
    deviceSerial: "00008110-001A",
    secrets: []
  });
  assert.equal(out.status, "ERROR");
  assert.equal(out.failureReason, "llm-secret-unbound:1");
  assert.equal(called, false);
});

test("executeIosLlmCase：有 secret 但脱敏未启用 → fail-closed", async () => {
  let called = false;
  const out = await executeIosLlmCase({
    proxy: {
      async callTool() {
        called = true;
        return result({ trace_id: "x" });
      }
    },
    traceDir: () => "/tmp",
    testCase: { caseId: "TC-IOS-SEC-2", taskDesc: "用 hunter2 登录" },
    deviceSerial: "00008110-001A",
    secrets: [{ alias: "PASSWORD", value: "hunter2", kind: "password" }]
  });
  assert.equal(out.status, "ERROR");
  assert.equal(out.failureReason, "ios-redaction-unavailable");
  assert.equal(called, false);
});

test("executeIosLlmCase：taskDesc 先脱敏再发给执行器", async (t) => {
  const dir = await trace(t);
  const calls = [];
  const out = await executeIosLlmCase({
    proxy: {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "mobile_run_task") return result({ trace_id: "ios-sec" });
        return result({
          status: "completed",
          test_summary: { passed: 1, failed: 0 }
        });
      }
    },
    traceDir: () => dir,
    testCase: {
      caseId: "TC-IOS-SEC-3",
      taskDesc: "用 hunter2 登录",
      expected: "页面显示“登录成功”"
    },
    deviceSerial: "00008110-001A",
    secrets: [{ alias: "PASSWORD", value: "hunter2", kind: "password" }],
    redactionActive: true
  });
  assert.equal(out.status, "PASS");
  const runTask = calls.find((call) => call.name === "mobile_run_task");
  assert.equal(runTask.args.task_desc, "用 <secret:PASSWORD> 登录");
});

test("executeIosLlmCase：透传 token_usage（含重试/验证累计）", async (t) => {
  const dir = await trace(t);
  const out = await executeIosLlmCase({
    proxy: {
      async callTool(name) {
        if (name === "mobile_run_task") return result({ trace_id: "ios-usage" });
        return result({
          status: "completed",
          test_summary: { passed: 1, failed: 0 },
          token_usage: [
            { promptTokens: 10, completionTokens: 2, cacheCreateTokens: 0, cacheReadTokens: 0 },
            { promptTokens: 4, completionTokens: 1, cacheCreateTokens: 0, cacheReadTokens: 2 }
          ]
        });
      }
    },
    traceDir: () => dir,
    testCase: { caseId: "TC-IOS-USAGE", taskDesc: "用量" },
    deviceSerial: "00008110-001A"
  });
  assert.equal(out.status, "PASS");
  assert.equal(out.tokenUsage.length, 2);
  assert.equal(out.tokenUsage[1].cacheReadTokens, 2);
});

test("executeIosLlmCase: 取消 → stop + SKIP", async (t) => {
  const dir = await trace(t);
  const controller = new AbortController();
  const calls = [];
  const out = await executeIosLlmCase({
    proxy: {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "mobile_run_task") {
          controller.abort();
          return result({ trace_id: "ios-trace-4" });
        }
        return result({ status: "running" });
      }
    },
    traceDir: () => dir,
    testCase: { caseId: "TC-IOS-4", taskDesc: "取消" },
    deviceSerial: "00008110-001A",
    signal: controller.signal
  });
  assert.equal(out.status, "SKIP");
  assert.ok(calls.some((call) => call.name === "mobile_manage_task" && call.args.action === "stop"));
});
