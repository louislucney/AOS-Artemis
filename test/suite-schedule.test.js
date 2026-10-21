import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-登录-aaaa1111",
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: "/x/登录.json",
        mdPath: "/x/登录.md",
        xlsxPath: "/x/登录.xlsx"
      }
    ]
  });
  return { runtime, store };
}

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

test("suite schedule: usage 列出 schedule", async () => {
  const logs = [];
  const code = await runSuiteCommand(["help"], {
    log: (line) => logs.push(line),
    errorLog: () => {}
  });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /suite schedule/);
});

test("suite schedule add：落库（缺省 name=首个 featureKey；平台去重）+ 校验 exit 2", async () => {
  const { runtime, store } = await setup();
  const added = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-登录-aaaa1111",
    "--platform",
    "android",
    "--platform",
    "android",
    "--every",
    "60",
    "--baseline",
    "none"
  ]);
  assert.equal(added.code, 0);
  assert.ok(added.logs.some((line) => line.includes("定时回归")));
  const schedules = await store.listSchedules(runtime.project.rootDir);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].name, "f-登录-aaaa1111");
  assert.deepEqual(schedules[0].platforms, ["android"]);
  assert.equal(schedules[0].everyMinutes, 60);
  assert.equal(schedules[0].baseline, "none");
  assert.equal(schedules[0].enabled, true);
  assert.equal(schedules[0].createdBy, "cli");
  assert.ok(added.logs.some((line) => line.includes(schedules[0].id)));

  const unknownRef = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-不存在",
    "--every",
    "60"
  ]);
  assert.equal(unknownRef.code, 2);
  assert.ok(unknownRef.errors.some((line) => line.includes("f-登录-aaaa1111")));

  const tooFrequent = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-登录-aaaa1111",
    "--every",
    "3"
  ]);
  assert.equal(tooFrequent.code, 2);

  const badPlatform = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-登录-aaaa1111",
    "--every",
    "60",
    "--platform",
    "windows"
  ]);
  assert.equal(badPlatform.code, 2);

  const badBaseline = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-登录-aaaa1111",
    "--every",
    "60",
    "--baseline",
    "latestt"
  ]);
  assert.equal(badBaseline.code, 2);

  const noRef = await runCli(runtime, ["schedule", "add", "--every", "60"]);
  assert.equal(noRef.code, 2);

  const named = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-登录-aaaa1111",
    "--every",
    "120",
    "--name",
    "夜间"
  ]);
  assert.equal(named.code, 0);
  const dup = await runCli(runtime, [
    "schedule",
    "add",
    "--ref",
    "f-登录-aaaa1111",
    "--every",
    "60",
    "--name",
    "夜间"
  ]);
  assert.equal(dup.code, 2);
  assert.ok(dup.errors.some((line) => line.includes("同名")));
});

test("suite schedule list/show：文本与 --json；未知 id → exit 2", async () => {
  const { runtime, store } = await setup();
  await runCli(runtime, ["schedule", "add", "--ref", "f-登录-aaaa1111", "--every", "120", "--name", "夜间"]);
  const schedule = (await store.listSchedules(runtime.project.rootDir))[0];

  const list = await runCli(runtime, ["schedule", "list"]);
  assert.equal(list.code, 0);
  assert.ok(list.logs.some((line) => line.includes(`夜间`)));
  assert.ok(list.logs.some((line) => line.includes(`120`)));
  assert.ok(list.logs.some((line) => line.includes("enabled")));

  const json = await runCli(runtime, ["schedule", "list", "--json"]);
  const payload = JSON.parse(json.logs.join("\n"));
  assert.equal(payload.ok, true);
  assert.equal(payload.schedules[0].id, schedule.id);

  const show = await runCli(runtime, ["schedule", "show", schedule.id]);
  assert.equal(show.code, 0);
  assert.ok(show.logs.some((line) => line.includes(schedule.id)));

  const missing = await runCli(runtime, ["schedule", "show", "sched-nope"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("未找到")));
});

test("suite schedule enable/disable/remove：幂等提示、状态变化与删除", async () => {
  const { runtime, store } = await setup();
  await runCli(runtime, ["schedule", "add", "--ref", "f-登录-aaaa1111", "--every", "60"]);
  const schedule = (await store.listSchedules(runtime.project.rootDir))[0];

  const disabled = await runCli(runtime, ["schedule", "disable", schedule.id]);
  assert.equal(disabled.code, 0);
  assert.equal((await store.getSchedule(runtime.project.rootDir, schedule.id)).enabled, false);

  const again = await runCli(runtime, ["schedule", "disable", schedule.id]);
  assert.equal(again.code, 0);
  assert.ok(again.logs.some((line) => line.includes("已是")));

  const enabled = await runCli(runtime, ["schedule", "enable", schedule.id]);
  assert.equal(enabled.code, 0);
  assert.equal((await store.getSchedule(runtime.project.rootDir, schedule.id)).enabled, true);

  const removed = await runCli(runtime, ["schedule", "remove", schedule.id]);
  assert.equal(removed.code, 0);
  assert.equal(await store.getSchedule(runtime.project.rootDir, schedule.id), null);

  const missing = await runCli(runtime, ["schedule", "remove", schedule.id]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("未找到")));
});
