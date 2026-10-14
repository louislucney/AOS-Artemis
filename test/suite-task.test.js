import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject, SuiteProxy } from "./helpers.js";

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

function caseEntry(index, feature) {
  return {
    id: `case-${index}`,
    name: `Case ${index}`,
    screens: ["Home"],
    steps: ["点击「Go」，验证进入「Next」"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: `run case ${index}（【真实数据】须经真实请求链路，禁止伪造页面/假数据）`,
    feature
  };
}

async function setupTaskProject({ statuses = {}, running = true } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const proxy = new SuiteProxy({ statuses, running });
  const crashCollector = { collect: async () => ({ status: "skipped", reason: "disabled" }) };
  const { runtime } = await loadTestRuntime(dir, { proxy, store, crashCollector });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  const archiveDir = path.join(runtime.configDirAbs, "design", "case-sets");
  fs.mkdirSync(archiveDir, { recursive: true });
  const older = path.join(archiveDir, "20261010T090000_登录.json");
  const newer = path.join(archiveDir, "20261014T153000_登录.json");
  const other = path.join(archiveDir, "20261014T153000_下单.json");
  fs.writeFileSync(older, JSON.stringify({ flows: [caseEntry(1, "f-登录-aaaa1111")] }), "utf-8");
  fs.writeFileSync(
    newer,
    JSON.stringify({ flows: [caseEntry(1, "f-登录-aaaa1111"), caseEntry(2, "f-登录-aaaa1111")] }),
    "utf-8"
  );
  fs.writeFileSync(other, JSON.stringify({ flows: [caseEntry(3, "f-下单-bbbb2222")] }), "utf-8");
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
  return { dir, runtime, store, proxy, older, newer, other, oldSet, newSet, otherSet };
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

test("suite run --task: 展开 refs×devices、逐例登记带 task 关联、状态 → completed", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": { status: "completed" },
      "trace-3": { status: "completed" }
    }
  });
  const create = await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111",
    "--ref",
    "f-下单-bbbb2222",
    "--platform",
    "android"
  ]);
  assert.equal(create.code, 0);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  const run = await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);
  assert.equal(run.code, 0);
  const runs = await store.listSuiteRuns(runtime.project.rootDir, { taskId: tasks[0].id });
  assert.equal(runs.length, 2);
  assert.ok(runs.every((entry) => entry.regressionTaskId === tasks[0].id));
  assert.equal(
    runs.reduce((sum, entry) => sum + entry.passed, 0),
    3
  );
  const updated = await store.getRegressionTask(runtime.project.rootDir, tasks[0].id);
  assert.equal(updated.status, "completed");
  assert.equal(updated.runIds.length, 2);
  assert.ok(run.logs.some((line) => line.includes("[android] 登录流程")));
  assert.ok(run.logs.some((line) => line.includes("子集运行不做全图覆盖门禁")));
});

test("suite run --task: 有失败 → 退出码 1、状态 partial、对比含回归", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": { status: "failed", error: "boom" }
    }
  });
  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111", "--platform", "android"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: tasks[0].refs[0].caseSetId,
      featureKey: "f-登录-aaaa1111",
      featureName: "登录流程",
      platform: "android",
      device: null,
      appVersion: null,
      status: "completed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 2,
      passed: 2,
      failed: 0,
      flaky: 0,
      quarantined: 0,
      failureDomains: {},
      gateResult: "pass",
      exitCode: 0,
      manifestPath: null,
      comparison: null
    },
    cases: ["case-1", "case-2"].map((caseId) => ({
      caseId,
      name: `Case ${caseId}`,
      featureKey: "f-登录-aaaa1111",
      platform: "android",
      status: "passed",
      traceId: null,
      failureDomain: null,
      failureConfidence: null,
      failureReason: null,
      durationMs: null,
      quarantined: false,
      flaky: false,
      verdict: null,
      verdictBy: null,
      verdictAt: null,
      verdictNote: null
    }))
  });

  const run = await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);
  assert.equal(run.code, 1);
  const runs = await store.listSuiteRuns(runtime.project.rootDir, { taskId: tasks[0].id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].comparison.regressed, 1);
  assert.ok(run.logs.some((line) => line.includes("回归1")));
  const updated = await store.getRegressionTask(runtime.project.rootDir, tasks[0].id);
  assert.equal(updated.status, "partial");
});

