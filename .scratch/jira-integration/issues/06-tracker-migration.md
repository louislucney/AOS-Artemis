# 06 — issue tracker 迁移与沙箱验收

**What to build:** 把本仓库 agent 工作流的 issue tracker 从 `.scratch` 本地 markdown 迁移为 Jira：重写 `docs/agents/issue-tracker.md`（沙箱项目 + 默认约定：Task=工单、Bug=缺陷、Epic=wayfinder 地图；To Do→In Progress→Done；五类 triage 标签原样；Blocks 链接；讨论/答案写评论），同步 AGENTS.md 的 Agent skills 摘要；用 CLI 在沙箱完成一轮真实验收（发布一张 spec、一组带阻塞边的 ticket、claim/resolve 一条、评论一条、Blocks 链接一条），并把验收记录写入本文档 Comments。

**Blocked by:** 05 — CLI `jira`（技能所需操作）。

**Status:** ready-for-agent

- [ ] `docs/agents/issue-tracker.md` 重写为 Jira 工作流（含 CLI 示例与查询约定）；AGENTS.md 摘要同步
- [ ] 沙箱端到端验收通过：建单、标签、评论、流转、Blocks、JQL 查询各至少一次，记录 trace/键值
- [ ] triage 标签词汇表（五类）保持原字符串；wayfinder 的 map/child/claim/resolve 语义在 Jira 中的对应关系成文
- [ ] DESIGN/README 同步（工作流迁移说明）；build/test/lint 全绿

## Comments
