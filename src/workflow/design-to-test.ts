import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  mergeWarnings,
  normalizeWarnings,
  readFlowsWarnings,
  summarizeWarnings,
  type DesignWarning
} from "../design/warnings.js";
import { loadDesignFlowGraph } from "../figma/design-store.js";
import { figmaExtractFlows } from "../figma/flows.js";
import { coverageGateIssue } from "../figma/gate.js";
import { preflightGeneratedTests } from "../figma/preflight.js";
import { executeSuiteBatch, type SuiteBatchResult } from "../figma/suite-batch.js";
import type { SuiteRunOptions, SuiteRunReport } from "../figma/suite-runner.js";
import {
  figmaGenerateTests,
  updateTestsApiReview,
  type ApiChange
} from "../figma/test-gen.js";
import { log as logInfo } from "../log.js";
import { penExtractFlows } from "../pen/flows.js";
import type { Runtime } from "../runtime.js";
import { platformOf } from "../tasks/run-registry.js";
import { errorMessage } from "../util.js";
import { defaultListDevices, pickDevice } from "./devices.js";
import { checkFigma, checkLlm, checkPen, type SetupDeps, type SetupNeed } from "./setup.js";

export { runnerInventoryEnv } from "./devices.js";

export interface DesignToTestArgs {
  figmaUrl?: string;
  nodeId?: string;
  penPath?: string;
  vision?: "auto" | boolean;
  reuseExistingFlows?: boolean;
  reuseExistingTests?: boolean;
  maxFlows?: number;
  maxDepth?: number;
  apiChange?: ApiChange;
  apiSpec?: string;
  apiSpecPath?: string;
  screens?: boolean;
  device?: string;
  run?: boolean;
  /** API 说明 pending 时仍允许执行（默认阻断）。 */
  allowPendingApi?: boolean;
}

export interface DesignToTestDeps {
  extractFigma?: typeof figmaExtractFlows;
  extractPen?: typeof penExtractFlows;
  generate?: typeof figmaGenerateTests;
  gate?: typeof coverageGateIssue;
  listDevices?: (runtime: Runtime) => Promise<Array<{ serial: string; platform?: string }>>;
  execute?: (runtime: Runtime, options: SuiteRunOptions) => Promise<SuiteRunReport>;
  setup?: SetupDeps;
  log?: (line: string) => void;
}

const REUSE_NO_FLOWS_QUESTION = "还没有设计流程——给 Figma 链接或 .pen 路径，或先跑一次设计提取";
const REUSE_NO_TESTS_QUESTION =
  "还没有可复用的用例（tests.json 缺失或不可读）——先跑一次生成，或去掉 reuseExistingTests";
const CHECK_SUGGESTION =
  "按提示用 figma_generate_tests 修正后重跑；路径被截断时可用 maxFlows/maxDepth 加大上限重试";
const RUN_FAILURE_SUGGESTION =
  "用例与证据已落盘（.artemis/design/runs/、.artemis/traces/），按提示处理后重跑安全";
const RUN_NOT_EXECUTED_SUGGESTIONS = [
  "确认设备在线且可驱动：node dist/cli.js doctor（Android 查 adb 授权；iOS 查 Appium/WDA 状态）",
  RUN_FAILURE_SUGGESTION
];

const FIGMA_EXTRACT_SUGGESTIONS = [
  "确认 Figma 链接可访问且 token 有权限（aos_configure(figmaToken=…) 或项目 .env 的 FIGMA_ACCESS_TOKEN）",
  "需要限定范围时传 nodeId；或用 penPath 改读 .pen 设计文件"
];
const PEN_EXTRACT_SUGGESTIONS = [
  "确认 .pen 路径存在且可读（pen CLI 状态见 doctor）",
  "可传 vision:true 做交互元素识别补全流程"
];
const GENERATE_SUGGESTIONS = [
  "确认 flows.json 存在且可读（先跑设计提取，或用 reuseExistingFlows:true 复用已有流程）",
  "按 figma_generate_tests 返回的提示修正后重跑"
];

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function usageError(message: string): CallToolResult {
  return jsonResult({ ok: false, error: `用法错误：${message}` }, true);
}

