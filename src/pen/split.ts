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

  for (const id of input.screenIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!safeId(id)) {
      skipped.push({ id, reason: "id 不能作为文件名" });
      continue;
    }
    const node =
      (doc.children ?? [])
        .map((child) => (child !== null && typeof child === "object" ? findNode(child, id) : null))
        .find((candidate): candidate is PenNode => candidate !== null) ?? null;
    if (node === null) {
      skipped.push({ id, reason: "源文档没有该节点" });
      continue;
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
