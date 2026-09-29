import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";
import { parsePenText, summarizePen, validatePen } from "./read.js";

export interface PenInspectArgs {
  path?: string;
  save?: boolean;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const HINT =
  "先获得 .pen 文件（pen.dev 桌面/IDE 导入 .fig 或从 Figma 粘贴后保存到项目；本仓库 scripts/figma-to-pen.mjs 也可从 Figma REST 转换），或在 path 里显式指定文件。";

function newestPen(designDir: string): string | null {
  if (!fs.existsSync(designDir)) return null;
  const files = fs
    .readdirSync(designDir)
    .filter((name) => name.endsWith(".pen"))
    .map((name) => path.join(designDir, name));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

export async function penInspect(runtime: Runtime, args: PenInspectArgs): Promise<CallToolResult> {
  try {
    const designDir = path.join(runtime.configDirAbs, "design");
    const target = args.path
      ? path.isAbsolute(args.path)
        ? args.path
        : path.join(runtime.project.rootDir, args.path)
      : newestPen(designDir);
    if (!target) {
      return jsonResult({ ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: HINT }, true);
    }
    if (!fs.existsSync(target)) {
      return jsonResult({ ok: false, error: `文件不存在：${target}`, hint: HINT }, true);
    }

    const doc = parsePenText(fs.readFileSync(target, "utf-8"));
    const validation = validatePen(doc);
    const summary = summarizePen(doc);
    const missingImages = summary.images.filter((url) => {
      if (!url.startsWith("./") && !url.startsWith("../")) return false;
      return !fs.existsSync(path.resolve(path.dirname(target), url));
    });

    let savedTo: string | undefined;
    if (args.save === true) {
      const outDir = path.join(designDir, "pen");
      fs.mkdirSync(outDir, { recursive: true });
      savedTo = path.join(outDir, "summary.json");
      fs.writeFileSync(savedTo, JSON.stringify({ file: target, ...summary, validation }, null, 2), "utf-8");
    }

    const payload = {
      ok: validation.errors.length === 0,
      file: path.relative(runtime.project.rootDir, target),
      version: summary.version,
      counts: {
        topLevel: summary.topLevel,
        nodes: summary.totalNodes,
        screens: summary.screens.length,
        components: summary.components.length,
        instances: summary.instances,
        texts: summary.texts,
        variables: summary.variables.total,
        images: summary.images.length,
        missingImages: missingImages.length
      },
      byType: summary.byType,
      screens: summary.screens.slice(0, 20),
      components: summary.components.slice(0, 20),
      textSamples: summary.textSamples,
      variablesByType: summary.variables.byType,
      themes: summary.themes,
      missingImages: missingImages.slice(0, 10),
      errors: validation.errors,
      warnings: validation.warnings,
      savedTo,
      hint: "离线解析（无账号/网络需求）；tokens/strings/brief 的 pen 侧导出沿用同一读取层，后续里程碑接入。"
    };
    return jsonResult(payload, validation.errors.length > 0);
  } catch (error) {
    return jsonResult({ ok: false, error: `pen 解析失败: ${errorMessage(error)}`, hint: HINT }, true);
  }
}
