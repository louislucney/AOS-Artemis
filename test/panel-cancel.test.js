import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject, TEST_HOST_IDENTITY } from "./helpers.js";

async function setupLocal() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { dir, store, runtime, rootPath: runtime.project.rootDir };
}

function taskInput(rootPath) {
  return {
    rootPath,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  };
}

function request(pathname, body) {
  return {
    method: "POST",
    url: new URL(`http://localhost${pathname}`),
    body
  };
}

function bodyOf(response) {
  return JSON.parse(response.body);
}

test("panel cancel: pending → cancelled，响应 {ok,task}，审计 actor/channel", async () => {
  const { store, rootPath } = await setupLocal();
  const task = await store.createRegressionTask(taskInput(rootPath));

  const response = await handlePanelActionRequest(
    request("/panel/api/tasks/cancel", { project: rootPath, taskId: task.id, note: "面板停止" }),
    { store, env: {} }
  );
  assert.equal(response.status, 200);
  const payload = bodyOf(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.task.status, "cancelled");
  assert.equal(payload.task.cancelSource, "panel");
  assert.equal(payload.task.cancelledBy, "panel");
  assert.equal(payload.task.cancelNote, "面板停止");
  assert.ok(payload.task.cancelledAt);

  const audit = await store.listAudit(rootPath, { domain: "panel" });
  const event = audit.find((entry) => entry.action === "action.tasks.cancel");
  assert.ok(event, "写入 action.tasks.cancel 审计");
  assert.equal(event.actor, "panel");
  assert.equal(event.channel, "panel");
  assert.equal(event.actorHostId, TEST_HOST_IDENTITY.id);
  assert.equal(event.refs.taskId, task.id);
});

test("panel cancel: host 作用域——同路径两主机只取消指定主机任务", async () => {
  const base = new MemoryStore();
  const a = base.scopeHost("h-a");
  const b = base.scopeHost("h-b");
  await a.upsertProject({ rootPath: "/w/app", name: "app" });
  await b.upsertProject({ rootPath: "/w/app", name: "app" });
  const ta = await a.createRegressionTask({ ...taskInput("/w/app"), targetHostId: "h-a", createdHostId: "h-a" });
  const tb = await b.createRegressionTask({ ...taskInput("/w/app"), targetHostId: "h-b", createdHostId: "h-b" });
  const deps = { store: base, env: {}, storeForHost: (hostId) => base.scopeHost(hostId) };

  const response = await handlePanelActionRequest(
    request("/panel/api/tasks/cancel", { project: "/w/app", host: "h-a", taskId: ta.id }),
    deps
  );
  assert.equal(response.status, 200);
  assert.equal((await a.getRegressionTask("/w/app", ta.id)).status, "cancelled");
  assert.equal((await b.getRegressionTask("/w/app", tb.id)).status, "pending", "另一主机不受影响");

  const audit = await a.listAudit("/w/app", { domain: "panel" });
  const event = audit.find((entry) => entry.action === "action.tasks.cancel");
  assert.equal(event.actorHostId, "h-a");
});

test("panel cancel: 空 taskId 400；未知任务 404；已取消幂等不覆盖", async () => {
  const { store, rootPath } = await setupLocal();
  const empty = await handlePanelActionRequest(
    request("/panel/api/tasks/cancel", { project: rootPath, taskId: "  " }),
    { store, env: {} }
  );
  assert.equal(empty.status, 400);

  const missing = await handlePanelActionRequest(
    request("/panel/api/tasks/cancel", { project: rootPath, taskId: "task-nope" }),
    { store, env: {} }
  );
  assert.equal(missing.status, 404);

  const unknownProject = await handlePanelActionRequest(
    request("/panel/api/tasks/cancel", { project: "/w/nope", taskId: "task-nope" }),
    { store, env: {} }
  );
  assert.equal(unknownProject.status, 404);

  const task = await store.createRegressionTask(taskInput(rootPath));
  const first = await store.cancelRegressionTask({
    rootPath,
    taskId: task.id,
    source: "admin",
    actor: "ops",
    actorHostId: "h-ops",
    note: "管理员取消",
    at: "2026-10-21T03:00:00.000Z"
  });
  const again = await handlePanelActionRequest(
    request("/panel/api/tasks/cancel", { project: rootPath, taskId: task.id, note: "重复" }),
    { store, env: {} }
  );
  assert.equal(again.status, 200);
  const payload = bodyOf(again);
  assert.equal(payload.task.cancelledBy, "ops");
  assert.equal(payload.task.cancelSource, "admin");
  assert.equal(payload.task.cancelledAt, first.cancelledAt);
});

