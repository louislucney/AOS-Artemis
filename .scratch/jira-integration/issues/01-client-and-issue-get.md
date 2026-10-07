# 01 — Jira 客户端与凭证配置（含 jira_issue_get）

**What to build:** 打通「配置 → 调用 → 读取」第一条端到端路径：`aos_configure` 接受 `jiraSite` / `jiraEmail` / `jiraApiToken` 并写入项目 `.env`；`aos_status` 显示 masked 就绪状态；新增 Jira 客户端（Basic auth、站点校验、429 有界等待 + 按凭证冷却、超时、401/403/404 可行动错误）；新增 `jira_issue_get` 工具，把 issue 规范化为纯文本描述 + 启发式验收标准（保留原始 ADF）。完成后配置沙箱凭证即可真实读取一个 issue。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] `.env` 契约：`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` 三变量，`aos_configure` 三者必须同时提供、站点仅接受 `https://*.atlassian.net`（去尾斜杠）、响应只回 masked 预览
- [x] `aos_status.jira` 输出 configured / site / email / token（present + masked + envVar）/ missing
- [x] 客户端：Basic auth、`AbortSignal.timeout`（`AOS_JIRA_TIMEOUT_MS` 默认 30s）、429 长冷却 fail-fast（`AOS_JIRA_RETRY_MAX_WAIT_MS` 默认 60s）+ 短等待重试一次、401/403/404/413 hint、无响应缓存
- [x] `jira_issue_get` 接受 issue key 或 browse URL：返回 key/id/url/summary/status/type/labels/project/assignee/reporter/updated + description.text（ADF→纯文本）+ acceptanceCriteria（标题段与 `AC:` 行，标注 heuristic）+ raw ADF
- [x] 缺配置/非法 key 返回 `{ ok:false, error, howToFix }` 且 isError
- [x] 测试：fetch 打桩覆盖认证头/错误映射/冷却/短等待；ADF 转换与 AC 抽取纯函数；工具响应契约与配置写入（`.env` + masked）；usage family `jira`
- [x] DESIGN §13 实施记录 + README Jira 小节 + AGENTS 速查同步；build/test/lint 全绿

## Comments

- 2026-10-07 实施：新增 `src/jira/{config,client,adf,context}.ts` + `src/tools/jira.ts`；`aos_configure` 三件套、`aos_status.jira`、usage family `jira`、`.env` 模板同步；测试 `test/jira-context.test.js`（6）/`test/jira-client.test.js`（5）/`test/jira-tools.test.js`（9），全量 631 用例、lint 干净。见 DESIGN §13.55。
