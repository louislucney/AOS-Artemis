import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readAndroidTraceObservations } from "../dist/artemis/android-trace.js";
import { MemoryStore } from "../dist/db/memory.js";
import { loadReconciliation } from "../dist/figma/reconciliation.js";
import { runGeneratedTests } from "../dist/figma/suite-runner.js";
import { baseConfig, loadTestRuntime, makeTempProject, SuiteProxy } from "./helpers.js";

const sqlite = await import("node:sqlite").catch(() => null);
const sqliteSkip = sqlite ? false : "node:sqlite unavailable (Node < 22.5)";

function makeArtemisDb(dbPath, traceId) {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE steps (
    step_id TEXT PRIMARY KEY,
    session_id TEXT,
    step_number INTEGER,
    timestamp REAL,
    pre_image_name TEXT,
    post_image_name TEXT,
    summary TEXT,
    action_taken TEXT,
    operator_raw_thinking TEXT,
    operator_native_thinking TEXT,
    last_execution_result TEXT,
    extra_metadata TEXT
  )`);
  db.exec(`CREATE TABLE images (
    image_name TEXT PRIMARY KEY,
    timestamp REAL,
    ocr_result TEXT,
    ui_tree TEXT,
    extra_metadata TEXT
  )`);
  const insertStep = db.prepare(
    "INSERT INTO steps (step_id, session_id, step_number, pre_image_name, post_image_name, action_taken) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insertStep.run(
    "s1",
    traceId,
    1,
    "img1",
    "img2",
    JSON.stringify({ action: "tap", coordinates: [500, 800], coordinate_space: "normalized", args: {} })
  );
  insertStep.run(
    "s2",
    traceId,
    2,
    "img2",
    "img3",
    JSON.stringify({ action: "swipe", coordinates: [600, 700, 600, 300], coordinate_space: "normalized", args: {} })
  );
  insertStep.run(
    "s3",
    traceId,
    3,
    null,
    null,
    JSON.stringify({ action: "tap", coordinates: [100, 200], args: {} })
  );
  const insertImage = db.prepare("INSERT INTO images (image_name, ocr_result) VALUES (?, ?)");
  insertImage.run("img1", JSON.stringify([{ text: "首頁" }, { text: "門市列表" }]));
  insertImage.run("img2", JSON.stringify([{ text: "門市列表" }]));
  insertImage.run("img3", JSON.stringify([{ text: "首頁" }]));
  db.close();
}

test("android trace: reads OCR labels and normalized taps from data_engine.db", { skip: sqliteSkip }, async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const dbPath = path.join(dir, ".artemis", "traces", "data_engine.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  makeArtemisDb(dbPath, "trace-1");

  const observations = await readAndroidTraceObservations(dbPath, "trace-1");
  assert.ok(observations);
  assert.equal(observations.steps.length, 3);
  assert.deepEqual([...observations.labels].sort(), ["門市列表", "首頁"].sort());
  assert.deepEqual(
    observations.taps,
    [{ relX: 0.5, relY: 0.8 }],
    "only taps carrying the normalized coordinate space count"
  );
  assert.equal(observations.steps[0].action, "tap");
  assert.deepEqual(observations.steps[0].preLabels, ["首頁", "門市列表"]);
  assert.deepEqual(observations.steps[0].postLabels, ["門市列表"]);
  assert.deepEqual(observations.transitions, [
    { fromLabels: ["首頁", "門市列表"], toLabels: ["門市列表"] },
    { fromLabels: ["門市列表"], toLabels: ["首頁"] }
  ]);

  assert.equal(await readAndroidTraceObservations(dbPath, "unknown-trace"), null);
  assert.equal(await readAndroidTraceObservations(path.join(dir, "missing.db"), "trace-1"), null);
});

test("android trace: schema 漂移（缺列/缺表）→ 明确降级为 null", { skip: sqliteSkip }, async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const tracesDir = path.join(dir, ".artemis", "traces");
  fs.mkdirSync(tracesDir, { recursive: true });

  const missingColumn = path.join(tracesDir, "missing-column.db");
  const db1 = new sqlite.DatabaseSync(missingColumn);
  db1.exec(`CREATE TABLE steps (
    session_id TEXT,
    step_number INTEGER,
    action_taken TEXT,
    pre_image_name TEXT
  )`);
  db1.exec(`CREATE TABLE images (image_name TEXT, ocr_result TEXT)`);
  db1.close();
  assert.equal(await readAndroidTraceObservations(missingColumn, "trace-1"), null);

  const missingTable = path.join(tracesDir, "missing-table.db");
  const db2 = new sqlite.DatabaseSync(missingTable);
  db2.exec(`CREATE TABLE steps (
    session_id TEXT,
    step_number INTEGER,
    action_taken TEXT,
    pre_image_name TEXT,
    post_image_name TEXT
  )`);
  db2.close();
  assert.equal(await readAndroidTraceObservations(missingTable, "trace-1"), null);
});

test(
  "suite runner: Android traces feed reconciliation and element discovery",
  { skip: sqliteSkip },
  async () => {
    const dir = makeTempProject({ config: baseConfig() });
    const designDir = path.join(dir, ".artemis", "design");
    fs.mkdirSync(designDir, { recursive: true });
    fs.writeFileSync(
      path.join(designDir, "tests.json"),
      JSON.stringify({
        flows: [
          {
            id: "case-1",
            name: "Case 1",
            screens: ["首頁", "選擇門市"],
            steps: ["探索到达「選擇門市」（来源未确认）"],
            preconditions: [],
            taskDesc: "run android case 1",
            expectations: [
              { index: 1, screen: "選擇門市", hints: [], provenance: "inferred", confidence: "low", kind: "explore" },
              { index: 2, screen: "首頁", hints: ["首頁"], provenance: "explicit", confidence: "high", kind: "assert" }
            ]
          }
        ]
      })
    );
    fs.writeFileSync(
      path.join(designDir, "flows.json"),
      JSON.stringify({
        screens: [
          {
            id: "s1",
            name: "首頁",
            suggestedRoute: "/",
            childNames: [],
            textHints: [
              {
                text: "首頁",
                textClass: "runtime-text",
                nodeId: "n-home",
                bounds: { x: 0, y: 900, width: 200, height: 40 }
              }
            ],
            bounds: { x: 0, y: 0, width: 390, height: 844 },
            provenance: "explicit",
            confidence: "high"
          },
          {
            id: "s2",
            name: "選擇門市",
            suggestedRoute: "/store",
            childNames: [],
            textHints: [{ text: "門市列表", textClass: "runtime-text" }],
            bounds: { x: 0, y: 0, width: 390, height: 844 },
            provenance: "inferred",
            confidence: "low"
          }
        ],
        edges: [],
        entryScreens: ["首頁"],
        unresolvedDestinations: []
      })
    );
    const dbPath = path.join(dir, ".artemis", "traces", "data_engine.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    makeArtemisDb(dbPath, "trace-1");

    const proxy = new SuiteProxy({
      statuses: { "trace-1": { status: "completed", device_serial: "emulator-5554" } }
    });
    const crashCollector = { collect: async () => ({ status: "skipped", reason: "disabled" }) };
    const { runtime } = await loadTestRuntime(dir, {
      proxy,
      store: new MemoryStore(),
      crashCollector
    });
    runtime.proxy = proxy;

    const report = await runGeneratedTests(runtime, {
      deviceSerial: "emulator-5554",
      reset: async (request) => ({
        ok: true,
        serial: request.serial ?? null,
        adb: { path: null, source: "missing" },
        commands: []
      }),
      sleep: async () => {},
      pollIntervalMs: 0,
      apiErrors: false
    });
    assert.equal(report.passed, 1, JSON.stringify(report.cases));

    const reconciliation = loadReconciliation(runtime.configDirAbs);
    const upgraded = reconciliation.edges.find((entry) => entry.to === "選擇門市");
    assert.ok(upgraded, "an OCR label matching the target screen's design text upgrades the edge");
    assert.equal(upgraded.status, "upgraded");
    assert.equal(upgraded.from, "首頁");

    const reverse = reconciliation.edges.find(
      (entry) => entry.direction === "runtime-only" && entry.from === "選擇門市"
    );
    assert.ok(reverse, "an observed transition without a design counterpart becomes a runtime-only entry");
    assert.equal(reverse.to, "首頁");
    assert.equal(reverse.status, "pending");

    const screenMap = JSON.parse(
      fs.readFileSync(path.join(designDir, "screen-map.json"), "utf-8")
    );
    assert.equal(screenMap.elements.length, 1);
    assert.equal(screenMap.elements[0].screen, "首頁");
    assert.equal(screenMap.elements[0].text, "首頁");
    assert.equal(screenMap.elements[0].designNodeId, "n-home");
  }
);
