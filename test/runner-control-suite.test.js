import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { fireDueSchedules } from "../dist/runner/schedules.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { buildRemoteSuiteRuntime } from "../dist/cli-runtime.js";
import { SuiteStoreClient } from "../dist/runner/control/suite-client.js";
import { createHybridSuiteStore } from "../dist/runner/control/suite-store.js";
import { baseConfig, makeTempProject } from "./helpers.js";

const HOST = "suite-control-host";
const TOKEN = "suite-control-token-0123456789abcdef";

function tools() {
  return {
    adb: true,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false
  };
}

async function makeWorkspace() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), "aos-suite-control-"));
}

function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

async function makeCentral(rootPathOverride = null) {
  const store = new MemoryStore();
  const rootPath = rootPathOverride ?? (await makeWorkspace());
  const project = await store.upsertProject({ rootPath, name: path.basename(rootPath), hostId: HOST });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST
  });
  return { store, rootPath, project, task };
}

async function runRecord(rootPath, taskId) {
  return {
    rootPath,
    run: {
      runId: "run-suite-1",
      trigger: "task",
      regressionTaskId: taskId,
      caseSetId: null,
      featureKey: "login",
      featureName: "登录",
      platform: "android",
      device: "pixel-1",
      appVersion: "1.0.0",
      runner: "suite-control",
      status: "completed",
      startedAt: "2026-11-02T00:00:00.000Z",
      finishedAt: "2026-11-02T00:01:00.000Z",
      total: 1,
      passed: 1,
      failed: 0,
      flaky: 0,
      quarantined: 0,
      failureDomains: {},
      gateResult: "pass",
      exitCode: 0,
      manifestPath: null,
      comparison: null,
      apiReview: null
    },
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: "login",
        platform: "android",
        status: "passed",
        traceId: "trace-1",
        failureDomain: null,
        failureConfidence: null,
        failureReason: null,
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null,
        jiraIssueKey: null
      }
    ]
  };
}

test("suite control: hybrid store 通过 HTTP 资源读写任务/case set/run/租约", async () => {
  const central = await makeCentral();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central.store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const local = new MemoryStore();
      await local.upsertProject({ rootPath: central.rootPath, name: path.basename(central.rootPath), hostId: HOST });
      const client = new SuiteStoreClient({ baseUrl, token: TOKEN, hostId: HOST, instanceId: "suite-instance-1" });
      const hybrid = createHybridSuiteStore(local, client);

      assert.equal((await hybrid.getRegressionTask(central.rootPath, central.task.id)).id, central.task.id);
      const bundle = await hybrid.getTaskBundle?.(central.rootPath, central.task.id);
      assert.equal(bundle?.task.id, central.task.id);
      assert.equal(bundle?.project?.id, central.project.id);
      assert.deepEqual(await hybrid.listCaseSets(central.rootPath), []);
      assert.deepEqual(await hybrid.listSuiteRuns(central.rootPath), []);

      const runner = await hybrid.upsertRunner({
        rootPath: central.rootPath,
        name: "suite-control",
        hostname: "suite-control",
        platforms: ["android"],
        devices: [],
        tools: tools(),
        hostId: HOST,
        instanceId: "suite-instance-1"
      });
      assert.equal(runner.hostId, HOST);
      const leases = await hybrid.acquireDeviceLeases({
        hostId: HOST,
        taskId: central.task.id,
        projectId: central.project.id,
        serials: ["pixel-1"],
        ttlMs: 60_000
      });
      assert.equal(leases.ok, true);
      const claimed = await hybrid.claimRegressionTask({
        rootPath: central.rootPath,
        runnerId: runner.id,
        platforms: ["android"],
        hostId: HOST,
        instanceId: "suite-instance-1",
        capabilities: ["android"]
      });
      assert.equal(claimed.id, central.task.id);
      assert.equal(
        (await hybrid.beginExecution({
          rootPath: central.rootPath,
          taskId: claimed.id,
          runnerId: runner.id,
          instanceId: "suite-instance-1"
        })).status,
        "running"
      );

      const otherInstance = new SuiteStoreClient({
        baseUrl,
        token: TOKEN,
        hostId: HOST,
        instanceId: "other-instance"
      });
      await assert.rejects(
        () =>
          otherInstance.updateRegressionTask(central.rootPath, claimed.id, {
            lastProgressAt: new Date().toISOString()
          }),
        (error) =>
          error?.name === "SuiteStoreHttpError" &&
          error.status === 409 &&
          error.code === "instance-mismatch"
      );
      assert.equal(
        await hybrid.updateRegressionTask(central.rootPath, claimed.id, {
          status: "completed",
          expectStatuses: ["running"]
        }),
        true
      );
      const run = await hybrid.recordSuiteRun(await runRecord(central.rootPath, claimed.id));
      assert.ok(run.id);
      const runs = await hybrid.listSuiteRuns(central.rootPath, { limit: 5 });
      assert.equal(runs.length, 1);
      assert.equal((await local.listCaseSets(central.rootPath)).length, 0);
      assert.equal(await hybrid.releaseDeviceLeases({ hostId: HOST, taskId: claimed.id }), 1);
    } finally {
      await handle.close();
    }
  });
});

