# Jira 接入（jira-integration）— spec

**Status:** ready-for-agent

## Problem Statement

AOS 的测试链路目前从 Figma/pen 设计稿出发，但真实团队的需求与缺陷都沉淀在 Jira：测试任务描述、验收标准、回归范围来自 issue；执行证据（失败截图、diff 标注图、崩溃签名、套件台账）却只能留在本地 `.artemis/`，缺陷要靠人手工搬运到 Jira。同时，本仓库自身的 agent 工作流（to-spec / to-tickets / triage / wayfinder）仍以 `.scratch` 本地 markdown 记录 issue，与团队真实使用的 Jira 脱节，跨人协作与状态追踪靠手工同步。没有接入，链路的起点（需求）与终点（缺陷闭环）都在系统之外断掉。

## Solution

为 AOS MCP 增加 Jira Cloud 原生接入（Jira 云端 REST API v3，Email + API Token 认证）：

- **产品能力（首期 ①②）**：新增 `jira_issue_get` / `jira_issue_search` 读取工具（issue 上下文规范化为纯文本 + 启发式验收标准标注，供 agent 直接生成测试用例）；新增 `jira_issue_comment` / `jira_issue_attach` 回写原语与 composite `jira_evidence_post`（按 traceId 自动收集失败证据 + 崩溃签名，以“单条评论就地更新”的幂等方式写回 issue，附件按确定性命名 + 内容哈希去重）。
- **仓库工作流（B，紧随 A）**：`node dist/cli.js jira ...` 覆盖技能所需操作（建单、标签、评论、流转、Blocks 链接），`docs/agents/issue-tracker.md` 从本地 markdown 迁移为 Jira 约定，to-spec / to-tickets / triage / wayfinder 经 CLI 读写 Jira。
- **平台覆盖**：Android / iOS 两端验收；证据与评论显式携带平台维度（android|ios + 设备 serial），iOS 取证依赖 macOS 宿主。

## User Stories

1. 作为测试工程师，我想让 agent 直接读取 Jira issue 的摘要、描述与验收标准，以便不复制粘贴就能生成覆盖需求的测试用例。
2. 作为测试工程师，我想让 `jira_issue_get` 返回规范化纯文本描述（并保留原始 ADF），以便 LLM 低成本理解需求。
3. 作为测试工程师，我想验收标准被启发式标注出来（关键词：Acceptance Criteria / 验收标准 / AC），以便关键约束不被淹没在描述里。
4. 作为测试工程师，我想用 JQL 搜索 issue（如 `project = X AND status != Done`），以便批量圈定回归范围。
5. 作为测试工程师，我想搜索结果支持游标分页（nextPageToken），以便大结果集不被截断。
6. 作为测试工程师，我想把一次任务/套件的失败证据（失败步骤截图、diff 标注图、报告摘要）一键写回对应的 Jira issue，以便缺陷上下文完整。
7. 作为测试工程师，我想同一 trace 重复回写时更新同一条评论而不是刷屏，以便 issue 评论可读。
8. 作为测试工程师，我想附件按确定性命名与内容哈希去重，以便重复回写不产生重复附件。
9. 作为测试工程师，我想证据回写自动附带崩溃签名摘要（若该 trace 有崩溃），以便缺陷单直接携带根因线索。
10. 作为测试工程师，我想证据带 Android / iOS 平台与设备 serial，以便区分平台差异问题。
11. 作为 QA 负责人，我想 iOS 与 Android 的验收都在真实链路中跑通，以便两端证据都可信。
12. 作为服务开发者，我想通过 `aos_configure` 一次写入 Jira 站点 / 邮箱 / API token 到项目 `.env`，以便配置入口与现有 LLM 配置一致。
13. 作为服务开发者，我想 `aos_status` 显示 Jira 配置状态（masked）与缺失项，以便快速排障。
14. 作为服务开发者，我想凭证实时从项目 `.env` 读取、不落 PG、日志不落 token，以便满足仓库安全约定。
15. 作为服务开发者，我想站点仅接受 `https://*.atlassian.net`，以便 v1 明确排除 Server/DC 与 SSRF 面。
16. 作为服务开发者，我想 429 按 Figma 模式处理（Retry-After 有界等待 + 按凭证冷却 fail-fast、无响应缓存），以便限流下行为可预期。
17. 作为服务开发者，我想 401/403/404 返回可行动的错误文案（含 API token 一年有效期提醒），以便用户自助修复。
18. 作为使用 Jira 的团队，我想用 CLI 从本仓库发布 spec / ticket 到 Jira（Task / Bug），以便 matt pocock 工作流落在真实 tracker 上。
19. 作为使用 Jira 的团队，我想 triage 五类标签原样作为 Jira label，以便现有词汇表不变。
20. 作为使用 Jira 的团队，我想 ticket 状态用 To Do → In Progress → Done，claim/resolve 经 CLI 流转，以便 wayfinder 语义保留。
21. 作为使用 Jira 的团队，我想 ticket 间“阻塞”关系用 Blocks 链接，以便依赖图在 Jira 内可见。
22. 作为使用 Jira 的团队，我想讨论与答案以 issue 评论承载，以便历史在 tracker 内闭环。
23. 作为 agent 使用者，我想所有 Jira 工具/CLI 离线可测（fetch 打桩、不触网），以便 CI 稳定且无需真实 Jira。
24. 作为 agent 使用者，我想有沙箱站点可做真实冒烟验收，以便接入在真实 API 上被验证。
25. 作为服务维护者，我想行为变更同步 DESIGN / README / AGENTS / CONTEXT，以便文档保持事实源。

