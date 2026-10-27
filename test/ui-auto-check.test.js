import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { autoCheckUi } from "../dist/ui/auto-check.js";
import { summarizeUi, summarizeUiCoverage } from "../dist/ui/verification.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function writeDesign(dir) {
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(path.join(design, "pen", "screens"), { recursive: true });
  fs.writeFileSync(
    path.join(design, "ui-contract.json"),
    JSON.stringify({ schemaVersion: 1, screens: [] }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        { id: "s1", name: "首頁", suggestedRoute: "/", childNames: [], textHints: [{ text: "首頁", textClass: "runtime-text" }] }
      ],
      edges: [],
      entryScreens: ["s1"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  fs.writeFileSync(path.join(design, "pen", "screens", "s1.pen"), "{}", "utf-8");
}

function writeTrace(runtime, traceId) {
  const dir = runtime.traceDir(traceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      trace_id: traceId,
      status: "completed",
      steps: [{ step: 3, screen: "STBTW 首頁 鄰近門市 行動預點" }]
    }),
    "utf-8"
  );
}

function fakeDiff(bySeverity = { minor: 1 }) {
  return async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          summary: { regions: 1, bySeverity },
          unit: { device: { sourceFormat: "png", lossless: true } },
          saved: { dir: "/tmp/ui-report" }
        })
      }
    ]
  });
}

test("ui auto-check: matched visited screen with PNG source passes", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir);
  const { runtime } = await loadTestRuntime(dir);
  writeTrace(runtime, "ios-t1");
  const ui = await autoCheckUi(
    runtime,
    { traceId: "ios-t1", screens: ["首頁"], deviceSerial: null, maxScreens: 3 },
    { designDeviceDiff: fakeDiff() }
  );
  assert.equal(ui.status, "passed");
  assert.equal(ui.sourceFormat, "png");
  assert.equal(ui.lossless, true);
  assert.equal(ui.regions, 1);
  assert.deepEqual(ui.evidence, ["/tmp/ui-report"]);
  assert.deepEqual(ui.coverage, {
    requested: 1,
    matched: 1,
    compared: 1,
    skipped: 0,
    unmatched: 0,
    comparedScreens: [{ id: "s1", name: "首頁" }],
    skippedScreens: [],
    unmatchedScreens: []
  });
  const coverage = summarizeUiCoverage(
    [{ ui }],
    [
      { id: "s1", name: "首頁" },
      { id: "s2", name: "其他" }
    ]
  );
  assert.deepEqual(coverage, {
    cases: 1,
    requested: 1,
    matched: 1,
    compared: 1,
    skipped: 0,
    unmatched: 0,
    comparedScreens: [{ id: "s1", name: "首頁" }],
    skippedScreens: [],
    unmatchedScreens: [],
    contractScreens: 2,
    contractNotCompared: [{ id: "s2", name: "其他" }]
  });
  assert.equal(
    summarizeUiCoverage([{ ui: { status: "unverified" } }]),
    null,
    "未跑 UI diff 时不伪造覆盖率"
  );
});

test("ui auto-check: text weight styles are report-only aggregate", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir);
  const { runtime } = await loadTestRuntime(dir);
  writeTrace(runtime, "ios-t-text");
  const fake = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          summary: { regions: 0, bySeverity: {} },
          unit: { device: { sourceFormat: "png", lossless: true } },
          detail: {
            textStyles: {
              scope: "contract",
              screenId: "s1",
              textsTotal: 3,
              checked: 2,
              lighter: 0,
              similar: 1,
              heavier: 1,
              highConfidenceHeavier: 1,
              unverified: 1,
              byReason: { "no-geometry": 1 }
            }
          }
        })
      }
    ]
  });
  const ui = await autoCheckUi(
    runtime,
    { traceId: "ios-t-text", screens: ["首頁"], deviceSerial: null, maxScreens: 3 },
    { designDeviceDiff: fake }
  );
  assert.equal(ui.status, "passed");
  assert.deepEqual(ui.textStyles, {
    textsTotal: 3,
    checked: 2,
    lighter: 0,
    similar: 1,
    heavier: 1,
    highConfidenceHeavier: 1,
    unverified: 1,
    byReason: { "no-geometry": 1 }
  });
  assert.deepEqual(summarizeUi([{ ui }]).textStyles, ui.textStyles);
});

test("ui auto-check: blocker difference fails UI", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir);
  const { runtime } = await loadTestRuntime(dir);
  writeTrace(runtime, "ios-t2");
  const ui = await autoCheckUi(
    runtime,
    { traceId: "ios-t2", screens: ["首頁"], deviceSerial: null, maxScreens: 3 },
    { designDeviceDiff: fakeDiff({ blocker: 1 }) }
  );
  assert.equal(ui.status, "failed");
  assert.equal(ui.reason, "auto-diff");
});

test("ui auto-check: screen without per-screen .pen stays unverified", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(path.join(design, "ui-contract.json"), "{}", "utf-8");
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [{ id: "s1", name: "首頁", suggestedRoute: "/", childNames: [], textHints: [] }],
      edges: [],
      entryScreens: ["s1"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir);
  writeTrace(runtime, "ios-t3");
  const ui = await autoCheckUi(
    runtime,
    { traceId: "ios-t3", screens: ["首頁"], deviceSerial: null, maxScreens: 3 },
    { designDeviceDiff: fakeDiff() }
  );
  assert.equal(ui.status, "unverified");
  assert.equal(ui.reason, "no-comparable-screen");
  assert.deepEqual(ui.coverage, {
    requested: 1,
    matched: 1,
    compared: 0,
    skipped: 1,
    unmatched: 0,
    comparedScreens: [],
    skippedScreens: [{ id: "s1", name: "首頁" }],
    unmatchedScreens: []
  });
});

test("ui auto-check: 步骤截图已是 PNG 但缺 lossless 标记仍按无损比对", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir);
  const { runtime } = await loadTestRuntime(dir);
  writeTrace(runtime, "ios-t-png-flag");
  const fake = fakeDiff({ blocker: 1 });
  const ui = await autoCheckUi(
    runtime,
    { traceId: "ios-t-png-flag", screens: ["首頁"], deviceSerial: null, maxScreens: 3 },
    {
      designDeviceDiff: async () => {
        const result = await fake();
        const payload = JSON.parse(result.content[0].text);
        payload.unit = { device: { sourceFormat: "png", lossless: false } };
        return { ...result, content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
    }
  );
  assert.equal(ui.status, "failed");
  assert.equal(ui.reason, "auto-diff");
  assert.equal(ui.lossless, true);
});
