# 收尾补齐 实施计划（统一服务 ⑤：usage 事件补齐＋接入指南＋精选硬化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按完整性核查结果收口：① D12/§9 缺的 3 个 usage 子项——`needsInfo.category`、`needsSetup.missing[]`、各步耗时（`step-ms:<step>`）；② `docs/接入指南.md` 补"统一服务四入口"一节并刷新版本行；③ 精选延后 Minor 硬化（清单校验、dryRun 文案与预览计数、候选不可读 WARN、测试补 pen 源/newer、文案两处）。

**Architecture:** 新增类型 `NeedsInfoCategory`（`src/workflow/setup.ts`）＋ `DevicePick` info 变体增 `category: "device-ambiguous"`；三流程工具 needs-info 返回补根字段 `category`，步记录统一为 `recordStep`（`steps[].ms` 实测）且 `run` 步执行后回填；`src/usage/capture.ts` 的 `outcomeSignalsOf` 只增三类提取；`project-archive.ts` 清单校验改判；`verify-jira.ts` 预览计数与 WARN；文档两处。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、zod（不动 schema）、node:test。

**Spec:** `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（D12 最小事件集；§9 usage 事件口径）。本计划为补齐既有 spec 缺口，不新建设计文档（设计选择见下"钉死"块，均为本计划之裁决）。

## Global Constraints

- 每任务收尾：`npm run build`＋该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- **信号只增不改**：既有信号（`needs:info`/`needs:<target>`/`failed-step:*`/`import.outcome`/`scope.match`/`run.gate`/`ticket.detailTier`/`mapping.*`/`writeback`）与顺序不变；新增仅在对应字段存在时追加；**仍不读参数值**（只取根字段/枚举）。
- **类型收紧须同步全构造点**：`DevicePick` info 变体、needs-info payload、`steps[].ms` 涉及的所有产出与测试断言一次改齐（含 `test/workflow-design-to-test.test.js` 4 处 steps 整对象断言）。
- ESM+NodeNext+strict、相对导入 `.js`；中文文案；默认无注释（契约 JSDoc 例外）；测试不依赖真实设备/网络/PG。
- 文档口径与实现一字不差同步（接入指南/README/DESIGN）。

## 钉死（本计划裁决；复核重点）

- **category 词汇（5 值）**：`device-ambiguous`（多设备未指定）｜`no-flows`（reuseExistingFlows 无 flows.json）｜`scope-no-hit`（scope 0 命中）｜`library-empty`（run_regression 库空）｜`ticket-coarse`（verify 粗单）。类型 `NeedsInfoCategory` 放 `setup.ts`。
- **信号命名**：category → `{code:"needs:info.category", field:<category>}`（在 `needs:info` 之后）；missing → 每条 `{code:"needs:<target>.missing", field:<条目>}`（在全部 `needs:<target>` 之后，按 checks 顺序）；耗时 → 每步 `{code:"step-ms:<step>", field:String(ms)}`（在 `run.gate` 之后追加）。
- **`steps[].ms` 语义**：`recordStep` 记录距上一步记录点的实测间隔；**`run` 步在执行完成后回填为执行耗时**（`execStartedAt` 前后差）。
- **接入指南**：§2 末新增 `### 2.11 统一服务四入口（对话层）`（四工具一句话＋needs 协议＋执行链复用说明＋指向 README 工具表/DESIGN §13.119–§13.123）；目录同步；版本行于 T6 刷新为真实全量数。

## Review Focus（最可能咬人；测试已归入各任务）

1. **信号只增不改**：既有 usage 断言全绿且顺序不变；新提取仅在字段存在时触发（无字段→零新增信号）（T1/T2/T3）。
2. **耗时语义真实**：ms 为 `Date.now()` 实测差（非预置/非推算）；run 步回填执行时长；测试断言 `number && ≥0` 且 run 步存在（T3）。
3. **类型收紧不破面**：DevicePick/Payload 定稿后所有构造点与断言同步；`category` 仅 needs-info 时出现（T1）。
4. **硬化不改正常路径**：清单校验只改判"不完整 ok 件"→`unreadable`（正常件逐字不变）；dryRun 预览计数与发送路径同式；WARN 走 `deps.log`（可断言、不落裸 stdout）（T5）。
5. **文档一致**：接入指南/README/DESIGN 与实现一字不差；版本行数字为 T6 全量实测（T4/T6）。

