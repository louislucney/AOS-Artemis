import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectIosDeviceCrashes } from "../dist/crash/ios-device.js";

function ipsContent(appName, timestampIso, symbol = "main") {
  return [
    JSON.stringify({ app_name: appName, timestamp: timestampIso }),
    JSON.stringify({
      exception: { type: "EXC_BAD_ACCESS" },
      threads: [{ frames: [{ symbol }] }]
    })
  ].join("\n");
}

function makeIpsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aos-ios-device-crash-test-"));
}

test("ios device crash: 拉取、窗口与进程过滤", async () => {
  const dir = makeIpsDir();
  const inWindow = Date.parse("2026-10-08T10:00:30.000Z");
  const files = {
    "App-1.ips": ipsContent("com.example.app", "2026-10-08T10:00:30.000Z"),
    "Other-1.ips": ipsContent("com.other.app", "2026-10-08T10:00:30.000Z"),
    "Old-1.ips": ipsContent("com.example.app", "2026-10-07T10:00:00.000Z"),
    "logo.png": "not-an-ips"
  };
  const copied = await collectIosDeviceCrashes(
    {
      udid: "00008101-000359440C69001E",
      startMs: inWindow - 60_000,
      endMs: inWindow + 60_000,
      processName: "com.example.app"
    },
    {
      copy: async (_udid, destination) => {
        for (const [name, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(destination, name), content);
        }
        return { ok: true };
      },
      makeTempDir: () => dir,
      removeDir: () => {}
    }
  );
  assert.equal(copied.skipped, null);
  assert.equal(copied.scanned, 3);
  assert.equal(copied.records.length, 1);
  assert.equal(copied.records[0].package, "com.example.app");
  assert.equal(copied.records[0].occurredAtMs, inWindow);
});

test("ios device crash: 拉取失败返回 skipped", async () => {
  const result = await collectIosDeviceCrashes(
    { udid: "U-1", startMs: null, endMs: null, processName: null },
    {
      copy: async () => ({ ok: false, error: "device locked" }),
      makeTempDir: () => makeIpsDir(),
      removeDir: () => {}
    }
  );
  assert.equal(result.records.length, 0);
  assert.match(result.skipped, /copy-failed: device locked/);
});

test("ios device crash: 默认复制命令形状（devicectl systemCrashLogs）", async () => {
  const calls = [];
  const result = await collectIosDeviceCrashes(
    { udid: "U-2", startMs: null, endMs: null, processName: null },
    {
      exec: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      listFiles: () => [],
      makeTempDir: () => makeIpsDir(),
      removeDir: () => {}
    }
  );
  assert.equal(result.scanned, 0);
  assert.equal(calls[0][0], "xcrun");
  assert.ok(calls[0].includes("devicectl"));
  assert.ok(calls[0].includes("systemCrashLogs"));
  assert.ok(calls[0].includes("U-2"));
});
