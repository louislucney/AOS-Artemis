import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import {
  llmList,
  llmModels,
  llmPoolList,
  llmSwitch,
  llmUsage,
  type LlmModelsArgs,
  type LlmSwitchArgs,
  type LlmUsageArgs
} from "../llm.js";

/** LLM 域原生工具（DESIGN §13.89）。 */
export const LLM_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "llm_pool_list",
    description:
      "查看当前项目绑定的 LLM 资源池 token（只读）：状态/模型/预算/token 快照，key 只返回 masked 预览；不返回其他项目或未绑定 token。管理（增改/绑定/价格）用 CLI `llm pool ...`。",
    schema: z.object({}),
    handler: (runtime) => llmPoolList(runtime)
  },
  {
    name: "llm_usage",
    description:
      "查看当前项目的 LLM 用量报表（只读）：按项目/模型/token/时间聚合 tokens 与金额；金额只用本位币 cost 字段，未定价/缺汇率单独计数；不返回 key。",
    schema: z.object({
      since: z.string().optional().describe("起始 ISO 时间（含）"),
      until: z.string().optional().describe("结束 ISO 时间（含）"),
      bucket: z.enum(["hour", "day", "month"]).optional().describe("按 UTC 时间分桶"),
      groupBy: z
        .enum(["project", "model", "token", "none"])
        .optional()
        .describe("分组维度，默认 none"),
      model: z.string().optional().describe("只统计指定模型"),
      token: z.string().optional().describe("只统计指定池 token id")
    }),
    handler: (runtime, args) => llmUsage(runtime, args as LlmUsageArgs)
  },
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
];
