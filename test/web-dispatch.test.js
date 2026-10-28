import assert from "node:assert/strict";
import test from "node:test";

import { deviceMeetsHardRequirements, selectWebAssignment } from "../dist/web/dispatch.js";

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

test("manual 只钉 host（devicePinned=false）时传 deviceSerial 必须 fail closed", () => {
  const runner = makeRunner({
    hostId: "host-pick",
    devices: [
      makeDevice({ serial: "requested" }),
      makeDevice({ serial: "best", model: "Pixel 7" })
    ]
  });
  const rejected = manual([runner], {
    targetHostId: "host-pick",
    devicePinned: false,
    deviceSerial: "requested",
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "requirements-unmet");
  assert.match(rejected.message, /devicePinned:true/);

  const defaultFlags = manual([runner], {
    targetHostId: "host-pick",
    deviceSerial: "requested",
    requirements: requirements({ platform: "android" })
  });
  assert.equal(defaultFlags.ok, false);
  assert.equal(defaultFlags.code, "requirements-unmet");

  const omitted = manual([runner], {
    targetHostId: "host-pick",
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(omitted.ok, true);
  assert.equal(omitted.deviceSerial, "best");

  const blank = manual([runner], {
    targetHostId: "host-pick",
    devicePinned: false,
    deviceSerial: "   ",
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] })
  });
  assert.equal(blank.ok, true);
  assert.equal(blank.deviceSerial, "best");
});

test("auto 仍忽略 deviceSerial（即使 devicePinned=false）", () => {
  const low = makeRunner({ hostId: "host-low", devices: [makeDevice({ serial: "low" })] });
  const high = makeRunner({ hostId: "host-high", devices: [makeDevice({ serial: "high", model: "Pixel 7" })] });
  const result = auto([low, high], {
    targetHostId: "host-low",
    deviceSerial: "low",
    devicePinned: false,
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] }),
    rng: () => 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "host-high");
  assert.equal(result.deviceSerial, "high", "auto 忽略 targetHostId/deviceSerial，按全池最高分选择");
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

test("请求校验：非法 osVersion 边界（非数字 / 非点分 / min>max）返回 requirements-unmet", () => {
  for (const osVersion of [
    { min: "abc" },
    { max: "17.x" },
    { min: "-1" },
    { min: "18", max: "17" },
    { min: "17.0", max: "17.0.0.1.2.x" }
  ]) {
    const result = auto([androidRunner], {
      requirements: requirements({ platform: "android", osVersion })
    });
    assert.equal(result.ok, false, JSON.stringify(osVersion));
    assert.equal(result.code, "requirements-unmet", JSON.stringify(osVersion));
  }
});

test("请求校验：平台/设备类型/分配方式非法返回 requirements-unmet", () => {
  const call = (request) =>
    selectWebAssignment({
      runners: [androidRunner],
      leases: [],
      request,
      nowMs: NOW,
      runnerTtlMs: TTL
    });

  assert.equal(call({ assignment: "auto", requirements: { platform: "windows", deviceKind: "any" } }).code, "requirements-unmet");
  assert.equal(call({ assignment: "auto", requirements: { platform: "android", deviceKind: "real" } }).code, "requirements-unmet");
  assert.equal(call({ assignment: "scheduled", requirements: requirements({ platform: "android" }) }).code, "requirements-unmet");
});

test("请求校验：tools/deviceModel 非数组或条目非字符串返回 requirements-unmet", () => {
  for (const requirementsPatch of [
    { tools: "maestro" },
    { tools: [123] },
    { tools: [null] },
    { deviceModel: "iPhone 15" },
    { deviceModel: [123] },
    { deviceModel: [null] }
  ]) {
    const result = auto([androidRunner], {
      requirements: requirements({ platform: "android", ...requirementsPatch })
    });
    assert.equal(result.ok, false, JSON.stringify(requirementsPatch));
    assert.equal(result.code, "requirements-unmet", JSON.stringify(requirementsPatch));
  }
});

