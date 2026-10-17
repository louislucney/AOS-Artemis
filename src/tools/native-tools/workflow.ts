import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { designToTest, type DesignToTestArgs } from "../../workflow/design-to-test.js";
import { runRegression, type RunRegressionArgs } from "../../workflow/run-regression.js";

/** 设计→测试一条龙 域原生工具（DESIGN §13.89）。 */
export const WORKFLOW_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "design_to_test",
    description:
      "设计→测试一条龙（CR 流程）：用户给出设计稿（Figma 链接或 .pen 文件）并要求产出并验证用例时优先用它——一条龙串起 前置自检→读设计→懂交互→出用例→校验→可选执行（等价于 figma/pen 流程提取 → figma_generate_tests → suite check → 可选 suite run 的手工串跑）。设计来源二选一：figmaUrl 或 penPath；已有 .artemis/design/flows.json 时传 reuseExistingFlows:true 跳过提取直接复用。run 缺省 false：默认止于校验，响应含 nextAction 指引以 reuseExistingFlows:true + run:true 续跑；显式 run:true 才执行（未指定 device 先盘点设备，多于一台返回 needs-info 询问）。缺前置（Figma token / pen 登录 / LLM 连通性 / 在线设备）返回 needs-setup、信息不足返回 needs-info——均为非 isError 的结构化指引（needs-setup 时 checks[]：每项 missing/howTo；needs-info 时 questions/context），先问不猜、补全后重跑；单步失败返回 failedStep/detail/suggestions。产物在 <项目>/.artemis/design/（tests.json/md/xlsx 三件套）。",
    schema: z.object({
      figmaUrl: z
        .string()
        .optional()
        .describe("Figma 文件 URL（建议带 ?node-id=）；与 penPath 二选一"),
      nodeId: z.string().optional().describe("覆盖 URL 中的 node-id（仅 figmaUrl 时可用）"),
      penPath: z
        .string()
        .optional()
        .describe("相对项目根或绝对路径的 .pen 设计文件；与 figmaUrl 二选一"),
      vision: z
        .union([z.literal("auto"), z.boolean()])
        .optional()
        .describe('pen 源视觉识别："auto"（默认，active LLM 具备视觉时启用）| true（强制尝试）| false（关闭）；仅 penPath'),
      reuseExistingFlows: z
        .boolean()
        .optional()
        .describe("复用已有 .artemis/design/flows.json，跳过设计提取，默认 false"),
      device: z
        .string()
        .optional()
        .describe("run:true 时的目标设备 serial / UDID；缺省自动盘点（多于一台先问）"),
      run: z
        .boolean()
        .optional()
        .describe("执行生成的用例，默认 false（止于校验，响应含 nextAction 指引续跑）")
    }),
    handler: (runtime, args) => designToTest(runtime, args as unknown as DesignToTestArgs)
  },
  {
    name: "run_regression",
    description:
      "回归一条龙：用户要做回归/重跑验证时优先用它——有 Excel 测试文档（excelPath，.xlsx）时导入用例库（按模块拆集、同内容幂等复用）并执行；没有文档时按 scope 关键词（功能/模块/用例名）在用例库里选最新份，或 all/缺省跑库内每个功能的最新一份全量。执行前回显回归目标（功能×条数＋来源：导入自 x / 生成自 y）并写服务日志；逐集执行后聚合报告（run manifest 路径、通过/失败计数与 gate：用例失败但已执行仍 ok:true）。前置自检：LLM 连通性与在线设备先于导入/选择——无设备→needs-setup、多台未指定→needs-info，needs-setup/needs-info 均为非 isError 的结构化指引（先问不猜、补全后重跑）；单步失败返回 failedStep/detail/suggestions。Excel 导入要求首行表头（用例名、步骤；可选：预期、前置、模块），合并单元格会显式报错。",
    schema: z.object({
      excelPath: z
        .string()
        .optional()
        .describe("Excel 测试文档路径（.xlsx，相对项目根或绝对）；导入后执行该导入集"),
      scope: z
        .string()
        .optional()
        .describe(
          "回归范围关键词（功能/模块/用例名，归一化匹配）；与 excelPath 同用时在该导入集内过滤"
        ),
      all: z
        .boolean()
        .optional()
        .describe("显式跑库内每个功能的最新一份全量（缺省行为同此；与 excelPath/scope 互斥）"),
      device: z
        .string()
        .optional()
        .describe("目标设备 serial / UDID；缺省自动盘点（多于一台先问）")
    }),
    handler: (runtime, args) => runRegression(runtime, args as unknown as RunRegressionArgs)
  }
];
