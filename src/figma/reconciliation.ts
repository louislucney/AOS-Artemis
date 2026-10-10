import fs from "node:fs";
import path from "node:path";

import {
  confidenceFor,
  isUnconfirmedProvenance,
  resolveProvenance,
  type Provenance
} from "../provenance.js";
import { writeFileAtomic } from "../util.js";
import type { FlowGraph } from "./flows.js";

export const RECONCILIATION_FILE = "reconciliation.json";
export const RECONCILIATION_VERSION = 1;

export type ReconciliationStatus = "pending" | "upgraded";

export interface ReconciliationEdgeEntry {
  from: string;
  to: string;
  /** Design-side provenance first recorded for this edge. */
  designProvenance: Provenance;
  /** Effective provenance (`runtime-observed` once upgraded). */
  provenance: Provenance;
  status: ReconciliationStatus;
  /** Distinct traces whose exploration reached the target (audit trail;
   * kept complete so re-ingesting any of them stays idempotent). */
  traces: string[];
  hits: number;
  lastSeenAt: string | null;
}

export interface ReconciliationAsset {
  version: number;
  updatedAt: string | null;
  edges: ReconciliationEdgeEntry[];
  corrupt?: boolean;
}

export interface EdgeObservation {
  from: string;
  to: string;
  designProvenance: Provenance;
  traceId: string;
  /** True when this run reached the target (hit); false registers the
   * design-side edge as pending evidence (a reconciliation gap). */
  reached: boolean;
}

export interface ExploreStepSignal {
  index: number;
  screen: string;
  provenance: Provenance;
}

function edgeKey(from: string, to: string): string {
  return `${from} → ${to}`;
}

function normalizeEntry(value: unknown): ReconciliationEdgeEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = typeof record.from === "string" ? record.from.trim() : "";
  const to = typeof record.to === "string" ? record.to.trim() : "";
  if (!from || !to) return null;
  const designProvenance = resolveProvenance(record.designProvenance);
  const rawProvenance = resolveProvenance(record.provenance);
  const upgraded =
    record.status === "upgraded" || rawProvenance === "runtime-observed";
  const status: ReconciliationStatus = upgraded ? "upgraded" : "pending";
  const provenance: Provenance = upgraded ? "runtime-observed" : rawProvenance;
  const traces = Array.isArray(record.traces)
    ? record.traces.filter((trace): trace is string => typeof trace === "string")
    : [];
  const hits =
    typeof record.hits === "number" && Number.isFinite(record.hits) && record.hits >= 0
      ? Math.floor(record.hits)
      : traces.length;
  const lastSeenAt = typeof record.lastSeenAt === "string" ? record.lastSeenAt : null;
  return { from, to, designProvenance, provenance, status, traces, hits, lastSeenAt };
}

export function parseReconciliation(text: string): ReconciliationAsset {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; updatedAt?: unknown; edges?: unknown };
    const edges = Array.isArray(parsed.edges)
      ? parsed.edges.map(normalizeEntry).filter((entry): entry is ReconciliationEdgeEntry => entry !== null)
      : [];
    return {
      version: typeof parsed.version === "number" ? parsed.version : RECONCILIATION_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      edges
    };
  } catch {
    return { version: RECONCILIATION_VERSION, updatedAt: null, edges: [] };
  }
}

export function serializeReconciliation(asset: ReconciliationAsset): string {
  const edges = [...asset.edges]
    .map(normalizeEntry)
    .filter((entry): entry is ReconciliationEdgeEntry => entry !== null)
    .sort((a, b) => edgeKey(a.from, a.to).localeCompare(edgeKey(b.from, b.to)));
  return (
    JSON.stringify(
      {
        version:
          typeof asset.version === "number" && asset.version > 0
            ? asset.version
            : RECONCILIATION_VERSION,
        ...(asset.updatedAt ? { updatedAt: asset.updatedAt } : {}),
        edges
      },
      null,
      2
    ) + "\n"
  );
}

export function reconciliationFilePath(configDirAbs: string): string {
  return path.join(configDirAbs, "design", RECONCILIATION_FILE);
}

export function loadReconciliation(configDirAbs: string): ReconciliationAsset {
  const file = reconciliationFilePath(configDirAbs);
  if (!fs.existsSync(file)) return { version: RECONCILIATION_VERSION, updatedAt: null, edges: [] };
  const text = fs.readFileSync(file, "utf-8");
  const asset = parseReconciliation(text);
  const corrupt = text.trim() !== "" && asset.edges.length === 0;
  return corrupt ? { ...asset, corrupt: true } : asset;
}

export function saveReconciliation(configDirAbs: string, asset: ReconciliationAsset): string {
  const file = reconciliationFilePath(configDirAbs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, serializeReconciliation(asset));
  return file;
}