function textOf(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function payloadOf(result: CallToolResult): Record<string, unknown> | null {
  const text = textOf(result);
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function failureDetail(result: CallToolResult, payload: Record<string, unknown> | null): string {
  const error = payload?.error;
  if (typeof error === "string" && error.trim() !== "") return error;
  const text = textOf(result);
  return text === "" ? "未返回结构化结果" : text;
}

function countOf(payload: Record<string, unknown> | null, key: string): number | null {
  if (!payload) return null;
  const counts = payload.counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return null;
  const value = (counts as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** CR 一条龙编排：前置检查 → 设计提取 → 用例生成 → 静态校验 →（可选）执行。
 * 预期缺失（前置未就绪 / 信息不足）走非 isError 的 needs-setup / needs-info；
 * 仅参数冲突等用法错误用 isError；每步失败返回 { failedStep, detail, suggestions }。
 * `run !== true` 时止于校验，响应带 nextAction 指向带 run 的续跑调用。 */
export async function designToTest(
  runtime: Runtime,
  args: DesignToTestArgs,
  deps: DesignToTestDeps = {}
): Promise<CallToolResult> {
  const figmaUrl =
    typeof args.figmaUrl === "string" && args.figmaUrl.trim() !== "" ? args.figmaUrl.trim() : null;
  const penPath =
    typeof args.penPath === "string" && args.penPath.trim() !== "" ? args.penPath.trim() : null;
  const nodeId =
    typeof args.nodeId === "string" && args.nodeId.trim() !== "" ? args.nodeId.trim() : null;
  const deviceArg =
    typeof args.device === "string" && args.device.trim() !== "" ? args.device.trim() : null;
  const reuse = args.reuseExistingFlows === true;
  const reuseTests = args.reuseExistingTests === true;

  if (figmaUrl !== null && penPath !== null) {
    return usageError("figmaUrl 与 penPath 互斥：一次只处理一个设计来源");
  }
  if (figmaUrl === null && penPath === null && !reuse) {
    return usageError(
      "缺少设计来源：给 figmaUrl 或 penPath；已有 flows.json 可传 reuseExistingFlows:true"
    );
  }
  if (reuseTests && !reuse) {
    return usageError(
      "reuseExistingTests 需与 reuseExistingFlows 同用：先复用已有 flows，再复用 tests"
    );
  }
  if (nodeId !== null && figmaUrl === null) {
    return usageError("nodeId 仅适用于 figmaUrl");
  }
  if (args.vision !== undefined && penPath === null) {
    return usageError("vision 仅适用于 penPath");
  }

  const checks: SetupNeed[] = [];
  if (!reuse && figmaUrl !== null) {
    const need = checkFigma(runtime);
    if (need) checks.push(need);
  }
  if (!reuse && penPath !== null) {
    const need = await checkPen(runtime, deps.setup);
    if (need) checks.push(need);
  }
  const llmNeed = await checkLlm(runtime, deps.setup);
  if (llmNeed) checks.push(llmNeed);
  if (checks.length > 0) {
    return jsonResult({ ok: false, needs: "setup", checks });
  }

  const designDirAbs = path.join(runtime.configDirAbs, "design");
  const flowsPath = path.join(designDirAbs, "flows.json");
  const testsPath = path.join(designDirAbs, "tests.json");
  const flowMapPath = path.join(designDirAbs, "flow-map.md");
  let warnings: DesignWarning[] = [];
  let warningSources: Array<{ source: string; warnings: DesignWarning[] }> = [];
  let warningsAvailable = false;
  let warningsSnapshotAt: string | null = null;
  let warningsBySource: Record<string, number> = {};
  const warningFields = (): Record<string, unknown> => ({
    warnings,
    designWarnings: summarizeWarnings(warnings, {
      available: warningsAvailable,
      ...(warningsSnapshotAt !== null ? { snapshotAt: warningsSnapshotAt } : {}),
      ...(Object.keys(warningsBySource).length > 0 ? { bySource: warningsBySource } : {})
    })
  });
  const steps: Array<Record<string, unknown>> = [];
  let stepMark = Date.now();
  const mergeGeneratedWarnings = (payload: Record<string, unknown> | null): void => {
    if (payload === null) return;
    if (!Array.isArray(payload.warnings) && !Array.isArray(payload.designWarnings)) return;
    warningSources = [
      ...warningSources,
      { source: "generated", warnings: normalizeWarnings(payload.warnings) }
    ];
    const merged = mergeWarnings(warningSources);
    warnings = merged.warnings;
    warningsBySource = merged.bySource;
    warningsAvailable = true;
  };
  const recordStep = (entry: Record<string, unknown>): Record<string, unknown> => {
    const now = Date.now();
    const out: Record<string, unknown> = { ...entry, ms: now - stepMark };
    stepMark = now;
    steps.push(out);
    return out;
  };

  if (reuse) {
    if (!fs.existsSync(flowsPath)) {
      return jsonResult({ ok: false, needs: "info", category: "no-flows", questions: [REUSE_NO_FLOWS_QUESTION] });
    }
    const graph = loadDesignFlowGraph(runtime.configDirAbs);
    const read = readFlowsWarnings(runtime.configDirAbs);
    warnings = read.warnings;
    warningSources = [{ source: "flows", warnings: read.warnings }];
    warningsAvailable = read.available;
    warningsSnapshotAt = read.snapshotAt;
    warningsBySource = { flows: read.warnings.length };
    recordStep({
      step: "extract",
      reused: true,
      ...(graph ? { screens: graph.screens.length, edges: graph.edges.length } : {}),
      warnings: warnings.length
    });
  } else {
    const extractFigma = deps.extractFigma ?? figmaExtractFlows;
    const extractPen = deps.extractPen ?? penExtractFlows;
    const suggestions = figmaUrl !== null ? FIGMA_EXTRACT_SUGGESTIONS : PEN_EXTRACT_SUGGESTIONS;
    let extracted: CallToolResult;
    try {
      extracted =
        figmaUrl !== null
          ? await extractFigma(runtime, {
              url: figmaUrl,
              ...(nodeId !== null ? { nodeId } : {})
            })
          : await extractPen(runtime, {
              path: penPath!,
              ...(args.vision !== undefined ? { vision: args.vision } : {})
            });
    } catch (error) {
      return jsonResult({
        ok: false,
        failedStep: "extract",
        detail: errorMessage(error),
        suggestions,
        ...warningFields()
      });
    }
    const extractedPayload = payloadOf(extracted);
    if (extracted.isError === true || extractedPayload?.ok === false) {
      return jsonResult({
        ok: false,
        failedStep: "extract",
        detail: failureDetail(extracted, extractedPayload),
        suggestions,
        ...warningFields()
      });
    }
    const screens = countOf(extractedPayload, "screens");
    const edges = countOf(extractedPayload, "edges");
    const diskWarnings = readFlowsWarnings(runtime.configDirAbs);
    warningSources = [
      { source: "extract", warnings: normalizeWarnings(extractedPayload?.warnings) },
      { source: "flows", warnings: diskWarnings.warnings }
    ];
    const mergedWarnings = mergeWarnings(warningSources);
    warnings = mergedWarnings.warnings;
    warningsAvailable = Array.isArray(extractedPayload?.warnings) || diskWarnings.available;
    warningsSnapshotAt = diskWarnings.snapshotAt;
    warningsBySource = mergedWarnings.bySource;
    recordStep({
      step: "extract",
      source: figmaUrl !== null ? "figma" : "pen",
      ...(screens !== null ? { screens } : {}),
      ...(edges !== null ? { edges } : {}),
      warnings: warnings.length
    });
  }

  let preflight: ReturnType<typeof preflightGeneratedTests> = null;
  let generatePayload: Record<string, unknown> | null = null;
  let generatedCases: number | null = null;
  let apiReviewUpdate: Awaited<ReturnType<typeof updateTestsApiReview>> | null = null;
  if (reuseTests) {
    preflight = preflightGeneratedTests(runtime.configDirAbs);
    if (preflight === null) {
      return jsonResult({
        ok: false,
        needs: "info",
        category: "no-tests",
        questions: [REUSE_NO_TESTS_QUESTION]
      });
    }
    generatedCases = preflight.cases;
    const reusedWarnings = preflight.designWarnings;
    const warningSource =
      preflight.designWarningsSource === "none" ? "tests" : preflight.designWarningsSource;
    warnings = reusedWarnings;
    warningSources = [{ source: warningSource, warnings: reusedWarnings }];
    warningsAvailable = preflight.designWarningsSource !== "none";
    warningsSnapshotAt = preflight.designWarningsSnapshotAt;
    warningsBySource = { [warningSource]: reusedWarnings.length };
    recordStep({ step: "generate", reused: true, cases: generatedCases });
    const hasApiInput =
      args.apiChange !== undefined ||
      args.apiSpec !== undefined ||
      args.apiSpecPath !== undefined;
    if (hasApiInput) {
      try {
        apiReviewUpdate = await updateTestsApiReview(runtime, {
          ...(args.apiChange !== undefined ? { apiChange: args.apiChange } : {}),
          ...(args.apiSpec !== undefined ? { apiSpec: args.apiSpec } : {}),
          ...(args.apiSpecPath !== undefined ? { apiSpecPath: args.apiSpecPath } : {})
        });
        warnings = [...warnings, ...apiReviewUpdate.warnings];
        recordStep({
          step: "api-review",
          status: apiReviewUpdate.review.status,
          artifacts: apiReviewUpdate.updatedArtifacts.length
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          failedStep: "api-review",
          detail: errorMessage(error),
          suggestions: ["确认 tests.json 存在，apiSpecPath 位于项目内且可读"],
          ...warningFields()
        });
      }
    }
  } else {
    const generate = deps.generate ?? figmaGenerateTests;
    try {
      const generated = await generate(runtime, {
        screens: args.screens ?? true,
        ...(typeof args.maxFlows === "number" ? { maxFlows: args.maxFlows } : {}),
        ...(typeof args.maxDepth === "number" ? { maxDepth: args.maxDepth } : {}),
        ...(args.apiChange !== undefined ? { apiChange: args.apiChange } : {}),
        ...(args.apiSpec !== undefined ? { apiSpec: args.apiSpec } : {}),
        ...(args.apiSpecPath !== undefined ? { apiSpecPath: args.apiSpecPath } : {})
      });
      const payload = payloadOf(generated);
      mergeGeneratedWarnings(payload);
      if (generated.isError === true || payload?.ok === false) {
        return jsonResult({
          ok: false,
          failedStep: "generate",
          detail: failureDetail(generated, payload),
          suggestions: GENERATE_SUGGESTIONS,
          ...warningFields()
        });
      }
      generatePayload = payload;
      mergeGeneratedWarnings(payload);
    } catch (error) {
      return jsonResult({
        ok: false,
        failedStep: "generate",
        detail: errorMessage(error),
        suggestions: GENERATE_SUGGESTIONS,
        ...warningFields()
      });
    }

    generatedCases = countOf(generatePayload, "flows");
    const generatedScreens = countOf(generatePayload, "screens");
    const generatedEdges = countOf(generatePayload, "edges");
    recordStep({
      step: "generate",
      ...(generatedCases !== null ? { cases: generatedCases } : {}),
      ...(generatedScreens !== null ? { screens: generatedScreens } : {}),
      ...(generatedEdges !== null ? { edges: generatedEdges } : {})
    });
  }

  if (generatedCases === 0) {
    return jsonResult({
      ok: false,
      failedStep: "generate",
      detail: "设计流程没有生成任何用例（flows.json 为空或流程不可达）",
      suggestions: GENERATE_SUGGESTIONS,
      ...warningFields()
    });
  }

  const flowMapArtifact: Record<string, string> = fs.existsSync(flowMapPath)
    ? { flowMap: flowMapPath }
    : {};

  preflight = preflight ?? preflightGeneratedTests(runtime.configDirAbs);
  const gate = deps.gate ?? coverageGateIssue;
  const issue = gate(preflight);
  if (issue !== null && issue !== undefined) {
    return jsonResult({
      ok: false,
      failedStep: "check",
      detail: issue,
      suggestions: [CHECK_SUGGESTION],
      ...(Object.keys(flowMapArtifact).length > 0 ? { artifacts: flowMapArtifact } : {}),
      ...warningFields()
    });
  }
  recordStep({
    step: "check",
    ok: true,
    ...(preflight ? { cases: preflight.cases } : {})
  });

  const generatedSource =
    generatePayload &&
    typeof generatePayload.source === "string" &&
    generatePayload.source !== ""
      ? generatePayload.source
      : null;
  const source =
    generatedSource ??
    (figmaUrl !== null ? `figma:${figmaUrl}` : penPath !== null ? `pen:${penPath}` : flowsPath);

  const reviewedApi =
    apiReviewUpdate !== null
      ? apiReviewUpdate.review
      : generatePayload !== null &&
          typeof generatePayload.apiReview === "object" &&
          generatePayload.apiReview !== null
        ? (generatePayload.apiReview as Record<string, unknown>)
        : null;
  if (args.run === true && reviewedApi?.status === "pending" && args.allowPendingApi !== true) {
    return jsonResult({
      ok: false,
      needs: "info",
      category: "api-spec-pending",
      questions: [
        "本次功能涉及新增/修改 API，但接口说明尚未提供；请先补充 apiSpec/apiSpecPath，或显式传 allowPendingApi:true 继续执行。"
      ],
      ...(reviewedApi !== null ? { apiReview: reviewedApi } : {}),
      ...warningFields()
    });
  }
  const logLine = deps.log ?? logInfo;
  let runSummary: Record<string, unknown> | null = null;
  let runManifestPath: string | null = null;
  if (args.run === true) {
    const pick = await pickDevice(deviceArg, async () =>
      deps.listDevices !== undefined ? await deps.listDevices(runtime) : await defaultListDevices(runtime)
    );
    if (!pick.ok) {
      return pick.needs === "setup"
        ? jsonResult({ ok: false, needs: "setup", checks: [pick.check], ...warningFields() })
        : jsonResult({
            ok: false,
            needs: "info",
            category: pick.category,
            questions: pick.questions,
            context: pick.context,
            ...warningFields()
          });
    }
    const device = pick.device;

    const cases = generatedCases ?? preflight?.cases ?? 0;
    const runEntry = recordStep({ step: "run", cases, source, device });
    logLine(
      `design_to_test: 即将执行 ${cases} 条用例 · 来源 ${source} · 设备 ${device}`
    );
    const execStartedAt = Date.now();

    let batch: SuiteBatchResult;
    try {
      batch = await executeSuiteBatch(
        runtime,
        {
          options: {
            testsPath,
            deviceSerial: device,
            apiErrors: true,
            failOnApiErrors: false,
            stopOnFailure: false
          },
          source: "design_to_test",
          trigger: "design_to_test",
          registration: { platform: platformOf(device) },
          ...(deps.execute !== undefined ? { execute: deps.execute } : {})
        },
        { log: logLine }
      );
    } catch (error) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: errorMessage(error),
        suggestions: [RUN_FAILURE_SUGGESTION],
        ...warningFields()
      });
    }
    runEntry.ms = Date.now() - execStartedAt;
    const report = batch.report;
    runManifestPath = batch.manifestPath;
    if (!report.ok) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: report.error ?? "套件未执行（无可提交用例）",
        suggestions: RUN_NOT_EXECUTED_SUGGESTIONS,
        ...(runManifestPath !== null || Object.keys(flowMapArtifact).length > 0
          ? {
              artifacts: {
                ...(runManifestPath !== null ? { runManifest: runManifestPath } : {}),
                ...flowMapArtifact
              }
            }
          : {}),
        ...warningFields()
      });
    }
    const quarantinedFailures = report.cases.filter(
      (entry) => entry.quarantined === true && entry.status !== "passed"
    ).length;
    runSummary = {
      device,
      source,
      total: report.total,
      executed: report.executed,
      passed: report.passed,
      failed: report.failed,
      ok: report.ok,
      gate: report.failed - quarantinedFailures === 0 ? "passed" : "failed",
      traceIds: report.cases
        .map((entry) => entry.traceId)
        .filter((traceId): traceId is string => traceId !== null)
    };
  }

  const artifacts: Record<string, unknown> = {};
  if (fs.existsSync(flowsPath)) artifacts.flows = flowsPath;
  Object.assign(artifacts, flowMapArtifact);
  artifacts.tests = testsPath;
  if (runManifestPath !== null) artifacts.runManifest = runManifestPath;
  const savedTo = generatePayload?.savedTo;
  if (savedTo !== undefined && savedTo !== null) artifacts.savedTo = savedTo;

  const nextAction =
    runSummary === null
      ? {
          tool: "design_to_test",
          args: {
            reuseExistingFlows: true,
            reuseExistingTests: true,
            run: true,
            ...(typeof args.maxFlows === "number" ? { maxFlows: args.maxFlows } : {}),
            ...(typeof args.maxDepth === "number" ? { maxDepth: args.maxDepth } : {}),
            ...(deviceArg !== null ? { device: deviceArg } : {})
          }
        }
      : null;

  const apiReview = reviewedApi;
  if (apiReviewUpdate !== null) {
    for (const artifact of apiReviewUpdate.updatedArtifacts) artifacts[artifact.endsWith(".json") ? "apiReviewJson" : artifact.endsWith(".md") ? "apiReviewMarkdown" : "apiReviewXlsx"] = artifact;
  }
  const apiNextAction =
    apiReview?.status === "pending"
      ? "provide-api-spec"
      : apiReview?.status === "unknown"
        ? "confirm-api-change"
        : null;
  return jsonResult({
    ok: true,
    steps,
    artifacts,
    ...warningFields(),
    ...(apiReview !== null ? { apiReview } : {}),
    ...(apiNextAction !== null ? { apiReviewNextAction: apiNextAction } : {}),
    ...(runSummary !== null ? { run: runSummary } : {}),
    ...(nextAction !== null ? { nextAction } : {})
  });
}
