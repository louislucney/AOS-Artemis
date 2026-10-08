# 06 — issue tracker 迁移与沙箱验收

**What to build:** 把本仓库 agent 工作流的 issue tracker 从 `.scratch` 本地 markdown 迁移为 Jira：重写 `docs/agents/issue-tracker.md`（沙箱项目 + 默认约定：Task=工单、Bug=缺陷、Epic=wayfinder 地图；To Do→In Progress→Done；五类 triage 标签原样；Blocks 链接；讨论/答案写评论），同步 AGENTS.md 的 Agent skills 摘要；用 CLI 在沙箱完成一轮真实验收（发布一张 spec、一组带阻塞边的 ticket、claim/resolve 一条、评论一条、Blocks 链接一条），并把验收记录写入本文档 Comments。

**Blocked by:** 05 — CLI `jira`（技能所需操作）。

**Status:** ready-for-human

- [x] `docs/agents/issue-tracker.md` 重写为 Jira 工作流（含 CLI 示例与查询约定）；AGENTS.md 摘要同步
- [ ] 沙箱端到端验收通过：建单、标签、评论、流转、Blocks、JQL 查询各至少一次，记录 trace/键值
- [x] triage 标签词汇表（五类）保持原字符串；wayfinder 的 map/child/claim/resolve 语义在 Jira 中的对应关系成文
- [x] DESIGN/README 同步（工作流迁移说明）；build/test/lint 全绿

## Comments

## Comments

- 2026-10-08 文档迁移完成：`docs/agents/issue-tracker.md` 重写为 Jira 工作流（对象映射：Task=工单/Bug=缺陷/Epic=wayfinder 地图；Blocks=阻塞边（inward=blocker）；五类 triage 标签原样；claim=`In Progress`、resolve=`Answer:` 评论 + `Done`；CLI 常用命令与 `--project`/`--json`/exit 0/1/2；JQL 有界查询与"无 total"约定；to-spec/to-tickets/triage/wayfinder 对应操作）；`docs/agents/triage-labels.md` 增加 tracker 映射；AGENTS.md 摘要与 DESIGN §6.8/README 同步。
- 2026-10-08 **沙箱端到端验收：待执行**——服务仓库 `.env` 与 starbuckstw 项目均无 `JIRA_*` 凭证（进程 env 亦无），无法在无凭证情况下触网。接受收方提供沙箱站点/邮箱/token + project key 后，按下列步骤验收并回填本评论区：
  1) `jira issue create --project-key <K> --summary "spec: …" --type Task --label ready-for-agent`（spec）
  2) 同 Epic 下建 2 张 Task + `jira issue link --inward <BLOCKER> --outward <BLOCKED>`（阻塞边）
  3) `jira issue transition <CHILD> --to "In Progress"` + `jira issue comment <CHILD> --body "claim: owner=<you>"`（claim）
  4) `jira issue comment <CHILD> --body "Answer: …"` + `--to "Done"`（resolve）
  5) `jira_issue_search(jql="project = <K> AND status != Done ORDER BY created DESC")` 复核；`jira_evidence_post`（可选，用任一 traceId 验证证据回写）
