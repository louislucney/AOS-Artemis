import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  __resetIosTasks,
  getIosTask,
  maybeIosManageTask,
  maybeIosRunTask
} from "../dist/ios/task-runner.js";
import {
  baseConfig,
  createImage,
  loadTestRuntime,
  makeTempProject,
  StubProxy,
  toPng
} from "./helpers.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";
const PNG_BYTES = Buffer.from(toPng(createImage(4, 4)));

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

const NODES = [
  { type: "Application", label: "", value: "", id: "", rect: { x: 0, y: 0, width: 402, height: 874 } },
  { type: "Button", label: "搜索", value: "", id: "", rect: { x: 100, y: 200, width: 80, height: 40 } }
];

function bootedSims() {
  return async () => ({
    ok: true,
    simulators: [{ udid: UDID, name: "iPhone 17 Pro", state: "Booted", isAvailable: true }]
  });
}

function fakeDevice() {
  const calls = [];
  return {
    calls,
    serial: UDID,
    platform: "ios",
    capabilities: { back: "none" },
    async tap(x, y) {
      calls.push(["tap", x, y]);
    },
    async swipe(...args) {
      calls.push(["swipe", ...args]);
    },
    async inputText(text, at) {
      calls.push(["text", text, at]);
      return { mode: "type" };
    },
    async launch(bundleId) {
      calls.push(["launch", bundleId]);
    },
    async terminate(bundleId) {
      calls.push(["terminate", bundleId]);
      return true;
    },
    async openUrl(url) {
      calls.push(["openUrl", url]);
    },
    async nodes() {
      return NODES;
    },
    async size() {
      return { width: 402, height: 874 };
    },
    async screenshot() {
      return PNG_BYTES;
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };
}

function scriptedChat(responses) {
  const messages = [];
  return {
    messages,
    chat: async (msgs) => {
      messages.push(JSON.parse(JSON.stringify(msgs)));
      const next = responses.shift();
      if (next === undefined) throw new Error("scripted chat exhausted");
      return typeof next === "function" ? next() : next;
    }
  };
}

async function makeRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  return { dir, runtime, proxy };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
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

test.beforeEach(() => {
  __resetIosTasks();
});

test("非 UDID serial 不接管（返回 null）", async () => {
  const { runtime } = await makeRuntime();
  const result = await maybeIosRunTask(
    runtime,
    { task_desc: "打开设置", device_serial: "emulator-5554" },
    { entry: ENTRY }
  );
  assert.equal(result, null);
});

test("runtime 代理：UDID 的 mobile_run_task 由 iOS 接管，不落内层代理", async () => {
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

test("locked_app_package：循环前自动启动应用", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID, locked_app_package: "com.apple.Preferences" },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.deepEqual(device.calls[0], ["launch", "com.apple.Preferences"]);
});

test("模拟器未启动 → failed 响应且不注册任务", async () => {
  const { runtime } = await makeRuntime();
  const result = await maybeIosRunTask(
    runtime,
    { task_desc: "打开设置", device_serial: UDID },
    {
      entry: ENTRY,
      listSimulators: async () => ({
        ok: true,
        simulators: [{ udid: UDID, name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true }]
      })
    }
  );
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.match(payload.error, /未启动.*simctl boot/);
  assert.equal(getIosTask(payload.trace_id), null);
});

test("完整执行：动作 → done，落盘 run.json/status.json 与截图证据", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat, messages } = scriptedChat([
    JSON.stringify({ thought: "点击搜索", action: "tap", x: 140, y: 220 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "已打开搜索" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "点击搜索按钮", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0 }
    )
  );
  assert.equal(started.status, "running");
  assert.match(started.trace_id, /^ios-/);
  assert.equal(started.device_serial, UDID);
  assert.equal(started.model, "fake-model");

  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.deepEqual(record.result, { success: true, summary: "已打开搜索" });
  assert.equal(record.steps.length, 2);
  assert.deepEqual(device.calls[0], ["tap", 140, 220]);

  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 2);
  assert.ok(fs.existsSync(path.join(record.runDir, "shots", "step-1.png")));
  const status = JSON.parse(fs.readFileSync(path.join(record.runDir, "status.json"), "utf-8"));
  assert.equal(status.status, "completed");

  const firstPrompt = messages[0][1].content;
  assert.match(firstPrompt, /点击搜索按钮/);
  assert.match(firstPrompt, /Center: \(140,220\)/);
  assert.equal(record.steps[0].perception, "text");
  assert.equal(record.vision, null);
});