test("suite control: 资源路由鉴权 / host / 未知路由", async () => {
  const central = await makeCentral();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central.store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "x-aos-host-id": HOST,
      "content-type": "application/json"
    };
    try {
      const unauthorized = await fetch(
        `${baseUrl}/panel/api/runners/suite/projects?rootPath=${encodeURIComponent(central.rootPath)}`,
        {
          method: "GET",
          headers: { ...headers, authorization: "Bearer wrong" }
        }
      );
      assert.equal(unauthorized.status, 401);
      const wrongHost = await fetch(
        `${baseUrl}/panel/api/runners/suite/projects?rootPath=${encodeURIComponent(central.rootPath)}`,
        {
          method: "GET",
          headers: { ...headers, "x-aos-host-id": "other-host" }
        }
      );
      assert.equal(wrongHost.status, 403);
      const unknown = await fetch(`${baseUrl}/panel/api/runners/suite/nope`, {
        method: "POST",
        headers,
        body: JSON.stringify({})
      });
      assert.equal(unknown.status, 404);
    } finally {
      await handle.close();
    }
  });
});

test("suite control: buildRemoteSuiteRuntime 使用本地文件台账 + HTTP 数据面", async () => {
  const projectDir = makeTempProject({ config: baseConfig() });
  const central = await makeCentral(projectDir);
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central.store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const env = {
        AOS_HOST_ID: HOST,
        AOS_RUNNER_JOB_TOKEN: TOKEN,
        AOS_RUNNER_CONTROL_URL: baseUrl,
        MOBILE_TESTING_PANEL_BASE_URL: baseUrl,
        AOS_PROJECT_DIR: projectDir,
        AOS_CONFIG: ""
      };
      const built = await buildRemoteSuiteRuntime(projectDir, env);
      try {
        assert.equal(built.runtime.store.kind, "file");
        const task = await built.runtime.store.getRegressionTask(projectDir, central.task.id);
        assert.equal(task?.id, central.task.id);
      } finally {
        await built.dispose();
      }
    } finally {
      await handle.close();
    }
  });
});


function probe(present = false) {
  return { present, version: present ? "1.0" : null, path: present ? "/bin/tool" : null };
}

function hostSnapshot() {
  return {
    identity: {
      id: HOST,
      hardwareId: null,
      hostname: "suite-control-host",
      username: "qa",
      osPlatform: "darwin",
      osVersion: "14.0",
      arch: "arm64",
      kind: "mac",
      identitySource: "env"
    },
    env: {
      collectedAt: new Date().toISOString(),
      node: process.version,
      aos: "test",
      cpu: { model: "test", count: 1 },
      memory: { totalBytes: 1024 },
      disk: { path: "/", freeBytes: null, totalBytes: null },
      tools: {
        adb: probe(true),
        xcodebuild: probe(),
        simctl: probe(),
        idb: probe(),
        ideviceId: probe(),
        idevicesyslog: probe(),
        appium: probe(),
        uv: probe()
      }
    },
    capabilities: ["android"],
    ipPrimary: null,
    addresses: []
  };
}