test("CLI suite task cancel：本地来源 local-cli，actor/host 与审计落库", async () => {
  const { store, runtime, rootPath } = await setupLocal();
  const task = await store.createRegressionTask(taskInput(rootPath));
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(["task", "cancel", task.id, "--note", "CLI 取消", "--json"], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    env: { AOS_ACTOR: "louis" }
  });
  assert.equal(code, 0, errors.join("\n"));
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(payload.ok, true);
  assert.equal(payload.task.status, "cancelled");
  assert.equal(payload.task.cancelSource, "local-cli");
  assert.equal(payload.task.cancelledBy, "louis");
  assert.equal(payload.task.cancelledHostId, TEST_HOST_IDENTITY.id);
  assert.equal(payload.task.cancelNote, "CLI 取消");

  const audit = await store.listAudit(rootPath, { domain: "suite" });
  const event = audit.find((entry) => entry.action === "action.tasks.cancel");
  assert.ok(event, "本地取消写入审计");
  assert.equal(event.actor, "louis");
  assert.equal(event.actorHostId, TEST_HOST_IDENTITY.id);
  assert.equal(event.channel, "cli");

  const missing = await runSuiteCommand(["task", "cancel", "task-nope"], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: () => {},
    errorLog: (line) => errors.push(line),
    env: { AOS_ACTOR: "louis" }
  });
  assert.equal(missing, 2);
  assert.ok(errors.some((line) => line.includes("未找到")));
});

test("CLI suite task cancel --host：中心模式不建本地 Runtime，来源 panel", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  const scoped = store.scopeHost("h-b");
  await scoped.upsertProject({ rootPath: "/w/app", name: "app" });
  const task = await scoped.createRegressionTask({
    ...taskInput("/w/app"),
    targetHostId: "h-b",
    createdHostId: "h-b"
  });

  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(
    ["task", "cancel", task.id, "--host", "h-b", "--project", "/w/app", "--json"],
    {
      buildRuntime: () => {
        throw new Error("should not build local Runtime");
      },
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
      center: { store },
      env: { AOS_ACTOR: "ops" }
    }
  );
  assert.equal(code, 0, errors.join("\n"));
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(payload.task.status, "cancelled");
  assert.equal(payload.task.cancelSource, "panel");
  assert.equal(payload.task.cancelledBy, "ops");

  const after = await scoped.getRegressionTask("/w/app", task.id);
  assert.equal(after.status, "cancelled");
  const audit = await store.listAudit("/w/app", { domain: "suite" });
  const event = audit.find((entry) => entry.action === "action.tasks.cancel");
  assert.ok(event);
  assert.equal(event.channel, "cli");
  assert.equal(event.actorHostId, null);
});

test("suite run --task：cancelled 拒绝执行（exit 2）", async () => {
  const { store, runtime, rootPath } = await setupLocal();
  const task = await store.createRegressionTask(taskInput(rootPath));
  await store.cancelRegressionTask({
    rootPath,
    taskId: task.id,
    source: "local-cli",
    actor: "louis",
    actorHostId: null
  });
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(["run", "--task", task.id, "--device", "emulator-5554"], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.ok(
    logs.some((line) => line.includes("取消")) || errors.some((line) => line.includes("取消")),
    "明确说明已取消"
  );
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled", "被拒绝的运行不改任务状态");
});
