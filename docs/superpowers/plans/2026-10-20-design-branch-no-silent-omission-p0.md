# 设计多分叉「不许静默漏」P0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pen 设计提取对多屏/多变体/多候选元素做到「要么识别，要么具名/计数暴露」，并让提取期设计警告在一条龙、生成、校验、报告、面板、档案入口全部可见。

**Architecture:** 先建两个纯函数模块（警告汇总、候选覆盖），再把 vision 从"主屏列表"扩成"主屏+变体 target 列表"，用四态覆盖与守恒统计兜底；最后把同一份警告快照接到所有下游面。P0-A 与 P0-B 同一里程碑发布，不单独发布 P0-A。

**Tech Stack:** TypeScript ESM/NodeNext strict、Node 内置 test runner、既有假 pen exec/chat/fetch 注入；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-19-design-branch-no-silent-omission-design.md`

## Global Constraints

- 完成标准：`npm run build && npm test && npm run lint` 全绿；测试跑 `dist/`，改完先 build。
- 全部新字段 additive；`screensRequested` 保持"进入 pass 的主屏数"，变体另计 `statesRequested`/`targetsRequested`。
- 警告不阻断：不改现有 check 门禁（覆盖/截断/三件套/真实数据）与退出码。
- 用户可见文案中文；代码标识符英文；默认不加注释（仅非显然契约的 JSDoc）。
- 测试不依赖真实 PG/设备/外网；pen 用假 `exec`/`render`/`chat`，Figma 用 fetch 打桩。
- stdout 属于 MCP stdio 协议；日志走 stderr。
- 不修改 `mobile_*` schema；新增原生工具能力按既有 zod 域放置。
- `AOS_VISION_MAX_TARGETS` 为新首选名，`AOS_VISION_MAX_SCREENS` 兼容；`AOS_VISION_CANDIDATE_TOKENS` 为候选词表追加。
- 行为/用法变更同步 `DESIGN.md`、`README.md`、`AGENTS.md`、`.env.example`。
- 不新增阻断门禁；`unverifiable`/`not-evaluated` 不得当 `covered`。

## Review Focus

1. **中文/陌生命名**：候选词表不适配时，不得静默 0 候选；Task 2 + Task 4 测试 `vision-candidate-vocabulary-unmatched`。
2. **auto-layout 缺几何**：候选无 bbox/文本时必须 `unverifiable`，不得算覆盖；Task 2 + Task 4 测试。
3. **变体超上限**：主屏优先，被裁变体必须具名；Task 5 测试 cap 顺序与 `capped` 明细。
4. **重复常见标签**：同 state 多个候选共享「确定/取消」文本时不得假 covered；Task 2 测试 `ambiguous-text`。
5. **快照/来源优先级**：tests 快照优先、flows 回退、manifest 冻结；陈旧快照标 `stale-snapshot`；Task 1 + Task 8 测试。

---

## File Structure

**Create**

- `src/design/warnings.ts` — 读取/合并/汇总 flows、tests、manifest 三源警告。
- `src/design/element-coverage.ts` — 候选词表、四态覆盖、覆盖告警。
- `test/design-warnings.test.js`
- `test/design-element-coverage.test.js`

**Modify**

- `src/design/vision.ts` — parse 截断、target/state 字段、四态覆盖接线、stats/accounting。
- `src/pen/flows.ts` — 候选/变体采集、静默路径、payload/flow-map。
- `src/workflow/design-to-test.ts` — 一条龙警告与 flowMap。
- `src/figma/test-gen.ts` — 生成响应/tests.md/tests.json 警告。
- `src/figma/preflight.ts`、`src/suite-command.ts`、`src/figma/suite-loop.ts` — check/loop。
- `src/figma/run-manifest.ts`、`src/figma/suite-batch.ts`、`src/figma/run-report.ts` — manifest/report。
- `src/workflow/run-regression.ts`、`src/workflow/verify-jira.ts` — 两个一条龙入口。
- `src/panel/assets.ts`、`src/panel/overview.ts`、`src/panel/web.ts`、`src/workflow/project-archive.ts`、`scripts/design-pipeline.mjs`。
- `DESIGN.md`、`README.md`、`AGENTS.md`、`.env.example`。

**Tests to extend**

- `test/pen-flows.test.js`、`test/pen-vision.test.js`
- `test/workflow-design-to-test.test.js`、`test/figma-testgen.test.js`
- `test/suite-command.test.js`、`test/suite-loop.test.js`、`test/suite-run-manifest.test.js`
- `test/panel-assets.test.js`、`test/panel-web.test.js`、`test/workflow-project-archive.test.js`
- `test/workflow-run-regression.test.js`、`test/workflow-verify-jira.test.js`

---

### Task 1: 警告收集/合并/汇总模块

**Files:**
- Create: `src/design/warnings.ts`
- Test: `test/design-warnings.test.js`

**Interfaces:**
- Consumes: `FlowWarning` shape (`{ code, message, details? }`) from `src/figma/flows.ts`; `fs`/`path`.
- Produces:
  ```ts
  interface DesignWarning { code: string; message: string; details?: string[] }
  interface WarningSummary {
    available: boolean; total: number; byCode: Record<string, number>; codes: string[];
    bySource?: Record<string, number>; snapshotAt?: string; stale?: boolean;
  }
  interface WarningRead { warnings: DesignWarning[]; snapshotAt: string | null; available: boolean }
  function normalizeWarnings(raw: unknown): DesignWarning[]
  function readFlowsWarnings(configDirAbs: string): WarningRead
  function readTestsWarnings(configDirAbs: string, options?: { testsPath?: string }): WarningRead
  function mergeWarnings(inputs: Array<{ warnings: DesignWarning[]; source: string }>): {
    warnings: DesignWarning[]; bySource: Record<string, number>
  }
  function summarizeWarnings(warnings: DesignWarning[], options?: {
    available?: boolean; bySource?: Record<string, number>; snapshotAt?: string; stale?: boolean
  }): WarningSummary
  function resolveDesignWarnings(configDirAbs: string, options?: {
    testsPath?: string; prefer?: "tests" | "flows"
  }): { warnings: DesignWarning[]; summary: WarningSummary; source: "tests" | "flows" | "none"; snapshotAt: string | null; stale: boolean }
  ```

- [ ] **Step 1: Write the failing test**

In `test/design-warnings.test.js`, cover:
```js
test("readFlowsWarnings: 读取数组并丢弃坏条目", () => {
  // temp configDir/design/flows.json: warnings: [{code:"pen-no-interactions",message:"x"}, {bad:true}]
  // assert available true, warnings.length===1, snapshotAt 是 ISO
});
test("resolveDesignWarnings: tests 快照优先，flows 回退，缺省 none", () => { /* ... */ });
test("resolveDesignWarnings: tests 早于 flows 时 stale=true", () => { /* fs.utimes */ });
test("mergeWarnings: code+message 去重、稳定序、bySource 计数", () => { /* ... */ });
test("summarizeWarnings: total/byCode/codes", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/design-warnings.test.js`
Expected: FAIL（模块不存在/函数未定义）。

- [ ] **Step 3: Implement `src/design/warnings.ts`**

Read flows.json 顶层 `warnings`；tests.json 顶层 `designWarnings`；缺文件/坏 JSON → `available:false`、空数组，不抛。`resolveDesignWarnings` 默认 tests 优先；`stale` 比较 tests/flows 的 mtime。`mergeWarnings` 按 `code + "\u0000" + message` 去重，保留首次出现顺序。`summarizeWarnings` 的 `codes` 按出现顺序去重。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/design-warnings.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/warnings.ts test/design-warnings.test.js
git commit -m "feat(design): design warning collector + summary"
```

---

### Task 2: 候选词表与四态覆盖纯函数

**Files:**
- Create: `src/design/element-coverage.ts`
- Test: `test/design-element-coverage.test.js`

**Interfaces:**
- Consumes: `FlowElement` (`bbox`, `label?`, `nodeId?`) from `src/figma/flows.ts`; `DesignWarning` from `./warnings.js`.
- Produces:
  ```ts
  const DEFAULT_CANDIDATE_TOKENS: readonly string[]
  function parseCandidateTokens(raw: string | undefined): string[]
  function candidateNameMatches(name: string, extraTokens?: readonly string[]): boolean
  interface VisionCandidate {
    id: string; name: string; type: string;
    bbox?: { x: number; y: number; width: number; height: number };
    textHints: string[]; state: string | null;
  }
  interface CandidateCoverageDetail {
    nodeId: string; name: string;
    status: "covered" | "uncovered" | "unverifiable" | "not-evaluated";
    reason?: "no-geometry" | "no-text" | "ambiguous-text" | "vision-off" | "capped" | "render-missing" | "frame-missing" | "rejected" | "failed";
    bbox?: { x: number; y: number; width: number; height: number };
  }
  interface FlowElementCoverage {
    state: string | null; designNodes: number; candidateNodes: number;
    recognizedElements: number; groundedElements: number; ungroundedElements: number;
    coveredCandidates: number; uncoveredCandidates: number; unverifiableCandidates: number;
    notEvaluatedCandidates: number; candidatesTruncated?: number;
    details: CandidateCoverageDetail[];
  }
  function evaluateCandidateCoverage(input: {
    state: string | null;
    designNodes: number;
    candidates: VisionCandidate[];
    elements: FlowElement[];
    notEvaluatedReason?: CandidateCoverageDetail["reason"];
    candidatesTruncated?: number;
  }): FlowElementCoverage
  function coverageWarnings(screenName: string, coverages: FlowElementCoverage[]): DesignWarning[]
  ```

- [ ] **Step 1: Write the failing test**

In `test/design-element-coverage.test.js`, cover:
```js
test("candidateNameMatches: 任一段命中（Icon/Bag→Bag, Button/My Order→Button）", () => { /* ... */ });
test("candidateNameMatches: 中文词与 AOS_VISION_CANDIDATE_TOKENS 追加", () => { /* ... */ });
test("evaluateCandidateCoverage: nodeId / IoU / 中心命中都算 covered", () => { /* ... */ });
test("evaluateCandidateCoverage: 无几何无文本 → unverifiable", () => { /* ... */ });
test("evaluateCandidateCoverage: 同 state 重复文本 → ambiguous-text，不假 covered", () => { /* ... */ });
test("evaluateCandidateCoverage: notEvaluatedReason 全量 not-evaluated", () => { /* ... */ });
test("coverageWarnings: uncovered 具名；unverifiable 每屏一条；零候选出 vocabulary-unmatched", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/design-element-coverage.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement `src/design/element-coverage.ts`**

词表分段匹配（`/` 分隔，大小写不敏感；`Sticky button` 允许空格）；中英文词表 + `extraTokens`。覆盖匹配只在该 `state` 传入的候选/元素内进行。文本 fallback：同 state 中同一归一化文本命中的候选数 >1 → `ambiguous-text`，不得覆盖。`coverageWarnings` 产出 `vision-candidate-uncovered`（具名 details）、`vision-candidate-unverifiable`（每屏一条）、`vision-candidate-vocabulary-unmatched`（`designNodes>0 && candidateNodes===0`）。`unverifiable` 不逐候选告警；`not-evaluated` 不重复告警（屏级承担）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/design-element-coverage.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/element-coverage.ts test/design-element-coverage.test.js
git commit -m "feat(design): candidate coverage four-state primitives"
```

---

### Task 3: vision 解析截断 + target/state/stats 类型

**Files:**
- Modify: `src/design/vision.ts`
- Test: `test/pen-vision.test.js`

**Interfaces:**
- Consumes: `VisionCandidate`/`FlowElementCoverage` from `./element-coverage.js`.
- Produces:
  ```ts
  function parseVisionReply(content: string): { items: RawVisionItem[]; invalid: number; truncated: number }
  interface VisionScreenInput {
    id: string; name: string; width: number; height: number; nodes: VisionNodeGeom[];
    stateOf?: string | null; stateName?: string | null; candidates?: VisionCandidate[];
    /** 渲染倍率；默认 1。非 1 时 bbox 先除以它再进入设计 px 判定。 */
    renderScale?: number;
  }
  interface VisionStats {
    // 既有 7 字段 + 新增（spec §5）
    screensInput: number; screensNoGeometry: number; screensFrameMissing: number; screensCapped: number; screensFailed: number;
    truncatedItems: number; groundedElements: number; ungroundedElements: number;
    candidateNodes: number; coveredCandidates: number; uncoveredCandidates: number;
    unverifiableCandidates: number; notEvaluatedCandidates: number;
    targetsRequested: number; statesRequested: number; statesInput: number;
    statesProcessed: number; statesSkipped: number; statesFailed: number; statesCapped: number;
    statesNoGeometry: number; statesFrameMissing: number;
  }
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/pen-vision.test.js`:
```js
test("parseVisionReply: >40 条返回 truncated 计数，不再静默丢弃", () => { /* 41 elements → items 40, truncated 1 */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/pen-vision.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement types/parse**

`parseVisionReply` 保留前 40 条；`truncated = Math.max(0, rawElements.length - 40)`。类型增加 `stateOf/stateName/candidates/renderScale` 与 stats 字段；`bboxInPx` 继续用设计 px，若 `renderScale` 存在且 ≠1，先除以它再判定。本任务只落类型与解析，`runVisionPass` 行为在 Task 5 接线。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/pen-vision.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/vision.ts test/pen-vision.test.js
git commit -m "feat(vision): parse truncation + target/state stats"
```

---

### Task 4: pen 候选/变体采集 + 静默路径

**Files:**
- Modify: `src/pen/flows.ts`
- Test: `test/pen-flows.test.js`, `test/pen-vision.test.js`

**Interfaces:**
- Consumes: `VisionCandidate`/`candidateNameMatches` from `../design/element-coverage.js`; `VisionScreenInput` from `../design/vision.js`.
- Produces:
  ```ts
  interface PenFlowScreen {
    states: Array<{
      id: string; label: string; frameName: string;
      elements?: FlowElement[]; edges?: FlowEdge[]; elementsCoverage?: FlowElementCoverage[];
    }>;
    elementsCoverage?: FlowElementCoverage[];
  }
  export interface CollectedVision {
    targets: VisionScreenInput[]; // 主屏在前，变体在后
    excluded: Array<{
      screenId: string; screenName: string; state: string | null;
      reason: "frame-missing" | "no-geometry";
      candidates: VisionCandidate[]; designNodes: number;
    }>;
    duplicateIds: string[];
    candidatesTruncated: number;
  }
  export function collectVisionScreens(doc: PenDocument, screens: PenFlowScreen[],
    sizeFor?: (id: string) => { width: number; height: number } | null): CollectedVision
  ```

- [ ] **Step 1: Write the failing test**

Add to `test/pen-flows.test.js` / `test/pen-vision.test.js`:
```js
test("collectVisionScreens: 帧缺 id/重复 id → excluded frame-missing + duplicateIds，不静默 continue", () => { /* ... */ });
test("collectVisionScreens: 主屏在前、states 在后；state target 带 stateOf/stateName", () => { /* ... */ });
test("collectVisionScreens: Button/Icon/Bag 候选命中；Flow/* 排除；嵌套保留最外层", () => { /* ... */ });
test("collectVisionScreens: auto-layout 无几何候选 bbox 缺省；200 上限 candidatesTruncated", () => { /* ... */ });
test("collectVisionScreens: state 帧缺失 → excluded frame-missing（statesFrameMissing 可计）", () => { /* ... */ });
test("renderAndImportPenScreens: 主屏 + 变体一并渲染，summary 分 screens/states 计数", () => { /* ... */ });
test("visionMaxScreens: AOS_VISION_MAX_TARGETS 优先于旧名；0/all 不限", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/pen-flows.test.js && npm run test:file -- test/pen-vision.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement collection**

`collectVisionScreens` 先按主屏、再按 `screen.states` 生成 target；每个 target 从 frame 子树采集候选（`candidateNameMatches`），累计 `x/y` 偏移，只有数值 `x/y/w/h` 齐全才给 bbox；候选上限 200。帧查不到 → `excluded(frame-missing)`；无几何且无渲染尺寸 → `excluded(no-geometry)`；重复 id 收集到 `duplicateIds`。节点 grounding 列表改为候选优先、叶子优先、容器兜底，仍截 300 并记录 `groundingTruncated`。`screenAssetLoader`/`renderAndImportPenScreens` 的 screenIds 改为主屏 + `states[].id`（去重）；summary 增 `screens`/`states` 计数；`screens:false` 时仍为 vision 渲染。`applyVision` 调用点改为传入主屏+变体。`visionMaxScreens` 读 `AOS_VISION_MAX_TARGETS` 优先，回退 `AOS_VISION_MAX_SCREENS`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/pen-flows.test.js && npm run test:file -- test/pen-vision.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pen/flows.ts test/pen-flows.test.js test/pen-vision.test.js
git commit -m "feat(pen): collect vision candidates/states + silent-path guards"
```

---

### Task 5: runVisionPass 四态/守恒 + applyVision 接线

**Files:**
- Modify: `src/design/vision.ts`, `src/pen/flows.ts`
- Test: `test/pen-vision.test.js`, `test/pen-flows.test.js`

**Interfaces:**
- Consumes: Task 2–4 的 `evaluateCandidateCoverage`、`coverageWarnings`、`CollectedVision`。
- Produces:
  ```ts
  interface VisionPassResult {
    // 既有字段
    coverageByTarget: Map<string, FlowElementCoverage>;
    cappedTargets: VisionScreenInput[];
    stateEdges: FlowEdge[];      // 审计用，不进 result.edges
  }
  // pen payload:
  // vision: { requested, active, model?, reason?, stats, accounting }
  // screens[].elementsCoverage / screens[].states[].elements|edges|elementsCoverage
  ```

- [ ] **Step 1: Write the failing test**

Add:
```js
test("runVisionPass: 主屏+变体逐 target 识别，state 元素只进 states，不进主屏 elements", () => { /* ... */ });
test("runVisionPass: state target 计入 statesRequested/Processed，元素带 state", () => { /* ... */ });
test("runVisionPass: 非 1x 渲染先按 renderScale 换算（或显式拒绝）", () => { /* ... */ });
test("runVisionPass: 变体独有 Button 未识别 → vision-candidate-uncovered 带 state 名", () => { /* ... */ });
test("runVisionPass: cap 先裁变体，主屏全保留；capped 具名", () => { /* ... */ });
test("applyVision: 会计公式成立；人为破坏 → vision-accounting-mismatch", () => { /* ... */ });
test("pen payload/flow-map: 屏/变体显示 识别/候选/覆盖/未覆盖/不可核验/未评估", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/pen-vision.test.js && npm run test:file -- test/pen-flows.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement runVisionPass/applyVision**

按 target 处理：render-missing→skipped（主屏/变体分桶）；拒图→当前+剩余进 skipped；调用失败→failed；成功→processed。解析 >40 → `vision-response-truncated`。每个 target 用 `evaluateCandidateCoverage` 生成四态；未进入 pass 的 target 用 `not-evaluated`。`applyVision` 把主屏元素/覆盖写到 `screen.elements`/`screen.elementsCoverage`；变体元素/边/覆盖写到 `screen.states[]`；`result.edges` 只合并主屏边；`stateEdges` 单独审计。payload 加 `vision.accounting`；flow-map 每屏/每 state 加一行覆盖摘要。守恒不成立 → `vision-accounting-mismatch`；截图开启时 `screens+states = rendered+skipped` 不成立 → `screenshot-accounting-mismatch`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/pen-vision.test.js && npm run test:file -- test/pen-flows.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/vision.ts src/pen/flows.ts test/pen-vision.test.js test/pen-flows.test.js
git commit -m "feat(vision): four-state coverage + accounting + variant targets"
```

---

### Task 6: `design_to_test` 一条龙警告与 flowMap

**Files:**
- Modify: `src/workflow/design-to-test.ts`
- Test: `test/workflow-design-to-test.test.js`

**Interfaces:**
- Consumes: `normalizeWarnings`/`readFlowsWarnings`/`mergeWarnings`/`summarizeWarnings` from `../design/warnings.js`。
- Produces: response adds `warnings: DesignWarning[]`, `designWarnings: WarningSummary`, `artifacts.flowMap?: string`, `steps[extract].warnings: number`。

- [ ] **Step 1: Write the failing test**

```js
test("design_to_test: extract warnings 进入最终响应（含 pen-no-interactions）", () => { /* stub extract payload */ });
test("design_to_test: reuseExistingFlows 读取 flows.json warnings", () => { /* ... */ });
test("design_to_test: artifacts.flowMap 指向 design/flow-map.md", () => { /* ... */ });
test("design_to_test: check 失败响应也携带已获得的 warnings", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/workflow-design-to-test.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement wiring**

extract 成功后取 `extractedPayload.warnings`；reuse 时 `readFlowsWarnings`；`designWarnings` 用 `summarizeWarnings`；`recordStep` 加计数；成功/失败响应都带 `warnings` 与 `designWarnings`；`artifacts.flowMap` 存在才加。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/workflow-design-to-test.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/workflow/design-to-test.ts test/workflow-design-to-test.test.js
git commit -m "feat(workflow): design_to_test surfaces design warnings"
```

---

### Task 7: `figma_generate_tests` 响应/tests.md/tests.json

**Files:**
- Modify: `src/figma/test-gen.ts`
- Test: `test/figma-testgen.test.js`

**Interfaces:**
- Consumes: `readFlowsWarnings`/`mergeWarnings`/`summarizeWarnings`; `flowGraphWarnings`。
- Produces: payload `designWarnings: DesignWarning[]`, `designWarningsSummary: WarningSummary`; `renderMarkdown(..., options: { images?; feedback?; designWarnings? })`；tests.json additive 字段。

- [ ] **Step 1: Write the failing test**

```js
test("figma_generate_tests: 文件模式把 flows warnings 写进响应/tests.json/tests.md", () => { /* ... */ });
test("figma_generate_tests: URL 模式现算 flowGraphWarnings", () => { /* ... */ });
test("figma_generate_tests: 无警告时 md 不出现空小节", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement**

文件模式在读取 flows.json 时保留原始 `warnings`；URL 模式用 `flowGraphWarnings(graph)`；与生成期 warnings 合并去重。payload 加 `designWarnings` + `designWarningsSummary`；`renderMarkdown` 顶部渲染「## 设计源警告（不阻断生成）」；tests.json 写同样字段。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/figma-testgen.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/figma/test-gen.ts test/figma-testgen.test.js
git commit -m "feat(figma): generate carries design warnings into md/json"
```

---

### Task 8: `preflight` / `suite check` / `suite loop`

**Files:**
- Modify: `src/figma/preflight.ts`, `src/suite-command.ts`, `src/figma/suite-loop.ts`
- Test: `test/suite-command.test.js`, `test/suite-loop.test.js`

**Interfaces:**
- Consumes: `resolveDesignWarnings`。
- Produces: `PreflightReport` adds `designWarnings`, `designWarningSummary`, `designWarningsSource`, `designWarningsSnapshotAt`, `designWarningsStale`；check JSON/text 与 loop report/markdown 透出。

- [ ] **Step 1: Write the failing test**

```js
test("suite check: 文本与 --json 都显示 designWarnings 摘要", () => { /* ... */ });
test("suite check: tests 快照早于 flows → stale-snapshot", () => { /* ... */ });
test("suite loop: check 步骤与 markdown 带 designWarnings", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/suite-command.test.js && npm run test:file -- test/suite-loop.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement**

`preflightGeneratedTests` 调 `resolveDesignWarnings`；`suiteCheck` 文本打一行 `设计源警告: N 条（codes）`，JSON 加字段；`suiteLoop` 的 `SuiteLoopCheck`/`SuiteLoopReport.steps.check` 加 summary，markdown 打印同源一行。保持退出码不变。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/suite-command.test.js && npm run test:file -- test/suite-loop.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/figma/preflight.ts src/suite-command.ts src/figma/suite-loop.ts test/suite-command.test.js test/suite-loop.test.js
git commit -m "feat(suite): check/loop surface design warnings"
```

---

### Task 9: manifest / report / `run_regression` / `verify_jira_issue`

**Files:**
- Modify: `src/figma/run-manifest.ts`, `src/figma/suite-batch.ts`, `src/figma/run-report.ts`, `src/workflow/run-regression.ts`, `src/workflow/verify-jira.ts`
- Test: `test/suite-run-manifest.test.js`, `test/workflow-run-regression.test.js`, `test/workflow-verify-jira.test.js`

**Interfaces:**
- Consumes: `PreflightReport.designWarningSummary`（Task 8）。
- Produces: `RunManifest.designWarnings: WarningSummary | null`; `RunReport.designWarnings: WarningSummary | null`; tool responses add `designWarnings`（跨 set 合并）。

- [ ] **Step 1: Write the failing test**

```js
test("run manifest: designWarnings 快照写入，历史批次不随 flows 变化", () => { /* ... */ });
test("run report: 摘要包含 designWarnings", () => { /* ... */ });
test("run_regression: 响应含跨 set 合并的 designWarnings", () => { /* ... */ });
test("verify_jira_issue: 响应含 designWarnings", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/suite-run-manifest.test.js && npm run test:file -- test/workflow-run-regression.test.js && npm run test:file -- test/workflow-verify-jira.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement**

`buildRunManifest` 从 `report.preflight?.designWarningSummary` 写 `designWarnings`；`RunReport` 增加同字段并在摘要区渲染一行；`run_regression`/`verify_jira_issue` 从各 batch 的 `report.preflight` 取 summary，按 `mergeWarnings` 合并后返回。缺 preflight → `null`，不伪造。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/suite-run-manifest.test.js && npm run test:file -- test/workflow-run-regression.test.js && npm run test:file -- test/workflow-verify-jira.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/figma/run-manifest.ts src/figma/suite-batch.ts src/figma/run-report.ts src/workflow/run-regression.ts src/workflow/verify-jira.ts test/suite-run-manifest.test.js test/workflow-run-regression.test.js test/workflow-verify-jira.test.js
git commit -m "feat(run): manifest/report/regression/jira surface design warnings"
```

---

### Task 10: 面板 / 档案 / design-pipeline

**Files:**
- Modify: `src/panel/assets.ts`, `src/panel/overview.ts`, `src/panel/web.ts`, `src/workflow/project-archive.ts`, `scripts/design-pipeline.mjs`
- Test: `test/panel-assets.test.js`, `test/panel-web.test.js`, `test/workflow-project-archive.test.js`

**Interfaces:**
- Consumes: `resolveDesignWarnings`/`summarizeWarnings`；`RunManifest.designWarnings`（Task 9）。
- Produces: `PanelDiskAssets.designWarnings` 或项目视图字段；`projectArchive` 的 `design.warnings`；脚本终端摘要。

- [ ] **Step 1: Write the failing test**

```js
test("panel assets: 项目页显示设计源警告数量与 codes", () => { /* ... */ });
test("panel batch detail: 读 manifest.designWarnings", () => { /* ... */ });
test("project_archive: design.warnings 摘要", () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/panel-assets.test.js && npm run test:file -- test/panel-web.test.js && npm run test:file -- test/workflow-project-archive.test.js`
Expected: FAIL。

- [ ] **Step 3: Implement**

项目级用 `resolveDesignWarnings` 取当前快照，渲染 `设计源警告 N 条（codes）`；批次详情读 manifest；`projectArchive` 加 `design.warnings`；`design-pipeline.mjs` 提取后打印 summary。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/panel-assets.test.js && npm run test:file -- test/panel-web.test.js && npm run test:file -- test/workflow-project-archive.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/panel/assets.ts src/panel/overview.ts src/panel/web.ts src/workflow/project-archive.ts scripts/design-pipeline.mjs test/panel-assets.test.js test/panel-web.test.js test/workflow-project-archive.test.js
git commit -m "feat(panel): panel/archive/pipeline surface design warnings"
```

---

### Task 11: 文档 + 全量验收

**Files:**
- Modify: `DESIGN.md`, `README.md`, `AGENTS.md`, `.env.example`

**Interfaces:**
- Consumes: Tasks 1–10 的实现。
- Produces: 文档与实现一致；全量绿。

- [ ] **Step 1: Update docs**

- `DESIGN.md`：新增 §13.133 实施记录（P0-A/P0-B、候选四态、变体 target、警告管道、守恒公式、env 迁移、已知边界）。
- `README.md`：`pen_extract_flows` 的 warnings/候选/变体说明；`AOS_VISION_MAX_TARGETS`（旧名兼容）、`AOS_VISION_CANDIDATE_TOKENS`；`design_to_test`/generate/check/loop/panel/archive 的 warnings 可见面。
- `AGENTS.md`：速查行同步 vision 上限/候选词表/警告可见面。
- `.env.example`：新增 `AOS_VISION_MAX_TARGETS`、`AOS_VISION_CANDIDATE_TOKENS`，旧名注释兼容。

- [ ] **Step 2: Full verification**

Run: `npm run build && npm test && npm run lint`
Expected: 全绿（build 0 error；test 全 pass；lint 0 error）。

- [ ] **Step 3: Real project manual replay（本地、非 CI）**

Run（本地 starbuckstw）：
```bash
AOS_VISION_MAX_SCREENS=0 node dist/cli.js ...  # 或 scripts/aos-call.mjs 调 design_to_test
```
Expected: 23 主屏 + 30 变体全部有 target 记录；默认 50 时 3 个变体具名 `capped`；`unverifiable` 有计数；215 条探索边在 `maxFlows=300` 下全保留；一条龙响应含 design warnings。

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md README.md AGENTS.md .env.example
git commit -m "docs(design): record P0 no-silent-omission implementation"
```

---

## Self-Review

- **Spec coverage**：P0-A 的七条静默路径、候选四态、变体 target、守恒（Task 3–5）；P0-B 的 design_to_test/generate/check/loop/manifest/report/panel/archive/run_regression/verify_jira_issue（Task 6–10）；env/词表/文档（Task 4/11）。P1 不在本计划，另出。
- **Step scan**：每个任务有失败测试→实现→通过→提交；无 TBD/“处理边界情况”式步骤。
- **Type consistency**：`DesignWarning`/`WarningSummary`/`FlowElementCoverage`/`VisionCandidate` 在 Task 1–5 定义，后续任务只消费；`screensRequested` 始终主屏，`statesRequested` 变体。
- **Review Focus**：五条均有对应任务测试（Task 2/4/5 与 Task 1/8）。
- **Proportion**：计划只列签名、测试断言与落点，不抄实现体；P1 拆出，避免单计划过大。
