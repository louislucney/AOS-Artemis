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
import { parseScriptPlan } from "../dist/ios/script-plan.js";
import { maybeIosInspectTrace } from "../dist/ios/inspect.js";
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

test("runLoop：设备解析失败 → 任务终态 failed（不滞留 running）", async () => {
  const { runtime } = await makeRuntime();
  runtime.iosDevice = async () => {
    throw new Error("appium 启动失败");
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, listSimulators: bootedSims() }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.match(record.error, /无法解析 iOS 设备/);
  assert.match(record.error, /appium 启动失败/);
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
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
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
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
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
  assert.match(record.visionDegraded, /自动视觉不可用/);
});

test("文本主模型 auto：每步视觉感知融合 V#（像素→pt + Center），决策仍在主模型", async () => {
  const { runtime } = await makeRuntime();
  const base = fakeDevice();
  const bigPng = Buffer.from(toPng(createImage(804, 1748)));
  const device = { ...base, nodes: async () => [], screenshot: async () => bigPng };
  const text = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "视觉完成" })
  ]);
  const visionMessages = [];
  const visionChat = async (msgs) => {
    visionMessages.push(JSON.parse(JSON.stringify(msgs)));
    return JSON.stringify([{ text: "搜索图标", bounds_px: [200, 400, 280, 480] }]);
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
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  assert.deepEqual(started.vision, { model: "qwen-vl-max", source: "env" });

  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].perception, "vision-text");
  assert.equal(record.steps[0].shot, "shots/step-1.png");

  const firstPrompt = text.messages[0][1].content;
  assert.equal(typeof firstPrompt, "string");
  assert.match(firstPrompt, /视觉感知补充/);
  assert.match(
    firstPrompt,
    /\[V1\] \(模型视觉，可能有误\) OCR Text: '搜索图标' \| Center: \(120,220\) \| Bounds: \[100,200\]\[140,240\]/
  );

  const visionUser = visionMessages[0][0];
  assert.equal(visionUser.role, "user");
  assert.ok(Array.isArray(visionUser.content));
  assert.match(visionUser.content[0].text, /屏幕视觉解析器/);
  assert.match(visionUser.content[1].image_url.url, /^data:image\/png;base64,/);

  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.deepEqual(run.vision_dropped, { invalid: 0, noScale: 0, duplicate: 0, overflow: 0 });
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
        stepDelayMs: 0, settleMs: 0
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
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
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
      {
        entry: ENTRY,
        device,
        chat,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0,
        maxSteps: 2,
        env: { AOS_IOS_LOG_FEEDBACK: "0" }
      }
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
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 60, settleMs: 0 }
    )
  );

  const status = payloadOf(maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id }));
  assert.equal(status.status, "running");
  assert.equal(status.device_serial, UDID);
  assert.equal(status.task_desc, "长任务");

  const injected = payloadOf(
    maybeIosManageTask(runtime, { action: "inject_instruction", trace_id: started.trace_id, instruction: "改为点击搜索" })
  );
  assert.match(injected.message, /已注入/);

  const stopped = payloadOf(maybeIosManageTask(runtime, { action: "stop", trace_id: started.trace_id }));
  assert.match(stopped.message, /已请求停止/);

  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "cancelled");

  assert.equal(maybeIosManageTask(runtime, { action: "status", trace_id: "not-ios" }), null);
});

test("LLM 调用失败 → failed 并记录原因", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([() => Promise.reject(new Error("boom"))]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0,
        env: { AOS_IOS_LOG_FEEDBACK: "0" }
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.match(record.result.summary, /LLM 调用失败/);
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.equal(status.test_summary.synthesized, true);
  assert.equal(status.test_summary.failed, 1);
});

test("run.json/status.json 记录 platform 与 owner pid（原子写）", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  const status = JSON.parse(fs.readFileSync(path.join(record.runDir, "status.json"), "utf-8"));
  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.equal(status.platform, "ios");
  assert.equal(status.pid, process.pid);
  assert.equal(run.platform, "ios");
  assert.equal(run.pid, process.pid);
  assert.equal(typeof status.process_started_at, "string");
  assert.equal(typeof run.process_started_at, "string");
});

