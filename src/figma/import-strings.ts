import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { STACK_PROFILES, detectProjectStacks, type StackProfile } from "../projects/stack.js";
import {
  androidLocaleDir,
  collectFigmaTexts,
  loadResolvedConflicts,
  loadStringContext,
  mergeStrings,
  parseStrings,
  platformKey,
  renderAndroidStrings,
  renderFlutterArb,
  renderIosStrings,
  renderIosStringsdict,
  renderJsonLocale,
  scanHardcodedStrings,
  serializeStrings,
  STRING_CONTEXT_FILE,
  writeResourceFile,
  type FigmaTextRecord,
  type ResourceWrite,
  type StringEntry
} from "./strings.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

export type Enforcement = "report" | "warn" | "block";

export interface ImportStringsArgs {
  url: string;
  locale?: string;
  dryRun?: boolean;
  save?: boolean;
  enforcement?: Enforcement;
}

export const IMPLEMENTED_STRING_STACKS = new Set([
  "android-native",
  "flutter",
  "react-native",
  "web",
  "ios-native"
]);

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const STRING_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN；M6b 先支持 Android(strings.xml)/Flutter(arb)，其余栈按需铺开。";

export interface StringsImportOptions {
  locale?: string;
  dryRun?: boolean;
  save?: boolean;
  enforcement?: Enforcement;
}

export async function figmaImportStrings(
  runtime: Runtime,
  args: ImportStringsArgs
): Promise<CallToolResult> {
  try {
    const { fileKey } = parseFigmaUrl(args.url);
    const file = (await fetchFile(fileKey)) as { document?: FigmaNode };
    if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);
    return await runStringsImport(runtime, collectFigmaTexts(file.document), args.url, args);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `文案 i18n 导入失败: ${errorMessage(error)}`, hint: STRING_HINT },
      true
    );
  }
}

/** Shared pipeline behind the Figma and pen string importers: merge collected text
 * records into the frozen mapping, write stack resources (idempotent), scan
 * hardcoded literals and report conflicts under the requested enforcement. */
