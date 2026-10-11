import assert from "node:assert/strict";
import test from "node:test";

import { collectIosCrashesFor } from "../dist/crash/ios-dispatch.js";

const SIM_UDID = "65584900-E161-4125-8928-587499DD6457";
const DEVICE_UDID = "00008110-001A2C681E22801E";
const EMPTY = { records: [], scanned: 0, skipped: null };

test("collectIosCrashesFor: 模拟器 serial → simulator 采集器（source diagnostic-reports）", async () => {
  const seen = [];
  const result = await collectIosCrashesFor(
    SIM_UDID,
    { startMs: 1, endMs: 2 },
    {
      via: "auto",
      simulator: async (window) => {
        seen.push(window);
        return EMPTY;
      },
      device: async () => {
        throw new Error("不应调用");
      }
    }
  );
  assert.deepEqual(seen, [{ startMs: 1, endMs: 2 }]);
  assert.equal(result.source, "diagnostic-reports");
  assert.equal(result.collected.records.length, 0);
});

test("collectIosCrashesFor: 真机 serial → device 采集器（带 udid，source devicectl-systemCrashLogs）", async () => {
  const seen = [];
  const result = await collectIosCrashesFor(
    DEVICE_UDID,
    { startMs: 1, endMs: 2, processName: "App" },
    {
      via: "auto",
      device: async (window) => {
        seen.push(window);
        return EMPTY;
      }
    }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].udid, DEVICE_UDID);
  assert.equal(seen[0].processName, "App");
  assert.equal(result.source, "devicectl-systemCrashLogs");
});

test("collectIosCrashesFor: injected 覆盖两种 kind（source 固定 diagnostic-reports）", async () => {
  let calls = 0;
  const injected = async () => {
    calls += 1;
    return EMPTY;
  };
  const sim = await collectIosCrashesFor(SIM_UDID, { startMs: null, endMs: null }, {
    via: "injected",
    collect: injected
  });
  const dev = await collectIosCrashesFor(DEVICE_UDID, { startMs: null, endMs: null }, {
    via: "injected",
    collect: injected
  });
  assert.equal(calls, 2);
  assert.equal(sim.source, "diagnostic-reports");
  assert.equal(dev.source, "diagnostic-reports");
});
