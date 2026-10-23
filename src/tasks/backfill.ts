import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CaseSetFeatureRecord, SuiteRunCaseRecord } from "../db/types.js";
import { caseSetsDir } from "../figma/case-sets.js";
import { loadRunManifest, runManifestFileNames } from "../figma/run-manifest.js";
import type { RunManifest } from "../figma/run-manifest.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { platformOf } from "./run-registry.js";

/** 回填扫描（DESIGN：回归服务 backfill）：只读扫描 `design/case-sets/*.json` 与
 * `design/runs/*.json`，幂等重建 `case_sets`/`case_set_features` 与 `suite_runs`/
 * `suite_run_cases` 登记。绝不改写磁盘产物；dry-run 只报告不写库。 */
export interface BackfillReport {
  scanned: { runs: number; caseSets: number };
  /** 实际写库数（dry-run 恒 0）。 */
  registered: { runs: number; caseSets: number };
  /** 将登记数（未登记且过下界；dry-run 下有值）。 */
  wouldRegister: { runs: number; caseSets: number };
  skipped: number;
  invalid: number;
  beforeSince: number;
  dryRun: boolean;
  warnings: string[];
}

interface BridgeEntry {
  caseSetId: string;
  featureKey: string;
  featureName: string;
}

export async function runBackfill(
  runtime: Runtime,
  options: { dryRun?: boolean; since?: string } = {}
): Promise<BackfillReport> {
  const dryRun = options.dryRun === true;
  const report: BackfillReport = {
    scanned: { runs: 0, caseSets: 0 },
    registered: { runs: 0, caseSets: 0 },
    wouldRegister: { runs: 0, caseSets: 0 },
    skipped: 0,
    invalid: 0,
    beforeSince: 0,
    dryRun,
    warnings: []
  };
  const rootPath = runtime.project.rootDir;
  const configDirAbs = runtime.configDirAbs;

  let since: string | null;
  if (options.since !== undefined) {
    const parsed = Date.parse(options.since);
    if (Number.isNaN(parsed)) {
      throw new Error(`--since 不可解析（须为可解析的 ISO 时间）: ${options.since}`);
    }
    since = new Date(parsed).toISOString();
  } else {
    since = await defaultSince(runtime, report);
  }

  // 路径桥：既有 listCaseSets 全量摊平 + 本次新登记（runs 段按 jsonPath 重映射）。
  const bridge = new Map<string, BridgeEntry>();
  for (const set of await runtime.store.listCaseSets(rootPath)) {
    for (const feature of set.features) {
      bridge.set(feature.jsonPath, {
        caseSetId: set.id,
        featureKey: feature.key,
        featureName: feature.name
      });
    }
  }
  const registeredJsonPaths = new Set(bridge.keys());

  // caseSets 段（先于 runs：路径桥需要新登记 id）。
  const setsDir = caseSetsDir(configDirAbs);
  let archiveNames: string[] = [];
  try {
    archiveNames = fs
      .readdirSync(setsDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    archiveNames = [];
  }
  report.scanned.caseSets = archiveNames.length;
  for (const name of archiveNames) {
    const jsonPath = path.join(setsDir, name);
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(jsonPath);
    } catch {
      report.invalid += 1;
      report.warnings.push(`归档读取失败: ${jsonPath}`);
      continue;
    }
    let archive: unknown;
    try {
      archive = JSON.parse(buffer.toString("utf-8"));
    } catch {
      report.invalid += 1;
      report.warnings.push(`归档 JSON 解析失败: ${jsonPath}`);
      continue;
    }
    const record = asRecord(archive);
    const first = firstFeature(record);
    if (first === null) {
      report.invalid += 1;
      report.warnings.push(`归档缺 features[0].key/name: ${jsonPath}`);
      continue;
    }
    if (registeredJsonPaths.has(jsonPath)) {
      report.skipped += 1;
      continue;
    }
    const createdAt = caseSetCreatedAt(name, jsonPath);
    if (createdAt === null) {
      report.invalid += 1;
      report.warnings.push(`归档 mtime 读取失败: ${jsonPath}`);
      continue;
    }
    if (since !== null && createdAt < since) {
      report.beforeSince += 1;
      continue;
    }
    const stem = name.slice(0, -".json".length);
    const mdPath = path.join(setsDir, `${stem}.md`);
    const xlsxPath = path.join(setsDir, `${stem}.xlsx`);
    const missingParts: string[] = [];
    if (!fs.existsSync(mdPath)) missingParts.push("md");
    if (!fs.existsSync(xlsxPath)) missingParts.push("xlsx");
    if (missingParts.length > 0) {
      report.warnings.push(`归档三件套缺 ${missingParts.join("/")}: ${stem}`);
    }
    if (dryRun) {
      report.wouldRegister.caseSets += 1;
      continue;
    }

    const flows = Array.isArray(record.flows) ? record.flows : [];
    const caseCount = Array.isArray(record.flows) ? record.flows.length : countOf(record.counts);
    const screens = first.screens.length > 0 ? [...first.screens] : [...uniqueScreens(flows)];
    const feature: CaseSetFeatureRecord = {
      key: first.key,
      name: first.name,
      caseCount,
      screens,
      jsonPath,
      mdPath,
      xlsxPath
    };
    const fingerprint = createHash("sha256").update(buffer).digest("hex");
    try {
      const inserted = await runtime.store.recordCaseSet({
        rootPath,
        source: typeof record.source === "string" ? record.source : "",
        designName: null,
        fingerprint,
        basename: stem,
        createdAt,
        features: [feature]
      });
      report.registered.caseSets += 1;
      bridge.set(jsonPath, { caseSetId: inserted.id, featureKey: feature.key, featureName: feature.name });
    } catch (error) {
      report.invalid += 1;
      report.warnings.push(`归档登记失败: ${jsonPath}（${errorMessage(error)}）`);
    }
  }

  // runs 段。
  const registeredManifestPaths = new Set(
    await runtime.store.listRegisteredManifestPaths(rootPath)
  );
  const manifestNames = runManifestFileNames(configDirAbs);
  report.scanned.runs = manifestNames.length;
  for (const name of manifestNames) {
    const read = loadRunManifest(configDirAbs, name);
    if (read.kind !== "ok") {
      report.invalid += 1;
      report.warnings.push(`清单不可用（${read.kind}）: ${name}`);
      continue;
    }
    const manifestPath = read.file;
    if (registeredManifestPaths.has(manifestPath)) {
      report.skipped += 1;
      continue;
    }
    if (since !== null && read.manifest.finishedAt < since) {
      report.beforeSince += 1;
      continue;
    }
    if (dryRun) {
      report.wouldRegister.runs += 1;
      continue;
    }
    try {
      await registerRun(runtime, rootPath, read.manifest, manifestPath, bridge);
      report.registered.runs += 1;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        report.skipped += 1;
      } else {
        report.invalid += 1;
        report.warnings.push(`清单登记失败: ${manifestPath}（${errorMessage(error)}）`);
      }
    }
  }

  return report;
}

