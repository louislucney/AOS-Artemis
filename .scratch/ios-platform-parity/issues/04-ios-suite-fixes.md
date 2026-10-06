# 04 — iOS 套件契约修复（统计 / 入账 / reset reason / test_summary）

**Milestone:** M1（执行与证据链）

**What to build:** 一次 iOS 套件运行只为同一 trace 记一行任务统计；启动失败也入账；iOS 复位失败返回 iOS 侧 reason；合成的 test_summary 带 `synthesized: true` 且失败分类仍可用。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 套件路径按持久化 `platform` 字段跳过自身记账（`ios-` 前缀 fallback），由执行器侧单点记录（无重复行）
- [x] iOS 启动失败（failStart）写入任务行
- [x] iOS 复位失败 reason 归 iOS 侧，不再包装成 `force-stop-failed`
- [x] 合成 test_summary 带 `synthesized: true`（同步任务状态类型），不冒充真实断言计数
- [x] 测试覆盖以上四项（SuiteProxy/status fixtures 等既有缝）
- [x] DESIGN.md 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
