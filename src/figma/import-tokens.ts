import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { extractDesignSystem } from "../vendor/design-context-bridge/figma-rest/analysis.js";
import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { detectProjectStacks, primaryProfile, skippedStacksWarnings } from "../projects/stack.js";
import {
  loadTokenOverrides,
  mergeColorTokens,
  parseCanonicalTokens,
  renderStackTokenFile,
  scanHardcodedColors,
  serializeTokens,
  skippedTokenFiles,
  writeStackTokenFile
} from "./color.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

export type Enforcement = "report" | "warn" | "block";

export interface ImportTokensArgs {
  url: string;
  dryRun?: boolean;
  overwrite?: boolean;
  save?: boolean;
  enforcement?: Enforcement;
}

interface DesignColorPayload {
  hex: string;
  usageCount: number;
  sampleLayers: string[];
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const TOKEN_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（项目 .env 或调用 aos_configure 携带 figmaToken）；token-names.json 可人工指定颜色 token 名。";

export async function figmaImportTokens(
  runtime: Runtime,
  args: ImportTokensArgs
): Promise<CallToolResult> {
  try {
    const { fileKey } = parseFigmaUrl(args.url);
    const file = (await fetchFile(fileKey)) as { document?: FigmaNode };
    if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);
    const designSystem = extractDesignSystem(file.document) as { colors?: DesignColorPayload[] };
    const designColors = designSystem.colors ?? [];

    const designDir = path.join(runtime.configDirAbs, "design");
    const tokenPath = path.join(designDir, "tokens.json");
    const existingText = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf-8") : "";
    const existing = parseCanonicalTokens(existingText);
    const overrides = loadTokenOverrides(runtime.configDirAbs);
    const merge = mergeColorTokens(designColors, existing, overrides);

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const stackWrite = profile ? renderStackTokenFile(profile, merge.tokens) : null;
    const warnings: string[] = [];
    warnings.push(...skippedStacksWarnings(stacks, profile));

    let stackResult: ReturnType<typeof writeStackTokenFile> | null = null;
    if (stackWrite) {
      stackResult = writeStackTokenFile(runtime.project.rootDir, stackWrite, {
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true
      });
      const skippedUnmanaged = skippedTokenFiles(stackResult);
      if (skippedUnmanaged.length > 0) {
        warnings.push(
          `目标文件非本工具生成，未覆盖：${skippedUnmanaged.join("、")}（确认后用 overwrite:true 覆盖）`
        );
      }
    } else if (!profile) {
      warnings.push("未检测到技术栈：仅更新 canonical tokens.json（不生成栈文件）");
    } else if (!stackWrite) {
      warnings.push(`${profile.displayName} 暂不支持生成 token 文件（M6a 范围外）`);
    }

    const savedTo: string[] = [];
    if (args.dryRun !== true && args.save !== false) {
      writeFileAtomic(tokenPath, serializeTokens(merge.tokens));
      savedTo.push(tokenPath);
    }

    const hardcoded = scanHardcodedColors(runtime.project.rootDir, {
      excludeGlobs: [...(profile?.tokenGlobs ?? []), profile?.i18n.tokenFile ?? ""].filter(Boolean)
    });
    const unused = merge.actions.filter((action) => action.action === "unused");
    const needsReview = merge.tokens.filter((token) => token.needsReview);
    const enforcement = args.enforcement ?? "report";
    const violations = hardcoded.length + unused.length + skippedTokenFiles(stackResult).length;

    const payload: Record<string, unknown> = {
      ok: true,
      dryRun: args.dryRun === true,
      sourceUrl: args.url,
      stack: profile?.id ?? null,
      counts: {
        designColors: designColors.length,
        tokens: merge.tokens.length,
        new: merge.actions.filter((action) => action.action === "new").length,
        unchanged: merge.actions.filter((action) => action.action === "unchanged").length,
        unused: unused.length,
        needsReview: needsReview.length,
        overridesApplied: Object.keys(overrides).length
      },
      tokens: merge.tokens.map((token) => ({
        name: token.name,
        value: token.aliasOf ? `{${token.aliasOf}}` : token.value,
        modes: token.modes,
        needsReview: token.needsReview,
        usageCount: token.usageCount
      })),
      actions: merge.actions,
      stackFile: stackResult,
      hardcodedColors: {
        total: hardcoded.length,
        sample: hardcoded.slice(0, 20)
      },
      unusedTokens: unused.map((action) => action.name),
      enforcement,
      warnings,
      savedTo: savedTo.length > 0 ? savedTo : undefined,
      hint:
        "canonical: .artemis/design/tokens.json（DTCG，modes 已预留）；人工命名：.artemis/design/token-names.json（{overrides:{\"#RRGGBBAA\":\"color.brand.primary\"}}）。"
    };

    if (enforcement === "block" && violations > 0) {
      return jsonResult({ ...payload, blocked: true, blockReason: `发现 ${violations} 项需处理（硬编码色值/未使用 token/未覆盖文件）` }, true);
    }
    if (enforcement === "warn" && violations > 0) {
      warnings.push(`enforcement=warn：${violations} 项问题待处理`);
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `颜色 token 导入失败: ${errorMessage(error)}`, hint: TOKEN_HINT },
      true
    );
  }
}
