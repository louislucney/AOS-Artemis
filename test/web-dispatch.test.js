import assert from "node:assert/strict";
import test from "node:test";

import { selectWebAssignment } from "../dist/web/dispatch.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const TTL = 90_000;

function makeTools(overrides = {}) {
  return {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false,
    ...overrides
  };
}

function makeDevice(overrides = {}) {
  return {
    serial: "device-1",
    name: "",
    model: null,
    osVersion: null,
    platform: "android",
    kind: "device",
    state: "device",
    ...overrides
  };
}

function makeRunner(overrides = {}) {
  return {
    id: "runner-1",
    hostId: "host-1",
    hostname: "host-1.local",
    platforms: ["android"],
    devices: [],
    tools: makeTools({ adb: true }),
    lastSeenAt: new Date(NOW - 5_000).toISOString(),
    ...overrides
  };
}

function makeLease(overrides = {}) {
  return {
    hostId: "host-1",
    serial: "device-1",
    taskId: "task-other",
    projectId: null,
    acquiredAt: new Date(NOW - 30_000).toISOString(),
    renewAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides
  };
}

function requirements(overrides = {}) {
  return { platform: "android", deviceKind: "any", ...overrides };
}

function auto(runners, extra = {}) {
  const { leases, rng, requirements: req, ...rest } = extra;
  return selectWebAssignment({
    runners,
    leases: leases ?? [],
    request: { assignment: "auto", requirements: req ?? requirements(), ...rest },
    nowMs: NOW,
    runnerTtlMs: TTL,
    ...(rng ? { rng } : {})
  });
}

function manual(runners, extra = {}) {
  const { leases, rng, requirements: req, ...rest } = extra;
  return selectWebAssignment({
    runners,
    leases: leases ?? [],
    request: { assignment: "manual", requirements: req ?? requirements(), ...rest },
    nowMs: NOW,
    runnerTtlMs: TTL,
    ...(rng ? { rng } : {})
  });
}

const iosRunner = makeRunner({
  id: "runner-ios",
  hostId: "host-ios",
  hostname: "ios.local",
  platforms: ["ios"],
  devices: [
    makeDevice({
      serial: "sim-15",
      platform: "ios",
      kind: "simulator",
      model: "iPhone 15",
      osVersion: "17.2"
    })
  ],
  tools: makeTools({ simctl: true, maestro: true })
});

const androidRunner = makeRunner({
  id: "runner-android",
  hostId: "host-android",
  hostname: "android.local",
  platforms: ["android"],
  devices: [
    makeDevice({
      serial: "pixel",
      platform: "android",
      kind: "device",
      model: "Pixel 7",
      osVersion: "14"
    })
  ],
  tools: makeTools({ adb: true, maestro: true })
});

