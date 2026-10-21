import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { PostgresStore } from "../dist/db/postgres.js";
import { runSuiteCommand } from "../dist/suite-command.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

function throwBuildRuntime() {
  throw new Error("should not build local Runtime");
}

function caseSetFeature(rootPath, featureKey) {
  return {
    key: featureKey,
    name: featureKey.toUpperCase(),
    caseCount: 1,
    screens: [],
    jsonPath: `${rootPath}/${featureKey}.json`,
    mdPath: `${rootPath}/${featureKey}.md`,
    xlsxPath: `${rootPath}/${featureKey}.xlsx`
  };
}

async function seedHostProject(store, hostId, rootPath, featureKey) {
  const scoped = store.scopeHost(hostId);
  await scoped.upsertProject({ rootPath, name: "app" });
  await scoped.recordCaseSet({
    rootPath,
    source: "test",
    basename: "tests",
    features: [caseSetFeature(rootPath, featureKey)]
  });
}

test("suite task create --host h-b 不构建本地 Runtime，定向主机写入", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  await seedHostProject(store, "h-b", "/w/app", "f-1");

  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(
    ["task", "create", "--host", "h-b", "--project", "/w/app", "--ref", "f-1"],
    {
      buildRuntime: throwBuildRuntime,
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
      center: { store }
    }
  );
  assert.equal(code, 0, errors.join("\n"));

  const tasks = await store.scopeHost("h-b").listRegressionTasks("/w/app");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].targetHostId, "h-b");
  assert.equal(tasks[0].createdHostId, "h-b");
  assert.deepEqual(tasks[0].refs, [{ caseSetId: tasks[0].refs[0].caseSetId, featureKey: "f-1" }]);
  assert.equal(tasks[0].refs[0].featureKey, "f-1");
});

test("suite task list --host h-b 只返回 h-b 的任务", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  await store.upsertHost({ id: "h-a", hostname: "mac-a" });

  await seedHostProject(store, "h-b", "/w/app", "f-1");
  const tb = await store.scopeHost("h-b").createRegressionTask({
    rootPath: "/w/app",
    refs: [{ caseSetId: "cs-b", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: "h-b",
    createdHostId: "h-b"
  });

  await seedHostProject(store, "h-a", "/w/app", "f-2");
  const ta = await store.scopeHost("h-a").createRegressionTask({
    rootPath: "/w/app",
    refs: [{ caseSetId: "cs-a", featureKey: "f-2" }],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: "h-a",
    createdHostId: "h-a"
  });

  const logs = [];
  const code = await runSuiteCommand(["task", "list", "--host", "h-b", "--json"], {
    buildRuntime: throwBuildRuntime,
    log: (line) => logs.push(line),
    errorLog: () => {},
    center: { store }
  });
  assert.equal(code, 0);
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].id, tb.id);
  assert.notEqual(payload.tasks[0].id, ta.id);
});

test("suite task create --host 未知主机 → exit 2", async () => {
  const store = await makePgStore();
  const errors = [];
  const code = await runSuiteCommand(
    ["task", "create", "--host", "nope", "--project", "/w/app", "--ref", "f-1"],
    {
      buildRuntime: throwBuildRuntime,
      log: () => {},
      errorLog: (line) => errors.push(line),
      center: { store }
    }
  );
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /未知主机/);
});

test("suite task create --host 无 --project → exit 2", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  const errors = [];
  const code = await runSuiteCommand(["task", "create", "--host", "h-b", "--ref", "f-1"], {
    buildRuntime: throwBuildRuntime,
    log: () => {},
    errorLog: (line) => errors.push(line),
    center: { store }
  });
  assert.equal(code, 2);
});

test("suite task create/list --host 未登记的项目路径 → exit 2", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  await seedHostProject(store, "h-b", "/w/app", "f-1");

  const createErrors = [];
  const create = await runSuiteCommand(
    ["task", "create", "--host", "h-b", "--project", "/w/other", "--ref", "f-1"],
    {
      buildRuntime: throwBuildRuntime,
      log: () => {},
      errorLog: (line) => createErrors.push(line),
      center: { store }
    }
  );
  assert.equal(create, 2);
  assert.match(createErrors.join("\n"), /未知项目/);
  assert.match(createErrors.join("\n"), /\/w\/app/);

  const listErrors = [];
  const list = await runSuiteCommand(["task", "list", "--host", "h-b", "--project", "/w/other"], {
    buildRuntime: throwBuildRuntime,
    log: () => {},
    errorLog: (line) => listErrors.push(line),
    center: { store }
  });
  assert.equal(list, 2);
  assert.match(listErrors.join("\n"), /未知项目/);
});

test("suite task --host 无 PG → exit 2 且提示 MOBILE_TESTING_DATABASE_URL", async () => {
  const errors = [];
  const code = await runSuiteCommand(["task", "list", "--host", "h-b"], {
    buildRuntime: throwBuildRuntime,
    log: () => {},
    errorLog: (line) => errors.push(line),
    env: {},
    center: {}
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /MOBILE_TESTING_DATABASE_URL/);
});

test("suite task create --host 容忍 --project 结尾斜杠", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  await seedHostProject(store, "h-b", "/w/app", "f-1");
  const errors = [];
  const code = await runSuiteCommand(
    ["task", "create", "--host", "h-b", "--project", "/w/app/", "--ref", "f-1"],
    {
      buildRuntime: throwBuildRuntime,
      log: () => {},
      errorLog: (line) => errors.push(line),
      center: { store }
    }
  );
  assert.equal(code, 0, errors.join("\n"));
  const tasks = await store.scopeHost("h-b").listRegressionTasks("/w/app");
  assert.equal(tasks.length, 1);
});

test("suite task --host 关闭 openStore 打开的存储", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  await seedHostProject(store, "h-b", "/w/app", "f-1");
  let closed = false;
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          closed = true;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const code = await runSuiteCommand(["task", "list", "--host", "h-b"], {
    buildRuntime: throwBuildRuntime,
    log: () => {},
    errorLog: () => {},
    center: { openStore: async () => proxy }
  });
  assert.equal(code, 0);
  assert.equal(closed, true);
});

