import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { classifyIosSerial, isSimulatorUdid, parseIdbNodes, parseSimulators } from "../dist/device/ios.js";
import { formatIosHierarchy, maybeIosDeviceState } from "../dist/tools/ios-state.js";
import {
  baseConfig,
  createImage,
  loadTestRuntime,
  makeTempProject,
  StubProxy,
  toPng
} from "./helpers.js";

const PNG_BYTES = Buffer.from(toPng(createImage(4, 4)));
const UDID = "65584900-E161-4125-8928-587499DD6457";

function bootedList(udid = UDID) {
  return async () => ({
    ok: true,
    simulators: [{ udid, name: "iPhone 17 Pro", state: "Booted", isAvailable: true }]
  });
}

async function makeRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });
  return { dir, runtime };
}

function textOf(result) {
  return result.content[0].text;
}

test("isSimulatorUdid: 仅接受规范 UUID", () => {
  assert.equal(isSimulatorUdid(UDID), true);
  assert.equal(isSimulatorUdid("emulator-5554"), false);
  assert.equal(isSimulatorUdid(""), false);
  assert.equal(isSimulatorUdid("R58M12345"), false);
});

test("classifyIosSerial: 模拟器 UUID / 真机 UDID（现代 8-16 与旧 40-hex）", () => {
  assert.equal(classifyIosSerial(UDID), "simulator");
  assert.equal(classifyIosSerial("00008110-001A2C681E22801E"), "device");
  assert.equal(classifyIosSerial("A".repeat(40)), "device");
  assert.equal(classifyIosSerial("emulator-5554"), null);
  assert.equal(classifyIosSerial(""), null);
});

test("maybeIosDeviceState: 真机 UDID 跳过 simctl 校验（best-effort）", async () => {
  const { dir, runtime } = await makeRuntime();
  const deviceUdid = "00008110-001A2C681E22801E";
  let listCalls = 0;
  const result = await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: deviceUdid }, {
    listSimulators: async () => {
      listCalls += 1;
      throw new Error("should not be called");
    },
    wda: {
      screenshot: async () => ({ ok: true, value: PNG_BYTES }),
      nodes: async () => ({ ok: false, error: "unused" })
    }
  });
  assert.equal(listCalls, 0);
  const text = textOf(result);
  assert.match(text, /^file:\/\//);
  assert.ok(fs.existsSync(text.slice("file://".length)));
  void dir;
});

test("parseSimulators: 解析状态与可用性；坏 JSON 返回 null", () => {
  const simulators = parseSimulators(
    JSON.stringify({
      devices: {
        "runtime-a": [
          { udid: "A", name: "iPhone", state: "Booted", isAvailable: true },
          { udid: "B", name: "iPad", state: "Shutdown" }
        ]
      }
    })
  );
  assert.equal(simulators.length, 2);
  assert.deepEqual(simulators[0], { udid: "A", name: "iPhone", state: "Booted", isAvailable: true });
  assert.equal(simulators[1].isAvailable, true);
  assert.equal(parseSimulators("nope"), null);
});

test("parseIdbNodes: 提取 label/value/id/rect，跳过无 frame 的条目", () => {
  const nodes = parseIdbNodes(
    JSON.stringify([
      { type: "Button", AXLabel: "通用", AXValue: "", AXUniqueId: "btn", frame: { x: 1, y: 2, width: 3, height: 4 } },
      { type: "Other", AXLabel: "无几何" },
      { type: "StaticText", AXValue: "Search" }
    ])
  );
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], {
    type: "Button",
    label: "通用",
    value: "",
    id: "btn",
    rect: { x: 1, y: 2, width: 3, height: 4 }
  });
  assert.equal(parseIdbNodes("{}"), null);
});

test("formatIosHierarchy: 归一化坐标、Value 行与截断标记", () => {
  const nodes = [
    { type: "Application", label: "", value: "", id: "", rect: { x: 0, y: 0, width: 402, height: 874 } },
    { type: "Button", label: "通用", value: "", id: "", rect: { x: 201, y: 437, width: 100, height: 44 } },
    { type: "SearchField", label: "", value: "Search", id: "", rect: { x: 0, y: 80, width: 402, height: 44 } },
    { type: "TextField", label: "账号", value: "abc", id: "", rect: { x: 0, y: 0, width: 100, height: 20 } }
  ];
  const text = formatIosHierarchy(nodes);
  assert.equal(
    text,
    [
      "[1] Text: '通用' | Bounds: [500,500][749,550]",
      "[2] Value: 'Search' | Bounds: [0,92][1000,142]",
      "[3] Text: '账号' | Bounds: [0,0][249,23] | Value: 'abc'"
    ].join("\n")
  );
  assert.match(formatIosHierarchy(nodes, 2), /truncated, 1 more elements/);
});

