# 05 — 用例身份与运行台账

**What to build:** 生成的每条用例有稳定 id（随 tests.json 落盘）；提交 mobile_run_task 时，在不改 mobile schema、不改写任务描述语义的前提下，用任务描述精确匹配把 caseId 记入运行台账；同时修复三个既存数据质量缺陷：报错提交不记录、无 traceId 的记录永不收敛、model 与 profile 混用。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] tests.json 每条用例含稳定 id；同输入重复生成 id 稳定
- [x] 提交记录含 caseId（精确匹配）；无法匹配时显式留空而非错配
- [x] 即时报错的提交也产生终态记录；无有效 traceId 的记录不进入永不收敛的 pending；model/profile 语义分离
- [x] `aos_tasks` 可按 caseId 关联 trace；PG 与内存两种存储语义一致
- [x] 测试不依赖真实 PG / 设备

## Comments

- 2026-10-01 实施：`GeneratedTest.id = case-<sha256(name,screens,steps)[0:12]>`（同输入稳定、不进入 taskDesc）；新增 `src/figma/case-index.ts` 从 `.artemis/design/tests.json` 精确匹配 `taskDesc`；`Runtime.recordTaskResult` 统一提交记录（成功有 trace → submitted；即时报错/无 trace → failed 终态，`local-<uuid>` 占位、`finished_at` 置位），`profile` 不再与 model 同值；`task_stats` 增 `case_id`（PG 存量库 init 时 `ADD COLUMN IF NOT EXISTS` 兼容），两存储语义一致；`aos_tasks` 输出 `case_id`。测试 `test/case-ledger.test.js`（4 例）+ `test/db.test.js` 台账往返；全量 335 例通过，lint 绿。
