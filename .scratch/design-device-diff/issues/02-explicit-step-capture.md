# 02 — 步骤截图（显式 trace_id + step_number）

**What to build:** 用户指定 `trace_id + step_number`，工具用该步骤的截图作为真机侧对比图（默认 post，可切 pre），而不是实时截图；截图路径经上游 `mobile_inspect_trace(view_step_screenshots)` 获取。缺 trace/步骤、步骤无图时给出明确错误与提示。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [ ] 设备源新增 `step` 模式：`trace_id` + `step_number` 必填，`image: "post" | "pre"`（默认 post）
- [ ] 通过上游代理工具取步骤截图路径并读取文件；不直读上游数据库/内部文件布局
- [ ] 报告 `unit.device` 记录 `mode/traceId/stepNumber/image/serial`
- [ ] 错误路径：trace 不存在、步骤越界、截图缺失、upstream 报错，均结构化返回并附下一步提示
- [ ] 测试：StubProxy 返回步骤截图路径的 fixture；错误分支；报告字段断言
