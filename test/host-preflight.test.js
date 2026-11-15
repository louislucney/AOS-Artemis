import assert from "node:assert/strict";
import test from "node:test";

import { checkHostDisk } from "../dist/figma/host-preflight.js";

function statfsOf(bsize, blocks, bavail) {
  return async () => ({ bsize, blocks, bavail, bfree: bavail, files: 0, ffree: 0 });
}

test("host preflight: 磁盘低于 10% 阻断", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: {},
    statfsFn: statfsOf(4096, 1000, 50)
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient-disk");
  assert.equal(result.freePercent, 5);
  assert.match(result.message, /AOS_RUNNER_MIN_FREE_DISK_PCT=10%/);
});

test("host preflight: 磁盘充足放行，阈值可配", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: { AOS_RUNNER_MIN_FREE_DISK_PCT: "20" },
    statfsFn: statfsOf(4096, 1000, 300)
  });
  assert.equal(result.ok, true);
  assert.equal(result.freePercent, 30);
  assert.equal(result.reason, null);
});

test("host preflight: 阈值 0 关闭磁盘门禁", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: { AOS_RUNNER_MIN_FREE_DISK_PCT: "0" },
    statfsFn: statfsOf(4096, 1000, 0)
  });
  assert.equal(result.ok, true);
  assert.equal(result.freePercent, 0);
});

test("host preflight: statfs 不可用不阻断", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: {},
    statfsFn: async () => {
      throw new Error("statfs unavailable");
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "unavailable");
  assert.match(result.message, /不阻断/);
});