test("参数语义：不适用参数进 warnings（机器可读），无参时空数组", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      {
        task_desc: "任务",
        device_serial: UDID,
        model: "Pro",
        verification_level: "checkpoints",
        explorer_mode: "ultra",
        expected_output_desc: "report",
        conversation_id: "c1"
      },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  assert.deepEqual(
    started.warnings.map((warning) => warning.field),
    ["model", "verification_level", "explorer_mode", "expected_output_desc", "conversation_id"]
  );
  assert.equal(started.warnings[0].code, "param_ignored");
  assert.equal(started.warnings[0].actual, "fake-model");
  assert.equal(started.warnings[4].actual, "poll-only");

  const plainChat = scriptedChat([JSON.stringify({ action: "done", success: true, summary: "ok" })]);
  const plain = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务2", device_serial: UDID },
      { entry: ENTRY, device: fakeDevice(), chat: plainChat.chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  assert.deepEqual(plain.warnings, []);
});

test("app_path 明确拒绝并写入任务行", async () => {
  const { runtime } = await makeRuntime();
  const rejected = payloadOf(
    await maybeIosRunTask(runtime, { task_desc: "任务", device_serial: UDID, app_path: "/tmp/app.apk" })
  );
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.code, "app_path_unsupported");
  assert.match(rejected.error, /locked_app_package/);
  assert.deepEqual(rejected.warnings, []);
  const tasks = await runtime.taskList(10);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].taskDesc, "任务");
});

test("app_path（真机 .ipa）：安装失败终止并记录", async () => {
  const { runtime } = await makeRuntime();
  const deviceUdid = "00008110-001A2C681E22801E";
  const ipaPath = path.join(runtime.project.rootDir, "app.ipa");
  fs.writeFileSync(ipaPath, "ipa");
  const calls = [];
  const { chat } = scriptedChat([JSON.stringify({ thought: "完成", action: "done", summary: "ok" })]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      {
        task_desc: "安装并运行",
        device_serial: deviceUdid,
        app_path: "app.ipa",
        locked_app_package: "com.example.app"
      },
      {
        entry: ENTRY,
        device: fakeDevice(),
        chat,
        installIpa: async (udid, ipa) => {
          calls.push([udid, ipa]);
          return { ok: false, error: "signature invalid" };
        }
      }
    )
  );
  assert.equal(started.status, "failed");
  assert.equal(started.code, "install_failed");
  assert.match(started.error, /signature invalid/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], deviceUdid);
  assert.equal(calls[0][1], ipaPath);
});

test("locked_app_package 限制动作：越界 launch 被拒、openUrl 禁止", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "逃逸", action: "launch", bundleId: "com.evil" }),
    JSON.stringify({ thought: "深链", action: "openUrl", url: "https://example.com" }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID, locked_app_package: "com.example.app" },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.match(record.steps[0].outcome, /已被 locked_app_package 限制/);
  assert.match(record.steps[1].outcome, /禁止 openUrl/);
  const launched = device.calls.filter((call) => call[0] === "launch").map((call) => call[1]);
  assert.deepEqual(launched, ["com.example.app"]);
  assert.equal(device.calls.some((call) => call[0] === "openUrl"), false);
});

test("每步持久化屏幕文本、post 截图与 scale（settle 可注入）", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "点", action: "tap", x: 100, y: 200 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, device, chat, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  const step1 = run.steps[0];
  assert.match(step1.screen, /搜索/);
  assert.ok(step1.postShot.endsWith("step-1-post.png"));
  assert.ok(fs.existsSync(path.join(record.runDir, step1.postShot)));
  assert.equal(typeof step1.scale, "number");
});

