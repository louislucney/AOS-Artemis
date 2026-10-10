import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  confidenceFor,
  isUnconfirmedProvenance,
  resolveProvenance,
  type Provenance
} from "../provenance.js";
import type { Runtime } from "../runtime.js";
import { writeFileAtomic } from "../util.js";
import { normalizeFlowGraph, normalizeFlowHints, type FlowGraph } from "./flows.js";

export const RECONCILIATION_FILE = "reconciliation.json";
export const RECONCILIATION_VERSION = 1;

export type ReconciliationStatus = "pending" | "upgraded" | "confirmed" | "rejected";
export type ReconciliationDecision = "confirmed" | "rejected";

export interface ReconciliationReview {
  decision: ReconciliationDecision;
  reviewer: string | null;
  at: string;
  note?: string;
}

export interface ReconciliationEdgeEntry {
  from: string;
  to: string;
  /** Design-side provenance first recorded for this edge. */
  designProvenance: Provenance;
  /** Effective provenance (`runtime-observed` after observation upgrade,
   * `human-confirmed` after review confirmation). */
  provenance: Provenance;
  status: ReconciliationStatus;
  /** Distinct traces whose exploration reached the target (audit trail;
   * kept complete so re-ingesting any of them stays idempotent). */
  traces: string[];
  hits: number;
  lastSeenAt: string | null;
  /** Human adjudication (review surface); null = untouched. */
  review: ReconciliationReview | null;
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

function normalizeReview(value: unknown): ReconciliationReview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.decision !== "confirmed" && record.decision !== "rejected") return null;
  return {
    decision: record.decision,
    reviewer: typeof record.reviewer === "string" && record.reviewer.trim() !== "" ? record.reviewer.trim() : null,
    at: typeof record.at === "string" ? record.at : "",
    ...(typeof record.note === "string" && record.note.trim() !== "" ? { note: record.note.trim() } : {})
  };
}

function normalizeEntry(value: unknown): ReconciliationEdgeEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = typeof record.from === "string" ? record.from.trim() : "";
  const to = typeof record.to === "string" ? record.to.trim() : "";
  if (!from || !to) return null;
  const designProvenance = resolveProvenance(record.designProvenance);
  const rawProvenance = resolveProvenance(record.provenance);
  const review = normalizeReview(record.review);
  let status: ReconciliationStatus;
  if (review) {
    status = review.decision === "confirmed" ? "confirmed" : "rejected";
  } else if (record.status === "confirmed") {
    status = "confirmed";
  } else if (record.status === "rejected") {
    status = "rejected";
  } else if (record.status === "upgraded" || rawProvenance === "runtime-observed") {
    status = "upgraded";
  } else {
    status = "pending";
  }
  const provenance: Provenance =
    status === "confirmed"
      ? "human-confirmed"
      : status === "upgraded"
        ? "runtime-observed"
        : status === "rejected"
          ? designProvenance
          : rawProvenance === "runtime-observed" || rawProvenance === "human-confirmed"
            ? designProvenance
            : rawProvenance;
  const traces = Array.isArray(record.traces)
    ? record.traces.filter((trace): trace is string => typeof trace === "string")
    : [];
  const hits =
    typeof record.hits === "number" && Number.isFinite(record.hits) && record.hits >= 0
      ? Math.floor(record.hits)
      : traces.length;
  const lastSeenAt = typeof record.lastSeenAt === "string" ? record.lastSeenAt : null;
  return {
    from,
    to,
    designProvenance,
    provenance,
    status,
    traces,
    hits,
    lastSeenAt,
    review
  };
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
  let corrupt = false;
  try {
    JSON.parse(text);
  } catch {
    corrupt = true;
  }
  const asset = parseReconciliation(text);
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
        lastSeenAt: null,
        review: null
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

/** Overlay reconciliation decisions onto a flow graph for the next generation:
 * observation-upgraded edges become runtime-observed, confirmed edges become
 * human-confirmed, rejected edges are dropped (invalid navigation). Only
 * unconfirmed design evidence is rewritten for promotions. */
export function applyReconciliationToGraph(
  graph: FlowGraph,
  asset: ReconciliationAsset
): {
  graph: FlowGraph;
  upgradedEdges: number;
  confirmedEdges: number;
  rejectedEdges: number;
} {
  const byKey = new Map(asset.edges.map((entry) => [edgeKey(entry.from, entry.to), entry]));
  let upgradedEdges = 0;
  let confirmedEdges = 0;
  let rejectedEdges = 0;
  const edges = graph.edges.flatMap((edge) => {
    if (!edge.to) return [edge];
    const entry = byKey.get(edgeKey(edge.from.name, edge.to.name));
    if (!entry) return [edge];
    if (entry.status === "rejected") {
      rejectedEdges += 1;
      return [];
    }
    if (!isUnconfirmedProvenance(resolveProvenance(edge.provenance))) return [edge];
    if (entry.status === "upgraded") {
      upgradedEdges += 1;
      return [
        {
          ...edge,
          provenance: "runtime-observed" as const,
          confidence: confidenceFor("runtime-observed")
        }
      ];
    }
    if (entry.status === "confirmed") {
      confirmedEdges += 1;
      return [
        {
          ...edge,
          provenance: "human-confirmed" as const,
          confidence: confidenceFor("human-confirmed")
        }
      ];
    }
    return [edge];
  });
  if (upgradedEdges + confirmedEdges + rejectedEdges === 0) {
    return { graph, upgradedEdges: 0, confirmedEdges: 0, rejectedEdges: 0 };
  }
  return { graph: { ...graph, edges }, upgradedEdges, confirmedEdges, rejectedEdges };
}

