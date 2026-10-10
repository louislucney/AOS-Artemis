# 09 — 对账审阅面（CLI/MCP 人工确认）

**What to build:** 人工只仲裁不一致：CLI 与 MCP 面提供差异列举、确认/修正（幂等写入 human-confirmed 与冲突裁决，记录来源与时间）；未裁决项保持待办、不升权。端到端：列举差异 → 确认 → 后续生成可走硬断言路径。

**Blocked by:** 08（对账资产）。

**Status:** resolved

> 实施注（2026-10-10）：`reviewEdge` 幂等决定（confirm→human-confirmed 硬断言 / reject→边不进生成，记录 reviewer/时间）；MCP `reconciliation` 工具 + CLI `suite reconcile list|confirm|reject`（exit 0/1/2）；生成消费扩展 confirmed/rejected；未裁决不升权。见 DESIGN §13.68。

- [ ] 列举 / 确认 / 修正命令与 MCP 工具；幂等写入 human-confirmed 与冲突裁决（含时间戳）
- [ ] 未裁决不升权；审阅输出含差异上下文（屏幕/边/文本）便于决策
- [ ] 单测 + CLI 行为测试；不依赖设备/PG/外网
- [ ] 用法变更同步 README 与 DESIGN.md；`npm run build && npm test && npm run lint` 全绿
