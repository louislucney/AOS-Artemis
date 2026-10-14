# 回归服务 P1a：生成侧（功能切分 / 命名 / 归档 / 登记）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `figma_generate_tests` 生成时按功能切"份"、命名（MCP 生成）、跨生成继承身份，把每份三件套归档到 `.artemis/design/case-sets/`，并把用例集/功能段登记进 DB。

**Architecture:** 新增纯函数模块 `src/figma/features.ts`（切分/命名/身份）与 `src/figma/case-sets.ts`（归档写入）；`src/figma/flows.ts` 屏幕增可选 `page`；`ProjectStore` 增 `case_sets`/`case_set_features` 两表两方法；`src/figma/test-gen.ts` 在保存路径接线。**live 三件套契约不变**，全部为增量。

**Tech Stack:** TypeScript（ESM + NodeNext + strict）；Node ≥ 20；`node:test`（JS 测试跑 `dist/`）；pg-mem；exceljs；测试用 `test/helpers.js` 的 `loadTestRuntime`/`makeTempProject`/`parseToolResult`。

**Spec:** `docs/superpowers/specs/2026-10-14-regression-service-design.md`（§5.1/§5.2/§5.3）。本计划只覆盖 **P1a**；P1b（`suite run --task`/对比/结果表）与 P1c（面板/归因）另立计划。

## Global Constraints

- 完工标准：`npm run build && npm test && npm run lint` 全绿（测试跑 `dist/`，先构建）。
- ESM + NodeNext：相对导入一律带 `.js` 后缀；strict 全开。
- 测试不依赖真实 PG / 设备 / 外网：DB 用 pg-mem；Figma 走 stub fetch；LLM 用注入 fake chat。
- 三件套同名配对硬约束：一份功能段归档＝`<stem>.json/.md/.xlsx` 同 basename（`suite check` 据此找配套）。
- live `.artemis/design/tests.json|md|xlsx` 契约不变（新增字段一律可选增量，旧读取方不受影响）。
- 用户可见文案中文；代码标识符英文；默认不加注释（非显然契约除外）。
- 行为变更同步 `DESIGN.md`（实施记录）与 `README.md`（用法）。
- 降级一律如实标注（warnings），不静默、不阻断生成。

## Review Focus

1. 功能名含 `/ \ : * ? " < > |`、空白、超长、同批重名 → 归档不得写入失败或互相覆盖（Task 5 sanitize + `-2` 后缀必须测）。
2. 无页面信息、无公共前缀、单屏、空图 → 切分回退单组且不崩（Task 1 `fallback`）。
3. LLM 返回非 JSON / 空 / 超长 / 抛错 → 命名回退链不阻断生成（Task 2 注入 fake chat）。
4. 两次生成同一设计（屏幕集合相同）→ 继承同一 key/name；低置信不静默合并（Task 3 + Task 8）。
5. store 不可用（抛错）→ 生成成功、warning 如实标注；`requireFullCoverage` 失败 → 归档也不落盘（Task 7/8）。

---

### Task 1: 功能切分 `splitFeatures`（纯函数）

**Files:**
- Create: `src/figma/features.ts`
- Create: `test/figma-features.test.js`

**Interfaces:**
- Produces（后续任务共用本文件的类型）：
  ```ts
  export interface FeatureSplitInput {
    screens: { name: string; page?: string }[];
    edges: { from: string; to: string | null }[];
  }
  export interface FeatureGroup {
    key: string;           // Task 3 填充
    name: string;          // Task 2 填充
    screens: string[];     // 屏幕名（切分输出，按屏幕名字典序）
    signal: "page" | "name-prefix" | "cluster" | "fallback";
    candidateName: string | null;
  }
  export interface FeatureWarning { code: string; message: string }
  export function splitFeatures(input: FeatureSplitInput): FeatureGroup[];
  ```