test("suite control: suite runner 仅凭 AOS_RUNNER_CONTROL_URL 领取并执行一轮", async () => {
  const projectDir = makeTempProject({ config: baseConfig() });
  const central = await makeCentral(projectDir);
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central.store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const executed = [];
      const code = await runSuiteCommand(
        ["runner", "--project", projectDir, "--name", "suite-http", "--once", "--artifact-port", "0"],
        {
          env: {
            AOS_HOST_ID: HOST,
            AOS_RUNNER_JOB_TOKEN: TOKEN,
            AOS_RUNNER_CONTROL_URL: baseUrl,
            MOBILE_TESTING_PANEL_BASE_URL: baseUrl
          },
          runner: {
            executeSuite: async (argv) => {
              executed.push(argv);
              return 0;
            },
            collectInventory: async () => ({
              platforms: ["android"],
              devices: [
                {
                  serial: "pixel-1",
                  name: "",
                  model: "Pixel 7",
                  osVersion: "14",
                  platform: "android",
                  kind: "device",
                  state: "device"
                }
              ],
              tools: tools()
            }),
            collectHostSnapshot: async () => hostSnapshot(),
            sleep: async () => {}
          }
        }
      );
      assert.equal(code, 0);
      assert.equal(executed.length, 1);
      assert.ok(executed[0].includes("--task"));
      const stored = await central.store.getRegressionTask(projectDir, central.task.id);
      assert.equal(stored.status, "running");
    } finally {
      await handle.close();
    }
  });
});


test("suite control: buildRemoteSuiteRuntime 首次接入会登记 host/project（中心原无项目行）", async () => {
  const projectDir = makeTempProject({ config: baseConfig() });
  const central = new MemoryStore();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const env = {
        AOS_HOST_ID: HOST,
        AOS_RUNNER_JOB_TOKEN: TOKEN,
        AOS_RUNNER_CONTROL_URL: baseUrl,
        MOBILE_TESTING_PANEL_BASE_URL: baseUrl,
        AOS_PROJECT_DIR: projectDir,
        AOS_CONFIG: ""
      };
      const built = await buildRemoteSuiteRuntime(projectDir, env);
      try {
        const project = await central.getProjectByPath(projectDir);
        assert.ok(project);
        assert.equal(project.hostId, HOST);
        assert.ok(await central.getHost(HOST));
      } finally {
        await built.dispose();
      }
    } finally {
      await handle.close();
    }
  });
});


test("suite control: 定时回归窗口与审计通过 HTTP 资源", async () => {
  const central = await makeCentral();
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central.store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      await central.store.recordCaseSet({
        rootPath: central.rootPath,
        source: "figma",
        basename: "login",
        features: [
          {
            key: "login",
            name: "登录",
            caseCount: 1,
            screens: ["Home"],
            jsonPath: "/tmp/login.json",
            mdPath: "/tmp/login.md",
            xlsxPath: "/tmp/login.xlsx"
          }
        ]
      });
      await central.store.createSchedule({
        rootPath: central.rootPath,
        name: "nightly",
        featureKeys: ["login"],
        platforms: ["android"],
        baseline: "latest",
        everyMinutes: 1
      });
      const local = new MemoryStore();
      await local.upsertProject({ rootPath: central.rootPath, name: path.basename(central.rootPath), hostId: HOST });
      const client = new SuiteStoreClient({ baseUrl, token: TOKEN, hostId: HOST, instanceId: "suite-instance-1" });
      const hybrid = createHybridSuiteStore(local, client);
      const fired = await fireDueSchedules({ store: hybrid, rootPath: central.rootPath });
      assert.equal(fired, 1);
      const tasks = await central.store.listRegressionTasks(central.rootPath);
      assert.ok(tasks.some((task) => task.createdBy === "schedule:nightly"));
      const schedules = await hybrid.listSchedules(central.rootPath);
      assert.ok(schedules[0].lastFiredAt);
    } finally {
      await handle.close();
    }
  });
});

