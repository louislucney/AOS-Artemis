import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CaseSetRecord, SuiteRunRecord } from "../db/types.js";
import { resolveDesignWarnings, type WarningSummary } from "../design/warnings.js";
import { designDir, loadDesignFlowGraph, readFlowDocumentMeta } from "../figma/design-store.js";
import { loadRunManifest, runManifestFileNames, type RunManifest } from "../figma/run-manifest.js";
import { resolveProvenance } from "../provenance.js";
import { detectProjectStacks } from "../projects/stack.js";
import type { Runtime } from "../runtime.js";
import { collectVerdictExits } from "../tasks/verdict-exits.js";
import { errorMessage } from "../util.js";
import { provenanceOf } from "./case-selection.js";
import { staticReadiness } from "./readiness.js";

/** `project_archive`（统一服务 ④）：只读摘要——不触网、不跑子进程、不写盘；
 * 恒 `ok:true`，缺口以 `degraded[]` 如实标注（含未配置持久台账时的会话内存回退）。 */

export const ARCHIVE_RUNS_LIMIT = 10;
export const ARCHIVE_CASE_SETS_LIMIT = 200;
export const ARCHIVE_VERDICT_RUNS_LIMIT = 200;
const ARCHIVE_LATEST_FEATURES = 10;

export interface ProjectArchiveDeps {
  listCaseSets?: (runtime: Runtime, limit: number) => Promise<CaseSetRecord[]>;
  listRuns?: (runtime: Runtime, limit: number) => Promise<SuiteRunRecord[]>;
  readiness?: typeof staticReadiness;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function provenanceCounts(entries: Array<{ provenance?: unknown }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = resolveProvenance(entry.provenance);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function designWarningsOf(configDirAbs: string): WarningSummary | null {
  try {
    return resolveDesignWarnings(configDirAbs).summary;
  } catch {
    return null;
  }
}

function usableManifest(manifest: RunManifest): boolean {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (typeof manifest.runId !== "string" || manifest.runId.trim() === "") return false;
  if (typeof manifest.source !== "string") return false;
  if (typeof manifest.startedAt !== "string" || typeof manifest.finishedAt !== "string") return false;
  const summary = manifest.summary as unknown;
  if (!isObject(summary)) return false;
  for (const key of ["total", "passed", "failed"] as const) {
    const value = summary[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  const gate = manifest.gate as unknown;
  if (!isObject(gate)) return false;
  if (gate.result !== "pass" && gate.result !== "fail") return false;
  if (typeof gate.exitCode !== "number" || !Number.isFinite(gate.exitCode)) return false;
  if (!isObject(manifest.failureDomains)) return false;
  return true;
}

export async function projectArchive(
  runtime: Runtime,
  deps: ProjectArchiveDeps = {}
): Promise<CallToolResult> {
  const degraded: string[] = [];
  const designDirAbs = designDir(runtime.configDirAbs);
  const root = runtime.project.rootDir;

  if (runtime.store !== undefined && runtime.store.kind === "memory") {
    degraded.push("登记读自会话内存（未配置持久台账），用例库/裁决数据可能不完整");
  }

  let design: Record<string, unknown> | null = null;
  const flowsPath = path.join(designDirAbs, "flows.json");
  if (fs.existsSync(flowsPath)) {
    const graph = loadDesignFlowGraph(runtime.configDirAbs);
    if (graph === null) {
      degraded.push("flows.json 存在但不可解析（已略过设计血统）");
    } else {
      const meta = readFlowDocumentMeta(runtime.configDirAbs);
      let savedAt: string | null = null;
      try {
        savedAt = fs.statSync(flowsPath).mtime.toISOString();
      } catch {
        savedAt = null;
      }
      const source =
        meta === null
          ? null
          : meta.penPath !== null
            ? `pen:${meta.penPath}`
            : meta.fileKey !== null
              ? `figma:${meta.fileKey}`
              : null;
      design = {
        source,
        savedAt,
        screens: graph.screens.length,
        edges: graph.edges.length,
        entryScreens: graph.entryScreens.length,
        unresolved: graph.unresolvedDestinations.length,
        provenance: {
          screens: provenanceCounts(graph.screens),
          edges: provenanceCounts(graph.edges)
        },
        warnings: designWarningsOf(runtime.configDirAbs)
      };
    }
  }

  let caseSets: Record<string, unknown> | null = null;
  const listCaseSets =
    deps.listCaseSets ?? ((rt: Runtime, limit: number) => rt.store.listCaseSets(rt.project.rootDir, limit));
  try {
    const sets = await listCaseSets(runtime, ARCHIVE_CASE_SETS_LIMIT);
    const seen = new Set<string>();
    const latest: Array<{ feature: string; cases: number; provenance: string; createdAt: string }> = [];
    for (const set of sets) {
      for (const feature of set.features) {
        if (seen.has(feature.key)) continue;
        seen.add(feature.key);
        if (latest.length < ARCHIVE_LATEST_FEATURES) {
          latest.push({
            feature: feature.name,
            cases: feature.caseCount,
            provenance: provenanceOf(set.source),
            createdAt: set.createdAt
          });
        }
      }
    }
    caseSets = {
      total: sets.length,
      imported: sets.filter((set) => set.source.startsWith("imported:")).length,
      generated: sets.filter((set) => !set.source.startsWith("imported:")).length,
      features: seen.size,
      truncated: sets.length >= ARCHIVE_CASE_SETS_LIMIT,
      latest
    };
  } catch (error) {
    degraded.push(`用例库读取降级：${errorMessage(error)}`);
  }

  const manifestNames = runManifestFileNames(runtime.configDirAbs);
  const recent: Array<Record<string, unknown>> = [];
  let unreadable = 0;
  for (const name of manifestNames.slice(0, ARCHIVE_RUNS_LIMIT)) {
    const read = loadRunManifest(runtime.configDirAbs, name);
    if (read.kind !== "ok" || !usableManifest(read.manifest)) {
      unreadable += 1;
      continue;
    }
    const manifest = read.manifest;
    recent.push({
      runId: manifest.runId,
      source: manifest.source,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      total: manifest.summary.total,
      passed: manifest.summary.passed,
      failed: manifest.summary.failed,
      gate: manifest.gate.result,
      exitCode: manifest.gate.exitCode,
      failureDomains: manifest.failureDomains
    });
  }

  let verdicts: Record<string, unknown> | null = null;
  const listRuns =
    deps.listRuns ??
    ((rt: Runtime, limit: number) => rt.store.listSuiteRuns(rt.project.rootDir, { limit }));
  try {
    const runs = await listRuns(runtime, ARCHIVE_VERDICT_RUNS_LIMIT);
    const exits = collectVerdictExits(runs);
    const jiraKeys = new Set<string>();
    for (const run of runs) {
      for (const entry of run.cases) {
        if (typeof entry.jiraIssueKey === "string" && entry.jiraIssueKey.trim() !== "") {
          jiraKeys.add(entry.jiraIssueKey);
        }
      }
    }
    verdicts = {
      runsScanned: runs.length,
      caseDefects: exits.caseDefects.length,
      environment: exits.environment.length,
      appDefects: exits.appDefects.length,
      jiraKeys: jiraKeys.size
    };
  } catch (error) {
    degraded.push(`裁决摘要读取降级：${errorMessage(error)}`);
  }

  const readiness = await (deps.readiness ?? staticReadiness)(runtime);

  return jsonResult({
    ok: true,
    project: {
      name: path.basename(root),
      root,
      stacks: detectProjectStacks(root).map((stack) => ({ id: stack.id, displayName: stack.displayName }))
    },
    design,
    caseSets,
    runs: { total: manifestNames.length, unreadable, recent },
    verdicts,
    readiness,
    degraded: [...degraded, ...readiness.degraded]
  });
}
