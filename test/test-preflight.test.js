import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import { preflightGeneratedTests } from "../dist/figma/preflight.js";
import { linearizeFlowsWithStats } from "../dist/figma/test-gen.js";

function makeDesignDir({ tests, flows }) {
  const root = makeTempDir("aos-preflight-");
  const designDir = path.join(root, "design");
  fs.mkdirSync(designDir, { recursive: true });
  if (tests !== undefined) fs.writeFileSync(path.join(designDir, "tests.json"), tests);
  if (flows !== undefined) fs.writeFileSync(path.join(designDir, "flows.json"), flows);
  return root;
}

test("preflightGeneratedTests: weak steps, screen/edge coverage, generation stats", () => {
  const tests = JSON.stringify({
    flows: [
      {
        id: "case-1",
        name: "Home → Checkout",
        screens: ["Home", "Checkout"],
        steps: ["点击「Buy now」，验证进入「Checkout」（页面应出现「Pay now」）"]
      },
      {
        id: "case-2",
        name: "Home → Home",
        screens: ["Home"],
        steps: ["点击「Go home」，验证进入「Home」"]
      }
    ],
    generation: { maxFlows: 10, truncated: false, droppedPaths: 0 }
  });
  const flows = JSON.stringify({
    screens: [{ name: "Home" }, { name: "Checkout" }, { name: "Success" }],
    edges: [
      { from: { name: "Home" }, to: { name: "Checkout" } },
      { from: { name: "Checkout" }, to: { name: "Success" } }
    ]
  });
  const configDir = makeDesignDir({ tests, flows });

  const report = preflightGeneratedTests(configDir);
  assert.equal(report.cases, 2);
  assert.deepEqual(report.weakCases, [
    { id: "case-2", name: "Home → Home", weakSteps: [{ index: 0, reason: "缺少可验证断言（目的地屏无文本提示）" }] }
  ]);
  assert.deepEqual(report.coverage.screens.sort(), ["Checkout", "Home"]);
  assert.deepEqual(report.coverage.uncoveredScreens, ["Success"]);
  assert.deepEqual(report.coverage.uncoveredEdges, ["Checkout → Success"]);
  assert.deepEqual(report.generation, { maxFlows: 10, truncated: false, droppedPaths: 0 });
});

test("preflightGeneratedTests: missing or corrupt tests.json returns null; flows optional", () => {
  const missing = makeDesignDir({});
  assert.equal(preflightGeneratedTests(missing), null);

  const corrupt = makeDesignDir({ tests: "{not json" });
  assert.equal(preflightGeneratedTests(corrupt), null);

  const testsOnly = makeDesignDir({
    tests: JSON.stringify({ flows: [{ id: "case-1", name: "A", screens: ["Home"], steps: [] }] })
  });
  const report = preflightGeneratedTests(testsOnly);
  assert.equal(report.cases, 1);
  assert.deepEqual(report.coverage.uncoveredScreens, []);
  assert.deepEqual(report.coverage.uncoveredEdges, []);
  assert.equal(report.generation, null);
});

test("linearizeFlowsWithStats: reports truncation, dropped paths and entry fallback", () => {
  const graph = {
    screens: [
      { id: "s1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
      { id: "s2", name: "A", suggestedRoute: "/a", childNames: [], textHints: [] },
      { id: "s3", name: "B", suggestedRoute: "/b", childNames: [], textHints: [] }
    ],
    edges: [
      {
        from: { id: "s1", name: "Home" },
        to: { id: "s2", name: "A" },
        element: { id: "e1", name: "To A", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE"
      },
      {
        from: { id: "s1", name: "Home" },
        to: { id: "s3", name: "B" },
        element: { id: "e2", name: "To B", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE"
      }
    ],
    entryScreens: ["Home"],
    unresolvedDestinations: []
  };

  const limited = linearizeFlowsWithStats(graph, { maxFlows: 1 });
  assert.equal(limited.paths.length, 1);
  assert.equal(limited.stats.entryFallback, false);
  assert.equal(limited.stats.truncated, true);
  assert.equal(limited.stats.droppedPaths, 1);
  assert.equal(limited.stats.keptPaths, 1);

  const fallback = linearizeFlowsWithStats({ ...graph, entryScreens: [] });
  assert.equal(fallback.stats.entryFallback, true);
  assert.equal(fallback.stats.truncated, false);
});
