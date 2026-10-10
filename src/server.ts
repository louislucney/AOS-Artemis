import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadProject } from "./config/loader.js";
import { configDirAbs } from "./artemis/assembly.js";
import { traceIdOf } from "./artemis/task-result.js";
import { ensureArtemisDeps, resolveDepsSource } from "./artemis/bootstrap.js";
import { createProjectStore } from "./db/index.js";
import { configureLogging, installCrashHandlers } from "./log.js";
import { startBridge, stopBridge } from "./figma/bridge.js";
import { figmaTools, handleFigmaTool, isFigmaTool } from "./figma/registry.js";
import { figmaExtractFlows, type ExtractFlowsArgs } from "./figma/flows.js";
import { figmaGapAnalysis, type GapAnalysisArgs } from "./figma/gaps.js";
import { figmaGenerateTests, type GenerateTestsArgs } from "./figma/test-gen.js";
import { figmaImportAssets, type ImportAssetsArgs } from "./figma/import.js";
import { figmaImportStrings, type ImportStringsArgs } from "./figma/import-strings.js";
import { figmaImportTokens, type ImportTokensArgs } from "./figma/import-tokens.js";
import { figmaExportBrief, type ExportBriefArgs } from "./figma/brief.js";
import { penInspect, type PenInspectArgs } from "./pen/inspect.js";
import { penExtractFlows, type PenExtractFlowsArgs } from "./pen/flows.js";
import { penImportTokens, type PenTokensArgs } from "./pen/tokens.js";
import { penImportStrings, type PenStringsArgs } from "./pen/strings.js";
import { penExportBrief, type PenBriefArgs } from "./pen/brief.js";
import { penExport, type PenExportArgs } from "./pen/export.js";
import {
  penApplyStrings,
  penApplyTokens,
  type PenApplyStringsArgs,
  type PenApplyTokensArgs
} from "./pen/apply.js";
import { penAgent, type PenAgentArgs } from "./pen/agent.js";
import { penImportAssets, type PenAssetsArgs } from "./pen/assets.js";
import { syncFigmaTokenEnv } from "./figma/token.js";
import { Runtime, sweepStaleChild } from "./runtime.js";
import { usageEventInputFrom } from "./usage/capture.js";
import { compareDesignAndDevice, type CompareArgs } from "./tools/composite.js";
import { designDeviceDiff, type DesignDeviceDiffArgs } from "./diff/tool.js";
import { screenMap, type ScreenMapArgs } from "./diff/screen-map.js";
import { reconciliation, type ReconciliationArgs } from "./figma/reconciliation.js";
import { aosConfigure, type ConfigureArgs } from "./tools/configure.js";
import { aosCrashes, type AosCrashesArgs } from "./tools/crash.js";
import {
  jiraEvidencePost,
  jiraIssueAttach,
  jiraIssueComment,
  jiraIssueGet,
  jiraIssueSearch,
  type JiraEvidencePostArgs,
  type JiraIssueAttachArgs,
  type JiraIssueCommentArgs,
  type JiraIssueGetArgs,
  type JiraIssueSearchArgs
} from "./tools/jira.js";
import {
  aosStatus,
  aosTasks,
  llmList,
  llmModels,
  llmSwitch,
  type AosTasksArgs,
  type LlmModelsArgs,
  type LlmSwitchArgs
} from "./tools/llm.js";
import { aosUsage, type AosUsageArgs } from "./tools/usage.js";
import { AOS_MCP_VERSION, errorMessage, log } from "./util.js";

interface NativeToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (
    runtime: Runtime,
    args: Record<string, unknown>
  ) => Promise<CallToolResult> | CallToolResult;
}

const SYNC_INTERVAL_MS = 30_000;

const NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "llm_list",
    description:
      "识别当前项目的全部 LLM 条目（.env 导入 / PostgreSQL / 高级配置）+ 当前激活项；key 只返回 masked 预览。",
    schema: z.object({}),
    handler: (runtime) => llmList(runtime)
  },
  {
    name: "llm_models",
    description:
      "厂商模型目录：查看/刷新已配置条目的 OpenAI 风格模型列表（GET {baseUrl}/models，缓存到 PostgreSQL；后台每 12h 自动刷新，可用 AOS_MODEL_REFRESH_HOURS 调整）。模型下线时按厂商别名/同族等价自动修复（AOS_LLM_AUTO_REPAIR=0 关闭）；返回 8 家国产厂商预设（DeepSeek/百炼/智谱/Kimi/硅基流动/阶跃/方舟/混元）便于一键配置。",
    schema: z.object({
      action: z.enum(["list", "refresh"]).describe("list 读缓存；refresh 立即请求厂商接口"),
      entry: z.string().optional().describe("只查看/刷新指定条目名（默认全部）")
    }),
    handler: (runtime, args) => llmModels(runtime, args as unknown as LlmModelsArgs)
  },
  {
    name: "llm_switch",
    description:
      "切换项目激活的 LLM 条目。模型变更对下一个 mobile_run_task 生效；key/base_url 变更会重启 artemis 网关子进程（运行中任务不受影响）。",
    schema: z.object({
      name: z.string().min(1).describe("要激活的条目名（见 llm_list）"),
      force: z.boolean().optional().describe("跳过运行中任务守卫并强制重启网关子进程，默认 false")
    }),
    handler: (runtime, args) => llmSwitch(runtime, args as unknown as LlmSwitchArgs)
  },
  {
    name: "aos_configure",
    description:
      "为当前项目配置 LLM（OpenAI 兼容）：写入 PostgreSQL 与项目 .env，并可选设为 active。model/baseUrl 可用 vendor 预设（deepseek/qwen/zhipu/moonshot/siliconflow/stepfun/ark/hunyuan）替代：只给 vendor 时自动拉取厂商模型列表并按稳定别名选型。可选同时配置 Jira Cloud（jiraSite/jiraEmail/jiraApiToken 三者一起提供，写入项目 .env，站点仅接受 https://*.atlassian.net）。用于 setup_required 引导场景。",
    schema: z.object({
      apiKey: z.string().min(1).describe("该项目的 LLM key（费用支付方）"),
      model: z.string().optional().describe("模型名，如 deepseek-flash；省略时按 vendor 列表自动选择"),
      baseUrl: z.string().optional().describe("OpenAI 兼容端点，如 https://api.deepseek.com/v1；提供 vendor 时默认用预设"),
      vendor: z
        .enum(["deepseek", "qwen", "zhipu", "moonshot", "siliconflow", "stepfun", "ark", "hunyuan"])
        .optional()
        .describe("国产厂商预设（自动填 baseUrl / 选取当前模型）"),
      name: z.string().optional().describe("条目名（默认取 model）"),
      makeActive: z.boolean().optional().describe("配置后立即设为 active，默认 true"),
      writeEnv: z.boolean().optional().describe("是否回写项目 .env，默认 true"),
      force: z.boolean().optional().describe("激活时跳过运行中任务守卫，默认 false"),
      figmaToken: z.string().optional().describe("可选的 Figma token（写入项目 .env / 存储）"),
      jiraSite: z.string().optional().describe("Jira Cloud 站点，如 https://your-site.atlassian.net（与 jiraEmail/jiraApiToken 同时提供）"),
      jiraEmail: z.string().optional().describe("Jira 账号邮箱（API token 的 Basic 认证用户名）"),
      jiraApiToken: z.string().optional().describe("Jira API token（id.atlassian.com 生成；只回写 .env，响应仅 masked）")
    }),
    handler: (runtime, args) => aosConfigure(runtime, args as unknown as ConfigureArgs)
  },
  {
    name: "aos_status",
    description:
      "AOS MCP 运行状态：项目注册信息、存储（PostgreSQL/降级内存）、active LLM、artemis 子进程（pid/重启数/stderr 尾部）、Figma 桥/就绪性、Jira 配置（masked）、setup 状态。",
    schema: z.object({}),
    handler: (runtime) => aosStatus(runtime)
  },
  {
    name: "aos_tasks",
    description:
      "任务/调用统计：列出本项目的 mobile_run_task 记录（trace/状态/模型/耗时），可选先与 artemis 同步完成态。",
    schema: z.object({
      limit: z.number().int().positive().max(100).optional().describe("返回条数，默认 20"),
      sync: z.boolean().optional().describe("是否先同步任务完成态，默认 true")
    }),
    handler: (runtime, args) => aosTasks(runtime, args as unknown as AosTasksArgs)
  },
  {
    name: "aos_crashes",
    description:
      "崩溃取证：任务终态后自动采集设备崩溃证据（Android：crash buffer；iOS：宿主机 DiagnosticReports .ips）并解析为崩溃签名（包名+根因异常+首个应用帧），按栈签名去重计数；list 列出签名，get 取完整栈/日志摘录，scan 手动扫描（指定 traceId 时强制重扫该 trace；不指定时扫描未扫描的终态任务，并主动采集当前连接设备的 crash buffer，可用 since/package 收窄）。",
    schema: z.object({
      action: z.enum(["list", "get", "scan"]).describe("list 列表 / get 详情 / scan 手动扫描"),
      signature: z.string().optional().describe("get 用的崩溃签名 id（见 list 的 records[].id）"),
      traceId: z.string().optional().describe("scan 时只扫描该 trace（强制重扫）"),
      package: z.string().optional().describe("list 过滤 / scan 包名过滤（精确匹配）"),
      kind: z.enum(["java", "native", "anr", "ios", "unknown"]).optional().describe("list 过滤：崩溃类型"),
      since: z.string().optional().describe("ISO 8601 时间：list 只返回该时间之后仍出现的签名；scan 只采集该时间之后的崩溃"),
      limit: z.number().int().positive().max(100).optional().describe("list 返回条数，默认 20")
    }),
    handler: (runtime, args) => aosCrashes(runtime, args as unknown as AosCrashesArgs)
  },
  {
    name: "aos_usage",
    description:
      "使用统计：客户端工具调用事件的聚合与流水（summary 概览 / signals 信号 / events 事件）。tool/status/days 可筛选；events 支持 limit（≤200）。AOS_USAGE=0 时显式标注采集已关闭，历史数据仍可查。",
    schema: z.object({
      action: z
        .enum(["summary", "signals", "events"])
        .optional()
        .describe("summary 概览（默认）/ signals 信号分布 / events 事件流水"),
      tool: z.string().optional().describe("只统计指定工具（精确匹配）"),
      status: z.enum(["ok", "error"]).optional().describe("只统计成功或失败调用"),
      days: z.number().int().positive().optional().describe("只看最近 N 天（默认全部保留期）"),
      limit: z.number().int().min(1).max(200).optional().describe("events 返回条数（1-200，默认 100）")
    }),
    handler: (runtime, args) => aosUsage(runtime, args as unknown as AosUsageArgs)
  },
  {
    name: "jira_issue_get",
    description:
      "读取 Jira Cloud issue：key 或 browse URL → 规范化上下文（summary/status/type/labels + 描述纯文本 + 启发式验收标准标注，保留原始 ADF），供 agent 直接生成测试用例。需项目 .env 配置 JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN（可用 aos_configure 写入）。",
    schema: z.object({
      key: z.string().min(1).describe("issue key（如 AOS-123）或含 /browse/ 的 URL")
    }),
    handler: (runtime, args) => jiraIssueGet(runtime, args as unknown as JiraIssueGetArgs)
  },
  {
    name: "jira_issue_search",
    description:
      "JQL 搜索 Jira Cloud issue（/rest/api/3/search/jql 游标分页）：返回 key/url/summary/status/type/labels/updated/assignee；limit 默认 20、上限 100，nextPageToken 透传。JQL 需有界（如 project = X ORDER BY created DESC）；无 total（计数用 JQL 侧聚合）。",
    schema: z.object({
      jql: z.string().min(1).describe("有界 JQL，如 project = AOS AND status != Done ORDER BY created DESC"),
      limit: z.number().int().positive().max(100).optional().describe("返回条数，默认 20"),
      fields: z.array(z.string()).optional().describe("覆盖默认字段集（summary/status/issuetype/labels/updated/assignee/project）"),
      nextPageToken: z.string().optional().describe("翻页游标（上次响应返回的 nextPageToken）")
    }),
    handler: (runtime, args) => jiraIssueSearch(runtime, args as unknown as JiraIssueSearchArgs)
  },
  {
    name: "jira_issue_comment",
    description:
      "写 Jira issue 评论：纯文本 → ADF；传 traceId 时按 `AOS-TRACE:<traceId>` 页脚 marker 幂等回写（同 issue+trace 存在则 PUT 更新，否则 POST 新建；随后 best-effort 写评论属性）。dryRun:true 只返回将写入的内容摘要（不触网）。",
    schema: z.object({
      key: z.string().min(1).describe("issue key（如 AOS-123）或含 /browse/ 的 URL"),
      body: z.string().min(1).describe("评论正文（纯文本；空行分段、生成 ADF 段落）"),
      traceId: z.string().optional().describe("trace id：提供时按 marker 幂等（更新既有评论）"),
      dryRun: z.boolean().optional().describe("仅返回计划，不写回，默认 false")
    }),
    handler: (runtime, args) => jiraIssueComment(runtime, args as unknown as JiraIssueCommentArgs)
  },
  {
    name: "jira_issue_attach",
    description:
      "上传附件到 Jira issue：项目根内相对路径数组；multipart（X-Atlassian-Token: no-check）；确定性命名 `<basename>-<sha8><ext>`（内容哈希内置），同名同大小视为已存在跳过；单文件上限取站点 attachment/meta 与 AOS_JIRA_ATTACH_MAX_MB（默认 20）较小者，超限 warning 跳过不失败；dryRun:true 只列计划（不读上限制、不触网写）。",
    schema: z.object({
      key: z.string().min(1).describe("issue key（如 AOS-123）或含 /browse/ 的 URL"),
      files: z.array(z.string()).min(1).describe("项目根内相对路径数组（绝对路径越界拒绝）"),
      dryRun: z.boolean().optional().describe("仅返回计划，不写回，默认 false")
    }),
    handler: (runtime, args) => jiraIssueAttach(runtime, args as unknown as JiraIssueAttachArgs)
  },
  {
    name: "jira_evidence_post",
    description:
      "失败证据 composite：输入 issueKey + traceId（可选 platform/deviceSerial/dryRun）→ 自动聚合失败步骤截图（锚定步骤 pre/post）、设计差异标注图（annotated.png 优先）、失败清单、失败域（确定性命中崩溃/环境/数据/API/设计推断/用例）与崩溃签名摘要；生成中文结构化评论并按 traceId（AOS-TRACE marker）幂等回写，附件按确定性命名去重上传（≤6 个）。trace 不存在时返回可行动说明；dryRun 只返回将写入的评论与附件清单（不触网）。",
    schema: z.object({
      key: z.string().min(1).describe("issue key（如 AOS-123）或含 /browse/ 的 URL"),
      traceId: z.string().min(1).describe("任务 trace id（mobile_run_task / suite run 产物）"),
      platform: z.enum(["android", "ios"]).optional().describe("平台覆盖（缺省按 trace 状态/设备号推断，推断不出记 unknown）"),
      deviceSerial: z.string().optional().describe("设备 serial 覆盖（缺省取 trace 状态）"),
      dryRun: z.boolean().optional().describe("仅返回计划，不写回，默认 false")
    }),
    handler: (runtime, args) => jiraEvidencePost(runtime, args as unknown as JiraEvidencePostArgs)
  },
  {
    name: "compare_design_and_device",
    description:
      "组合工具：拉取 Figma 节点的渲染图（PNG@2x，REST）与当前真机截图，一并返回两张图片，供多模态模型比对布局/间距/颜色/文案。lossless=true 时真机侧改用 adb 无损 PNG 截图（避免 JPEG 伪影；失败自动回退 live JPEG）；platform=\"ios\" 时真机侧改走 macOS 模拟器（idb→simctl，需 deviceSerial 传 UDID 或唯一已启动模拟器）。",
    schema: z.object({
      figmaUrl: z.string().min(1).describe("Figma URL（建议带 ?node-id=）"),
      nodeId: z.string().optional().describe("覆盖 URL 中的 node-id"),
      deviceSerial: z.string().optional().describe("目标设备 serial（默认自动选择；平台 ios 时为模拟器 UDID）"),
      platform: z
        .enum(["android", "ios"])
        .optional()
        .describe("设备平台：android（默认，ARTEMIS/adb）| ios（仅 macOS 模拟器，经 idb/simctl 截图）"),
      lossless: z
        .boolean()
        .optional()
        .describe("真机侧无损 PNG（adb exec-out screencap -p）；失败回退 live JPEG，默认 false")
    }),
    handler: (runtime, args) => compareDesignAndDevice(runtime, args as unknown as CompareArgs)
  },
  {
    name: "design_device_diff",
    description:
      "设计 vs 真机差异：取设计渲染（Figma 节点 PNG@2x，或 `design:{source:\"pen\"}` 经 pen CLI 渲染 .pen）与真机截图（device.mode=live 实时截图，或 device.mode=step + traceId（stepNumber 可选：省略则用失败证据自动检索步骤）指定失败步骤截图，默认 post），做确定性对齐（设计宽度缩放 + 顶部对齐；insets/ignoreRegions/降采样可配）与像素差异判定，产出结构化差异报告（区域/严重度/证据）与标注图，默认落盘 <项目>/.artemis/design/diffs/<node>-<时间戳>/（report.json / annotated.png / design.png / device.png）；响应返回摘要 + 标注图 + 产物路径。dryRun 只回计划；判定不依赖 LLM。",
    schema: z.object({
      design: z.object({
        source: z.enum(["figma", "pen"]).optional().describe("设计源；省略时按 figmaUrl/penPath 推断"),
        figmaUrl: z.string().optional().describe("Figma 文件 URL（建议带 ?node-id=；source=figma 或推断）"),
        penPath: z.string().optional().describe("相对项目根或绝对路径的 .pen（source=pen；缺省取 .artemis/design 下最新）"),
        nodeId: z.string().optional().describe("覆盖 URL 中的 node-id"),
        renderOut: z.string().optional().describe("pen 渲染输出路径（相对项目根；默认 .artemis/design/pen/<name>.png）")
      }),
      device: z
        .object({
          mode: z.enum(["live", "step"]).optional().describe("设备源模式：live（实时截图，默认）| step（trace 步骤截图）"),
          platform: z
            .enum(["android", "ios"])
            .optional()
            .describe("设备平台：android（默认）| ios（macOS 模拟器；live 经 idb/simctl 截图，step 走 iOS trace 截图）"),
          serial: z.string().optional().describe("目标设备 serial（默认自动选择；平台 ios 时为模拟器 UDID）"),
          traceId: z.string().optional().describe("mode=step 必填：任务 trace id（mobile_run_task 返回）"),
          stepNumber: z.number().int().positive().optional().describe("mode=step 步骤号；省略则用失败证据自动检索步骤（Pro 任务，best-effort）"),
          image: z.enum(["post", "pre"]).optional().describe("步骤截图选 post（行动后，默认）或 pre（行动前）"),
          lossless: z
            .boolean()
            .optional()
            .describe("mode=live 时经 adb 抓无损 PNG（避免 JPEG 伪影；失败自动回退 live JPEG），默认 false")
        })
        .optional(),
      alignment: z
        .object({
          insets: z
            .object({
              top: z.number().optional(),
              right: z.number().optional(),
              bottom: z.number().optional(),
              left: z.number().optional()
            })
            .optional()
            .describe("设备截图边缘裁剪（px），用于系统栏/手势条"),
          ignoreRegions: z
            .array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }))
            .optional()
            .describe("按设计坐标屏蔽的区域（动态内容：视频位/轮播/时钟等）")
        })
        .optional(),
      diff: z
        .object({
          pixelThreshold: z.number().min(0).max(1).optional().describe("pixelmatch 阈值，默认 0.1"),
          minAreaRatio: z.number().min(0).max(1).optional().describe("最小区域面积占比，默认 0.005"),
          clusterGap: z.number().int().nonnegative().optional().describe("区域聚类间距（px），默认 8"),
          maxRegions: z.number().int().positive().optional().describe("区域数上限，默认 20"),
          maxEdge: z.number().int().positive().optional().describe("降采样最长边，默认 1440"),
          nodeProximity: z.number().int().nonnegative().optional().describe("无交集区域判为 position-size 的最近节点距离（px），默认 24"),
          colorTolerance: z.number().int().nonnegative().optional().describe("父级填充色比较容差（0-255），默认 24"),
          systemBandRatio: z.number().min(0).max(0.25).optional().describe("上下系统边缘条带比例（无节点引用区域降级 system-area），默认 0.05")
        })
        .optional(),
      save: z.boolean().optional().describe("是否落盘产物，默认 true"),
      dryRun: z.boolean().optional().describe("仅返回计划，不取图不写盘，默认 false")
    }),
    handler: (runtime, args) => designDeviceDiff(runtime, args as unknown as DesignDeviceDiffArgs)
  },
  {
    name: "screen_map",
    description:
      "屏幕映射（持久定位资产）：维护 <项目>/.artemis/design/screen-map.json——设计屏幕/组件 ↔ 路由/组件/文件，另含元素级映射 elements（设计运行期文本 ↔ 观察标签 + accessibilityIdentifier 建议；iOS 套件运行自动发现，save 人工可补）。action=propose 基于 build-brief + 栈约定给出粗粒度候选（带 confidence 与 unmatched，需复核）；action=save 显式写入（幂等，merge:true 增量合并；elements 按 screen+text 合并、source 强制 manual、manual identifier 不被观察覆盖）；action=list 读取。design_device_diff 报告用该映射为每个差异区域输出 localized（mapped/unmapped/no-candidates）。",
    schema: z.object({
      action: z.enum(["list", "propose", "save"]).describe("list 读取 / propose 生成候选 / save 显式写入"),
      entries: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('save 用：{design:{screen,nodeId?,component?}, code:{route?,component?,file?}} 数组'),
      elements: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "save 用：{screen,text,observedLabel?,identifier?,confidence?} 元素级映射数组（source 强制 manual）"
        ),
      merge: z.boolean().optional().describe("save 时按 design key 增量合并已有映射，默认 false（替换）")
    }),
    handler: (runtime, args) => screenMap(runtime, args as unknown as ScreenMapArgs)
  },
  {
    name: "reconciliation",
    description:
      "交互对账审阅（持久资产）：维护 <项目>/.artemis/design/reconciliation.json——设计边 ↔ 真机观测命中/升级/审阅状态。action=list 列举（含来源 designProvenance→provenance、命中数、traces、审阅记录）；action=confirm 人工确认边为可信导航（human-confirmed，下一次 figma_generate_tests 以硬断言生成；幂等，记录 reviewer/时间）；action=reject 判为不成立（该边不进入后续生成）。未裁决项保持待办、不升权。iOS 套件运行自动写入观测与差异条目（见 suite run / DESIGN §13.67）。",
    schema: z.object({
      action: z.enum(["list", "confirm", "reject"]).describe("list 列举 / confirm 确认 / reject 驳回"),
      from: z.string().optional().describe("边起点屏幕名（confirm/reject 必填，与 list 输出一致）"),
      to: z.string().optional().describe("边终点屏幕名（confirm/reject 必填）"),
      reviewer: z.string().optional().describe("审阅人标识（写入资产，可省略）"),
      note: z.string().optional().describe("备注（写入资产）")
    }),
    handler: (runtime, args) => reconciliation(runtime, args as unknown as ReconciliationArgs)
  },
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

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function inProcessToolCatalog(): string[] {
  const names = new Set(NATIVE_TOOLS.map((tool) => tool.name));
  for (const tool of figmaTools()) names.add(tool.name);
  return [...names].sort();
}

