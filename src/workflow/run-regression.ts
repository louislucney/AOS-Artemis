import fs from "node:fs";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CaseSetRecord } from "../db/types.js";
import { executeSuiteBatch } from "../figma/suite-batch.js";
import { log as logInfo } from "../log.js";
import { platformOf } from "../tasks/run-registry.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { defaultListDevices, pickDevice } from "./devices.js";
import { importTestDocument, type ImportedSet } from "./excel-import.js";
import { checkLlm, type SetupDeps } from "./setup.js";

export interface RunRegressionArgs {
  excelPath?: string;
  scope?: string;
  all?: boolean;
  device?: string;
}

export interface RunRegressionDeps {
  importDocument?: typeof importTestDocument;
  listSets?: (runtime: Runtime, limit: number) => Promise<CaseSetRecord[]>;
  executeBatch?: typeof executeSuiteBatch;
  listDevices?: () => Promise<Array<{ serial: string }>>;
  setup?: SetupDeps;
  log?: (line: string) => void;
}

interface RegressionTarget {
  feature: string;
  jsonPath: string;
  cases: number;
  provenance: string;
  caseIds?: string[];
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

function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function contains(text: string, keyword: string): boolean {
  return normalizeKeyword(text).includes(keyword);
}

function provenanceOf(source: string): string {
  return source.startsWith("imported:") ? `导入自 ${source.slice("imported:".length)}` : `生成自 ${source}`;
}

function caseIdsMatching(jsonPath: string, keyword: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { flows?: unknown };
    const flows = Array.isArray(parsed.flows) ? parsed.flows : [];
    const ids: string[] = [];
    for (const entry of flows) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as { id?: unknown; name?: unknown };
      if (typeof record.name !== "string" || typeof record.id !== "string") continue;
      if (contains(record.name, keyword)) ids.push(record.id);
    }
    return ids;
  } catch {
    return [];
  }
}

function latestFeatures(sets: CaseSetRecord[]): RegressionTarget[] {
  const seen = new Set<string>();
  const targets: RegressionTarget[] = [];
  for (const set of sets) {
    for (const feature of set.features) {
      if (seen.has(feature.key)) continue;
      seen.add(feature.key);
      targets.push({
        feature: feature.name,
        jsonPath: feature.jsonPath,
        cases: feature.caseCount,
        provenance: provenanceOf(set.source)
      });
    }
  }
  return targets;
}

function selectByScope(candidates: RegressionTarget[], keyword: string): RegressionTarget[] {
  const targets: RegressionTarget[] = [];
  for (const candidate of candidates) {
    if (contains(candidate.feature, keyword)) {
      targets.push(candidate);
      continue;
    }
    const caseIds = caseIdsMatching(candidate.jsonPath, keyword);
    if (caseIds.length > 0) {
      targets.push({ ...candidate, cases: caseIds.length, caseIds });
    }
  }
  return targets;
}

function importedTargets(sets: ImportedSet[], sourceId: string): RegressionTarget[] {
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
      : jsonResult({ ok: false, needs: "info", questions: pick.questions, context: pick.context });
  }
  const device = pick.device;
  steps.push({ step: "device", device });

  const keyword = scope === null ? null : normalizeKeyword(scope);
  let mode: "import" | "scope" | "all";
  let targets: RegressionTarget[];

  if (excelPath !== null) {
    mode = "import";
    const importFn = deps.importDocument ?? importTestDocument;
    const imported = await importFn(runtime, { excelPath });
    if (!imported.ok) {
      return jsonResult({
        ok: false,
        failedStep: "import",
        detail: imported.error,
        suggestions: IMPORT_SUGGESTIONS
      });
    }
    steps.push({
      step: "import",
      status: imported.status,
      sourceId: imported.sourceId,
      sets: imported.sets.length,
      sourceCopy: imported.sourceCopy
    });
    targets = importedTargets(imported.sets, imported.sourceId);
    if (keyword !== null) {
      targets = selectByScope(targets, keyword);
      if (targets.length === 0) {
        return jsonResult({
          ok: false,
          needs: "info",
          questions: [`导入集里没有匹配「${scope}」的用例：换关键词，或去掉 scope 跑整个导入集`],
          context: imported.sets.map((set) => `${set.feature}（${set.caseCount} 条）`)
        });
      }
    }
  } else {
    const listSets =
      deps.listSets ?? ((rt: Runtime, limit: number) => rt.store.listCaseSets(rt.project.rootDir, limit));
    const sets = await listSets(runtime, 200);
    const latest = latestFeatures(sets);
    if (keyword !== null) {
      mode = "scope";
      targets = selectByScope(latest, keyword);
      if (targets.length === 0) {
        return jsonResult({
          ok: false,
          needs: "info",
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
          questions: ["用例库还没有可用用例：先给 Excel 测试文档导入，或用 design_to_test 从设计稿生成"],
          context: []
        });
      }
    }
  }

  const echo = targets.map((target) => ({
    feature: target.feature,
    cases: target.cases,
    provenance: target.provenance
  }));
  steps.push({ step: "select", mode, targets: echo });
  const totalCases = targets.reduce((sum, target) => sum + target.cases, 0);
  logLine(
    `run_regression: 回归目标 ${echo
      .map((entry) => `${entry.feature} ×${entry.cases}（${entry.provenance}）`)
      .join("；")} · 设备 ${device}`
  );
  logLine(`run_regression: 即将执行 ${totalCases} 条用例 · ${targets.length} 个功能 · 设备 ${device}`);
  steps.push({ step: "run", cases: totalCases, sets: targets.length, device });

  const executeBatch = deps.executeBatch ?? executeSuiteBatch;
  const summaries: Array<{ feature: string; jsonPath: string; manifestPath: string | null }> = [];
  let total = 0;
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let gate: "passed" | "failed" = "passed";
  const traceIds: string[] = [];
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
        artifacts: { sets: summaries }
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
        artifacts: { sets: summaries }
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
    for (const entry of report.cases) {
      if (typeof entry.traceId === "string" && entry.traceId !== "") traceIds.push(entry.traceId);
    }
  }

  return jsonResult({
    ok: true,
    steps,
    artifacts: { sets: summaries },
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
