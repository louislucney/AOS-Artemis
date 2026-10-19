import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { designToTest, type DesignToTestArgs } from "../../workflow/design-to-test.js";
import { projectArchive } from "../../workflow/project-archive.js";
import { runRegression, type RunRegressionArgs } from "../../workflow/run-regression.js";
import { verifyJiraIssue, type VerifyJiraIssueArgs } from "../../workflow/verify-jira.js";

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
      maxFlows: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe(
          "生成用例条数上限（透传 figma_generate_tests，默认 10；vision 全量探索路径多时可调大以避免覆盖闸「路径截断」）"
        ),
      maxDepth: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("路径最大深度（边数；透传 figma_generate_tests，默认 30；超限按续段拆分，不丢尾）"),
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
      "回归一条龙：用户要做回归/重跑验证时优先用它——有 Excel 测试文档（excelPath，.xlsx）时导入用例库（按模块拆集、同内容幂等复用）并执行；没有文档时按 scope 关键词（功能/模块/用例名）在用例库里选最新份，或 all/缺省跑库内每个功能的最新一份全量。执行前回显回归目标（功能×条数＋来源：导入自 x / 生成自 y）并写服务日志；逐集执行后聚合报告（run manifest 路径、通过/失败计数与 gate：用例失败但已执行仍 ok:true）。前置自检：LLM 连通性与在线设备先于导入/选择——无设备→needs-setup、多台未指定→needs-info，needs-setup/needs-info 均为非 isError 的结构化指引（先问不猜、补全后重跑）；单步失败返回 failedStep/detail/suggestions。Excel 导入要求首行表头（用例名、步骤；可选：预期、前置、模块），列名可用 columns 覆盖，合并单元格会显式报错。",
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
        .describe("目标设备 serial / UDID；缺省自动盘点（多于一台先问）"),
      columns: z
        .object({
          name: z.string().optional(),
          steps: z.string().optional(),
          expected: z.string().optional(),
          preconditions: z.string().optional(),
          module: z.string().optional()
        })
        .optional()
        .describe("Excel 列名覆盖（默认自动识别；按字段给出实际表头文本）")
    }),
    handler: (runtime, args) => runRegression(runtime, args as unknown as RunRegressionArgs)
  },
  {
    name: "verify_jira_issue",
    description:
      "Jira 验证一条龙：用户给出 Jira 单号（issueKey，如 AOS-123 或 browse URL）并要求验证/复验该单时优先用它——读单分档 → 用例库映射或单子即用例 → 执行 → 聚合 → 回写。详细单优先做用例库映射（LLM 辅助但约束只能从清单中选或答没有；库空/无匹配时按单子步骤直接合成「单子即用例」执行并注明来源）；粗单（一句话/无步骤/无预期）返回 needs-info 先问（功能页面、触发条件、期望结果）。执行前回显将跑的用例（数量＋来源＋设备）并写服务日志。聚合口径：任一强断言失败→FAIL；全弱/全探索→无法判定（弱断言仅记录路径，不代表验证通过，评论披露构成）；quarantine 失败不计门禁。回写（外部副作用，默认执行）：失败证据评论/附件幂等＋结论评论同单复用（marker AOS-VERIFY:<单号>，显式标注自动验证）；不自动写 verdict，只写 jira_issue_key 关联；dryRun 零写回（不产生任何外部副作用；读单/评论读取不变）；响应含结论预览。前置：Jira 凭证＋LLM 连通性＋在线设备——缺→needs-setup、多台未指定→needs-info（均非 isError 结构化指引，先问不猜）；scope 给定时覆盖映射（按关键词选用例库最新份，不调 LLM）；device 缺省自动盘点。单步失败返回 failedStep/detail/suggestions。",
    schema: z.object({
      issueKey: z.string().describe("Jira 单号（如 AOS-123）或 browse URL；必填"),
      device: z.string().optional().describe("目标设备 serial / UDID；缺省自动盘点（多于一台先问）"),
      scope: z
        .string()
        .optional()
        .describe("覆盖映射的范围关键词（功能/用例名，归一化匹配）；给定时不调 LLM 映射"),
      dryRun: z.boolean().optional().describe("只执行不写回（零外部副作用），响应含结论评论预览")
    }),
    handler: (runtime, args) => verifyJiraIssue(runtime, args as unknown as VerifyJiraIssueArgs)
  },
  {
    name: "project_archive",
    description:
      "项目档案（只读摘要面）：汇总 项目与栈 / 设计血统（flows 来源/落盘时间/屏边数/provenance 构成）/ 用例库（每功能最新份与导入自/生成自来源）/ 最近运行（近 10 批清单：gate/通过率/失败域）/ 裁决与 Jira 关联摘要 / 前置状态（figma/pen/jira/llm 就绪，masked 预览）。只读铁律：不触网、无子进程、不写盘；前置项仅静态存在性并显式「未复核」（真实复核在各流程工具首步）。缺数据如实标注：未配置持久台账（登记读自会话内存）/flows.json 不可解析/清单坏件等以 degraded[] 标注，恒返回 ok:true（非 isError）。无参数。",
    schema: z.object({}),
    handler: (runtime) => projectArchive(runtime)
  }
];
