import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveMaestroPath } from "../dist/device/maestro.js";
import { collectRunnerInventory } from "../dist/runner/inventory.js";

function makeExec(routes) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    for (const route of routes) {
      if (route.match(command, args)) return route.result;
    }
    return { code: 1, stdout: "", stderr: "ENOENT", error: "ENOENT" };
  };
  return { exec, calls };
}

test("android：adb devices → 设备清单（emulator-* kind emulator；offline 不计）", async () => {
  const { exec } = makeExec([
    {
      match: (command, args) => command === "adb" && args[0] === "devices",
      result: {
        code: 0,
        stdout:
          "List of devices attached\nemulator-5554\tdevice\nR58M12ABCD\tdevice\nbroken-1\toffline\n",
        stderr: ""
      }
    },
    { match: (command) => command.endsWith("xcrun"), result: { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" } },
    { match: (command) => command === "idevice_id", result: { code: 1, stdout: "", stderr: "no devices" } }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });
  assert.deepEqual(inventory.platforms, ["android"]);
  assert.equal(inventory.devices.length, 2);
  const emulator = inventory.devices.find((device) => device.serial === "emulator-5554");
  assert.deepEqual(emulator, {
    serial: "emulator-5554",
    name: "",
    model: null,
    osVersion: null,
    platform: "android",
    kind: "emulator",
    state: "device"
  });
  assert.equal(
    inventory.devices.find((device) => device.serial === "R58M12ABCD").kind,
    "device"
  );
  assert.equal(
    inventory.devices.some((device) => device.serial === "broken-1"),
    false,
    "offline 不计"
  );
  assert.equal(inventory.tools.adb, true);
});

test("ios（darwin）：simctl 仅 Booted 可用模拟器 + idevice_id 真机；离线状态排除", async () => {
  const simctlJson = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        {
          udid: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
          name: "iPhone 15",
          state: "Booted",
          isAvailable: true
        },
        {
          udid: "11111111-2222-3333-4444-555555555555",
          name: "iPhone 14",
          state: "Shutdown",
          isAvailable: true
        },
        {
          udid: "99999999-8888-7777-6666-555555555555",
          name: "iPhone 13",
          state: "Booted",
          isAvailable: false
        }
      ]
    }
  });
  const { exec } = makeExec([
    { match: (command) => command === "adb", result: { code: 0, stdout: "", stderr: "" } },
    { match: (command) => command.endsWith("xcrun"), result: { code: 0, stdout: simctlJson, stderr: "" } },
    {
      match: (command) => command === "idevice_id",
      result: { code: 0, stdout: "00008101-000A1B2C3D4E001E\n", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });
  assert.deepEqual(inventory.platforms, ["ios"]);
  assert.deepEqual(
    inventory.devices.map((device) => device.serial),
    ["00008101-000A1B2C3D4E001E", "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B"]
  );
  const real = inventory.devices.find((device) => device.serial.startsWith("0000"));
  assert.equal(real.kind, "device");
  const simulator = inventory.devices.find((device) => device.serial.startsWith("4E0A"));
  assert.equal(simulator.kind, "simulator");
  assert.equal(simulator.name, "iPhone 15");
  assert.equal(inventory.tools.ideviceId, true);
  assert.equal(inventory.tools.simctl, true);
});

