import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import {
  analyzeStructure,
  describeComponentVariants,
  extractDesignSystem
} from "../vendor/design-context-bridge/figma-rest/analysis.js";
import { walk, type FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import {
  detectProjectStacks,
  formatComponentFileName,
  primaryProfile,
  skippedStacksWarnings,
  type StackProfile
} from "../projects/stack.js";
import { buildFlowGraph } from "./flows.js";
import { writeAssetFile } from "./import.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BriefComponent {
  id: string;
  name: string;
  type: string;
  propertyNames: string[];
  variantCount: number;
  sampleVariants: string[];
}

export interface BriefData {
  sourceUrl: string;
  fileKey: string;
  fileName: string | null;
  generatedAt: string;
  stack: {
    id: string;
    displayName: string;
    codeRules: string;
    locatorRules: string;
    componentDir: string;
    componentExample: string;
  } | null;
  screens: Array<{ page: string; name: string; suggestedRoute: string }>;
  suggestedRoutes: string[];
  designSystem: {
    colors: Array<{ hex: string; usageCount: number; sampleLayers: string[] }>;
    typography: Array<Record<string, unknown>>;
    spacingScale: Array<{ value: number; usageCount: number }>;
    borderRadius: Array<{ value: number; usageCount: number }>;
    shadows: Array<Record<string, unknown>>;
  };
  components: BriefComponent[];
  flowSummary: { screens: number; edges: number; entryScreens: string[] } | null;
  gapSummary: { missingAssets: number; missingColors: number | "not-checked" } | null;
  nextSteps: string[];
}

export interface ScaffoldEntry {
  name: string;
  relativePath: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Scaffolding (pure)
// ---------------------------------------------------------------------------

export function detectAndroidPackage(rootDir: string): string | null {
  try {
    const manifest = fs.readFileSync(path.join(rootDir, "app/src/main/AndroidManifest.xml"), "utf-8");
    const match = /package="([^"]+)"/.exec(manifest);
    if (match) return match[1]!;
  } catch {
    /* fall through */
  }
  for (const file of ["app/build.gradle", "app/build.gradle.kts"]) {
    try {
      const text = fs.readFileSync(path.join(rootDir, file), "utf-8");
      const match = /namespace\s*[= ]\s*["']([^"']+)["']/.exec(text);
      if (match) return match[1]!;
    } catch {
      /* try next */
    }
  }
  return null;
}

function componentDir(profile: StackProfile | null, packageName: string | null): string {
  const base = profile?.naming.componentFile.preferredDir ?? "src/components";
  if (profile?.id === "android-native" && packageName) {
    return `app/src/main/java/${packageName.replace(/\./g, "/")}/ui/components`;
  }
  return base;
}

