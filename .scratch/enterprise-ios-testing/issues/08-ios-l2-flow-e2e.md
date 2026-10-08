# 08 — iOS：L2 流级 E2E 薄层（3–5 条）

**What to build:** 以 `MOPEndToEndFlowUITests` 为种子重构成 3–5 条流级 E2E：单测试方法内真实导航、状态贯穿、固定种子 fixture、无 `USE_REAL_NAV` 类开关、方法名内嵌 case_id（供 MCP calibrate 对齐）、显式 owner。删除/冻结碎片化 demo 直进用例（保留为本地快速检查，不进企业门禁）。

**Blocked by:** 06（fixture 连贯）、07（真实导航接线，若流级用生产入口）

**Status:** ready-for-agent

- [ ] 方法名/附件绑定 case_id 约定
- [ ] 用 `build-for-testing` + `test-without-building` 验证（区分构建与执行耗时）
- [ ] xcresult 落盘供 `suite calibrate` 消费

## Comments

- 2026-10-08 种子交付：`MOPEndToEndFlowUITests` 作为 L2 首条流级用例走通——`build-for-testing` + `test-without-building`（1 用例 40.8s）；头部标注 case_id 命名约定（方法名内嵌 `case-<12hex>`）与 fixture 出处；xcresult 落 DerivedData（已用 `xcresulttool get test-results tests` + AOS 解析器验证 64 用例可解析）。
- 扩展到 3–5 条真实导航流依赖 07 接线；当前保持 demo 链路种子 + 约定。

- 2026-10-08 边界修正（用户指示）：L2 扩流属项目侧；MCP 侧等价路径为 `suite loop`（检查→执行→反馈→校准 + 下一步动作）的迭代，不依赖真实导航接线。
