import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";
import { summarizePen, validatePen } from "./read.js";

export interface PenInspectArgs {
  path?: string;
  save?: boolean;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penInspect(runtime: Runtime, args: PenInspectArgs): Promise<CallToolResult> {
  try {
    const designDir = path.join(runtime.configDirAbs, "design");
    const target = resolvePenTarget(runtime, args.path);
    if (!target) {
      return jsonResult({ ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: PEN_HINT }, true);
    }

    const doc = loadPenDocument(target);
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
      file: penRelativePath(runtime, target),
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
      hint: "离线解析（无账号/网络需求）；tokens/strings/brief 导出见 pen_import_tokens / pen_import_strings / pen_export_brief。"
    };
    return jsonResult(payload, validation.errors.length > 0);
  } catch (error) {
    return jsonResult({ ok: false, error: `pen 解析失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  }
}
