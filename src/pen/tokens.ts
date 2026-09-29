import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Enforcement } from "../figma/import-tokens.js";
import { detectProjectStacks, primaryProfile } from "../projects/stack.js";
import {
  normalizeHexColor,
  parseCanonicalTokens,
  renderStackTokenFile,
  scanHardcodedColors,
  serializeTokens,
  writeStackTokenFile,
  type ColorToken,
  type TokenAction
} from "../figma/color.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";
import { collectPenNodes, type PenDocument, type PenVariable } from "./read.js";

export interface PenTokensArgs {
  path?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  save?: boolean;
  enforcement?: Enforcement;
}

interface PaintUsage {
  usageCount: number;
  samples: string[];
}

export interface PenColorInput {
  name: string;
  value: string;
  modes: Record<string, string>;
  aliasOf?: string;
  usageCount: number;
  samples: string[];
}

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const MAX_SAMPLES = 3;

function addUsage(map: Map<string, PaintUsage>, key: string, sample: string): void {
  const entry = map.get(key) ?? { usageCount: 0, samples: [] };
  entry.usageCount += 1;
  if (sample && !entry.samples.includes(sample) && entry.samples.length < MAX_SAMPLES) entry.samples.push(sample);
  map.set(key, entry);
}

export function scanPenPaintUsage(doc: PenDocument): {
  byRef: Map<string, PaintUsage>;
  byHex: Map<string, PaintUsage>;
} {
  const byRef = new Map<string, PaintUsage>();
  const byHex = new Map<string, PaintUsage>();
  const visit = (value: unknown, sample: string): void => {
    if (typeof value === "string") {
      if (value.startsWith("$") && value.length > 1) {
        addUsage(byRef, value.slice(1), sample);
        return;
      }
      if (HEX_RE.test(value)) {
        const hex = normalizeHexColor(value);
        if (hex) addUsage(byHex, hex, sample);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, sample);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item, sample);
    }
  };
  for (const node of collectPenNodes(doc)) {
    const sample = (typeof node.name === "string" && node.name) || node.id || "";
    if (node.fill !== undefined) visit(node.fill, sample);
    if (node.stroke !== undefined) visit(node.stroke, sample);
  }
  return { byRef, byHex };
}

interface PenVariableTerm {
  value?: unknown;
  theme?: Record<string, string>;
}

function termsOf(variable: PenVariable): PenVariableTerm[] {
  const value = variable.value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as PenVariableTerm)
        : { value: item }
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) return [record as PenVariableTerm];
  }
  return [{ value }];
}

function themeKey(theme?: Record<string, string>): string | null {
  if (!theme || typeof theme !== "object") return null;
  const parts = Object.entries(theme)
    .filter(([axis, value]) => axis.length > 0 && typeof value === "string")
    .map(([axis, value]) => `${axis}=${value}`)
    .sort();
  return parts.length > 0 ? parts.join(",") : null;
}

/** Resolve a color variable's base (default-theme) hex, following `$alias` chains. */
export function penVariableDefaultHex(
  variable: PenVariable | undefined,
  variables: Record<string, PenVariable>
): string | null {
  let current = variable;
  const seen = new Set<string>();
  for (let depth = 0; depth < 10 && current; depth += 1) {
    let nextAlias: string | null = null;
    for (const term of termsOf(current)) {
      const raw = typeof term.value === "string" ? term.value.trim() : "";
      if (raw.startsWith("$") && raw.length > 1) {
        nextAlias = raw.slice(1);
        break;
      }
      const hex = normalizeHexColor(raw);
      if (hex) return hex;
    }
    if (!nextAlias || seen.has(nextAlias)) return null;
    seen.add(nextAlias);
    current = variables[nextAlias];
  }
  return null;
}

export interface PenColorExtraction {
  inputs: PenColorInput[];
  skipped: Record<string, number>;
  warnings: string[];
}

export function extractPenColorVariables(doc: PenDocument): PenColorExtraction {
  const variables = doc.variables ?? {};
  const usage = scanPenPaintUsage(doc);
  const inputs: PenColorInput[] = [];
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];

  for (const name of Object.keys(variables).sort()) {
    const variable = variables[name]!;
    const type = typeof variable?.type === "string" ? variable.type : "unknown";
    if (type !== "color") {
      skipped[type] = (skipped[type] ?? 0) + 1;
      continue;
    }
    const resolved: Array<{ hex?: string; alias?: string; key: string | null }> = [];
    for (const term of termsOf(variable)) {
      const key = themeKey(term.theme);
      const raw = typeof term.value === "string" ? term.value.trim() : "";
      if (raw.startsWith("$") && raw.length > 1) {
        const alias = raw.slice(1);
        const target = variables[alias];
        if (target && (target.type ?? "unknown") === "color") resolved.push({ alias, key });
        else warnings.push(`变量 ${name} 引用了不可解析的颜色变量 $${alias}，该取值已忽略`);
        continue;
      }
      const hex = normalizeHexColor(raw);
      if (hex) resolved.push({ hex, key });
      else warnings.push(`变量 ${name} 的取值不是颜色（${JSON.stringify(term.value)}），已忽略`);
    }
    if (resolved.length === 0) {
      skipped.invalid = (skipped.invalid ?? 0) + 1;
      continue;
    }

    const base = resolved[0]!;
    const modes: Record<string, string> = {};
    let value: string;
    let aliasOf: string | undefined;
    if (base.alias) {
      aliasOf = base.alias;
      value = `{${base.alias}}`;
      modes.default = value;
    } else {
      value = base.hex!;
      modes.default = value;
    }
    for (const entry of resolved.slice(1)) {
      if (!entry.key) {
        warnings.push(`变量 ${name} 存在无主题的多余取值，已忽略`);
        continue;
      }
      modes[entry.key] = entry.alias ? `{${entry.alias}}` : entry.hex!;
    }

    const ref = usage.byRef.get(name);
    const usageEntry = { usageCount: ref?.usageCount ?? 0, samples: [...(ref?.samples ?? [])] };
    for (const entry of resolved) {
      if (!entry.hex) continue;
      const raw = usage.byHex.get(entry.hex);
      if (!raw) continue;
      usageEntry.usageCount += raw.usageCount;
      for (const sample of raw.samples) {
        if (!usageEntry.samples.includes(sample) && usageEntry.samples.length < MAX_SAMPLES) {
          usageEntry.samples.push(sample);
        }
      }
    }

    inputs.push({
      name,
      value,
      modes,
      ...(aliasOf ? { aliasOf } : {}),
      usageCount: usageEntry.usageCount,
      samples: usageEntry.samples
    });
  }
  return { inputs, skipped, warnings };
}

