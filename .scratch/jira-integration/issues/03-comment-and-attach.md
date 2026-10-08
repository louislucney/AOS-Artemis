# 03 — 评论与附件回写原语

**What to build:** `jira_issue_comment`（最小 ADF：段落/列表/代码块/引用；marker 定位同 issue+trace 的历史评论，存在则更新 PUT 否则新建 POST）与 `jira_issue_attach`（multipart 上传，`X-Atlassian-Token: no-check`；路径限项目根内；确定性命名 + 内容哈希去重；站点 `/attachment/meta` 与本地上限取小，超限 warning 跳过不失败）。完成后可对测试 issue 完成一次评论与附件回写。

**Blocked by:** 01 — Jira 客户端与凭证配置（含 jira_issue_get）。

**Status:** resolved

- [ ] 评论 ADF 构造器（段落/无序列表/代码块/引用）与纯文本→ADF 辅助
- [ ] 同 issue + 同 trace marker：更新既有评论（PUT），否则新建（POST）；marker 优先 comment properties、不可用时页脚文本标记
- [ ] 附件上传：multipart、必需头、sha256 内容去重（比对既有附件名/大小）、项目根内路径校验、单文件上限 warning
- [ ] 测试：评论创建/更新路径、marker 解析、multipart 形状与请求头、去重跳过、越界路径拒绝
- [ ] DESIGN/README 同步；build/test/lint 全绿

## Comments

## Comments

- 2026-10-08 实施：`src/jira/adf.ts` 增加构造器（paragraph/bulletList/orderedList/codeBlock/blockquote/doc/plainTextToAdf）；`src/jira/comments.ts`（`AOS-TRACE:` marker + `findCommentByTrace` + `upsertTraceComment` 幂等）；`JiraClient` 扩展（`getComments/createComment/updateComment/setCommentProperty`（best-effort 不抛）/`getAttachmentMeta/listAttachments/uploadAttachment`；JSON 请求抽象为 `rawRequest` 复用冷却/429/超时，原本 `request` 行为不变）；工具 `jira_issue_comment`（dryRun 不触网）与 `jira_issue_attach`（项目根内路径校验、确定性命名+内容哈希去重、上限取小、超限/越界跳过不失败）；server 注册 + README/AGENTS/DESIGN 同步。测试 +6（ADF/marker/幂等/创建/更新/附件三态+multipart 形状）；定向 20 例全绿。真实 Jira 冒烟沿用 M8c 沙箱验收（票 06）。
