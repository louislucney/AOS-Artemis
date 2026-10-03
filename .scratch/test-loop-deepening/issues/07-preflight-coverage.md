# 07 — 可执行性预检与覆盖视图

**What to build:** 执行前对 tests.json 做静态预检：无断言步骤、入口屏回退、截断/深度上限、死端与不可达屏幕；输出"哪些用例弱、哪些屏幕/边没被覆盖"的报告；不写盘、不调设备。被上限截断或回退时，响应中如实标注计数，不再沉默。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 报告逐条列出弱用例及具体原因
- [x] 列出未覆盖屏幕/边清单
- [x] 截断/回退时响应含明确计数
- [x] 纯函数、可单测，不写盘不联网

## Comments

- 2026-10-01 实施：新增 `src/figma/preflight.ts`（`preflightGeneratedTests`：弱步骤检测（步骤缺「应」断言）、屏幕/边覆盖（边按用例 screens 的连续对判定）、透传 `generation` 摘要；缺 flows.json 时覆盖仅到已生成屏幕；文件缺失/损坏返回 null）。生成侧补 `linearizeFlowsWithStats`（`onStats` 回调），`figma_generate_tests` 响应/落盘新增 `generation: {maxFlows,maxDepth,entryFallback,exploredPaths,keptPaths,droppedPaths,truncated}`——截断/入口回退不再沉默。测试 `test/test-preflight.test.js`（3 例）；全量 350 例通过，lint 绿。
