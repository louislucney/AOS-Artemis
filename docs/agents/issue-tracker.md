# Issue tracker: Jira Cloud（沙箱）

本仓库 agent 工作流的 issue/spec/ticket 以 **Jira Cloud 沙箱项目**为准，通过 `jira` CLI（与 MCP Jira 工具共用同一客户端与凭证）读写；`.scratch/<feature>/` 本地 markdown 仅保留为 M8 之前的**历史票据归档**，新工作不再使用。

## 凭证与沙箱

- 凭证在项目 `.env`：`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`（MCP `aos_configure(jiraSite, jiraEmail, jiraApiToken)` 可三件套写入；站点仅接受 `https://*.atlassian.net`）。
- 沙箱 project key 由使用方提供（下文记 `<KEY>`）。
- 连通性自检：`node dist/cli.js jira issue create --project-key <KEY> --summary "smoke"`，或 MCP `jira_issue_search`（JQL 有界）。

## 对象映射（工作流语义）

| 工作流概念 | Jira 对象 |
| --- | --- |
| spec / 工单 | `Task`（`issue create --type Task`） |
| 缺陷 | `Bug`（`issue create --type Bug`） |
| wayfinder 地图 | `Epic`；child ticket 用 `--parent <EPIC-KEY>` 挂到地图 |
| 阻塞边（Blocked by） | Blocks 链接：`issue link --inward <blocker> --outward <blocked>`（blocker blocks blocked） |
| triage 标签 | 五类原样字符串：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`（`issue label --add/--remove`） |
| 认领（claim） | `issue transition <KEY> --to "In Progress"` + 评论留下 owner/上下文 |
| 解决（resolve） | 评论追加 `Answer:` 段落 + `issue transition <KEY> --to "Done"` |
| 讨论 / 答案 / 指针 | 评论：`issue comment <KEY> --body "…"`（纯文本，空行分段；MCP 侧自动转 ADF） |
| 失败证据 | MCP `jira_evidence_post`（traceId 幂等评论 + 去重附件） |

状态机：`To Do → In Progress → Done`（按目标状态名匹配当前可用 transition；不匹配时 CLI 会列出可用项）。

## 常用命令

```bash
# 建单（Task/Bug；描述纯文本；标签逗号分隔；父级挂 Epic；Blocks 链接）
node dist/cli.js jira issue create --project-key <KEY> --summary "标题" --type Task \
  --description "背景…\n\n验收标准…" --label ready-for-agent --parent <EPIC-KEY> --blocks <OTHER-KEY>

# 评论（可带 traceId 幂等回写）
node dist/cli.js jira issue comment <KEY> --body "Answer: …" [--trace <traceId>]

# 标签增删
node dist/cli.js jira issue label <KEY> --add ready-for-agent --remove needs-triage

# 流转（按目标状态名匹配）
node dist/cli.js jira issue transition <KEY> --to "In Progress"

# Blocks 链接（blocker blocks blocked）
node dist/cli.js jira issue link --inward <BLOCKER-KEY> --outward <BLOCKED-KEY>

# 公共：--project <dir> 指定项目根；--json 机器可读；exit 0 成功 / 1 请求或配置失败 / 2 用法错误
```

## 查询约定

- 列表/检索走 MCP 工具 `jira_issue_search`：JQL 必须有界，如 `project = <KEY> AND status != Done ORDER BY created DESC`（limit ≤100，游标 `nextPageToken`）。
- 搜索响应**无 total**：需要计数时按 labels/status 分次查询或取回后本地计数。
- 详情读取走 MCP `jira_issue_get`（描述纯文本 + 启发式验收标准 + 原始 ADF）。

## 技能工作流（to-spec / to-tickets / triage / wayfinder）

- **to-spec**：在目标 Epic（地图）下建 `Task`，`--description` 写 spec 正文（纯文本、空行分段），初始标签 `needs-triage` 或 `ready-for-agent`。
- **to-tickets**：每张 tracer-bullet ticket 建一个 `Task`；所有阻塞边用 Blocks 链接（inward=blocker）；正文含验收标准与验证方式。
- **triage**：用 `issue label` 在五类标签间迁移；`needs-info` 时评论提出问题；可动手 → `ready-for-agent`；需人工 → `ready-for-human`；关闭 → `wontfix`（如可用则同时流转 Done）。
- **wayfinder**：地图 = `Epic`；child ticket = `Task`（`--parent` 挂地图）；claim = 流转 `In Progress` + 评论 owner/上下文；resolve = 评论 `Answer:` + 流转 `Done` + 在 Epic 评论附 context pointer（gist + 链接）。
- 失败证据回写统一走 `jira_evidence_post`（同一 trace 幂等更新评论、附件按内容哈希去重）。

> 沙箱端到端验收（发布 spec、带阻塞边的一组 ticket、claim/resolve、评论、Blocks）记录在 `.scratch/jira-integration/issues/06-tracker-migration.md` 的 Comments；在提供沙箱凭证前保持待办。
