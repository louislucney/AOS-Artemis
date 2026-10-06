# 05 — iOS 日志采集与 api-errors

**Milestone:** M1（执行与证据链）

**What to build:** iOS 套件运行按任务时间窗 best-effort 采集模拟器日志并匹配 `.artemis/design/error-codes.json`；采集不可用时保留显式降级标记，CLI `suite api-errors` 在 iOS 上可用或明确降级。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 新增可注入的 iOS 日志采集器（`simctl log` 等 best-effort；套件 options 注入，镜像既有 `logcatCollector`）
- [x] 采集器约束：谓词过滤到目标进程 + 超时 + 条数上限；超限即放弃并标降级，不得阻塞套件（禁止 best-effort 变 hang）
- [x] 采集到日志时匹配 error-codes.json 并标注实际来源；无匹配/失败时 `source:"none"` + degraded 原因（保留 `ios-log-unsupported` 语义）
- [x] CLI `suite api-errors <trace>` 对 iOS trace 不再打 adb，走 iOS 分支或明确降级
- [x] 测试用 fake exec 覆盖采集/匹配/降级/超限四分支
- [x] DESIGN.md 同步；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
