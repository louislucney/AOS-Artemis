import fs from "node:fs";
import path from "node:path";

import { detectPenFailure, penEnvFrom, runPenExport, type PenExecFn } from "../pen/cli.js";
import { ensurePenCli, type PenEnsureFn } from "../pen/install.js";
import { loadPenDocument, penRelativePath, resolvePenTarget } from "../pen/paths.js";
import type { PenDocument, PenNode } from "../pen/read.js";
import { penVariableDefaultHex } from "../pen/tokens.js";
import type { Runtime } from "../runtime.js";
import type { DesignNode } from "./engine.js";

export interface PenRender {
  png: Buffer;
  nodes: DesignNode[];
  penPath: string;
  output: string;
}

export interface PenRenderOptions {
  penPath?: string;
  renderOut?: string;
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fillHexOf(node: PenNode, variables: Record<string, { type?: string; value?: unknown }>): string | null {
  const fill = node.fill;
  if (typeof fill !== "string") return null;
  if (fill.startsWith("$")) return penVariableDefaultHex(variables[fill.slice(1)], variables);
  return /^#[0-9a-fA-F]{3,8}$/.test(fill) ? fill : null;
}

export function penDesignNodes(doc: PenDocument): DesignNode[] {
  const variables = doc.variables ?? {};
  const nodes: DesignNode[] = [];
  const visit = (
    node: PenNode,
    parentX: number,
    parentY: number,
    parentFlex: boolean,
    inheritedFill: string | undefined,
    depth: number
  ): void => {
    const x = numeric(node.x);
    const y = numeric(node.y);
    const width = numeric(node.width);
    const height = numeric(node.height);
    if (parentFlex && node.layoutPosition !== "absolute") return;
    const absX = parentX + (x ?? 0);
    const absY = parentY + (y ?? 0);
    const hasGeometry = x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0;
    const ownFill = fillHexOf(node, variables);
    if (hasGeometry && typeof node.id === "string" && node.id.length > 0) {
      nodes.push({
        id: node.id,
        name: typeof node.name === "string" ? node.name : "",
        type: typeof node.type === "string" ? node.type : "unknown",
        x: absX,
        y: absY,
        width,
        height,
        depth,
        ...(typeof node.content === "string" && node.content ? { text: node.content } : {}),
        ...(inheritedFill ? { parentFill: inheritedFill } : {})
      });
    }
    const layout = typeof node.layout === "string" ? node.layout : "none";
    const childFill = ownFill ?? inheritedFill;
    for (const child of node.children ?? []) {
      if (child && typeof child === "object") visit(child, absX, absY, layout !== "none", childFill, depth + 1);
    }
  };
  for (const child of doc.children ?? []) {
    if (child && typeof child === "object") visit(child, 0, 0, false, undefined, 0);
  }
  return nodes;
}

export async function renderPenDesign(
  runtime: Runtime,
  options: PenRenderOptions = {}
): Promise<PenRender> {
  const target = resolvePenTarget(runtime, options.penPath);
  if (!target) throw new Error("没有找到 .pen 文件（.artemis/design 下无 *.pen）");
  const doc = loadPenDocument(target);
  const output = options.renderOut
    ? path.resolve(runtime.project.rootDir, options.renderOut)
    : path.join(runtime.configDirAbs, "design", "pen", `${path.basename(target, ".pen")}.png`);

  const env = penEnvFrom(runtime.project.dotenvValues, process.env);
  const ready = await (options.ensure ?? ensurePenCli)({ env });
  if (!ready.ok) throw new Error(ready.error ?? "pen CLI 不可用");

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const existedBefore = fs.existsSync(output);
  const run = await runPenExport({
    input: target,
    output,
    format: "png",
    scale: 1,
    exec: options.exec,
    cliPath: ready.path ?? undefined,
    env
  });
  const failure = detectPenFailure(run.result, run.log);
  if (failure || !run.saved) {
    if (!existedBefore) {
      try {
        fs.rmSync(output, { force: true });
      } catch {
        /* best effort */
      }
    }
    throw new Error(failure ?? "pen 渲染未产出文件（检查 .pen 内容与登录状态）");
  }
  return {
    png: fs.readFileSync(output),
    nodes: penDesignNodes(doc),
    penPath: penRelativePath(runtime, target),
    output
  };
}
