# Test Case Authoring P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐用例字段 P1：产物内 `relatedCases`、`designRefs`，以及 `acceptance.variants` 的变体克隆、变体预期渲染与汇总计数。

**Architecture:** 在现有 P0 字段与 12 列 Excel/隐藏执行器契约上做加性扩展。`enrichGeneratedCases` 补 `designRefs`；生成后按产物范围计算 `relatedCases`；`acceptance.json` 增 `variants` 解析，克隆基准用例并写入 `variant`/合并 `testData`；子集归档前对副本重算 `relatedCases`，避免跨功能引用。

**Tech Stack:** TypeScript ESM、Node test runner、ExcelJS、现有 `src/figma/test-gen.ts` / `case-view.ts` / `test-xlsx.ts`。

**Spec:** `docs/superpowers/specs/2026-10-20-test-case-authoring-design.md`（P1 节 + §4.4/§5.3/§5.4/§5.5/§6.3/§9）

## Global Constraints

- 不改 `caseId` 语义；新增展示字段全部可选，旧 `tests.json` 缺失时显示 `—`/`n/a`。
- 不改 `steps`/`expectations` 对齐；变体额外预期只做渲染，不合并进 `expectations`。
- 三件套落盘契约、前 6 列位置、`suite check` 门禁不变。
- `relatedCases` 只在同一产物范围内（live 或单个功能归档）；不得引用子集外用例。
- 变体克隆必须使用独立 id 哈希（纳入 `variant.label`），避免与基准用例撞身份。
- 生成/测试不依赖网络、真实 PG 或设备。

## Review Focus

- `variants` 的 `screen` 不在任何用例屏幕中：应显式 warning、不克隆，不静默丢。
- 变体 label 含空格/中文/重复：id/displayId 必须唯一，重复 label 不合并。
- 同一屏幕被多条用例覆盖：克隆数量需有安全上限并可见告警。
- 子集归档：`relatedCases` 必须只引用同子集 `displayId`。
- 模板占位符：新增字段的空值应保留空串/回退值，未知占位符原样保留。

---

### Task 1: 解析 `acceptance.variants`

**Files:**
- Modify: `src/figma/test-gen.ts`（`AcceptanceDetails`、`emptyAcceptanceDetails`、`loadAcceptanceDetails`、新增 `readVariants`）
- Test: `test/figma-testgen.test.js`

**Interfaces:**
- Produces: `AcceptanceVariant { screen: string; label: string; data: string[]; expected: string[] }`
- Produces: `AcceptanceDetails.variants: AcceptanceVariant[]`

- [x] **Step 1: 写失败测试**

在 `test/figma-testgen.test.js` 加：acceptance v2 含合法 `variants`、非法条目、超过 20 条截断；断言 `payload.warnings` 与 `payload.flows` 后续可见（本任务先只断言解析不报错/警告）。

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: FAIL（`variants` 未解析，相关断言不成立）。

- [x] **Step 3: 实现解析**

`readVariants(value, warnings)`：只接受对象数组，`screen`/`label` 非空；`data`/`expected` 复用字符串数组清洗（去空、去重、每项 ≤20 条）；条目 ≤20，超出截断并 `acceptance-details-truncated`；非法条目 `acceptance-details-invalid`。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: PASS。

---

### Task 2: `designRefs` 填充

**Files:**
- Modify: `src/figma/test-gen.ts`（`EnrichCasesInput`、`enrichGeneratedCases`、调用点）
- Test: `test/figma-testgen.test.js`

**Interfaces:**
- Consumes: `FlowGraph.screens[].id/name/suggestedRoute`
- Produces: `GeneratedTest.designRefs = { screens, nodeIds, route? }`

- [x] **Step 1: 写失败测试**

在 acceptance v2 测试中加断言：`testCase.designRefs.screens` 与 `testCase.screens` 一致；`nodeIds` 与屏幕顺序对齐且非空；入口屏有 `suggestedRoute` 时 `route` 存在。

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: FAIL（`designRefs` 为 undefined）。

- [x] **Step 3: 实现**

`EnrichCasesInput` 增 `graph: FlowGraph`；`enrichGeneratedCases` 建 `screenByName`，按 `testCase.screens` 生成 `nodeIds`（缺失写 `""`，不伪造），`route` 取入口屏 `suggestedRoute`（空串省略）；调用点传入 `graph`。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: PASS。

---

### Task 3: `relatedCases` 与子集范围

