import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isGenericLayerName } from "../figma/color.js";
import { runStringsImport, type StringsImportOptions } from "../figma/import-strings.js";
import {
  canonicalizePlaceholders,
  normalizedText,
  type FigmaTextRecord
} from "../figma/strings.js";
import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";
import type { PenDocument, PenNode } from "./read.js";

export interface PenStringsArgs extends StringsImportOptions {
  path?: string;
}

const MAX_TEXTS = 500;

interface CollectContext {
  screen: string;
  ancestors: string[];
}

function elementHintFor(layer: string, context: CollectContext): string {
  if (!isGenericLayerName(layer)) return layer;
  for (let index = context.ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = context.ancestors[index]!;
    if (candidate !== context.screen && !isGenericLayerName(candidate)) return candidate;
  }
  return layer;
}

function collectFromNode(node: PenNode, context: CollectContext, out: FigmaTextRecord[]): void {
  const isComponent = node.reusable === true;
  const name = typeof node.name === "string" ? node.name : "";
  const next: CollectContext = isComponent
    ? { screen: name || context.screen, ancestors: [] }
    : { screen: context.screen, ancestors: [...context.ancestors, name] };

  if (node.type === "text") {
    const raw = typeof node.content === "string" ? node.content : "";
    const characters = normalizedText(raw);
    if (characters !== "") {
      const { canonicalText, placeholders } = canonicalizePlaceholders(characters);
      const dynamic =
        /\$\{|\{\{/.test(characters) || /^\$[A-Za-z_][\w.-]*$/.test(characters);
      const layer = name || "text";
      out.push({
        nodeId: typeof node.id === "string" ? node.id : "",
        characters,
        canonicalText,
        screen: context.screen || "app",
        layer,
        element: elementHintFor(layer, context),
        placeholders,
        needsContext: dynamic,
        needsRename: isGenericLayerName(layer)
      });
    }
    return;
  }

  if (node.type === "ref") return;
  for (const child of node.children ?? []) {
    if (!child || typeof child !== "object") continue;
    collectFromNode(child, next, out);
    if (out.length >= MAX_TEXTS) return;
  }
}

export function collectPenTexts(doc: PenDocument): FigmaTextRecord[] {
  const records: FigmaTextRecord[] = [];
  for (const top of doc.children ?? []) {
    if (!top || typeof top !== "object") continue;
    const screen = typeof top.name === "string" && top.name ? top.name : "app";
    collectFromNode(top, { screen, ancestors: [] }, records);
    if (records.length >= MAX_TEXTS) return records;
  }
  return records;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penImportStrings(
  runtime: Runtime,
  args: PenStringsArgs
): Promise<CallToolResult> {
  try {
    const target = resolvePenTarget(runtime, args.path);
    if (!target) {
      return jsonResult(
        { ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: PEN_HINT },
        true
      );
    }
    const doc = loadPenDocument(target);
    return await runStringsImport(
      runtime,
      collectPenTexts(doc),
      penRelativePath(runtime, target),
      args,
      PEN_HINT
    );
  } catch (error) {
    return jsonResult(
      { ok: false, error: `文案 i18n 导入失败: ${errorMessage(error)}`, hint: PEN_HINT },
      true
    );
  }
}