**切分规则（确定性，同输入同输出；遍历一律按屏幕名字典序）：**
1. `page`：非空 page 值 ≥2 个且覆盖 ≥2 屏 → 按 page 分组（`signal:"page"`，`candidateName`=page 名）。
2. 前缀：屏幕名取首个分隔符（`-` `_` 空格 `·` `/` 或数字边界）前的 token；≥2 屏共享同一 token → 成组（`signal:"name-prefix"`，`candidateName`=token）；剩余屏幕按**边邻居多数**并入已存在组（并列取字典序最小组；无邻居 → 单独成组，`signal:"cluster"`）。
3. 连通分量：1、2 均无分组时，按无向边连通分量分组（≥2 组才用；`signal:"cluster"`，`candidateName:null`）。
4. 回退：以上都不成立 → 单组（`signal:"fallback"`，`candidateName:null`）。

- [ ] **Step 1: 写失败测试**（`test/figma-features.test.js`，从 `../dist/figma/features.js` 导入）
  测试名与断言：
  - `splitFeatures: 按页面分组（signal=page）`——两页各 2 屏，断言 2 组、`signal:"page"`、`candidateName` 为页面名。
  - `splitFeatures: 无页面时按屏幕名前缀归并`——`登录-输入 / 登录-验证 / 首页`，断言 2 组、登录组 2 屏。
  - `splitFeatures: 前缀未覆盖屏幕按边邻居多数归并`——未分组屏与登录组有 2 条边、与首页组 1 条 → 并入登录组。
  - `splitFeatures: 无页面无前缀按连通分量`——两簇屏幕（无公共前缀、两条内边），断言 2 组、`signal:"cluster"`。
  - `splitFeatures: 单屏回退单组、空图返回空数组`——单屏断言 1 组、`signal:"fallback"`；`splitFeatures({screens:[],edges:[]})` 断言 `[]`（无屏幕即无功能段）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/figma-features.test.js` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 `splitFeatures`**（`src/figma/features.ts`，纯函数、无 I/O）。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2 命令 → PASS。
- [ ] **Step 5: 提交**：`git add src/figma/features.ts test/figma-features.test.js && git commit -m "feat(figma): feature splitting for case-set batches"`

### Task 2: 命名链 `nameFeatures`

**Files:**
- Modify: `src/figma/features.ts`
- Modify: `test/figma-features.test.js`

**Interfaces:**
- Consumes: `FeatureGroup`、`FeatureWarning`（Task 1）；`ChatFn`（`src/llm/chat.js`：`(messages, signal?) => Promise<string>`）。
- Produces:
  ```ts
  export function nameFeatures(
    groups: FeatureGroup[],
    deps?: { chat?: ChatFn | null }
  ): Promise<{ groups: FeatureGroup[]; warnings: FeatureWarning[] }>;
  ```
- 每组的命名回退链：`candidateName`（trim、去引号/换行、≤16 字符）→ `chat`（system 指令要求输出 JSON `{"name":"≤8字功能名"}`，user 给该组屏幕清单；解析 `{"name": string}`，trim、≤8 字符）→ `功能N`（N=按屏幕名字典序的组序号，从 1 起）+ warning `feature-naming-fallback`。chat 为 null / 抛错 / 解析失败 → 进入下一级，不阻断。

- [ ] **Step 1: 写失败测试**
  - `nameFeatures: 有候选名直接用（不调用 chat）`——fake chat 断言零调用。
  - `nameFeatures: 无候选名走 LLM（fake 返回 JSON）`——断言 name 生效、无警告。
  - `nameFeatures: LLM 坏 JSON 回退 功能N 并告警`——断言 name=`功能1`、warning code=`feature-naming-fallback`。
  - `nameFeatures: 名称清洗`——引号/换行/超长（>16）被清洗或截断。
  - `nameFeatures: chat 抛错不阻断`——断言仍返回全部组。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/figma-features.test.js`。
- [ ] **Step 3: 实现 `nameFeatures`**（prompt 文案固定中文；JSON 解析失败按失败处理）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): feature naming chain (candidate -> LLM -> 功能N)"`

### Task 3: 身份继承 `applyIdentity` + 用例归属 `assignCaseFeature`

**Files:**
- Modify: `src/figma/features.ts`
- Modify: `test/figma-features.test.js`

**Interfaces:**
- Produces:
  ```ts
  export interface PriorFeature { key: string; name: string; screens: string[] }
  export function applyIdentity(
    groups: FeatureGroup[],
    prior: PriorFeature[]
  ): { groups: FeatureGroup[]; warnings: FeatureWarning[] };
  export function assignCaseFeature(caseScreens: string[], groups: FeatureGroup[]): string | null;
  ```