test("tools：adb 缺失不炸；idb 经 --version 探测；appium＝AOS_APPIUM_URL 非空", async () => {
  const { exec } = makeExec([
    { match: (command) => command === "adb", result: { code: null, stdout: "", stderr: "", error: "ENOENT" } },
    { match: (command, args) => command.endsWith("xcrun") && args[0] === "simctl", result: { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" } },
    { match: (command) => command === "idevice_id", result: { code: null, stdout: "", stderr: "", error: "ENOENT" } },
    { match: (command) => command.endsWith("idb"), result: { code: 0, stdout: "idb 1.1.8", stderr: "" } }
  ]);
  const inventory = await collectRunnerInventory({
    exec,
    platform: "darwin",
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" }
  });
  assert.equal(inventory.tools.adb, false, "adb 缺失");
  assert.equal(inventory.tools.idb, true);
  assert.equal(inventory.tools.ideviceId, false);
  assert.equal(inventory.tools.simctl, true);
  assert.equal(inventory.tools.appium, true);
  assert.equal(inventory.tools.maestro, false, "maestro 不可用");
  assert.equal(inventory.tools.devicectl, false, "devicectl 不可用");
  assert.deepEqual(inventory.devices, []);
});

test("AOS_RUNNER_DEVICES 覆盖全部来源（平台按 classifyIosSerial；空项忽略；不触设备来源）", async () => {
  const { exec, calls } = makeExec([]);
  const inventory = await collectRunnerInventory({
    exec,
    platform: "darwin",
    env: {
      AOS_RUNNER_DEVICES:
        "emulator-5554, 4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B, , 00008101-000A1B2C3D4E001E"
    }
  });
  assert.deepEqual(
    inventory.devices.map((device) => [device.platform, device.kind, device.serial]),
    [
      ["android", "emulator", "emulator-5554"],
      ["ios", "device", "00008101-000A1B2C3D4E001E"],
      ["ios", "simulator", "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B"]
    ]
  );
  assert.deepEqual(inventory.platforms, ["android", "ios"]);
  assert.ok(inventory.devices.every((device) => device.name === ""));
  assert.ok(
    inventory.devices.every((device) => device.model === null && device.osVersion === null),
    "覆盖路径不探测机型/系统版本"
  );
  assert.equal(inventory.tools.maestro, false);
  assert.equal(inventory.tools.devicectl, false);
  assert.equal(calls.length, 0, "覆盖模式不调用设备来源");
});

test("非 darwin：无 iOS 设备且不调 iOS 工具", async () => {
  const { exec, calls } = makeExec([
    {
      match: (command) => command === "adb",
      result: { code: 0, stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "linux", env: {} });
  assert.deepEqual(inventory.platforms, ["android"]);
  assert.equal(inventory.tools.simctl, false);
  assert.equal(inventory.tools.ideviceId, false);
  assert.equal(inventory.tools.idb, false);
  assert.ok(
    calls.every((call) => call.command === "adb" || call.command.endsWith("maestro")),
    "不调 iOS 工具"
  );
});

test("远程 adb：项目 env（ADB_SERVER_SOCKET）透传到 adb devices 子进程", async () => {
  const { exec, calls } = makeExec([
    {
      match: (command, args) => command === "/opt/adb" && args[0] === "devices",
      result: {
        code: 0,
        stdout: "List of devices attached\nemulator-5554\tdevice\n",
        stderr: ""
      }
    }
  ]);
  const env = {
    ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037",
    AOS_ADB_PATH: "/opt/adb",
    PROJECT_SENTINEL: "from-dotenv"
  };
  const inventory = await collectRunnerInventory({ exec, platform: "linux", env });

  assert.deepEqual(inventory.devices.map((device) => device.serial), ["emulator-5554"]);
  const devicesCall = calls.find(
    (call) => call.command === "/opt/adb" && call.args[0] === "devices"
  );
  assert.ok(devicesCall, "adb devices 被调用");
  assert.equal(devicesCall.options.env.ADB_SERVER_SOCKET, "tcp:10.0.0.5:5037");
  assert.equal(devicesCall.options.env.PROJECT_SENTINEL, "from-dotenv");
});

test("android：getprop 读取机型与系统版本（5s 超时；失败为 null）", async () => {
  const { exec, calls } = makeExec([
    {
      match: (command, args) => command === "adb" && args[0] === "devices",
      result: {
        code: 0,
        stdout: "List of devices attached\nemulator-5554\tdevice\n",
        stderr: ""
      }
    },
    {
      match: (command, args) =>
        command === "adb" && args[0] === "-s" && args[4] === "ro.product.model",
      result: { code: 0, stdout: "Pixel 7\n", stderr: "" }
    },
    {
      match: (command, args) =>
        command === "adb" && args[0] === "-s" && args[4] === "ro.build.version.release",
      result: { code: 0, stdout: "14\n", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "linux", env: {} });

  const device = inventory.devices.find((entry) => entry.serial === "emulator-5554");
  assert.equal(device.model, "Pixel 7");
  assert.equal(device.osVersion, "14");
  const modelCall = calls.find((call) => call.args?.[4] === "ro.product.model");
  assert.ok(modelCall, "调用 getprop ro.product.model");
  assert.deepEqual(modelCall.args, ["-s", "emulator-5554", "shell", "getprop", "ro.product.model"]);
  assert.equal(modelCall.options.timeoutMs, 5_000, "探测命令 5s 超时");
});

test("ios 模拟器：model 取 name，osVersion 由 runtime 解析（iOS-17-2 → 17.2）；devicectl 探测", async () => {
  const simctlJson = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-2": [
        {
          udid: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
          name: "iPhone 15",
          state: "Booted",
          isAvailable: true
        }
      ]
    }
  });
  const { exec, calls } = makeExec([
    { match: (command) => command === "adb", result: { code: 0, stdout: "", stderr: "" } },
    {
      match: (command, args) => command.endsWith("xcrun") && args[0] === "devicectl",
      result: { code: 0, stdout: "devicectl 1.0", stderr: "" }
    },
    {
      match: (command, args) => command.endsWith("xcrun") && args[0] === "simctl",
      result: { code: 0, stdout: simctlJson, stderr: "" }
    },
    { match: (command) => command === "idevice_id", result: { code: 1, stdout: "", stderr: "none" } }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });

  const simulator = inventory.devices.find((entry) =>
    entry.serial.startsWith("4E0A")
  );
  assert.equal(simulator.kind, "simulator");
  assert.equal(simulator.model, "iPhone 15");
  assert.equal(simulator.osVersion, "17.2");
  assert.equal(inventory.tools.devicectl, true, "xcrun devicectl 可用");
  const devicectlCall = calls.find((call) => call.args?.[0] === "devicectl");
  assert.ok(devicectlCall, "调用 xcrun devicectl --version");
  assert.equal(devicectlCall.options.timeoutMs, 5_000);
});

test("ios 真机：ideviceinfo 读取 ProductType/ProductVersion", async () => {
  const serial = "00008101-000A1B2C3D4E001E";
  const { exec, calls } = makeExec([
    { match: (command) => command === "adb", result: { code: 0, stdout: "", stderr: "" } },
    {
      match: (command, args) => command.endsWith("xcrun") && args[0] === "simctl",
      result: { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" }
    },
    { match: (command) => command === "idevice_id", result: { code: 0, stdout: `${serial}\n`, stderr: "" } },
    {
      match: (command, args) => command === "ideviceinfo" && args[args.length - 1] === "ProductType",
      result: { code: 0, stdout: "iPhone15,2\n", stderr: "" }
    },
    {
      match: (command, args) => command === "ideviceinfo" && args[args.length - 1] === "ProductVersion",
      result: { code: 0, stdout: "17.2\n", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });

  const device = inventory.devices.find((entry) => entry.serial === serial);
  assert.equal(device.model, "iPhone15,2");
  assert.equal(device.osVersion, "17.2");
  assert.equal(inventory.tools.ideviceId, true);
  const metaCall = calls.find((call) => call.command === "ideviceinfo");
  assert.ok(metaCall, "调用 ideviceinfo");
  assert.equal(metaCall.options.timeoutMs, 5_000);
});

test("ios 真机：ideviceinfo 缺失/失败 → model/osVersion 为 null，设备仍保留", async () => {
  const serial = "00008101-000A1B2C3D4E001E";
  const { exec } = makeExec([
    { match: (command) => command === "adb", result: { code: 0, stdout: "", stderr: "" } },
    {
      match: (command, args) => command.endsWith("xcrun") && args[0] === "simctl",
      result: { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" }
    },
    { match: (command) => command === "idevice_id", result: { code: 0, stdout: `${serial}\n`, stderr: "" } },
    {
      match: (command) => command === "ideviceinfo",
      result: { code: null, stdout: "", stderr: "ENOENT", error: "ENOENT" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });

  const device = inventory.devices.find((entry) => entry.serial === serial);
  assert.ok(device, "设备仍保留");
  assert.equal(device.model, null);
  assert.equal(device.osVersion, null);
});

test("tools：maestro --version 探测（AOS_MAESTRO_PATH 优先且透传 env）；非 darwin 不探测 devicectl", async () => {
  const { exec, calls } = makeExec([
    {
      match: (command, args) => command === "adb" && args[0] === "devices",
      result: { code: 0, stdout: "", stderr: "" }
    },
    {
      match: (command) => command === "/fake/bin/maestro",
      result: { code: 0, stdout: "1.0.0", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({
    exec,
    platform: "linux",
    env: { AOS_MAESTRO_PATH: "/fake/bin/maestro" }
  });

  assert.equal(inventory.tools.maestro, true);
  assert.equal(inventory.tools.devicectl, false);
  const maestroCall = calls.find((call) => call.command === "/fake/bin/maestro");
  assert.deepEqual(maestroCall.args, ["--version"]);
  assert.equal(maestroCall.options.timeoutMs, 5_000);
  assert.equal(maestroCall.options.env.AOS_MAESTRO_PATH, "/fake/bin/maestro", "项目 env 透传");
  assert.equal(
    calls.some((call) => call.args?.includes("devicectl")),
    false,
    "非 darwin 不探测 devicectl"
  );
});

test("resolveMaestroPath：AOS_MAESTRO_PATH → PATH → 常见安装位置；缺失 null", () => {
  assert.deepEqual(
    resolveMaestroPath({ AOS_MAESTRO_PATH: " /custom/maestro " }, () => true),
    { path: "/custom/maestro", source: "env" }
  );

  const pathEnv = { PATH: ["/empty", "/custom/bin"].join(path.delimiter) };
  assert.deepEqual(
    resolveMaestroPath(pathEnv, (candidate) => candidate === path.join("/custom/bin", "maestro")),
    { path: path.join("/custom/bin", "maestro"), source: "path" }
  );
  assert.deepEqual(
    resolveMaestroPath({ PATH: "/opt/homebrew/bin" }, (candidate) => candidate === "/opt/homebrew/bin/maestro"),
    { path: "/opt/homebrew/bin/maestro", source: "path" }
  );

  const homeCandidate = path.join(os.homedir(), ".maestro", "bin", "maestro");
  assert.deepEqual(
    resolveMaestroPath({}, (candidate) => candidate === homeCandidate),
    { path: homeCandidate, source: "candidate" }
  );
  assert.deepEqual(
    resolveMaestroPath({}, (candidate) => candidate === "/usr/local/bin/maestro"),
    { path: "/usr/local/bin/maestro", source: "candidate" }
  );
  assert.deepEqual(resolveMaestroPath({ PATH: "/nowhere" }, () => false), {
    path: null,
    source: "missing"
  });
});

test("android：多设备元数据探测并发（心跳耗时 ~单次超时，而非设备数累加）", async () => {
  let active = 0;
  let maxActive = 0;
  const exec = async (command, args) => {
    if (command === "adb" && args[0] === "devices") {
      return {
        code: 0,
        stdout:
          "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\nR58M12ABCD\tdevice\n",
        stderr: ""
      };
    }
    if (command === "adb" && args[0] === "-s") {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return {
        code: 0,
        stdout: args[4] === "ro.product.model" ? "Pixel 7\n" : "14\n",
        stderr: ""
      };
    }
    return { code: 1, stdout: "", stderr: "ENOENT", error: "ENOENT" };
  };

  const inventory = await collectRunnerInventory({ exec, platform: "linux", env: {} });

  assert.equal(inventory.devices.length, 3);
  assert.ok(
    inventory.devices.every((device) => device.model === "Pixel 7" && device.osVersion === "14")
  );
  assert.ok(
    maxActive >= 3,
    `探测应并发执行（maxActive=${maxActive}；按设备顺序等待时为 2，完全串行为 1）`
  );
});
