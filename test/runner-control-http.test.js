import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { createHttpWebRunnerControl } from "../dist/runner/control/client.js";
import { runWebRunner, runWebRunnerCommand } from "../dist/runner/web-agent.js";

const HOST = "web-control-http-host";
const TOKEN = "runner-control-token-0123456789abcdef";

function android() {
  return {
    serial: "pixel-http-1",
    name: "",
    model: "Pixel 7",
    osVersion: "14",
    platform: "android",
    kind: "device",
    state: "device"
  };
}

async function makeWorkspace() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "aos-runner-control-"));
}

async function makeStore() {
  const store = new MemoryStore();
  const rootPath = await makeWorkspace();
  const project = await store.upsertProject({ rootPath, name: path.basename(rootPath) });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: { kind: "web-test" },
    deviceSerial: "pixel-http-1",
    deviceLeaseId: `${HOST}:pixel-http-1`
  });
  const leased = await store.acquireDeviceLeases({
    hostId: HOST,
    taskId: task.id,
    projectId: project.id,
    serials: ["pixel-http-1"],
    ttlMs: 300_000,
    at: new Date().toISOString()
  });
  assert.equal(leased.ok, true);
  return { store, rootPath, task };
}

function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("runner control HTTP：心跳/领取/开始/终态与鉴权", async () => {
  const { store, rootPath, task } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    delete process.env.AOS_RUNNER_CONTROL;
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const control = createHttpWebRunnerControl({
        baseUrl,
        token: TOKEN,
        hostId: HOST,
        instanceId: "http-instance-1"
      });
      const beat = await control.heartbeat({
        host: {
          hostname: "web-control-http",
          username: "qa",
          osPlatform: "darwin",
          osVersion: "14.0",
          arch: "arm64",
          kind: "mac"
        },
        name: "http-runner",
        version: "test",
        artifactBaseUrl: null,
        inventory: {
          platforms: ["android"],
          devices: [android()],
          tools: {
            adb: true,
            idb: false,
            simctl: false,
            ideviceId: false,
            appium: false,
            maestro: true,
            devicectl: false
          }
        },
        active: []
      });
      assert.equal(beat.ok, true);

      const claimed = await control.claim("pixel-http-1");
      assert.equal(claimed.kind, "claimed");
      assert.equal(claimed.task.id, task.id);
      assert.match(claimed.leaseToken, /^[0-9a-f]{64}$/);

      const began = await control.begin(task.id);
      assert.equal(began.started, true);

      const terminal = await control.terminal(task.id, "completed");
      assert.equal(terminal, "written");
      const stored = await store.getRegressionTask(rootPath, task.id);
      assert.equal(stored.status, "completed");

      await control.releaseLease(task.id, "pixel-http-1", claimed.leaseToken);
      await control.stop();

      const unauthenticated = await fetch(`${baseUrl}/panel/api/runners/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aos-host-id": HOST },
        body: JSON.stringify({})
      });
      assert.equal(unauthenticated.status, 401);
    } finally {
      await handle.close();
    }
  });
});

test("runner control HTTP：错误 token / 缺 host / 非法 body", async () => {
  const { store } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const headers = {
        authorization: `Bearer ${TOKEN}`,
        "x-aos-host-id": HOST,
        "content-type": "application/json"
      };
      const wrongToken = await fetch(`${baseUrl}/panel/api/runners/claim`, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer wrong" },
        body: JSON.stringify({ instanceId: "x", deviceSerial: "pixel-http-1" })
      });
      assert.equal(wrongToken.status, 401);

      const noHost = await fetch(`${baseUrl}/panel/api/runners/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ instanceId: "x", deviceSerial: "pixel-http-1" })
      });
      assert.equal(noHost.status, 403);

      const invalid = await fetch(`${baseUrl}/panel/api/runners/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceSerial: "pixel-http-1" })
      });
      assert.equal(invalid.status, 400);
    } finally {
      await handle.close();
    }
  });
});


test("runner control HTTP：web-runner agent 仅凭 control 跑完一轮（不打开 PG）", async () => {
  const { store, rootPath, task } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const control = createHttpWebRunnerControl({
        baseUrl,
        token: TOKEN,
        hostId: HOST,
        instanceId: "http-agent-instance"
      });
      const logs = [];
      const errors = [];
      const code = await runWebRunner(
        {
          control,
          name: "http-agent",
          env: { AOS_HOST_ID: HOST, AOS_DEVICE_LEASE_MS: "300000", AOS_RUNNER_TTL_MS: "90000" },
          once: true
        },
        { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) },
        {
          collectInventory: async () => ({
            platforms: ["android"],
            devices: [android()],
            tools: {
              adb: true,
              idb: false,
              simctl: false,
              ideviceId: false,
              appium: false,
              maestro: true,
              devicectl: false
            }
          }),
          executeJob: async () => ({ status: "completed" }),
          sleep: async () => {},
          now: () => Date.now()
        }
      );
      assert.equal(code, 0, errors.join("\n"));
      const stored = await store.getRegressionTask(rootPath, task.id);
      assert.equal(stored.status, "completed");
      assert.ok(logs.some((line) => line.includes("执行结束：completed")), logs.join("\n"));
    } finally {
      await handle.close();
    }
  });
});


test("runner control HTTP：CLI --control-url 不需要 MOBILE_TESTING_DATABASE_URL", async () => {
  const { store, rootPath, task } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const logs = [];
      const errors = [];
      const code = await runWebRunnerCommand(
        ["--control-url", baseUrl, "--once"],
        { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) },
        {
          env: {
            AOS_HOST_ID: HOST,
            AOS_RUNNER_JOB_TOKEN: TOKEN,
            AOS_DEVICE_LEASE_MS: "300000",
            AOS_RUNNER_TTL_MS: "90000"
          },
          collectInventory: async () => ({
            platforms: ["android"],
            devices: [android()],
            tools: {
              adb: true,
              idb: false,
              simctl: false,
              ideviceId: false,
              appium: false,
              maestro: true,
              devicectl: false
            }
          }),
          executeJob: async () => ({ status: "completed" }),
          sleep: async () => {},
          now: () => Date.now()
        }
      );
      assert.equal(code, 0, errors.join("\n"));
      assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "completed");
      assert.ok(logs.some((line) => line.includes("控制面")), logs.join("\n"));
    } finally {
      await handle.close();
    }
  });
});


test("runner control HTTP：每主机 token 优先，host 头必须匹配", async () => {
  const { store } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  const hostTokens = JSON.stringify([{ hostId: HOST, token: TOKEN }]);
  await withEnv("AOS_RUNNER_HOST_TOKENS", hostTokens, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const control = createHttpWebRunnerControl({
        baseUrl,
        token: TOKEN,
        hostId: HOST,
        instanceId: "host-token-instance"
      });
      const beat = await control.heartbeat({
        host: {
          hostname: "host-token",
          username: "qa",
          osPlatform: "darwin",
          osVersion: "14.0",
          arch: "arm64",
          kind: "mac"
        },
        name: "host-token-runner",
        version: "test",
        artifactBaseUrl: null,
        inventory: {
          platforms: ["android"],
          devices: [android()],
          tools: {
            adb: true,
            idb: false,
            simctl: false,
            ideviceId: false,
            appium: false,
            maestro: true,
            devicectl: false
          }
        },
        active: []
      });
      assert.equal(beat.ok, true);

      const wrongHost = await fetch(`${baseUrl}/panel/api/runners/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": "other-host",
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      assert.equal(wrongHost.status, 403);
      const wrongToken = await fetch(`${baseUrl}/panel/api/runners/heartbeat`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      assert.equal(wrongToken.status, 401);
    } finally {
      await handle.close();
    }
  });
});

