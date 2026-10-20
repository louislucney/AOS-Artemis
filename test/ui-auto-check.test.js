import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { autoCheckUi } from "../dist/ui/auto-check.js";
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
});
