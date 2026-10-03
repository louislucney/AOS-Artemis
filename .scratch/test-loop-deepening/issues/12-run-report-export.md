# 12 — 运行报告导出

**What to build:** 从运行台账生成独立的运行报告：逐用例 pass/fail / 耗时 / 证据路径 / 失败分类，输出 xlsx 结果页与 JUnit XML；不覆盖既有的生成物 tests.xlsx，不改变其契约。

**Blocked by:** 05.

**Status:** ready-for-agent

- [x] 报告含逐用例结果与证据路径，可追溯到 traceId
- [x] JUnit XML 可被通用 CI 解析（suite / case / failure）
- [x] 既有 tests.xlsx 生成契约与模版语义不回归

## Comments

- 2026-10-02 实施：新增 `src/figma/run-report.ts`（`buildRunReport`，模块级入口同票据 08/09/11）。从 `store.listTasks` 生成（submittedAt 升序 + traceId 次序稳定；`caseIds` 过滤；`limit` 默认 50）：`outcome`（completed→passed/submitted→pending/其余→failed）、`durationMs`（状态文件 start/end 优先，回退台账时间）、证据（traceDir 恒有 + 状态文件 notes/stderr/stdout）、名称与 preconditions 经 tests.json 按 caseId/`taskDesc` 精确匹配、失败行复用票据 10 `classifyFailure`（状态 + trace 崩溃 + 前置假设）。产物 `<项目>/.artemis/design/reports/run-<stamp>.xlsx`（结果页，冻结表头）与 `run-<stamp>.xml`（JUnit：testsuites/testsuite/testcase，failure type=失败域 + message=判定依据，pending→skipped，XML 转义；`save:false` 不写盘）。测试 `test/run-report.test.js` 3 例（台账映射与时长/分类/证据、xlsx+JUnit 解析与计数、过滤与不写盘），全量 373 例通过；既有 tests.xlsx 生成/模版契约用例不变。见 DESIGN.md §13.28。