test("runner control HTTP：每主机 token 配置非法 fail-closed", async () => {
  const { store } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_HOST_TOKENS", "not-json", async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const response = await fetch(`${baseUrl}/panel/api/runners/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      assert.equal(response.status, 503);
    } finally {
      await handle.close();
    }
  });
});


test("runner control HTTP：AOS_RUNNER_HOST_TOKENS_FILE 热更新", async () => {
  const { store } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  const tokenFile = path.join(workspaceRoot, "runner-tokens.json");
  const firstToken = "host-file-token-1111111111111111";
  const secondToken = "host-file-token-22222222222222222222";
  fs.writeFileSync(tokenFile, JSON.stringify([{ hostId: HOST, token: firstToken }]));
  fs.chmodSync(tokenFile, 0o600);
  await withEnv("AOS_RUNNER_HOST_TOKENS", "", async () => {
    await withEnv("AOS_RUNNER_HOST_TOKENS_FILE", tokenFile, async () => {
      const handle = await createAosHttpServer({
        port: 0,
        host: "127.0.0.1",
        workspaceRoot,
        store
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      try {
        const first = createHttpWebRunnerControl({
          baseUrl,
          token: firstToken,
          hostId: HOST,
          instanceId: "file-instance-1"
        });
        const body = {
          host: {
            hostname: "file-token",
            username: "qa",
            osPlatform: "darwin",
            osVersion: "14.0",
            arch: "arm64",
            kind: "mac"
          },
          name: "file-token-runner",
          version: "test",
          artifactBaseUrl: null,
          inventory: {
            platforms: ["android"],
            devices: [android()],
            tools: {
              adb: true,
              idb: false,
              simctl: false,
              ideviceId: false,
              appium: false,
              maestro: true,
              devicectl: false
            }
          },
          active: []
        };
        assert.equal((await first.heartbeat(body)).ok, true);

        fs.writeFileSync(tokenFile, JSON.stringify([{ hostId: HOST, token: secondToken }]));
        fs.chmodSync(tokenFile, 0o600);
        const oldToken = await fetch(`${baseUrl}/panel/api/runners/heartbeat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${firstToken}`,
            "x-aos-host-id": HOST,
            "content-type": "application/json"
          },
          body: JSON.stringify({})
        });
        assert.equal(oldToken.status, 401);

        const second = createHttpWebRunnerControl({
          baseUrl,
          token: secondToken,
          hostId: HOST,
          instanceId: "file-instance-1"
        });
        assert.equal((await second.heartbeat(body)).ok, true);
      } finally {
        await handle.close();
      }
    });
  });
});