test("层级为空时走视觉模型：截图入参、perception=image、vision 记录", async () => {
  const { runtime } = await makeRuntime();
  const base = fakeDevice();
  const device = { ...base, nodes: async () => [] };
  const text = scriptedChat([]);
  const visionMessages = [];
  const visionChat = async (msgs) => {
    visionMessages.push(JSON.parse(JSON.stringify(msgs)));
    return JSON.stringify({ thought: "看截图", action: "done", success: true, summary: "视觉完成" });
  };
  const visionTarget = {
    chat: { baseUrl: "https://v.example.com/v1", apiKey: "vk", model: "qwen-vl-max" },
    model: "qwen-vl-max",
    source: "env"
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "看图确认", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat: text.chat,
        visionChat,
        visionTarget,
        listSimulators: bootedSims(),
        stepDelayMs: 0
      }
    )
  );
  assert.deepEqual(started.vision, { model: "qwen-vl-max", source: "env" });

  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].perception, "image");
  assert.equal(record.steps[0].shot, "shots/step-1.png");

  const userContent = visionMessages[0][1].content;
  assert.ok(Array.isArray(userContent), "视觉消息使用内容分片");
  assert.match(userContent[0].text, /本轮附有截图/);
  assert.match(userContent[0].text, /scale≈/);
  assert.match(userContent[1].image_url.url, /^data:image\/png;base64,/);
});

test("视觉调用失败 → 降级纯文本并记录原因", async () => {
  const { runtime } = await makeRuntime();
  const base = fakeDevice();
  const device = { ...base, nodes: async () => [] };
  const text = scriptedChat([JSON.stringify({ thought: "降级完成", action: "done", success: true, summary: "文本完成" })]);
  const visionChat = async () => {
    throw new Error("vision unsupported");
  };
  const visionTarget = {
    chat: { baseUrl: "https://v.example.com/v1", apiKey: "vk", model: "qwen-vl-max" },
    model: "qwen-vl-max",
    source: "env"
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "看图确认", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat: text.chat,
        visionChat,
        visionTarget,
        listSimulators: bootedSims(),
        stepDelayMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].perception, "text-degraded");
  assert.match(record.visionDegraded, /视觉调用失败.*vision unsupported/);
  const lastUser = text.messages[0][1].content;
  assert.equal(typeof lastUser, "string");

  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.match(run.vision_degraded, /视觉调用失败/);
  assert.equal(run.vision.model, "qwen-vl-max");
});

test("模型输出非法 JSON 记为 invalid 并继续", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    "这不是 JSON",
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].action, "invalid");
  assert.match(record.steps[0].outcome, /JSON/);
});

test("超出步数上限 → failed", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat(
    Array.from({ length: 10 }, () => JSON.stringify({ thought: "再点", action: "tap", x: 1, y: 1 }))
  );
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, maxSteps: 2 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.match(record.result.summary, /超出步数上限/);
});

test("mobile_manage_task：status/stop/inject_instruction/未知 trace", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat(
    Array.from({ length: 50 }, () => JSON.stringify({ thought: "循环", action: "tap", x: 1, y: 1 }))
  );
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "长任务", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 60 }
    )
  );

  const status = payloadOf(maybeIosManageTask({ action: "status", trace_id: started.trace_id }));
  assert.equal(status.status, "running");
  assert.equal(status.device_serial, UDID);
  assert.equal(status.task_desc, "长任务");

  const injected = payloadOf(
    maybeIosManageTask({ action: "inject_instruction", trace_id: started.trace_id, instruction: "改为点击搜索" })
  );
  assert.match(injected.message, /已注入/);

  const stopped = payloadOf(maybeIosManageTask({ action: "stop", trace_id: started.trace_id }));
  assert.match(stopped.message, /已请求停止/);

  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "cancelled");

  assert.equal(maybeIosManageTask({ action: "status", trace_id: "not-ios" }), null);
});

test("LLM 调用失败 → failed 并记录原因", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([() => Promise.reject(new Error("boom"))]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.match(record.result.summary, /LLM 调用失败/);
});
