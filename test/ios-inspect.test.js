import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { __resetIosTasks, getIosTask, maybeIosRunTask } from "../dist/ios/task-runner.js";
import { maybeIosInspectTrace } from "../dist/ios/inspect.js";
import { traceEvidence } from "../dist/artemis/evidence.js";
import { designDeviceDiff } from "../dist/diff/tool.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubFigmaFetch,
  toPng,
  withFigmaToken
} from "./helpers.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";
const ENTRY = {
  name: "fake",
  provider: "custom",
  model: "fake-model",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "fake-key",
  keyEnvName: null,
  fallback: null,
  nodeOverrides: null,
  source: "env",
  isActive: true
};

function bootedSims() {
  return async () => ({
    ok: true,
    simulators: [{ udid: UDID, name: "iPhone 17 Pro", state: "Booted", isAvailable: true }]
  });
}

function fakeDevice(shotPng) {
  return {
    serial: UDID,
    platform: "ios",
    capabilities: { back: "none" },
    async tap() {},
    async swipe() {},
    async inputText() {
      return { mode: "type" };
    },
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async nodes() {
      return [{ type: "Button", label: "按钮", value: "", id: "", rect: { x: 0, y: 0, width: 100, height: 40 } }];
    },
    async size() {
      return { width: 390, height: 844 };
    },
    async screenshot() {
      return shotPng;
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };
}

function scriptedChat(responses) {
  return async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("scripted chat exhausted");
    return typeof next === "function" ? next() : next;
  };
}

async function makeRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });
  return { dir, runtime };
}

