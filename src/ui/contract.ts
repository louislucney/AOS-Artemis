import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { pngDimensions } from "../design/screens.js";
import type { PenTextBound } from "../pen/bounds.js";
import { loadPenDocument } from "../pen/paths.js";
import type { PenNode } from "../pen/read.js";
import type { Runtime } from "../runtime.js";
import { writeFileAtomic } from "../util.js";

export type UiContractStatus = "extracted" | "partial" | "unverifiable" | "no-baseline";
export type UiGeometryStatus = "extracted" | "partial" | "unverifiable";

export interface UiTextContract {
  id: string;
  content: string;
  fontFamily: string | null;
  fontWeight: number | null;
  fontSize: number | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  bboxSpace: "design-px";
  geometryStatus: UiGeometryStatus;
}

export interface UiScreenContract {
  id: string;
  name: string;
  sourceFrameName: string | null;
  presentation: "screen" | "unknown";
  status: UiContractStatus;
  geometry: { nodes: number; withGeometry: number; missingGeometry: number };
  tokens: {
    cornerRadius: number[];
    colors: string[];
    fontFamilies: string[];
    fontSizes: number[];
    fontWeights: string[];
    spacing: number[];
  };
  components: Array<{ name: string; type: string }>;
  texts: UiTextContract[];
  render: string | null;
  renderScale: number | null;
  /** Design frame width in design px; used to map text bbox to render pixels. */
  frameWidth: number | null;
  warnings: string[];
}

export interface UiContract {
  schemaVersion: 1;
  generatedAt: string;
  source: { flows: string; designRoot: string; fingerprint: string };
  screens: UiScreenContract[];
  summary: Record<UiContractStatus, number>;
  warnings: string[];
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numbers(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  return [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value.toFixed(2))))].sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function walkPen(
  node: PenNode,
  visit: (node: PenNode) => void
): void {
  visit(node);
  for (const child of node.children ?? []) {
    if (child && typeof child === "object") walkPen(child, visit);
  }
}

export function normalizeFontWeight(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[\s_-]/g, "");
  const aliases: Record<string, number> = {
    thin: 100,
    hairline: 100,
    extralight: 200,
    ultralight: 200,
    light: 300,
    regular: 400,
    normal: 400,
    book: 400,
    medium: 500,
    semibold: 600,
    demibold: 600,
    bold: 700,
    extrabold: 800,
    heavy: 800,
    black: 900
  };
  if (aliases[key] !== undefined) return aliases[key];
  const numericWeight = Number.parseInt(key, 10);
  return Number.isFinite(numericWeight) ? numericWeight : null;
}

