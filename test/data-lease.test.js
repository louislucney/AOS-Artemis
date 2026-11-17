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
    value: "1000000",
    provider: "pool-a",
    riskLevel: "low",
    cooldownMs: 60_000
  });
  assert.equal(lease.provider, "pool-a");
  assert.throws(
    () => registry.allocate({ resource: "phone", value: "1000000" }),
    (error) => error instanceof DataLeaseError && error.code === "busy"
  );
  const released = registry.release(lease.id);
  assert.ok(released.releasedAt);
  assert.ok(released.cooldownUntil);
  assert.throws(
    () => registry.allocate({ resource: "phone", value: "1000000" }),
    (error) => error instanceof DataLeaseError && error.code === "cooldown"
  );
  now += 61_000;
  const next = registry.allocate({ resource: "phone", value: "1000000" });
  assert.ok(next.id);
});

test("data lease: 共享文件的两个实例不能重复分配，释放前会重读", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-data-lease-race-"));
  const file = path.join(dir, "leases.json");
  try {
    const first = new DataLeaseRegistry({ file, now: () => 1000 });
    const second = new DataLeaseRegistry({ file, now: () => 1000 });
    const lease = first.allocate({ resource: "phone", value: "1000000" });
    assert.throws(
      () => second.allocate({ resource: "phone", value: "1000000" }),
      (error) => error instanceof DataLeaseError && error.code === "busy"
    );
    const released = second.release(lease.id);
    assert.ok(released.releasedAt);
    const next = second.allocate({ resource: "phone", value: "1000000" });
    assert.notEqual(next.id, lease.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("data lease: 活跃租约超过 TTL 后可被回收", () => {
  let now = 1000;
  const registry = new DataLeaseRegistry({ now: () => now, leaseTtlMs: 1000 });
  const first = registry.allocate({ resource: "phone", value: "1000000" });
  now += 1001;
  const next = registry.allocate({ resource: "phone", value: "1000000" });
  assert.notEqual(next.id, first.id);
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
