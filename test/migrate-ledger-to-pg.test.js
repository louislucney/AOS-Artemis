import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { migrateLedgerToPg, readLedger } from "../scripts/migrate-ledger-to-pg.mjs";
import { makeTempDir } from "./helpers.js";

function writeLedger(dir, { usageLines, regressionTasks }) {
  const ledgerDir = path.join(dir, ".artemis", "ledger");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, "usage.jsonl"), usageLines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(
    path.join(ledgerDir, "state.json"),
    JSON.stringify({ v: 1, state: { regressionTasks } }, null, 2),
    "utf-8"
  );
}

function fakeDb({ projectId = "new-project", existingUsage = [], existingTasks = [], projectRows } = {}) {
  const calls = [];
  const insertedUsage = new Set(existingUsage);
  const insertedTasks = new Set(existingTasks);
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT id, name, root_path FROM projects")) {
      return { rows: projectRows ?? [{ id: projectId, name: "starbuckstw", root_path: "" }] };
    }
    if (sql.startsWith("SELECT id FROM usage_events")) {
      return { rows: (params?.[0] ?? []).filter((id) => insertedUsage.has(id)).map((id) => ({ id })) };
    }
    if (sql.startsWith("SELECT id FROM regression_tasks")) {
      return { rows: (params?.[0] ?? []).filter((id) => insertedTasks.has(id)).map((id) => ({ id })) };
    }
    if (sql.startsWith("INSERT INTO usage_events")) {
      if (insertedUsage.has(params[0])) return { rows: [] };
      insertedUsage.add(params[0]);
      return { rows: [{ id: params[0] }] };
    }
    if (sql.startsWith("INSERT INTO regression_tasks")) {
      if (insertedTasks.has(params[0])) return { rows: [] };
      insertedTasks.add(params[0]);
      return { rows: [{ id: params[0] }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, calls, insertedUsage, insertedTasks };
}

const USAGE = [
  {
    id: "u1",
    projectId: "old-project",
    at: "2026-10-19T07:07:51.375Z",
    tool: "project_archive",
    family: "workflow",
    ok: true,
    durationMs: 6,
    errorClass: null,
    errorSummary: null,
    signals: [{ code: "step-ms:extract", field: "1" }],
    argKeys: [],
    traceId: null
  },
  {
    id: "u2",
    projectId: "old-project",
    at: "2026-10-19T07:08:51.375Z",
    tool: "mobile_get_device_state",
    family: "device",
    ok: false,
    durationMs: 10,
    errorClass: "timeout",
    errorSummary: "timeout",
    signals: [],
    argKeys: ["view_type"],
    traceId: "t1"
  }
];

const TASK = {
  id: "t1",
  projectId: "old-project",
  createdAt: "2026-10-19T11:28:30.419Z",
  createdBy: "cli",
  refs: [{ caseSetId: "cs1", featureKey: "f-login" }],
  platforms: ["ios", "android"],
  baseline: "latest",
  status: "pending",
  claimedBy: null,
  claimedAt: null,
  attempts: 0,
  runIds: []
};

test("readLedger: 解析 usage.jsonl 与 state.json，坏行只告警", () => {
  const dir = makeTempDir("aos-migrate-");
  writeLedger(dir, {
    usageLines: [JSON.stringify(USAGE[0]), "{bad json", JSON.stringify(USAGE[1])],
    regressionTasks: [TASK]
  });
  const ledger = readLedger(dir);
  assert.equal(ledger.usage.length, 2);
  assert.equal(ledger.regressionTasks.length, 1);
  assert.deepEqual(ledger.legacyProjectIds, ["old-project"]);
  assert.ok(ledger.warnings.some((warning) => warning.includes("不是合法 JSON")));
});

test("migrate: dry-run 只报告，不写库", async () => {
  const dir = makeTempDir("aos-migrate-");
  writeLedger(dir, { usageLines: USAGE.map((entry) => JSON.stringify(entry)), regressionTasks: [TASK] });
  const db = fakeDb({ projectRows: [{ id: "new-project", name: "starbuckstw", root_path: dir }], existingUsage: ["u1"] });
  const report = await migrateLedgerToPg({ projectDir: dir, query: db.query, dryRun: true });
  assert.equal(report.project.id, "new-project");
  assert.deepEqual(report.legacyProjectIds, ["old-project"]);
  assert.equal(report.usage.total, 2);
  assert.equal(report.usage.existing, 1);
  assert.equal(report.usage.wouldInsert, 1);
  assert.equal(report.usage.inserted, 0);
  assert.equal(report.regressionTasks.wouldInsert, 1);
  assert.equal(report.regressionTasks.inserted, 0);
  assert.equal(db.calls.filter((call) => call.sql.startsWith("INSERT")).length, 0);
});

test("migrate: --write 按目标项目 id 幂等插入", async () => {
  const dir = makeTempDir("aos-migrate-");
  writeLedger(dir, { usageLines: USAGE.map((entry) => JSON.stringify(entry)), regressionTasks: [TASK] });
  const db = fakeDb({ projectRows: [{ id: "new-project", name: "starbuckstw", root_path: dir }], existingUsage: ["u1"] });
  const report = await migrateLedgerToPg({ projectDir: dir, query: db.query, dryRun: false });
  assert.equal(report.usage.inserted, 1);
  assert.equal(report.regressionTasks.inserted, 1);
  const usageInsert = db.calls.find((call) => call.sql.startsWith("INSERT INTO usage_events"));
  assert.equal(usageInsert.params[1], "new-project", "旧 projectId 重映射为目标 id");
  assert.equal(usageInsert.params[0], "u2");
  assert.deepEqual(JSON.parse(usageInsert.params[10]), ["view_type"]);
  const taskInsert = db.calls.find((call) => call.sql.startsWith("INSERT INTO regression_tasks"));
  assert.equal(taskInsert.params[1], "new-project");
  assert.deepEqual(JSON.parse(taskInsert.params[5]), ["ios", "android"]);

  const second = await migrateLedgerToPg({ projectDir: dir, query: db.query, dryRun: false });
  assert.equal(second.usage.inserted, 0);
  assert.equal(second.regressionTasks.inserted, 0);
});

test("migrate: PG 无对应 root_path 时显式失败", async () => {
  const dir = makeTempDir("aos-migrate-");
  writeLedger(dir, { usageLines: [JSON.stringify(USAGE[0])], regressionTasks: [] });
  const db = fakeDb({ projectRows: [] });
  await assert.rejects(
    () => migrateLedgerToPg({ projectDir: dir, query: db.query, dryRun: true }),
    /PG 中没有 root_path/
  );
});
