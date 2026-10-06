# 06 — 崩溃扫描 iOS 路由与补扫

**Milestone:** M1（执行与证据链）

**What to build:** `aos_crashes scan`（指定 trace 与批量）按平台路由到宿主机 DiagnosticReports 采集；执行器异常退出（finalize 未执行）后仍有补扫，且补扫考虑报告异步落盘。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] scan（含指定 traceId 与批量）按持久化 `platform` 字段路由（`ios-` 前缀 fallback）到 iOS 采集器，不再落到 adb
- [x] 补扫按有界延迟/重试（DiagnosticReports 异步落盘），匹配规则 = 进程名 + 时间窗
- [x] 执行器异常退出后的补扫路径存在且入同一崩溃索引
- [x] 测试用 fake collector 覆盖路由与补扫（含重试）
- [x] DESIGN.md 同步（含「崩溃记录可能延迟入库」为预期）；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