test("硬过滤：Android 任务不会选 iOS runner", () => {
  const result = auto([iosRunner, androidRunner], {
    requirements: requirements({ platform: "android" })
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "host-android");
  assert.equal(result.deviceSerial, "pixel");
});

test("硬过滤：deviceKind=simulator 选模拟器/模拟机，不选真机", () => {
  const emulator = makeDevice({ serial: "emulator-5554", platform: "android", kind: "emulator" });
  const runner = makeRunner({ devices: [makeDevice({ serial: "real-pixel" }), emulator] });
  const result = auto([runner], {
    requirements: requirements({ platform: "android", deviceKind: "simulator" })
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "emulator-5554");

  const iosSim = auto([iosRunner], {
    requirements: requirements({ platform: "ios", deviceKind: "simulator" })
  });
  assert.equal(iosSim.ok, true);
  assert.equal(iosSim.deviceSerial, "sim-15");
});

test("硬过滤：deviceKind=device 不选模拟器/模拟机", () => {
  const runner = makeRunner({
    devices: [
      makeDevice({ serial: "emulator-5554", kind: "emulator" }),
      makeDevice({ serial: "real-pixel" })
    ]
  });
  const result = auto([runner], {
    requirements: requirements({ platform: "android", deviceKind: "device" })
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "real-pixel");

  const ios = auto([iosRunner], {
    requirements: requirements({ platform: "ios", deviceKind: "device" })
  });
  assert.equal(ios.ok, false);
  assert.equal(ios.code, "no-device");
});

test("硬过滤：缺 maestro 工具不选；未知工具名 requirements-unmet", () => {
  const withoutMaestro = makeRunner({
    hostId: "host-no-maestro",
    devices: [makeDevice({ serial: "no-maestro" })],
    tools: makeTools({ adb: true, maestro: false })
  });
  const withMaestro = makeRunner({
    hostId: "host-maestro",
    devices: [makeDevice({ serial: "with-maestro" })],
    tools: makeTools({ adb: true, maestro: true })
  });
  const result = auto([withoutMaestro, withMaestro], {
    requirements: requirements({ platform: "android", tools: ["maestro"] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "host-maestro");
  assert.equal(result.deviceSerial, "with-maestro");

  const unknown = auto([withMaestro], {
    requirements: requirements({ platform: "android", tools: ["scrcpy"] })
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "requirements-unmet");
});

test("硬过滤：appium/idb 等工具按 RunnerTools 布尔值映射", () => {
  const runner = makeRunner({
    devices: [makeDevice({ serial: "ios-real", platform: "ios" })],
    platforms: ["ios"],
    tools: makeTools({ idb: true, appium: false })
  });
  const idb = auto([runner], {
    requirements: requirements({ platform: "ios", tools: ["idb"] })
  });
  assert.equal(idb.ok, true);

  const appium = auto([runner], {
    requirements: requirements({ platform: "ios", tools: ["appium"] })
  });
  assert.equal(appium.ok, false);
  assert.equal(appium.code, "no-device");
});

test("软偏好：deviceModel 精确匹配分数高于同系列，同系列高于不匹配", () => {
  const exact = auto([iosRunner], {
    requirements: requirements({ platform: "ios", deviceModel: ["iPhone 15"] })
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.deviceSerial, "sim-15");
  assert.equal(exact.score, 20);

  const seriesRunner = makeRunner({
    hostId: "host-ios",
    platforms: ["ios"],
    devices: [
      makeDevice({ serial: "sim-15-pro", platform: "ios", kind: "simulator", model: "iPhone 15 Pro" })
    ]
  });
  const series = auto([seriesRunner], {
    requirements: requirements({ platform: "ios", deviceModel: ["iPhone 15"] })
  });
  assert.equal(series.ok, true);
  assert.equal(series.score, 10);

  const otherRunner = makeRunner({
    hostId: "host-ios",
    platforms: ["ios"],
    devices: [makeDevice({ serial: "sim-14", platform: "ios", kind: "simulator", model: "iPhone 14" })]
  });
  const other = auto([otherRunner], {
    requirements: requirements({ platform: "ios", deviceModel: ["iPhone 15"] })
  });
  assert.equal(other.ok, true);
  assert.equal(other.score, 0);
  assert.ok(exact.score > series.score && series.score > other.score);
});

test("软偏好：OS 版本满足 min/max 加分，越接近 min 分数越高", () => {
  const runner = makeRunner({
    devices: [
      makeDevice({ serial: "os-14", osVersion: "14" }),
      makeDevice({ serial: "os-15", osVersion: "15" })
    ]
  });
  const result = auto([runner], {
    requirements: requirements({ platform: "android", osVersion: { min: "14" } })
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "os-14");
  assert.equal(result.score, 8);

  const only15 = auto([makeRunner({ devices: [makeDevice({ serial: "os-15", osVersion: "15" })] })], {
    requirements: requirements({ platform: "android", osVersion: { min: "14" } })
  });
  assert.equal(only15.ok, true);
  assert.equal(only15.score, 6);
  assert.ok(result.score > only15.score);
});

test("软偏好：min/max 含等号；超出范围的版本不加分", () => {
  const runner = makeRunner({
    devices: [
      makeDevice({ serial: "in-range", osVersion: "18.0" }),
      makeDevice({ serial: "above-max", osVersion: "19.0" })
    ]
  });
  const result = auto([runner], {
    requirements: requirements({ platform: "android", osVersion: { min: "17.0", max: "18.0" } })
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "in-range");
  assert.equal(result.score, 6);
});

test("软偏好：缺失 model/osVersion 仍可被选但分数低", () => {
  const runner = makeRunner({
    platforms: ["ios"],
    devices: [
      makeDevice({ serial: "fully-known", platform: "ios", kind: "simulator", model: "iPhone 15", osVersion: "17.0" }),
      makeDevice({ serial: "unknown-meta", platform: "ios", kind: "simulator", model: null, osVersion: null })
    ]
  });
  const req = requirements({
    platform: "ios",
    deviceModel: ["iPhone 15"],
    osVersion: { min: "17.0" }
  });
  const result = auto([runner], { requirements: req });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "fully-known");
  assert.equal(result.score, 28);

  const onlyUnknown = auto(
    [makeRunner({ platforms: ["ios"], devices: [makeDevice({ serial: "unknown-meta", platform: "ios", kind: "simulator" })] })],
    { requirements: req }
  );
  assert.equal(onlyUnknown.ok, true, "未知元数据不能当匹配，但软偏好不排除设备");
  assert.equal(onlyUnknown.score, 0);
});

test("指定 host：只在该 host 的设备里选", () => {
  const lowScore = makeRunner({
    hostId: "host-low",
    devices: [makeDevice({ serial: "low" })],
    platforms: ["android"]
  });
  const highScore = makeRunner({
    hostId: "host-high",
    devices: [makeDevice({ serial: "high" })],
    platforms: ["android"]
  });
  const result = manual([lowScore, highScore], {
    targetHostId: "host-low",
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "host-low");
  assert.equal(result.deviceSerial, "low");
});

test("指定 host：host 离线或未注册返回 host-offline", () => {
  const offline = makeRunner({
    hostId: "host-offline",
    lastSeenAt: new Date(NOW - TTL - 1).toISOString()
  });
  const result = manual([offline], { targetHostId: "host-offline" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "host-offline");

  const missing = manual([androidRunner], { targetHostId: "host-unknown" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "host-offline");
});

test("指定 host + 钉住设备：选中该设备（即使分数更低）", () => {
  const runner = makeRunner({
    hostId: "host-pinned",
    devices: [makeDevice({ serial: "wanted" }), makeDevice({ serial: "better" })]
  });
  const result = manual([runner], {
    targetHostId: "host-pinned",
    devicePinned: true,
    deviceSerial: "wanted",
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "host-pinned");
  assert.equal(result.deviceSerial, "wanted");
  assert.equal(result.score, 0);
});

test("指定 host + 钉住设备：serial 不属于 host 返回 requirements-unmet", () => {
  const result = manual([androidRunner], {
    targetHostId: "host-android",
    devicePinned: true,
    deviceSerial: "sim-15",
    requirements: requirements({ platform: "android" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "requirements-unmet");
});

test("指定 host + 钉住设备：不满足硬要求返回 requirements-unmet", () => {
  const result = manual([androidRunner], {
    targetHostId: "host-android",
    devicePinned: true,
    deviceSerial: "pixel",
    requirements: requirements({ platform: "android", deviceKind: "simulator" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "requirements-unmet");
});

test("指定 host + 钉住设备：被有效租约占用返回 device-busy", () => {
  const result = manual([androidRunner], {
    targetHostId: "host-android",
    devicePinned: true,
    deviceSerial: "pixel",
    requirements: requirements({ platform: "android" }),
    leases: [makeLease({ hostId: "host-android", serial: "pixel" })]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "device-busy");
});

test("租约：过期（expiresAt <= now）不阻塞，非法时间保守占用", () => {
  const expired = manual([androidRunner], {
    targetHostId: "host-android",
    requirements: requirements({ platform: "android" }),
    leases: [makeLease({ hostId: "host-android", serial: "pixel", expiresAt: new Date(NOW).toISOString() })]
  });
  assert.equal(expired.ok, true);
  assert.equal(expired.deviceSerial, "pixel");

  const invalid = manual([androidRunner], {
    targetHostId: "host-android",
    requirements: requirements({ platform: "android" }),
    leases: [makeLease({ hostId: "host-android", serial: "pixel", expiresAt: "not-a-date" })]
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "device-busy");
});

test("租约：本任务自己的租约不阻塞", () => {
  const result = selectWebAssignment({
    runners: [androidRunner],
    leases: [makeLease({ hostId: "host-android", serial: "pixel", taskId: "task-self" })],
    request: {
      assignment: "manual",
      targetHostId: "host-android",
      requirements: requirements({ platform: "android" })
    },
    nowMs: NOW,
    runnerTtlMs: TTL,
    taskId: "task-self"
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "pixel");
});

test("auto：同分用注入 rng 固定结果", () => {
  const runner = makeRunner({
    devices: [makeDevice({ serial: "a" }), makeDevice({ serial: "b" }), makeDevice({ serial: "c" })]
  });
  const first = auto([runner], { rng: () => 0 });
  assert.equal(first.ok, true);
  assert.equal(first.deviceSerial, "a");

  const last = auto([runner], { rng: () => 0.999 });
  assert.equal(last.ok, true);
  assert.equal(last.deviceSerial, "c");

  const middle = auto([runner], { rng: () => 0.5 });
  assert.equal(middle.ok, true);
  assert.equal(middle.deviceSerial, "b");
});

test("auto：无 runner 返回 no-runner，无设备返回 no-device", () => {
  assert.equal(auto([]).code, "no-runner");
  assert.equal(auto([makeRunner({ lastSeenAt: new Date(NOW - TTL - 1).toISOString() })]).code, "no-runner");
  const noDevices = auto([makeRunner({ devices: [] })]);
  assert.equal(noDevices.ok, false);
  assert.equal(noDevices.code, "no-device");
});

test("auto：忽略 targetHostId/deviceSerial，在全池选最高分", () => {
  const low = makeRunner({ hostId: "host-low", devices: [makeDevice({ serial: "low" })] });
  const high = makeRunner({
    hostId: "host-high",
    devices: [makeDevice({ serial: "high", model: "Pixel 7" })]
  });
  const result = auto([low, high], {
    targetHostId: "host-low",
    deviceSerial: "low",
    devicePinned: true,
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "host-high");
  assert.equal(result.deviceSerial, "high");
});

test("manual 只钉 host（devicePinned=false）时忽略 deviceSerial，选最高分空闲设备", () => {
  const runner = makeRunner({
    hostId: "host-pick",
    devices: [
      makeDevice({ serial: "requested" }),
      makeDevice({ serial: "best", model: "Pixel 7" })
    ]
  });
  const result = manual([runner], {
    targetHostId: "host-pick",
    devicePinned: false,
    deviceSerial: "requested",
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "best");
});

test("所有满足硬要求的设备都被占用返回 device-busy", () => {
  const runner = makeRunner({
    devices: [makeDevice({ serial: "busy-1" }), makeDevice({ serial: "busy-2" })]
  });
  const result = auto([runner], {
    requirements: requirements({ platform: "android" }),
    leases: [makeLease({ serial: "busy-1" }), makeLease({ serial: "busy-2" })]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "device-busy");
});

test("manual 未指定 targetHostId 返回 requirements-unmet", () => {
  const result = manual([androidRunner], { requirements: requirements({ platform: "android" }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "requirements-unmet");
});

test("devicePinned=true 但缺少 deviceSerial 返回 requirements-unmet", () => {
  const result = manual([androidRunner], {
    targetHostId: "host-android",
    devicePinned: true,
    requirements: requirements({ platform: "android" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "requirements-unmet");
});

test("reasons 解释选择结果（在线、空闲、打分来源）", () => {
  const result = auto([iosRunner], {
    requirements: requirements({ platform: "ios", deviceModel: ["iPhone 15"], osVersion: { min: "17.0" } })
  });
  assert.equal(result.ok, true);
  const text = result.reasons.join("\n");
  assert.match(text, /online/);
  assert.match(text, /lease/);
  assert.match(text, /iPhone 15/);
  assert.match(text, /17\.2/);
});