**Files:**
- Modify: `src/figma/test-gen.ts`（新增导出 `assignRelatedCases`；live 与 case-set 子集接入）
- Test: `test/figma-testgen.test.js`

**Interfaces:**
- Produces: `assignRelatedCases(cases: GeneratedTest[]): void`
- 规则：同 `module` 或共享 ≥1 屏，排除自身；共享屏数降序 → `displayId` 升序；取前 3；只引用传入数组内的 `displayId`。

- [x] **Step 1: 写失败测试**

加单测：三条用例（A/B 同 module 共享 2 屏、C 不同 module 共享 1 屏、D 无关）→ A.relatedCases 为 `[B, C]` 顺序；子集数组只含 A/B 时，A 不引用 C。

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: FAIL（`assignRelatedCases` 未导出/未实现）。

- [x] **Step 3: 实现 live 接入**

`enrichGeneratedCases` 后调用 `assignRelatedCases(cases)`，再进入截图/渲染。

- [x] **Step 4: 实现子集接入**

case-set 循环内：`const subsetView = subset.map((testCase) => ({ ...testCase })); assignRelatedCases(subsetView);`，用 `subsetView` 渲染 md/xlsx 与写归档 JSON；live 的 `cases` 不被子集重算污染。

- [x] **Step 5: 跑测试确认通过**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: PASS。

---

### Task 4: 变体克隆与渲染

**Files:**
- Modify: `src/figma/test-gen.ts`（`applyAcceptanceVariants`、`caseIdFor` 调用、`taskDesc` 变体块）
- Modify: `src/figma/case-view.ts`（`expectedResultLines` 追加变体预期）
- Test: `test/figma-testgen.test.js`

**Interfaces:**
- `AcceptanceVariant` from Task 1.
- 克隆规则：对每个 variant，克隆所有 `screens.includes(variant.screen)` 的基准用例；每个 variant 最多 20 个克隆，超出 warning `variant-clone-truncated`；无匹配 warning `variant-screen-unmatched`。
- 克隆字段：`id = caseIdFor(name + variant.label, screens, steps)`；`semanticId` 纳入 `variant.label`；`variant = { group: screen, label, expected }`；`testData` 合并 variant.data 去重、≤12；`taskDesc` 在 `【AOS-EXPECT】` 前追加 `【变体：label】` + `- 数据：…`/`- 预期：…`。

- [x] **Step 1: 写失败测试**

acceptance `variants: [{screen:"Checkout", label:"优惠券已满", data:["优惠券：已满"], expected:["提示不可用"]}]`；断言：live flows +1；克隆 `id`/`displayId` 与基准不同；`variant` 字段完整；`testData` 含变体数据；`taskDesc` 含 `【变体：优惠券已满】`；`summary.variantGroups=1`；Excel 预期列含 `变体预期（优惠券已满）：提示不可用`；Markdown 同样可见。

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: FAIL（无克隆）。

- [x] **Step 3: 实现克隆**

`applyAcceptanceVariants(cases, variants, warnings)` 在 `enrichGeneratedCases` 后、`assignRelatedCases` 前执行；克隆用 `{...base}` 浅拷贝，保留 steps/expectations/designRefs/feature/module/section；重新派生 id/semanticId/displayId（`TC_` + 后 6 位，冲突加 `-2`）；`taskDesc` 追加变体块。

- [x] **Step 4: 实现渲染**

`expectedResultLines` 在编号预期后追加 `变体预期（<label>）：<item>`；Excel/Markdown 通过现有调用自动生效。

- [x] **Step 5: 跑测试确认通过**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: PASS。

---

### Task 5: 模板占位符、文档与全量验证

**Files:**
- Test: `test/figma-testgen.test.js`
- Modify: `DESIGN.md`（§13.135 状态 + 新增 §13.209）
- Modify: `README.md` / `AGENTS.md`（P1 字段与模板占位符摘要）

- [x] **Step 1: 模板测试**

构造带 `{{case.relatedCases}}`/`{{case.designRefs}}`/`{{case.variantLabel}}`/`{{case.variantExpected}}` 的模板；断言替换值、空值空串、未知占位符原样保留。

- [x] **Step 2: 文档**

DESIGN §13.135 状态改「P0/P1 已实施，P2 未实施」；新增 §13.209 记录规则、变体选择/上限/ID 决策与测试数；README/AGENTS 补 P1 字段摘要。

- [x] **Step 3: 全量验证**

Run: `npm test && npm run lint`
Expected: 全绿（lint 允许 2 条既有 warning）。
