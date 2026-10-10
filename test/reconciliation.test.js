import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  applyObservations,
  applyReconciliationToGraph,
  hitsFromRunSteps,
  ingestExplorationObservations,
  loadReconciliation,
  parseReconciliation,
  reconciliationFilePath,
  serializeReconciliation
} from "../dist/figma/reconciliation.js";
import { makeTempDir } from "./helpers.js";

test("reconciliation: observations create, count and idempotently upgrade unconfirmed edges", () => {
  const empty = { version: 1, updatedAt: null, edges: [] };
  const observation = {
    from: "首頁",
    to: "選擇門市",
    designProvenance: "inferred",
    traceId: "t1",
    reached: true
  };

  const first = applyObservations(empty, [observation], "2026-10-10T00:00:00.000Z");
  assert.equal(first.applied, 1);
  assert.equal(first.asset.edges.length, 1);
  const entry = first.asset.edges[0];
  assert.equal(entry.status, "upgraded");
  assert.equal(entry.provenance, "runtime-observed");
  assert.equal(entry.hits, 1);
  assert.deepEqual(entry.traces, ["t1"]);

  const again = applyObservations(first.asset, [observation], "2026-10-10T00:01:00.000Z");
  assert.equal(again.applied, 0, "re-ingesting the same trace is idempotent");
  assert.equal(again.asset.edges[0].hits, 1);

  const second = applyObservations(
    first.asset,
    [{ ...observation, traceId: "t2" }],
    "2026-10-10T00:02:00.000Z"
  );
  assert.equal(second.applied, 1);
  assert.equal(second.asset.edges[0].hits, 2);
  assert.deepEqual(second.asset.edges[0].traces, ["t1", "t2"]);
});

test("reconciliation: un-reached observations register pending gaps", () => {
  const result = applyObservations(
    { version: 1, updatedAt: null, edges: [] },
    [{ from: "A", to: "B", designProvenance: "inferred", traceId: "t1", reached: false }],
    "2026-10-10T00:00:00.000Z"
  );
  assert.equal(result.applied, 1);
  assert.equal(result.asset.edges[0].status, "pending");
  assert.equal(result.asset.edges[0].provenance, "inferred");
  assert.equal(result.asset.edges[0].hits, 0);
  assert.deepEqual(result.asset.edges[0].traces, []);

  const replay = applyObservations(result.asset, [
    { from: "A", to: "B", designProvenance: "inferred", traceId: "t1", reached: false }
  ], "2026-10-10T00:01:00.000Z");
  assert.equal(replay.applied, 0, "pending gaps are idempotent too");
});

test("reconciliation: pending gaps upgrade once the edge is reached later", () => {
  const pending = applyObservations(
    { version: 1, updatedAt: null, edges: [] },
    [{ from: "A", to: "B", designProvenance: "inferred", traceId: "t1", reached: false }],
    "2026-10-10T00:00:00.000Z"
  ).asset;
  assert.equal(pending.edges[0].status, "pending");

  const upgraded = applyObservations(
    pending,
    [{ from: "A", to: "B", designProvenance: "inferred", traceId: "t2", reached: true }],
    "2026-10-10T00:01:00.000Z"
  );
  assert.equal(upgraded.applied, 1);
  assert.equal(upgraded.asset.edges[0].status, "upgraded");
  assert.equal(upgraded.asset.edges[0].provenance, "runtime-observed");
  assert.equal(upgraded.asset.edges[0].hits, 1);
  assert.deepEqual(upgraded.asset.edges[0].traces, ["t2"]);
});

test("reconciliation: explicit evidence is recorded but never promoted", () => {
  const result = applyObservations(
    { version: 1, updatedAt: null, edges: [] },
    [{ from: "A", to: "B", designProvenance: "explicit", traceId: "t1", reached: true }],
    "2026-10-10T00:00:00.000Z"
  );
  assert.equal(result.asset.edges[0].status, "pending");
  assert.equal(result.asset.edges[0].provenance, "explicit");
});

