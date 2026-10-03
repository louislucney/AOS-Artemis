# 09 — 失败证据包

**What to build:** 给定 traceId 一次调用返回结构化证据包：崩溃签名、全部失败项（不再只取第一个）、锚定步骤截图引用、可选设计差异引用；证据随台账落盘可复核。Flash 任务无失败证据时显式降级说明；默认只复制失败步骤 ±1 的图片，其余存路径清单，`full_trace` 可选。

**Blocked by:** 05, 06.

**Status:** ready-for-agent

- [x] 一次调用得到聚合证据，无需人工串联多个工具
- [x] 多失败项全部保留；无证据时返回明确降级而非报错
- [x] 默认体积有界（失败步骤 ±1 + manifest 引用），可开关全量
- [x] 不引入 LLM 解释（判定层保持确定性）

## Comments

- 2026-10-01 实施：新增 `src/artemis/evidence.ts`（`traceEvidence`）：一次调用聚合 status（全部 failed_items）、崩溃签名（`crashStore` 按 traceIds 过滤）、失败步骤锚点与截图（默认复制锚定步骤 pre/post；`fullTrace` 复制全部锚点候选步骤，上限 10；其余证据只写 manifest 引用）、可选设计差异引用（注入 `diffRunner`，默认 `design_device_diff` step 模式）。降级不抛错：`trace-status-missing / no-run-outcome / anchor-skipped / anchor-unavailable / design-diff-failed / screenshot-unavailable / evidence-write-failed`；无任何证据时不建目录。新增 `Runtime.traceDir` 公共路径。顺带修复：`resolveTraceStepAnchor` 之前把任务态 `error` 当成工具调用错误（失败任务带 error 时锚点必失败），现仅在无 `status` 字段时按工具错误处理。测试 `test/evidence.test.js`（5 例）；全量 355 例通过，lint 绿。入口接线（MCP 工具 vs CLI）同票据 08，待决策问题 3。