test("maybeIosDeviceState: Android serial 或缺省 → 不接管（返回 null）", async () => {
  const { runtime } = await makeRuntime();
  assert.equal(await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: "emulator-5554" }), null);
  assert.equal(await maybeIosDeviceState(runtime, { view_type: "screenshot" }), null);
});

test("maybeIosDeviceState: 未知 UDID / 未启动 / 非 macOS 给出明确错误", async () => {
  const { runtime } = await makeRuntime();
  const unknown = await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: UDID }, {
    listSimulators: async () => ({ ok: true, simulators: [] })
  });
  assert.match(textOf(unknown), /未找到模拟器/);

  const shutdown = await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: UDID }, {
    listSimulators: async () => ({
      ok: true,
      simulators: [{ udid: UDID, name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true }]
    })
  });
  assert.match(textOf(shutdown), /未启动.*simctl boot/);

  const unsupported = await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: UDID }, {
    platform: "linux",
    listSimulators: async ({ platform }) =>
      platform === "darwin"
        ? { ok: true, simulators: [] }
        : { ok: false, error: "ios-unsupported" }
  });
  assert.match(textOf(unsupported), /仅支持 macOS/);
});

test("maybeIosDeviceState: screenshot 写入项目 traces 并返回 file:// 路径", async () => {
  const { dir, runtime } = await makeRuntime();
  const result = await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: UDID }, {
    listSimulators: bootedList(),
    captureIosPng: async () => ({ ok: true, bytes: PNG_BYTES, serial: UDID, tool: "idb" })
  });
  const text = textOf(result);
  const expected = path.join(dir, ".artemis", "traces", "live_screenshots", `live_screenshot_${UDID}.png`);
  assert.equal(text, `file://${expected}`);
  assert.equal(fs.readFileSync(expected).equals(PNG_BYTES), true);
});

test("maybeIosDeviceState: screenshot 失败与非法 view_type 返回错误文本", async () => {
  const { runtime } = await makeRuntime();
  const failed = await maybeIosDeviceState(runtime, { view_type: "screenshot", device_serial: UDID }, {
    listSimulators: bootedList(),
    captureIosPng: async () => ({ ok: false, serial: UDID, error: "not-found" })
  });
  assert.match(textOf(failed), /^Error: 未找到 idb/);

  const invalid = await maybeIosDeviceState(runtime, { view_type: "tap", device_serial: UDID }, {
    listSimulators: bootedList()
  });
  assert.match(textOf(invalid), /Invalid view_type 'tap'/);
});

test("maybeIosDeviceState: hierarchy 走 idb 描述并输出简化列表", async () => {
  const { runtime } = await makeRuntime();
  const result = await maybeIosDeviceState(runtime, { view_type: "hierarchy", device_serial: UDID }, {
    listSimulators: bootedList(),
    describeIosUi: async () => ({
      ok: true,
      serial: UDID,
      nodes: [
        { type: "Application", label: "", value: "", id: "", rect: { x: 0, y: 0, width: 402, height: 874 } },
        { type: "Button", label: "通用", value: "", id: "", rect: { x: 0, y: 0, width: 402, height: 44 } }
      ]
    })
  });
  const text = textOf(result);
  assert.match(text, /\[1\] Text: '通用' \| Bounds: \[0,0\]\[1000,50\]/);
});

test("maybeIosDeviceState: hierarchy 描述失败返回结构化错误", async () => {
  const { runtime } = await makeRuntime();
  const failed = await maybeIosDeviceState(runtime, { view_type: "hierarchy", device_serial: UDID }, {
    listSimulators: bootedList(),
    describeIosUi: async () => ({ ok: false, error: "timeout" })
  });
  assert.match(textOf(failed), /^Error: idb 命令超时/);
});
