import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function runCli(runtime, args) {
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(args, {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line)
  });
  return { code, logs, errors };
}

async function setupTaskProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  const archiveDir = path.join(runtime.configDirAbs, "design", "case-sets");
  fs.mkdirSync(archiveDir, { recursive: true });
  const older = path.join(archiveDir, "20261010T090000_登录.json");
  const newer = path.join(archiveDir, "20261014T153000_登录.json");
  const other = path.join(archiveDir, "20261014T153000_下单.json");
  for (const file of [older, newer, other]) {
    fs.writeFileSync(file, JSON.stringify({ flows: [] }), "utf-8");
  }
  const paths = (json) => ({
    jsonPath: json,
    mdPath: json.replace(/\.json$/, ".md"),
    xlsxPath: json.replace(/\.json$/, ".xlsx")
  });
  const oldSet = await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:a.pen",
    basename: "tests",
    createdAt: "2026-10-10T09:00:00.000Z",
    features: [
      { key: "f-登录-aaaa1111", name: "登录流程", caseCount: 1, screens: ["登录"], ...paths(older) }
    ]
  });
  const newSet = await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:a.pen",
    basename: "tests",
    createdAt: "2026-10-14T15:30:00.000Z",
    features: [
      {
        key: "f-登录-aaaa1111",
        name: "登录流程",
        caseCount: 2,
        screens: ["登录", "登录-验证"],
        ...paths(newer)
      }
    ]
  });
  const otherSet = await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:b.pen",
    basename: "tests",
    createdAt: "2026-10-14T15:30:00.000Z",
    features: [
      { key: "f-下单-bbbb2222", name: "下单流程", caseCount: 3, screens: ["下单"], ...paths(other) }
    ]
  });
  return { dir, runtime, store, older, newer, other, oldSet, newSet, otherSet };
}

test("suite task create: 解析最新份并落库", async () => {
  const { runtime, store, newer, newSet } = await setupTaskProject();
  const { code, logs } = await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111"]);
  assert.equal(code, 0);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "pending");
  assert.deepEqual(tasks[0].platforms, ["ios", "android"]);
  assert.equal(tasks[0].baseline, "latest");
  assert.deepEqual(tasks[0].refs, [{ caseSetId: newSet.id, featureKey: "f-登录-aaaa1111" }]);
  assert.ok(logs.some((line) => line.includes("登录流程")));
  assert.ok(logs.some((line) => line.includes(newer)));
});

test("suite task create: 未知 key → exit 2 且列出可用 key", async () => {
  const { runtime } = await setupTaskProject();
  const { code, errors } = await runCli(runtime, ["task", "create", "--ref", "f-不存在"]);
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("未知 feature key")));
  assert.ok(errors.some((line) => line.includes("f-登录-aaaa1111")));
  assert.ok(errors.some((line) => line.includes("f-下单-bbbb2222")));
});

test("suite task create: --platform 覆盖默认；--ref 逗号分隔", async () => {
  const { runtime, store } = await setupTaskProject();
  const { code } = await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111,f-下单-bbbb2222",
    "--platform",
    "ios"
  ]);
  assert.equal(code, 0);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].platforms, ["ios"]);
  assert.equal(tasks[0].refs.length, 2);
});

test("suite task list/show: 输出状态、解析路径与运行列表", async () => {
  const { runtime, store, newer } = await setupTaskProject();
  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);

  const list = await runCli(runtime, ["task", "list"]);
  assert.equal(list.code, 0);
  assert.ok(list.logs.some((line) => line.includes(tasks[0].id)));
  assert.ok(list.logs.some((line) => line.includes("pending")));

  const show = await runCli(runtime, ["task", "show", tasks[0].id]);
  assert.equal(show.code, 0);
  assert.ok(show.logs.some((line) => line.includes("登录流程")));
  assert.ok(show.logs.some((line) => line.includes(newer)));

  const missing = await runCli(runtime, ["task", "show", "task-nope"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("未找到回归任务")));
});