export async function runStringsImport(
  runtime: Runtime,
  records: FigmaTextRecord[],
  sourceUrl: string,
  args: StringsImportOptions,
  hint: string = STRING_HINT
): Promise<CallToolResult> {
  try {
    const designDir = path.join(runtime.configDirAbs, "design");
    const stringsPath = path.join(designDir, "strings.json");
    const existing = parseStrings(
      fs.existsSync(stringsPath) ? fs.readFileSync(stringsPath, "utf-8") : ""
    );
    const sourceLocale = args.locale ?? existing.sourceLocale ?? "zh";
    const resolved = loadResolvedConflicts(runtime.configDirAbs);
    const merge = mergeStrings(existing.entries, records);
    const context = loadStringContext(runtime.configDirAbs);
    const mergedEntries: StringEntry[] = merge.entries.map((entry) => {
      const plural = context.contexts.get(entry.key);
      return plural ? { ...entry, plural } : entry;
    });
    const unmatchedContext = [...context.contexts.keys()].filter(
      (key) => !mergedEntries.some((entry) => entry.key === key)
    );

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const implemented = stacks
      .filter((stack) => IMPLEMENTED_STRING_STACKS.has(stack.id))
      .map((stack) => STACK_PROFILES[stack.id]);
    const warnings: string[] = [];

    const resources: Array<{
      stack: string;
      path: string;
      action: string;
      conflicts: Array<{ key: string; existing: string; incoming: string; resolved: boolean }>;
    }> = [];
    const resourceWrites: ResourceWrite[] = [];

    for (const profile of implemented) {
      for (const write of renderStringsForStack(profile, mergedEntries, runtime.project.rootDir, sourceLocale)) {
        const conflictView = write.conflicts.map((conflict) => ({
          ...conflict,
          resolved: resolved.has(conflict.key)
        }));
        if (args.dryRun !== true && args.save !== false) {
          writeResourceFile(runtime.project.rootDir, write);
        }
        resources.push({
          stack: profile.id,
          path: write.relativePath,
          action: args.dryRun === true ? "planned" : write.action,
          conflicts: conflictView
        });
        resourceWrites.push(write);
      }
    }

    const conflictKeys = new Map<string, { resolved: boolean }>();
    for (const write of resourceWrites) {
      for (const conflict of write.conflicts) {
        conflictKeys.set(conflict.key, { resolved: resolved.has(conflict.key) });
      }
    }
    const entries: StringEntry[] = mergedEntries.map((entry) => {
      for (const profile of implemented) {
        const key = platformKey(entry.key, profile.i18n.keyStyle);
        const hit = conflictKeys.get(key);
        if (hit) return { ...entry, lifecycle: hit.resolved ? "resolved" : "conflict" };
      }
      return entry;
    });

    const unresolved = [...conflictKeys.values()].filter((conflict) => !conflict.resolved).length;

    const hardcoded: Array<{ file: string; line: number; text: string; stack: string }> = [];
    for (const profile of implemented) {
      if (profile.id === "android-native" || profile.id === "flutter" || profile.id === "ios-native") {
        hardcoded.push(...scanHardcodedStrings(runtime.project.rootDir, profile.id));
      }
    }

    const existingKeys = new Set(existing.entries.map((entry) => entry.key));
    const counts = {
      designTexts: records.length,
      entries: entries.length,
      newKeys: entries.filter((entry) => !existingKeys.has(entry.key)).length,
      sourceChanged: entries.filter((entry) => entry.lifecycle === "source_changed").length,
      conflicts: unresolved,
      resolved: entries.filter((entry) => entry.lifecycle === "resolved").length,
      needsContext: entries.filter((entry) => entry.lifecycle === "needs_context" && !entry.plural).length,
      pluralized: entries.filter((entry) => entry.plural !== undefined).length,
      needsRename: entries.filter((entry) => entry.lifecycle === "needs_rename").length,
      unused: merge.unused.length
    };

    if (args.dryRun !== true && args.save !== false) {
      writeFileAtomic(stringsPath, serializeStrings(entries, sourceLocale));
    }

    const enforcement = args.enforcement ?? "report";
    const violations = unresolved + hardcoded.length;
    const payload: Record<string, unknown> = {
      ok: true,
      dryRun: args.dryRun === true,
      sourceUrl,
      sourceLocale,
      stacks: implemented.map((profile) => profile.id),
      counts,
      resources,
      hardcodedStrings: {
        total: hardcoded.length,
        sample: hardcoded.slice(0, 20),
        heuristic: hardcoded.some((hit) => hit.stack === "ios-native"),
        ...(hardcoded.some((hit) => hit.stack === "ios-native")
          ? { note: "Swift 硬编码扫描为启发式规则（白名单 API，可能误报/漏报）" }
          : {})
      },
      migrations: merge.migrations.slice(0, 20),
      reuseSuggestions: merge.reuseSuggestions.slice(0, 20),
      unusedStrings: merge.unused,
      sourceChangedKeys: merge.sourceChanged,
      stringContext: {
        file: path.join(designDir, STRING_CONTEXT_FILE),
        pluralKeys: entries.filter((entry) => entry.plural !== undefined).map((entry) => entry.key),
        unmatched: unmatchedContext,
        errors: context.errors
      },
      entries: entries.map((entry) => ({
        key: entry.key,
        nodeId: entry.nodeId,
        screen: entry.screen,
        sourceText: entry.sourceText,
        lifecycle: entry.lifecycle,
        placeholders: entry.placeholders,
        ...(entry.plural
          ? { plural: { variable: entry.plural.variable, quantities: Object.keys(entry.plural.forms) } }
          : {})
      })),
      enforcement,
      warnings,
      savedTo: args.dryRun !== true && args.save !== false ? stringsPath : undefined,
      hint:
        `canonical: .artemis/design/strings.json（key 一经分配即冻结）；冲突人工决策后写入 .artemis/design/resolutions.json（{conflicts:{key:{resolvedAt}}}）；` +
        `复数/人工上下文写入 .artemis/design/${STRING_CONTEXT_FILE}（{entries:{"<key>":{plural:{variable?,forms:{one,other,...}}}}}）。`
    };

    if (enforcement === "block" && violations > 0) {
      return jsonResult(
        { ...payload, blocked: true, blockReason: `发现 ${unresolved} 个未解决冲突 / ${hardcoded.length} 处硬编码文案` },
        true
      );
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `文案 i18n 导入失败: ${errorMessage(error)}`, hint },
      true
    );
  }
}

/** Per-stack resource writers. iOS returns `.strings` plus (when confirmed
 * plurals exist) the companion `.stringsdict`; `.strings` cannot express them. */
export function renderStringsForStack(
  profile: StackProfile,
  entries: StringEntry[],
  rootDir: string,
  sourceLocale: string
): ResourceWrite[] {
  if (profile.id === "android-native") {
    return [renderAndroidStrings(profile, entries, rootDir, androidLocaleDir(sourceLocale))];
  }
  if (profile.id === "flutter") {
    return [renderFlutterArb(profile, entries, rootDir, sourceLocale)];
  }
  if (profile.id === "ios-native") {
    const strings = renderIosStrings(profile, entries, rootDir, sourceLocale);
    const stringsdict = renderIosStringsdict(profile, entries, rootDir, sourceLocale);
    return stringsdict ? [strings, stringsdict] : [strings];
  }
  return [renderJsonLocale(profile, entries, rootDir, sourceLocale)];
}