function inspectPen(file: string): {
  tokens: UiScreenContract["tokens"];
  components: Array<{ name: string; type: string }>;
  texts: UiTextContract[];
  geometry: UiScreenContract["geometry"];
  frameWidth: number | null;
} {
  const doc = loadPenDocument(file);
  const cornerRadius: number[] = [];
  const colors: string[] = [];
  const fontFamilies: string[] = [];
  const fontSizes: number[] = [];
  const fontWeights: string[] = [];
  const spacing: number[] = [];
  const components: Array<{ name: string; type: string }> = [];
  const texts: UiTextContract[] = [];
  let nodes = 0;
  let withGeometry = 0;

  const visit = (node: PenNode): void => {
    nodes += 1;
    const width = numeric(node.width);
    const height = numeric(node.height);
    const x = numeric(node.x);
    const y = numeric(node.y);
    if (x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0) {
      withGeometry += 1;
    }
    cornerRadius.push(...numbers(node.cornerRadius));
    if (typeof node.fill === "string" && node.fill.startsWith("#")) colors.push(node.fill);
    if (typeof node.fontFamily === "string") fontFamilies.push(node.fontFamily);
    if (typeof node.fontSize === "number") fontSizes.push(node.fontSize);
    if (typeof node.fontWeight === "string") fontWeights.push(node.fontWeight);
    spacing.push(...numbers(node.gap), ...numbers(node.padding));
    if (typeof node.name === "string" && typeof node.type === "string") {
      components.push({ name: node.name, type: node.type });
    }
    if (typeof node.content === "string" && node.content.trim() !== "") {
      const geometryFields = [x, y, width, height].filter((value) => value !== null).length;
      texts.push({
        id: typeof node.id === "string" ? node.id : "",
        content: node.content,
        fontFamily: typeof node.fontFamily === "string" ? node.fontFamily : null,
        fontWeight: normalizeFontWeight(node.fontWeight),
        fontSize: numeric(node.fontSize),
        bbox:
          x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0
            ? { x, y, width, height }
            : null,
        bboxSpace: "design-px",
        geometryStatus:
          geometryFields === 4 ? "extracted" : geometryFields === 0 ? "unverifiable" : "partial"
      });
    }
  };
  for (const child of doc.children ?? []) {
    if (child && typeof child === "object") walkPen(child, visit);
  }
  const firstFrame = (doc.children ?? []).find(
    (child) => child && typeof child === "object" && numeric(child.width) !== null
  );
  const frameWidth = firstFrame ? numeric(firstFrame.width) : null;

  return {
    tokens: {
      cornerRadius: uniqueNumbers(cornerRadius),
      colors: uniqueStrings(colors),
      fontFamilies: uniqueStrings(fontFamilies),
      fontSizes: uniqueNumbers(fontSizes),
      fontWeights: uniqueStrings(fontWeights),
      spacing: uniqueNumbers(spacing)
    },
    components: components.slice(0, 80),
    texts,
    geometry: {
      nodes,
      withGeometry,
      missingGeometry: Math.max(0, nodes - withGeometry)
    },
    frameWidth
  };
}

