import fs from "node:fs";
import os from "node:os";

import type { SuiteRunCaseRecord, SuiteRunRecord } from "../db/types.js";
import { recordAuditSafe } from "../db/audit-event.js";
import { classifyIosSerial } from "../device/ios.js";
import type { SuiteRunReport } from "../figma/suite-runner.js";
import { apiReviewSnapshot } from "../figma/run-manifest.js";
import { logWarn } from "../log.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import type { CompareCaseInput } from "./run-compare.js";

/** 运行登记（DESIGN：回归服务 §5.5）：`SuiteRunReport` → `suite_runs`/`suite_run_cases` 行。
 * 登记与基线查询一律 best-effort：失败只告警，绝不阻断执行。 */
export function platformOf(serial: string | null): "ios" | "android" | "unknown" {
  if (!serial) return "unknown";
  return classifyIosSerial(serial) ? "ios" : "android";
}

export interface BuildSuiteRunInput {
  report: SuiteRunReport;
  trigger: string;
  regressionTaskId?: string | null;
  caseSetId?: string | null;
  featureKey?: string | null;
  featureName?: string | null;
  platform: string;
  device: string | null;
  appVersion?: string | null;
  /** 执行机标识（registerSuiteRun 缺省填 os.hostname()）。 */
  runner?: string | null;
  exitCode: number;
  startedAtMs: number;
  finishedAtMs: number;
  manifestPath?: string | null;
  /** 批次清单 runId；缺省时尝试从 manifestPath 读取。 */
  runId?: string | null;
  comparison?: unknown;
}

function runIdFromManifest(manifestPath: string | null | undefined): string | null {
  if (!manifestPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { runId?: unknown };
    return typeof parsed.runId === "string" && parsed.runId.trim() !== "" ? parsed.runId : null;
  } catch {
    return null;
  }
}

export function buildSuiteRunInput(input: BuildSuiteRunInput): {
  run: Omit<SuiteRunRecord, "id" | "projectId" | "cases" | "createdAt">;
  cases: SuiteRunCaseRecord[];
} {
  const failureDomains: Record<string, number> = {};
  for (const entry of input.report.cases) {
    if (entry.status === "passed") continue;
    const domain = entry.failure?.domain ?? "unclassified";
    failureDomains[domain] = (failureDomains[domain] ?? 0) + 1;
  }
  const quarantinedFailed = input.report.cases.filter(
    (entry) => entry.quarantined === true && entry.status !== "passed"
  ).length;
  const flaky = input.report.cases.filter((entry) => entry.retry?.flaky === true).length;
  return {
    run: {
      runId: input.runId ?? runIdFromManifest(input.manifestPath),
      trigger: input.trigger,
      regressionTaskId: input.regressionTaskId ?? null,
      caseSetId: input.caseSetId ?? null,
      featureKey: input.featureKey ?? null,
      featureName: input.featureName ?? null,
      platform: input.platform,
      device: input.device,
      appVersion: input.appVersion ?? null,
      runner: input.runner ?? null,
      status: input.exitCode === 0 ? "completed" : "failed",
      startedAt: new Date(input.startedAtMs).toISOString(),
      finishedAt: new Date(input.finishedAtMs).toISOString(),
      total: input.report.total,
      passed: input.report.passed,
      failed: input.report.failed,
      flaky,
      quarantined: quarantinedFailed,
      failureDomains,
      gateResult: input.exitCode === 0 ? "pass" : "fail",
      exitCode: input.exitCode,
      manifestPath: input.manifestPath ?? null,
      comparison: input.comparison ?? null,
      apiReview: apiReviewSnapshot(input.report.testsPath)
    },
    cases: input.report.cases.map((entry) => ({
      caseId: entry.caseId,
      name: entry.name,
      featureKey: input.featureKey ?? null,
      platform: input.platform,
      status: entry.status,
      traceId: entry.traceId,
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
    }))
  };
}

export async function resolveRunRefs(
  runtime: Runtime,
  testsPath: string
): Promise<{ caseSetId: string; featureKey: string; featureName: string } | null> {
  try {
    const sets = await runtime.store.listCaseSets(runtime.project.rootDir);
    for (const set of sets) {
      for (const feature of set.features) {
        if (feature.jsonPath === testsPath) {
          return { caseSetId: set.id, featureKey: feature.key, featureName: feature.name };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function registerSuiteRun(
  runtime: Runtime,
  input: BuildSuiteRunInput
): Promise<string | null> {
  try {
    const built = buildSuiteRunInput({ ...input, runner: input.runner ?? os.hostname() });
    const record = await runtime.store.recordSuiteRun({
      rootPath: runtime.project.rootDir,
      run: built.run,
      cases: built.cases,
      createdAt: built.run.finishedAt
    });
    await recordAuditSafe(runtime.store, runtime.project.rootDir, {
      domain: "suite",
      action: "run.recorded",
      result: "ok",
      summary: `批次登记 ${record.id}（${built.run.platform}）`,
      refs: {
        runId: record.id,
        caseSetId: input.caseSetId ?? undefined,
        featureKey: input.featureKey ?? undefined,
        taskId: input.regressionTaskId ?? undefined
      }
    });
    return record.id;
  } catch (error) {
    logWarn(`suite run 登记失败（不影响执行）：${errorMessage(error)}`);
    return null;
  }
}

export async function baselineFor(
  runtime: Runtime,
  ref: { caseSetId: string; featureKey: string; platform: string },
  excludeRunId?: string
): Promise<CompareCaseInput[] | null> {
  try {
    const runs = await runtime.store.listSuiteRuns(runtime.project.rootDir, {
      caseSetId: ref.caseSetId,
      featureKey: ref.featureKey,
      platform: ref.platform,
      limit: 20
    });
    const prior = runs.find((run) => run.id !== excludeRunId && run.cases.length > 0);
    if (!prior) return null;
    return prior.cases.map((entry) => ({
      caseId: entry.caseId,
      name: entry.name,
      outcome: entry.status === "passed" ? "passed" : "failed"
    }));
  } catch (error) {
    logWarn(`基线查询失败（按无基线处理）：${errorMessage(error)}`);
    return null;
  }
}