test("runner control HTTP：token 文件非 0600 fail-closed", async () => {
  if (process.platform === "win32") return;
  const { store } = await makeStore();
  const workspaceRoot = await makeWorkspace();
  const tokenFile = path.join(workspaceRoot, "runner-tokens-insecure.json");
  fs.writeFileSync(tokenFile, JSON.stringify([{ hostId: HOST, token: TOKEN }]), { mode: 0o644 });
  fs.chmodSync(tokenFile, 0o644);
  await withEnv("AOS_RUNNER_HOST_TOKENS", "", async () => {
    await withEnv("AOS_RUNNER_HOST_TOKENS_FILE", tokenFile, async () => {
      const handle = await createAosHttpServer({
        port: 0,
        host: "127.0.0.1",
        workspaceRoot,
        store
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      try {
        const response = await fetch(`${baseUrl}/panel/api/runners/heartbeat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "x-aos-host-id": HOST,
            "content-type": "application/json"
          },
          body: JSON.stringify({})
        });
        assert.equal(response.status, 503);
      } finally {
        await handle.close();
      }
    });
  });
});

test("控制面客户端：请求超时会中止并进入 network-error", async () => {
  const control = createHttpWebRunnerControl({
    baseUrl: "http://center.invalid",
    token: TOKEN,
    hostId: HOST,
    instanceId: "http-timeout",
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => undefined, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new DOMException("aborted", "AbortError"));
        });
      })
  });
  await assert.rejects(
    () => control.stop(),
    (error) => error instanceof Error && /network-error|abort/i.test(error.message)
  );
});
