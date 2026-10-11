import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { llmList, llmModels, llmSwitch, type LlmModelsArgs, type LlmSwitchArgs } from "../llm.js";

/** LLM 域原生工具（DESIGN §13.89）。 */
export const LLM_NATIVE_TOOLS: NativeToolDefinition[] = [
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
