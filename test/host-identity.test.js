import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hostKindOf, resolveHostIdentity } from "../dist/host/identity.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "aos-host-"));
}

test("AOS_HOST_ID 优先且不落盘", async () => {
  const dir = await tempDir();
  const id = await resolveHostIdentity({
    env: { AOS_HOST_ID: "host-1", AOS_HOST_DIR: dir },
    platform: "darwin",
    hostname: "mac-a",
    username: "louis",
    osVersion: "14.6.1"
  });
  assert.equal(id.id, "host-1");
  assert.equal(id.identitySource, "env");
  assert.equal(id.kind, "mac");
  await assert.rejects(fs.access(path.join(dir, "host-id")));
});

test("首次生成 host-id 并复用", async () => {
  const dir = await tempDir();
  const first = await resolveHostIdentity({ env: { AOS_HOST_DIR: dir }, platform: "darwin" });
  const second = await resolveHostIdentity({ env: { AOS_HOST_DIR: dir }, platform: "darwin" });
  assert.equal(first.id, second.id);
  assert.equal(first.identitySource, "file");
});

test("目录不可写退化为 derived 且稳定", async () => {
  const first = await resolveHostIdentity({
    env: { AOS_HOST_DIR: "/proc/definitely-not-writable" },
    platform: "linux",
    hostname: "linux-a",
    username: "ci"
  });
  const second = await resolveHostIdentity({
    env: { AOS_HOST_DIR: "/proc/definitely-not-writable" },
    platform: "linux",
    hostname: "linux-a",
    username: "ci"
  });
  assert.equal(first.identitySource, "derived");
  assert.equal(first.id, second.id);
});

test("hostKindOf 映射", () => {
  assert.equal(hostKindOf("darwin"), "mac");
  assert.equal(hostKindOf("win32"), "pc");
  assert.equal(hostKindOf("linux"), "linux");
  assert.equal(hostKindOf("freebsd"), "other");
});