## Implementation Decisions

- **形态与里程碑**：产品级集成（A）与仓库工作流接入（B）都做；顺序 M8a（client + 凭证 + 读取）→ M8b（证据回写）→ M8c（CLI + tracker 迁移 + 沙箱验收）；建单（③）与状态双向同步（④）留后续里程碑。
- **领域模块**：新增 Jira 领域模块（配置、客户端、ADF 处理、issue 上下文规范化）与工具模块（读写工具 + evidence composite）；Runtime 暴露 Jira 配置视图给工具与 `aos_status`。
- **工具面**：`jira_issue_get`（key 或 browse URL → 规范化上下文）、`jira_issue_search`（JQL → `/rest/api/3/search/jql` 游标分页）、`jira_issue_comment`、`jira_issue_attach`、`jira_evidence_post`（composite，显式 issueKey + traceId + platform/serial）。工具名统一 `jira_` 前缀；usage family 增加 `jira`。
- **读取契约**：issue 上下文含 key/id/url/summary/status/type/labels/project/assignee/reporter/updated；`description.text`（ADF→纯文本）、`description.acceptanceCriteria`（启发式：标题段 + `AC:` 行，标注 heuristic）、`description.raw`（原始 ADF）。搜索默认字段集 summary/status/issuetype/labels/updated/assignee/project，limit 默认 20、上限 100，透传 nextPageToken/isLast。
- **ADF 子集**：纯文本转换覆盖 doc/paragraph/heading/bulletList/orderedList/listItem/codeBlock/blockquote/panel/text/hardBreak/mention/emoji/inlineCard/media/rule/table；评论构造用最小 ADF（段落/列表/代码块/引用）。
- **凭证与配置**：扩展 `aos_configure`（新增 `jiraSite` / `jiraEmail` / `jiraApiToken`，必须三者同时提供），写项目 `.env` 的 `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`；调用时经 resolver 实时读取（进程 env 优先）；`aos_status.jira` 输出 configured/site/email/token masked/missing；站点校验 `https://<site>.atlassian.net`（去尾斜杠）；不落 PG、不新增表；日志与响应只出 masked 预览。
- **客户端与限流**：Basic auth（email:token）；`AbortSignal.timeout` 超时（`AOS_JIRA_TIMEOUT_MS`，默认 30s）；429 读取 `Retry-After` 与 `RateLimit-Reason`：等待时长 ≤ `AOS_JIRA_RETRY_MAX_WAIT_MS`（默认 60s）时等待一次并重试，否则按凭证指纹记录冷却并抛 `JiraRateLimitError`（冷却期内 fail-fast 不打 API）；不做响应缓存；非 2xx 抛 `JiraApiError`（status + body 截断 + 可行动 hint）。
- **证据回写原语**：评论以隐藏标记（优先 comment properties，字段不可用时退化为页脚文本标记 `[aos:trace=<id>]`）定位同 issue+trace 的历史评论，存在则更新（PUT）否则新建（POST）；附件命名确定性（trace/step/kind + 内容 sha256 短码），上传前比对 issue 既有附件跳过同内容；路径限项目根内；单文件保守上限（取站点 `/attachment/meta` 与本地上限的较小值），超限记 warning 而非失败。
- **evidence composite**：输入 `issueKey` + `traceId` + 可选 `platform`（android|ios）/`deviceSerial`/`dryRun`；从 trace 产物与套件台账收集失败证据，crash 索引中若有该 trace 的签名则附摘要；评论为中文结构化摘要（平台、设备、trace、失败清单、失败域、产物清单）。
- **CLI `jira`**：子命令与工具共用客户端；建单（Task/Bug，标题/描述/标签/父/链接）、标签增删、评论、流转（按当前可用 transition 匹配目标状态名）、Blocks 链接；`--project` 指定项目根（沿用 CLI 约定）、`--json`。
- **工作流约定（B）**：沙箱项目先跑通；Task=工单、Bug=缺陷、Epic=wayfinder 地图；状态 To Do→In Progress→Done；五类 triage 标签原样；阻塞用 Blocks；讨论/答案写评论；`docs/agents/issue-tracker.md` 重写为 Jira 版并同步 AGENTS.md 摘要。
- **约束**：不新增 npm 依赖（Node 内置 fetch/FormData/Blob）；stdout 规范不变；离线可测；里程碑表与实施记录按仓库惯例追加。

