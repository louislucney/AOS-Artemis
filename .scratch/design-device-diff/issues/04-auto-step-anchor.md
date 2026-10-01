# 04 — 自动锚点（trace_id → 失败步骤，best-effort）

**What to build:** 用户只给 `trace_id` 时，工具用失败证据文本（来自 Pro 任务终态 `run_outcome`）经上游 `mobile_inspect_trace(search)` 找回候选步骤并选取锚点，报告记录锚点来源（`explicit` / `search`）与候选信息。Flash 任务（无 `run_outcome`）或找不到失败证据时，明确说明并建议显式 `step_number`，不静默失败。

**Blocked by:** 02（步骤截图（显式 trace_id + step_number））

**Status:** ready-for-agent

- [ ] 设备源支持仅 `trace_id`：先读取/获取失败证据，再检索步骤，取回截图
- [ ] 报告记录锚点来源与命中依据（证据文本/步骤号），便于复核
- [ ] 无失败证据（Flash）→ 结构化提示，可用显式步骤替代
- [ ] 检索零命中/多命中歧义 → 返回候选列表与建议
- [ ] 测试：StubProxy 模拟 run_outcome/检索结果的三类分支（命中、无记录、歧义）
