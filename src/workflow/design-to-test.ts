import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadDesignFlowGraph } from "../figma/design-store.js";
import { figmaExtractFlows } from "../figma/flows.js";
import { coverageGateIssue } from "../figma/gate.js";
import { preflightGeneratedTests } from "../figma/preflight.js";
import {
  runGeneratedTests,
  type SuiteRunOptions,
  type SuiteRunReport
} from "../figma/suite-runner.js";
import { figmaGenerateTests } from "../figma/test-gen.js";
import { penExtractFlows } from "../pen/flows.js";
import { collectRunnerInventory } from "../runner/inventory.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { checkFigma, checkLlm, checkPen, type SetupDeps, type SetupNeed } from "./setup.js";

export interface DesignToTestArgs {
  figmaUrl?: string;
  nodeId?: string;
  penPath?: string;
  vision?: "auto" | boolean;
  reuseExistingFlows?: boolean;
  device?: string;
  run?: boolean;
}

export interface DesignToTestDeps {
  extractFigma?: typeof figmaExtractFlows;
  extractPen?: typeof penExtractFlows;
  generate?: typeof figmaGenerateTests;
  gate?: typeof coverageGateIssue;
  listDevices?: () => Promise<Array<{ serial: string; platform?: string }>>;
  execute?: (runtime: Runtime, options: SuiteRunOptions) => Promise<SuiteRunReport>;
  setup?: SetupDeps;
}

const REUSE_NO_FLOWS_QUESTION = "还没有设计流程——给 Figma 链接或 .pen 路径，或先跑一次设计提取";
const CHECK_SUGGESTION = "按提示用 figma_generate_tests 修正后重跑";
const RUN_FAILURE_SUGGESTION =
  "用例与证据已落盘（.artemis/design/runs/、.artemis/traces/），按提示处理后重跑安全";

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

function deviceNeed(note: string | null): SetupNeed {
  return {
    target: "device",
    missing: ["在线设备"],
    howTo: [
      "连接设备并确认在线：node scripts/adb-safe.mjs devices（Android 需已授权 USB 调试）",
      "node dist/cli.js doctor 查看设备与工具链状态（iOS 模拟器启动后亦可见）",
      "或用 device 参数直接指定设备序列号 / UDID"
    ],
    ...(note !== null ? { note: `设备盘点失败：${note}` } : {})
  };
}

