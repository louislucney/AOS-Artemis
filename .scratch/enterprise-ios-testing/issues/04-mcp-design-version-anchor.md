# 04 — MCP：flows.json 设计版本锚点 + 路线漂移标注

**What to build:** `figma_extract_flows` 的 flows.json 写入 Figma `version`/`lastModified`（设计冻结锚点基础）；`suite check` 输出"测试引用但设计缺失"的屏幕（路线漂移，警告不阻断）。设计冻结（baseline-lock）全量版另评。

**Blocked by:** None

**Status:** resolved

- [ ] `figmaExtractFlows` payload 增加 `fileVersion`/`lastModified`
- [ ] `suite check` 增加 route drift 列表（case screens − flows screens）
- [ ] 测试：可离线覆盖的部分（drift 计算）；version 透传如无离线 harness 则以类型/字段测试锁定
- [ ] DESIGN §6.10 同步

## Comments

- 2026-10-08 实施：`figma_extract_flows` 将 Figma `version`/`lastModified` 写入 flows.json（`fileVersion`/`lastModified`）；`suite check` 输出路线漂移（测试引用、设计缺失）。baseline-lock 全量版（RC 冻结/解冻流程）待独立评估。