test("多模态主模型 auto：截图直附主决策调用，历史不留旧截图", async () => {
  const { runtime } = await makeRuntime();
  const base = fakeDevice();
  const bigPng = Buffer.from(toPng(createImage(804, 1748)));
  const device = { ...base, screenshot: async () => bigPng };
  const { chat, messages } = scriptedChat([
    JSON.stringify({ thought: "点", action: "tap", x: 1, y: 1 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "多模态任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        mainVision: true,
        verifier: null,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].perception, "image");
  assert.ok(Array.isArray(messages[0][1].content));
  assert.match(messages[0][1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(typeof messages[1][1].content, "string");
  assert.ok(Array.isArray(messages[1][3].content));
  assert.equal(record.vision, null);
});

test("off 档：纯文本决策，不发图不感知", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat, messages } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  let visionCalls = 0;
  const visionChat = async () => {
    visionCalls += 1;
    return "[]";
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "纯文本", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        visionChat,
        mainVision: true,
        verifier: null,
        env: { AOS_IOS_VISION_MODE: "off" },
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].perception, "text");
  assert.equal(typeof messages[0][1].content, "string");
  assert.equal(visionCalls, 0);
});

test("no-op：界面无变化下一轮提示并记 noop；wait 不参与判定", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat, messages } = scriptedChat([
    JSON.stringify({ thought: "点一", action: "tap", x: 1, y: 1 }),
    JSON.stringify({ thought: "点二", action: "tap", x: 2, y: 2 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "无变化任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        verifier: null,
        env: { AOS_IOS_LOG_FEEDBACK: "0" },
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.doesNotMatch(messages[0][1].content, /没有变化/);
  assert.match(messages[1][3].content, /上一步后界面没有变化/);
  assert.equal(record.steps[1].noop, true);
  assert.ok(record.noopStreak >= 1);

  const waitCase = scriptedChat([
    JSON.stringify({ thought: "等待", action: "wait", ms: 10 }),
    JSON.stringify({ thought: "点", action: "tap", x: 1, y: 1 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const startedWait = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "等待任务", device_serial: UDID },
      {
        entry: ENTRY,
        device: fakeDevice(),
        chat: waitCase.chat,
        verifier: null,
        env: { AOS_IOS_LOG_FEEDBACK: "0" },
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const waitRecord = await waitFor(() => {
    const current = getIosTask(startedWait.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(waitRecord.status, "completed");
  assert.notEqual(waitRecord.steps[1].noop, true);
  assert.doesNotMatch(waitCase.messages[1][3].content, /没有变化/);
});

test("终态验证：pass → completed，test_summary 为真实结构", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "已下单" })
  ]);
  const verifier = {
    chat: async () => JSON.stringify({ pass: true, reason: "界面符合预期" }),
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "下单任务", device_serial: UDID },
      { entry: ENTRY, device, chat, verifier, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.verification.status, "passed");
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.equal(status.test_summary.synthesized, false);
  assert.equal(status.test_summary.passed, 1);
  assert.equal(status.test_summary.verification, "model-final");
  assert.equal(status.test_summary.verification_model, "verify-model");
});

test("终态验证：fail 带 failed_items → failed，摘要与表格采用验证项", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "已下单" })
  ]);
  const verifier = {
    chat: async () =>
      JSON.stringify({
        pass: false,
        reason: "未显示成功提示",
        failed_items: [{ item_text: "订单号未显示", evidence: "列表无订单号" }]
      }),
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "下单任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        verifier,
        env: { AOS_IOS_LOG_FEEDBACK: "0" },
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.match(record.result.summary, /验证未通过：未显示成功提示/);
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.equal(status.test_summary.synthesized, false);
  assert.equal(status.test_summary.failed, 1);
  assert.equal(status.test_summary.failed_items[0].item_text, "订单号未显示");
  assert.equal(status.test_summary.verification, "model-final");
});

test("终态验证：无具体失效项/调用失败 → unavailable 且保持 completed", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const runWith = async (verifier) => {
    const { chat } = scriptedChat([
      JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
    ]);
    const started = payloadOf(
      await maybeIosRunTask(
        runtime,
        { task_desc: "任务", device_serial: UDID },
        { entry: ENTRY, device: fakeDevice(), chat, verifier, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
      )
    );
    return {
      started,
      record: await waitFor(() => {
        const current = getIosTask(started.trace_id);
        return current && current.status !== "running" ? current : null;
      })
    };
  };
  const hollow = await runWith({
    chat: async () => JSON.stringify({ pass: false, reason: "疑似未完成" }),
    model: "verify-model",
    vision: false
  });
  assert.equal(hollow.record.status, "completed");
  assert.equal(hollow.record.verification.status, "unavailable");
  const hollowStatus = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: hollow.started.trace_id })
  );
  assert.equal(hollowStatus.test_summary.verification, "unavailable");
  assert.equal(hollowStatus.test_summary.synthesized, true);

  const broken = await runWith({
    chat: async () => {
      throw new Error("verify down");
    },
    model: "verify-model",
    vision: false
  });
  assert.equal(broken.record.status, "completed");
  assert.equal(broken.record.verification.status, "unavailable");
  assert.match(broken.record.verification.reason, /验证调用失败/);
  assert.deepEqual(device.calls, []);
});

