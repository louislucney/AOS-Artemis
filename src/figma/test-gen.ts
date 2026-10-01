import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import ExcelJS from "exceljs";

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

export interface WorkbookMeta {
  source: string;
  generatedAt: string;
  counts: { cases: number; screens: number; edges: number };
}

const WORKBOOK_SHEET = "测试用例";
const WORKBOOK_HEADERS = ["#", "用例名称", "涉及页面", "步骤", "artemis 任务描述"];
const CASE_PLACEHOLDER = /\{\{\s*(index|case\.[A-Za-z][\w]*)\s*\}\}/;
const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;
const SINGLE_PLACEHOLDER = /^\s*\{\{\s*([A-Za-z][\w.]*)\s*\}\}\s*$/;
const NUMERIC_PLACEHOLDERS = new Set(["index", "counts.cases", "counts.screens", "counts.edges"]);

function substitute(text: string, resolve: (key: string) => string | undefined): string {
  return text.replace(PLACEHOLDER, (match, key: string) => resolve(key) ?? match);
}

function fillCell(cell: ExcelJS.Cell, resolve: (key: string) => string | undefined): void {
  if (typeof cell.value !== "string") return;
  const raw = cell.value;
  const single = raw.match(SINGLE_PLACEHOLDER);
  if (single) {
    const key = single[1]!;
    const value = resolve(key);
    if (value === undefined) return;
    cell.value = NUMERIC_PLACEHOLDERS.has(key) ? Number(value) : value;
    if (typeof cell.value === "string" && value.includes("\n")) {
      cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
    }
    return;
  }
  const next = substitute(raw, resolve);
  if (next === raw) return;
  cell.value = next;
  if (next.includes("\n")) cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
}

function casePlaceholderValues(testCase: GeneratedTest, index: number): Map<string, string> {
  return new Map([
    ["index", String(index + 1)],
    ["case.name", testCase.name],
    ["case.screens", testCase.screens.join(" → ")],
    ["case.steps", testCase.steps.map((step, stepIndex) => `${stepIndex + 1}) ${step}`).join("\n")],
    ["case.taskDesc", testCase.taskDesc]
  ]);
}

function metaPlaceholderValues(meta: WorkbookMeta): Map<string, string> {
  return new Map([
    ["meta.source", meta.source],
    ["meta.generatedAt", meta.generatedAt],
    ["counts.cases", String(meta.counts.cases)],
    ["counts.screens", String(meta.counts.screens)],
    ["counts.edges", String(meta.counts.edges)]
  ]);
}

function findCaseTemplateRow(sheet: ExcelJS.Worksheet): number | null {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    let hit = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === "string" && CASE_PLACEHOLDER.test(cell.value)) hit = true;
    });
    if (hit) return rowNumber;
  }
  return null;
}

/** Fill a user workbook: the first row holding a case-level placeholder is
 * replicated per case (styles preserved), then `{{meta.*}}`/`{{counts.*}}`
 * are substituted everywhere. Unknown placeholders stay verbatim. */
function applyTemplate(workbook: ExcelJS.Workbook, cases: GeneratedTest[], meta: WorkbookMeta): void {
  const metaMap = metaPlaceholderValues(meta);
  let templateRows = 0;
  for (const sheet of workbook.worksheets) {
    const templateRow = findCaseTemplateRow(sheet);
    if (templateRow === null) continue;
    templateRows += 1;
    if (cases.length === 0) {
      sheet.spliceRows(templateRow, 1);
      continue;
    }
    if (cases.length > 1) sheet.duplicateRow(templateRow, cases.length - 1, true);
    cases.forEach((testCase, index) => {
      const row = sheet.getRow(templateRow + index);
      const caseMap = casePlaceholderValues(testCase, index);
      row.eachCell({ includeEmpty: false }, (cell) => {
        fillCell(cell, (key) => caseMap.get(key) ?? metaMap.get(key));
      });
    });
  }
  if (templateRows === 0) {
    throw new Error("Excel 模版缺少行级占位符（如 {{case.name}}、{{index}}）");
  }
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        fillCell(cell, (key) => metaMap.get(key));
      });
    });
  }
}