test("rng 只在最高分并列时调用；分数不同不调用", () => {
  const runner = makeRunner({
    devices: [
      makeDevice({ serial: "best", model: "Pixel 7" }),
      makeDevice({ serial: "plain" })
    ]
  });
  let calls = 0;
  const result = auto([runner], {
    requirements: requirements({ platform: "android", deviceModel: ["Pixel 7"] }),
    rng: () => {
      calls += 1;
      return 0.999;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceSerial, "best");
  assert.equal(calls, 0, "唯一最高分不应触发 rng");

  let tieCalls = 0;
  const tie = auto([makeRunner({ devices: [makeDevice({ serial: "a" }), makeDevice({ serial: "b" })] })], {
    rng: () => {
      tieCalls += 1;
      return 0;
    }
  });
  assert.equal(tie.ok, true);
  assert.equal(tie.deviceSerial, "a");
  assert.equal(tieCalls, 1);
});

test("跨 runner 重复 serial：按 host 独立，租约不串台", () => {
  const hostA = makeRunner({ id: "runner-a", hostId: "host-a", devices: [makeDevice({ serial: "same" })] });
  const hostB = makeRunner({ id: "runner-b", hostId: "host-b", devices: [makeDevice({ serial: "same" })] });

  const stableFirst = auto([hostA, hostB]);
  assert.equal(stableFirst.ok, true);
  assert.equal(stableFirst.hostId, "host-a");

  const leasedB = auto([hostA, hostB], {
    leases: [makeLease({ hostId: "host-b", serial: "same" })]
  });
  assert.equal(leasedB.ok, true);
  assert.equal(leasedB.hostId, "host-a", "host-b 的租约不应阻塞 host-a 的同名设备");

  const bothLeased = auto([hostA, hostB], {
    leases: [
      makeLease({ hostId: "host-a", serial: "same" }),
      makeLease({ hostId: "host-b", serial: "same" })
    ]
  });
  assert.equal(bothLeased.ok, false);
  assert.equal(bothLeased.code, "device-busy");

  const pinned = manual([hostA, hostB], {
    targetHostId: "host-b",
    devicePinned: true,
    deviceSerial: "same"
  });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.hostId, "host-b");
});

test("同一设备同时存在过期与有效租约：有效租约仍然阻塞（与顺序无关）", () => {
  const expired = makeLease({
    hostId: "host-android",
    serial: "pixel",
    expiresAt: new Date(NOW - 1_000).toISOString()
  });
  const active = makeLease({
    hostId: "host-android",
    serial: "pixel",
    taskId: "task-active",
    expiresAt: new Date(NOW + 60_000).toISOString()
  });
  for (const leases of [
    [expired, active],
    [active, expired]
  ]) {
    const result = manual([androidRunner], {
      targetHostId: "host-android",
      devicePinned: true,
      deviceSerial: "pixel",
      requirements: requirements({ platform: "android" }),
      leases
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "device-busy");
  }
});

test("设备状态 blocklist：offline/unauthorized/unavailable/shutdown 不参与选机", () => {
  for (const state of ["offline", "unauthorized", "unavailable", "shutdown"]) {
    const result = auto([makeRunner({ devices: [makeDevice({ serial: "blocked", state })] })]);
    assert.equal(result.ok, false, state);
    assert.equal(result.code, "no-device", state);
  }
  const configured = auto([
    makeRunner({ devices: [makeDevice({ serial: "configured", state: "configured" })] })
  ]);
  assert.equal(configured.ok, true);
  assert.equal(configured.deviceSerial, "configured");
});

test("deviceMeetsHardRequirements 直接调用时缺少 deviceKind 默认 any", () => {
  const runner = makeRunner();
  const device = makeDevice();
  const result = deviceMeetsHardRequirements({
    runner,
    device,
    requirements: { platform: "android" },
    leases: [],
    nowMs: NOW,
    runnerTtlMs: TTL
  });
  assert.deepEqual(result, { ok: true });
});

test("钉住设备的执行机离线（同 host 在线兄弟没有该 serial）返回 host-offline", () => {
  const online = makeRunner({
    id: "runner-online",
    hostId: "host-split",
    devices: [makeDevice({ serial: "other" })]
  });
  const offline = makeRunner({
    id: "runner-offline",
    hostId: "host-split",
    lastSeenAt: new Date(NOW - TTL - 1).toISOString(),
    devices: [makeDevice({ serial: "wanted" })]
  });
  const result = manual([online, offline], {
    targetHostId: "host-split",
    devicePinned: true,
    deviceSerial: "wanted",
    requirements: requirements({ platform: "android" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "host-offline");
});
