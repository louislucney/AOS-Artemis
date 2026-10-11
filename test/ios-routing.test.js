import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { __resetIosTasks } from "../dist/ios/task-runner.js";
import { createServerForRuntime } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";

test.beforeEach(() => {
  __resetIosTasks();
});

async function makeRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  return { dir, runtime, proxy };
}

function writeIosTrace(runtime, traceId) {
  const dir = runtime.traceDir(traceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify({
      trace_id: traceId,
      status: "completed",
      platform: "ios",
      device_serial: UDID,
      task_desc: "路由测试",
      model: "fake-model",
      start_time: 1000,
      end_time: 1010
    })
  );
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      trace_id: traceId,
      platform: "ios",
      status: "completed",
      device_serial: UDID,
      task_desc: "路由测试",
      steps: [],
      result: { success: true, summary: "done" }
    })
  );
}

test("路由：iOS UDID 的 mobile_run_task 由 iOS 接管，不落内层代理", async () => {
  const { runtime, proxy } = await makeRuntime();
  const result = await runtime.proxy.callTool("mobile_run_task", {
    task_desc: "观察",
    device_serial: UDID
  });
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.trace_id, /^ios-/);
  assert.equal(payload.status, "failed");
  assert.equal(proxy.calls.some((call) => call.name === "mobile_run_task"), false);
});

test("路由：mobile_diagnose 不被 iOS 截获（即使 serial 是 UDID）", async () => {
  const { runtime, proxy } = await makeRuntime();
  await runtime.proxy.callTool("mobile_diagnose", { device_serial: UDID });
  assert.equal(proxy.calls.some((call) => call.name === "mobile_diagnose"), true);
});

test("路由：Android serial 的 mobile_* 全部穿透内层代理", async () => {
  const { runtime, proxy } = await makeRuntime();
  await runtime.proxy.callTool("mobile_run_task", {
    task_desc: "x",
    device_serial: "emulator-5554"
  });
  await runtime.proxy.callTool("mobile_get_device_state", {
    view_type: "screenshot",
    device_serial: "emulator-5554"
  });
  assert.deepEqual(
    proxy.calls.map((call) => call.name),
    ["mobile_run_task", "mobile_get_device_state"]
  );
});

test("路由：磁盘 iOS trace 的 mobile_manage_task 由 iOS 接管（source=disk）", async () => {
  const { runtime, proxy } = await makeRuntime();
  writeIosTrace(runtime, "ios-route-1");
  const result = await runtime.proxy.callTool("mobile_manage_task", {
    trace_id: "ios-route-1",
    action: "status"
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.trace_id, "ios-route-1");
  assert.equal(payload.status, "completed");
  assert.equal(payload.source, "disk");
  assert.equal(proxy.calls.some((call) => call.name === "mobile_manage_task"), false);
});

test("路由：磁盘 iOS trace 的 mobile_inspect_trace 由 iOS 接管", async () => {
  const { runtime, proxy } = await makeRuntime();
  writeIosTrace(runtime, "ios-route-2");
  const result = await runtime.proxy.callTool("mobile_inspect_trace", {
    trace_id: "ios-route-2",
    action: "view_summary"
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.platform, "ios");
  assert.equal(payload.trace_id, "ios-route-2");
  assert.equal(proxy.calls.some((call) => call.name === "mobile_inspect_trace"), false);
});

test("server 级：ios- trace 结果不由 server 重复补记任务行；普通 trace 会补记", async () => {
  const rows = [];
  const makeServer = (traceId) => {
    const runtime = {
      proxy: {
        isRunning: () => false,
        ensureStarted: async () => {},
        listTools: async () => [],
        callTool: async () => ({
          content: [
            { type: "text", text: JSON.stringify({ trace_id: traceId, status: "running" }) }
          ]
        }),
        status: () => ({}),
        markForRestart: async () => {},
        dispose: async () => {},
        disposeSync: () => {}
      },
      setupInfo: async () => ({ required: false, missing: [], message: "", howToFix: [] }),
      ensureActiveModelUsable: async () => ({ ok: true, warnings: [] }),
      recordTaskResult: async (input) => {
        rows.push(input);
      },
      recordUsage: async (input) => ({ id: "fake-usage-id", ...input })
    };
    return createServerForRuntime(runtime, null);
  };

  for (const [traceId, expected] of [
    ["ios-abc12345", 0],
    ["deadbeef-0001", 1]
  ]) {
    rows.length = 0;
    const server = makeServer(traceId);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "routing-server-test", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "mobile_run_task",
        arguments: { task_desc: "x", device_serial: "emulator-5554" }
      });
      assert.equal(rows.length, expected, `trace=${traceId}`);
    } finally {
      await client.close();
      await server.close();
    }
  }
});
