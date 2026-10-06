import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { maybeIosInspectTrace } from "../dist/ios/inspect.js";
import { maybeIosManageTask } from "../dist/ios/task-runner.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";
const TRACE_A = "ios-aaaaaaaa-1111-4111-8111-111111111111";
const TRACE_B = "ios-bbbbbbbb-2222-4222-8222-222222222222";
const TRACE_C = "ios-cccccccc-3333-4333-8333-333333333333";
const TRACE_D = "ios-dddddddd-4444-4444-8444-444444444444";
const TRACE_E = "ios-eeeeeeee-5555-4555-8555-555555555555";
const TRACE_F = "ios-ffffffff-6666-4666-8666-666666666666";

async function makeRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });
  return { dir, runtime };
}

function writeTrace(runtime, traceId, { status, run }) {
  const traceDir = runtime.traceDir(traceId);
  fs.mkdirSync(traceDir, { recursive: true });
  if (status !== undefined) {
    fs.writeFileSync(path.join(traceDir, "status.json"), JSON.stringify(status, null, 2));
  }
  if (run !== undefined) {
    fs.writeFileSync(path.join(traceDir, "run.json"), JSON.stringify(run, null, 2));
  }
  return traceDir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

test("磁盘 fallback：owner 进程存活 → running + note，不重写 status.json", async () => {
  const { runtime } = await makeRuntime();
  const traceDir = writeTrace(runtime, TRACE_A, {
    status: {
      trace_id: TRACE_A,
      status: "running",
      platform: "ios",
      device_serial: UDID,
      task_desc: "T",
      model: "m",
      pid: 4242,
      message: "started"
    },
    run: { trace_id: TRACE_A, platform: "ios", status: "running", steps: [] }
  });
  const payload = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: TRACE_A }, { isProcessAlive: () => true })
  );
  assert.equal(payload.status, "running");
  assert.equal(payload.source, "disk");
  assert.equal(payload.pid, 4242);
  assert.equal(payload.alive, true);
  assert.match(payload.note, /可能仍由进程 4242 执行/);
  assert.equal(readJson(path.join(traceDir, "status.json")).status, "running");
});

test("磁盘 fallback：owner 进程死亡 → orphaned 并落盘（status.json + run.json）", async () => {
  const { runtime } = await makeRuntime();
  const traceDir = writeTrace(runtime, TRACE_B, {
    status: {
      trace_id: TRACE_B,
      status: "running",
      platform: "ios",
      device_serial: UDID,
      task_desc: "T",
      model: "m",
      pid: 4243
    },
    run: { trace_id: TRACE_B, platform: "ios", status: "running", steps: [] }
  });
  const payload = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: TRACE_B }, { isProcessAlive: () => false })
  );
  assert.equal(payload.status, "orphaned");
  assert.equal(payload.alive, false);
  assert.match(payload.note, /已退出/);
  const status = readJson(path.join(traceDir, "status.json"));
  assert.equal(status.status, "orphaned");
  assert.equal(typeof status.end_time, "number");
  assert.match(status.message, /已退出/);
  assert.equal(readJson(path.join(traceDir, "run.json")).status, "orphaned");
});

test("无 pid：超时归 orphaned，未超时保持 running（不确定提示）", async () => {
  const { runtime } = await makeRuntime();
  writeTrace(runtime, TRACE_C, {
    status: {
      trace_id: TRACE_C,
      status: "running",
      platform: "ios",
      device_serial: UDID,
      task_desc: "T",
      model: "m"
    }
  });
  const stale = payloadOf(
    maybeIosManageTask(
      runtime,
      { action: "status", trace_id: TRACE_C },
      { clock: () => Date.now() + 31 * 60_000 }
    )
  );
  assert.equal(stale.status, "orphaned");
  assert.match(stale.note, /无进程记录/);

  writeTrace(runtime, TRACE_D, {
    status: {
      trace_id: TRACE_D,
      status: "running",
      platform: "ios",
      device_serial: UDID,
      task_desc: "T",
      model: "m"
    }
  });
  const fresh = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: TRACE_D }, { clock: () => Date.now() })
  );
  assert.equal(fresh.status, "running");
  assert.match(fresh.note, /无法确认/);
});

test("platform 路由：字段优先（android 不接管），无字段时 ios- 前缀 fallback", async () => {
  const { runtime } = await makeRuntime();
  writeTrace(runtime, TRACE_E, {
    status: {
      trace_id: TRACE_E,
      status: "completed",
      platform: "android",
      device_serial: "emulator-5554"
    }
  });
  assert.equal(
    maybeIosManageTask(runtime, { action: "status", trace_id: TRACE_E }, { isProcessAlive: () => true }),
    null
  );

  writeTrace(runtime, "trace-1", {
    status: { trace_id: "trace-1", status: "completed", device_serial: "emulator-5554" }
  });
  assert.equal(
    maybeIosManageTask(runtime, { action: "status", trace_id: "trace-1" }, { isProcessAlive: () => true }),
    null
  );

  writeTrace(runtime, TRACE_F, {
    status: { trace_id: TRACE_F, status: "completed", device_serial: UDID }
  });
  const fallback = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: TRACE_F }, { isProcessAlive: () => true })
  );
  assert.equal(fallback.status, "completed");
  assert.equal(fallback.device_serial, UDID);
});

test("inspect 磁盘 fallback：run.json 步骤可读可检索", async () => {
  const { runtime } = await makeRuntime();
  writeTrace(runtime, TRACE_A, {
    status: {
      trace_id: TRACE_A,
      status: "failed",
      platform: "ios",
      device_serial: UDID,
      task_desc: "查找按钮",
      model: "m",
      test_summary: {
        task_status: "failed",
        passed: 0,
        failed: 1,
        failed_items: [{ item_text: "未找到按钮", evidence: "未找到按钮" }]
      }
    },
    run: {
      trace_id: TRACE_A,
      platform: "ios",
      status: "failed",
      steps: [
        { step: 1, thought: "点一下", action: "tap", params: { x: 10, y: 20 }, outcome: "ok" },
        { step: 2, thought: "找不到", action: "fail", params: { reason: "未找到按钮" }, outcome: "fail" }
      ]
    }
  });
  const summary = payloadOf(
    maybeIosInspectTrace(runtime, { action: "view_summary", trace_id: TRACE_A })
  );
  assert.equal(summary.status, "failed");
  assert.equal(summary.device_serial, UDID);
  assert.equal(summary.steps.length, 2);
  assert.equal(summary.steps[1].action, "fail");

  const search = payloadOf(
    maybeIosInspectTrace(runtime, { action: "search", trace_id: TRACE_A, query: "未找到按钮" })
  );
  assert.equal(search.matches, 1);
  assert.match(search.results, /^\[Step 2\]/m);
});

test("runtime.traceStatus：死亡任务归 orphaned，供台账收尾", async () => {
  const { runtime } = await makeRuntime();
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(typeof child.pid, "number");
  const traceDir = writeTrace(runtime, TRACE_A, {
    status: {
      trace_id: TRACE_A,
      status: "running",
      platform: "ios",
      device_serial: UDID,
      task_desc: "T",
      model: "m",
      pid: child.pid
    }
  });
  const status = await runtime.traceStatus(TRACE_A);
  assert.equal(status?.status, "orphaned");
  assert.equal(readJson(path.join(traceDir, "status.json")).status, "orphaned");
});
