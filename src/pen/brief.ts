import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  detectAndroidPackage,
  renderBriefMarkdown,
  scaffoldComponentSkeleton,
  type BriefComponent,
  type BriefData
} from "../figma/brief.js";
import { writeAssetFile } from "../figma/import.js";
import {
  detectProjectStacks,
  formatComponentFileName,
  primaryProfile,
  type StackProfile
} from "../projects/stack.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";
import { collectPenNodes, type PenDocument, type PenNode } from "./read.js";
import { penVariableDefaultHex, scanPenPaintUsage } from "./tokens.js";

export interface PenBriefArgs {
  path?: string;
  save?: boolean;
  includeGaps?: boolean;
  scaffold?: boolean;
  maxComponents?: number;
  overwrite?: boolean;
}

interface ColorUsage {
  hex: string;
  usageCount: number;
  sampleLayers: string[];
}

function toRoute(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean || clean === "home" || clean === "landing" || clean === "index") return "/";
  return `/${clean}`;
}

function penColors(doc: PenDocument): ColorUsage[] {
  const variables = doc.variables ?? {};
  const { byRef, byHex } = scanPenPaintUsage(doc);
  const merged = new Map<string, { usageCount: number; sampleLayers: string[] }>();
  const add = (hex: string, usageCount: number, samples: string[]): void => {
    const entry = merged.get(hex) ?? { usageCount: 0, sampleLayers: [] };
    entry.usageCount += usageCount;
    for (const sample of samples) {
      if (!entry.sampleLayers.includes(sample) && entry.sampleLayers.length < 3) entry.sampleLayers.push(sample);
    }
    merged.set(hex, entry);
  };
  for (const [hex, usage] of byHex) add(hex, usage.usageCount, usage.samples);
  for (const [name, usage] of byRef) {
    const hex = penVariableDefaultHex(variables[name], variables);
    if (hex) add(hex, usage.usageCount, usage.samples);
  }
  return [...merged.entries()]
    .sort((a, b) => b[1].usageCount - a[1].usageCount || a[0].localeCompare(b[0]))
    .map(([hex, entry]) => ({ hex, usageCount: entry.usageCount, sampleLayers: entry.sampleLayers }));
}

function penTypography(doc: PenDocument): Array<Record<string, unknown>> {
  const map = new Map<
    string,
    {
      fontFamily?: string;
      fontSize?: number;
      fontWeight?: string;
      lineHeight?: number;
      letterSpacing?: number;
      usageCount: number;
    }
  >();
  for (const node of collectPenNodes(doc)) {
    if (node.type !== "text") continue;
    const fontFamily = typeof node.fontFamily === "string" ? node.fontFamily : undefined;
    const fontSize = typeof node.fontSize === "number" ? node.fontSize : undefined;
    const fontWeight = node.fontWeight !== undefined ? String(node.fontWeight) : undefined;
    const lineHeight = typeof node.lineHeight === "number" ? node.lineHeight : undefined;
    const letterSpacing = typeof node.letterSpacing === "number" ? node.letterSpacing : undefined;
    if (fontFamily === undefined && fontSize === undefined && fontWeight === undefined) continue;
    const key = JSON.stringify([fontFamily, fontSize, fontWeight, lineHeight, letterSpacing]);
    const entry = map.get(key) ?? { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, usageCount: 0 };
    entry.usageCount += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.usageCount - a.usageCount);
}

function numericList(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.filter((item): item is number => typeof item === "number");
  return [];
}

function penSpacing(doc: PenDocument): Array<{ value: number; usageCount: number }> {
  const counts = new Map<number, number>();
  for (const node of collectPenNodes(doc)) {
    if (node.type !== "frame") continue;
    for (const value of [...numericList(node.gap), ...numericList(node.padding)]) {
      if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, usageCount]) => ({ value, usageCount }));
}

function penRadii(doc: PenDocument): Array<{ value: number; usageCount: number }> {
  const counts = new Map<number, number>();
  for (const node of collectPenNodes(doc)) {
    for (const value of numericList(node.cornerRadius)) {
      if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, usageCount]) => ({ value, usageCount }));
}

function effectsOf(node: PenNode): Array<Record<string, unknown>> {
  const effect = node.effect;
  if (Array.isArray(effect)) {
    return effect.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  if (effect && typeof effect === "object") return [effect as Record<string, unknown>];
  return [];
}

function penShadows(doc: PenDocument): Array<Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const node of collectPenNodes(doc)) {
    for (const effect of effectsOf(node)) {
      if (effect.type !== "shadow") continue;
      const key = JSON.stringify([effect.shadowType, effect.offset, effect.blur, effect.color]);
      const entry = map.get(key) ?? { ...effect, usageCount: 0 };
      entry.usageCount = Number(entry.usageCount) + 1;
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => Number(b.usageCount) - Number(a.usageCount));
}

