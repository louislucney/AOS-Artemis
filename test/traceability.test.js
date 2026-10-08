import assert from "node:assert/strict";
import test from "node:test";

import { buildTraceability } from "../dist/figma/traceability.js";

test("buildTraceability: screens/edges mapped to cases, traces and evidence", () => {
  const report = buildTraceability({
    screenNames: ["Home", "Checkout", "Success"],
    edges: [
      { from: "Home", to: "Checkout" },
      { from: "Checkout", to: "Success" },
      { from: "Success", to: "Success" }
    ],
    cases: [
      {
        id: "case-1",
        name: "Home → Checkout",
        screens: ["Home", "Checkout"],
        traceId: "trace-1",
        hasEvidence: true
      },
      {
        id: "case-2",
        name: "Home → Checkout → Success",
        screens: ["Home", "Checkout", "Success"],
        traceId: "trace-2",
        hasEvidence: false
      }
    ]
  });

  const home = report.screens.find((entry) => entry.screen === "Home");
  assert.deepEqual(home.caseIds, ["case-1", "case-2"]);
  assert.deepEqual(home.traceIds, ["trace-1", "trace-2"]);
  assert.deepEqual(report.uncoveredScreens, []);
  assert.deepEqual(
    report.edges.map((entry) => [entry.edge, entry.caseIds.length]),
    [
      ["Home → Checkout", 2],
      ["Checkout → Success", 1]
    ],
    "self transitions are excluded from the edge matrix"
  );
  assert.deepEqual(report.uncoveredEdges, []);
  assert.deepEqual(report.casesWithoutTrace, []);
  assert.deepEqual(report.casesWithoutEvidence, ["case-2"]);
});

test("buildTraceability: uncovered design and missing traces are flagged", () => {
  const report = buildTraceability({
    screenNames: ["Home", "Orphan"],
    edges: [{ from: "Orphan", to: "Home" }],
    cases: [{ id: "case-1", name: "Home", screens: ["Home"], traceId: null, hasEvidence: false }]
  });
  assert.deepEqual(report.uncoveredScreens, ["Orphan"]);
  assert.deepEqual(report.uncoveredEdges, ["Orphan → Home"]);
  assert.deepEqual(report.casesWithoutTrace, ["case-1"]);
  assert.deepEqual(
    report.casesWithoutEvidence,
    [],
    "cases without trace are reported once, not double-counted as missing evidence"
  );
});
