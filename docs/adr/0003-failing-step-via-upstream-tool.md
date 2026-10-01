# 失败步骤锚定经上游工具编排，不直读 data_engine.db

「失败步骤截图」的来源不直读上游 SQLite（`data_engine.db`）与 `check_ledger.jsonl`：稳定接口要求调用方显式给 `trace_id + step_number`；自动模式通过 AOS 内部调用上游 `mobile_inspect_trace(action="search")`，用失败证据文本找回步骤；截图路径由 `mobile_inspect_trace(action="view_step_screenshots")` 返回（pre/post/overlay）。理由：不绑定上游数据库 schema、不引入 sqlite 依赖、复用上游已编排好的读取逻辑；AOS 已具备内部调用上游工具的通路（`runtime.proxy.callTool`）。

## Consequences

- 自动模式只对 Pro 任务有效（Flash 任务没有 `run_outcome.json`），且按文本检索属于 best-effort；
- 上游若把步骤锚点写进 `run_outcome.failed_items`（记入 backlog），自动模式可升级为精确映射。