function componentDir(profile: StackProfile | null, packageName: string | null): string {
  const base = profile?.naming.componentFile.preferredDir ?? "src/components";
  if (profile?.id === "android-native" && packageName) {
    return `app/src/main/java/${packageName.replace(/\./g, "/")}/ui/components`;
  }
  return base;
}

function stackStep(profile: StackProfile | null): string {
  if (!profile) return "未检测到技术栈：确认项目包含 pubspec.yaml / package.json / gradle 等标记文件";
  return `按 ${profile.displayName} 约定实现（组件目录 ${profile.naming.componentFile.preferredDir}，文件命名 ${profile.naming.componentFile.style}）`;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penExportBrief(
  runtime: Runtime,
  args: PenBriefArgs
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
    const relative = penRelativePath(runtime, target);
    const fileName = path.basename(target);

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const packageName = profile?.id === "android-native" ? detectAndroidPackage(runtime.project.rootDir) : null;

    const maxComponents = args.maxComponents ?? 40;
    const components: BriefComponent[] = collectPenNodes(doc)
      .filter((node) => node.reusable === true)
      .slice(0, maxComponents)
      .map((node) => ({
        id: node.id ?? "",
        name: node.name ?? "",
        type: "COMPONENT",
        propertyNames: [],
        variantCount: 0,
        sampleVariants: []
      }));

    const screens = (doc.children ?? [])
      .filter((child) => child?.type === "frame")
      .map((child) => ({
        page: "pen",
        name: child.name ?? "",
        suggestedRoute: toRoute(child.name ?? "")
      }));
    const suggestedRoutes = [...new Set(screens.map((screen) => screen.suggestedRoute))];

    let gapSummary: BriefData["gapSummary"] = null;
    if (args.includeGaps !== false) {
      const gapsPath = path.join(runtime.configDirAbs, "design", "gaps.json");
      if (fs.existsSync(gapsPath)) {
        try {
          const gaps = JSON.parse(fs.readFileSync(gapsPath, "utf-8")) as {
            missingAssets?: unknown[];
            colorsChecked?: boolean;
            missingColors?: unknown[];
          };
          gapSummary = {
            missingAssets: gaps.missingAssets?.length ?? 0,
            missingColors: gaps.colorsChecked === false ? "not-checked" : gaps.missingColors?.length ?? 0
          };
        } catch {
          gapSummary = null;
        }
      }
    }

    const nextSteps: string[] = [
      "运行 pen_import_tokens 将颜色变量写入 tokens.json 与栈 token 文件",
      "运行 pen_import_strings 将文案写入 strings.json 与资源文件",
      stackStep(profile),
      "按第 1 节 tokens 与第 6 节约定实现组件；关键页面完成后用 mobile_run_task 做端到端验证"
    ];

    const brief: BriefData = {
      sourceUrl: relative,
      fileKey: fileName,
      fileName,
      generatedAt: new Date().toISOString(),
      stack: profile
        ? {
            id: profile.id,
            displayName: profile.displayName,
            codeRules: profile.codeRules,
            locatorRules: profile.locatorRules,
            componentDir: componentDir(profile, packageName),
            componentExample: formatComponentFileName("Home Button", profile)
          }
        : null,
      screens,
      suggestedRoutes,
      designSystem: {
        colors: penColors(doc).slice(0, 30),
        typography: penTypography(doc).slice(0, 15),
        spacingScale: penSpacing(doc).slice(0, 15),
        borderRadius: penRadii(doc).slice(0, 10),
        shadows: penShadows(doc).slice(0, 10)
      },
      components,
      flowSummary: null,
      gapSummary,
      nextSteps
    };

    const payload: Record<string, unknown> = {
      ok: true,
      source: relative,
      summary: {
        screens: screens.length,
        routes: suggestedRoutes.length,
        components: components.length,
        colors: brief.designSystem.colors.length,
        stack: profile?.id ?? null
      },
      brief
    };

    if (args.save !== false) {
      const jsonPath = path.join(runtime.configDirAbs, "design", "build-brief.json");
      writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
      const markdownPath = path.join(runtime.configDirAbs, "design", "build-brief.md");
      writeFileAtomic(markdownPath, renderBriefMarkdown(brief));
      payload.savedTo = { json: jsonPath, markdown: markdownPath };
    }

    if (args.scaffold === true) {
      const scaffoldResults = components.slice(0, 10).map((component) => {
        const skeleton = scaffoldComponentSkeleton(component.name, {
          profile,
          packageName,
          propertyNames: component.propertyNames
        });
        const written = writeAssetFile(
          runtime.project.rootDir,
          skeleton.relativePath,
          skeleton.content,
          args.overwrite === true
        );
        return { name: component.name, file: skeleton.relativePath, status: written.status };
      });
      payload.scaffold = {
        count: scaffoldResults.length,
        results: scaffoldResults,
        hint: "骨架仅含结构占位与 tokens 引用注释；实现细节按 build-brief.md 补全。"
      };
    }

    return jsonResult(payload);
  } catch (error) {
    return jsonResult({ ok: false, error: `构建简报生成失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  }
}
