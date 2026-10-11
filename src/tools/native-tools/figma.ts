import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { figmaExtractFlows, type ExtractFlowsArgs } from "../../figma/flows.js";
import { figmaGapAnalysis, type GapAnalysisArgs } from "../../figma/gaps.js";
import { figmaGenerateTests, type GenerateTestsArgs } from "../../figma/test-gen.js";
import { figmaImportAssets, type ImportAssetsArgs } from "../../figma/import.js";
import { figmaImportStrings, type ImportStringsArgs } from "../../figma/import-strings.js";
import { figmaImportTokens, type ImportTokensArgs } from "../../figma/import-tokens.js";
import { figmaExportBrief, type ExportBriefArgs } from "../../figma/brief.js";

/** Figma 域原生工具（DESIGN §13.89）。 */
export const FIGMA_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "figma_extract_flows",
    description:
      "解析 Figma 文件的原型交互 → 流程图：screens（含建议路由）+ edges（元素/触发器/导航/转场，支持 ON_CLICK/AFTER_TIMEOUT/拖拽/BACK 等连续动作）+ entryScreens；落盘 <项目>/.artemis/design/flows.json。REST 模式需 FIGMA_ACCESS_TOKEN。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL（可选带 node-id 限定范围）"),
      nodeId: z.string().optional().describe("可选：只解析该节点子树"),
      save: z.boolean().optional().describe("是否落盘到 .artemis/design/flows.json，默认 true")
    }),
    handler: (runtime, args) => figmaExtractFlows(runtime, args as unknown as ExtractFlowsArgs)
  },
  {
    name: "figma_gap_analysis",
    description:
      "缺口分析：对比 Figma 中应导出的资源（图标/矢量）与色板 vs 项目现有资产与 token 文件，输出缺失清单及建议文件名；扫描规则按项目技术栈自动选择（Flutter/React Native/原生 Android/iOS/Web，可用 assetGlobs/tokenFiles 覆盖）；落盘 <项目>/.artemis/design/gaps.json。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      id: z.string().optional().describe("可选：限定分析节点"),
      assetGlobs: z
        .array(z.string())
        .optional()
        .describe('项目资产匹配模式（默认 ["**/*.svg","**/*.png",…]，忽略 node_modules/dist 等）'),
      tokenFiles: z
        .array(z.string())
        .optional()
        .describe('token 文件匹配模式（默认 ["**/tokens.json","**/theme.css","**/variables.css",…]）'),
      save: z.boolean().optional().describe("是否落盘到 .artemis/design/gaps.json，默认 true")
    }),
    handler: (runtime, args) => figmaGapAnalysis(runtime, args as unknown as GapAnalysisArgs)
  },
  {
    name: "figma_generate_tests",
    description:
      "流程 → 测试用例：读取 .artemis/design/flows.json（或直接给 Figma URL 现场提取），把连续交互线性化为端到端流程（覆盖贪心 + 长路径优先：先长主链、再补覆盖缺口，冗余短片段不产出），生成可直接传给 mobile_run_task 的自然语言任务描述；默认（save !== false）三份同时落盘：tests.json + tests.md + tests.xlsx（响应 savedTo 给出三个路径；Excel 可用 excelPath 指定路径、excelTemplate 指定 .xlsx 模版），仅 save:false 才不写任何文件。覆盖保证：响应与 tests.json 内含 coverage（硬覆盖：未覆盖屏幕/跳转、路径截断、entryFallback；explore：inferred 探索缺口，仅报告不阻断）；requireFullCoverage:true 时硬覆盖不完整即报错且三份都不落盘。",
    schema: z.object({
      url: z.string().optional().describe("Figma URL（可选；不传则用 flows.json）"),
      flowsPath: z.string().optional().describe("自定义 flows.json 路径（相对项目根）"),
      maxFlows: z.number().int().positive().max(50).optional().describe("最多生成条数，默认 10"),
      maxDepth: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("路径最大深度（边数），默认 30；长流程可调大以生成更长的连续用例（超限按续段拆分，不丢尾）"),
      save: z.boolean().optional().describe("是否落盘 tests.json/tests.md/tests.xlsx，默认 true"),
      excelPath: z
        .string()
        .optional()
        .describe("xlsx 输出路径（相对项目根），默认 .artemis/design/tests.xlsx"),
      excelTemplate: z
        .string()
        .optional()
        .describe("测试用例 .xlsx 模版路径（相对项目根或绝对），支持 {{meta.*}}/{{counts.*}}/{{case.*}}/{{index}} 占位符"),
      requireFullCoverage: z
        .boolean()
        .optional()
        .describe("覆盖不完整（有未覆盖屏幕/跳转或路径被截断）时报错且不落盘，默认 false")
    }),
    handler: (runtime, args) => figmaGenerateTests(runtime, args as unknown as GenerateTestsArgs)
  },
  {
    name: "figma_import_assets",
    description:
      "资源导入：按 gaps.json（或 ids 过滤）从 Figma 导出缺失资源（SVG 内联 / PNG 下载），按项目技术栈命名与首选目录幂等写入（同内容跳过；不同需 overwrite）；PNG 默认按栈倍率集导出（Android drawable-xhdpi/-xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x；densities:false 回退单文件 @2x）；支持 dryRun 预览；落盘 .artemis/design/import-report.json。",
    schema: z.object({
      url: z.string().optional().describe("Figma URL（默认取 gaps.json 的 sourceUrl）"),
      gapPath: z.string().optional().describe("自定义 gaps.json 路径（相对项目根）"),
      destDir: z.string().optional().describe("覆盖目标目录（默认按栈档案/建议目录）"),
      ids: z.array(z.string()).optional().describe("只导入指定 Figma 节点 id（缺省=全部缺失项）"),
      format: z.enum(["svg", "png"]).optional().describe("导出格式，默认 svg"),
      densities: z
        .boolean()
        .optional()
        .describe("PNG 是否按栈倍率集导出，默认 true；false 回退单文件 @2x"),
      overwrite: z.boolean().optional().describe("同名不同内容时是否覆盖，默认 false（跳过）"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      save: z.boolean().optional().describe("是否落盘 import-report.json，默认 true")
    }),
    handler: (runtime, args) => figmaImportAssets(runtime, args as unknown as ImportAssetsArgs)
  },
  {
    name: "figma_export_brief",
    description:
      "构建简报：把 Figma 文件综合成编码用事实包（tokens/页面路由/组件与变体/流程概览/资源缺口/按栈编码约定），落盘 build-brief.{json,md}；可选 scaffold 按技术栈生成组件骨架文件（幂等）。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      save: z.boolean().optional().describe("是否落盘 build-brief.{json,md}，默认 true"),
      includeFlows: z.boolean().optional().describe("是否附带交互流程概览，默认 true"),
      includeGaps: z.boolean().optional().describe("是否附带 gaps.json 缺口摘要，默认 true"),
      scaffold: z.boolean().optional().describe("是否生成组件骨架文件，默认 false"),
      maxComponents: z.number().int().positive().max(200).optional().describe("组件清单上限，默认 40"),
      overwrite: z.boolean().optional().describe("scaffold 命名冲突时是否覆盖，默认 false")
    }),
    handler: (runtime, args) => figmaExportBrief(runtime, args as unknown as ExportBriefArgs)
  },
  {
    name: "figma_import_tokens",
    description:
      "颜色 token 导入：REST 读取 Figma 设计系统颜色（含 alpha，canonical #RRGGBBAA）→ 值冻结的语义命名 → .artemis/design/tokens.json（DTCG，modes 预留）+ 按检测栈生成 token 文件（Android colors.xml / Flutter Dart / RN TS / Web CSS / iOS Colors.xcassets + AosTokens.swift）；输出 new/unchanged/unused、裸色扫描与 enforcement。人工命名用 .artemis/design/token-names.json。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      overwrite: z.boolean().optional().describe("允许覆盖非本工具生成的目标文件，默认 false（skipped_unmanaged）"),
      save: z.boolean().optional().describe("是否落盘 canonical tokens.json，默认 true"),
      enforcement: z.enum(["report", "warn", "block"]).optional().describe("硬编码/unused 问题级别，默认 report")
    }),
    handler: (runtime, args) => figmaImportTokens(runtime, args as unknown as ImportTokensArgs)
  },
  {
    name: "figma_import_strings",
    description:
      "文案 i18n 导入：REST 采集 Figma TEXT 节点 → 语义 key（nodeId 冻结映射，图层改名不改 key）→ .artemis/design/strings.json + 按检测栈写入源语言资源（Android strings.xml / Flutter arb / iOS .strings+.stringsdict）；输出复用建议、nodeId 迁移建议、source_changed、unused 与硬编码文案扫描（Swift 为启发式白名单）；冲突需人工决策（resolutions.json），enforcement=block 可阻断。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      locale: z.string().optional().describe("source locale（BCP-47，默认沿用 strings.json 或 zh）"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      save: z.boolean().optional().describe("是否落盘 strings.json，默认 true"),
      enforcement: z.enum(["report", "warn", "block"]).optional().describe("冲突/硬编码问题级别，默认 report")
    }),
    handler: (runtime, args) => figmaImportStrings(runtime, args as unknown as ImportStringsArgs)
  },
];
