# 02 — iOS inspect 增强（屏幕文本 / post 截图 / 动作标注）

**Milestone:** M1（执行与证据链）

**What to build:** 排障者能在 iOS trace 上用 search 按每一步的屏幕文本（元素摘要）定位步骤；`view_step_screenshots` 返回真实的动作前后截图与动作标注 overlay；`view_step_details` 带 `device_serial`；以上在新进程（磁盘 fallback，依赖 01）同样可用。

**Blocked by:** 01 — iOS trace 跨进程持久化与中断归因

**Status:** ready-for-agent

- [x] 执行器每步持久化屏幕元素文本摘要；search 覆盖该文本（多词分词与计分行为与现有一致或更好）
- [x] 动作执行后经可配置 settle 延迟（默认 200ms、范围 0–2000ms、进契约）再补真实 post 截图；`after` 不再用下一步观察截图冒充
- [x] 动作标注 overlay 按需生成（画在已截图像上）；overlay 坐标 point↔pixel（@2x/@3x）换算正确（单列测试）；生成失败显式降级（字段 null + 原因），不影响主流程
- [x] `view_step_details` 响应含 `device_serial`
- [x] 每步双截图 + 文本摘要的预算符合 spec「风险与预算」节（沿用 `AOS_IOS_MAX_STEPS` 上限保护）
- [x] 测试覆盖：fake device 截图调用序列、settle 延迟、overlay 成功/失败分支、point↔pixel 换算、跨进程检索
- [x] DESIGN.md 同步响应差异与降级；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交）：`npm run build && npm test && npm run lint` 全绿（542 tests）；行为契约见 DESIGN §13.52–13.53 与 spec 决策 2–19。
