# Web 手工 Excel 通用执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让网页测试直接接受简体、繁体、英文手工 Excel：规则解析 + 可选 LLM 规范化 + 尽力生成可运行 Maestro flow；未识别步骤标 `UNVERIFIED` 而不是让整条用例失败。

**Architecture:** 把“步骤 → 动作”的解析从 `script-gen.ts` 拆成可测试的 `step-parse.ts`，统一简/繁/英动作词表与相对定位选择器；生成器增加 `bestEffort`，未映射步骤写 `# aos:manual` + 截图并继续，runner 上报 manual 标记，中心把带 manual 的 PASS 降级为 `UNVERIFIED`。可选 LLM 只输出受控 JSON AST，经同一套校验后编译成 Maestro，不直接写 YAML；无 LLM 时规则路径仍可生成。

**Tech Stack:** TypeScript ESM/NodeNext、node:test、exceljs、现有 `ChatFn`/`makeChatFn`、现有 Web 资产/脚本集/runner/结果判定链路。

**Spec:** `docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md` §6.1（受控 LLM + 规则生成 Maestro）与 §7.1（LLM/手工用例执行）；现有生成器边界见 `docs/superpowers/specs/2026-10-29-maestro-assertion-generation-rationale.md`。

## Global Constraints

- TS ESM strict，相对导入一律 `.js`；不新增第三方依赖。
- 测试 hermetic：Memory/File store + 临时目录；LLM 用 fake `ChatFn`；不连真实设备、真实 LLM、真实 PG、外网。
- `bestEffort=false` 时保持现有 strict 语义不变；旧测试与旧脚本集行为不能回退。
- **不伪造 PASS**：manual/未映射步骤、无断言证据、只有软文本预期，一律 `UNVERIFIED`。
- LLM 只输出受控 JSON AST；标签必须来自用例原文或系统标签白名单，禁止模型发明选择器；禁止模型直接输出 YAML/命令。
- 语言覆盖：简体、繁体、英文使用同一套动作语义；标签保留原始文字，不翻译。
- 用户可见文案用中文；代码标识符用英文。
- 每个任务结束提交；最终 `npm run build && npm test && npm run lint` 全绿（lint 允许既有 warning）。
- 真实 GU 项目验证只作为手工验收，不写进 CI 测试。

## Review Focus

- **续行合并**：Excel 中 `2. Input invalid referral code` 下一行 `(A random code)` 是续行，不是新步骤；合并错误会直接导致步骤号与断言错位。
- **繁体动作词**：`點一下/輕觸/填寫/選取/前往` 等必须与简体同义；只覆盖部分词会让繁体用户再次遇到 `step-unparsed`。
- **英文相对定位**：`Tap the information button next to "Referral Code"` 必须生成 `rightOf` 选择器或显式 manual，不能退化成点击 `Referral Code` 文本。
- **占位输入值**：`(A random code)` 必须生成确定性、可审计的测试值并标注；不能写死成看似真实的数据。
- **manual 不得假绿**：flow 里有 `# aos:manual` 时，即使断言通过，中心也必须把 PASS 降级为 `UNVERIFIED`。
- **LLM 幻觉标签**：模型返回原文不存在的标签时必须拒绝并回退规则，不能生成点击不存在元素的脚本。
- **部分脚本集**：0 条完整 ready、但有 partial 可执行用例时，脚本集应允许写入；0 条可执行才拒绝。

---

### Task 1: 步骤续行合并与繁体动作词

**Files:**
- Modify: `src/web/excel.ts:144-149, 359-363`
- Modify: `src/web/script-gen.ts`（动作词正则、`stripStepNumber`）
- Test: `test/web-excel.test.js`, `test/web-script-gen.test.js`

**Interfaces:**
- Produces: `export function splitStepLines(value: string): string[]`（`src/web/excel.ts`）；`parseExcel` 的 `steps` 改用它。
- Produces: `splitLines` 继续用于 `preconditions`，语义不变。
- Produces: `generateFlow` 识别新增繁体动作词，不改变现有简体的输出。

- [ ] **Step 1: Write the failing tests**

在 `test/web-excel.test.js` 增加一个 `steps` 含续行的用例：

```js
test("web-excel: 续行合并到上一步，不单独成为步骤", async (t) => {
  const buffer = await workbookBuffer([
    ["TC-1", "1. Go to Register page\n2. Input invalid referral code\n(A random code)\n3. Tap submit", "", ""]
  ]);
  const parsed = await parseExcel(buffer, mapping);
  assert.deepEqual(parsed.cases[0].steps, [
    "1. Go to Register page",
    "2. Input invalid referral code (A random code)",
    "3. Tap submit"
  ]);
});
```

在 `test/web-script-gen.test.js` 增加繁体动作词用例：