function sameModes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, index) => key === keysB[index] && a[key] === b[key]);
}

export interface MergePenTokensResult {
  tokens: ColorToken[];
  actions: TokenAction[];
}

export function mergePenColorTokens(
  inputs: PenColorInput[],
  existing: ColorToken[]
): MergePenTokensResult {
  const byName = new Map(existing.map((token) => [token.name, token]));
  const seen = new Set(inputs.map((input) => input.name));
  const tokens: ColorToken[] = [];
  const actions: TokenAction[] = [];

  for (const input of inputs) {
    const prior = byName.get(input.name);
    const unchanged =
      prior !== undefined &&
      prior.value === input.value &&
      (prior.aliasOf ?? null) === (input.aliasOf ?? null) &&
      sameModes(prior.modes, input.modes);
    tokens.push({
      name: input.name,
      value: input.value,
      modes: input.modes,
      ...(input.aliasOf ? { aliasOf: input.aliasOf } : {}),
      usageCount: input.usageCount,
      samples: input.samples,
      needsReview: false
    });
    actions.push({
      name: input.name,
      action: prior ? (unchanged ? "unchanged" : "updated") : "new",
      value: input.value,
      needsReview: false
    });
  }

  for (const token of existing) {
    if (seen.has(token.name)) continue;
    tokens.push(token);
    actions.push({ name: token.name, action: "unused", value: token.value, needsReview: token.needsReview });
  }

  tokens.sort((a, b) => a.name.localeCompare(b.name));
  actions.sort((a, b) => a.name.localeCompare(b.name));
  return { tokens, actions };
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penImportTokens(
  runtime: Runtime,
  args: PenTokensArgs
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
    const extraction = extractPenColorVariables(doc);

    const designDir = path.join(runtime.configDirAbs, "design");
    const tokenPath = path.join(designDir, "tokens.json");
    const existing = parseCanonicalTokens(
      fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf-8") : ""
    );
    const merge = mergePenColorTokens(extraction.inputs, existing);

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const stackWrite = profile ? renderStackTokenFile(profile, merge.tokens) : null;
    const warnings = [...extraction.warnings];

    let stackResult: ReturnType<typeof writeStackTokenFile> | null = null;
    if (stackWrite) {
      stackResult = writeStackTokenFile(runtime.project.rootDir, stackWrite, {
        overwrite: args.overwrite === true,
        dryRun: args.dryRun === true
      });
      if (stackResult.action === "skipped_unmanaged") {
        warnings.push(`目标文件非本工具生成，未覆盖：${stackWrite.relativePath}（确认后用 overwrite:true 覆盖）`);
      }
    } else if (!profile) {
      warnings.push("未检测到技术栈：仅更新 canonical tokens.json（不生成栈文件）");
    } else {
      warnings.push(`${profile.displayName} 暂不支持生成 token 文件`);
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
    const enforcement = args.enforcement ?? "report";
    const violations =
      hardcoded.length + unused.length + (stackResult?.action === "skipped_unmanaged" ? 1 : 0);

    const payload: Record<string, unknown> = {
      ok: true,
      dryRun: args.dryRun === true,
      source: penRelativePath(runtime, target),
      stack: profile?.id ?? null,
      counts: {
        penColorVariables: extraction.inputs.length,
        tokens: merge.tokens.length,
        new: merge.actions.filter((action) => action.action === "new").length,
        updated: merge.actions.filter((action) => action.action === "updated").length,
        unchanged: merge.actions.filter((action) => action.action === "unchanged").length,
        unused: unused.length,
        skippedNonColor: Object.values(extraction.skipped).reduce((sum, count) => sum + count, 0)
      },
      skippedByType: extraction.skipped,
      tokens: merge.tokens.map((token) => ({
        name: token.name,
        value: token.aliasOf ? `{${token.aliasOf}}` : token.value,
        modes: token.modes,
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
        "canonical: .artemis/design/tokens.json（DTCG；pen 变量名即 token 名，modes 记录主题取值，栈文件使用 default）；裸色扫描与 enforcement 语义同 figma_import_tokens。"
    };

    if (enforcement === "block" && violations > 0) {
      return jsonResult(
        { ...payload, blocked: true, blockReason: `发现 ${violations} 项需处理（硬编码色值/未使用 token/未覆盖文件）` },
        true
      );
    }
    if (enforcement === "warn" && violations > 0) {
      warnings.push(`enforcement=warn：${violations} 项问题待处理`);
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `pen 颜色 token 导入失败: ${errorMessage(error)}`, hint: PEN_HINT },
      true
    );
  }
}
