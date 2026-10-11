import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { penInspect, type PenInspectArgs } from "../../pen/inspect.js";
import { penExtractFlows, type PenExtractFlowsArgs } from "../../pen/flows.js";
import { penImportTokens, type PenTokensArgs } from "../../pen/tokens.js";
import { penImportStrings, type PenStringsArgs } from "../../pen/strings.js";
import { penExportBrief, type PenBriefArgs } from "../../pen/brief.js";
import { penExport, type PenExportArgs } from "../../pen/export.js";
import { penApplyStrings, penApplyTokens, type PenApplyStringsArgs, type PenApplyTokensArgs } from "../../pen/apply.js";
import { penAgent, type PenAgentArgs } from "../../pen/agent.js";
import { penImportAssets, type PenAssetsArgs } from "../../pen/assets.js";

/** pen 域原生工具（DESIGN §13.89）。 */
export const PEN_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "pen_inspect",
    description:
      "pen.dev 离线检查：解析 .pen（开放 JSON 格式，支持 // 注释）→ 结构校验（id 唯一/无斜杠、ref 可解析、$变量可解析）+ 摘要（屏幕/组件/实例/文案/变量与主题/图片资产及缺失文件）；不需账号与网络。path 缺省取 .artemis/design 下最新的 *.pen；save:true 落盘 .artemis/design/pen/summary.json。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      save: z.boolean().optional().describe("是否落盘 .artemis/design/pen/summary.json，默认 false")
    }),
    handler: (runtime, args) => penInspect(runtime, args as unknown as PenInspectArgs)
  },
  {
    name: "pen_extract_flows",
    description:
      "pen 流程合成（离线）：检测交互线索（.pen v2.20 无原型交互字段；text href / 交互类键 / metadata 线索）：无线索时按「Flow 标注 > 屏内首个文本 > 图层名」命名屏幕、按标签前缀归并状态变体（主屏+states）、按画板顺序与排布推断跳转（全部 trigger=INFERRED，需复核）；有线索显式告警 pen-interactions-present（未解析，不静默）→ 落盘 .artemis/design/flows.json（可直接供 figma_generate_tests / suite check 使用）+ flow-map.md（全局交互地图：画板/主链/状态/警告）；返回碎片度统计（默认名屏数、状态归并、推断边数、交互线索数）与 warnings。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      save: z.boolean().optional().describe("是否落盘 flows.json + flow-map.md，默认 true"),
      maxScreens: z.number().int().positive().max(500).optional().describe("主屏数量上限，默认 200")
    }),
    handler: (runtime, args) => penExtractFlows(runtime, args as unknown as PenExtractFlowsArgs)
  },
  {
    name: "pen_import_tokens",
    description:
      "pen 颜色变量导入：.pen 的 color 变量（变量名即 token 名，支持主题取值与 $别名）→ .artemis/design/tokens.json（DTCG，modes 记录主题值）+ 按检测栈生成 token 文件（Android/Flutter/RN/Web/iOS）；输出 new/updated/unchanged/unused、裸色扫描与 enforcement；完全离线（无需账号/网络）。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      overwrite: z.boolean().optional().describe("允许覆盖非本工具生成的目标文件，默认 false（skipped_unmanaged）"),
      save: z.boolean().optional().describe("是否落盘 canonical tokens.json，默认 true"),
      enforcement: z.enum(["report", "warn", "block"]).optional().describe("硬编码/unused 问题级别，默认 report")
    }),
    handler: (runtime, args) => penImportTokens(runtime, args as unknown as PenTokensArgs)
  },
  {
    name: "pen_import_strings",
    description:
      "pen 文案 i18n 导入：.pen 文本节点（nodeId 冻结 key，reusable 组件自成屏幕上下文）→ .artemis/design/strings.json + 按检测栈写入资源（Android strings.xml / Flutter arb / RN·Web JSON / iOS strings）；输出复用建议、source_changed、unused 与硬编码文案扫描；冲突经 resolutions.json 闭环；完全离线。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      locale: z.string().optional().describe("source locale（BCP-47，默认沿用 strings.json 或 zh）"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      save: z.boolean().optional().describe("是否落盘 strings.json，默认 true"),
      enforcement: z.enum(["report", "warn", "block"]).optional().describe("冲突/硬编码问题级别，默认 report")
    }),
    handler: (runtime, args) => penImportStrings(runtime, args as unknown as PenStringsArgs)
  },
  {
    name: "pen_export_brief",
    description:
      "pen 构建简报：.pen → build-brief.{json,md}（颜色/字阶/间距/圆角/阴影、屏幕与建议路由、可复用组件、按栈编码约定、可选 gaps 摘要）；可选 scaffold 按技术栈生成组件骨架（幂等）；完全离线。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      save: z.boolean().optional().describe("是否落盘 build-brief.{json,md}，默认 true"),
      includeGaps: z.boolean().optional().describe("是否附带 gaps.json 缺口摘要，默认 true"),
      scaffold: z.boolean().optional().describe("是否生成组件骨架文件，默认 false"),
      maxComponents: z.number().int().positive().max(200).optional().describe("组件清单上限，默认 40"),
      overwrite: z.boolean().optional().describe("scaffold 命名冲突时是否覆盖，默认 false")
    }),
    handler: (runtime, args) => penExportBrief(runtime, args as unknown as PenBriefArgs)
  },
  {
    name: "pen_export",
    description:
      "pen 渲染导出（headless CLI）：.pen → PNG/JPEG/WEBP/PDF，默认落盘 .artemis/design/pen/<name>.<format>；用于与真机截图对比。pen CLI 缺失时自动安装到 ~/.aos/pen-cli（AOS_PEN_NO_INSTALL=1 关闭；AOS_PEN_CLI_PATH/AOS_PEN_CLI_DIR 可覆盖）；登录用 pen login 或在项目 .env 设置 PEN_CLI_KEY（自动透传）。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      out: z.string().optional().describe("输出路径（相对项目根）；缺省 .artemis/design/pen/<name>.<format>"),
      format: z.enum(["png", "jpeg", "webp", "pdf"]).optional().describe("导出格式，默认 png"),
      scale: z.number().optional().describe("图片倍率 1-4，默认 2（pdf 忽略）"),
      dryRun: z.boolean().optional().describe("仅返回将执行的命令，不调用 CLI，默认 false"),
      timeoutMs: z.number().int().positive().optional().describe("CLI 超时（毫秒），默认 AOS_PEN_TIMEOUT_MS 或 120s")
    }),
    handler: (runtime, args) => penExport(runtime, args as unknown as PenExportArgs)
  },
  {
    name: "pen_import_assets",
    description:
      "pen 资源导入（headless CLI）：.pen 指定节点 → 位图（interactive Export，单会话按倍率批量；png/jpeg/webp）→ 按检测栈命名/倍率集/目录幂等写入（路径幂等 + sha256 去重 + duplicate_of；densities:false 回退单 @2x）；产物以 CLI 响应的 Exported 路径对账，缺失记 export-no-output + 批次告警；报告落 .artemis/design/import-report.pen.json（schemaVersion/penCliVersion/vector:\"unsupported\"；不与 Figma 报告互相覆盖）。pen CLI 缺失时自动安装（同 pen_export），需已登录（pen login 或项目 .env 的 PEN_CLI_KEY）；非离线工具。",
    schema: z.object({
      path: z.string().optional().describe("相对项目根或绝对路径的 .pen 文件；缺省自动选择最新文件"),
      ids: z.array(z.string().min(1)).min(1).describe("要导出的节点 id 列表（来自 .pen；可用 pen_inspect 核对）"),
      format: z.enum(["png", "jpeg", "webp"]).optional().describe("导出格式，默认 png"),
      densities: z.boolean().optional().describe("位图是否按栈倍率集导出，默认 true；false 回退单文件 @2x"),
      destDir: z.string().optional().describe("覆盖目标目录（默认按栈档案/建议目录）"),
      overwrite: z.boolean().optional().describe("同名不同内容时是否覆盖，默认 false（skipped_exists）"),
      dryRun: z.boolean().optional().describe("仅预览不写文件（渲染仍会执行以获得去重结果），默认 false"),
      save: z.boolean().optional().describe("是否落盘 import-report.pen.json，默认 true"),
      timeoutMs: z.number().int().positive().optional().describe("CLI 超时（毫秒）；缺省按会话自适应（AOS_PEN_IMPORT_TIMEOUT_MS / 规模公式）")
    }),
    handler: (runtime, args) => penImportAssets(runtime, args as unknown as PenAssetsArgs)
  },
  {
    name: "pen_apply_tokens",
    description:
      "pen 颜色写回（headless CLI）：读取 .artemis/design/tokens.json（含 modes 主题取值）→ .pen 的 SetVariables；默认原位更新（先写临时文件、解析校验变量值后再原子替换，失败不动原文件），可用 out 指定输出文件；别名 token 不单独写入。pen CLI 缺失时自动安装（同 pen_export），需已登录（pen login 或项目 .env 的 PEN_CLI_KEY）。",
    schema: z.object({
      path: z.string().optional().describe("目标 .pen（相对项目根或绝对路径）；缺省自动选择最新文件"),
      tokensPath: z.string().optional().describe("自定义 tokens.json 路径（相对项目根），默认 .artemis/design/tokens.json"),
      out: z.string().optional().describe("输出到新文件（相对项目根）；省略则原位更新"),
      dryRun: z.boolean().optional().describe("仅返回 cmd，不调用 CLI、不写文件，默认 false"),
      timeoutMs: z.number().int().positive().optional().describe("CLI 超时（毫秒），默认 AOS_PEN_TIMEOUT_MS 或 120s")
    }),
    handler: (runtime, args) => penApplyTokens(runtime, args as unknown as PenApplyTokensArgs)
  },
  {
    name: "pen_apply_strings",
    description:
      "pen 文案写回（headless CLI）：读取 .artemis/design/strings.json 的 nodeId→sourceText → .pen 文本节点 Update(content)；默认原位更新（临时文件 + 回读校验后原子替换，失败不动原文件），nodeId 在 .pen 中不存在时记入 notFound；pen CLI 缺失时自动安装（同 pen_export），需已登录。",
    schema: z.object({
      path: z.string().optional().describe("目标 .pen（相对项目根或绝对路径）；缺省自动选择最新文件"),
      stringsPath: z.string().optional().describe("自定义 strings.json 路径（相对项目根），默认 .artemis/design/strings.json"),
      out: z.string().optional().describe("输出到新文件（相对项目根）；省略则原位更新"),
      dryRun: z.boolean().optional().describe("仅返回将执行的 cmd，不调用 CLI、不写文件，默认 false"),
      timeoutMs: z.number().int().positive().optional().describe("CLI 超时（毫秒），默认 AOS_PEN_TIMEOUT_MS 或 120s")
    }),
    handler: (runtime, args) => penApplyStrings(runtime, args as unknown as PenApplyStringsArgs)
  },
  {
    name: "pen_agent",
    description:
      "pen agent 生成/修改设计（headless CLI）：自然语言 prompt → .pen（默认原位更新：临时文件→结构校验→原子替换，失败不动原文件；out 可新建/另存，dryRun 只返回命令）。凭证自动复用 AOS active LLM 条目：注入 PEN_AGENT_API_KEY=该 key（不落日志），DeepSeek 自动映射 ANTHROPIC_BASE_URL（https://api.deepseek.com→/anthropic，实测可用）；项目 .env 的 PEN_* / ANTHROPIC_* 会透传（active LLM 派生值优先）；pen CLI 缺失时自动安装（同 pen_export）。可选 exportPath 顺带出图。",
    schema: z.object({
      path: z.string().optional().describe("输入 .pen（相对项目根或绝对路径）；缺省自动选择最新文件；省略且无 out 则报错"),
      out: z.string().optional().describe("输出 .pen（相对项目根）；提供 path 时省略则原位更新"),
      prompt: z.string().min(1).describe("自然语言设计指令（自包含、可执行）"),
      agent: z.enum(["claude", "codex", "gemini"]).optional().describe("agent 类型；与 model 二选一，默认 claude"),
      model: z.string().optional().describe("模型 id（如 claude-sonnet-5 / gpt-5.6-terra / gemini-3.7-flash）"),
      effort: z.string().optional().describe("推理力度（claude/codex/gemini 各有取值）"),
      anthropicBaseUrl: z.string().optional().describe("覆盖 Anthropic 兼容端点（默认按 active LLM 自动推导；AOS_PEN_ANTHROPIC_BASE_URL 亦可）"),
      custom: z.boolean().optional().describe("claude agent 是否传 --custom（自定义 Claude 模型配置）；默认在有兼容端点时自动开启，false 可关闭"),
      exportPath: z.string().optional().describe("顺带导出图片/PDF 的路径（相对项目根）"),
      exportType: z.enum(["png", "jpeg", "webp", "pdf"]).optional().describe("导出格式，默认 png"),
      exportScale: z.number().optional().describe("图片倍率 1-4"),
      maxFailedCalls: z.number().int().positive().optional().describe("连续失败工具调用上限（CLI --max-failed-calls）"),
      dryRun: z.boolean().optional().describe("仅返回将执行的命令，默认 false"),
      timeoutMs: z.number().int().positive().optional().describe("CLI 超时（毫秒），默认 AOS_PEN_TIMEOUT_MS 或 120s")
    }),
    handler: (runtime, args) => penAgent(runtime, args as unknown as PenAgentArgs)
  }
];