```js
test("script-gen: 繁体常见动作词", () => {
  for (const step of ["點一下“登入”", "輕觸“登入”", "選取“登入”"]) {
    const result = gen({ steps: ["1. 啟動 App", `2. ${step}`], expected: "頁面顯示“首頁”" });
    assert.equal(result.status, "ready");
    assert.match(result.yaml, /- tapOn: '登入'/);
  }
  const filled = gen({
    steps: ["1. 啟動 App", "2. 在“帳號”填寫 test@example.com"],
    expected: "頁面顯示“首頁”"
  });
  assert.equal(filled.status, "ready");
  assert.match(filled.yaml, /- tapOn: '帳號'\n- inputText: 'test@example\.com'/);
  const nav = gen(
    { steps: ["1. 啟動 App", "2. 前往“設定”頁面"], expected: "頁面顯示“設定”" },
    { inferNavigationTap: true }
  );
  assert.equal(nav.status, "ready");
  assert.match(nav.yaml, /- tapOn: '設定'/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-excel.test.js test/web-script-gen.test.js`
Expected: FAIL（续行被拆成单独步骤；`點一下/輕觸/填寫/前往` 返回 `step-unparsed`）。

- [ ] **Step 3: Implement `splitStepLines`**

在 `src/web/excel.ts` 增加：

```ts
const STEP_LINE = /^\s*(?:\d{1,4}\s*(?:[.)、）]|．(?!\d))|[-•*]\s+)\s*/;

export function splitStepLines(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (out.length === 0 || STEP_LINE.test(line)) out.push(line);
    else out[out.length - 1] = `${out[out.length - 1]} ${line}`;
  }
  return out;
}
```

把 `parseExcel` 的 `steps: splitLines(rawSteps)` 改为 `steps: splitStepLines(rawSteps)`；`preconditions` 保持 `splitLines`。

- [ ] **Step 4: Extend Traditional verbs**

在 `src/web/script-gen.ts`：

- `TAP_VERB` 增加 `點一下|点一下|輕觸|轻触|輕按|轻按|按下|按一下|點按|点按|選取|选取`。
- `INPUT_VERB` 增加 `填寫|填写|鍵入|键入`。
- `VERIFY_VERB` 增加 `核對|核对|檢視|检视|瀏覽|浏览`。
- 导航正则 `^(进入|進入)` 增加 `前往|轉到|转到`。
- `stripStepNumber` 支持 `•`/`-`/`*` 列表前缀。

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:file -- test/web-excel.test.js test/web-script-gen.test.js`
Expected: PASS（含既有用例）。

- [ ] **Step 6: Commit**

```bash
git add src/web/excel.ts src/web/script-gen.ts test/web-excel.test.js test/web-script-gen.test.js
git commit -m "feat: merge excel step continuations and support traditional action verbs"
```

---

### Task 2: 英文动作解析与相对定位选择器

**Files:**
- Create: `src/web/step-types.ts`
- Create: `src/web/step-parse.ts`
- Modify: `src/web/script-gen.ts`（改为导入 parser；新增 selector YAML 输出；保留类型 re-export）
- Test: `test/web-script-gen.test.js`

**Interfaces:**
- Produces: `ParsedSelector { text: string; relation?: "rightOf" | "leftOf" | "below" | "above" }`
- Produces: `ParsedStep` 联合类型；`tap`/`input`/`verify` 使用 `ParsedSelector`。
- Produces: `parseStep(raw: string, context: StepParseContext): ParsedStep`：

```ts
export interface StepParseContext {
  inferNavigationTap?: boolean;
  getLastLabel: () => string | null;
  setLastLabel: (value: string) => void;
  pushWarning: (warning: string) => void;
}
```

- Consumes: Task 1 的繁体词表；`ScriptGenUnresolvedCode` 从 `step-types.ts` 导出，`script-gen.ts` 继续 re-export 保持兼容。

- [ ] **Step 1: Write the failing tests**

在 `test/web-script-gen.test.js` 增加：

```js
test("script-gen: 英文 go to / tap / input", () => {
  const result = gen(
    {
      steps: [
        "1. Go to Register page",
        '2. Tap the "OK" button',
        "3. Input invalid referral code (A random code)",
        '4. Tap the "submit" button'
      ],
      expected: '2. Display pop-up message box\n3. Display "Referral code does not exist"'
    },
    { inferNavigationTap: true }
  );
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- tapOn: 'Register'/);
  assert.match(result.yaml, /- tapOn: 'OK'/);
  assert.match(result.yaml, /- tapOn: 'referral code'\n- inputText: 'AOSINVALID0001'/);
  assert.ok(result.warnings.includes("input-value-generated"));
});