/** Record navigation observations (exploration reached its target). Promotion
 * threshold: one observed traversal upgrades unconfirmed evidence; hard
 * assertions still require the review surface (ticket 09). Re-ingesting the
 * same trace is idempotent. */
export function applyObservations(
  asset: ReconciliationAsset,
  observations: EdgeObservation[],
  at: string
): { asset: ReconciliationAsset; applied: number } {
  const map = new Map(
    asset.edges.map((entry) => [edgeKey(entry.from, entry.to), { ...entry, traces: [...entry.traces] }])
  );
  let applied = 0;
  for (const observation of observations) {
    const key = edgeKey(observation.from, observation.to);
    let entry = map.get(key);
    const created = entry === undefined;
    if (!entry) {
      entry = {
        from: observation.from,
        to: observation.to,
        designProvenance: observation.designProvenance,
        provenance: observation.designProvenance,
        status: "pending",
        traces: [],
        hits: 0,
        lastSeenAt: null
      };
      map.set(key, entry);
      applied += 1;
    }
    if (!observation.reached) continue;
    if (entry.traces.includes(observation.traceId)) continue;
    entry.traces.push(observation.traceId);
    entry.hits += 1;
    entry.lastSeenAt = at;
    if (entry.status === "pending" && isUnconfirmedProvenance(entry.designProvenance)) {
      entry.status = "upgraded";
      entry.provenance = "runtime-observed";
    }
    if (!created) applied += 1;
  }
  if (applied === 0) return { asset, applied: 0 };
  return {
    asset: {
      version: RECONCILIATION_VERSION,
      updatedAt: at,
      edges: [...map.values()].sort((a, b) => edgeKey(a.from, a.to).localeCompare(edgeKey(b.from, b.to)))
    },
    applied
  };
}

/** Overlay upgraded edges onto a flow graph for the next generation: only
 * unconfirmed (inferred/legacy) edges can be promoted to runtime-observed. */
export function applyReconciliationToGraph(
  graph: FlowGraph,
  asset: ReconciliationAsset
): { graph: FlowGraph; upgradedEdges: number } {
  const upgraded = new Set(
    asset.edges
      .filter((entry) => entry.status === "upgraded")
      .map((entry) => edgeKey(entry.from, entry.to))
  );
  if (upgraded.size === 0) return { graph, upgradedEdges: 0 };
  let count = 0;
  const edges = graph.edges.map((edge) => {
    if (!edge.to || !upgraded.has(edgeKey(edge.from.name, edge.to.name))) return edge;
    if (!isUnconfirmedProvenance(resolveProvenance(edge.provenance))) return edge;
    count += 1;
    return {
      ...edge,
      provenance: "runtime-observed" as const,
      confidence: confidenceFor("runtime-observed")
    };
  });
  if (count === 0) return { graph, upgradedEdges: 0 };
  return { graph: { ...graph, edges }, upgradedEdges: count };
}

/** Exploration hit indexes recorded by the iOS executor (step.scriptHits). */
export function hitsFromRunSteps(run: unknown): number[] {
  if (!run || typeof run !== "object" || Array.isArray(run)) return [];
  const steps = (run as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const hits = new Set<number>();
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const scriptHits = (step as { scriptHits?: unknown }).scriptHits;
    if (!Array.isArray(scriptHits)) continue;
    for (const hit of scriptHits) {
      if (typeof hit === "number" && Number.isFinite(hit)) hits.add(Math.floor(hit));
    }
  }
  return [...hits].sort((a, b) => a - b);
}

/** Ingest one case's exploration observations into the durable asset.
 * Returns the number of newly applied observations (0 = nothing new). */
export function ingestExplorationObservations(input: {
  configDirAbs: string;
  traceId: string;
  at: string;
  screens: string[];
  exploreSteps: ExploreStepSignal[];
  hitIndexes: number[];
}): number {
  const hitSet = new Set(input.hitIndexes);
  const observations: EdgeObservation[] = [];
  for (const step of input.exploreSteps) {
    // Last occurrence wins: revisited screens (Home → Detail → Home) still map
    // their exploration edge to the step that leads back to the target.
    const position = input.screens.lastIndexOf(step.screen);
    if (position <= 0) continue;
    observations.push({
      from: input.screens[position - 1]!,
      to: step.screen,
      designProvenance: step.provenance,
      traceId: input.traceId,
      reached: hitSet.has(step.index)
    });
  }
  if (observations.length === 0) return 0;
  const current = loadReconciliation(input.configDirAbs);
  const { asset, applied } = applyObservations(current, observations, input.at);
  if (applied > 0) saveReconciliation(input.configDirAbs, asset);
  return applied;
}