export function scaffoldComponentSkeleton(
  name: string,
  options: { profile: StackProfile | null; packageName?: string | null; propertyNames?: string[] }
): ScaffoldEntry {
  const { profile } = options;
  const propertyNames = options.propertyNames ?? [];
  const relativePath = path.posix.join(
    componentDir(profile, options.packageName ?? null),
    formatComponentFileName(name, profile)
  );
  const propsComment = propertyNames.length > 0 ? `变体属性: ${propertyNames.join(", ")}` : "无变体属性";

  switch (profile?.id) {
    case "flutter": {
      const className = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)
        .map((part) => part[0]!.toUpperCase() + part.slice(1)).join("") || "Component";
      return {
        name,
        relativePath,
        content: `import 'package:flutter/material.dart';

// TODO: 对齐 .artemis/design/build-brief.md 的 tokens（颜色/字阶/间距）
// ${propsComment}
class ${className} extends StatelessWidget {
  const ${className}({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return const SizedBox.shrink(); // TODO: 按设计稿实现
  }
}
`
      };
    }
    case "android-native": {
      const className = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)
        .map((part) => part[0]!.toUpperCase() + part.slice(1)).join("") || "Component";
      const packageName = options.packageName ?? "com.example.app";
      return {
        name,
        relativePath,
        content: `package ${packageName}.ui.components${options.packageName ? "" : " // TODO: 改为应用实际包名"}

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

// TODO: 对齐 .artemis/design/build-brief.md 的 tokens
// ${propsComment}
@Composable
fun ${className}() {
    Box {
        Text("${className}")
    }
}
`
      };
    }
    case "ios-native": {
      const className = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)
        .map((part) => part[0]!.toUpperCase() + part.slice(1)).join("") || "Component";
      return {
        name,
        relativePath,
        content: `import SwiftUI

// TODO: 对齐 .artemis/design/build-brief.md 的 tokens
// ${propsComment}
struct ${className}: View {
    var body: some View {
        Text("${className}")
    }
}

#Preview {
    ${className}()
}
`
      };
    }
    case "react-native": {
      const componentName = (formatComponentFileName(name, profile).replace(/\.tsx$/, "") || "Component");
      return {
        name,
        relativePath,
        content: `import { View, Text, StyleSheet } from "react-native";

// TODO: 对齐 .artemis/design/build-brief.md 的 tokens（颜色/字阶/间距）
// ${propsComment}
export interface ${componentName}Props {}

export function ${componentName}(_props: ${componentName}Props) {
  return (
    <View style={styles.root}>
      <Text>${componentName}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {}
});
`
      };
    }
    default: {
      const componentName = (formatComponentFileName(name, profile).replace(/\.tsx$/, "") || "Component");
      return {
        name,
        relativePath,
        content: `// TODO: 对齐 .artemis/design/build-brief.md 的 tokens（CSS 变量/主题）
// ${propsComment}
export interface ${componentName}Props {}

export function ${componentName}(_props: ${componentName}Props) {
  return <div className="${componentName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}">${componentName}</div>;
}
`
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering (pure)
// ---------------------------------------------------------------------------

export function renderBriefMarkdown(brief: BriefData): string {
  const lines: string[] = [
    `# 构建简报：${brief.fileName ?? brief.fileKey}`,
    "",
    `> 来源: ${brief.sourceUrl}`,
    `> 生成时间: ${brief.generatedAt}`,
    brief.stack
      ? `> 技术栈: ${brief.stack.displayName}（自动检测）`
      : "> 技术栈: 未检测到（使用通用约定）",
    ""
  ];

  lines.push("## 1. 设计 tokens", "");
  lines.push("### 色彩（按使用频次）", "", "| Hex | 用量 | 样例图层 |", "|---|---|---|");
  for (const color of brief.designSystem.colors) {
    lines.push(`| \`${color.hex}\` | ${color.usageCount} | ${color.sampleLayers.slice(0, 3).join(", ")} |`);
  }
  lines.push("", "### 字阶", "", "| Family | Size | Weight | LineHeight | 用量 |", "|---|---|---|---|---|");
  for (const type of brief.designSystem.typography) {
    lines.push(
      `| ${type.fontFamily ?? ""} | ${type.fontSize ?? ""} | ${type.fontWeight ?? ""} | ${type.lineHeight ?? "-"} | ${type.usageCount ?? ""} |`
    );
  }
  lines.push(
    "",
    `**间距**: ${brief.designSystem.spacingScale.map((entry) => entry.value).join(", ") || "-"}`,
    "",
    `**圆角**: ${brief.designSystem.borderRadius.map((entry) => entry.value).join(", ") || "-"}`,
    "",
    `**阴影**: ${brief.designSystem.shadows.length} 种（详见 build-brief.json）`,
    ""
  );

  lines.push("## 2. 页面与路由", "", "| 页面 | 画板 | 建议路由 |", "|---|---|---|");
  for (const screen of brief.screens) {
    lines.push(`| ${screen.page} | ${screen.name} | \`${screen.suggestedRoute}\` |`);
  }
  lines.push("");

  lines.push("## 3. 组件与变体", "", "| 组件 | 类型 | 变体属性 | 变体数 |", "|---|---|---|---|");
  for (const component of brief.components) {
    lines.push(
      `| ${component.name} | ${component.type} | ${component.propertyNames.join(", ") || "-"} | ${component.variantCount} |`
    );
  }
  lines.push("");

  if (brief.flowSummary) {
    lines.push(
      "## 4. 交互流程概览",
      "",
      `- 屏幕 ${brief.flowSummary.screens} 个 / 交互边 ${brief.flowSummary.edges} 条`,
      `- 入口: ${brief.flowSummary.entryScreens.join(", ") || "-"}`,
      ""
    );
  }

  if (brief.gapSummary) {
    lines.push(
      "## 5. 资源缺口（来自 gaps.json）",
      "",
      `- 缺失资源: ${brief.gapSummary.missingAssets}`,
      `- 缺失色值: ${brief.gapSummary.missingColors}`,
      ""
    );
  }

  if (brief.stack) {
    lines.push(
      "## 6. 编码约定（按检测栈）",
      "",
      `- 代码结构: ${brief.stack.codeRules}`,
      `- 定位约定: ${brief.stack.locatorRules}`,
      `- 组件目录: \`${brief.stack.componentDir}\`（示例: ${brief.stack.componentExample}）`,
      ""
    );
  }

  lines.push("## 7. 建议下一步", "");
  brief.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export interface ExportBriefArgs {
  url: string;
  save?: boolean;
  includeFlows?: boolean;
  includeGaps?: boolean;
  scaffold?: boolean;
  maxComponents?: number;
  overwrite?: boolean;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function figmaExportBrief(
  runtime: Runtime,
  args: ExportBriefArgs
): Promise<CallToolResult> {
  try {
    const { fileKey } = parseFigmaUrl(args.url);
    const file = (await fetchFile(fileKey)) as {
      name?: string;
      document?: FigmaNode;
    };
    if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);
    const document = file.document;

    const structure = analyzeStructure(document) as {
      pages: Array<{ page: string; screens: Array<{ id: string; name: string; suggestedRoute: string }> }>;
      suggestedRoutes: string[];
      components: Array<{ id: string; name: string; type: string }>;
    };
    const designSystem = extractDesignSystem(document) as BriefData["designSystem"];

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const packageName = profile?.id === "android-native" ? detectAndroidPackage(runtime.project.rootDir) : null;

    const byId = new Map<string, FigmaNode>();
    walk(document, (node) => byId.set(node.id, node));

    const maxComponents = args.maxComponents ?? 40;
    const components: BriefComponent[] = structure.components.slice(0, maxComponents).map((entry) => {
      const node = byId.get(entry.id);
      if (!node) {
        return { ...entry, propertyNames: [], variantCount: 0, sampleVariants: [] };
      }
      const described = describeComponentVariants(node) as {
        propertyDefinitions?: Record<string, unknown>;
        variants?: Array<{ name: string }>;
        variantCount?: number;
      };
      return {
        ...entry,
        propertyNames: Object.keys(described.propertyDefinitions ?? {}),
        variantCount: described.variantCount ?? 0,
        sampleVariants: (described.variants ?? []).slice(0, 8).map((variant) => variant.name)
      };
    });

    let flowSummary: BriefData["flowSummary"] = null;
    if (args.includeFlows !== false) {
      const graph = buildFlowGraph(document);
      flowSummary = {
        screens: graph.screens.length,
        edges: graph.edges.length,
        entryScreens: graph.entryScreens
      };
    }

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

    const screens = structure.pages.flatMap((page) =>
      page.screens.map((screen) => ({ page: page.page, name: screen.name, suggestedRoute: screen.suggestedRoute }))
    );

    const nextSteps: string[] = [];
    if (gapSummary && gapSummary.missingAssets > 0) {
      nextSteps.push("运行 figma_import_assets 导入缺失资源（可先 dryRun 预览落点）");
    }
    if (flowSummary && flowSummary.edges > 0) {
      nextSteps.push("运行 figma_generate_tests 生成 artemis 端到端测试用例");
    }
    nextSteps.push(
      briefStackStep(profile),
      "按第 1 节 tokens 与第 6 节约定实现组件；关键页面完成后用 compare_design_and_device 做视觉回归"
    );

    const brief: BriefData = {
      sourceUrl: args.url,
      fileKey,
      fileName: file.name ?? null,
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
      suggestedRoutes: structure.suggestedRoutes ?? [],
      designSystem: {
        colors: (designSystem.colors ?? []).slice(0, 30),
        typography: (designSystem.typography ?? []).slice(0, 15),
        spacingScale: (designSystem.spacingScale ?? []).slice(0, 15),
        borderRadius: (designSystem.borderRadius ?? []).slice(0, 10),
        shadows: (designSystem.shadows ?? []).slice(0, 10)
      },
      components,
      flowSummary,
      gapSummary,
      nextSteps
    };

    const payload: Record<string, unknown> = {
      ok: true,
      warnings: skippedStacksWarnings(stacks, profile),
      summary: {
        screens: screens.length,
        routes: brief.suggestedRoutes.length,
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
      const targets = components
        .filter((component) => component.type === "COMPONENT" || component.type === "COMPONENT_SET")
        .slice(0, 10);
      const scaffoldResults = targets.map((component) => {
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
    return jsonResult(
      {
        ok: false,
        error: `构建简报生成失败: ${errorMessage(error)}`,
        hint: "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（项目 .env 或 aos_configure 携带 figmaToken）。"
      },
      true
    );
  }
}

function briefStackStep(profile: StackProfile | null): string {
  if (!profile) return "未检测到技术栈：确认项目根目录包含 pubspec.yaml / package.json / gradle 等标记文件";
  return `按 ${profile.displayName} 约定实现（组件目录 ${profile.naming.componentFile.preferredDir}，文件命名 ${profile.naming.componentFile.style}）`;
}
