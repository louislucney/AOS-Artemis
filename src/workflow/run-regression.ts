import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CaseSetRecord } from "../db/types.js";
import { executeSuiteBatch } from "../figma/suite-batch.js";
import {
  mergeDesignWarningBatches,
  type DesignWarningBatch
} from "../figma/run-manifest.js";
import { log as logInfo } from "../log.js";
import { platformOf } from "../tasks/run-registry.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { latestFeatures, normalizeKeyword, provenanceOf, selectByScope, type CaseTarget } from "./case-selection.js";
import { defaultListDevices, pickDevice } from "./devices.js";
import { importTestDocument, type ImportColumns, type ImportedSet } from "./excel-import.js";
import { checkLlm, type SetupDeps } from "./setup.js";

export interface RunRegressionArgs {
  excelPath?: string;
  scope?: string;
  all?: boolean;
  device?: string;
  columns?: ImportColumns;
}

export interface RunRegressionDeps {
  importDocument?: typeof importTestDocument;
  listSets?: (runtime: Runtime) => Promise<CaseSetRecord[]>;
  executeBatch?: typeof executeSuiteBatch;
  listDevices?: () => Promise<Array<{ serial: string }>>;
  setup?: SetupDeps;
  log?: (line: string) => void;
}

const IMPORT_SUGGESTIONS = [
  "确认文件是 .xlsx、首行表头含「用例名」「步骤」（可选：预期、前置、模块），且没有合并单元格",
  "自定义列名用 columns 参数映射后重试"
];
const RUN_FAILURE_SUGGESTION =
  "用例与证据已落盘（.artemis/design/runs/、.artemis/traces/），按提示处理后重跑安全";