test("reconciliation: serialize is stable-sorted; parse tolerates corruption", () => {
  const asset = {
    version: 1,
    updatedAt: "2026-10-10T00:00:00.000Z",
    edges: [
      {
        from: "B",
        to: "C",
        designProvenance: "inferred",
        provenance: "runtime-observed",
        status: "upgraded",
        traces: ["t2"],
        hits: 2,
        lastSeenAt: "2026-10-10T00:00:00.000Z"
      },
      {
        from: "A",
        to: "B",
        designProvenance: "inferred",
        provenance: "inferred",
        status: "pending",
        traces: [],
        hits: 0,
        lastSeenAt: null
      }
    ]
  };
  const text = serializeReconciliation(asset);
  const parsed = parseReconciliation(text);
  assert.deepEqual(
    parsed.edges.map((entry) => `${entry.from}→${entry.to}`),
    ["A→B", "B→C"],
    "entries are stable-sorted by edge"
  );
  assert.deepEqual(parseReconciliation(serializeReconciliation(parsed)), parsed, "round-trip deterministic");
  assert.deepEqual(parseReconciliation("not json"), { version: 1, updatedAt: null, edges: [] });
  const dropped = parseReconciliation(
    JSON.stringify({ edges: [{ from: "", to: "X" }, { from: "A", to: "" }, "junk"] })
  );
  assert.equal(dropped.edges.length, 0, "malformed entries are dropped");
});

test("reconciliation: applyReconciliationToGraph promotes only unconfirmed matches", () => {
  const graph = {
    screens: [],
    edges: [
      {
        from: { id: "a", name: "A" },
        to: { id: "b", name: "B" },
        element: { id: "e1", name: "E", type: "INFERRED" },
        textHints: [],
        trigger: "INFERRED",
        actionType: "INFERRED",
        provenance: "inferred",
        confidence: "low"
      },
      {
        from: { id: "a", name: "A" },
        to: { id: "c", name: "C" },
        element: { id: "e2", name: "E2", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE",
        provenance: "explicit",
        confidence: "high"
      }
    ],
    entryScreens: [],
    unresolvedDestinations: []
  };
  const asset = {
    version: 1,
    updatedAt: null,
    edges: [
      {
        from: "A",
        to: "B",
        designProvenance: "inferred",
        provenance: "runtime-observed",
        status: "upgraded",
        traces: ["t1"],
        hits: 1,
        lastSeenAt: null
      },
      {
        from: "A",
        to: "C",
        designProvenance: "explicit",
        provenance: "runtime-observed",
        status: "upgraded",
        traces: ["t1"],
        hits: 1,
        lastSeenAt: null
      }
    ]
  };

  const applied = applyReconciliationToGraph(graph, asset);
  assert.equal(applied.upgradedEdges, 1);
  assert.equal(applied.graph.edges[0].provenance, "runtime-observed");
  assert.equal(applied.graph.edges[0].confidence, "high");
  assert.equal(applied.graph.edges[1].provenance, "explicit", "explicit edges are never rewritten");
});

test("reconciliation: hitsFromRunSteps dedupes and sorts; ingest writes the durable asset idempotently", () => {
  assert.deepEqual(hitsFromRunSteps({ steps: [{ scriptHits: [2, 1] }, { scriptHits: [1] }, {}] }), [1, 2]);
  assert.deepEqual(hitsFromRunSteps(null), []);
  assert.deepEqual(hitsFromRunSteps({ steps: "nope" }), []);

  const dir = makeTempDir("aos-reconciliation-");
  const configDir = path.join(dir, ".artemis");
  const input = {
    configDirAbs: configDir,
    traceId: "ios-abc",
    at: "2026-10-10T00:00:00.000Z",
    screens: ["首頁", "選擇門市"],
    exploreSteps: [{ index: 1, screen: "選擇門市", provenance: "inferred" }],
    hitIndexes: [1]
  };

  assert.equal(ingestExplorationObservations(input), 1);
  assert.ok(fs.existsSync(reconciliationFilePath(configDir)));
  const asset = loadReconciliation(configDir);
  assert.equal(asset.edges.length, 1);
  assert.equal(asset.edges[0].status, "upgraded");
  assert.equal(asset.edges[0].from, "首頁");
  assert.equal(asset.edges[0].to, "選擇門市");

  assert.equal(ingestExplorationObservations(input), 0, "replaying the same trace writes nothing new");
  assert.equal(loadReconciliation(configDir).edges[0].hits, 1);

  const gap = ingestExplorationObservations({
    ...input,
    traceId: "ios-ghi",
    screens: ["首頁", "店員推薦"],
    exploreSteps: [{ index: 2, screen: "店員推薦", provenance: "inferred" }],
    hitIndexes: []
  });
  assert.equal(gap, 1, "an un-reached exploration registers a pending reconciliation gap");
  const pending = loadReconciliation(configDir).edges.find((entry) => entry.to === "店員推薦");
  assert.equal(pending.status, "pending");
  assert.equal(pending.hits, 0);

  const unmapped = ingestExplorationObservations({
    ...input,
    traceId: "ios-def",
    exploreSteps: [{ index: 5, screen: "未知目标", provenance: "inferred" }],
    hitIndexes: [5]
  });
  assert.equal(unmapped, 0, "unmapped targets contribute nothing");
});
