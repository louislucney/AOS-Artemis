# 02 — 步骤截图（显式 trace_id + step_number）

**What to build:** 用户指定 `trace_id + step_number`，工具用该步骤的截图作为真机侧对比图（默认 post，可切 pre），而不是实时截图；截图路径经上游 `mobile_inspect_trace(view_step_screenshots)` 获取。缺 trace/步骤、步骤无图时给出明确错误与提示。

**Blocked by:** 01（Figma × 实时截图 最小闭环）

**Status:** ready-for-agent

- [x] 设备源新增 `step` 模式：`trace_id` + `step_number` 必填，`image: "post" | "pre"`（默认 post）
- [x] 通过上游代理工具取步骤截图路径并读取文件；不直读上游数据库/内部文件布局
- [x] 报告 `unit.device` 记录 `mode/traceId/stepNumber/image/serial`
- [x] 错误路径：trace 不存在、步骤越界、截图缺失、upstream 报错，均结构化返回并附下一步提示
- [x] 测试：StubProxy 返回步骤截图路径的 fixture；错误分支；报告字段断言

## Comments

- 2026-10-01 实施完成：设备源抽取为 `src/diff/device-source.ts`（live/step 两个采集函数）；`step` 经 `mobile_inspect_trace(view_step_screenshots)` 取 post/pre；缺参在取图前结构化报错；测试 6 例（`test/diff-step-capture.test.js`），全量 278 例通过；DESIGN §6.1/§13.14、README、AGENTS 已同步。
- code-review 修订：不再向上游传其不支持的 `device_serial`（step 的 serial 改从上游响应 `device_serial` 取并写入报告）；`post` 为空时错误提示可改用 `image:"pre"`；文件缺失/解析失败错误补下一步提示；`stepNumber` 校验与 schema 对齐（正整数）；测试补 post 缺失与 stepNumber=0 分支。保留的判断项：`textContent/parsePayload` 与仓库既有 3 处 MCP 文本解析形态重复（跨模块抽取留待后续）。