test("script-gen: 英文 next to 生成 rightOf", () => {
  const result = gen(
    {
      steps: ["1. Go to Register page", '2. Tap the information button next to "Referral Code"'],
      expected: '2. Display "Referral Code"'
    },
    { inferNavigationTap: true }
  );
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- tapOn:\n      rightOf: 'Referral Code'/);
  assert.ok(result.warnings.includes("relation-inferred:rightOf"));
});

test("script-gen: 英文 e.g. 输入值取箭头后的示例", () => {
  const result = gen({
    steps: [
      "1. Go to Register page",
      "2. Input incorrect referral code (A code with wrong upper & lower case e.g A23b8C --> a23B8c)"
    ],
    expected: '2. Display "Referral code does not exist"'
  }, { inferNavigationTap: true });
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- tapOn: 'referral code'\n- inputText: 'a23B8c'/);
  assert.ok(result.warnings.includes("input-value-example"));
});

test("script-gen: 英文 check 是 verify，不生成 tap", () => {
  const result = gen(
    {
      steps: ["1. Go to My rewards", "2. Check the coupons in My rewards"],
      expected: '2. Display "Referral coupon" and "Free coupon"'
    },
    { inferNavigationTap: true }
  );
  assert.equal(result.status, "ready");
  assert.doesNotMatch(result.yaml, /tapOn: 'coupons'/);
  assert.match(result.yaml, /assertVisible: 'Referral coupon'/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-script-gen.test.js`
Expected: FAIL（英文步骤返回 `step-unparsed`；无 `rightOf` 输出）。

- [ ] **Step 3: Create `step-types.ts` and move parser**

把 `ParsedStep`、`PreconditionMode`、`ScriptGenUnresolvedCode` 及 selector 类型移到 `src/web/step-types.ts`。`step-parse.ts` 实现：

- `stripStepNumber`、`splitClauses`、`quotedMatches`、`extractQuoted`、`isConcreteLabel`、`isSymbolLabel`、`parseInput`、`parseStep` 从 `script-gen.ts` 迁入。
- 英文词表：

```ts
const EN_TAP = /\b(?:tap|click|press|select|choose|hit|touch)\b/i;
const EN_INPUT = /\b(?:input|enter|type|fill(?:\s+in)?|set)\b/i;
const EN_VERIFY = /^(?:verify|check|ensure|confirm|validate|see|find|observe|look\s+for)\b/i;
const EN_NAV = /^(?:go\s+to|navigate\s+to|open|visit|switch\s+to)\b/i;
const EN_SCROLL = /\b(?:scroll|swipe)\b/i;
const EN_BACK = /^(?:back|go\s+back|return)\b/i;
const EN_WAIT = /^(?:wait|pause)\b/i;
const EN_LAUNCH = /^(?:launch|start|open)\s+(?:the\s+)?app\b/i;
```

- 英文 target 解析：优先引号；`next to|beside` → `rightOf` + `pushWarning("relation-inferred:rightOf")`；`right of|left of|below|above|under` 映射对应关系。
- 英文 input：字段取 `in|into|on|at` 前/后的引号或短语；值取第二个引号、`with|as|to` 后文本、或括号内示例；`(A random code)` → `AOSINVALID0001` + `pushWarning("input-value-generated")`；`e.g A --> B` → `B` + `pushWarning("input-value-example")`。
- `go to X page` / `navigate to X`：`inferNavigationTap` 为 true 时生成 `tap` selector `X`，否则 `navigation-unparsed`。
- `check/verify ...`：`verify`，不生成动作；引号目标设置 last label。
- `complete TC_XX`：返回 `unsupported`，code 用 `step-unparsed`，detail `depends-on:TC_XX`。

- [ ] **Step 4: Wire `script-gen.ts` to the new parser**

- 删除 `script-gen.ts` 内已迁走的 parser 常量/函数，改为 `import { parseStep } from "./step-parse.js";`。
- 从 `step-types.ts` re-export `ParsedStep`、`ParsedSelector`、`ScriptGenUnresolvedCode`、`PreconditionMode`。
- 生成循环使用 `ParsedStep` 的 `selector`；新增：

```ts
function selectorLines(selector: ParsedSelector): string[] {
  if (selector.relation === undefined) return [`- tapOn: ${yamlScalar(escapeRegExp(selector.text))}`];
  return ["- tapOn:", `    ${selector.relation}: ${yamlScalar(escapeRegExp(selector.text))}`];
}
```

- `input` 输出 `selectorLines(field)` + `- inputText: ...`。
- `verify` 不输出动作。
- `scrollTo` 使用 selector 的 relation 输出 `scrollUntilVisible` 的 `text`；relation 不支持时按 `step-unparsed` 处理（生成 warning）。

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:file -- test/web-script-gen.test.js`
Expected: PASS（含 Task 1 用例与既有用例）。

- [ ] **Step 6: Commit**

```bash
git add src/web/step-types.ts src/web/step-parse.ts src/web/script-gen.ts test/web-script-gen.test.js
git commit -m "feat: parse english manual steps and relational selectors"
```

---

### Task 3: 尽力生成、runner 上报与“不假绿”门禁

**Files:**
- Modify: `src/web/script-gen.ts`
- Modify: `src/web/script-set.ts`
- Modify: `src/runner/web-executors.ts`
- Modify: `src/web/results.ts`
- Modify: `src/web/verdicts.ts`
- Modify: `src/runner/web-job-runner.ts`（结果 payload 带 `manualSteps`）
- Test: `test/web-script-gen.test.js`, `test/web-script-set.test.js`, `test/web-executors.test.js`, `test/web-result-ingest.test.js`, `test/web-verdicts.test.js`

**Interfaces:**
- Produces: `ScriptGenOptions.bestEffort?: boolean`
- Produces: `ScriptGenResult.manualSteps: Array<{ step: number; code: ScriptGenUnresolvedCode; detail: string }>`、`ScriptGenResult.partial: boolean`
- Produces: `GenerateScriptSetResult.partial: number`、`runnable: number`
- Produces: `ScriptSetBundle.partial: number`、`runnable: number`；manifest `counts` 增加 `partial`/`runnable`，`cases[]` 增加 `partial`/`manualSteps`。
- Produces: `WebJobExecutionCase.manualSteps?: Array<{ step: number; reason: string }>`
- Produces: `parseFlowManualSteps(content: string): Array<{ step: number; reason: string }>`（从 `web-executors.ts` 导出）
- Produces: `WebResultCase.manualSteps?: Array<{ step: number; reason: string }>`；`deriveCaseVerdicts` 对带 manual 的 PASS 降级 `UNVERIFIED`，reason `manual-step`。

- [ ] **Step 1: Write the failing tests**

`test/web-script-gen.test.js`：

```js
test("script-gen: bestEffort 未映射步骤不阻断整条用例", () => {
  const result = gen(
    {
      steps: ["1. Go to Register page", "2. Fill in other required fields"],
      expected: "页面显示“成功”"
    },
    { bestEffort: true, inferNavigationTap: true }
  );
  assert.equal(result.status, "ready");
  assert.equal(result.partial, true);
  assert.equal(result.manualSteps.length, 1);
  assert.equal(result.manualSteps[0].step, 2);
  assert.match(result.yaml, /# aos:manual step=2/);
  assert.match(result.yaml, /- takeScreenshot: 'aos-TC-1-step-2'/);
});

test("script-gen: bestEffort 全部未映射仍生成可运行 launch+screenshot flow", () => {
  const result = gen(
    { steps: ["1. Do the needful"], expected: null },
    { bestEffort: true }
  );
  assert.equal(result.status, "ready");
  assert.equal(result.partial, true);
  assert.match(result.yaml, /- launchApp:/);
  assert.match(result.yaml, /# aos:manual step=1/);
});
```

`test/web-script-set.test.js`：构造 `ready=0, partial=1, runnable=1` 的 bundle，断言 `storeScriptSet` 成功；`runnable=0` 时仍抛 `script-set-unusable`。

`test/web-executors.test.js`：flow 含 `# aos:manual step=2 reason=step-unparsed`，断言 `executeWebJob` 返回 case 的 `manualSteps`。

`test/web-result-ingest.test.js`：runner 上报 `PASS` + `manualSteps:[{step:2,reason:"step-unparsed"}]`，断言中心落库 `UNVERIFIED`，Excel 写 `UNVERIFIED`，gate `partial`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-script-gen.test.js test/web-script-set.test.js test/web-executors.test.js test/web-result-ingest.test.js`
Expected: FAIL（`bestEffort` 未识别；manual 字段未上报/未降级）。

- [ ] **Step 3: Implement best-effort generation**

`generateFlow`：

- 当 `parsed.kind === "unsupported"` 且 `bestEffort === true`：
  - push `manualSteps`；
  - push warning `step-manual:${stepNumber}:${parsed.code}`；
  - 追加：

```yaml
# aos:manual step=2 reason=step-unparsed
# aos:manual-text Fill in other required fields
- takeScreenshot: 'aos-TC-1-step-2'
```

- 截图名：`aos-${caseId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}-step-${stepNumber}`。
- `status = unresolved.length === 0 ? "ready" : "unresolved"`；`partial = manualSteps.length > 0`。
- `bestEffort !== true` 时保持现有行为。
- `bestEffort === true` 时，`assertion-step-out-of-range` 与 `assertion-text-invalid` 改为 warning + 跳过该断言，不把整条用例置为 unresolved；strict 不变。

`generateScriptSet`：统计 `ready`（无 manual 的 ready）、`partial`（有 manual 的 ready）、`unresolved`、`runnable = ready + partial`。

`script-set.ts`：manifest/bundle 增加 counts 与 case 字段；`storeScriptSet` 的 `ready === 0` 判断改为 `(input.bundle.runnable ?? input.bundle.ready) === 0`（兼容旧 bundle）；错误文案列出 `partial`。

- [ ] **Step 4: Implement runner manual markers + center downgrade**

`web-executors.ts`：

```ts
const MANUAL_LINE = /^\s*#\s*aos:manual\s+step=(\d+)\s+reason=([^\n]*)$/gm;
export function parseFlowManualSteps(content: string): Array<{ step: number; reason: string }> {
  const out: Array<{ step: number; reason: string }> = [];
  for (const match of content.matchAll(MANUAL_LINE)) {
    const step = Number(match[1]);
    if (!Number.isInteger(step) || step < 1 || out.length >= 200) continue;
    out.push({ step, reason: (match[2] ?? "").trim().slice(0, 200) });
  }
  return out;
}
```

- 在 `collectFlowAssertions` 返回 `manualSteps`（顶层 flow + `runFlow` 子流程去重）。
- 在 `executeWebJob` 设置 `entry.manualSteps`。
- `web-job-runner.ts` 的 `executedPayload` 增加 `...(entry.manualSteps === undefined ? {} : { manualSteps: entry.manualSteps })`，否则中心看不到 manual 标记。

`results.ts`：

- `WebResultCase` 增加 `manualSteps`；`parseCase` 解析（最多 200 条，step 正整数，reason ≤200）。
- `deriveCaseVerdicts` 在断言门禁前：若 `entry.status === "PASS"` 且 `manualSteps.length > 0`，降级 `UNVERIFIED`，`failureReason: "未验证：包含 N 个未映射/手工步骤"`，并追加 warning。
- `assertionGate` 不直接改；降级在 `deriveCaseVerdicts`。

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:file -- test/web-script-gen.test.js test/web-script-set.test.js test/web-executors.test.js test/web-result-ingest.test.js test/web-verdicts.test.js`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/web/script-gen.ts src/web/script-set.ts src/runner/web-executors.ts src/web/results.ts src/web/verdicts.ts test/web-script-gen.test.js test/web-script-set.test.js test/web-executors.test.js test/web-result-ingest.test.js test/web-verdicts.test.js
git commit -m "feat: best-effort manual excel flows without fake pass"
```

---

### Task 4: 受控 LLM 步骤规范化

**Files:**
- Create: `src/web/step-normalizer.ts`
- Modify: `src/web/script-gen.ts`（`normalizedSteps` 输入与编译）
- Modify: `src/web/script-generation.ts`（调用 normalizer）
- Modify: `src/web/script-set.ts`（manifest 记录 normalizer）
- Test: `test/web-step-normalizer.test.js`, `test/web-script-generation.test.js`

**Interfaces:**
- Produces:

```ts
export type NormalizedSelector = {
  text: string;
  relation?: "rightOf" | "leftOf" | "below" | "above";
};
export type NormalizedAction =
  | { type: "launch" }
  | { type: "tap"; target: NormalizedSelector }
  | { type: "input"; target: NormalizedSelector; value: string }
  | { type: "verify"; target?: NormalizedSelector }
  | { type: "scroll"; direction?: "UP" | "DOWN" }
  | { type: "back" }
  | { type: "wait" }
  | { type: "manual"; reason: string };
export interface NormalizedStep {
  step: number;
  actions: NormalizedAction[];
  confidence: "high" | "medium" | "low";
  note?: string;
}
export interface NormalizeCaseInput {
  caseId: string;
  name: string;
  steps: string[];
  expected: string | null;
  preconditions: string[];
  platform: "android" | "ios";
  appId: string;
}
export interface StepNormalizer {
  normalize(input: NormalizeCaseInput, signal?: AbortSignal): Promise<NormalizedStep[] | null>;
}
export function createLlmStepNormalizer(options: {
  chat: ChatFn;
  model: string;
  timeoutMs?: number;
}): StepNormalizer;
```

- Consumes: `ChatFn` from `src/llm/chat.ts`；Task 2 的 `ParsedSelector` 语义。
- Produces: `ScriptGenCaseInput.normalizedSteps?: NormalizedStep[]`；`generateFlow` 优先使用它，缺失时回退原始步骤解析。
- Produces: `GenerateScriptSetInput.normalizer?: StepNormalizer`；`ScriptSetBundleInput.normalizer?: "llm" | "rules"`、`llmCases?: number`；manifest 记录同名可选字段。

- [ ] **Step 1: Write the failing tests**

`test/web-step-normalizer.test.js`：

```js
test("step-normalizer: 有效 JSON 生成受控动作", async () => {
  const normalizer = createLlmStepNormalizer({
    model: "fake",
    chat: async () => JSON.stringify({
      steps: [
        { step: 1, actions: [{ type: "tap", target: { text: "Referral Code", relation: "rightOf" } }], confidence: "high" },
        { step: 2, actions: [{ type: "verify" }], confidence: "high" }
      ]
    })
  });
  const result = await normalizer.normalize({
    caseId: "TC-1",
    name: "Information",
    steps: ['1. Tap the information button next to "Referral Code"', "2. Verify popup"],
    expected: '2. Display "Referral Code"',
    preconditions: [],
    platform: "android",
    appId: "com.example.app"
  });
  assert.deepEqual(result[0].actions[0], { type: "tap", target: { text: "Referral Code", relation: "rightOf" } });
});

test("step-normalizer: 模型发明标签时拒绝并回退 null", async () => {
  const normalizer = createLlmStepNormalizer({
    model: "fake",
    chat: async () => JSON.stringify({
      steps: [{ step: 1, actions: [{ type: "tap", target: { text: "Invented Button" } }], confidence: "high" }]
    })
  });
  const result = await normalizer.normalize({ /* 原文没有 Invented Button */ });
  assert.equal(result, null);
});

test("step-normalizer: chat 抛错/非法 JSON 返回 null", async () => {
  const throwing = createLlmStepNormalizer({ model: "fake", chat: async () => { throw new Error("boom"); } });
  assert.equal(await throwing.normalize(input), null);
  const bad = createLlmStepNormalizer({ model: "fake", chat: async () => "not json" });
  assert.equal(await bad.normalize(input), null);
});
```

`test/web-script-generation.test.js`：注入 fake normalizer，断言生成的 YAML 使用 normalized 的 `rightOf`/input，且 manifest `normalizer:"llm"`、`llmCases:1`；fake normalizer 抛错时回退规则并记 `llm-normalize-failed` warning。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-step-normalizer.test.js test/web-script-generation.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Implement `step-normalizer.ts`**

- Prompt 规则：
  - 输入可能是简体、繁体或英文；输出保留原文标签，不翻译。
  - 只允许 `launch/tap/input/verify/scroll/back/wait/manual`。
  - `target.text` 必须出现在该用例的 `steps/name/expected` 原文中，或属于系统标签白名单（`OK/Cancel/Submit/Back/Next/Done/Save/Close/Yes/No` 及简繁对应词）。
  - `next to` → `relation:"rightOf"`；`right of/left of/below/above/under` 映射对应关系。
  - 输入值必须来自原文；`A random code` 允许生成 `AOSINVALID0001` 并在 `note` 说明。
  - `Complete TC_XX` → `manual` + `reason:"depends-on:TC_XX"`。
  - 不确定 → `manual`，不要猜。
  - 只输出 JSON 对象 `{steps:[...]}`，不要 Markdown/YAML/命令。
- `createLlmStepNormalizer`：调用 `chat([{role:"system"...},{role:"user"...}], signal)`；超时默认 30s（`AbortController`）；解析 JSON（剥离 code fence、取第一个 `{` 到最后一个 `}`）；校验；失败返回 `null`。
- 校验函数导出 `validateNormalizedSteps(raw, input): NormalizedStep[] | null`，测试直接覆盖。

- [ ] **Step 4: Integrate normalized steps into generation**

`script-gen.ts`：

- `ScriptGenCaseInput` 增加 `normalizedSteps?: NormalizedStep[]`。
- 主循环按步骤号取 `normalizedSteps`；存在时用 `compileNormalizedActions`，否则 `parseStep`。
- 多条 action 按顺序输出；`manual` 在 bestEffort 下写 manual marker，在 strict 下记 unresolved `step-unparsed`。
- `verify` 只作为断言落点；`tap`/`input` 复用 Task 2 的 selector YAML。

`script-generation.ts`：

- `GenerateScriptSetInput` 增加 `normalizer?: StepNormalizer`、`bestEffort?`（`preconditionMode:"auto"` 由 Task 5 加入）。
- 对每个 case 调 `normalizer.normalize`（并发上限 4；单例失败不影响其他）；失败记 `llm-normalize-failed:<caseId>`，回退原始步骤。
- 传 `normalizedSteps` 给 `buildScriptSetBundle`；manifest 写 `normalizer`/`llmCases`。

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:file -- test/web-step-normalizer.test.js test/web-script-generation.test.js test/web-script-gen.test.js`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/web/step-normalizer.ts src/web/script-gen.ts src/web/script-generation.ts src/web/script-set.ts test/web-step-normalizer.test.js test/web-script-generation.test.js
git commit -m "feat: controlled llm step normalization for manual excel"
```

---

### Task 5: 前置条件 auto 与面板/CLI 接线

**Files:**
- Modify: `src/web/script-generation.ts`（`preconditionMode:"auto"` 解析）
- Modify: `src/web/script-set.ts`（`bestEffort`/`auto` 写入 manifest）
- Modify: `src/panel/actions.ts`（解析 `bestEffort`/`useLlm`/`auto`；构造 normalizer）
- Modify: `src/console/pages.ts`（生成表单、结果表）
- Modify: `src/web-command.ts`（`--best-effort`、`--precondition-mode auto`、help）
- Test: `test/panel-script-gen.test.js`, `test/web-assets-ui.test.js`, `test/web-script-generation.test.js`

**Interfaces:**
- Consumes: Task 3/4 的 `bestEffort`、`StepNormalizer`。
- Produces: panel 请求字段 `bestEffort?: boolean`、`useLlm?: "auto" | "off" | "require"`、`preconditionMode?: "auto"`。
- Produces: 响应字段 `partial`, `runnable`, `normalizer: "llm" | "rules"`, `llmCases`, `llmModel`。
- Produces: `auto` 的解析规则：`bestEffort === true` → `assume-prepared`；否则 `strict`；manifest 记录解析后的模式。

- [ ] **Step 1: Write the failing tests**

`test/panel-script-gen.test.js`：

```js
test("panel script-gen: bestEffort + auto 前置条件 + 规则回退", async () => {
  // Excel 含 "Fill in other required fields" 与前置条件 "CMS: active"
  // 请求 { bestEffort: true, preconditionMode: "auto", useLlm: "off", dryRun: true }
  // 断言 200、runnable=1、partial=1、manifest.preconditionMode="assume-prepared"
  // manifest.cases[0].manualSteps[0].code === "step-unparsed"
});
```

`test/web-assets-ui.test.js`：HTML 含 `script-gen-best-effort`（默认 checked）、`script-gen-llm`、`<option value="auto">`、结果表头「手工步骤」，且 helper 文案说明「部分执行不会假绿」。

`test/web-script-generation.test.js`：`preconditionMode:"auto"` + `bestEffort:true` 生成 `clearState:false`；`auto` + bestEffort false 仍 strict。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/panel-script-gen.test.js test/web-assets-ui.test.js test/web-script-generation.test.js`
Expected: FAIL（字段/选项不存在）。

- [ ] **Step 3: Implement precondition auto**

在 `buildScriptSetBundle` 解析：

```ts
const preconditionMode =
  input.preconditionMode === "auto"
    ? input.bestEffort === true
      ? "assume-prepared"
      : "strict"
    : input.preconditionMode ?? "strict";
```

`ScriptSetManifest.preconditionMode` 记录解析后的值，不记录 `auto`。

- [ ] **Step 4: Wire panel action**

`generateScriptSetAction`：

- `bestEffort = payload.bestEffort === true || payload.bestEffort === "true"`。
- `useLlm`: `auto`（默认）/`off`/`require`；非法 400。
- `preconditionMode`: `auto`/`strict`/`assume-prepared`。
- normalizer 解析：

```ts
async function resolveNormalizer(rootPath, useLlm) {
  if (useLlm === "off") return { normalizer: null, model: null };
  const runtime = deps.runtimeFor ? await deps.runtimeFor(rootPath) : null;
  const entry = runtime ? await runtime.activeEntry() : null;
  if (!entry || !entry.baseUrl || !entry.apiKey || !entry.model) {
    if (useLlm === "require") throw new ScriptGenerationError("llm-not-configured", "未配置可用 LLM；可切到规则解析");
    return { normalizer: null, model: null };
  }
  return {
    normalizer: createLlmStepNormalizer({
      chat: makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model }, { temperature: 0 }),
      model: entry.model
    }),
    model: entry.model
  };
}
```

- 传 `bestEffort`、`normalizer`、`preconditionMode`、`inferNavigationTap: bestEffort`。
- 响应加 `partial`/`runnable`/`normalizer`/`llmCases`/`llmModel`。
- 错误映射：`llm-not-configured` → 400。
- 审计 summary 加 `partial`/`runnable` 与 `normalizer`。

- [ ] **Step 5: Update panel HTML**

`src/console/pages.ts` 生成表单：

- `script-gen-best-effort` 复选框，默认 `checked`，文案「尽力生成（未识别步骤标 UNVERIFIED，不阻断）」。
- `script-gen-mode` 增加 `<option value="auto" selected>auto（手工文档按环境已准备）</option>`。
- `script-gen-llm` 增加 `auto/off/require`，默认 `auto`；文案「AI 解析（有 LLM 时自动启用）」。
- Helper 文案改为：

> 手工 Excel 默认尽力生成：识别不了的步骤会标 UNVERIFIED 并截图，不阻断其他步骤；不会伪造 PASS。前置条件 auto 在尽力模式下按测试环境已准备处理，并在 manifest/结果标注。

- JS 请求体加 `bestEffort`、`useLlm`；结果状态文案显示 `可执行 X（完整 Y / 部分 Z）/ 未就绪 N`；表格列加「手工步骤」，显示 `code:step`。

- [ ] **Step 6: Update CLI**

`src/web-command.ts`：

- `--best-effort` 传给 `generateScriptSetForProject`。
- `--precondition-mode auto` 允许（`parsePreconditionMode` 接受 `auto`）。
- Help 增加两行说明。
- 成功输出 summary 加 `runnable/partial`。

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test:file -- test/panel-script-gen.test.js test/web-assets-ui.test.js test/web-script-generation.test.js`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/web/script-generation.ts src/web/script-set.ts src/panel/actions.ts src/console/pages.ts src/web-command.ts test/panel-script-gen.test.js test/web-assets-ui.test.js test/web-script-generation.test.js
git commit -m "feat: best-effort manual excel generation in panel and cli"
```

---

### Task 6: 文档、全量验证与真实样本验收

**Files:**
- Modify: `DESIGN.md`（新增 §13.295）
- Modify: `README.md`（网页测试用法）
- Modify: `docs/superpowers/specs/2026-10-29-maestro-assertion-generation-rationale.md`（把 2B 的“仅 LLM 执行”边界更新为“LLM 规范化 + 尽力生成已落地”）
- Test: 全量 `npm test`

**Interfaces:**
- 无新代码接口；记录 Task 1–5 的行为契约。

- [ ] **Step 1: Update DESIGN.md**

新增 `### 13.295 新增（Web 手工 Excel：简繁英解析、尽力生成与 LLM 规范化）`，至少包含：

- 根因：旧生成器 all-or-nothing，未识别一步整条用例 unresolved；`splitLines` 把续行当步骤。
- `splitStepLines` 续行合并规则。
- 简/繁/英动作词表与 `rightOf/leftOf/below/above` 相对定位。
- `bestEffort` 语义：`ready`/`partial`/`unresolved`/`runnable`；manual marker + screenshot；`storeScriptSet` 用 `runnable` 判断。
- runner 上报 `manualSteps`；中心降级 PASS→UNVERIFIED（reason `manual-step`）；PASS 口径不变。
- LLM 规范化：受控 JSON AST、标签原文校验、失败回退规则、`normalizer/llmCases` 审计；模型不直接写 YAML。
- `preconditionMode:"auto"`：bestEffort 下 assume-prepared，否则 strict。
- 边界：不实现设备上的 LLM 观察执行器/发现；manual 步骤仍需人工或后续 agent。

- [ ] **Step 2: Update README.md**

在网页测试/测试资产章节补充：

- 手工 Excel 支持简体/繁体/英文；默认「尽力生成」。
- 「部分」用例会执行已识别步骤，未识别步骤标 `UNVERIFIED`，不会假绿。
- 配置项目 active LLM 后自动启用 AI 规范化；无 LLM 仍可用规则生成。
- CLI 示例：`web scripts generate ... --best-effort --precondition-mode auto --dry-run --json`。

- [ ] **Step 3: Run targeted tests**

Run:

```bash
npm run build
node --test test/web-script-gen.test.js test/web-script-set.test.js test/web-step-normalizer.test.js test/web-script-generation.test.js test/web-executors.test.js test/web-result-ingest.test.js test/web-verdicts.test.js test/panel-script-gen.test.js test/web-assets-ui.test.js
```

Expected: all PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run build && npm test && npm run lint
```

Expected: build 成功；全量测试 0 fail（数量 ≥ 2979 + 新增）；lint 0 error（允许既有 2 条 warning）。

- [ ] **Step 5: Real GU sample dry-run (manual acceptance)**

用当前 ESSO-GU 的 Excel/package 资产调用面板 dry-run：

```bash
# 从项目 ledger 读取 excel/package assetId 后：
curl -sS -u "panel:<token>" \
  -H 'Content-Type: application/json' -H 'X-AOS-Console: 1' \
  -d '{"project":"/Users/louis/Documents/AOS/ESSO-GU","excelAssetId":"<id>","packageAssetId":"<id>","platform":"android","appId":"com.exxonmobil.mobil.gusp.uat","preconditionMode":"auto","bestEffort":true,"useLlm":"auto","dryRun":true}' \
  http://127.0.0.1:8765/panel/api/projects/scripts/generate
```

Expected:

- HTTP 200（不再 409）；
- `runnable=20`、`unresolved=0`；
- `partial>0`，manifest cases 有 `manualSteps`；
- `normalizer="rules"`（ESSO-GU 无 active LLM）或 `"llm"`（配置后）；
- 逐例能看到 `Go to Register page`、`Tap the information button...` 等步骤的处理结果。

- [ ] **Step 6: Commit**

```bash
git add DESIGN.md README.md docs/superpowers/specs/2026-10-29-maestro-assertion-generation-rationale.md
git commit -m "docs: document manual excel parsing and best-effort web tests"
```
