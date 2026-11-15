import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DataLeaseError, DataLeaseRegistry } from "../dist/figma/data-lease.js";

test("data lease: 分配/释放/冷却期内拒绝再次分配", () => {
  let now = Date.parse("2026-11-16T00:00:00.000Z");
  const registry = new DataLeaseRegistry({ now: () => now });
  const lease = registry.allocate({
    resource: "phone",
    value: "6953512",
    provider: "pool-a",
    riskLevel: "low",
    cooldownMs: 60_000
  });
  assert.equal(lease.provider, "pool-a");
  assert.throws(
    () => registry.allocate({ resource: "phone", value: "6953512" }),
    (error) => error instanceof DataLeaseError && error.code === "busy"
  );
  const released = registry.release(lease.id);
  assert.ok(released.releasedAt);
  assert.ok(released.cooldownUntil);
  assert.throws(
    () => registry.allocate({ resource: "phone", value: "6953512" }),
    (error) => error instanceof DataLeaseError && error.code === "cooldown"
  );
  now += 61_000;
  const next = registry.allocate({ resource: "phone", value: "6953512" });
  assert.ok(next.id);
});

test("data lease: 文件状态可恢复，重复释放被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-data-lease-"));
  const file = path.join(dir, "leases.json");
  try {
    const first = new DataLeaseRegistry({ file, now: () => 1000 });
    const lease = first.allocate({ resource: "email", value: "a+1@example.com" });
    assert.throws(
      () => first.release(lease.id) && first.release(lease.id),
      (error) => error instanceof DataLeaseError && error.code === "already-released"
    );
    const second = new DataLeaseRegistry({ file, now: () => 2000 });
    assert.equal(second.get(lease.id)?.value, "a+1@example.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
