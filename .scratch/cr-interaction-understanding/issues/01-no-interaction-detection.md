# 01 — 无交互数据检测与结构化告警

**What to build:** 从 Figma/pen 得到交互理解时，若设计源实际没有原型/交互数据，产物与响应必须显式告警（不再静默产出孤岛图）。pen 侧检测文件是否携带交互数据——携带时不得静默走合成，需显式标注当前合成原因；Figma 侧零/缺交互数据时新增结构化告警码。端到端：跑解析工具 → 响应 warnings 与落盘产物均含新告警，测试与文档同步。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [ ] pen：检测 `.pen` 交互数据有无；无交互 → 结构化告警码；有交互 → 不再静默合成（显式标注合成原因/待接交互解析）
- [ ] Figma：零/缺交互数据时输出结构化告警码（与既有 no-entry/unreachable/unresolved 并列），既有告警语义不变
- [ ] 告警进入工具响应与 flows 产物，下游（md/报告）可见
- [ ] 单测覆盖「有交互 / 无交互」两种 fixture；不依赖设备/PG/外网
- [ ] 行为/接口变更同步 DESIGN.md（用法变更同步 README）；`npm run build && npm test && npm run lint` 全绿
