# 07 — design_device_diff iOS step 模式放行

**Milestone:** M1（执行与证据链）

**What to build:** `design_device_diff` 的 `mode:"step"` 接受 iOS trace（失败步骤截图参与确定性对比），不再被 `platform="ios"` 拒绝；跨进程（新进程 + 磁盘 fallback）可用。

**Blocked by:** 01 — iOS trace 跨进程持久化与中断归因

**Status:** ready-for-agent

- [x] 去掉 `platform="ios"` 的 step 模式拒绝；iOS 步骤截图可作设备源
- [x] 新进程下 step 检索与取图可用（依赖 01 的磁盘 fallback 与 `platform` 字段）
- [x] 测试覆盖（StubProxy/stubDevice 既有缝）与文档同步
- [x] `npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
