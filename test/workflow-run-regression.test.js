import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { importTestDocument } from "../dist/workflow/excel-import.js";
import { runRegression } from "../dist/workflow/run-regression.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const LLM_ENTRY = {
  name: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-key"
};

let dirCounter = 0;

function tempPath() {
  dirCounter += 1;
  return path.join(os.tmpdir(), `aos-run-regression-${process.pid}-${dirCounter}`);
}

function stubRuntime(dir = tempPath()) {
  return {
    configDirAbs: dir,
    project: { rootDir: dir, dotenvValues: {} },
    async activeEntry() {
      return LLM_ENTRY;
    }
  };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function importedSet(overrides = {}) {
  return {
    feature: "账户",
    featureKey: "imp-账户-abcd1234",
    stem: "20261017T000000_账户",
    jsonPath: "/p/账户.json",
    mdPath: "/p/账户.md",
    xlsxPath: "/p/账户.xlsx",
    caseCount: 2,
    ...overrides
  };
}

function importResult(overrides = {}) {
  return {
    ok: true,
    status: "imported",
    sourceId: "imported:qa.xlsx@abcd1234",
    sets: [importedSet()],
    sourceCopy: "/p/20261017T000000_qa.xlsx.source.xlsx",
    ...overrides
  };
}

function caseStub(caseId, traceId, overrides = {}) {
  return { caseId, status: "passed", traceId, quarantined: false, ...overrides };
}

function reportStub(overrides = {}) {
  return {
    ok: true,
    total: 2,
    executed: 2,
    passed: 2,
    failed: 0,
    cases: [caseStub("c1", "t1"), caseStub("c2", "t2")],
    testsPath: "/p/a.json",
    error: null,
    ...overrides
  };
}

function batchStub(report, manifestPath) {
  return {
    report,
    startedAtMs: 0,
    coverageIssue: null,
    exitCode: 0,
    quarantinedCaseIds: undefined,
    quarantineMessages: [],
    manifestPath,
    runId: null,
    comparison: null
  };
}

function makeDeps(overrides = {}) {
  const calls = { import: 0, list: 0, execute: [] };
  const deps = {
    calls,
    setup: { chat: async () => "pong" },
    listDevices: async () => [{ serial: "dev-1" }],
    importDocument: async () => {
      calls.import += 1;
      return importResult();
    },
    listSets: async () => {
      calls.list += 1;
      return [];
    },
    executeBatch: async (runtime, request) => {
      calls.execute.push(request);
      return batchStub(reportStub(), "/p/runs/1.json");
    },
    ...overrides
  };
  return { deps, calls };
}

function record(source, createdAt, features) {
  return {
    id: `set-${createdAt}`,
    projectId: null,
    createdAt,
    source,
    designName: null,
    fingerprint: null,
    basename: "basename",
    features
  };
}

function featureRecord(jsonPath, overrides = {}) {
  return {
    key: "feature-key",
    name: "账户",
    caseCount: 2,
    screens: ["账户"],
    jsonPath,
    mdPath: jsonPath.replace(/\.json$/, ".md"),
    xlsxPath: jsonPath.replace(/\.json$/, ".xlsx"),
    ...overrides
  };
}

test("run_regression: excelPath 导入并执行（来源/设备/清单路径回传）", async () => {
  const { deps, calls } = makeDeps();
  const result = await runRegression(stubRuntime(), { excelPath: "qa/cases.xlsx" }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.run.total, 2);
  assert.equal(payload.run.passed, 2);
  assert.equal(payload.run.device, "dev-1");
  assert.equal(payload.artifacts.sets[0].feature, "账户");
  assert.equal(payload.artifacts.sets[0].manifestPath, "/p/runs/1.json");
  assert.ok(payload.steps.some((step) => step.step === "import" && step.status === "imported"));
  assert.equal(payload.steps.find((step) => step.step === "select").mode, "import");
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].source, "run_regression");
  assert.equal(calls.execute[0].options.testsPath, "/p/账户.json");
  assert.equal(calls.execute[0].options.deviceSerial, "dev-1");
});

test("run_regression: 同内容二次导入 skipped 仍执行既有集", async () => {
  const { deps, calls } = makeDeps({
    importDocument: async () => ({ ...importResult(), status: "skipped" })
  });
  const result = await runRegression(stubRuntime(), { excelPath: "qa/cases.xlsx" }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.steps.find((step) => step.step === "import").status, "skipped");
  assert.equal(calls.execute.length, 1);
});

test("run_regression: scope 命中回显功能×条数＋来源（导入自）", async () => {
  const sets = [
    record("imported:qa.xlsx@abcd1234", "2026-10-17T02:00:00.000Z", [
      featureRecord("/p/账户.json", { key: "imp-账户-abcd1234" })
    ]),
    record("figma:abc", "2026-10-17T01:00:00.000Z", [featureRecord("/p/交易.json", { name: "交易" })])
  ];
  const { deps, calls } = makeDeps({ listSets: async () => sets });
  const result = await runRegression(stubRuntime(), { scope: "账户" }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  const select = payload.steps.find((step) => step.step === "select");
  assert.equal(select.mode, "scope");
  assert.deepEqual(select.targets.map((target) => target.feature), ["账户"]);
  assert.ok(select.targets[0].provenance.includes("导入自 qa.xlsx@abcd1234"));
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].options.testsPath, "/p/账户.json");
});

