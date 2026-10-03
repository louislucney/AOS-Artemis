# 13 — 执行反馈回生成器

**What to build:** 基于台账与基线数据做聚合分析：哪些屏幕/元素相关用例反复失败、哪些断言长期无法验证、哪些前置数据假设总不满足；输出可追踪到具体用例与历史运行的改进建议（提示词/hint/断言/数据标注），供下次生成时应用。默认只建议，不自动改写生成物。

**Blocked by:** 08, 11.

**Status:** ready-for-agent

- [x] 按失败域与用例聚合，输出屏幕/元素/断言维度的问题清单
- [x] 每条建议可追踪到用例与历史运行记录
- [x] 默认只读建议；应用与否由调用方决定

## Comments

- 2026-10-02 实施：新增 `src/figma/generation-feedback.ts`（`buildGenerationFeedback(runtime, {limit?,minFailures?})`，minFailures 默认 2；`RunReportCase` 增 `failedItems`）。数据源：`buildRunReport(save:false)`（台账 + 票据 10 分类）⊕ `preflightGeneratedTests`（无「应」弱断言）⊕ 设备基线 `last-diff.json`（未消除差异热点）。输出 `issues.{screens,assertions,data,weakAssertions,visualHotspots}` 与 `suggestions[]`（kind `prompt|data|hint|assertion`，各带 targets 与 caseIds/traceIds 回溯；排序计数降序 + 码点次序，同输入确定性）；纯只读，不写文件、不改写生成物。测试 `test/generation-feedback.test.js` 3 例（聚合与可追踪、只读+确定性、minFailures 过滤）；全量 376 例通过。见 DESIGN.md §13.29。

