import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateIosVersionChecks,
  readIosInstalledAppVersion
} from "../dist/ios/app-version.js";

function result(code, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

test("readIosInstalledAppVersion: devicectl JSON 读取版本", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    return result(
      0,
      JSON.stringify({
        result: {
          apps: [
            { bundleIdentifier: "com.other.app", version: "1.0.0", bundleVersion: "1" },
            { bundleIdentifier: "com.example.app", version: "2.0.0", bundleVersion: "2" }
          ]
        }
      })
    );
  };
  const read = await readIosInstalledAppVersion({
    udid: "00008101-000359440C69001E",
    bundleId: "com.example.app",
    env: {},
    exec
  });
  assert.equal(read.ok, true);
  assert.deepEqual(read.version, {
    version: "2.0.0",
    build: "2",
    source: "devicectl"
  });
  assert.ok(calls[0].args.includes("devicectl"));
});

test("readIosInstalledAppVersion: devicectl 未列出应用 → not-installed", async () => {
  const read = await readIosInstalledAppVersion({
    udid: "udid",
    bundleId: "com.example.app",
    env: {},
    exec: async () =>
      result(0, JSON.stringify({ result: { apps: [{ bundleIdentifier: "com.other.app" }] } }))
  });
  assert.equal(read.ok, false);
  assert.equal(read.code, "not-installed");
});

test("readIosInstalledAppVersion: devicectl 输出非 JSON 时回退 ideviceinstaller", async () => {
  const read = await readIosInstalledAppVersion({
    udid: "udid",
    bundleId: "com.example.app",
    env: {},
    exec: async (command, args) => {
      if (args.includes("devicectl")) return result(0, "not-json");
      return result(
        0,
        JSON.stringify([
          {
            CFBundleIdentifier: "com.example.app",
            CFBundleShortVersionString: "3.0.0",
            CFBundleVersion: "30"
          }
        ])
      );
    }
  });
  assert.equal(read.ok, true);
  assert.equal(read.version.source, "ideviceinstaller");
  assert.equal(read.version.version, "3.0.0");
});

test("readIosInstalledAppVersion: devicectl 失败回退 ideviceinstaller JSON", async () => {
  const read = await readIosInstalledAppVersion({
    udid: "14e7f3970cb6fd1b55ec86e85aaba0a726423f6f",
    bundleId: "com.example.app",
    env: {},
    exec: async (command, args) => {
      if (args.includes("devicectl")) return result(1, "", "unsupported");
      assert.equal(command, "ideviceinstaller");
      return result(
        0,
        JSON.stringify([
          {
            CFBundleIdentifier: "com.example.app",
            CFBundleShortVersionString: "1.2.3",
            CFBundleVersion: "45"
          }
        ])
      );
    }
  });
  assert.equal(read.ok, true);
  assert.deepEqual(read.version, {
    version: "1.2.3",
    build: "45",
    source: "ideviceinstaller"
  });
});

test("readIosInstalledAppVersion: 两条路径都不可用 → unavailable", async () => {
  const read = await readIosInstalledAppVersion({
    udid: "udid",
    bundleId: "com.example.app",
    env: {},
    exec: async () => result(null, "", "timeout")
  });
  assert.equal(read.ok, false);
  assert.equal(read.code, "unavailable");
  assert.match(read.error, /devicectl/);
  assert.match(read.error, /ideviceinstaller/);
});

test("evaluateIosVersionChecks: 未填期望版本 → 记录实际版本并跳过", () => {
  const verdict = evaluateIosVersionChecks({
    bundleId: "com.example.app",
    expected: "",
    checks: [
      {
        serial: "udid-1",
        read: {
          ok: true,
          version: { version: "2.0.0", build: "2", source: "devicectl" }
        }
      }
    ]
  });
  assert.deepEqual(verdict, { ok: true, actual: "2.0.0 (2)", check: "skipped" });
});

test("evaluateIosVersionChecks: 期望版本匹配 short version 或 build", () => {
  const read = {
    ok: true,
    version: { version: "2.0.0", build: "2", source: "devicectl" }
  };
  for (const expected of ["2.0.0", "2", "2.0.0 (2)"]) {
    const verdict = evaluateIosVersionChecks({
      bundleId: "com.example.app",
      expected,
      checks: [{ serial: "udid-1", read }]
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.check, "matched");
  }
});

test("evaluateIosVersionChecks: 版本不一致 → 硬失败并列出设备实际版本", () => {
  const verdict = evaluateIosVersionChecks({
    bundleId: "com.example.app",
    expected: "2.0.0",
    checks: [
      {
        serial: "udid-1",
        read: {
          ok: true,
          version: { version: "1.9.0", build: "19", source: "devicectl" }
        }
      }
    ]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "app-version-mismatch");
  assert.match(verdict.message, /期望 2\.0\.0/);
  assert.match(verdict.message, /udid-1=1\.9\.0 \(19\)/);
});

test("evaluateIosVersionChecks: 期望非空但读不到 → unavailable", () => {
  const verdict = evaluateIosVersionChecks({
    bundleId: "com.example.app",
    expected: "2.0.0",
    checks: [
      {
        serial: "udid-1",
        read: { ok: false, code: "unavailable", error: "tool missing" }
      }
    ]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "app-version-unavailable");
  assert.match(verdict.message, /tool missing/);
});

test("evaluateIosVersionChecks: 未安装 → app-not-installed", () => {
  const verdict = evaluateIosVersionChecks({
    bundleId: "com.example.app",
    expected: "",
    checks: [
      {
        serial: "udid-1",
        read: { ok: false, code: "not-installed", error: "未列出" }
      }
    ]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "app-not-installed");
  assert.match(verdict.message, /TestFlight/);
});

test("readIosInstalledAppVersion: 空 bundleId → not-installed", async () => {
  const read = await readIosInstalledAppVersion({
    udid: "udid",
    bundleId: " ",
    env: {},
    exec: async () => result(0, "{}")
  });
  assert.equal(read.ok, false);
  assert.equal(read.code, "not-installed");
});