test("终态验证：层级补采失败且验证模型非多模态 → unavailable", async () => {
  const { runtime } = await makeRuntime();
  let nodeCalls = 0;
  const device = {
    ...fakeDevice(),
    nodes: async () => {
      nodeCalls += 1;
      if (nodeCalls >= 2) throw new Error("hierarchy down");
      return NODES;
    }
  };
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const verifier = {
    chat: async () => JSON.stringify({ pass: true, reason: "ok" }),
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      { entry: ENTRY, device, chat, verifier, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.verification.status, "unavailable");
  assert.equal(record.verification.stale, true);
  assert.match(record.verification.reason, /层级补采失败/);
});

test("失败日志：采集落盘、摘要追加、inspect search 可检索", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "放弃", action: "fail", reason: "按钮不存在" })
  ]);
  const collected = [];
  const logCollector = {
    collect: async (request) => {
      collected.push(request);
      return { status: "ok", text: "MyApp[123] fatal: boom\nMyApp[123] detail", serial: UDID };
    }
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "会失败的任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        verifier: null,
        logCollector,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.equal(record.failureLogs.status, "ok");
  assert.equal(record.failureLogs.source, "simctl-log");
  assert.equal(record.failureLogs.lines, 2);
  assert.ok(fs.existsSync(path.join(record.runDir, "logs/device.log")));
  assert.match(record.result.summary, /设备日志已采集（2 行，来源 simctl-log）/);
  assert.equal(collected.length, 1);
  assert.equal(collected[0].processName, "");

  const search = payloadOf(
    maybeIosInspectTrace(runtime, { action: "search", trace_id: started.trace_id, query: "boom" })
  );
  assert.equal(search.ok, true);
  assert.match(search.results, /device\.log/);
  assert.match(search.results, /boom/);
});

test("历史压缩：更早步骤输出动作链摘要（AOS_IOS_HISTORY_STEPS=4）", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const responses = Array.from({ length: 5 }, (_, index) =>
    JSON.stringify({ thought: `第${index + 1}步思考。继续`, action: "tap", x: 1, y: 1 })
  );
  responses.push(JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" }));
  const { chat, messages } = scriptedChat(responses);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "长任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        verifier: null,
        env: { AOS_IOS_HISTORY_STEPS: "4", AOS_IOS_LOG_FEEDBACK: "0" },
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.doesNotMatch(messages[4][9].content, /更早步骤摘要/);
  assert.match(messages[5][11].content, /更早步骤摘要/);
  assert.match(messages[5][11].content, /1\) 第1步思考/);
  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.match(run.digest, /第1步思考/);
});

test("sparse 档：可见文本充足时不触发视觉感知（auto 会触发）", async () => {
  const { runtime } = await makeRuntime();
  const richNodes = [
    { type: "Application", label: "", value: "", id: "", rect: { x: 0, y: 0, width: 402, height: 874 } },
    { type: "Button", label: "甲", value: "", id: "", rect: { x: 0, y: 0, width: 10, height: 10 } },
    { type: "Button", label: "乙", value: "", id: "", rect: { x: 20, y: 0, width: 10, height: 10 } },
    { type: "Button", label: "丙", value: "", id: "", rect: { x: 40, y: 0, width: 10, height: 10 } }
  ];
  const visionTarget = {
    chat: { baseUrl: "https://v.example.com/v1", apiKey: "vk", model: "qwen-vl-max" },
    model: "qwen-vl-max",
    source: "env"
  };
  const runWith = async (mode) => {
    const device = { ...fakeDevice(), nodes: async () => richNodes };
    let calls = 0;
    const visionChat = async () => {
      calls += 1;
      return "[]";
    };
    const { chat } = scriptedChat([
      JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
    ]);
    const started = payloadOf(
      await maybeIosRunTask(
        runtime,
        { task_desc: "档位任务", device_serial: UDID },
        {
          entry: ENTRY,
          device,
          chat,
          visionChat,
          visionTarget,
          verifier: null,
          env: { AOS_IOS_VISION_MODE: mode, AOS_IOS_LOG_FEEDBACK: "0" },
          listSimulators: bootedSims(),
          stepDelayMs: 0,
          settleMs: 0
        }
      )
    );
    const record = await waitFor(() => {
      const current = getIosTask(started.trace_id);
      return current && current.status !== "running" ? current : null;
    });
    return { record, calls };
  };
  const sparse = await runWith("sparse");
  assert.equal(sparse.calls, 0);
  assert.equal(sparse.record.steps[0].perception, "text");
  const auto = await runWith("auto");
  assert.equal(auto.calls, 1);
  assert.equal(auto.record.steps[0].perception, "vision-text");
});