const RUN_NOT_EXECUTED_SUGGESTIONS = [
  "确认设备在线且可驱动：node dist/cli.js doctor（Android 查 adb 授权；iOS 查 Appium/WDA 状态）",
  RUN_FAILURE_SUGGESTION
];

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function trimOrNull(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function importedTargets(sets: ImportedSet[], sourceId: string): CaseTarget[] {
  const provenance = provenanceOf(sourceId);
  return sets.map((set) => ({
    feature: set.feature,
    jsonPath: set.jsonPath,
    cases: set.caseCount,
    provenance
  }));
}

/** 回归一条龙：前置自检 → 选择/导入（回显命中）→ 逐集执行（quarantine/manifest/登记）→ 聚合。 */
export async function runRegression(
  runtime: Runtime,
  args: RunRegressionArgs,
  deps: RunRegressionDeps = {}
): Promise<CallToolResult> {
  const excelPath = trimOrNull(args.excelPath);
  const scope = trimOrNull(args.scope);
  const requestedDevice = trimOrNull(args.device);
  if (excelPath !== null && args.all === true) {
    return jsonResult({ ok: false, error: "用法错误：excelPath 与 all 不能同用" }, true);
  }
  if (scope !== null && args.all === true) {
    return jsonResult({ ok: false, error: "用法错误：scope 与 all 不能同用" }, true);
  }

  const logLine = deps.log ?? logInfo;
  const steps: Array<Record<string, unknown>> = [];
  let stepMark = Date.now();
  const recordStep = (entry: Record<string, unknown>): Record<string, unknown> => {
    const now = Date.now();
    const out: Record<string, unknown> = { ...entry, ms: now - stepMark };
    stepMark = now;
    steps.push(out);
    return out;
  };

  const llmNeed = await checkLlm(runtime, deps.setup);
  if (llmNeed !== null) {
    return jsonResult({ ok: false, needs: "setup", checks: [llmNeed] });
  }

  const pick = await pickDevice(requestedDevice, async () => {
    if (deps.listDevices !== undefined) return await deps.listDevices();
    return await defaultListDevices(runtime);
  });
  if (!pick.ok) {
    return pick.needs === "setup"
      ? jsonResult({ ok: false, needs: "setup", checks: [pick.check] })
      : jsonResult({
          ok: false,
          needs: "info",
          category: pick.category,
          questions: pick.questions,
          context: pick.context
        });
  }
  const device = pick.device;
  recordStep({ step: "device", device });

  const keyword = scope === null ? null : normalizeKeyword(scope);
  let mode: "import" | "scope" | "all";
  let targets: CaseTarget[];
  let importOutcome: "imported" | "skipped" | null = null;
  let importWarnings: string[] = [];

  if (excelPath !== null) {
    mode = "import";
    const importFn = deps.importDocument ?? importTestDocument;
    const imported = await importFn(runtime, {
      excelPath,
      ...(args.columns !== undefined ? { columns: args.columns } : {})
    });
    if (!imported.ok) {
      return jsonResult({
        ok: false,
        failedStep: "import",
        import: { outcome: "invalid" },
        detail: imported.error,
        suggestions: IMPORT_SUGGESTIONS
      });
    }
    recordStep({
      step: "import",
      status: imported.status,
      sourceId: imported.sourceId,
      sets: imported.sets.length,
      sourceCopy: imported.sourceCopy
    });
    importOutcome = imported.status;
    importWarnings = imported.warnings ?? [];
    targets = importedTargets(imported.sets, imported.sourceId);
    if (keyword !== null) {
      targets = selectByScope(targets, keyword);
      if (targets.length === 0) {
        return jsonResult({
          ok: false,
          needs: "info",
          category: "scope-no-hit",
          questions: [`导入集里没有匹配「${scope}」的用例：换关键词，或去掉 scope 跑整个导入集`],
          context: imported.sets.map((set) => `${set.feature}（${set.caseCount} 条）`)
        });
      }
    }
  } else {
    const listSets =
      deps.listSets ?? ((rt: Runtime) => rt.store.listCaseSets(rt.project.rootDir));
    const sets = await listSets(runtime);
    const latest = latestFeatures(sets);
    if (keyword !== null) {
      mode = "scope";
      targets = selectByScope(latest, keyword);
      if (targets.length === 0) {
        return jsonResult({
          ok: false,
          needs: "info",
          category: "scope-no-hit",
          questions: [`用例库里没有匹配「${scope}」的用例：换个功能/用例关键词，或给 Excel 测试文档导入`],
          context: latest.map((entry) => `${entry.feature}（${entry.cases} 条，${entry.provenance}）`)
        });
      }
    } else {
      mode = "all";
      targets = latest;
      if (targets.length === 0) {
        return jsonResult({
          ok: false,
          needs: "info",
          category: "library-empty",
          questions: ["用例库还没有可用用例：先给 Excel 测试文档导入，或用 design_to_test 从设计稿生成"],
          context: []
        });
      }
    }
  }

  const scopeHits = keyword === null ? null : targets.reduce((sum, target) => sum + target.cases, 0);
  const echo = targets.map((target) => ({
    feature: target.feature,
    cases: target.cases,
    provenance: target.provenance
  }));
  recordStep({ step: "select", mode, targets: echo });
  const totalCases = targets.reduce((sum, target) => sum + target.cases, 0);
  logLine(
    `run_regression: 回归目标 ${echo
      .map((entry) => `${entry.feature} ×${entry.cases}（${entry.provenance}）`)
      .join("；")} · 设备 ${device}`
  );
  logLine(`run_regression: 即将执行 ${totalCases} 条用例 · ${targets.length} 个功能 · 设备 ${device}`);
  const runEntry = recordStep({ step: "run", cases: totalCases, sets: targets.length, device });
  const execStartedAt = Date.now();

  const executeBatch = deps.executeBatch ?? executeSuiteBatch;
  const summaries: Array<{ feature: string; jsonPath: string; manifestPath: string | null }> = [];
  let total = 0;
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let gate: "passed" | "failed" = "passed";
  const traceIds: string[] = [];
  const designWarningBatches: DesignWarningBatch[] = [];
  for (const target of targets) {
    let batch;
    try {
      batch = await executeBatch(
        runtime,
        {
          options: {
            testsPath: target.jsonPath,
            deviceSerial: device,
            ...(target.caseIds !== undefined ? { caseIds: target.caseIds } : {}),
            apiErrors: true,
            failOnApiErrors: false,
            stopOnFailure: false
          },
          source: "run_regression",
          trigger: "run_regression",
          registration: { platform: platformOf(device) }
        },
        { log: logLine }
      );
    } catch (error) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: errorMessage(error),
        suggestions: [RUN_FAILURE_SUGGESTION],
        artifacts: { sets: summaries },
        designWarnings: mergeDesignWarningBatches(designWarningBatches)
      });
    }
    const report = batch.report;
    summaries.push({ feature: target.feature, jsonPath: target.jsonPath, manifestPath: batch.manifestPath });
    if (!report.ok) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: report.error ?? "套件未执行（无可提交用例）",
        suggestions: RUN_NOT_EXECUTED_SUGGESTIONS,
        artifacts: { sets: summaries },
        designWarnings: mergeDesignWarningBatches(designWarningBatches)
      });
    }
    const quarantinedFailures = report.cases.filter(
      (entry) => entry.quarantined === true && entry.status !== "passed"
    ).length;
    if (report.failed - quarantinedFailures > 0) gate = "failed";
    total += report.total;
    executed += report.executed;
    passed += report.passed;
    failed += report.failed;
    designWarningBatches.push({
      source: target.feature,
      warnings: report.preflight?.designWarnings ?? [],
      summary: report.preflight?.designWarningSummary ?? null
    });
    for (const entry of report.cases) {
      if (typeof entry.traceId === "string" && entry.traceId !== "") traceIds.push(entry.traceId);
    }
  }

  runEntry.ms = Date.now() - execStartedAt;

  return jsonResult({
    ok: true,
    ...(importOutcome !== null ? { import: { outcome: importOutcome } } : {}),
    ...(importWarnings.length > 0 ? { importWarnings } : {}),
    ...(scopeHits !== null ? { scope: { keyword: scope, hits: scopeHits } } : {}),
    steps,
    artifacts: { sets: summaries },
    designWarnings: mergeDesignWarningBatches(designWarningBatches),
    run: {
      device,
      sets: targets.length,
      total,
      executed,
      passed,
      failed,
      ok: true,
      gate,
      traceIds
    }
  });
}