function defaultTestsWorkbook(cases: GeneratedTest[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(WORKBOOK_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: WORKBOOK_HEADERS[0], key: "index", width: 5 },
    { header: WORKBOOK_HEADERS[1], key: "name", width: 36 },
    { header: WORKBOOK_HEADERS[2], key: "screens", width: 30 },
    { header: WORKBOOK_HEADERS[3], key: "steps", width: 60 },
    { header: WORKBOOK_HEADERS[4], key: "taskDesc", width: 70 }
  ];
  sheet.getRow(1).font = { bold: true };
  cases.forEach((testCase, index) => {
    const row = sheet.addRow({
      index: index + 1,
      name: testCase.name,
      screens: testCase.screens.join(" → "),
      steps: testCase.steps.map((step, stepIndex) => `${stepIndex + 1}) ${step}`).join("\n"),
      taskDesc: testCase.taskDesc
    });
    row.getCell(4).alignment = { wrapText: true, vertical: "top" };
    row.getCell(5).alignment = { wrapText: true, vertical: "top" };
  });
  return workbook;
}

/** Render the generated cases as an .xlsx buffer: a ready-to-use sheet by
 * default, or a filled `{{...}}` template when `options.templatePath` is set. */
export async function renderTestsWorkbook(
  cases: GeneratedTest[],
  meta: WorkbookMeta,
  options: { templatePath?: string } = {}
): Promise<Buffer> {
  if (!options.templatePath) {
    const workbook = defaultTestsWorkbook(cases);
    workbook.creator = "aos-mcp";
    workbook.lastModifiedBy = "aos-mcp";
    workbook.description = meta.source;
    const generatedAt = new Date(meta.generatedAt);
    if (!Number.isNaN(generatedAt.getTime())) {
      workbook.created = generatedAt;
      workbook.modified = generatedAt;
    }
    const rendered = await workbook.xlsx.writeBuffer();
    return Buffer.from(rendered);
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(options.templatePath);
  } catch (error) {
    throw new Error(
      `Excel 模版无法读取（仅支持 .xlsx）: ${options.templatePath}（${errorMessage(error)}）`
    );
  }
  applyTemplate(workbook, cases, meta);
  const rendered = await workbook.xlsx.writeBuffer();
  return Buffer.from(rendered);
}

export interface GenerateTestsArgs {
  url?: string;
  flowsPath?: string;
  maxFlows?: number;
  save?: boolean;
  excelPath?: string;
  excelTemplate?: string;
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
    const counts = { cases: cases.length, screens: graph.screens.length, edges: graph.edges.length };
    const payload: Record<string, unknown> = {
      ok: true,
      source,
      counts: { flows: counts.cases, screens: counts.screens, edges: counts.edges },
      flows: cases,
      hint:
        "用 mobile_run_task 执行 flows[].taskDesc；失败步骤可用 compare_design_and_device 做视觉断言；" +
        "若已跑过 figma_import_strings，步骤中会附带 i18n key（原文仅在 source locale 兜底）。"
    };

    if (args.save !== false) {
      const jsonPath = path.join(runtime.configDirAbs, "design", "tests.json");
      const markdownPath = path.join(runtime.configDirAbs, "design", "tests.md");
      const excelPath = args.excelPath
        ? path.resolve(runtime.project.rootDir, args.excelPath)
        : path.join(runtime.configDirAbs, "design", "tests.xlsx");
      const templatePath = args.excelTemplate
        ? path.resolve(runtime.project.rootDir, args.excelTemplate)
        : undefined;
      const excelBuffer = await renderTestsWorkbook(
        cases,
        { source, generatedAt, counts },
        { templatePath }
      );
      writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
      writeFileAtomic(markdownPath, renderMarkdown(cases, { source, generatedAt }));
      writeFileAtomic(excelPath, excelBuffer);
      payload.savedTo = { json: jsonPath, markdown: markdownPath, xlsx: excelPath };
      if (templatePath) payload.excel = { template: templatePath };
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
