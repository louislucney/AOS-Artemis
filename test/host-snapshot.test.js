import assert from "node:assert/strict";
import test from "node:test";

import { collectHostSnapshot } from "../dist/runner/host-snapshot.js";

function fakeExec() {
  return async () => ({ code: 1, stdout: "", stderr: "" });
}

function iface(address, family, internal = false) {
  return {
    address,
    netmask: family === "IPv4" ? "255.255.255.0" : "",
    family,
    mac: "",
    internal,
    cidr: null
  };
}

async function snapshotWith(interfaces) {
  return collectHostSnapshot({
    projectRoot: "/w/app",
    env: { AOS_HOST_ID: "h-test" },
    platform: "darwin",
    exec: fakeExec(),
    networkInterfaces: () => interfaces
  });
}

test("collectHostSnapshot: 过滤 internal/loopback/link-local，ipPrimary 优先 IPv4", async () => {
  const snap = await snapshotWith({
    lo0: [iface("127.0.0.1", "IPv4", true)],
    en0: [
      iface("169.254.1.1", "IPv4"),
      iface("10.0.0.5", "IPv4"),
      iface("fe80::1", "IPv6")
    ]
  });
  assert.deepEqual(
    snap.addresses.map((entry) => entry.address),
    ["10.0.0.5"]
  );
  assert.equal(snap.addresses[0].source, "self");
  assert.equal(snap.addresses[0].family, "ipv4");
  assert.equal(snap.ipPrimary, "10.0.0.5");
});

test("collectHostSnapshot: 无 IPv4 时 ipPrimary 回退首个 IPv6（过滤链路本地）", async () => {
  const snap = await snapshotWith({
    en0: [iface("fe80::1", "IPv6"), iface("2001:db8::1", "IPv6")]
  });
  assert.deepEqual(
    snap.addresses.map((entry) => entry.address),
    ["2001:db8::1"]
  );
  assert.equal(snap.ipPrimary, "2001:db8::1");
});

test("collectHostSnapshot: 仅被过滤地址时 addresses 为空、ipPrimary 为 null", async () => {
  const snap = await snapshotWith({
    lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
    en0: [iface("169.254.99.99", "IPv4"), iface("fe80::abcd", "IPv6")]
  });
  assert.deepEqual(snap.addresses, []);
  assert.equal(snap.ipPrimary, null);
});
