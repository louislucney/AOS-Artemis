# 03 — MCP：`suite report` 追溯矩阵（design↔case↔trace↔evidence）

**What to build:** `buildRunReport` 增加 `traceability` 与 xlsx 第二工作表：每个设计屏幕/跳转 → 覆盖它的 case_id → trace_id → 证据目录是否存在（fs.existsSync）；列出未覆盖屏幕/跳转、无 trace 用例、无证据用例。

**Blocked by:** None

**Status:** resolved

- [ ] 纯函数 `buildTraceability`（屏幕/边 → case → trace/evidence），可单测
- [ ] xlsx 增加"追溯矩阵"表 + JSON `traceability` 字段
- [ ] 测试：矩阵单元、无证据标注、空 flows 降级
- [ ] README/DESIGN 同步

## Comments

- 2026-10-08 实施：新增 `src/figma/traceability.ts`（纯函数）；`suite report` 增加 `traceability` JSON 字段与「追溯矩阵」工作表（屏幕/跳转 → case_id → trace → 证据；未覆盖/无 trace/无证据标注）；测试 2+1 例。
