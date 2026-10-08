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

test("mobile_run_task：Android 透传响应补空 warnings（双端同构）", async () => {
  const { runtime } = await setup();
  const result = await runtime.proxy.callTool("mobile_run_task", {
    task_desc: "x",
    device_serial: "emulator-5554"
  });
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.warnings, []);
});

test("runtime: iOS 签名配置合并项目 .env（进程 env 覆盖）", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: ["AOS_APPIUM_URL=http://127.0.0.1:4799", "AOS_IOS_XCODE_ORG_ID=TEAM_DOTENV"].join("\n")
  });
  const original = globalThis.fetch;
  const sessionBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const json = (payload) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    if (href.endsWith("/status")) return json({ value: { ready: true } });
    if (href.endsWith("/session") && (init.method ?? "GET") === "POST") {
      sessionBodies.push(JSON.parse(init.body));
      return json({ value: { sessionId: "s-1", capabilities: {} } });
    }
    if (href.endsWith("/screenshot")) {
      return json({ value: Buffer.from("png").toString("base64") });
    }
    return json({ value: null });
  };
  const udid = "00008101-000000000000000E";
  try {
    const { runtime: dotenvRuntime } = await loadTestRuntime(dir, {
      proxy: new StubProxy({ running: false }),
      baseEnv: {}
    });
    const fromDotenv = await dotenvRuntime.iosWda().screenshot(udid);
    assert.equal(fromDotenv.ok, true);
    await dotenvRuntime.disposeIosWda();

    const { runtime: processRuntime } = await loadTestRuntime(dir, {
      proxy: new StubProxy({ running: false }),
      baseEnv: { AOS_IOS_XCODE_ORG_ID: "TEAM_PROCESS" }
    });
    const fromProcess = await processRuntime.iosWda().screenshot(udid);
    assert.equal(fromProcess.ok, true);
    await processRuntime.disposeIosWda();
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(sessionBodies.length, 2);
  assert.equal(sessionBodies[0].capabilities.alwaysMatch["appium:xcodeOrgId"], "TEAM_DOTENV");
  assert.equal(sessionBodies[1].capabilities.alwaysMatch["appium:xcodeOrgId"], "TEAM_PROCESS");
});
