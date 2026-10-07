# 04 — 证据回写 composite（jira_evidence_post）

**What to build:** `jira_evidence_post` 一站式工具：输入 issueKey + traceId + 可选 platform（android|ios）/ deviceSerial / dryRun；自动收集失败证据（失败步骤截图、diff 标注图、报告摘要）与该 trace 的崩溃签名摘要；生成中文结构化评论（平台/设备/trace/失败清单/失败域/产物清单）并以 03 的幂等方式回写，附件走去重。完成后一次调用即可把失败上下文写入 Jira。

**Blocked by:** 03 — 评论与附件回写原语。

**Status:** ready-for-agent

- [ ] 证据检索：按 traceId 定位 trace 产物与套件台账失败信息；能识别失败步骤截图与 diff 标注图；不存在时给出可行动说明而非崩溃
- [ ] crash 摘要：crash 索引有该 trace 签名时附摘要（不附完整栈）
- [ ] 平台维度：评论与附件元数据带 platform 与 deviceSerial（缺省 auto/未知时如实标注）
- [ ] dryRun 只返回将写回的评论与附件清单，不触网
- [ ] 测试：取证与评论渲染纯函数/golden、dryRun、重复调用幂等（更新而非新增）、iOS trace 标注
- [ ] DESIGN/README 同步；build/test/lint 全绿

## Comments
