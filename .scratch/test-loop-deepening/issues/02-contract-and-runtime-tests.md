# 02 — 契约补全与 Runtime 专项测试

**What to build:** 补齐仓库自测的两个硬缺口：mobile 全部 5 个工具的 schema 逐字节契约对比（现状只对比 1 个）；为 runtime 的关键路径建立专属测试（子进程装配、状态同步、终态清理/陈旧子进程清扫），使删除任一分支都会让测试变红。不改变生产行为。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 5/5 mobile 工具 schema 与上游假子进程逐字节一致（含 required / additionalProperties）
- [x] runtime 的装配、状态同步、清扫路径有直接断言（删掉实现会失败，而非仅被间接覆盖）
- [x] 全量测试与 lint 全绿；不依赖真实 PG / 设备 / 外网

## Comments

- 2026-10-02 实施：假子进程工具定义抽到 `test/fixtures/fake-artemis-tools.mjs`（`TOOLS` 导出，fake-artemis.mjs 引用），`test/proxy.test.js` 对 5 个 mobile_* 逐工具 deepEqual `{name,description,inputSchema}`（required/additionalProperties 全量）。新增 `test/runtime.test.js` 6 例：默认装配（store/state/crashStore/traceDir/惰性代理 + dispose）与 `sweepStaleChild` 全分支（无记录、死 pid 清 state、owner 存活不动、cmdline 不匹配不杀、真 `python -m mcp_server`（bash exec -a）孤儿终止回报；win32 跳过）。状态同步/镜像路径已由 crash-tools/artifacts 用例直接覆盖。全量 382 例通过、lint 绿；不依赖真实 PG/设备/外网。见 DESIGN.md §13.31。