---

### Task 1: needs-info category（类型＋三工具＋capture）

**Files:**
- Modify: `src/workflow/setup.ts`（`NeedsInfoCategory` 类型）、`src/workflow/devices.ts`（info 变体）、`src/workflow/design-to-test.ts`、`src/workflow/run-regression.ts`、`src/workflow/verify-jira.ts`、`src/usage/capture.ts`
- Test: `test/workflow-devices.test.js` 无（用现测试）→ 更新 `test/workflow-design-to-test.test.js`、`test/workflow-run-regression.test.js`、`test/workflow-verify-jira.test.js`（needs-info 断言补 `category`）；`test/usage-capture.test.js`（追加）

**Interfaces:**
- Produces:
```ts
export type NeedsInfoCategory = "device-ambiguous" | "no-flows" | "scope-no-hit" | "library-empty" | "ticket-coarse";
// devices.ts
export type DevicePick =
  | { ok: true; device: string }
  | { ok: false; needs: "setup"; check: SetupNeed }
  | { ok: false; needs: "info"; category: "device-ambiguous"; questions: string[]; context: string[] };
```
- 行为钉死：
  - `pickDevice` 多设备分支返回 `category:"device-ambiguous"`；三工具把 `pick.category` 写入 payload 根 `category`。
  - 其余 needs-info 点位：design_to_test `no-flows`；run_regression 集内/库内 scope 0 命中 `scope-no-hit`、库空 `library-empty`；verify 粗单 `ticket-coarse`、scope 0 命中 `scope-no-hit`。
  - capture：`record.needs==="info"` 且根 `category` 为非空 string → `{code:"needs:info.category", field:category}`（紧随 `needs:info`）。
- [ ] **Step 1: 写失败测试**：三工具各 needs-info 用例补断言 `payload.category` 逐字（multi-device/scope-0-hit/library-empty/coarse/no-flows）；usage：`{needs:"info",category:"scope-no-hit"}` → `[{needs:info},{needs:info.category scope-no-hit}]`（顺序钉死）；无 category → 仅 `needs:info`。
- [ ] **Step 2: 红**。**Step 3: 实现**。**Step 4: 绿**＋`npm run test:file -- test/workflow-design-to-test.test.js test/workflow-run-regression.test.js test/workflow-verify-jira.test.js test/usage-capture.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): needs-info category (payload + usage signal)"`

---

### Task 2: needs-setup `missing[]` 入事件（capture）

**Files:**
- Modify: `src/usage/capture.ts`
- Test: `test/usage-capture.test.js`（追加）

**Interfaces:**
- 行为钉死：`needs==="setup"` 时，遍历 `checks[]`，对每个 `target` 非空 string 且 `missing` 为数组的项，逐条（string 且非空）推 `{code:"needs:<target>.missing", field:<条目>}`；**在全部 `needs:<target>` 之后**按 checks 顺序输出；无 missing 字段→零新增（既有断言不变）。
- [ ] **Step 1: 写失败测试**：checks `[{target:"figma",missing:["FIGMA_ACCESS_TOKEN"]},{target:"jira",missing:["JIRA_BASE_URL","JIRA_API_TOKEN"]}]` → 信号序 `needs:figma, needs:jira, needs:figma.missing(FIGMA_ACCESS_TOKEN), needs:jira.missing(JIRA_BASE_URL), needs:jira.missing(JIRA_API_TOKEN)`；`[{target:"jira"}]` → 仅 `needs:jira`（既有用例保持）。
- [ ] **Step 2: 红→实现→绿**（同 T1 测试文件命令）。
- [ ] **Step 5: 提交**：`git commit -m "feat(usage): needs-setup missing entries as signals"`