test("suite control: /llm 用中心默认项目返回代理，runner 不需要项目路径", async () => {
  const projectDir = makeTempProject({ config: baseConfig() });
  const central = await makeCentral(projectDir);
  await central.store.upsertLlm(central.rootPath, {
    name: "center-deepseek",
    provider: "custom",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-center-test",
    makeActive: true
  });
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, () =>
    withEnv("AOS_RUNNER_DEFAULT_PROJECT", central.rootPath, async () => {
      const handle = await createAosHttpServer({
        port: 0,
        host: "127.0.0.1",
        workspaceRoot,
        store: central.store
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const headers = { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": HOST };
      try {
        const response = await fetch(`${baseUrl}/panel/api/runners/suite/llm`, { headers });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.ok, true);
        assert.equal(payload.value.found, true);
        assert.equal(payload.value.entry.model, "deepseek-flash");
        assert.equal(payload.value.entry.apiKey, null, "真实 key 不下发给 runner");
        assert.match(payload.value.entry.baseUrl, /\/panel\/api\/runners\/suite\/llm\/proxy\//);
        assert.equal(JSON.stringify(payload).includes("sk-center-test"), false);

        const env = {
          AOS_HOST_ID: HOST,
          AOS_RUNNER_JOB_TOKEN: TOKEN,
          AOS_RUNNER_CONTROL_URL: baseUrl,
          MOBILE_TESTING_PANEL_BASE_URL: baseUrl,
          AOS_PROJECT_DIR: projectDir,
          AOS_CONFIG: "",
          AOS_LLM_FROM_CENTER: "1"
        };
        const built = await buildRemoteSuiteRuntime(projectDir, env);
        try {
          const active = await built.runtime.activeEntry();
          assert.equal(active?.name, "center:center-deepseek");
          assert.equal(active?.model, "deepseek-flash");
          assert.match(active?.baseUrl ?? "", /\/panel\/api\/runners\/suite\/llm\/proxy\//);
          assert.equal(active?.apiKey, TOKEN, "runner 用 runner token 调中心代理");
          const entries = await built.runtime.entries();
          assert.ok(entries.some((entry) => entry.name === "center:center-deepseek"));
        } finally {
          await built.dispose();
        }
      } finally {
        await handle.close();
      }
    })
  );
});

test("suite control: LLM 代理转发到中心 provider，runner 不接触真实 key", async () => {
  const projectDir = makeTempProject({ config: baseConfig() });
  const central = await makeCentral(projectDir);
  const providerRequests = [];
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      providerRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-test", choices: [] }));
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;
  await central.store.upsertLlm(central.rootPath, {
    name: "center-deepseek",
    provider: "custom",
    model: "deepseek-flash",
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: "sk-upstream",
    makeActive: true
  });
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({
      port: 0,
      host: "127.0.0.1",
      workspaceRoot,
      store: central.store
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    try {
      const proxyUrl = `${baseUrl}/panel/api/runners/suite/llm/proxy/${Buffer.from(
        central.rootPath,
        "utf8"
      ).toString("base64url")}/chat/completions`;
      const response = await fetch(proxyUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: [{ role: "user", content: "hi" }]
        })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, "chatcmpl-test");
      assert.equal(providerRequests.length, 1);
      assert.equal(providerRequests[0].url, "/v1/chat/completions");
      assert.equal(providerRequests[0].authorization, "Bearer sk-upstream");
    } finally {
      await handle.close();
      await new Promise((resolve) => provider.close(resolve));
    }
  });
});

test("suite control: default project + bundle documents allow a different runner root", async () => {
  const centerDir = await makeWorkspace();
  const central = await makeCentral(centerDir);
  const designDir = path.join(centerDir, ".artemis", "design");
  const caseSetDir = path.join(designDir, "case-sets");
  fs.mkdirSync(caseSetDir, { recursive: true });
  const caseSetJson = path.join(caseSetDir, "login.json");
  fs.writeFileSync(
    caseSetJson,
    JSON.stringify({ flows: [{ id: "TC_01", name: "登录" }] })
  );
  fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify({ screens: [] }));
  await central.store.recordCaseSet({
    rootPath: central.rootPath,
    source: "test",
    basename: "login",
    features: [
      {
        key: "login",
        name: "登录",
        caseCount: 1,
        screens: [],
        jsonPath: caseSetJson,
        mdPath: "",
        xlsxPath: ""
      }
    ]
  });
  const [caseSet] = await central.store.listCaseSets(central.rootPath);
  const task = await central.store.createRegressionTask({
    rootPath: central.rootPath,
    refs: [{ caseSetId: caseSet.id, featureKey: "login" }],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST
  });
  const localDir = makeTempProject({ config: baseConfig() });
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, () =>
    withEnv("AOS_RUNNER_DEFAULT_PROJECT", central.rootPath, async () => {
      const handle = await createAosHttpServer({
        port: 0,
        host: "127.0.0.1",
        workspaceRoot,
        store: central.store
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const headers = { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": HOST };
      try {
        const defaultProject = await fetch(
          `${baseUrl}/panel/api/runners/suite/default-project`,
          { headers }
        );
        assert.equal(defaultProject.status, 200);
        const defaultPayload = await defaultProject.json();
        assert.equal(defaultPayload.value.found, true);
        assert.equal(defaultPayload.value.rootPath, central.rootPath);

        const bundleResponse = await fetch(
          `${baseUrl}/panel/api/runners/suite/tasks/${encodeURIComponent(task.id)}/bundle?rootPath=${encodeURIComponent(central.rootPath)}`,
          { headers }
        );
        assert.equal(bundleResponse.status, 200);
        const bundlePayload = await bundleResponse.json();
        assert.equal(bundlePayload.value.documents.length, 1);
        assert.match(bundlePayload.value.documents[0].content, /TC_01/);
        assert.match(bundlePayload.value.flows.content, /screens/);

        const env = {
          AOS_HOST_ID: HOST,
          AOS_RUNNER_JOB_TOKEN: TOKEN,
          AOS_RUNNER_CONTROL_URL: baseUrl,
          MOBILE_TESTING_PANEL_BASE_URL: baseUrl,
          AOS_PROJECT_DIR: localDir,
          AOS_CONFIG: ""
        };
        const built = await buildRemoteSuiteRuntime(localDir, env);
        try {
          const remoteTask = await built.runtime.store.getRegressionTask(localDir, task.id);
          assert.equal(remoteTask?.id, task.id);
          const remoteBundle = await built.runtime.store.getTaskBundle?.(localDir, task.id);
          assert.equal(remoteBundle?.documents?.length, 1);
        } finally {
          await built.dispose();
        }
      } finally {
        await handle.close();
      }
    })
  );
});

test("suite control: suite runner claims center task with a different local root via default project", async () => {
  const centerDir = await makeWorkspace();
  const central = await makeCentral(centerDir);
  const localDir = makeTempProject({ config: baseConfig() });
  const workspaceRoot = await makeWorkspace();
  await withEnv("AOS_RUNNER_JOB_TOKEN", TOKEN, () =>
    withEnv("AOS_RUNNER_DEFAULT_PROJECT", central.rootPath, async () => {
      const handle = await createAosHttpServer({
        port: 0,
        host: "127.0.0.1",
        workspaceRoot,
        store: central.store
      });
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      try {
        const executed = [];
        const code = await runSuiteCommand(
          [
            "runner",
            "--project",
            localDir,
            "--name",
            "suite-cross-root",
            "--once",
            "--artifact-port",
            "0"
          ],
          {
            env: {
              AOS_HOST_ID: HOST,
              AOS_RUNNER_JOB_TOKEN: TOKEN,
              AOS_RUNNER_CONTROL_URL: baseUrl,
              MOBILE_TESTING_PANEL_BASE_URL: baseUrl
            },
            runner: {
              executeSuite: async (argv) => {
                executed.push(argv);
                return 0;
              },
              collectInventory: async () => ({
                platforms: ["android"],
                devices: [
                  {
                    serial: "pixel-1",
                    name: "",
                    model: "Pixel 7",
                    osVersion: "14",
                    platform: "android",
                    kind: "device",
                    state: "device"
                  }
                ],
                tools: tools()
              }),
              collectHostSnapshot: async () => hostSnapshot(),
              sleep: async () => {}
            }
          }
        );
        assert.equal(code, 0);
        assert.equal(executed.length, 1);
        assert.ok(executed[0].includes("--task"));
        const stored = await central.store.getRegressionTask(central.rootPath, central.task.id);
        assert.equal(stored.status, "running");
      } finally {
        await handle.close();
      }
    })
  );
});
