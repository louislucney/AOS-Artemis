# 05 — CLI `jira`（技能所需操作）

**What to build:** `node dist/cli.js jira ...` 子命令组，与 MCP 工具共用同一 Jira 客户端：建单（Task/Bug，标题/描述/标签/父/Blocks 链接）、标签增删、评论、按目标状态名匹配当前可用 transition 的流转、Blocks 链接；支持 `--project` 与 `--json`；退出码遵循仓库约定（0 成功 / 1 失败 / 2 用法错误）。完成后 to-spec / to-tickets / triage / wayfinder 有可调用的真实 Jira 通道。

**Blocked by:** 01 — Jira 客户端与凭证配置；03 — 评论与附件回写原语。

**Status:** resolved

- [ ] 子命令：`issue create|comment|label|transition|link`（评论复用原语）；未知子命令/缺参 exit 2
- [ ] 流转按可用 transitions 的目标状态名匹配（To Do→In Progress→Done 语境），不匹配时列出可用项
- [ ] `--json` 输出机器可读结果；`--project <dir>` 沿用 CLI 约定
- [ ] 测试：注入假客户端覆盖各子命令参数拼装、退出码、JSON/文本输出
- [ ] DESIGN/README 同步；build/test/lint 全绿

## Comments

## Comments

- 2026-10-08 实施：`JiraClient` 增加 `createIssue/updateIssue/getTransitions/doTransition/createIssueLink`（写操作走新增 `requestVoid`，兼容 200/201/204/空响应；CLI 测试抓出 201 空体导致 JSON 解析失败后修复）；新增 `src/jira-command.ts`（`runJiraCommand`：`issue create|comment|label|transition|link`；`--project <dir>`/`--json`；exit 0/1/2；建单 Task/Bug + 描述 ADF + 标签 + 父级 + Blocks 链接；流转按 `to.name`/`name` 大小写不敏感匹配、不匹配列出可用项；label 取现值增删后 PUT；comment 复用 03 幂等原语）；`src/cli-runtime.ts` 提取共享 `defaultBuildRuntime`（suite-command 同步改用）；`cli.ts` 注册 `jira` 子命令与 usage。测试 +7（建单/用法/缺凭证/label/transition/comment/ link）；全量 736 绿、lint 干净。剩余票 06：tracker 迁移 + 沙箱端到端验收（需真实 Jira 环境）。