test("run_regression: scope 0 命中 → needs-info（不执行）", async () => {
  const { deps, calls } = makeDeps({
    listSets: async () => [record("figma:abc", "2026-10-17T01:00:00.000Z", [featureRecord("/p/a.json")])]
  });
  const result = await runRegression(stubRuntime(), { scope: "不存在的功能" }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "info");
  assert.ok(payload.questions[0].includes("不存在的功能"));
  assert.equal(calls.execute.length, 0);
});

test("run_regression: 缺省＝库内最新份全量（每 feature 取最新）", async () => {
  const sets = [
    record("figma:new", "2026-10-17T02:00:00.000Z", [featureRecord("/p/new.json")]),
    record("figma:old", "2026-10-17T01:00:00.000Z", [featureRecord("/p/old.json")])
  ];
  const { deps, calls } = makeDeps({ listSets: async () => sets });
  const result = await runRegression(stubRuntime(), {}, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.steps.find((step) => step.step === "select").mode, "all");
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].options.testsPath, "/p/new.json");
  assert.ok(payload.steps.find((step) => step.step === "select").targets[0].provenance.includes("生成自 figma:new"));
});

test("run_regression: excelPath+scope 集内过滤（caseIds 透传）", async () => {
  const dir = tempPath();
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "账户.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      meta: { source: "imported:qa.xlsx@abcd1234" },
      flows: [
        { id: "c1", name: "登录成功" },
        { id: "c2", name: "下单成功" }
      ]
    })
  );
  try {
    const { deps, calls } = makeDeps({
      importDocument: async () => importResult({ sets: [importedSet({ jsonPath })] })
    });
    const result = await runRegression(stubRuntime(dir), { excelPath: "qa/cases.xlsx", scope: "登录" }, deps);
    const payload = payloadOf(result);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(calls.execute.length, 1);
    assert.deepEqual(calls.execute[0].options.caseIds, ["c1"]);
    assert.equal(payload.steps.find((step) => step.step === "select").targets[0].cases, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run_regression: 多集顺序执行并聚合", async () => {
  const sets = [
    record("figma:abc", "2026-10-17T02:00:00.000Z", [
      featureRecord("/p/a.json", { key: "fa", name: "账户" }),
      featureRecord("/p/b.json", { key: "fb", name: "交易" })
    ])
  ];
  const { deps, calls } = makeDeps({ listSets: async () => sets });
  const result = await runRegression(stubRuntime(), { all: true }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(calls.execute.length, 2);
  assert.equal(payload.run.total, 4);
  assert.equal(payload.run.sets, 2);
  assert.equal(payload.artifacts.sets.length, 2);
  assert.deepEqual(payload.artifacts.sets.map((entry) => entry.feature), ["账户", "交易"]);
});

test("run_regression: 无设备 → needs-setup 且未导入/未选择", async () => {
  const { deps, calls } = makeDeps({ listDevices: async () => [] });
  const result = await runRegression(stubRuntime(), { excelPath: "qa/cases.xlsx" }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "setup");
  assert.equal(payload.checks[0].target, "device");
  assert.equal(calls.import, 0);
  assert.equal(calls.list, 0);
  assert.equal(calls.execute.length, 0);
});

test("run_regression: 多设备 → needs-info（不执行）", async () => {
  const { deps, calls } = makeDeps({
    listDevices: async () => [{ serial: "dev-1" }, { serial: "dev-2" }]
  });
  const result = await runRegression(stubRuntime(), {}, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "info");
  assert.ok(payload.questions[0].includes("2 台"));
  assert.equal(calls.execute.length, 0);
});

test("run_regression: 某集未执行（report.ok=false）→ failedStep:run", async () => {
  const { deps } = makeDeps({
    executeBatch: async () =>
      batchStub(reportStub({ ok: false, total: 0, executed: 0, passed: 0, failed: 0, cases: [], error: "设备不可达" }), "/p/runs/1.json")
  });
  const result = await runRegression(stubRuntime(), { excelPath: "qa/cases.xlsx" }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "run");
  assert.ok(payload.detail.includes("设备不可达"));
});

test("run_regression: 同一 Excel 更新后只跑最新份（featureKey 稳定）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  const file = path.join(dir, "cases.xlsx");
  const write = async (rows) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    for (const row of rows) sheet.addRow(row);
    await workbook.xlsx.writeFile(file);
  };
  await write([
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const v1 = await importTestDocument(runtime, { excelPath: file });
  assert.equal(v1.ok, true);
  await write([
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"],
    ["下单", "提交订单", "出现订单号"]
  ]);
  const v2 = await importTestDocument(runtime, { excelPath: file });
  assert.equal(v2.ok, true);
  assert.equal(v2.sets[0].featureKey, v1.sets[0].featureKey);

  const requests = [];
  const result = await runRegression(stubRuntime(dir), {}, {
    setup: { chat: async () => "pong" },
    listDevices: async () => [{ serial: "dev-1" }],
    listSets: () => store.listCaseSets(dir, 10),
    executeBatch: async (runtimeArg, request) => {
      void runtimeArg;
      requests.push(request);
      return batchStub(reportStub(), "/p/runs/latest.json");
    }
  });
  const payload = payloadOf(result);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  const select = payload.steps.find((step) => step.step === "select");
  assert.equal(select.mode, "all");
  assert.equal(select.targets.length, 1, "同一功能只跑最新一份");
  assert.equal(select.targets[0].cases, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.testsPath, v2.sets[0].jsonPath);
});