async function registerRun(
  runtime: Runtime,
  rootPath: string,
  manifest: RunManifest,
  manifestPath: string,
  bridge: Map<string, BridgeEntry>
): Promise<void> {
  if (
    !manifest.summary ||
    typeof manifest.summary !== "object" ||
    !manifest.gate ||
    typeof manifest.gate !== "object" ||
    !Array.isArray(manifest.cases)
  ) {
    throw new Error("清单缺 summary/gate/cases");
  }
  const registration = manifest.registration;
  const deviceSerial = manifest.options?.deviceSerial ?? null;
  const platform = deviceSerial
    ? platformOf(deviceSerial)
    : (registration?.platform ?? "unknown");
  const refPath = registration?.caseSetJsonPath ?? registration?.testsPath;
  const bridged = refPath !== null && refPath !== undefined ? bridge.get(refPath) : undefined;
  const caseSetId = bridged ? bridged.caseSetId : (registration?.caseSetId ?? null);
  const featureKey = bridged ? bridged.featureKey : (registration?.featureKey ?? null);
  const featureName = bridged ? bridged.featureName : (registration?.featureName ?? null);

  const failureDomains: Record<string, number> = {};
  for (const [domain, count] of Object.entries(manifest.failureDomains)) {
    if (typeof count === "number") failureDomains[domain] = count;
  }

  const cases: SuiteRunCaseRecord[] = manifest.cases.map((entry) => ({
    caseId: entry.caseId,
    name: entry.name,
    featureKey,
    platform,
    status: entry.status,
    traceId: entry.traceId ?? null,
    failureDomain: entry.failure?.domain ?? null,
    failureConfidence: entry.failure?.confidence ?? null,
    failureReason: entry.failure?.reason ?? null,
    durationMs: null,
    quarantined: entry.quarantined === true,
    flaky: entry.retry?.flaky === true,
    verdict: null,
    verdictBy: null,
    verdictAt: null,
    verdictNote: null,
    jiraIssueKey: null
  }));

  await runtime.store.recordSuiteRun({
    rootPath,
    createdAt: manifest.finishedAt,
    run: {
      runId: typeof manifest.runId === "string" && manifest.runId !== "" ? manifest.runId : null,
      trigger: "cli",
      regressionTaskId: registration?.regressionTaskId ?? null,
      caseSetId,
      featureKey,
      featureName,
      platform,
      device: deviceSerial,
      appVersion: registration?.appVersion ?? null,
      runner: registration?.runner ?? null,
      status: manifest.gate.exitCode === 0 ? "completed" : "failed",
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      total: manifest.summary.total,
      passed: manifest.summary.passed,
      failed: manifest.summary.failed,
      flaky: manifest.summary.flaky,
      quarantined: manifest.summary.quarantinedFailed,
      failureDomains,
      gateResult: manifest.gate.result,
      exitCode: manifest.gate.exitCode,
      manifestPath,
      comparison: null,
      apiReview: manifest.apiReview ?? null
    },
    cases
  });
}

