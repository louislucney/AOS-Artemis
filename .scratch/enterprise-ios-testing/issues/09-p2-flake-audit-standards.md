# 09 — P2：flake 治理、审计保留期与企业标准映射

**What to build:** ① `suite run --retry <n>`：失败重试，首跑结果与 flake 如实标注（重跑转绿不计首跑门禁）；② 审计产物保留期可配置（默认 90d，对齐 `AOS_USAGE_RETENTION_DAYS`；签字产物待合规口径）；③ 企业标准对照映射表（ISO/IEC/IEEE 29119 / ISTQB 词汇）落入文档。

**Blocked by:** 1、2、3 的落地（数据源）

**Status:** ready-for-human

- [ ] retry 实现与如实标注测试
- [ ] 保留期配置项 + 文档
- [ ] 映射表文档

## Comments

- 2026-10-08 状态：暂缓。flake retry（`suite run --retry`）需 L2 校准数据（02/08）确定误报/漏报口径后再实现，避免无依据的重试策略；审计保留期待合规口径输入；29119/ISTQB 映射表待补。触发条件：L2 差分校准跑通后。

- 2026-10-08 实施（flake 部分）：`suite run --retry N`（≤3）——对未通过用例重跑做诊断；`retry {attempts, finalStatus, finalTraceId, flaky}` 如实写入报告/JSON；**首跑结果仍决定退出码**（重跑转绿不计首跑门禁），文本标注"重试转绿 N 例（flaky）"；测试 2 例；README/DESIGN §6.10 同步。
- 2026-10-08 实施（标准映射）：ISO/IEC/IEEE 29119 / ISTQB 能力映射表已落 `analysis.md §6`。
- 剩余（转 ready-for-human）：审计产物保留期与签字格式（待合规口径）、quarantine 流程（需 owner 签字机制）。