async function startFailedTask(runtime, shotPng) {
  const chat = scriptedChat([
    JSON.stringify({ thought: "点一下按钮", action: "tap", x: 10, y: 20 }),
    JSON.stringify({ thought: "界面上找不到", action: "fail", reason: "未找到按钮" })
  ]);
  const started = JSON.parse(
    (
      await maybeIosRunTask(
        runtime,
        { task_desc: "查找按钮并点击", device_serial: UDID },
        { entry: ENTRY, device: fakeDevice(shotPng), chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
      )
    ).content[0].text
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  return { started, record };
}

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

test.beforeEach(() => {
  __resetIosTasks();
});

test("view_summary: 步骤与终态", async () => {
  const { runtime } = await makeRuntime();
  const { started, record } = await startFailedTask(runtime, Buffer.from(toPng(createImage(4, 4))));
  const payload = payloadOf(
    maybeIosInspectTrace(runtime, { action: "view_summary", trace_id: started.trace_id })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "failed");
  assert.equal(payload.steps.length, 2);
  assert.equal(payload.steps[1].action, "fail");
  assert.equal(record.result.summary, "未找到按钮");
});

test("view_step_screenshots: before/post=同一步截图，overlay 按需生成", async () => {
  const { runtime } = await makeRuntime();
  const { started, record } = await startFailedTask(runtime, Buffer.from(toPng(createImage(4, 4))));
  const first = payloadOf(
    maybeIosInspectTrace(runtime, { action: "view_step_screenshots", trace_id: started.trace_id, step_number: 1 })
  );
  assert.equal(first.before_screenshot, path.join(record.runDir, "shots/step-1.png"));
  assert.equal(first.after_screenshot, path.join(record.runDir, "shots/step-1-post.png"));
  assert.equal(first.action_overlay_screenshot, path.join(record.runDir, "shots/step-1-overlay.png"));
  assert.ok(fs.existsSync(first.action_overlay_screenshot));
  assert.equal(first.device_serial, UDID);
  assert.ok(fs.existsSync(first.before_screenshot));

  const last = payloadOf(
    maybeIosInspectTrace(runtime, { action: "view_step_screenshots", trace_id: started.trace_id, step_number: 2 })
  );
  assert.equal(last.after_screenshot, path.join(record.runDir, "shots/step-2-post.png"));
  assert.equal(last.action_overlay_screenshot, null);
  assert.equal(last.action_overlay_error, "unsupported-action-or-scale");
});

test("view_step_details: 单步推理/动作/结果", async () => {
  const { runtime } = await makeRuntime();
  const { started } = await startFailedTask(runtime, Buffer.from(toPng(createImage(4, 4))));
  const payload = payloadOf(
    maybeIosInspectTrace(runtime, { action: "view_step_details", trace_id: started.trace_id, step_number: 1 })
  );
  assert.equal(payload.action, "tap");
  assert.equal(payload.device_serial, UDID);
  assert.deepEqual(payload.params, { x: 10, y: 20 });
  assert.equal(payload.outcome, "ok");
  assert.equal(payload.perception, "text");

  const missing = payloadOf(
    maybeIosInspectTrace(runtime, { action: "view_step_details", trace_id: started.trace_id, step_number: 9 })
  );
  assert.equal(missing.ok, false);
});

test("search: 全文/分词匹配与 step_range", async () => {
  const { runtime } = await makeRuntime();
  const { started } = await startFailedTask(runtime, Buffer.from(toPng(createImage(4, 4))));
  const hit = payloadOf(
    maybeIosInspectTrace(runtime, { action: "search", trace_id: started.trace_id, query: "未找到按钮" })
  );
  assert.equal(hit.matches, 1);
  assert.match(hit.results, /^\[Step 2\]/m);

  const ranged = payloadOf(
    maybeIosInspectTrace(runtime, {
      action: "search",
      trace_id: started.trace_id,
      query: "按钮",
      step_range: [1, 1],
      max_results: 10
    })
  );
  assert.equal(ranged.matches, 1);
  assert.match(ranged.results, /^\[Step 1\]/m);

  const none = payloadOf(
    maybeIosInspectTrace(runtime, { action: "search", trace_id: started.trace_id, query: "完全不存在的内容" })
  );
  assert.equal(none.matches, 0);

  const byScreen = payloadOf(
    maybeIosInspectTrace(runtime, { action: "search", trace_id: started.trace_id, query: "按钮" })
  );
  assert.equal(byScreen.matches, 2);
});

test("非 iOS trace 不接管", async () => {
  const { runtime } = await makeRuntime();
  assert.equal(maybeIosInspectTrace(runtime, { action: "view_summary", trace_id: "t1" }), null);
});

test("design_device_diff：iOS 失败步骤自动锚定 + pre 截图对比", async () => {
  await withFigmaToken(async () => {
    const dir = makeTempProject({ config: baseConfig() });
    const designImage = createImage(390, 844);
    fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
    const designPng = toPng(designImage);
    const figma = stubFigmaFetch(designPng, "1:2", "IosStep1");
    const devicePng = Buffer.from(toPng(createImage(390, 844)));
    const proxy = new StubProxy({ running: true });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const { started } = await startFailedTask(runtime, devicePng);
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/IosStep1/File?node-id=1-2" },
          device: { mode: "step", traceId: started.trace_id, image: "pre", platform: "ios" }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.anchor.source, "search");
      assert.equal(payload.anchor.query, "未找到按钮");
      assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
      assert.equal(
        proxy.calls.some((call) => call.name === "mobile_manage_task" || call.name === "mobile_inspect_trace"),
        false
      );
    } finally {
      figma.restore();
    }
  });
});

test("suite evidence: iOS 失败 trace 产出失败项与步骤锚点", async () => {
  const { runtime } = await makeRuntime();
  const { started } = await startFailedTask(runtime, Buffer.from(toPng(createImage(4, 4))));
  const bundle = await traceEvidence(runtime, { traceId: started.trace_id, save: false });
  assert.equal(bundle.failedItems.length, 1);
  assert.match(bundle.failedItems[0].evidence, /未找到按钮/);
  assert.equal(bundle.anchor?.stepNumber, 2);
  assert.equal(bundle.crashes.length, 0);
});