async function defaultSince(runtime: Runtime, report: BackfillReport): Promise<string | null> {
  const earliest = await runtime.store.getEarliestRegistrationCreatedAt(runtime.project.rootDir);
  const values = [earliest.runs, earliest.caseSets].filter((value): value is string => value !== null);
  if (values.length === 0) {
    report.warnings.push("库内无登记，无下界（将扫描全部归档）");
    return null;
  }
  return values.reduce((a, b) => (a < b ? a : b));
}

function caseSetCreatedAt(name: string, jsonPath: string): string | null {
  const stem = name.slice(0, -".json".length);
  const match = /^(\d{8})[T_](\d{6})(?:_|$)/.exec(stem);
  if (match) {
    const iso = `${match[1]!.slice(0, 4)}-${match[1]!.slice(4, 6)}-${match[1]!.slice(6, 8)}T${match[2]!.slice(0, 2)}:${match[2]!.slice(2, 4)}:${match[2]!.slice(4, 6)}.000Z`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  try {
    return new Date(fs.statSync(jsonPath).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstFeature(record: Record<string, unknown>): { key: string; name: string; screens: string[] } | null {
  const features = Array.isArray(record.features) ? record.features : [];
  const first = features[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const feature = first as Record<string, unknown>;
  if (typeof feature.key !== "string" || feature.key === "") return null;
  if (typeof feature.name !== "string" || feature.name === "") return null;
  const screens = new Set<string>();
  const raw = Array.isArray(feature.screens) ? feature.screens : [];
  for (const screen of raw) {
    if (typeof screen === "string" && screen !== "") screens.add(screen);
  }
  return { key: feature.key, name: feature.name, screens: [...screens] };
}

function countOf(counts: unknown): number {
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return 0;
  const flows = (counts as Record<string, unknown>).flows;
  return typeof flows === "number" && Number.isFinite(flows) ? flows : 0;
}

function uniqueScreens(flows: unknown[]): string[] {
  const screens = new Set<string>();
  for (const flow of flows) {
    if (!flow || typeof flow !== "object" || Array.isArray(flow)) continue;
    const raw = (flow as Record<string, unknown>).screens;
    if (!Array.isArray(raw)) continue;
    for (const screen of raw) {
      if (typeof screen === "string") screens.add(screen);
    }
  }
  return [...screens];
}