function penFileFor(designRoot: string, screenId: string): string | null {
  const candidates = [
    path.join(designRoot, "pen", "screens", `${screenId}.pen`),
    path.join(designRoot, "pen", `${screenId}.pen`)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function renderFor(designRoot: string, screenId: string): string | null {
  const candidates = [
    path.join(designRoot, "screens", "pen-untitled", `${screenId}.png`),
    path.join(designRoot, "pen", "screens", `${screenId}.png`)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function statusOf(hasPen: boolean, geometry: UiScreenContract["geometry"]): UiContractStatus {
  if (!hasPen) return "no-baseline";
  if (geometry.nodes === 0 || geometry.withGeometry === 0) return "unverifiable";
  if (geometry.missingGeometry > 0) return "partial";
  return "extracted";
}

function fingerprintOf(flowsPath: string, designRoot: string): string {
  const hash = createHash("sha256");
  const flows = fs.readFileSync(flowsPath);
  hash.update(flows);
  const screensDir = path.join(designRoot, "pen", "screens");
  let names: string[] = [];
  try {
    names = fs.readdirSync(screensDir).filter((name) => name.endsWith(".pen")).sort();
  } catch {
    /* no split pen files */
  }
  for (const name of names) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(screensDir, name)));
  }
  return hash.digest("hex");
}

/** ui-lint 的契约漂移校验（DESIGN §13.220）：与 `suite ui-contract` 同源指纹。 */
export function uiContractFingerprint(flowsPath: string, designRoot: string): string {
  return fingerprintOf(flowsPath, designRoot);
}

function readFlows(flowsPath: string): Array<{ id: string; name: string; sourceFrameName?: string }> {
  const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as {
    screens?: Array<{ id?: unknown; name?: unknown; sourceFrameName?: unknown }>;
  };
  const screens = Array.isArray(parsed.screens) ? parsed.screens : [];
  return screens
    .filter(
      (screen): screen is { id: string; name: string; sourceFrameName?: string } =>
        typeof screen?.id === "string" && screen.id.length > 0 && typeof screen?.name === "string"
    )
    .map((screen) => ({
      id: screen.id,
      name: screen.name,
      ...(typeof screen.sourceFrameName === "string" ? { sourceFrameName: screen.sourceFrameName } : {})
    }));
}

export interface BuildUiContractOptions {
  /** Design directory; defaults to `<configDir>/design`. */
  designRoot?: string;
  outDir?: string;
  /** Optional pen CLI bounds provider for auto-layout text geometry. */
  boundsProvider?: (penFile: string) => PenTextBound[];
}

export interface UiContractBuildResult {
  contract: UiContract;
  jsonPath: string;
  markdownPath: string;
}

export function buildUiContract(
  runtime: Runtime,
  options: BuildUiContractOptions = {}
): UiContractBuildResult {
  const designRoot = path.resolve(options.designRoot ?? path.join(runtime.configDirAbs, "design"));
  const flowsPath = path.join(designRoot, "flows.json");
  if (!fs.existsSync(flowsPath)) {
    throw new Error(`缺少 flows.json：${flowsPath}`);
  }
  const screens = readFlows(flowsPath);
  if (screens.length === 0) throw new Error(`flows.json 没有 screens：${flowsPath}`);

  const warnings: string[] = [];
  const contracts: UiScreenContract[] = screens.map((screen) => {
    const penFile = penFileFor(designRoot, screen.id);
    const render = renderFor(designRoot, screen.id);
    const screenWarnings: string[] = [];
    if (penFile === null) {
      screenWarnings.push("没有逐屏 .pen，只有渲染 PNG；token/几何不可核验");
    }
    if (render === null && penFile === null) {
      screenWarnings.push("没有逐屏渲染 PNG 或 .pen");
    }
    let inspected: ReturnType<typeof inspectPen> | null = null;
    if (penFile !== null) {
      try {
        inspected = inspectPen(penFile);
      } catch (error) {
        screenWarnings.push(`解析 .pen 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (inspected !== null && inspected.geometry.withGeometry === 0) {
      screenWarnings.push("节点无显式几何（auto-layout/组件实例）；几何不可核验");
    }
    if (inspected !== null && inspected.geometry.missingGeometry > 0) {
      screenWarnings.push(
        `部分节点无显式几何（${inspected.geometry.missingGeometry}/${inspected.geometry.nodes}）`
      );
    }
    let texts = inspected?.texts ?? [];
    if (options.boundsProvider !== undefined && penFile !== null && texts.length > 0) {
      try {
        const byId = new Map(options.boundsProvider(penFile).map((entry) => [entry.id, entry]));
        let resolved = 0;
        texts = texts.map((text) => {
          const bound = byId.get(text.id);
          if (!bound) return text;
          resolved += 1;
          return {
            ...text,
            bbox: { x: bound.x, y: bound.y, width: bound.width, height: bound.height },
            geometryStatus: "extracted" as const
          };
        });
        if (resolved > 0) screenWarnings.push(`pen CLI 解析文本几何 ${resolved}/${texts.length}`);
      } catch (error) {
        screenWarnings.push(
          `pen CLI 文本几何失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const status = statusOf(inspected !== null, inspected?.geometry ?? { nodes: 0, withGeometry: 0, missingGeometry: 0 });
    if (status === "no-baseline") warnings.push(`${screen.id} ${screen.name}: no-baseline`);
    return {
      id: screen.id,
      name: screen.name,
      sourceFrameName: screen.sourceFrameName ?? null,
      presentation: "screen",
      status,
      geometry: inspected?.geometry ?? { nodes: 0, withGeometry: 0, missingGeometry: 0 },
      tokens: inspected?.tokens ?? {
        cornerRadius: [],
        colors: [],
        fontFamilies: [],
        fontSizes: [],
        fontWeights: [],
        spacing: []
      },
      components: inspected?.components ?? [],
      texts,
      render: render === null ? null : path.relative(runtime.project.rootDir, render),
      renderScale:
        render !== null && inspected?.frameWidth !== null && inspected?.frameWidth !== undefined
          ? (() => {
              const dims = pngDimensions(fs.readFileSync(render));
              return dims && inspected.frameWidth! > 0
                ? Number((dims.width / inspected.frameWidth!).toFixed(3))
                : null;
            })()
          : null,
      frameWidth: inspected?.frameWidth ?? null,
      warnings: screenWarnings
    };
  });

  const summary: Record<UiContractStatus, number> = {
    extracted: 0,
    partial: 0,
    unverifiable: 0,
    "no-baseline": 0
  };
  for (const screen of contracts) summary[screen.status] += 1;

  const contract: UiContract = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      flows: path.relative(runtime.project.rootDir, flowsPath),
      designRoot: path.relative(runtime.project.rootDir, designRoot),
      fingerprint: fingerprintOf(flowsPath, designRoot)
    },
    screens: contracts,
    summary,
    warnings
  };

  const outDir = path.resolve(options.outDir ?? designRoot);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "ui-contract.json");
  const markdownPath = path.join(outDir, "ui-contract.md");
  writeFileAtomic(jsonPath, JSON.stringify(contract, null, 2) + "\n");
  writeFileAtomic(markdownPath, renderUiContractMarkdown(contract));
  return { contract, jsonPath, markdownPath };
}

export function renderUiContractMarkdown(contract: UiContract): string {
  const lines = [
    "# UI 契约（由 flows.json + .pen 投影）",
    "",
    `> 生成时间：${contract.generatedAt}`,
    `> 设计源：\`${contract.source.designRoot}\` · 指纹：\`${contract.source.fingerprint}\``,
    `> 状态：extracted ${contract.summary.extracted} / partial ${contract.summary.partial} / unverifiable ${contract.summary.unverifiable} / no-baseline ${contract.summary["no-baseline"]}`,
    "",
    "| 屏幕 | 状态 | 几何 | 文本 | 圆角 | 字号 | 字体 | 间距 |",
    "|---|---|---|---|---|---|---|---|"
  ];
  for (const screen of contract.screens) {
    const textWeights = uniqueNumbers(
      screen.texts
        .map((text) => text.fontWeight)
        .filter((weight): weight is number => weight !== null)
    );
    lines.push(
      `| ${screen.name} (\`${screen.id}\`) | ${screen.status} | ${screen.geometry.withGeometry}/${screen.geometry.nodes} | ${screen.texts.length} 条（${textWeights.join(", ") || "—"}） | ${screen.tokens.cornerRadius.join(", ") || "—"} | ${screen.tokens.fontSizes.join(", ") || "—"} | ${screen.tokens.fontFamilies.join(", ") || "—"} | ${screen.tokens.spacing.join(", ") || "—"} |`
    );
  }
  lines.push("", "## 逐屏说明", "");
  for (const screen of contract.screens) {
    lines.push(`### ${screen.name} (\`${screen.id}\`)`, "");
    lines.push(`- 状态：**${screen.status}**；presentation：**${screen.presentation}**`);
    if (screen.render) lines.push(`- 渲染图：\`${screen.render}\``);
    lines.push(`- 圆角：${screen.tokens.cornerRadius.join(", ") || "（未提取）"}`);
    lines.push(`- 颜色：${screen.tokens.colors.join(", ") || "（未提取）"}`);
    lines.push(`- 字体：${screen.tokens.fontFamilies.join(", ") || "（未提取）"} · 字号：${screen.tokens.fontSizes.join(", ") || "（未提取）"} · 字重：${screen.tokens.fontWeights.join(", ") || "（未提取）"}`);
    lines.push(
      `- 文本节点：${screen.texts.length} 条（有几何 ${screen.texts.filter((text) => text.geometryStatus === "extracted").length}）`
    );
    lines.push(`- 间距：${screen.tokens.spacing.join(", ") || "（未提取）"}`);
    if (screen.warnings.length > 0) {
      lines.push(`- 警告：${screen.warnings.join("；")}`);
    }
    lines.push("");
  }
  if (contract.warnings.length > 0) {
    lines.push("## 整体警告", "", ...contract.warnings.map((warning) => `- ${warning}`), "");
  }
  return lines.join("\n");
}
