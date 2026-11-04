import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeIosLlmCase } from "../dist/web/llm/ios-case.js";

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
