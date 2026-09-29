import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { buildFlowGraph, type FlowEdge, type FlowGraph } from "./flows.js";
import { canonicalizePlaceholders, normalizedText } from "./strings.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

export interface GeneratedTest {
  name: string;
  screens: string[];
  steps: string[];
  /** Ready-to-run mobile_run_task description. */
  taskDesc: string;
}

/** Expand the flow graph into concrete execution paths (entry → … → terminal /
 * back edge), bounded by count and depth. */
export function linearizeFlows(
  graph: FlowGraph,
  options: { maxFlows?: number; maxDepth?: number } = {}
): FlowEdge[][] {
  const maxFlows = options.maxFlows ?? 10;
  const maxDepth = options.maxDepth ?? 12;

  const outgoingByScreen = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoingByScreen.get(edge.from.id) ?? [];
    list.push(edge);
    outgoingByScreen.set(edge.from.id, list);
  }

  const entryIds = new Set(
    graph.screens.filter((screen) => graph.entryScreens.includes(screen.name)).map((s) => s.id)
  );
  const startIds = entryIds.size > 0 ? [...entryIds] : graph.screens.map((s) => s.id);

  const flows: FlowEdge[][] = [];
  let guard = 0;
  const stack = startIds.map((id) => ({ screenId: id, path: [] as FlowEdge[], visited: new Set([id]) }));
  while (stack.length > 0 && flows.length < maxFlows * 4 && guard < 500) {
    guard += 1;
    const { screenId, path, visited } = stack.pop()!;
    const outgoing = outgoingByScreen.get(screenId) ?? [];
    if (path.length >= maxDepth || outgoing.length === 0) {
      if (path.length > 0) flows.push(path);
      continue;
    }
    for (const edge of outgoing) {
      const nextPath = [...path, edge];
      if (!edge.to || visited.has(edge.to.id)) {
        flows.push(nextPath); // terminate at dead ends, back edges and self loops
        continue;
      }
      stack.push({
        screenId: edge.to.id,
        path: nextPath,
        visited: new Set([...visited, edge.to.id])
      });
    }
  }

  const seen = new Set<string>();
  return flows
    .filter((flow) => {
      const signature = flow
        .map((edge) => `${edge.element.id}->${edge.to?.id ?? "?"}:${edge.trigger}`)
        .join("|");
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .slice(0, maxFlows);
}

function assertionFor(graph: FlowGraph, edge: FlowEdge): string {
  if (!edge.to) return "";
  const screen = graph.screens.find((candidate) => candidate.id === edge.to!.id);
  const hints = [...(screen?.textHints ?? []), ...(screen?.childNames ?? [])].slice(0, 3);
  return hints.length > 0 ? `（页面应出现「${hints.join("」「")}」等）` : "";
}

function lookupI18nKey(text: string | undefined, i18nKeys: Map<string, string> | undefined): string | null {
  if (!text || !i18nKeys || i18nKeys.size === 0) return null;
  const canonical = normalizedText(canonicalizePlaceholders(text).canonicalText);
  return i18nKeys.get(canonical) ?? i18nKeys.get(normalizedText(text)) ?? null;
}

function stepFor(graph: FlowGraph, edge: FlowEdge, i18nKeys?: Map<string, string>): string {
  const target = edge.to ? `「${edge.to.name}」` : null;
  const assertion = assertionFor(graph, edge);
  const label = edge.textHints[0] ? `「${edge.textHints[0]}」` : `「${edge.element.name}」`;
  const i18nKey = lookupI18nKey(edge.textHints[0], i18nKeys);
  const elementNote = edge.textHints[0]
    ? `（设计元素：${edge.element.name}${i18nKey ? `；i18n: ${i18nKey}` : ""}）`
    : "";

  if (edge.trigger === "AFTER_TIMEOUT") {
    const seconds = ((edge.triggerTimeoutMs ?? 0) / 1000).toFixed(1).replace(/\.0$/, "");
    return `等待 ${seconds} 秒${target ? `，页面应自动进入${target}${assertion}` : ""}`;
  }
  if (edge.back) {
    return `点击${label}返回上一页${target ? `（应回到${target}${assertion}）` : ""}`;
  }
  if (edge.trigger === "ON_DRAG") {
    return `在${label}${elementNote}上执行拖拽操作${target ? `，验证进入${target}${assertion}` : ""}`;
  }
  if (edge.trigger.startsWith("ON_")) {
    return `点击${label}${elementNote}${
      target ? `，验证进入${target}${assertion}` : "（应停留在本页不产生跳转）"
    }`;
  }
  return `触发${label}${elementNote}（${edge.trigger}）${target ? `，验证进入${target}${assertion}` : ""}`;
}

/** Turn flow paths into test cases with artemis-ready task descriptions.
 * `i18nKeys` maps canonical source text → frozen i18n key (strings.json) so
 * generated steps can prefer resource keys over locale-dependent literals. */
export function generateTestCases(
  graph: FlowGraph,
  options: { maxFlows?: number; i18nKeys?: Map<string, string> } = {}
): GeneratedTest[] {
  const flows = linearizeFlows(graph, { maxFlows: options.maxFlows ?? 10 });
  return flows.map((flowPath) => {
    const first = flowPath[0]!;
    const screens: string[] = [first.from.name];
    for (const edge of flowPath) {
      const name = edge.to?.name;
      if (name && name !== screens[screens.length - 1]) screens.push(name);
    }
    const steps = flowPath.map((edge) => stepFor(graph, edge, options.i18nKeys));
    const name =
      screens.length <= 4 ? screens.join(" → ") : `${screens.slice(0, 4).join(" → ")} → …`;
    const taskDesc = [
      `【设计流程端到端验证】${name}`,
      `开始前：打开应用并确保停留在「${first.from.name}」页（如不在该页，先导航过去）。`,
      ...steps.map((step, index) => `${index + 1}) ${step}`),
      "每步完成后报告当前页面标题与可见关键文本；任一步失败则停止，报告失败步骤、屏幕上的关键文本并截屏；全部通过后输出 PASS/FAIL 摘要。"
    ].join("\n");
    return { name, screens, steps, taskDesc };
  });
}

export function renderMarkdown(
  cases: GeneratedTest[],
  meta: { source: string; generatedAt: string }
): string {
  const lines: string[] = [
    "# 设计流程测试用例",
    "",
    `> 来源: ${meta.source}`,
    `> 生成时间: ${meta.generatedAt}`,
    ""
  ];
  cases.forEach((testCase, index) => {
    lines.push(`## ${index + 1}. ${testCase.name}`, "");
    testCase.steps.forEach((step, stepIndex) => {
      lines.push(`- [ ] ${stepIndex + 1}) ${step}`);
    });
    lines.push("", "### artemis 任务描述（可直接传给 mobile_run_task）", "", "```text", testCase.taskDesc, "```", "");
  });
  return lines.join("\n") + "\n";
}

export interface GenerateTestsArgs {
  url?: string;
  flowsPath?: string;
  maxFlows?: number;
  save?: boolean;
}

/** Load the frozen text→key mapping produced by figma_import_strings (M6b). */
function loadI18nKeys(runtime: Runtime): Map<string, string> {
  const stringsPath = path.join(runtime.configDirAbs, "design", "strings.json");
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(stringsPath, "utf-8")) as {
      entries?: Array<{ canonicalText?: unknown; key?: unknown; lifecycle?: unknown }>;
    };
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.canonicalText !== "string" || typeof entry.key !== "string") continue;
      if (entry.lifecycle === "unused") continue;
      if (!map.has(entry.canonicalText)) map.set(entry.canonicalText, entry.key);
    }
  } catch {
    /* no strings.json yet: literal-only descriptions */
  }
  return map;
}

