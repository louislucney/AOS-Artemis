# 设计稿分块阅读（design_reading）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `design_to_test` 内部增加“分块读取设计稿 → 合并交互链/CR 主线 → 输出问题清单”的阶段；用户仍然只调用一个入口，不新增命令。

**Architecture:** 3 屏一块、1 屏重叠；每块用多模态 ChatFn 读取原图，输出严格 JSON（观察/推断/待确认）；合并成 `reading.json` 与 `reading.md`，并把摘要/问题放进 `design_to_test` 响应。阅读阶段只读报告，不改变现有生成器与硬门禁。

**Tech Stack:** TypeScript ESM + NodeNext + strict；Node 内置 `node:test`；现有 `ChatFn` / `makeChatFn`、`isVisionCapableModel`、`writeFileAtomic`；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-26-design-reading-design.md`

## Global Constraints

- 不新增 MCP 工具、不新增 CLI 命令；唯一用户入口是 `design_to_test`。
- `reading` 默认 `"auto"`：屏幕数 ≥ 6 且视觉可用时触发；`false` 关闭；`true` 强制。
- 屏幕数 < 6 的 `auto` 路径必须**不加步骤、不加 warning**，保持现有 `design_to_test` 响应与测试稳定。
- 阅读失败/视觉不可用不得让 `design_to_test` 失败；只加 warning/`reading.status:"skipped"`。
- 视觉阅读产生的交互边一律 `vision-inferred`；只有原型边/人工确认可 `explicit`/`human-confirmed`。
- 不写 flows/tests；只写 `.artemis/design/reading/`。
- 测试不依赖真实 LLM/网络/设备/PG；全部用 fake `ChatFn` 与临时目录。
- 用户可见文案中文；代码标识符英文；相对导入带 `.js`。
- 完工前：`npm run build && npm test && npm run lint` 全绿。

## Review Focus

- 多图被 provider 拒绝：3 屏 → 2 屏 → 1 屏，块会计仍正确，不把失败块算成成功。
- 屏幕框内有 `Flow/Header`/状态栏/备注：不得把 chrome 当应用 UI；控件清单允许 `chrome`。
- 搜索按钮/无文字图标：prompt 强制清单；parser 保留 `search`；若标注/旁注出现「搜尋/搜索」但 header 无 `search`，merge 生成 question（测试）。
- 连接线起点不明：必须 `unconfirmed` + question；不得凭旁注文字直接生成目标页。
- 块级缓存：改一屏只重跑相关块；切换模型/参数必须失效；降级结果不能用全量计划哈希复用。
- `design_to_test` 原有 2/3 屏路径：不新增 step、不改变 `nextAction`/`steps` 断言。
- 稠密原型图（每屏互连）：spine 最长路径必须有访问预算，不能同步阻塞运行时。
- 视觉守卫必须走 `resolveVisionCapability`（声明/缓存/启发式/unknown），不能只看模型名。

---

### Task 1: 阅读类型、分块与产物路径

**Files:**
- Create: `src/design/reading/types.ts`
- Create: `src/design/reading/chunk.ts`
- Create: `src/design/reading/store.ts`
- Test: `test/design-reading.test.js`

**Interfaces:**
- Consumes: `FlowEdge`, `FlowElement`, `FlowWarning` from `src/figma/flows.js`; `writeFileAtomic` from `src/util.js`.
- Produces:
  - `ReadingStatus = "observed" | "inferred" | "unconfirmed"`
  - `ReadingScreenRef { id; name; order; imagePath: string | null }`
  - `ReadingChunkPlan { chunkId; screens: ReadingScreenRef[]; boundaryBefore: string | null; boundaryAfter: string | null; knownEdges: FlowEdge[] }`
  - `ReadingChunk { chunkId; plannedScreenIds: string[]; screenIds: string[]; screens: ...; interactions: ...; questions: ...; droppedScreens: string[]; unreadScreens: string[]; calls: number }`
  - `chunkReadingScreens(screens: ReadingScreenRef[], options: { chunkSize?: number; overlap?: number; maxScreens?: number }): { plans: ReadingChunkPlan[]; truncated: number; truncatedScreens: string[] }`
  - `readingPaths(configDirAbs: string): { root; chunksDir; json; markdown }`（MVP 无 cropsDir）
  - `readingChunkHash(input: { screenIds: string[]; imageSha256: string[]; knownEdges: FlowEdge[]; options: object; promptVersion: number; model: string }): string`（model 必须是解析后的模型 ID；edges canonical 序列化）
  - `readCachedChunk(root: string, hash: string): ReadingChunk | null`
  - `writeReadingChunk(root: string, chunk: ReadingChunk): string`

- [ ] **Step 1: Write the failing tests**

在 `test/design-reading.test.js` 覆盖：

```js
test("chunk: 7 屏 → [1,2,3] [3,4,5] [5,6,7]，最后不足 2 屏并入前块", () => {
  const screens = Array.from({ length: 7 }, (_, index) => ({
    id: `s${index + 1}`,
    name: `Screen ${index + 1}`,
    order: index,
    imagePath: null
  }));
  const { plans } = chunkReadingScreens(screens, { chunkSize: 3, overlap: 1 });
  assert.deepEqual(plans.map((plan) => plan.screens.map((screen) => screen.id)), [
    ["s1", "s2", "s3"],
    ["s3", "s4", "s5"],
    ["s5", "s6", "s7"]
  ]);
});

