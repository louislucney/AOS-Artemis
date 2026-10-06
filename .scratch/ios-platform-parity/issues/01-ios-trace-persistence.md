# 01 — iOS trace 跨进程持久化与中断归因

**Milestone:** M1（执行与证据链）

**What to build:** 进程重启（或另一个 MCP 实例）后，`mobile_manage_task`（status/stop/inject_instruction）与 `mobile_inspect_trace`（view_summary/search/view_step_screenshots/view_step_details）仍能按 trace_id 查询与操作 iOS 任务；被中断的任务在确认执行进程死亡后归因 interrupted，仍在执行的任务不会被误判。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] iOS 运行目录的 `run.json`/`status.json` 改为原子写；记录 owner pid、进程启动时间；`status.json` 补 `platform` 字段（`run.json` 已有）
- [x] manage/inspect 采用「内存 → 磁盘」两级查找（签名对齐设备状态入口：runtime + args + 可注入 deps：clock/liveness/staleMs；fs/tracesDir 用真实临时目录，不新增未用 seam）
- [x] 磁盘 fallback 归因前做进程存活校验：pid 存活 → 保持 running（或标 stale）并提示「可能仍由该进程执行」；仅确认死亡、或超时且无存活 pid 才置中断态（落盘/响应复用既有终态词 `orphaned`，见 spec 决策 3；默认 30 分钟；基准 = `status.json` 最后写入时间）
- [x] 平台判别改为读持久化 `platform` 字段（`ios-` 前缀 fallback）；旧版本无磁盘产物的 trace 查不到属预期并写入文档
- [x] 测试覆盖：跨进程查询、存活/死亡两分支、超时归因（注入 clock/liveness）、platform 字段路由；不依赖真机
- [x] DESIGN.md 同步持久化契约与归因规则；`npm run build && npm test && npm run lint` 全绿

## Comments

- 2026-10-06 实现完成（未提交，待提交确认）：新增 `src/ios/trace-store.ts`；`src/ios/task-runner.ts`（原子写 + `platform`/`pid`/`process_started_at` + 两级查找）、`src/ios/inspect.ts`（签名对齐 + 磁盘渲染复用）、`src/runtime.ts`（`traceStatus` 归因收尾）；新增 `test/ios-trace-store.test.js`（6 例），适配既有两套 iOS 测试。`npm run build && npm test && npm run lint` 全绿（513 tests）。
- 措辞映射：中断态落盘/响应使用既有终态词 `orphaned`（而非新造 `interrupted`），以便 `TERMINAL_TASK_STATUSES` 驱动 `aos_tasks` 自动收尾；spec 决策 3 已同步此映射。
- 跨进程 stop/inject：磁盘态明确返回「无法跨进程操作」（不伪造成功）；控制通道不在本票范围。
- `runtime.traceStatus` 在读路径做幂等 orphan 归因回写（略超 manage/inspect 清单），目的即 US5「台账不悬挂」；DESIGN §13.51 已记录。
- code review 采纳：合并 `statusPayload`/`diskStatusPayload` 为同一 builder；移除新增注释与未用导出/字段；`process_started_at` 为 spec 决策 3 明确要求，保留备查。