export async function figmaGenerateTests(
  runtime: Runtime,
  args: GenerateTestsArgs
): Promise<CallToolResult> {
  try {
    const flowsPath = args.flowsPath
      ? path.resolve(runtime.project.rootDir, args.flowsPath)
      : path.join(runtime.configDirAbs, "design", "flows.json");

    let graph: FlowGraph;
    let source: string;
    if (args.url) {
      const { fileKey } = parseFigmaUrl(args.url);
      const file = (await fetchFile(fileKey)) as { name?: string; document?: FigmaNode };
      if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);
      graph = buildFlowGraph(file.document);
      source = `figma:${fileKey}${file.name ? ` (${file.name})` : ""}`;
    } else {
      if (!fs.existsSync(flowsPath)) {
        throw new Error(`未找到 ${flowsPath}：先运行 figma_extract_flows（或直接传 url）`);
      }
      const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as FlowGraph;
      if (!Array.isArray(parsed.screens) || !Array.isArray(parsed.edges)) {
        throw new Error(`${flowsPath} 格式不正确（缺少 screens/edges）`);
      }
      graph = parsed;
      source = flowsPath;
    }

    const cases = generateTestCases(graph, {
      maxFlows: args.maxFlows ?? 10,
      i18nKeys: loadI18nKeys(runtime)
    });
    const generatedAt = new Date().toISOString();
    const payload: Record<string, unknown> = {
      ok: true,
      source,
      counts: { flows: cases.length, screens: graph.screens.length, edges: graph.edges.length },
      flows: cases,
      hint:
        "用 mobile_run_task 执行 flows[].taskDesc；失败步骤可用 compare_design_and_device 做视觉断言；" +
        "若已跑过 figma_import_strings，步骤中会附带 i18n key（原文仅在 source locale 兜底）。"
    };

    if (args.save !== false) {
      const jsonPath = path.join(runtime.configDirAbs, "design", "tests.json");
      writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
      const markdownPath = path.join(runtime.configDirAbs, "design", "tests.md");
      writeFileAtomic(markdownPath, renderMarkdown(cases, { source, generatedAt }));
      payload.savedTo = { json: jsonPath, markdown: markdownPath };
    }

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: `测试用例生成失败: ${errorMessage(error)}` }, null, 2)
        }
      ],
      isError: true
    };
  }
}