test("验证模型：AOS_IOS_VERIFY_LLM 不可用回退主模型（调用失败 → unavailable）", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "任务", device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat,
        env: { AOS_IOS_VERIFY_LLM: "missing-entry" },
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.verification.status, "unavailable");
  assert.match(record.verification.reason, /验证调用失败/);
});

test("失败日志：真机环形缓冲快照按时间窗过滤并落盘", async () => {
  const { runtime } = await makeRuntime();
  const deviceUdid = "00008110-001A2C681E22801E";
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${months[now.getMonth()]} ${String(now.getDate()).padStart(2, " ")} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.000`;
  const tailLines = [`${stamp} MyApp[42] <Notice>: hello-tail`, "junk line without timestamp"];
  const tailCalls = { start: 0, stop: 0 };
  const tail = {
    start: () => {
      tailCalls.start += 1;
    },
    stop: () => {
      tailCalls.stop += 1;
    },
    snapshot: () => tailLines
  };
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "放弃", action: "fail", reason: "无法继续" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: "真机失败任务", device_serial: deviceUdid },
      { entry: ENTRY, device: fakeDevice(), chat, verifier: null, logTail: tail, stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "failed");
  assert.equal(record.failureLogs.status, "ok");
  assert.equal(record.failureLogs.source, "idevicesyslog");
  assert.equal(record.failureLogs.lines, 1);
  assert.equal(tailCalls.start, 1);
  assert.equal(tailCalls.stop, 1);
  const logFile = path.join(record.runDir, "logs/device.log");
  const content = fs.readFileSync(logFile, "utf-8");
  assert.match(content, /hello-tail/);
  assert.doesNotMatch(content, /junk line/);
  assert.match(content, /时间窗口近似|来源 idevicesyslog/);
});

test("脚本断言：解析 【AOS-EXPECT】 块（缺失/非法 → null，hints 过滤空项）", () => {
  assert.equal(parseScriptPlan("普通任务描述"), null);
  assert.equal(parseScriptPlan("x【AOS-EXPECT】not-json"), null);
  assert.equal(parseScriptPlan('x【AOS-EXPECT】{"steps":[]}'), null);
  const parsed = parseScriptPlan(
    '任务\n脚本断言：【AOS-EXPECT】{"start":{"screen":"首页","hints":["欢迎",""]},"steps":[{"index":1,"screen":"订单页","hints":["订单成功",""],"provenance":"explicit","confidence":"high","kind":"assert"},{"index":2,"screen":null,"hints":[],"provenance":"inferred","confidence":"low","kind":"explore"}]}'
  );
  assert.deepEqual(parsed.start, { screen: "首页", hints: ["欢迎"] });
  assert.deepEqual(parsed.steps, [
    { index: 1, screen: "订单页", hints: ["订单成功"], kind: "assert" },
    { index: 2, screen: null, hints: [], kind: "explore" }
  ]);
  const startOnly = parseScriptPlan('x【AOS-EXPECT】{"start":{"screen":"首页","hints":["欢迎"]}}');
  assert.deepEqual(startOnly, { start: { screen: "首页", hints: ["欢迎"] }, steps: [] });
});

test("脚本断言：逐步核对命中，未出现项进入验证证据与 test_summary.adherence", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const extraNode = {
    type: "StaticText",
    label: "订单成功",
    value: "",
    id: "",
    rect: { x: 0, y: 300, width: 200, height: 30 }
  };
  let tapped = false;
  device.tap = async (x, y) => {
    device.calls.push(["tap", x, y]);
    tapped = true;
  };
  device.nodes = async () => (tapped ? [...NODES, extraNode] : NODES);

  const taskDesc = [
    "【设计流程端到端验证】下单",
    "1) 点击「搜索」",
    "2) 完成下单",
    '脚本断言（供 iOS 执行器自动核对，执行时无需处理）：【AOS-EXPECT】{"steps":[{"index":1,"screen":"订单页","hints":["订单成功"]},{"index":2,"screen":"结果页","hints":["永远不出现的文案"]}]}'
  ].join("\n");
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "点搜索", action: "tap", x: 140, y: 220 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "已下单" })
  ]);
  const verifierPrompts = [];
  const verifier = {
    chat: async (msgs) => {
      verifierPrompts.push(msgs.at(-1).content);
      return JSON.stringify({ pass: true, reason: "界面符合预期" });
    },
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: taskDesc, device_serial: UDID },
      { entry: ENTRY, device, chat, verifier, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.deepEqual(record.scriptAdherence, {
    checkable: 2,
    satisfied: 1,
    unchecked: 0,
    unresolved: [{ index: 2, screen: "结果页", hints: ["永远不出现的文案"] }],
    deferred: { total: 0, reached: 0 }
  });
  assert.ok(
    record.steps.some((step) => Array.isArray(step.scriptHits) && step.scriptHits.includes(1)),
    "命中序号写入步骤轨迹"
  );
  assert.match(String(verifierPrompts[0]), /脚本断言核对/);
  assert.match(String(verifierPrompts[0]), /永远不出现的文案/);
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.equal(status.test_summary.adherence.satisfied, 1);
  assert.equal(status.test_summary.adherence.unresolved.length, 1);
  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.equal(run.script_adherence.checkable, 2);
});

test("探索步骤（deferred）：不进门禁、命中目标屏记 reached、验证提示词豁免", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const orderNode = {
    type: "StaticText",
    label: "订单成功",
    value: "",
    id: "",
    rect: { x: 0, y: 300, width: 200, height: 30 }
  };
  const nextNode = {
    type: "StaticText",
    label: "下一步",
    value: "",
    id: "",
    rect: { x: 0, y: 340, width: 200, height: 30 }
  };
  let tapped = false;
  device.tap = async (x, y) => {
    device.calls.push(["tap", x, y]);
    tapped = true;
  };
  device.nodes = async () => (tapped ? [...NODES, orderNode, nextNode] : NODES);

  const taskDesc = [
    "【设计流程端到端验证】下单",
    "1) 点击「搜索」",
    "2) 完成下单",
    '脚本断言（供 iOS 执行器自动核对，执行时无需处理）：【AOS-EXPECT】{"steps":[{"index":1,"screen":"订单页","hints":["订单成功"],"kind":"assert"},{"index":2,"screen":"下一步","hints":[],"kind":"explore"}]}'
  ].join("\n");
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "点搜索", action: "tap", x: 140, y: 220 }),
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "已下单" })
  ]);
  const verifierPrompts = [];
  const verifier = {
    chat: async (msgs) => {
      verifierPrompts.push(msgs.at(-1).content);
      return JSON.stringify({ pass: true, reason: "界面符合预期" });
    },
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: taskDesc, device_serial: UDID },
      { entry: ENTRY, device, chat, verifier, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });

  assert.equal(record.status, "completed");
  assert.deepEqual(record.scriptAdherence, {
    checkable: 1,
    satisfied: 1,
    unchecked: 0,
    unresolved: [],
    deferred: { total: 1, reached: 1 }
  });
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.equal(status.test_summary.adherence.deferred.total, 1);
  assert.equal(status.test_summary.adherence.deferred.reached, 1);
  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.equal(run.script_adherence.deferred.total, 1);
  assert.match(String(verifierPrompts[0]), /另有 1 步探索/);
});

test("探索步骤未达成（目标屏未出现）仍 completed，deferred.reached=0", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const orderNode = {
    type: "StaticText",
    label: "订单成功",
    value: "",
    id: "",
    rect: { x: 0, y: 300, width: 200, height: 30 }
  };
  let tapped = false;
  device.tap = async (x, y) => {
    device.calls.push(["tap", x, y]);
    tapped = true;
  };
  device.nodes = async () => (tapped ? [...NODES, orderNode] : NODES);

  const taskDesc = [
    "【设计流程端到端验证】下单",
    "1) 点击「搜索」",
    '脚本断言（供 iOS 执行器自动核对，执行时无需处理）：【AOS-EXPECT】{"steps":[{"index":1,"screen":"订单页","hints":["订单成功"],"kind":"assert"},{"index":2,"screen":"不存在的目标屏","hints":[],"kind":"explore"}]}'
  ].join("\n");
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "点搜索", action: "tap", x: 140, y: 220 }),
    JSON.stringify({
      thought: "探索未达成，记录路径后完成",
      action: "done",
      success: true,
      summary: "已完成可执行部分，探索未达成已记录"
    })
  ]);
  const verifier = {
    chat: async () => JSON.stringify({ pass: true, reason: "界面符合预期" }),
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: taskDesc, device_serial: UDID },
      { entry: ENTRY, device, chat, verifier, listSimulators: bootedSims(), stepDelayMs: 0, settleMs: 0 }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });

  assert.equal(record.status, "completed", "exploration gaps never fail the case");
  assert.deepEqual(record.scriptAdherence, {
    checkable: 1,
    satisfied: 1,
    unchecked: 0,
    unresolved: [],
    deferred: { total: 1, reached: 0 }
  });
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.equal(status.test_summary.adherence.deferred.reached, 0);
});

test("起始屏核对：未命中时提示模型导航，并进入验证证据与 test_summary.preflight", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  const taskDesc = [
    "【设计流程端到端验证】下单",
    "1) 完成下单",
    '脚本断言：【AOS-EXPECT】{"start":{"screen":"首页","hints":["欢迎"]},"steps":[{"index":1,"screen":"订单页","hints":["订单成功"]}]}'
  ].join("\n");
  const scripted = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "已下单" })
  ]);
  const verifierPrompts = [];
  const verifier = {
    chat: async (msgs) => {
      verifierPrompts.push(msgs.at(-1).content);
      return JSON.stringify({ pass: true, reason: "界面符合预期" });
    },
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: taskDesc, device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat: scripted.chat,
        verifier,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.preflight.status, "unmatched");
  assert.match(String(scripted.messages[0][1].content), /起始屏核对未通过/);
  assert.match(String(scripted.messages[0][1].content), /欢迎/);
  assert.match(record.result.summary, /⚠ 起始屏核对未通过/);
  assert.match(String(verifierPrompts[0]), /起始屏核对（确定性）/);
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.deepEqual(status.test_summary.preflight, { screen: "首页", status: "unmatched" });
  const run = JSON.parse(fs.readFileSync(path.join(record.runDir, "run.json"), "utf-8"));
  assert.equal(run.preflight.screen, "首页");
});

test("起始屏核对：命中即 matched（首步），不注入提示", async () => {
  const { runtime } = await makeRuntime();
  const device = fakeDevice();
  device.nodes = async () => [
    ...NODES,
    { type: "StaticText", label: "欢迎", value: "", id: "", rect: { x: 0, y: 300, width: 120, height: 30 } }
  ];
  const taskDesc = '任务\n【AOS-EXPECT】{"start":{"screen":"首页","hints":["欢迎"]}}';
  const scripted = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const verifier = {
    chat: async () => JSON.stringify({ pass: true, reason: "ok" }),
    model: "verify-model",
    vision: false
  };
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: taskDesc, device_serial: UDID },
      {
        entry: ENTRY,
        device,
        chat: scripted.chat,
        verifier,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.preflight.status, "matched");
  assert.equal(record.preflight.matchedAtStep, 1);
  assert.doesNotMatch(String(scripted.messages[0][1].content), /起始屏核对未通过/);
  const status = payloadOf(
    maybeIosManageTask(runtime, { action: "status", trace_id: started.trace_id })
  );
  assert.deepEqual(status.test_summary.preflight, {
    screen: "首页",
    status: "matched",
    matched_at_step: 1
  });
});

test("脚本断言：未出现项在无验证时写入摘要提示且不改变完成态", async () => {
  const { runtime } = await makeRuntime();
  const taskDesc =
    '任务\n【AOS-EXPECT】{"steps":[{"index":1,"screen":"X","hints":["永不出现"]}]}';
  const { chat } = scriptedChat([
    JSON.stringify({ thought: "完成", action: "done", success: true, summary: "ok" })
  ]);
  const started = payloadOf(
    await maybeIosRunTask(
      runtime,
      { task_desc: taskDesc, device_serial: UDID },
      {
        entry: ENTRY,
        device: fakeDevice(),
        chat,
        verifier: null,
        listSimulators: bootedSims(),
        stepDelayMs: 0,
        settleMs: 0
      }
    )
  );
  const record = await waitFor(() => {
    const current = getIosTask(started.trace_id);
    return current && current.status !== "running" ? current : null;
  });
  assert.equal(record.status, "completed");
  assert.equal(record.scriptAdherence.unresolved.length, 1);
  assert.match(record.result.summary, /⚠ 脚本断言未出现/);
  assert.match(record.result.summary, /永不出现/);
});
