import type { NativeToolDefinition } from "./types.js";
import { z } from "zod";
import { jiraEvidencePost, jiraIssueAttach, jiraIssueComment, jiraIssueGet, jiraIssueSearch, type JiraEvidencePostArgs, type JiraIssueAttachArgs, type JiraIssueCommentArgs, type JiraIssueGetArgs, type JiraIssueSearchArgs } from "../jira.js";

/** Jira 域原生工具（DESIGN §13.89）。 */
export const JIRA_NATIVE_TOOLS: NativeToolDefinition[] = [
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
];