## Testing Decisions

- 好测试只验证外部行为：请求形状（URL/method/认证头/body）、错误映射与冷却行为、工具响应契约、配置写入与 masked、usage family；不测私有实现细节。
- 接缝与先例（优先复用既有接缝）：
  1. **HTTP**：`globalThis.fetch` 打桩（先例 `test/figma-limits.test.js`）——认证头、429 长冷却 fail-fast / 短等待重试、401/403/404 hint、超时、搜索 body 与分页透传。
  2. **ADF/上下文**：纯函数单测——各类节点转文本、AC 标题段与 `AC:` 行、无 AC 返回空、raw 保留。
  3. **工具**：`loadTestRuntime` + `parseToolResult`（先例 `test/crash-tools.test.js`）——缺配置的可行动错误、get/search 响应契约、非法 key。
  4. **配置**：`makeTempProject` + `aosConfigure` 直调（先例 configure 相关测试）——三变量写 `.env`、masked 预览、非法站点拒绝、部分提供拒绝；`aos_status.jira` 缺失/就绪两态。
  5. **CLI（M8c）**：`suite-command.test.js` 风格注入 io/假客户端。
- 全程不依赖真实 Jira / 外网；真实沙箱冒烟为人工验收（非 `npm test`）。

## Out of Scope

- Jira Server / Data Center（REST v2、PAT）与自托管站点。
- OAuth 2.0 3LO / Forge / Connect 应用形态与 marketplace 发布。
- Xray / Zephyr 等测试管理插件的字段级同步。
- 视频等大附件、附件回读与内容比对、评论富文本回读。
- 任务完成自动回写（需要 issue↔trace 持久关联表）与状态双向同步（④）。
- 建单工具（③，M8c 仅 CLI 覆盖技能所需）。
- Jira 侧 webhook 入站与监听。

## Further Notes

- 关键 API 事实（2026-10 核对，来源 developer.atlassian.com）：搜索必须走 `/rest/api/3/search/jql`（旧 `/search` 正在移除；游标 nextPageToken、无 total、fields 默认仅 id，需显式传、JQL 必须有界；计数用 `/search/approximate-count`）；评论 REST v3 强制 ADF；附件上传需 `multipart/form-data` 字段 `file` 与 `X-Atlassian-Token: no-check`，站点上限读 `/rest/api/3/attachment/meta`；Blocks 链接 `POST /rest/api/3/issueLink`；API token 现行 1 年有效期制，需在 401 文案中提示轮换。
- 沙箱站点/邮箱/token 与 project key 由使用方提供（实现前不阻塞，自动测试全 mock）。
- 平台备注：iOS 证据采集与模拟器执行仅在 macOS 宿主可用；Linux 服务器上 Jira 读写本身不受影响（纯 REST）。
- 里程碑落地时按仓库惯例同步：DESIGN 里程碑表 + §13 实施记录、README 小节、AGENTS 速查、CONTEXT 术语（如有）。
