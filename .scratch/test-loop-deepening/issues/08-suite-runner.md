# 08 — 最小套件运行器

**What to build:** 一个入口顺序执行 tests.json 里的一批用例：每例前按第 04 票复位，提交任务、轮询终态、把 caseId→trace→状态写入台账，最后产出逐用例 pass/fail 汇总与证据路径。不做多设备并行；失败默认继续跑完并汇总，可选遇错即停。

**Blocked by:** 04, 05.

**Status:** ready-for-agent

- [x] 一次调用跑完 N 条用例并返回逐用例结果（含预检摘要）
- [x] 每例前复位；复位降级不阻塞其余用例，且报告中可见
- [x] 结果可从台账与产物复查
- [x] 假 proxy 集成测试覆盖：全通过 / 中间失败继续 / 遇错即停 / 无设备明确报错

## Comments

- 2026-10-01 实施：新增 `src/figma/suite-runner.ts`（`runGeneratedTests(runtime, options)`）：读 tests.json（可 `maxCases`），逐例「复位（07→04 的 `resetApp`，可注入）→ 提交 mobile_run_task（透传 model/device_serial/locked_app_package）→ 轮询 `Runtime.traceStatus`（新公共方法，文件优先、代理回退）→ `syncTaskStatuses` 落台账并触发崩溃采集」；失败/超时/提交错误逐例记录（trace/error/test_summary/notes/stderr/stdout），`stopOnFailure` 可选，`ok:false` + 明确 error 仅当 0 例提交成功（无设备场景）。报告含 `preflight` 摘要、passed/failed/skipped。测试 `test/suite-runner.test.js`（6 例：全通过+台账、失败继续、遇错即停、无设备、复位降级、轮询超时）；全量 350 例通过，lint 绿。
- 待决策：入口形态（新增原生 MCP 工具如 `mobile_run_suite` vs `scripts/` CLI）依赖开放问题 3；当前以模块级入口交付，工具/脚本接线待定。
