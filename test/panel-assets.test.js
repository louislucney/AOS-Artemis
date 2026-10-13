import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectDiskAssets } from "../dist/panel/assets.js";
import { makeTempDir } from "./helpers.js";

const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function crashRecord(overrides = {}) {
  return {
    id: "sig-1",
    kind: "java",
    package: "com.example.app",
    attribution: "process-line",
    exceptionClass: "java.lang.NullPointerException",
    message: "boom",
    rootCauseClass: "java.lang.NullPointerException",
    topFrame: "com.example.app.Main.onCreate",
    signatureBasis: "package+exception+frame",
    source: "crash-buffer",
    deviceSerial: "emulator-5554",
    occurredAt: "2026-10-13T00:00:00.000Z",
    capturedAt: "2026-10-13T00:00:01.000Z",
    occurrences: 3,
    outcomeCounts: { failed: 3 },
    firstSeenAt: "2026-10-13T00:00:00.000Z",
    lastSeenAt: "2026-10-13T01:00:00.000Z",
    traceIds: ["trace-1"],
    ...overrides
  };
}

test("collectDiskAssets: 崩溃/对账/基线/保留期汇总", async () => {
  const root = makeTempDir("aos-panel-assets-");
  const configDir = path.join(root, ".artemis");
  fs.mkdirSync(path.join(configDir, "crashes"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "crashes", "index.json"),
    JSON.stringify({
      version: 1,
      records: [crashRecord(), crashRecord({ id: "sig-2", kind: "anr", occurrences: 1 })]
    }),
    "utf-8"
  );

  fs.mkdirSync(path.join(configDir, "design"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "design", "reconciliation.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-10-13T12:00:00.000Z",
      edges: [
        { from: "主页", to: "门店", direction: "design", status: "upgraded" },
        { from: "主页", to: "结算", direction: "design", status: "pending" },
        { from: "主页", to: "个人", direction: "design", status: "confirmed" },
        { from: "门店", to: "商品详情", direction: "runtime-only", status: "pending" }
      ]
    }),
    "utf-8"
  );

  const hotspotDir = path.join(
    configDir,
    "design",
    "baselines",
    "emulator-5554",
    "case-1",
    "step-2-post"
  );
  fs.mkdirSync(hotspotDir, { recursive: true });
  fs.writeFileSync(
    path.join(hotspotDir, "last-diff.json"),
    JSON.stringify({ regions: [{ category: "color" }, { category: "position-size" }] }),
    "utf-8"
  );

  const oldFile = path.join(configDir, "design", "reports", "run-old.json");
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, "x".repeat(100));
  const oldSeconds = (NOW - 120 * DAY) / 1000;
  fs.utimesSync(oldFile, oldSeconds, oldSeconds);

  const assets = await collectDiskAssets({ configDirAbs: configDir, projectRoot: root, nowMs: NOW });
  assert.deepEqual(assets.warnings, []);

  assert.equal(assets.crashes.total, 2);
  assert.equal(assets.crashes.recent[0].exceptionClass, "java.lang.NullPointerException");
  assert.equal(assets.crashes.recent[0].occurrences, 3);

  assert.equal(assets.reconciliation.present, true);
  assert.equal(assets.reconciliation.edges, 4);
  assert.deepEqual(assets.reconciliation.byStatus, {
    pending: 2,
    upgraded: 1,
    confirmed: 1,
    rejected: 0
  });
  assert.equal(assets.reconciliation.runtimeOnly, 1);
  assert.equal(assets.reconciliation.updatedAt, "2026-10-13T12:00:00.000Z");

  assert.equal(assets.baselines.count, 1);
  assert.deepEqual(assets.baselines.hotspots[0], {
    serial: "emulator-5554",
    caseId: "case-1",
    step: 2,
    regions: 2,
    categories: ["color", "position-size"]
  });

  assert.equal(assets.retention.days, 90);
  assert.equal(assets.retention.overdue.count, 1);
  const reports = assets.retention.categories.find((entry) => entry.id === "reports");
  assert.equal(reports.overdue, 1);
});

test("collectDiskAssets: 空项目全空态且无警告", async () => {
  const root = makeTempDir("aos-panel-assets-empty-");
  const assets = await collectDiskAssets({
    configDirAbs: path.join(root, ".artemis"),
    projectRoot: root,
    nowMs: NOW
  });
  assert.equal(assets.crashes.total, 0);
  assert.equal(assets.reconciliation.present, false);
  assert.equal(assets.reconciliation.edges, 0);
  assert.equal(assets.baselines.count, 0);
  assert.equal(assets.retention.overdue.count, 0);
  assert.deepEqual(assets.warnings, []);
});