test("chunk: maxScreens 显式截断并返回 truncated；断言去重", () => {
  const screens = Array.from({ length: 9 }, (_, index) => ({ id: `s${index + 1}`, name: `S${index + 1}`, order: index, imagePath: null }));
  const result = chunkReadingScreens(screens, { chunkSize: 3, overlap: 1, maxScreens: 4 });
  assert.equal(result.truncated, 5);
  assert.deepEqual(result.truncatedScreens, ["s5", "s6", "s7", "s8", "s9"]);
  assert.deepEqual([...new Set(result.plans.flatMap((plan) => plan.screens.map((screen) => screen.id)))], ["s1", "s2", "s3", "s4"]);
});

test("chunk: 6..10 屏的分块数表", () => {
  const counts = {};
  for (let n = 6; n <= 10; n += 1) {
    const screens = Array.from({ length: n }, (_, index) => ({ id: `s${index + 1}`, name: `S${index + 1}`, order: index, imagePath: null }));
    counts[n] = chunkReadingScreens(screens, { chunkSize: 3, overlap: 1 }).plans.length;
  }
  assert.deepEqual(counts, { 6: 3, 7: 3, 8: 4, 9: 4, 10: 5 });
});

test("store: chunk hash 对图片/参数/模型敏感", () => {
  const base = { imageSha256: ["a"], knownEdges: [], options: { chunkSize: 3, overlap: 1 }, promptVersion: 1, model: "m1" };
  assert.equal(readingChunkHash(base), readingChunkHash({ ...base }));
  assert.notEqual(readingChunkHash(base), readingChunkHash({ ...base, imageSha256: ["b"] }));
  assert.notEqual(readingChunkHash(base), readingChunkHash({ ...base, model: "m2" }));
  assert.notEqual(readingChunkHash(base), readingChunkHash({ ...base, knownEdges: [{ from: { id: "s1", name: "S1" }, to: { id: "s2", name: "S2" }, element: { id: "e", name: "E", type: "T" }, textHints: [], trigger: "ON_CLICK", actionType: "NAVIGATE" }] }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/design-reading.test.js`
Expected: FAIL because `dist/design/reading/*` does not exist.

- [ ] **Step 3: Implement types, chunker, store**

`types.ts` 定义上述类型，并补齐 `ReadingControl`、`ReadingQuestion`、`ReadingChunk`、`ReadingFile`（字段按设计稿 §6/§7/§8）。`chunk.ts` 用 `step = Math.max(1, chunkSize - overlap)`；最后一块 `< 2` 屏时并入前一块；`maxScreens` 截断返回 `truncated` + `truncatedScreens`；`ReadingChunk` 同时保留 `plannedScreenIds` 与实际 `screenIds`。`store.ts` 用 `createHash("sha256")`、`mkdirSync({recursive:true})`、`writeFileAtomic`；路径固定 `design/reading/{chunks}`；hash 对 `knownEdges` 做 canonical 键序序列化。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/design-reading.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/reading/types.ts src/design/reading/chunk.ts src/design/reading/store.ts test/design-reading.test.js
git commit -m "feat(design): add reading chunk types and store"
```

---

### Task 2: 阅读 Prompt、解析与校验

**Files:**
- Create: `src/design/reading/prompt.ts`
- Create: `src/design/reading/parse.ts`
- Modify: `test/design-reading.test.js`

**Interfaces:**
- Consumes: `ChatMessage` from `src/llm/chat.js`; `ReadingChunkPlan` from `./chunk.js`; `ReadingChunk`/`ReadingQuestion` from `./types.js`.
- Produces:
  - `READING_PROMPT_VERSION = 1`
  - `buildReadingMessages(input: { plan: ReadingChunkPlan; images: Array<{ screenId: string; dataUrl: string }>; knownElements?: FlowElement[] }): ChatMessage[]`
  - `parseReadingReply(content: string, plan: ReadingChunkPlan): { chunk: ReadingChunk | null; invalid: number; warnings: FlowWarning[] }`

- [ ] **Step 1: Write the failing tests**

```js
test("prompt: 必含 headerControls/search 清单与三档状态", () => {
  const plan = { chunkId: "chunk-001", screens: [{ id: "s1", name: "行動預點", order: 0, imagePath: null }], boundaryBefore: null, boundaryAfter: null, knownEdges: [] };
  const messages = buildReadingMessages({ plan, images: [{ screenId: "s1", dataUrl: "data:image/png;base64,AA==" }] });
  const text = messages.map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("")).join("\n");
  assert.match(text, /headerControls/);
  assert.match(text, /search/);
  assert.match(text, /observed/);
  assert.match(text, /inferred/);
  assert.match(text, /unconfirmed/);
  assert.match(text, /不得省略/);
});

test("parse: 缺 headerControls 的屏幕整屏丢弃并 warning", () => {
  const plan = { chunkId: "chunk-001", screens: [{ id: "s1", name: "S1", order: 0, imagePath: null }], boundaryBefore: null, boundaryAfter: null, knownEdges: [] };
  const parsed = parseReadingReply(JSON.stringify({ screens: [{ screenId: "s1", name: "S1" }] }), plan);
  assert.equal(parsed.chunk?.screens.length, 0);
  assert.ok(parsed.warnings.some((warning) => warning.code === "reading-screen-invalid"));
});

test("parse: 空 headerControls 合法；chrome 标签出 warning", () => {
  const plan = { chunkId: "chunk-001", screens: [{ id: "s1", name: "S1", order: 0, imagePath: null }], boundaryBefore: null, boundaryAfter: null, knownEdges: [] };
  const reply = { screens: [{ screenId: "s1", name: "S1", observed: { title: "Flow/Header", headerControls: [], persistentNav: { sideNav: [], bottomTabs: [], activeTab: null }, contentGroups: [], floatingActions: [], annotations: [] }, states: [], inferredInteractions: [] }] };
  const parsed = parseReadingReply(JSON.stringify(reply), plan);
  assert.equal(parsed.chunk.screens.length, 1, "空数组合法");
  assert.ok(parsed.warnings.some((warning) => warning.code === "chrome-suspect"));
});

test("parse: 搜索按钮保留为 search；unconfirmed 自动补 question", () => {
  const plan = { chunkId: "chunk-001", screens: [{ id: "s1", name: "行動預點", order: 0, imagePath: null }], boundaryBefore: null, boundaryAfter: null, knownEdges: [] };
  const reply = {
    screens: [{
      screenId: "s1",
      name: "行動預點",
      observed: {
        title: "推薦",
        headerControls: [{ kind: "search", label: null, bbox: { x: 0.8, y: 0.1, width: 0.1, height: 0.1 } }],
        persistentNav: { sideNav: ["飲料"], bottomTabs: ["首頁", "行動預點"], activeTab: "行動預點" },
        contentGroups: [{ label: "推薦", items: ["冰蘋果山茶花風味美式"] }],
        floatingActions: [],
        annotations: []
      },
      states: [],
      inferredInteractions: [{ element: "search", action: "tap", to: "product-search", basis: "icon+position", status: "inferred", confidence: 0.9, why: "顶部放大镜" }]
    }],
    crossScreenLinks: [{ fromScreenId: "s1", fromElement: "產品搜尋", toScreenId: null, toLabel: "產品搜尋", status: "unconfirmed", basis: "annotation-line", why: "线起点不明" }],
    questions: []
  };
  const parsed = parseReadingReply(JSON.stringify(reply), plan);
  assert.equal(parsed.chunk.screens[0].observed.headerControls[0].kind, "search");
  assert.ok(parsed.chunk.questions.some((question) => question.question.includes("產品搜尋")));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/design-reading.test.js`
Expected: FAIL because `buildReadingMessages`/`parseReadingReply` are missing.

- [ ] **Step 3: Implement prompt and parser**

Prompt 必须包含：`headerControls` 固定槽位（back/title/search/cart/other）、无文字图标必须输出、`Flow/Header` 视为 chrome、连接线单独 `annotations`、三档状态、`to:null` + question。Parser 用现有 JSON 提取思路；校验每屏必填数组；bbox 归一化并 clamp；非法条目不补全、记 warning；`unconfirmed` 无对应 question 时自动生成稳定 id。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/design-reading.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/reading/prompt.ts src/design/reading/parse.ts test/design-reading.test.js
git commit -m "feat(design): add reading prompt and parser"
```

---

### Task 3: 多图运行、合并、主线与 Markdown

**Files:**
- Create: `src/design/reading/run.ts`
- Create: `src/design/reading/merge.ts`
- Create: `src/design/reading/render.ts`
- Modify: `test/design-reading.test.js`

**Interfaces:**
- Consumes: `ChatFn` (`src/llm/chat.js`), `runtime.traceDir`? no — only `DesignRuntimeLike`/`Runtime` for `configDirAbs`; `FlowEdge`, `FlowElement`; `Chunk`/`Plan`.
- Produces:
  - `mergeReadingChunks(chunks: ReadingChunk[], input: { screens: ReadingScreenRef[]; knownEdges: FlowEdge[] }): ReadingFile`
  - `renderReadingMarkdown(reading: ReadingFile): string`
  - `runDesignReading(input: { runtime: Pick<Runtime,"configDirAbs">; flowsPath: string; screensDir?: string; options?: { chunkSize?: number; overlap?: number; maxScreens?: number; concurrency?: number; timeoutMs?: number }; model: string; chat?: ChatFn; imageFor?: (screenId: string) => string | null; reuse?: boolean; now?: () => Date }): Promise<DesignReadingResult>`
  - `DesignReadingResult { ok: boolean; status: "read"|"skipped"|"partial"; reason: string | null; reading: ReadingFile | null; artifacts: { json; markdown; chunksDir } | null; warnings: FlowWarning[]; stats: { chunksRequested; chunksProcessed; chunksReused; chunksFailed; calls; screens; screensRead; screensTotal; droppedScreens: string[]; truncatedScreens: string[]; observed; inferred; unconfirmed } }`

- [ ] **Step 1: Write the failing tests**

```js
test("merge: 同屏冲突保留两份 + question；observed 不被 inferred 覆盖", () => { /* 2 chunks，s1 两个 search bbox；断言 conflicts=1、questions 非空、observed 优先 */ });
test("merge: unconfirmed 边保留但不进入 observed；completeness 统计 orphan/unresolved", () => { /* 断言 completeness 字段 */ });
test("merge: 旁注含「產品搜尋」但 header 无 search → question", () => { /* 一条 annotation 文本含搜尋，headerControls 为空；断言 question 指向搜索入口 */ });
test("merge: toScreenId 不在全局屏集 → unconfirmed + question；plan 外 screenId 丢弃 + warning", () => { /* ... */ });
test("merge: overlap 同屏 title/headerControls 不一致 → question + overlapConflicts", () => { /* ... */ });
test("merge: spine 带 edgeIds/statusSummary；含 inferred 边时 markdown 标注", () => { /* ... */ });
test("run: 8 屏 fake chat → 4 块（[1-3][3-5][5-7][7-8]），reading.json/reading.md 落盘；第 2 块失败仍 partial", async () => { /* imageFor 返回 1x1 PNG data URL；chat 第 2 次抛错 */ });
test("run: 多图被拒 → 丢尾 2 屏 → 1 屏；缓存键用实际 image 集，screensRead/screensTotal 正确", async () => { /* chat 第 1 次抛 ChatError 400，后续成功；断言 stats.calls */ });
test("run: 预计块数 > 20 → reading-budget-large warning；maxScreens 截断计入 truncatedScreens", async () => { /* ... */ });
test("render: markdown 含 CR 主线、每块屏幕、questions、completeness、推断边标注", () => { /* ... */ });
test("render: 模型文本中的 | / 换行被转义（防 tables/HTML 注入）", () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/design-reading.test.js`
Expected: FAIL because run/merge/render are missing.

- [ ] **Step 3: Implement merge, render, run**

`merge`：按 screenId 合并；交互边去重键 `fromScreenId+fromElement+action+to`；优先级 observed > inferred > unconfirmed；同优先级不同目标 → 两份 + question；`unconfirmed` 永不进 observed。**端点校验**：`toScreenId` 不在全局屏集 → 降级 unconfirmed + question；plan 外 screenId 丢弃 + warning。**overlap 一致性**：同屏被相邻块各读一次时比较 `title/headerControls/persistentNav` 归一化结果，分歧 → question + `completeness.overlapConflicts`。若某屏 annotation 文本匹配常量 `SEARCH_TEXT_RE = /搜尋|搜索|search/i` 但 `headerControls` 没有 `search`，生成“搜索入口是否漏识别？”question（docs 注明非穷尽）。`spine`：入口屏 + 最长路径 + 连接密度；输出 `edgeIds/statusSummary`；含非 observed 边时 markdown 显著标注；MVP 用模板 summary（不调用文本模型），语义化总结留第二阶段；无入口/屏数 <3 → `unconfirmed`；DFS 访问预算 5000，耗尽用当前 best + `bounded-search`。`run`：读 flows JSON、按 `screenshots.summary.dir` 或 `screensDir` 找 `<screenFileName(id)>.png`；**实际发送屏幕 ID + image 集**计算块哈希；`maxScreens` 默认 50；复用已存 chunk（`reuse:false` 忽略缓存并重写同名 chunk，不删除历史文件）；`knownElements` 按块屏幕过滤；每块组 images（3→2→1 丢尾降级，记录 `droppedScreens`）；并发 2、60s 超时；>20 块 warning；失败块记入 stats 并继续；写 chunk/reading/markdown（模型文本经 Markdown 转义）。**status 映射**：所有计划屏实际读到且无失败块 → `read`；至少一块成功但有失败/漏读/截断 → `partial`；0 块成功 → `skipped`；`ok:true` 表示报告可读/已落盘，不等于完整；写盘/读取异常 catch 为 `skipped` + warning。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/design-reading.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/design/reading/run.ts src/design/reading/merge.ts src/design/reading/render.ts test/design-reading.test.js
git commit -m "feat(design): run and merge chunked design reading"
```

---

### Task 4: 接进 `design_to_test`（唯一入口）

**Files:**
- Modify: `src/workflow/design-to-test.ts`
- Modify: `src/tools/native-tools/workflow.ts`
- Modify: `test/workflow-design-to-test.test.js`
- Modify: `test/native-workflow-tool.test.js`

**Interfaces:**
- Consumes: `runDesignReading` from `../design/reading/run.js`; `makeChatFn`/`ChatFn`; `isVisionCapableModel`.
- Produces:
  - `DesignToTestArgs.reading?: "auto" | boolean`
  - `DesignToTestArgs.readingMaxScreens?: number`
  - `DesignToTestDeps.readDesign?: typeof runDesignReading`
  - `DesignToTestDeps.readingChat?: ChatFn`
  - Response adds `reading` when status `read`/`partial`/forced skip; steps add `{step:"read", ...}` only when reading actually attempted.

- [ ] **Step 1: Write failing integration tests**

在 `test/workflow-design-to-test.test.js` 新增：

```js
test("design_to_test: 8 屏自动阅读，steps = extract/read/generate/check", async () => {
  // stubRuntime.activeEntry 返回 model="deepseek-flash"（vision capable）
  // extractFigma 返回 counts.screens=8
  // deps.readDesign 返回 { ok:true, status:"read", stats:{chunksProcessed:4,...}, reading:{spine:{...},questions:[...]}, artifacts:{...}, warnings:[] }
  // 断言 steps 顺序、payload.reading.questions、artifacts.readingJson
});

test("design_to_test: reading:false 不调用 readDesign；2 屏 auto 也不调用", async () => { /* ... */ });
test("design_to_test: reading:true + 非视觉模型 → 不调用 readDesign，reading.status='skipped' 且有 vision-required warning", async () => { /* ... */ });
test("design_to_test: 阅读失败仍继续 generate，payload.reading.status='skipped' 且有 warning", async () => { /* ... */ });
test("design_to_test: 预计块数 > 20 → reading-budget-large warning，但仍继续", async () => { /* ... */ });
```

在 `test/native-workflow-tool.test.js` 的 schema 测试中接受 `reading:"auto"|true|false` 与 `readingMaxScreens`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/workflow-design-to-test.test.js`
Expected: FAIL because `reading`/`readDesign` is not wired.

- [ ] **Step 3: Implement integration**

在 `design-to-test.ts`：
- 读取 `readingMode = args.reading ?? "auto"`；计算 `screenCount`（extract payload 或 graph）。
- 触发条件：`readingMode === true || (readingMode === "auto" && screenCount >= 6)`；`false` 不触发。
- 在 extract/reuse 步骤后、generate 前调用 `readDesign`；`chat` 用 `deps.readingChat`，否则 `makeChatFn(activeEntry)`；`model` 传 **activeEntry.model 解析后的 ID**。
- 视觉守卫：用 `resolveVisionCapability`（`AOS_LLM_VISION` 声明 → 缓存 → 启发式 → unknown）；`auto` + 明确无视觉 → skip；`true` + 明确无视觉 → 不发起带图请求（`vision-required`）；`auto` + unknown → skip；`true` + unknown → 尝试并 `vision-model-unverified` warning。
- 成功：`recordStep({step:"read", chunks, screens, screensRead, observed, inferred, unconfirmed})`；response `reading` 摘要（含 `questions/completeness`）；artifacts `readingJson`/`readingMarkdown`。
- 失败：`reading = {status:"skipped"|"partial", reason}`；warning；继续 generate。`auto` 且 screenCount<6 不加 step/warning。
- 预算：`readingMaxScreens` 默认 50；预计块数 > 20 时 response 加 `reading-budget-large` warning，但仍继续。
- zod schema：`reading` union literal auto/boolean；`readingMaxScreens` int 1–200。

- [ ] **Step 4: Run tests to verify they pass**

Run:
- `npm run test:file -- test/workflow-design-to-test.test.js`
- `npm run test:file -- test/native-workflow-tool.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/workflow/design-to-test.ts src/tools/native-tools/workflow.ts test/workflow-design-to-test.test.js test/native-workflow-tool.test.js
git commit -m "feat(workflow): run design reading inside design_to_test"
```

---

### Task 5: 文档、响应样式与全量验证

**Files:**
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `docs/接入指南.md`
- Modify: `docs/superpowers/specs/2026-10-26-design-reading-design.md` if implementation reveals drift

**Interfaces:**
- Consumes: Task 4 response shape (`steps[].step === "read"`, `reading.summary/questions/artifacts`).
- Produces: user-facing docs describing one-command flow; no new command.

- [ ] **Step 1: Update docs**

README `design_to_test` 段：加“屏多时自动分块阅读；`reading:false` 关闭；结果含 `reading.questions` / `reading.md`”；不新增命令。写明 questions 的确认路径：**编辑 flows.json 加显式边（knownEdges 进哈希与 prompt）后重跑**，否则问题会持续重生。
DESIGN §13.227 增补：分块阅读、三档状态、chunk 缓存、报告只读、与生成解耦、预算/并发/丢尾降级、screensRead/screensTotal。
接入指南：给接入项目一句“看到 questions 先确认控件/连接线，再重跑”；注明 chrome/搜索 regex 非穷尽。

- [ ] **Step 2: Run full verification**

Run: `npm run build && npm test && npm run lint`
Expected: build 成功；全量测试通过；lint 0 error（既有 warning 允许）。

- [ ] **Step 3: Commit**

```bash
git add README.md DESIGN.md docs/接入指南.md docs/superpowers/specs/2026-10-26-design-reading-design.md
git commit -m "docs: document chunked design reading in design_to_test"
```

---

## Self-Review Notes

- 设计稿 §4 的“不新增命令”已映射到 Task 4；`reading:auto` 阈值 ≥6 与现有 2/3 屏测试兼容。
- 设计稿 §6.1 的 provenance 映射落在 Task 2（parser 只产 reading 状态，不产 `explicit`）与 Task 4（不把阅读结果写入 flows/tests）。
- 设计稿 §7 的合并/主线/完整性落在 Task 3。
- 设计稿 §8 的块级哈希/复用落在 Task 1+3。
- 设计稿 §11 的降级落在 Task 3+4。
- 设计稿 §12 的测试覆盖：分块/解析/合并/降级/缓存/问题/集成。
- Review Focus 的 5 个高风险输入（多图拒绝、chrome、搜索按钮、连接线不明、缓存失效）均有测试落点。
- 评审修正：K1（实际 image 集哈希/丢尾/screensRead）、K2（非视觉模型拒绝发图）、M1（解析后 model ID）、M2（去重断言/8 屏 4 块/6..10 表）、M3（端点校验）、M4（spine edgeIds/statusSummary）、M5（并发/超时/预算）、M6（overlap 一致性）；L1/L3/L4/L5/L7/L8 已进 Spec/Plan。
