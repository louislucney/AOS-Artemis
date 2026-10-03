import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { sweepStaleChild } from "../dist/runtime.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

async function setup({ injectedProxy = true } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const options = injectedProxy
    ? { proxy: new StubProxy({ running: false }) }
    : {};
  const { runtime } = await loadTestRuntime(dir, options);
  return { dir, runtime };
}

function spawnNode(args) {
  return spawn(process.execPath, args, { stdio: "ignore" });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitAlive(pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return false;
}

async function kill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await waitForExit(child);
}

test("runtime: default wiring exposes store, state, crash store and an inert proxy", async () => {
  const { runtime } = await setup({ injectedProxy: false });
  assert.equal(runtime.store.kind, "memory");
  assert.ok(runtime.crashStore.dirPath.endsWith(path.join(".artemis", "crashes")));
  assert.ok(runtime.traceDir("t1").endsWith(path.join("traces", "t1")));
  assert.deepEqual(runtime.state.read(), {});
  assert.equal(runtime.proxy.isRunning(), false);
  assert.equal(runtime.proxy.status().running, false);
  assert.equal(runtime.proxy.status().pid, null);
  await runtime.proxy.dispose();
});

test("sweepStaleChild: no recorded child is a no-op", async () => {
  const { runtime } = await setup();
  assert.equal(await sweepStaleChild(runtime), null);
  assert.deepEqual(runtime.state.read(), {});
});

test("sweepStaleChild: dead child pid is cleared from state", async () => {
  const { runtime } = await setup();
  const dead = spawnNode(["-e", ""]);
  await waitForExit(dead);
  runtime.state.write({
    child: { ownerPid: process.pid, pid: dead.pid, fingerprint: "fp", startedAt: "2026-10-02T00:00:00.000Z" }
  });

  assert.equal(await sweepStaleChild(runtime), null);
  assert.equal(runtime.state.read().child, undefined);
});

test("sweepStaleChild: live owner keeps the child untouched", async () => {
  const { runtime } = await setup();
  const child = spawnNode(["-e", "setTimeout(() => {}, 30000)"]);
  try {
    assert.equal(await waitAlive(child.pid), true);
    runtime.state.write({
      child: {
        ownerPid: process.ppid,
        pid: child.pid,
        fingerprint: "fp",
        startedAt: "2026-10-02T00:00:00.000Z"
      }
    });

    assert.equal(await sweepStaleChild(runtime), null);
    assert.equal(runtime.state.read().child.pid, child.pid);
    assert.equal(child.exitCode, null);
  } finally {
    await kill(child);
  }
});

test("sweepStaleChild: mismatched cmdline is never killed", async () => {
  const { runtime } = await setup();
  const child = spawnNode(["-e", "setTimeout(() => {}, 30000)"]);
  try {
    assert.equal(await waitAlive(child.pid), true);
    runtime.state.write({
      child: {
        ownerPid: process.pid,
        pid: child.pid,
        fingerprint: "fp",
        startedAt: "2026-10-02T00:00:00.000Z"
      }
    });

    assert.equal(await sweepStaleChild(runtime), null);
    assert.equal(runtime.state.read().child.pid, child.pid);
    assert.equal(child.exitCode, null);
  } finally {
    await kill(child);
  }
});

test("sweepStaleChild: orphan mcp_server process is terminated and reported", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX cmdline check");
    return;
  }
  const { runtime } = await setup();
  const child = spawn(
    "bash",
    ["-c", `exec -a "python -m mcp_server" "${process.execPath}" -e "setTimeout(() => {}, 30000)"`],
    { stdio: "ignore" }
  );
  try {
    assert.equal(await waitAlive(child.pid), true);
    runtime.state.write({
      child: {
        ownerPid: process.pid,
        pid: child.pid,
        fingerprint: "fp",
        startedAt: "2026-10-02T00:00:00.000Z"
      }
    });

    const message = await sweepStaleChild(runtime);
    assert.match(message, /已清理孤儿 artemis mcp_server 进程/);
    assert.equal(runtime.state.read().child, undefined);
    await waitForExit(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    await kill(child);
  }
});
