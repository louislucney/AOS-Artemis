# 14 — 开放问题 3：测试闭环 CLI 接线

**What to build:** 把模块级测试闭环（suite-runner / evidence / baseline / run-report / generation-feedback）接线为 `node dist/cli.js suite` 子命令（run/evidence/baseline/report/feedback），退出码供 CI；不新增 MCP 工具、不改 mobile 透传契约。

**Blocked by:** 08, 09, 11, 12, 13.

**Status:** ready-for-agent

- [x] 五个子命令可用，`suite help` 完整；`--project`/`--json` 公共选项
- [x] 退出码 0/1/2（全通过 / 用例失败或证据缺失 / 参数执行错误与基线回归）
- [x] 假 proxy/内存 store 集成测试 7 例；不依赖真实 PG/设备/外网
- [x] 全量测试与 lint 全绿

## Comments

- 2026-10-02 实施：决议走 CLI（长任务/CI 友好，MCP 同步调用易超时）。新增 `src/suite-command.ts` + `cli.ts` `suite` 子命令：`run`（tests.json 全流程 + 预检摘要 + 逐例 PASS/FAIL + 失败域 + 证据命令）、`evidence <traceId>`、`baseline save|compare`（`--fail-on new|persisting|any` 触发退出码 2）、`report`（默认先 `syncTaskStatuses`+`flushCrashScans`）、`feedback`；公共 `--project <dir>`/`--json`；默认装配 `loadProject → createProjectStore（PG 失败降级内存）→ Runtime.initialize`，结束清理子进程与 store。测试 `test/suite-command.test.js` 7 例（复用 helpers.SuiteProxy，该 proxy 由 suite-runner 测试抽出共享）；README/AGENTS/DESIGN §13.33 同步；全量 389 例通过、lint 绿。