test("suite run --task: 跨份重复 caseId 去重（同设备只跑一次）", async () => {
  const { runtime, store, proxy } = await setupTaskProject({
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": { status: "completed" },
      "trace-3": { status: "completed" }
    }
  });
  const archiveDir = path.join(runtime.configDirAbs, "design", "case-sets");
  const overlapPath = path.join(archiveDir, "20261014T160000_登录补充.json");
  fs.writeFileSync(
    overlapPath,
    JSON.stringify({
      flows: [caseEntry(1, "f-登录-补充-cccc3333"), caseEntry(4, "f-登录-补充-cccc3333")]
    }),
    "utf-8"
  );
  await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:c.pen",
    basename: "tests",
    createdAt: "2026-10-14T16:00:00.000Z",
    features: [
      {
        key: "f-登录-补充-cccc3333",
        name: "登录补充",
        caseCount: 2,
        screens: ["登录"],
        jsonPath: overlapPath,
        mdPath: overlapPath,
        xlsxPath: overlapPath
      }
    ]
  });
  await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111",
    "--ref",
    "f-登录-补充-cccc3333",
    "--platform",
    "android"
  ]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  const run = await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);
  assert.equal(run.code, 0);
  assert.equal(proxy.submitted, 3, "case-1 跨份去重，共提交 3 次");
  assert.ok(run.logs.some((line) => line.includes("去重 1 例")));
});

test("suite run --task: 缺端设备 → 标注该端未执行", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "completed" } }
  });
  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  const run = await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);
  assert.equal(run.code, 0);
  assert.ok(
    run.logs.some((line) => line.includes("ios") && line.includes("未执行")),
    "缺端标注"
  );
});

test("suite run --task: 未知任务/缺设备/与 --tests 互斥 → exit 2", async () => {
  const { runtime, store } = await setupTaskProject();
  const missing = await runCli(runtime, ["run", "--task", "task-nope", "--device", "emulator-5554"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("未找到回归任务")));

  const conflict = await runCli(runtime, [
    "run",
    "--task",
    "task-x",
    "--tests",
    "x.json",
    "--device",
    "d"
  ]);
  assert.equal(conflict.code, 2);
  assert.ok(conflict.errors.some((line) => line.includes("不能同用")));

  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  const noDevice = await runCli(runtime, ["run", "--task", tasks[0].id]);
  assert.equal(noDevice.code, 2);
  assert.ok(noDevice.errors.some((line) => line.includes("--device")));
});

test("suite report --task: 输出 xlsx/junit 两路径且文件存在", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "completed" } }
  });
  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111", "--platform", "android"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);

  const report = await runCli(runtime, ["report", "--task", tasks[0].id]);
  assert.equal(report.code, 0);
  const xlsxLine = report.logs.find((line) => line.startsWith("xlsx: "));
  assert.ok(xlsxLine, "xlsx 路径行");
  const xlsxPath = xlsxLine.slice("xlsx: ".length);
  assert.ok(fs.existsSync(xlsxPath));
  assert.ok(xlsxPath.includes("登录流程"));
  assert.ok(xlsxPath.endsWith("_回归.xlsx"));
  const junitLine = report.logs.find((line) => line.startsWith("junit: "));
  assert.ok(junitLine, "junit 路径行");
  assert.ok(fs.existsSync(junitLine.slice("junit: ".length)));
});

test("suite run --task: --fail-on-uncovered 被忽略并提示", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "completed" } }
  });
  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111", "--platform", "android"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  const run = await runCli(runtime, [
    "run",
    "--task",
    tasks[0].id,
    "--device",
    "emulator-5554",
    "--fail-on-uncovered"
  ]);
  assert.equal(run.code, 0);
  assert.ok(run.logs.some((line) => line.includes("--fail-on-uncovered 在 task 模式忽略")));
});