---

### Task 3: 各步耗时（`recordStep`＋`step-ms` 事件）

**Files:**
- Modify: `src/workflow/design-to-test.ts`、`src/workflow/run-regression.ts`、`src/workflow/verify-jira.ts`、`src/usage/capture.ts`
- Test: `test/workflow-design-to-test.test.js`（4 处 steps 整对象断言改为 ms 拆分）、`test/usage-capture.test.js`（追加）

**Interfaces:**
- 三工具统一形态（示例钉死）：
```ts
const steps: Array<Record<string, unknown>> = [];
let stepMark = Date.now();
const recordStep = (entry: Record<string, unknown>): Record<string, unknown> => {
  const now = Date.now();
  const out: Record<string, unknown> = { ...entry, ms: now - stepMark };
  stepMark = now;
  steps.push(out);
  return out;
};
```
  所有 `steps.push(...)` 改 `recordStep(...)`；`run` 步：`const runEntry = recordStep({step:"run",...}); const execStartedAt = Date.now();` 执行循环结束后 `runEntry.ms = Date.now() - execStartedAt;`（执行早退的错误返回路径不回填）。
- capture：根 `steps[]` 中 `step` 非空 string 且 `ms` 为有限 number（≥0）→ `{code:`step-ms:${step}`, field:String(ms)}`（在 `run.gate` 提取之后按 steps 顺序；无 steps→零新增）。
- 测试断言更新式（逐点核对）：`const { ms, ...rest } = payload.steps[0]; assert.equal(typeof ms, "number"); assert.ok(ms >= 0); assert.deepEqual(rest, {…原断言对象});`
- [ ] **Step 1: 写失败测试**：设计侧 3 处整对象断言（extract/generate/check、pen extract、reused extract）改拆分断言；run/verify 各加 `typeof step.ms === "number"` 断言（含 `run` 步）；usage：`steps:[{step:"run",ms:12},{step:"select",ms:3}]` → `[{step-ms:run,field:"12"},{step-ms:select,field:"3"}]`；`steps:[{step:"x"}]`（无 ms）→ 零新增。
- [ ] **Step 2: 红→实现→绿**＋`npm run test:file -- test/workflow-design-to-test.test.js test/workflow-run-regression.test.js test/workflow-verify-jira.test.js test/usage-capture.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): per-step timing (steps[].ms + step-ms signals)"`

---

### Task 4: 接入指南补"统一服务四入口"

**Files:**
- Modify: `docs/接入指南.md`（新增 `### 2.11 统一服务四入口（对话层）`＋目录同步；版本行先改措辞、数字留 T6）

- [ ] **Step 1: 写节**（与 README/DESIGN 口径一致）：四工具各 2–3 行（`design_to_test` 缺省止于校验＋nextAction；`run_regression` Excel/scope/缺省最新份＋导入集覆盖闸 n/a；`verify_jira_issue` 分档/映射/单子即用例/强断言聚合/写回与 dryRun；`project_archive` 只读恒 ok:true＋degraded）；needs 协议一段（checks[]/questions＋category）；执行链一句（三执行工具复用 `executeSuiteBatch`；不 shell）；指向 `README 工具表`、`DESIGN §13.119–§13.123`、usage 信号（D12 三子项）。
- [ ] **Step 2: 校验**：目录锚点与正文标题一致（`grep -n "2.11" docs/接入指南.md`）。
- [ ] **Step 3: 提交**：`git commit -m "docs(guide): unified service four entry points"`

---

### Task 5: 精选 Minor 硬化

**Files:**
- Modify: `src/workflow/project-archive.ts`（清单校验→unreadable）、`src/workflow/verify-jira.ts`（候选不可读 WARN＋dryRun 预览计数）、`src/tools/native-tools/workflow.ts`＋`README.md`＋`DESIGN.md`（dryRun 文案）、`test/workflow-project-archive.test.js`、`test/workflow-verify-jira.test.js`、`README.md`（通过率文案）