- 匹配规则：重叠率 = `|交集| / min(|新组屏幕|, |旧组屏幕|)`；唯一最高且 ≥0.5 → 继承旧 `key` 与 `name`（名称冻结）；并列最高或 <0.5 → 新 key = `` `f-${slug(name)}-${sha256(排序屏幕).slice(0,8)}` `` + warning `feature-identity-new`（message 含组名与屏幕数）。`slug` 规则：名称转小写、保留 `[a-z0-9]` 与 CJK、其余 → `-`、去首尾 `-`、空 → `feature`、截 16 字符。
- `assignCaseFeature`：用例屏幕命中数最多的组；并列 → 该用例首个屏幕所在组；无命中 → `null`。

- [ ] **Step 1: 写失败测试**
  - `applyIdentity: 重叠 ≥0.5 继承 key 与名`（prior 同名不同 key，断言继承 key）。
  - `applyIdentity: 无匹配生成新 key 并告警`（断言 key 形如 `f-…-<8hex>`、warning `feature-identity-new`）。
  - `applyIdentity: 并列最高不合并`（两个 prior 同为最高 → 新 key）。
  - `assignCaseFeature: 多数归属；并列取首屏；无命中 null`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（sha256 用 `node:crypto`）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): feature identity inheritance across generations"`

### Task 4: flows 捕获页面名

**Files:**
- Modify: `src/figma/flows.ts`（`FlowScreen` 增可选 `page?: string`；`buildFlowGraph` 屏幕构造处——`screenOf` 已在 `parentOf` 链上定位屏幕，同处取所属 `PAGE` 节点 `name`；`normalizeFlowGraph` 容忍缺失/非字符串）
- Modify: `test/figma-flows.test.js`
- Modify: `test/fixtures/figma-flow-doc.mjs`（增导出 `pagedFlowDocument()`：两个 `PAGE` 各含 2 屏 + 一条跨页边）

**注意：** 不升 `FLOWS_SCHEMA_VERSION`（可选增量字段；旧读取方忽略，读侧容忍缺失）。

- [ ] **Step 1: 写失败测试**
  - `buildFlowGraph: 屏幕记录所属页面名`——`pagedFlowDocument()` 断言每屏 `page` 等于其页面名。
  - `normalizeFlowGraph: 缺 page 的旧文档正常读取`——旧 fixture 断言 `page === undefined` 且不报错。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/figma-flows.test.js`。
- [ ] **Step 3: 实现**（构建屏幕时向上找 `type === "PAGE"` 的祖先，取其 `name`）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): capture owning page name per screen in flows"`

### Task 5: 归档写入 `case-sets.ts`

**Files:**
- Create: `src/figma/case-sets.ts`
- Create: `test/figma-case-sets.test.js`
- Modify: `src/figma/retention.ts`（`RETENTION_CATEGORIES` 增 `case-sets`）
- Modify: `test/retention.test.js`

**Interfaces:**
- Consumes: `designDir`（`src/figma/design-store.js`）、`writeFileAtomic`（`src/util.js`）。
- Produces:
  ```ts
  export const CASE_SETS_DIR = "case-sets";
  export function caseSetsDir(configDirAbs: string): string; // designDir + case-sets
  export function caseSetStem(name: string, now: Date, taken: Set<string>): string;
  // stem = `${YYYYMMDDTHHmmss}_${sanitize(name)}`（UTC，同 runId 风格）；冲突加 -2、-3…
  // sanitize：`/ \ : * ? " < > |` 与空白 → "-"，去首尾 "-"，空 → "feature"，截 ≤40 字符
  export function saveCaseSetFiles(
    dir: string,
    stem: string,
    files: { json: string; markdown: string; xlsx: Buffer }
  ): Promise<{ jsonPath: string; mdPath: string; xlsxPath: string }>;
  // 三份同 basename（stem.json / stem.md / stem.xlsx），writeFileAtomic
  ```

- [ ] **Step 1: 写失败测试**（temp dir，`fs.mkdtempSync`）
  - `caseSetStem: 清洗非法字符与空白、空名回退 feature、超长截断`。
  - `caseSetStem: 冲突加后缀 -2`。
  - `saveCaseSetFiles: 三件套同 basename 且可读、返回路径一致`。
  - `suite retention: case-sets 分类存在`（`RETENTION_CATEGORIES` 含 `case-sets`；报告计数涵盖该目录）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/figma-case-sets.test.js`。
