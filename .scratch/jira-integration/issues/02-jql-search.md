# 02 — JQL 搜索（jira_issue_search）

**What to build:** `jira_issue_search` 工具：按 JQL 调用 `/rest/api/3/search/jql`，显式字段集与游标分页（nextPageToken/isLast），limit 默认 20、上限 100；结果按 issue 摘要行输出（key/url/summary/status/type/labels/updated/assignee）。完成后 agent 可用 JQL 批量圈定回归范围。

**Blocked by:** 01 — Jira 客户端与凭证配置（含 jira_issue_get）。

**Status:** ready-for-agent

- [x] POST body 形状：jql / maxResults / fields / nextPageToken 透传；响应 count / isLast / nextPageToken
- [x] 字段默认 summary/status/issuetype/labels/updated/assignee/project；JQL 空串或非法返回可行动错误
- [x] 429/401/403 行为与 01 的客户端一致；无缓存
- [x] 测试：请求 body 断言、分页透传、缺失配置错误、JQL API 错误映射
- [x] DESIGN/README 同步（工具表与用法）；build/test/lint 全绿

## Comments

- 2026-10-07 实施：`jira_issue_search` 走 `/rest/api/3/search/jql`（POST，显式字段，limit 1–100，游标透传）；复用 01 的客户端与错误映射；测试见 `test/jira-tools.test.js`。见 DESIGN §6.8/§13.55。