**Interfaces:**
- **清单校验**：`kind==="ok"` 后再验 `runId` 非空 string、`source` string、`startedAt/finishedAt` string、`summary` 为对象且 `total/passed/failed` 有限 number、`gate` 对象且 `result ∈ {pass,fail}` 且 `exitCode` 有限 number、`failureDomains` 为对象；不满足→`unreadable++` 且不出行（正常件行为逐字不变）。
- **候选不可读**：verify 映射候选构建时 `readCaseSummaries(jsonPath)` 为空 → `logLine(\`verify_jira_issue: 候选用例文件不可读，已跳过：${target.jsonPath}\`)`（经 `deps.log`，可断言）。
- **dryRun 预览**：`writeback.evidenceTruncated = failedWithTrace.length - planned.length`（>0 时；与发送路径同式）。
- **dryRun 文案**：统一为「dryRun 零写回（不产生任何外部副作用；读单/评论读取不变）」（工具描述/README/DESIGN §13.121）。
- **文案两处**：DESIGN §13.122「六值＋legacy-unknown」→「六值（含 legacy-unknown）」；README `project_archive` 行「通过率」→「通过/失败计数」。
- [ ] **Step 1: 写失败测试**：清单"ok 但缺 gate/summary 字段"→`unreadable` 计入且不出行；`schemaVersion:99` 清单→`unreadable`；pen 源 flows（`source:"pen:design/x.pen"`）→`design.source==="pen:design/x.pen"`；候选文件缺失＋另一正常集→映射候选仅正常集且日志含"不可读"；dryRun 11 条失败→`evidencePlanned` 10 条＋`evidenceTruncated:1`。
- [ ] **Step 2: 红→实现→绿**＋`npm run test:file -- test/workflow-project-archive.test.js test/workflow-verify-jira.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "fix(workflow): carry-over hardening (manifest validation, dryRun preview, candidate warn)"`

---

### Task 6: 记录＋全量

**Files:**
- Modify: `DESIGN.md`（§13.123 实施记录：范围、口径（三信号/五值/耗时语义/清单校验）、测试数）、`docs/接入指南.md`（版本行刷新为真实全量数）

- [ ] **Step 1: 全量** `npm run build && npm test && npm run lint`（记录实数）。
- [ ] **Step 2: §13.123＋接入指南版本行**（数字用 T6 实测）；`git add` 后提交：`git commit -m "docs: closure round (unified service ⑤) record"`。

---

## Self-Review 记录（写稿人自查）

- **覆盖**：核查缺口 G1 三子项→T1/T2/T3；G2→T4；"值得做的延后 Minor"→T5（③-Minor3 dryRun 文案／③-Minor4 预览计数／③-Minor5 候选 WARN／④-Minor2 清单校验／④-Minor4 测试补 pen 源＋newer／④-Minor5 文案两处）；**不做**：④-Minor1 顶层 catch（假空载荷会掩盖错误，per-path 已守，裁决留终审）、③-Minor6 读评论单遍、④-Minor3 空 runs 原因提示（继续留档）。
- **类型一致性**：`NeedsInfoCategory` 单点定义；`DevicePick` 变体与三工具 payload 同步；`recordStep` 三工具同形；信号码在计划与测试逐字一致。
- **比例**：6 任务；测试以增量断言为主（T3 含 4 处既有断言迁移）；无整段实现转写。
- **留白**：`step-ms` 是否并入既有 `steps[].ms` 之外的聚合（不做）；接入指南节内措辞（随实现收敛）。

## Execution Handoff

计划就绪。建议 **Native（executing-plans）**：T1→T3 顺序咬合（类型收紧先行）、T4/T5 独立、T6 收口；终审单独派 fresh reviewer。请审阅计划——确认后选择执行方式（Native／Subagent-driven）。