- [ ] **Step 3: 实现**（归档写入 + 保留期分类）。
- [ ] **Step 4: 跑测试确认通过**：`npm run test:file -- test/figma-case-sets.test.js` 与 `npm run test:file -- test/retention.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): case-set archive writer (time+feature naming)"`

### Task 6: DB 登记（store + postgres + memory）

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`（DDL 区新增两张表；`recordCaseSet`/`listCaseSets`；rootPath→project 解析仿 `recordTask`）
- Modify: `src/db/memory.ts`（同语义内存实现）
- Create: `test/db-case-sets.test.js`（仿 `test/db.test.js` 的 pg-mem 装配；memory 部分直接构造）

**Interfaces:**
- Produces（`src/db/types.ts`）：
  ```ts
  export interface CaseSetFeatureRecord {
    key: string; name: string; caseCount: number; screens: string[];
    jsonPath: string; mdPath: string; xlsxPath: string;
  }
  export interface CaseSetRecord {
    id: string; projectId: string | null; createdAt: string; source: string;
    designName: string | null; fingerprint: string | null; basename: string;
    features: CaseSetFeatureRecord[];
  }
  export interface RecordCaseSetInput {
    rootPath: string; source: string; designName?: string | null; fingerprint?: string | null;
    basename: string; createdAt?: string;
    features: Array<{ key: string; name: string; caseCount: number; screens: string[];
                      jsonPath: string; mdPath: string; xlsxPath: string }>;
  }
  // ProjectStore 增：
  recordCaseSet(input: RecordCaseSetInput): Promise<CaseSetRecord>;
  listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]>; // 新→旧，默认 50
  ```
- DDL（postgres）：
  ```sql
  CREATE TABLE IF NOT EXISTS case_sets (
    id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT, source TEXT,
    design_name TEXT, fingerprint TEXT, basename TEXT);
  CREATE TABLE IF NOT EXISTS case_set_features (
    case_set_id TEXT, feature_key TEXT, name TEXT, case_count INTEGER,
    screens JSONB, json_path TEXT, md_path TEXT, xlsx_path TEXT,
    PRIMARY KEY (case_set_id, feature_key));
  ```
- id 生成仿现有记录模式（`randomUUID`）。

- [ ] **Step 1: 写失败测试**（pg-mem + memory 两套）
  - `recordCaseSet: 往返完整（features 嵌套、screens 数组）`。
  - `listCaseSets: 新→旧排序与 limit`。
  - `listCaseSets: 项目隔离（不同 rootPath 不串）`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-case-sets.test.js`。
- [ ] **Step 3: 实现**（DDL、两方法、memory 镜像）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): case_sets registry (record/list, pg-mem tested)"`

### Task 7: 生成接线（切分 / 命名 / 归档）

**Files:**
- Modify: `src/figma/test-gen.ts`
- Create: `test/figma-case-sets-gen.test.js`（用 `test/helpers.js`：`loadTestRuntime`、`makeTempProject`、`parseToolResult`；fixture 复用 `test/fixtures/figma-flow-doc.mjs`）