/** Human adjudication of one edge (review surface). Confirm promotes the edge
 * to human-confirmed (hard-assertion grade); reject marks it invalid so
 * generation drops it. Idempotent: repeating a decision keeps the same state
 * (only the recorded time/reviewer refresh). */
export function reviewEdge(
  asset: ReconciliationAsset,
  input: {
    from: string;
    to: string;
    decision: ReconciliationDecision;
    reviewer?: string | null;
    note?: string;
    at: string;
  }
): { asset: ReconciliationAsset; entry: ReconciliationEdgeEntry } | { error: string } {
  const key = edgeKey(input.from, input.to);
  const edges = asset.edges.map((entry) => ({ ...entry, traces: [...entry.traces] }));
  const entry = edges.find((candidate) => edgeKey(candidate.from, candidate.to) === key);
  if (!entry) {
    return { error: `资产中未找到边「${key}」：先运行 suite run 产生观测，或核对屏幕名（可在 list 中查看可用边）` };
  }
  entry.review = {
    decision: input.decision,
    reviewer: input.reviewer?.trim() ? input.reviewer.trim() : (entry.review?.reviewer ?? null),
    at: input.at,
    ...(input.note?.trim() ? { note: input.note.trim() } : {})
  };
  entry.status = input.decision === "confirmed" ? "confirmed" : "rejected";
  entry.provenance = input.decision === "confirmed" ? "human-confirmed" : entry.designProvenance;
  return {
    asset: {
      version: asset.version,
      updatedAt: input.at,
      edges: edges.sort((a, b) => edgeKey(a.from, a.to).localeCompare(edgeKey(b.from, b.to)))
    },
    entry
  };
}

/** Destination-screen runtime text per screen (review context): helps a human
 * adjudicate an edge by showing what the destination screen should display.
 * Loaded once per listing (single flows.json read). */
export function screenTextHintsMap(configDirAbs: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  try {
    const flowsPath = path.join(configDirAbs, "design", "flows.json");
    if (!fs.existsSync(flowsPath)) return map;
    const graph = normalizeFlowGraph(JSON.parse(fs.readFileSync(flowsPath, "utf-8")));
    for (const screen of graph.screens) {
      const hints = normalizeFlowHints(screen.textHints)
        .filter((hint) => hint.textClass === "runtime-text")
        .map((hint) => hint.text)
        .slice(0, 3);
      if (hints.length > 0) map.set(screen.name, hints);
    }
  } catch {
    /* flows.json missing or unreadable: review proceeds without text context */
  }
  return map;
}

export interface ReconciliationArgs {
  action: "list" | "confirm" | "reject";
  from?: string;
  to?: string;
  reviewer?: string;
  note?: string;
}

export interface ReconciliationListingEdge extends ReconciliationEdgeEntry {
  toTextHints: string[];
}

export interface ReconciliationListing {
  file: string;
  updatedAt: string | null;
  counts: Record<ReconciliationStatus, number>;
  corrupt: boolean;
  edges: ReconciliationListingEdge[];
}

/** Shared listing builder for the MCP tool and the CLI (single shape). */
export function reconciliationListing(configDirAbs: string): ReconciliationListing {
  const asset = loadReconciliation(configDirAbs);
  const counts: Record<ReconciliationStatus, number> = {
    pending: 0,
    upgraded: 0,
    confirmed: 0,
    rejected: 0
  };
  for (const entry of asset.edges) counts[entry.status] += 1;
  const hintsByScreen = screenTextHintsMap(configDirAbs);
  return {
    file: reconciliationFilePath(configDirAbs),
    updatedAt: asset.updatedAt,
    counts,
    corrupt: asset.corrupt === true,
    edges: asset.edges.map((entry) => ({
      ...entry,
      toTextHints: hintsByScreen.get(entry.to) ?? []
    }))
  };
}

/** MCP tool handler (review surface): list / confirm / reject. Never throws:
 * filesystem errors come back as structured errors (screen-map precedent). */
export async function reconciliation(
  runtime: Runtime,
  args: ReconciliationArgs
): Promise<CallToolResult> {
  const json = (payload: unknown, isError = false): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  });
  try {
    const file = reconciliationFilePath(runtime.configDirAbs);
    if (args.action === "list") {
      const listing = reconciliationListing(runtime.configDirAbs);
      return json({
        ok: true,
        ...listing,
        ...(listing.corrupt
          ? { note: "资产文件损坏（JSON 不可解析）：按空资产处理，下一次写入将重建" }
          : {})
      });
    }
    const from = args.from?.trim();
    const to = args.to?.trim();
    if (!from || !to) {
      return json({ ok: false, error: "confirm/reject 需要 from 与 to（屏幕名，与 list 输出一致）" }, true);
    }
    const asset = loadReconciliation(runtime.configDirAbs);
    const result = reviewEdge(asset, {
      from,
      to,
      decision: args.action === "confirm" ? "confirmed" : "rejected",
      reviewer: args.reviewer ?? null,
      note: args.note,
      at: new Date().toISOString()
    });
    if ("error" in result) return json({ ok: false, error: result.error }, true);
    saveReconciliation(runtime.configDirAbs, result.asset);
    return json({ ok: true, file, edge: result.entry });
  } catch (error) {
    return json({ ok: false, error: `对账资产读写失败: ${String(error)}` }, true);
  }
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