function resultErrorSummary(result: CallToolResult): string {
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      return item.text.replace(/\s+/g, " ").slice(0, 160);
    }
  }
  return "unknown error";
}

function stripSchemaMeta(schema: unknown): unknown {
  if (schema && typeof schema === "object") {
    const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
    return rest;
  }
  return schema;
}

/** Build a fully wired MCP Server for one project runtime (stdio or HTTP). */
export function createServerForRuntime(runtime: Runtime | null, initError: string | null): Server {
  const server = new Server(
    { name: "aos-mcp", version: AOS_MCP_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{ name: string; description: string; inputSchema: unknown }> = NATIVE_TOOLS.map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: stripSchemaMeta(
          zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" })
        )
      })
    );

    if (runtime) {
      try {
        const proxied = await runtime.proxy.listTools();
        for (const tool of proxied) {
          // Passthrough: artemis schemas are forwarded verbatim (no zod mirroring).
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema
          });
        }
      } catch (error) {
        log(`mobile 工具不可用（artemis 子进程未就绪）: ${errorMessage(error)}`);
      }
    }

    // Figma tools (vendored design-context-bridge surface, zod-validated).
    for (const tool of figmaTools()) {
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: stripSchemaMeta(
          zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" })
        )
      });
    }
    return { tools };
  });

  const handleCall = async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const native = NATIVE_TOOLS.find((tool) => tool.name === name);

    if (native) {
      if (!runtime) {
        return errorResult(`AOS 项目初始化失败：${initError ?? "未知错误"}\nRun: aos-mcp doctor`);
      }
      const parsed = native.schema.safeParse(args ?? {});
      if (!parsed.success) {
        return errorResult(`参数校验失败: ${parsed.error.message}`);
      }
      return await native.handler(runtime, parsed.data as Record<string, unknown>);
    }

    // Figma tools work independent of the artemis runtime (plugin mode needs
    // only the bridge; REST mode needs FIGMA_ACCESS_TOKEN, synced at startup).
    if (isFigmaTool(name)) {
      try {
        return await handleFigmaTool(name, (args ?? {}) as Record<string, unknown>);
      } catch (error) {
        return errorResult(`Figma 工具 "${name}" 执行失败: ${errorMessage(error)}`);
      }
    }

    if (!runtime) {
      return errorResult(`AOS 项目初始化失败：${initError ?? "未知错误"}\nRun: aos-mcp doctor`);
    }

    // setup_required gate: mobile_run_task needs a project LLM; other mobile tools pass.
    if (name === "mobile_run_task") {
      const setup = await runtime.setupInfo();
      if (setup.required) {
        return errorResult(JSON.stringify({ ok: false, setup_required: true, ...setup }, null, 2));
      }
      // Retired-model gate: never let artemis fail mid-task on model_not_found.
      const preflight = await runtime.ensureActiveModelUsable();
      if (!preflight.ok) {
        return errorResult(JSON.stringify(preflight.payload, null, 2));
      }
      for (const warning of preflight.warnings) log(`mobile_run_task 预检: ${warning}`, "warn");
    }

    try {
      const result = await runtime.proxy.callTool(name, (args ?? {}) as Record<string, unknown>);
      if (name === "mobile_run_task") {
        const taskArgs = (args ?? {}) as Record<string, unknown>;
        // iOS runs record their own task row inside maybeIosRunTask.
        if (!traceIdOf(result)?.startsWith("ios-")) {
          void runtime.recordTaskResult({
            isError: result.isError === true,
            traceId: traceIdOf(result),
            model: typeof taskArgs.model === "string" ? taskArgs.model : null,
            taskDesc: typeof taskArgs.task_desc === "string" ? taskArgs.task_desc : null,
            lockedAppPackage:
              typeof taskArgs.locked_app_package === "string" ? taskArgs.locked_app_package : null
          });
        }
      }
      return result;
    } catch (error) {
      return errorResult(`工具 "${name}" 执行失败: ${errorMessage(error)}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = Date.now();
    const name = request.params.name;
    let result: CallToolResult;
    try {
      result = await handleCall(
        request as { params: { name: string; arguments?: Record<string, unknown> } }
      );
    } catch (error) {
      result = errorResult(`工具 "${name}" 执行失败: ${errorMessage(error)}`);
    }
    const durationMs = Date.now() - started;
    let usageId: string | null = null;
    if (runtime && name !== "aos_usage") {
      try {
        const event = await runtime.recordUsage(
          usageEventInputFrom(name, request.params.arguments ?? {}, result, durationMs)
        );
        usageId = event?.id ?? null;
      } catch (error) {
        log(`使用统计记录失败: ${errorMessage(error)}`, "warn");
      }
    }
    const ok = result.isError !== true;
    const detail = ok ? "" : ` error=${resultErrorSummary(result)}`;
    const usage = usageId === null ? "" : ` usage=${usageId}`;
    log(`tool=${name} ok=${ok} ms=${durationMs}${usage}${detail}`, ok ? "info" : "warn");
    return result;
  });

  return server;
}

export async function runServer(): Promise<void> {
  let runtime: Runtime | null = null;
  let initError: string | null = null;

  try {
    const project = loadProject();
    // Logging first: bootstrap/bridge/tool-call records must land in the log file.
    const logDir =
      process.env.AOS_LOG_DIR?.trim() ||
      path.join(configDirAbs(project.config, project.rootDir), "logs");
    const logFile = configureLogging({ logDir });
    installCrashHandlers();
    log(`aos-mcp ${AOS_MCP_VERSION} 启动（stdio）项目=${project.rootDir}`);
    if (logFile) log(`日志文件: ${logFile}`);
    // First-run/update bootstrap: installs or refreshes artemis deps when the
    // venv is missing, unmanaged, or stale against uv.lock (no-op when ready).
    const deps = await ensureArtemisDeps({
      repoDir: project.config.artemis.repo,
      source: resolveDepsSource(project.config),
      log
    });
    if (deps.status !== "ready") {
      log(`依赖状态: ${deps.status} — ${deps.message.split("\n")[0]}`);
    }
    const { store, degraded, reason } = await createProjectStore();
    runtime = new Runtime(project, { store, storeNote: reason });
    await runtime.initialize();
    if (degraded && reason) log(reason);
    log(
      `项目已注册: ${project.rootDir}` +
        (runtime.activeEntryCached()
          ? `，active LLM: ${runtime.activeEntryCached()!.name}`
          : "，未配置 LLM（setup_required）")
    );
  } catch (error) {
    initError = errorMessage(error);
    configureLogging({
      logDir:
        process.env.AOS_LOG_DIR?.trim() || path.join(process.cwd(), ".aos-mcp", "logs")
    });
    installCrashHandlers();
    log(`初始化失败: ${initError}`, "error");
  }

  if (runtime) {
    try {
      const swept = await sweepStaleChild(runtime);
      if (swept) log(swept);
    } catch (error) {
      log(`孤儿清理检查失败: ${errorMessage(error)}`);
    }
    try {
      const figmaToken = await runtime.figmaTokenInfo();
      syncFigmaTokenEnv(figmaToken.value);
    } catch (error) {
      log(`Figma token 同步失败: ${errorMessage(error)}`);
    }
  }

  // stdio mirror of the HTTP-mode sync loop: terminal tasks are re-checked so
  // crash forensics fires without waiting for an explicit aos_tasks call.
  const syncTimer = runtime
    ? setInterval(() => {
        void runtime.syncTaskStatuses();
        runtime.maybeRefreshModels();
      }, SYNC_INTERVAL_MS)
    : null;
  syncTimer?.unref?.();
  runtime?.maybeRefreshModels();

  try {
    const bridge = await startBridge();
    log(bridge.message || `Figma bridge: ${bridge.status}`);
  } catch (error) {
    log(`Figma 桥启动失败: ${errorMessage(error)}`);
  }

  const server = createServerForRuntime(runtime, initError);

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (syncTimer) clearInterval(syncTimer);
    try {
      await runtime?.proxy.dispose();
    } catch {
      /* best effort */
    }
    try {
      await runtime?.disposeIosWda();
    } catch {
      /* best effort */
    }
    try {
      await runtime?.store.close();
    } catch {
      /* best effort */
    }
    try {
      await stopBridge();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.onclose = () => {
    void shutdown(0);
  };
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  process.on("exit", () => {
    runtime?.proxy.disposeSync();
  });
  process.stdin.on("end", () => void shutdown(0));

  log(`aos-mcp ${AOS_MCP_VERSION} 已启动（stdio）`);
}