**Interfaces:**
- `GeneratedTest`（`src/figma/test-gen.ts`）增可选 `feature?: string`（feature key）。
- `GenerateTestsDeps` 增 `chat?: ChatFn | null`、`now?: () => Date`。
- payload 增 `features: Array<{ key: string; name: string; screens: string[]; caseIds: string[] }>`；`savedTo` 增 `caseSets: Array<{ feature: string; json: string; md: string; xlsx: string }>`。
- `figmaGenerateTests` 保存段接线（锚点：现有 `if (args.save !== false)` 块，`jsonPath`/`markdownPath`/`excelPath` 处）：
  1. `splitFeatures({ screens: graph.screens.map(s => ({name: s.name, page: s.page})), edges: graph.edges.map(e => ({from: e.from.name, to: e.to?.name ?? null})) })`
  2. `fallback` 组填 `candidateName`：pen → `.pen` 文件名；figma → `fetchFile(fileKey, 1)` 的 `name`（失败 → null）。
  3. `nameFeatures(groups, { chat })`；`chat` 缺省解析：仿 `src/pen/flows.ts:839`（active LLM entry → `makeChatFn`），解析不到传 `null`。
  4. （本任务 `prior = []`；继承与登记在 Task 8。）
  5. `case.feature = assignCaseFeature(case.screens, groups) ?? undefined`。
  6. live 三件套照旧写（不改路径/命名）；随后**每功能子集**：json = `{...payload, flows: 子集, features: [该组], coverage: computeFlowCoverage(graph, 子集)}`（实际签名 `(graph, cases, stats?)`），markdown = `renderMarkdown(子集, …)`（截图 map 传子集对应项），xlsx = `renderTestsWorkbook(子集, …)` → `saveCaseSetFiles(caseSetsDir(configDirAbs), caseSetStem(组名, now(), taken), …)`；`taken` 由目录现有 stem 前缀收集。
  7. `savedTo.caseSets` 填三路径；`requireFullCoverage` 不通过路径保持现状（三件套与归档都不落盘）。

- [ ] **Step 1: 写失败测试**（stub runtime + 临时项目；`deps: { now: () => new Date("2026-10-14T15:30:00Z"), chat: null }`）
  - `生成后每份归档三件套同 basename（savedTo.caseSets 三路径存在且可读）`。
  - `用例带 feature 且 payload.features.caseIds 与归档 flows 一致`。
  - `save:false 不写归档（savedTo.caseSets 不存在）`。
  - `命名走注入 chat（fake 返回 JSON，断言归档 stem 含该名）`。
  - `requireFullCoverage 不通过时不落任何文件`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/figma-case-sets-gen.test.js`。
- [ ] **Step 3: 实现接线**。
- [ ] **Step 4: 跑测试确认通过**；再跑 `npm run test:file -- test/figma-testgen.test.js` 确认既有生成测试无回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): wire feature splitting + case-set archives into test generation"`

### Task 8: 登记与继承接线

**Files:**
- Modify: `src/figma/test-gen.ts`
- Modify: `test/figma-case-sets-gen.test.js`

**Interfaces:**
- 生成前：`prior` = `runtime.store.listCaseSets(rootDir, 50)` 展平 features → `PriorFeature[]`；store 抛错 → `prior=[]` + warning `case-set-registry-unavailable`。
- 生成后（保存成功时）：`runtime.store.recordCaseSet({ rootPath, source, designName, fingerprint: testsFingerprint(liveJsonPath)?.sha256, basename, features: 归档列表 })`（`testsFingerprint` 复用 `src/figma/run-manifest.js`）；失败 → warning `case-set-registration-failed`，不阻断。
- warnings 汇入 payload.warnings（沿用现有 warnings 数组）。

- [ ] **Step 1: 写失败测试**
  - `两次生成同一屏幕集合 → 继承同一 key/name`（memory store 两轮生成，断言第二轮 key/name 与第一轮一致）。
  - `store 不可用（注入抛错 store）→ 生成成功 + case-set-registry-unavailable 警告`。
  - `登记行与归档一致`（memory store 断言 features 数与路径）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现接线**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): register case-sets in DB + identity inheritance wiring"`

### Task 9: 全量回归 + 文档

**Files:**
- Modify: `DESIGN.md`（实施记录：P1a——切分/命名/身份/归档/登记，含决策与降级口径）
- Modify: `README.md`（`figma_generate_tests` 产物：case-sets 归档、`savedTo.caseSets`、功能名生成说明）

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 更新 DESIGN.md 实施记录 + README.md 用法**。
- [ ] **Step 3: 提交**：`git add DESIGN.md README.md && git commit -m "docs: regression service P1a (feature split / naming / archives / registry)"`

---

## 范围外（另立计划）

- **P1b**：`suite run --task`（引用解析、子运行展开、`suite_runs`/`suite_run_cases` 登记、同份对比、结果表命名/列）。
- **P1c**：面板动作层（回归引用屏、任务页、归因队列 v1、统计雏形）与鉴权口径。
