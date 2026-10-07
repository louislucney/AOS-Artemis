# 05 — CLI `jira`（技能所需操作）

**What to build:** `node dist/cli.js jira ...` 子命令组，与 MCP 工具共用同一 Jira 客户端：建单（Task/Bug，标题/描述/标签/父/Blocks 链接）、标签增删、评论、按目标状态名匹配当前可用 transition 的流转、Blocks 链接；支持 `--project` 与 `--json`；退出码遵循仓库约定（0 成功 / 1 失败 / 2 用法错误）。完成后 to-spec / to-tickets / triage / wayfinder 有可调用的真实 Jira 通道。

**Blocked by:** 01 — Jira 客户端与凭证配置；03 — 评论与附件回写原语。

**Status:** ready-for-agent

- [ ] 子命令：`issue create|comment|label|transition|link`（评论复用原语）；未知子命令/缺参 exit 2
- [ ] 流转按可用 transitions 的目标状态名匹配（To Do→In Progress→Done 语境），不匹配时列出可用项
- [ ] `--json` 输出机器可读结果；`--project <dir>` 沿用 CLI 约定
- [ ] 测试：注入假客户端覆盖各子命令参数拼装、退出码、JSON/文本输出
- [ ] DESIGN/README 同步；build/test/lint 全绿

## Comments
