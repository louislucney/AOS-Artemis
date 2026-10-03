# 06 — 任务结果 codec：统一解析与类型化状态

**What to build:** 收回 MCP 字符串边界：由一个 module 把代理返回解析为类型化的任务状态（traceId / 状态 / 错误 / test_summary / notes / stderr），替换 runtime、server、diff、composite 四处各自实现的 JSON 解析；状态语义在统计同步与崩溃采集之间共享。mobile 工具 schema 逐字节透传契约不变。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 四处重复解析收敛为一处（旧实现删除后复杂度不回流）
- [x] trace 状态文件与上游状态响应走同一 codec；非法输入有明确错误
- [x] test_summary / error 首次可被结构化读取
- [x] proxy 契约测试保持 5 工具 schema 逐字节透传

## Comments

- 2026-10-01 实施：新增 `src/artemis/task-result.ts`（`resultText` / `parseJsonObject` / `resultPayload` / `traceIdOf` / `taskStatusOf` / `taskStatusFromFile`，类型化 `TaskStatus` 含 test_summary.failed_items、error/message/notes/stderr/时间窗）。删除四处重复解析：`runtime.extractJson`、`server.extractTraceId`、`diff/device-source.parsePayload`+`textContent`、`composite` 内联 `JSON.parse`；`crash/scanner.readTraceStatusInfo` 与 `Runtime.readTraceStatus`/`queryTaskStatusViaProxy` 共用 `taskStatusFromFile`/`taskStatusOf`（状态文件与上游状态响应同一 codec）。测试 `test/task-result.test.js`（6 例）；全量 341 例通过，lint 绿；proxy 5 工具 schema 透传契约不变（`test/proxy.test.js`）。
