# 03 — 评论与附件回写原语

**What to build:** `jira_issue_comment`（最小 ADF：段落/列表/代码块/引用；marker 定位同 issue+trace 的历史评论，存在则更新 PUT 否则新建 POST）与 `jira_issue_attach`（multipart 上传，`X-Atlassian-Token: no-check`；路径限项目根内；确定性命名 + 内容哈希去重；站点 `/attachment/meta` 与本地上限取小，超限 warning 跳过不失败）。完成后可对测试 issue 完成一次评论与附件回写。

**Blocked by:** 01 — Jira 客户端与凭证配置（含 jira_issue_get）。

**Status:** ready-for-agent

- [ ] 评论 ADF 构造器（段落/无序列表/代码块/引用）与纯文本→ADF 辅助
- [ ] 同 issue + 同 trace marker：更新既有评论（PUT），否则新建（POST）；marker 优先 comment properties、不可用时页脚文本标记
- [ ] 附件上传：multipart、必需头、sha256 内容去重（比对既有附件名/大小）、项目根内路径校验、单文件上限 warning
- [ ] 测试：评论创建/更新路径、marker 解析、multipart 形状与请求头、去重跳过、越界路径拒绝
- [ ] DESIGN/README 同步；build/test/lint 全绿

## Comments
