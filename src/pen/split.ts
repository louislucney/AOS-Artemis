import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";
import { parsePenText, type PenNode } from "./read.js";

export interface SplitPenScreensInput {
  /** 源 .pen 文档（通常是整个设计文件）。 */
  sourceFile: string;
  /** 需要拆出的顶层屏 id（flows.json 的 screen.id）。 */
  screenIds: string[];
  /** 输出目录；文件名为 `<screenId>.pen`。 */
  outDir: string;
  /** 已知渲染为多屏拼图的 screen id（例如渲染宽度远大于手机宽）；强制选第一块单屏。 */
  compositeIds?: string[];
}

export interface SplitPenScreensResult {
  dir: string;
  written: string[];
  /** 已存在且内容一致（未重写）。 */
  unchanged: number;
  skipped: Array<{ id: string; reason: string }>;
}

function findNode(node: PenNode, id: string): PenNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    if (child === null || typeof child !== "object") continue;
    const found = findNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

function safeId(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && path.basename(id) === id;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function walk(node: PenNode, visit: (node: PenNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    if (child !== null && typeof child === "object") walk(child, visit);
  }
}

/** 子树几何（显式宽高优先；否则取子节点坐标跨度）。用于识别“一块画板里并排多屏”的拼图。 */
function boundsOf(node: PenNode): { width: number; height: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  walk(node, (entry) => {
    const x = numeric(entry.x);
    const y = numeric(entry.y);
    const width = numeric(entry.width);
    const height = numeric(entry.height);
    if (x !== null && width !== null) xs.push(x, x + width);
    if (y !== null && height !== null) ys.push(y, y + height);
  });
  const ownWidth = numeric(node.width);
  const ownHeight = numeric(node.height);
  const width = ownWidth ?? (xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : null);
  const height = ownHeight ?? (ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : null);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** 多屏画板里选第一块“手机宽屏”（默认状态），避免整板拼图 / 多状态并排成为 diff 基线。 */
function firstScreenLike(node: PenNode, typicalWidth: number): PenNode | null {
  const limit = Math.max(600, typicalWidth * 1.5);
  const phoneWidth = (width: number): boolean =>
    width >= typicalWidth * 0.6 && width <= typicalWidth * 1.4;
  const screenTall = (height: number): boolean => height >= typicalWidth * 0.8;
  const children = (node.children ?? []).filter(
    (child): child is PenNode => child !== null && typeof child === "object"
  );
  const variantKids = (parent: PenNode): PenNode[] =>
    (parent.children ?? []).filter((child): child is PenNode => {
      if (child === null || typeof child !== "object") return false;
      const bounds = boundsOf(child);
      return (
        bounds !== null &&
        phoneWidth(bounds.width) &&
        screenTall(bounds.height) &&
        (child.children?.length ?? 0) > 0
      );
    });
  for (const child of children) {
    const bounds = boundsOf(child);
    if (bounds === null) continue;
    if (bounds.width > limit) {
      const found = firstScreenLike(child, typicalWidth);
      if (found !== null) return found;
      continue;
    }
    const variants = variantKids(child);
    if (variants.length >= 2) return variants[0]!;
    if (phoneWidth(bounds.width) && (child.children?.length ?? 0) > 0) {
      if (screenTall(bounds.height) || (child.children?.length ?? 0) >= 2) return child;
    }
  }
  for (const child of children) {
    const bounds = boundsOf(child);
    if (bounds !== null && bounds.width <= limit) continue;
    const found = firstScreenLike(child, typicalWidth);
    if (found !== null) return found;
  }
  return null;
}

/** 把整份 .pen 里指定屏拆成单屏 .pen（顶层只留该屏，原点归零）。
 * 逐屏文件是 ui-contract / 逐屏设计对比的基线；拆分不复制引用其它屏的组件定义，
 * 屏内 `ref` 由源文档保留的顶层字段（variables/themes/fileToken）解析。 */
export function splitPenScreens(input: SplitPenScreensInput): SplitPenScreensResult {
  const doc = parsePenText(fs.readFileSync(input.sourceFile, "utf-8"));
  fs.mkdirSync(input.outDir, { recursive: true });
  const written: string[] = [];
  let unchanged = 0;
  const skipped: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  const nodes = new Map<string, PenNode>();
  for (const id of input.screenIds) {
    if (seen.has(id) || !safeId(id)) continue;
    seen.add(id);
    const node =
      (doc.children ?? [])
        .map((child) => (child !== null && typeof child === "object" ? findNode(child, id) : null))
        .find((candidate): candidate is PenNode => candidate !== null) ?? null;
    if (node !== null) nodes.set(id, node);
  }
  const phoneWidths = [...nodes.values()]
    .map((node) => boundsOf(node)?.width ?? null)
    .filter((width): width is number => width !== null && width >= 300 && width <= 600);
  const typicalWidth = median(phoneWidths) ?? 375;
  const processed = new Set<string>();
  const forcedComposite = new Set(input.compositeIds ?? []);

  for (const id of input.screenIds) {
    if (processed.has(id)) continue;
    processed.add(id);
    if (!safeId(id)) {
      skipped.push({ id, reason: "id 不能作为文件名" });
      continue;
    }
    let node = nodes.get(id) ?? null;
    if (node === null) {
      skipped.push({ id, reason: "源文档没有该节点" });
      continue;
    }
    const bounds = boundsOf(node);
    if (
      forcedComposite.has(id) ||
      (bounds !== null && bounds.width > Math.max(600, typicalWidth * 1.5))
    ) {
      node = firstScreenLike(node, typicalWidth) ?? node;
    }
    const screen: PenNode = { ...node, x: 0, y: 0 };
    const payload = JSON.stringify({ ...doc, children: [screen] }, null, 2) + "\n";
    const file = path.join(input.outDir, `${id}.pen`);
    try {
      if (fs.readFileSync(file, "utf-8") === payload) {
        unchanged += 1;
        continue;
      }
    } catch {
      /* 不存在或不可读：继续写 */
    }
    writeFileAtomic(file, payload);
    written.push(id);
  }

  return { dir: input.outDir, written, unchanged, skipped };
}
