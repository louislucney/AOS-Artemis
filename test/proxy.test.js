import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ArtemisProxy } from "../dist/artemis/proxy.js";
import { TOOLS as UPSTREAM_TOOLS } from "./fixtures/fake-artemis-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fake-artemis.mjs");
const repoRoot = path.resolve(here, "..");

function makeProxy(extraEnv = {}, hooks = {}) {
  let spawned = 0;
  const proxy = new ArtemisProxy({
    prepare: () => ({
      command: process.execPath,
      args: [fixture],
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      fingerprint: "test-fp"
    }),
    onSpawned: () => {
      spawned += 1;
    },
    onStderrLine: hooks.onStderrLine,
    connectTimeoutMs: 15_000
  });
  return { proxy, spawnedCount: () => spawned };
}

test("proxy spawns the child, lists tools verbatim, and calls tools", async () => {
  const { proxy, spawnedCount } = makeProxy();
  try {
    const tools = await proxy.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "mobile_diagnose",
      "mobile_get_device_state",
      "mobile_inspect_trace",
      "mobile_manage_task",
      "mobile_run_task"
    ]);

    // Passthrough contract: all 5 mobile_* schemas (required /
    // additionalProperties included) are forwarded byte-identically.
    assert.equal(UPSTREAM_TOOLS.length, 5);
    for (const upstream of UPSTREAM_TOOLS) {
      const forwarded = tools.find((tool) => tool.name === upstream.name);
      assert.ok(forwarded, `${upstream.name} should be forwarded`);
      assert.deepEqual(forwarded, {
        name: upstream.name,
        description: upstream.description,
        inputSchema: upstream.inputSchema
      });
    }

    const cached = await proxy.listTools();
    assert.equal(cached, tools, "second listTools call returns the cached array");

    const result = await proxy.callTool("mobile_run_task", { task_desc: "hello world" });
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /hello world/);

    const status = proxy.status();
    assert.equal(status.running, true);
    assert.ok(typeof status.pid === "number" && status.pid > 0);
    assert.equal(status.fingerprint, "test-fp");
    assert.equal(spawnedCount(), 1);
  } finally {
    await proxy.dispose();
  }
});

test("markForRestart stops the child and the next call respawns it", async () => {
  const { proxy, spawnedCount } = makeProxy();
  try {
    await proxy.listTools();
    const firstPid = proxy.status().pid;
    await proxy.markForRestart();
    assert.equal(proxy.isRunning(), false);

    const tools = await proxy.listTools();
    assert.equal(tools.length, 5);
    assert.notEqual(proxy.status().pid, firstPid);
    assert.equal(spawnedCount(), 2);
  } finally {
    await proxy.dispose();
  }
});

test("proxy captures the child stderr ring buffer", async () => {
  const lines = [];
  const { proxy } = makeProxy({ FAKE_STDERR: "1" }, { onStderrLine: (line) => lines.push(line) });
  try {
    await proxy.listTools();
    const deadline = Date.now() + 2000;
    let tail = "";
    while (Date.now() < deadline) {
      tail = proxy.status().stderrTail.join("\n");
      if (tail.includes("fake-artemis ready")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(tail, /fake-artemis ready/);
    assert.ok(
      lines.some((line) => line.includes("fake-artemis ready")),
      "onStderrLine sink should receive child stderr lines"
    );
  } finally {
    await proxy.dispose();
  }
});
