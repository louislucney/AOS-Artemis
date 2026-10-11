import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { aosConfigure, type ConfigureArgs } from "../configure.js";
import { aosCrashes, type AosCrashesArgs } from "../crash.js";
import { aosStatus, aosTasks, type AosTasksArgs } from "../llm.js";
import { aosUsage, type AosUsageArgs } from "../usage.js";

/** AOS 域原生工具（DESIGN §13.89）。 */
export const AOS_NATIVE_TOOLS: NativeToolDefinition[] = [
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
];
