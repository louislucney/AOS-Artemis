# 04 — 证据回写 composite（jira_evidence_post）

**What to build:** `jira_evidence_post` 一站式工具：输入 issueKey + traceId + 可选 platform（android|ios）/ deviceSerial / dryRun；自动收集失败证据（失败步骤截图、diff 标注图、报告摘要）与该 trace 的崩溃签名摘要；生成中文结构化评论（平台/设备/trace/失败清单/失败域/产物清单）并以 03 的幂等方式回写，附件走去重。完成后一次调用即可把失败上下文写入 Jira。

**Blocked by:** 03 — 评论与附件回写原语。

**Status:** resolved

- [ ] 证据检索：按 traceId 定位 trace 产物与套件台账失败信息；能识别失败步骤截图与 diff 标注图；不存在时给出可行动说明而非崩溃
- [ ] crash 摘要：crash 索引有该 trace 签名时附摘要（不附完整栈）
- [ ] 平台维度：评论与附件元数据带 platform 与 deviceSerial（缺省 auto/未知时如实标注）
- [ ] dryRun 只返回将写回的评论与附件清单，不触网
- [ ] 测试：取证与评论渲染纯函数/golden、dryRun、重复调用幂等（更新而非新增）、iOS trace 标注
- [ ] DESIGN/README 同步；build/test/lint 全绿

## Comments

## Comments

- 2026-10-08 实施：新增 `src/jira/evidence.ts`（纯函数：`buildEvidenceComment` 中文结构化评论 + `candidateAttachments`：锚定截图 + design-diff 的 annotated.png 优先，存在性过滤、≤6）；工具 `jira_evidence_post`（复用 `traceEvidence` 聚合失败项/崩溃/锚定截图/设计差异；`classifyFailure` 失败域；platform/deviceSerial 显式覆盖或按 serial 推断（iOS 序列号判定，其余按 android，缺省 unknown）；trace 不存在返回可行动说明；`dryRun` 不触网返回评论文本与附件清单；写回走 03 幂等评论 + 去重附件）。测试 +4（golden/dryRun 0 网络/幂等 PUT 不新建/trace 缺失）；定向 19 例全绿。真实沙箱冒烟并入票 06。