async function defaultListDevices(): Promise<Array<{ serial: string; platform?: string }>> {
  const inventory = await collectRunnerInventory();
  return inventory.devices.map((device) => ({ serial: device.serial, platform: device.platform }));
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

  if (figmaUrl !== null && penPath !== null) {
    return usageError("figmaUrl 与 penPath 互斥：一次只处理一个设计来源");
  }
  if (figmaUrl === null && penPath === null && !reuse) {
    return usageError(
      "缺少设计来源：给 figmaUrl 或 penPath；已有 flows.json 可传 reuseExistingFlows:true"
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
  const steps: Array<Record<string, unknown>> = [];

  if (reuse) {
    if (!fs.existsSync(flowsPath)) {
      return jsonResult({ ok: false, needs: "info", questions: [REUSE_NO_FLOWS_QUESTION] });
    }
    const graph = loadDesignFlowGraph(runtime.configDirAbs);
    steps.push({
      step: "extract",
      reused: true,
      ...(graph ? { screens: graph.screens.length, edges: graph.edges.length } : {})
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
        suggestions
      });
    }
    const extractedPayload = payloadOf(extracted);
    if (extracted.isError === true || extractedPayload?.ok === false) {
      return jsonResult({
        ok: false,
        failedStep: "extract",
        detail: failureDetail(extracted, extractedPayload),
        suggestions
      });
    }
    const screens = countOf(extractedPayload, "screens");
    const edges = countOf(extractedPayload, "edges");
    steps.push({
      step: "extract",
      source: figmaUrl !== null ? "figma" : "pen",
      ...(screens !== null ? { screens } : {}),
      ...(edges !== null ? { edges } : {})
    });
  }

  const generate = deps.generate ?? figmaGenerateTests;
  let generatePayload: Record<string, unknown> | null = null;
  try {
    const generated = await generate(runtime, {});
    const payload = payloadOf(generated);
    if (generated.isError === true || payload?.ok === false) {
      return jsonResult({
        ok: false,
        failedStep: "generate",
        detail: failureDetail(generated, payload),
        suggestions: GENERATE_SUGGESTIONS
      });
    }
    generatePayload = payload;
  } catch (error) {
    return jsonResult({
      ok: false,
      failedStep: "generate",
      detail: errorMessage(error),
      suggestions: GENERATE_SUGGESTIONS
    });
  }

  const generatedCases = countOf(generatePayload, "flows");
  const generatedScreens = countOf(generatePayload, "screens");
  const generatedEdges = countOf(generatePayload, "edges");
  steps.push({
    step: "generate",
    ...(generatedCases !== null ? { cases: generatedCases } : {}),
    ...(generatedScreens !== null ? { screens: generatedScreens } : {}),
    ...(generatedEdges !== null ? { edges: generatedEdges } : {})
  });

  const preflight = preflightGeneratedTests(runtime.configDirAbs);
  const gate = deps.gate ?? coverageGateIssue;
  const issue = gate(preflight);
  if (issue !== null && issue !== undefined) {
    return jsonResult({
      ok: false,
      failedStep: "check",
      detail: issue,
      suggestions: [CHECK_SUGGESTION]
    });
  }
  steps.push({
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

  let runSummary: Record<string, unknown> | null = null;
  if (args.run === true) {
    const listDevices = deps.listDevices ?? defaultListDevices;
    let device = deviceArg;
    if (device === null) {
      let devices: Array<{ serial: string; platform?: string }> = [];
      let listError: string | null = null;
      try {
        devices = await listDevices();
      } catch (error) {
        listError = errorMessage(error);
      }
      if (devices.length === 0) {
        return jsonResult({ ok: false, needs: "setup", checks: [deviceNeed(listError)] });
      }
      if (devices.length > 1) {
        return jsonResult({
          ok: false,
          needs: "info",
          questions: [
            `发现 ${devices.length} 台在线设备，本次执行用哪台？重跑并在 device 参数给出序列号 / UDID`
          ],
          context: devices.map((entry) =>
            entry.platform ? `${entry.serial}（${entry.platform}）` : entry.serial
          )
        });
      }
      device = devices[0]!.serial;
    }

    const cases = generatedCases ?? preflight?.cases ?? 0;
    steps.push({ step: "run", cases, source, device });

    const execute = deps.execute ?? runGeneratedTests;
    const options: SuiteRunOptions = {
      testsPath,
      deviceSerial: device,
      apiErrors: true,
      failOnApiErrors: false,
      stopOnFailure: false
    };
    let report: SuiteRunReport;
    try {
      report = await execute(runtime, options);
    } catch (error) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: errorMessage(error),
        suggestions: [RUN_FAILURE_SUGGESTION]
      });
    }
    runSummary = {
      device,
      source,
      total: report.total,
      executed: report.executed,
      passed: report.passed,
      failed: report.failed,
      ok: report.ok,
      gate: report.ok ? (report.failed === 0 ? "passed" : "failed") : "error",
      traceIds: report.cases
        .map((entry) => entry.traceId)
        .filter((traceId): traceId is string => traceId !== null)
    };
  }

  const artifacts: Record<string, unknown> = {};
  if (fs.existsSync(flowsPath)) artifacts.flows = flowsPath;
  artifacts.tests = testsPath;
  const savedTo = generatePayload?.savedTo;
  if (savedTo !== undefined && savedTo !== null) artifacts.savedTo = savedTo;

  const nextAction =
    runSummary === null
      ? {
          tool: "design_to_test",
          args: {
            reuseExistingFlows: true,
            run: true,
            ...(deviceArg !== null ? { device: deviceArg } : {})
          }
        }
      : null;

  return jsonResult({
    ok: true,
    steps,
    artifacts,
    ...(runSummary !== null ? { run: runSummary } : {}),
    ...(nextAction !== null ? { nextAction } : {})
  });
}