test("suite run --task: --baseline none 跳过对比并重建基准", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "failed", error: "boom" } }
  });
  await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111",
    "--platform",
    "android",
    "--baseline",
    "none"
  ]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  assert.equal(tasks[0].baseline, "none");
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: tasks[0].refs[0].caseSetId,
      featureKey: "f-登录-aaaa1111",
      featureName: "登录流程",
      platform: "android",
      device: null,
      appVersion: null,
      status: "completed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 2,
      passed: 2,
      failed: 0,
      flaky: 0,
      quarantined: 0,
      failureDomains: {},
      gateResult: "pass",
      exitCode: 0,
      manifestPath: null,
      comparison: null
    },
    cases: ["case-1", "case-2"].map((caseId) => ({
      caseId,
      name: `Case ${caseId}`,
      featureKey: "f-登录-aaaa1111",
      platform: "android",
      status: "passed",
      traceId: null,
      failureDomain: null,
      failureConfidence: null,
      failureReason: null,
      durationMs: null,
      quarantined: false,
      flaky: false,
      verdict: null,
      verdictBy: null,
      verdictAt: null,
      verdictNote: null
    }))
  });

  const run = await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);
  assert.equal(run.code, 1);
  const runs = await store.listSuiteRuns(runtime.project.rootDir, { taskId: tasks[0].id });
  assert.equal(runs[0].comparison.baseline, "established");
  assert.equal(runs[0].comparison.regressed, 0);
  assert.ok(run.logs.some((line) => line.includes("基准建立")));
});

test("suite report --task: 未知任务 → exit 2 且不落盘", async () => {
  const { runtime } = await setupTaskProject();
  const report = await runCli(runtime, ["report", "--task", "task-nope"]);
  assert.equal(report.code, 2);
  assert.ok(report.errors.some((line) => line.includes("未找到回归任务")));
  assert.equal(fs.existsSync(path.join(runtime.configDirAbs, "design", "reports")), false);
});

test("suite run --task: 任务状态回写失败 → 运行结果不受影响", async () => {
  const { runtime, store } = await setupTaskProject({
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": { status: "completed" }
    }
  });
  await runCli(runtime, ["task", "create", "--ref", "f-登录-aaaa1111", "--platform", "android"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);

  store.updateRegressionTask = async () => {
    throw new Error("pg down");
  };
  const run = await runCli(runtime, ["run", "--task", tasks[0].id, "--device", "emulator-5554"]);
  assert.equal(run.code, 0, "运行结果不受状态回写失败影响");
  assert.ok(run.logs.some((line) => line.includes("[android] 登录流程")), "结果摘要行仍在");
  assert.ok(
    run.logs.some((line) => line.includes("注意: 任务状态回写失败（运行结果不受影响）")),
    "回写失败有提示"
  );
  const runs = await store.listSuiteRuns(runtime.project.rootDir, { taskId: tasks[0].id });
  assert.equal(runs.length, 1, "运行仍登记");
});

test("suite task create: 非法 --platform/--baseline → exit 2 不落库", async () => {
  const { runtime, store } = await setupTaskProject();
  const badPlatform = await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111",
    "--platform",
    "windows"
  ]);
  assert.equal(badPlatform.code, 2);
  assert.ok(badPlatform.errors.some((line) => line.includes("非法 --platform")));

  const badBaseline = await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111",
    "--baseline",
    "latestt"
  ]);
  assert.equal(badBaseline.code, 2);
  assert.ok(badBaseline.errors.some((line) => line.includes("非法 --baseline")));

  assert.equal(
    (await store.listRegressionTasks(runtime.project.rootDir)).length,
    0,
    "非法参数不落库"
  );
});

test("suite task create: --platform 去重", async () => {
  const { runtime, store } = await setupTaskProject();
  const { code } = await runCli(runtime, [
    "task",
    "create",
    "--ref",
    "f-登录-aaaa1111",
    "--platform",
    "android",
    "--platform",
    "android"
  ]);
  assert.equal(code, 0);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  assert.deepEqual(tasks[0].platforms, ["android"]);
});
