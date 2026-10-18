# verify_jira_issue 实施计划（统一服务 ③：Jira 验证）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 MCP 工具 `verify_jira_issue`——给一个 Jira 单号：读单分档（粗单先问）→ 详细单走用例库映射（LLM 只能从清单中选或答没有）或"单子即用例" → 执行（回显先行）→ 聚合（强断言口径＋弱断言披露）→ 回写（失败证据＋同单复用的结论评论＋`jira_issue_key` 关联；`dryRun` 不写回）。

**Architecture:** 新增 `src/workflow/case-selection.ts`（从 `run_regression` 抽出共享选择原语＋现场读用例清单）、`src/workflow/jira-issue.ts`（细致度分档/步骤提取/单子即用例合成/落盘）、`src/workflow/jira-mapping.ts`（LLM 约束映射）、`src/workflow/verify-jira.ts`（编排）、`src/jira/verify-comment.ts`（结论评论构建＋映射行解析）；`src/jira/comments.ts` 增通用 marker upsert（trace 路径委派、行为不变）；`src/workflow/setup.ts` 增 `checkJira`；执行统一复用 `executeSuiteBatch`；工具定义进 `src/tools/native-tools/workflow.ts`。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、zod、exceljs（既有依赖，本计划不动）、node:test。

**Spec:** `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（本计划实施其 ③ 阶段：D8/D8b/D9/D12/D13/D15、§5 矩阵、§9 测试口径、§10 留白。④ `project_archive` 不在本计划）。

## Global Constraints

- 每任务收尾：`npm run build`＋该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- `needs-setup`/`needs-info` 为**非 isError**；仅用法错误（key 不合法/参数冲突）isError。复用而非 shell（禁止 shell 到 CLI/脚本）；测试全桩：不依赖真实 Jira / 设备 / LLM / PG（client / chat / executeBatch / postEvidence / store 均注入）。
- ESM+NodeNext+strict、相对导入 `.js`；中文文案；默认无注释（契约 JSDoc 例外）。
- **D9 口径不动摇**：不自动写 `verdict`（裁决是人工语义）；只写 `jira_issue_key` 关联＋评论显式标注「自动验证」；`dryRun` 零写回（不 createComment/updateComment/uploadAttachment/setCaseIssueKey）。
- **既有面零回归**：`run_regression`/`design_to_test`/`jira_*`/usage/native 工具与 `suite-*` CLI 测试全绿；`RunManifestSource` 只增枚举值、不改既有语义。
- **合成用例文件不得落 `case-sets/`**（`suite backfill` 会扫该目录幂等重建登记，会误认）：落 `<项目>/.artemis/design/jira/<KEY>.tests.json`（覆盖式写入、幂等）。
- 聚合口径（spec D9）：任一**强断言**失败→FAIL；**全弱/全探索**必须披露构成（N 强/M 弱）且**不得报 PASS**；弱断言失败不静默吞掉（列进失败清单）。
- 门禁分档沿用既有 `gateIssueForTests`（导入集三件套＋真实数据、覆盖 n/a）——本工具不新增闸门，执行链与 `run_regression` 同一条。

## Review Focus（最可能咬人；测试已归入各任务）

1. **回写幂等与复验**：同单二次验证→同 marker（`AOS-VERIFY:<KEY>`）**更新**既有评论而非新建（不刷屏）；上次评论里的「映射用例」行可被回读、进本次映射 prompt（T3/T6 测试钉死）。
2. **dryRun 零外部调用**：不 create/update 评论、不上传附件、不写 `jira_issue_key`；payload 含结论预览（T6 断言调用计数 0＋预览文本）。
3. **聚合诚实性**：强/弱/探索分类来自 `report.preflight.weakCases`＋`case.scriptProvenance`；quarantine 失败不计门禁；全弱不得 PASS（T6）。
4. **顺序与不白干**：粗单→needs-info 在 LLM ping/设备盘点/映射之前；无设备→needs-setup 在映射调用之前（省 token）；`scope` 给定时**不做 LLM 映射**（T6）。
5. **映射 fail-loud**：LLM/JSON 失败→`failedStep:"mapping"`（**不**静默降级为单子即用例）；编造/失效 id 一律被候选交集丢弃；上限与去重必须可断言（T5/T6）。

---

### Task 1: 共享选择原语（`case-selection.ts`）＋`run_regression` 复用

**Files:**
- Create: `src/workflow/case-selection.ts`
- Modify: `src/workflow/run-regression.ts`（删私有助手、改 import；行为不变）
- Test: `test/workflow-case-selection.test.js`（新）＋`test/workflow-run-regression.test.js` 零回归

**Interfaces:**
- Produces:
```ts
import type { CaseSetRecord } from "../db/types.js";

export interface CaseTarget {
  feature: string;
  jsonPath: string;
  cases: number;
  provenance: string;
  caseIds?: string[];
}
export function normalizeKeyword(value: string): string;       // NFKC + lowercase + 去空白
export function containsKeyword(text: string, keyword: string): boolean; // keyword 须已归一
export function provenanceOf(source: string): string;           // "导入自 x" / "生成自 y"
export function latestFeatures(sets: CaseSetRecord[]): CaseTarget[]; // 列表新→旧，每 feature.key 取首个
export function selectByScope(candidates: CaseTarget[], keyword: string): CaseTarget[];
export function readCaseSummaries(jsonPath: string): Array<{ id: string; name: string }>; // 坏文件 → []
```
- 迁移明细：`normalizeKeyword/contains→containsKeyword/provenanceOf/latestFeatures/selectByScope` 从 `run-regression.ts` 原样迁出（`RegressionTarget` 更名 `CaseTarget`）；`caseIdsMatching` 删除，`selectByScope` 内部改用 `readCaseSummaries`（仅取 string 型 `id`/`name`，语义不变）。

- [ ] **Step 1: 写失败测试**（`readCaseSummaries` 读 `flows[]` 只收 string id/name；缺文件/坏 JSON → `[]`；`latestFeatures` 每 key 取首个并携带 provenance；`normalizeKeyword` 全角/大小写/空白归一；`provenanceOf` 两条文案）。
- [ ] **Step 2: 红**（`npm run test:file -- test/workflow-case-selection.test.js`）。
- [ ] **Step 3: 实现**（新建文件＋run-regression 改 import）。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/workflow-case-selection.test.js test/workflow-run-regression.test.js` 零回归。
- [ ] **Step 5: 提交**：`git commit -m "refactor(workflow): extract shared case-selection primitives"`

---

### Task 2: Jira 前置（`setup.ts`）

**Files:**
- Modify: `src/workflow/setup.ts`
- Test: `test/workflow-setup.test.js`（追加）

**Interfaces:**
- Consumes: `runtime.jiraConfig()`（`ResolvedJiraConfig`：`configured/missing/siteUrl/email/apiToken`）。
- Produces:
```ts
export type SetupTarget = "figma" | "pen" | "llm" | "device" | "jira";
export function checkJira(runtime: Runtime): SetupNeed | null;
```
- 行为钉死：`configured === true` → `null`；否则 `{ target: "jira", missing: config.missing, howTo: [...] }`，howTo 两条逐字：
  1. `调用 aos_configure 同时提供 jiraSite / jiraEmail / jiraApiToken（写入项目 .env 并即时刷新）`
  2. `或在 <项目根>/.env 中添加 JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN 后重启 MCP 会话`

- [ ] **Step 1: 写失败测试**（configured→null；缺 URL+token→`missing` 逐字 `["JIRA_BASE_URL","JIRA_API_TOKEN"]`、target=`jira`、howTo 逐字）。stub runtime 只需 `jiraConfig()`。
- [ ] **Step 2: 红**。**Step 3: 实现**。
- [ ] **Step 4: 绿**（`npm run test:file -- test/workflow-setup.test.js`）。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): jira preflight check (needs-setup target jira)"`

---

### Task 3: 评论 marker 通用化＋结论评论（`comments.ts` / `verify-comment.ts`）

**Files:**
- Modify: `src/jira/comments.ts`（trace 路径改为通用 marker 的委派实现）
- Create: `src/jira/verify-comment.ts`
- Test: `test/jira-comments.test.js`（追加）、`test/jira-verify-comment.test.js`（新）

**Interfaces:**
- Produces（comments.ts）：
```ts
export function findCommentByMarker(
  comments: Array<{ id: string; body?: unknown }>, marker: string
): { id: string } | null;
export interface UpsertMarkedCommentOptions {
  marker: string;
  body: AdfNode;
  property?: { key: string; value: unknown }; // best-effort 写评论属性
}
export async function upsertMarkedComment(
  client: JiraClient, issueKey: string, options: UpsertMarkedCommentOptions
): Promise<UpsertCommentResult>;
```
  `upsertTraceComment(client, key, {traceId, body})` 改为一层委派：`marker=traceMarker(traceId)`、`property={key: AOS_TRACE_PROPERTY_KEY, value:{traceId}}`；`traceMarker/findCommentByTrace/withTraceMarker` 导出与语义保持不变（既有测试零回归）。
- Produces（verify-comment.ts）：
```ts
export const VERIFY_MARKER_PREFIX = "AOS-VERIFY:";
export function verifyMarker(issueKey: string): string; // "AOS-VERIFY:<KEY>"
export interface VerifyCommentInput {
  issue: { key: string; summary: string };
  conclusion: "passed" | "failed" | "inconclusive";
  composition: { strong: number; weak: number; explore: number };
  source: string;              // 回显用来源串（含 provenance 或 "单子即用例"）
  device: string;
  manifestPaths: string[];
  failed: Array<{ caseId: string; name: string; classification: "strong" | "weak" | "explore"; traceId: string | null }>;
  mapping?: { caseIds: string[] };
}
export function buildVerifyComment(input: VerifyCommentInput): { text: string; adf: AdfNode };
export function parseVerifyMapping(text: string): string[]; // 读 "映射用例:" 行；中英文冒号；逗号/顿号/空白分隔
```
- 文案钉死（`buildVerifyComment().text` 逐行，测试字面断言）：
  - 首行：`【AOS 自动验证】<KEY> <summary>`
  - `- 结论: ` → passed=`PASS`；failed=`FAIL（强断言失败 X 条）`；inconclusive=`无法判定（无强断言；弱断言仅记录路径，不代表验证通过）`
  - `- 构成: 强 X · 弱 Y · 探索 Z（共 N 条）`
  - `- 来源: <source>`、`- 设备: <device>`、每个 manifest 一行 `- 批次: <path>`
  - 失败行：`- 失败: <name>（trace <id>，<强|弱|探索>）`；无 traceId 时省略 `（trace …）` 括号段
  - 当 `weak + explore > 0` 且结论非 inconclusive 时追加一行：`弱断言仅记录路径，不代表验证通过`
  - `mapping` 存在且非空时追加：`映射用例: id1, id2`
- adf 用 `adfDoc/adfParagraph/adfBulletList`（首行 paragraph＋其余 bulletList）；marker 段落由 `upsertMarkedComment` 追加，`buildVerifyComment` 不写 marker。

- [ ] **Step 1: 写失败测试**：marker 通用化（无 marker→create＋属性写入；有 marker→update；`property` 缺省不写属性）＋trace 委派字段（`aos-trace` 属性键/值不变，既有测试覆盖）；verify-comment 三种结论文案逐字、构成行、失败行（含/不含 trace）、弱披露行去重、映射行有无、`parseVerifyMapping` 正常/空/英文冒号。
- [ ] **Step 2: 红**。**Step 3: 实现**。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/jira-comments.test.js test/jira-verify-comment.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(jira): verify conclusion comment + generic marker upsert"`

---

### Task 4: 单子解读与合成（`jira-issue.ts`）

**Files:**
- Create: `src/workflow/jira-issue.ts`
- Test: `test/workflow-jira-issue.test.js`

**Interfaces:**
- Consumes: `NormalizedIssue`（`src/jira/context.ts`：`key/summary/description.{text,acceptanceCriteria,raw}`）、`adfToText/asAdfNode`（`src/jira/adf.ts`）、`REAL_DATA_CLAUSE`（`src/figma/data-policy.ts`）、`designDir`（`src/figma/design-store.ts`）。
- Produces:
```ts
export type DetailTier = "detailed" | "coarse";
export function detailTierOf(issue: NormalizedIssue): DetailTier;
export function issueStepItems(description: unknown): string[]; // ADF listItem 文本，有序/无序/嵌套展平；无列表 → []
export interface TicketCase {
  id: string; name: string; preconditions: string[]; taskDesc: string;
  screens: string[]; steps: string[];
  expectations: Array<Record<string, unknown>>; feature: string;
}
export function synthesizeCasesFromIssue(issue: NormalizedIssue): TicketCase[];
export function ticketTestsPath(configDirAbs: string, issueKey: string): string; // <design>/jira/<KEY>.tests.json
export function writeTicketTestsFile(
  configDirAbs: string, issue: NormalizedIssue, cases: TicketCase[], now: Date
): string; // 返回 jsonPath；覆盖式
```
- 行为钉死：
  - **分档**：`acceptanceCriteria.length > 0` → detailed；否则 `issueStepItems(raw).length >= 2` → detailed；否则非空白字符数（`description.text` 去掉 `\s`）`>= 120` → detailed；否则 coarse。（阈值即口径，测试钉死 5 例。）
  - **步骤来源**：列表项优先；无列表项→用 `description.text` 的非空行；仍为空→用 `summary`（单条）。
  - **预期分离**：对每条 `/(?:预期(?:结果)?|期望(?:结果)?|应该|应当|应出现|应显示)[：:，,]\s*(.+)$/` 命中→ action=前缀去尾部标点，`steps.push(执行「${action}」，应出现「${expected}」)`＋`expectations.push({kind:"assert", text})`；未命中→ `steps.push(探索：${item})`＋`{kind:"explore"}`（与 Excel 导入口径同构，preflight 弱判据「含应」/explore 豁免成立）。
  - **用例**：单条（`id=jira-<KEY>-1`）；`name=issue.summary`（空则 `验证 <KEY>`）；`feature=jira-<KEY>`；`screens=[]`；`preconditions=[]`；`taskDesc` 行序：`REAL_DATA_CLAUSE`、`用例：<summary>`、`工单：<KEY>`、`步骤：<items.join("；")>`、（有预期时）`预期：<expected.join("；")>`。
  - **文件**：`{meta:{source:"jira:<KEY>",generatedAt},source,features:[{key,name:"<KEY>",screens:[]}],counts:{flows:n,screens:0,edges:0},flows:[...cases]}`，`JSON.stringify(...,null,2)+"\n"`；目录 `mkdirSync recursive`。

- [ ] **Step 1: 写失败测试**（用 ADF 字面量构造 issue）：分档 5 例（空描述→coarse；一句短话→coarse；两条 listItem→detailed；AC 段→detailed；120+ 字长文本→detailed）；`issueStepItems` 有序/无序/嵌套展平；合成（预期分离 assert、无预期 explore、taskDesc 含 REAL_DATA_CLAUSE 与工单号、id/feature 命名）；落盘（路径 `design/jira/<KEY>.tests.json`、meta.source、二次写覆盖、可被 `readTestsDocument` 读回）。
- [ ] **Step 2: 红→实现→绿**＋`npm run test:file -- test/workflow-jira-issue.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): jira issue tiering + ticket-as-case synthesis"`

---

### Task 5: LLM 约束映射（`jira-mapping.ts`）

**Files:**
- Create: `src/workflow/jira-mapping.ts`
- Test: `test/workflow-jira-mapping.test.js`

**Interfaces:**
- Consumes: `ChatFn/ChatMessage`（`src/llm/chat.ts`）。
- Produces:
```ts
export interface MappingCandidate { feature: string; provenance: string; cases: Array<{ id: string; name: string }>; }
export interface MappingIssue { key: string; summary: string; descriptionText: string; acceptanceCriteria: string[]; }
export type MappingSelection = { ok: true; caseIds: string[] } | { ok: false; error: string };
export const MAPPING_CASE_CAP = 400;
export const MAPPING_SELECTION_CAP = 10;
export function buildMappingMessages(input: {
  issue: MappingIssue; candidates: MappingCandidate[]; previous?: string[];
}): ChatMessage[];
export async function selectCasesWithLlm(chat: ChatFn, input: {
  issue: MappingIssue; candidates: MappingCandidate[]; previous?: string[];
}): Promise<MappingSelection>;
```
- 行为钉死：
  - system 消息含字面：「只能从清单中选」「不能编造」「没有合适的就返回空数组」「最多选 10 条」「只输出 JSON」；输出契约 `{"caseIds":["…"]}`。
  - user 消息：`工单：<KEY> <summary>`、描述原文、AC 逐条、候选逐 feature 分组（`- <feature>（<provenance>）`＋`  - <id> <name>`），按 case 计数截断至 `MAPPING_CASE_CAP=400`（超限在末尾注明）；`previous` 非空时含行 `上次验证选择的用例（仅供参考）：<id, …>`。
  - 调用 `chat(messages, AbortSignal.timeout(30_000))`；解析容错：直接 `JSON.parse` 失败→提取首个 `{…}` 子串；仍失败或非对象→`{ok:false,error}`。
  - `caseIds` 过滤：仅 string；与候选 id 集合求交（编造 id 丢弃）；保序去重；截断至 `MAPPING_SELECTION_CAP=10`；合法但为空→`{ok:true,caseIds:[]}`（="答没有"，由编排决定降级）。
  - chat 抛错→`{ok:false,error:errorMessage(error)}`。

- [ ] **Step 1: 写失败测试**（prompt 字面含约束/候选/上次选择行；合法 JSON 交集去重；编造 id 丢弃；`[]`→空；围栏/前后缀 JSON 提取；非 JSON→ok:false；>10 截断；chat 抛错→ok:false）。
- [ ] **Step 2: 红→实现→绿**。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): constrained LLM case mapping for jira issues"`

---

### Task 6: `verify_jira_issue` 编排

**Files:**
- Create: `src/workflow/verify-jira.ts`
- Modify: `src/figma/run-manifest.ts`（`RunManifestSource` 增 `"verify_jira_issue"`；不改既有值）
- Test: `test/workflow-verify-jira.test.js`

**Interfaces:**
- Consumes: `checkJira/checkLlm`（T2）、`resolveJiraClient/parseIssueKey/normalizeIssue/jiraErrorPayload`（`src/jira/*`）、`upsertMarkedComment/findCommentByMarker`（T3）、`verifyMarker/buildVerifyComment/parseVerifyMapping`（T3）、`detailTierOf/synthesizeCasesFromIssue/writeTicketTestsFile`（T4）、`buildMappingMessages/selectCasesWithLlm/MappingCandidate`（T5）、`latestFeatures/selectByScope/readCaseSummaries`（T1）、`executeSuiteBatch`、`postEvidenceToIssue`（`src/jira/post.ts`）、`makeChatFn`、`pickDevice/defaultListDevices`、`platformOf`、`adfToText`（读上次映射）。
- Produces:
```ts
export interface VerifyJiraIssueArgs { issueKey: string; device?: string; scope?: string; dryRun?: boolean; }
export interface VerifyJiraIssueDeps {
  setup?: SetupDeps;
  chat?: ChatFn;
  listDevices?: () => Promise<Array<{ serial: string }>>;
  listSets?: (runtime: Runtime, limit: number) => Promise<CaseSetRecord[]>;
  executeBatch?: typeof executeSuiteBatch;
  resolveJira?: typeof resolveJiraClient;
  postEvidence?: typeof postEvidenceToIssue;
  associateCase?: (runtime: Runtime, input: { runId: string; caseId: string; jiraKey: string }) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => Date;
}
export async function verifyJiraIssue(
  runtime: Runtime, args: VerifyJiraIssueArgs, deps?: VerifyJiraIssueDeps
): Promise<CallToolResult>;
```
- 流程钉死（顺序即口径）：
  1. `parseIssueKey(args.issueKey)` 失败→isError 用法错误（轻量文案）；`scope` 归一化（T1 `normalizeKeyword`）。
  2. `checkJira(runtime)` → needs-setup `checks:[need]`（**不触网**：`resolveJira` 与 `getIssue` 均不发生）。
  3. `client.getIssue(key, ["summary","description","labels"])`（`(deps.resolveJira ?? resolveJiraClient)(runtime)`；null 不过可能，防御同 2 走 needs-setup）→ 失败→`{ok:false,failedStep:"ticket",detail}`＋建议（核对单号与权限/429 稍后重试）。
  4. `detailTierOf(issue)`：**coarse → `{ok:false,needs:"info"}`**：questions 三条逐字（`这是哪个功能/页面？`、`触发条件是什么（做了什么操作）？`、`期望结果是什么？`），context：`工单 <KEY>：<summary>`＋`在工单描述里补充「步骤/复现条件＋预期结果」后重跑；或给 scope 指向用例库里的相关功能`。**此分支不调用 LLM ping/设备盘点/映射。**
  5. `checkLlm(runtime, deps.setup)` → needs-setup。6. 设备（`pickDevice`，同 run-regression 三态）。
  7. 选择：
     - `scope` 给定：`listSets`（缺省 `(rt,limit)=>rt.store.listCaseSets(rt.project.rootDir,limit)`，limit 200）→`latestFeatures`→`selectByScope`；0 命中→needs-info（questions：`用例库里没有匹配「<scope>」的用例：换关键词，或给 Excel 测试文档导入/用 design_to_test 生成`；context 为最新份清单）；**不调用映射 chat**；mode=`scope`。
     - 否则：候选=`latestFeatures` 逐 feature `readCaseSummaries`（空表跳过）；候选为空→合成（`mappingAttempted=false`）；非空→读上次映射（`client.getComments(key)`＋`findCommentByMarker(comments, verifyMarker(key))`＋`adfToText`＋`parseVerifyMapping`；失败降级为空＋WARN 日志）→`selectCasesWithLlm(deps.chat ?? makeChatFn(activeEntry), {issue,candidates,previous})`（置 `mappingAttempted=true`）；`ok:false`→`{ok:false,failedStep:"mapping",detail,suggestions:[可重试/给 scope]}`；`caseIds` 空→合成；非空→mode=`mapped`，targets=对应 feature（`caseIds` 透传）。
     - 合成（D8b）：`synthesizeCasesFromIssue(issue)`＋`writeTicketTestsFile(configDirAbs, issue, cases, deps.now?.() ?? new Date())`→单 target（`provenance:"单子即用例"`）；mode=`ticket`；steps 增 `{step:"synthesize",cases,testsFile}`。
     - 回显/评论用 `source` 串：mode=`ticket` → `单子即用例`；否则 targets 的 `provenance` 去重后以 `；` 连接（如 `导入自 qa.xlsx@abcd1234；生成自 figma:…`）；评论的 `mapping:{caseIds}` 仅在 mode=`mapped` 传入。
  8. 回显＋日志（同 run-regression 两次 `log()`）：`verify_jira_issue: 验证目标 …（来源…）· 设备 …`、`verify_jira_issue: 即将执行 N 条用例 · M 个集 · 设备 …`；steps 增 `{step:"select",mode,targets}`。
  9. 逐集 `executeSuiteBatch({options:{testsPath,deviceSerial,caseIds?,apiErrors:true,failOnApiErrors:false,stopOnFailure:false},source:"verify_jira_issue",trigger:"verify_jira_issue",registration:{platform:platformOf(device)}})`；抛错/`report.ok:false`→`{ok:false,failedStep:"run",detail,suggestions,artifacts:{sets}}`。
  10. 分类与聚合（钉死）：`weakIds=report.preflight?.weakCases.map(id)`；每 case 分类 `weak`（在 weakIds 或 `scriptProvenance===null`）→`explore`（`asserts===0`）→`strong`；`strongFailed`=分类 strong 且 `status!=="passed"` 且非 quarantined；`weakFailed`=其余分类的同类失败；`conclusion = strongFailed>0 ? "failed" : strongTotal===0 ? "inconclusive" : weakFailed>0 ? "inconclusive" : "passed"`；`composition{strong,weak,explore}` 计 executed 用例。
  11. 写回（`dryRun!==true` 才发生）：
      - 失败证据：失败条目里 `traceId` 非空的前 10 条（超出记 `evidenceTruncated`）→`postEvidence`（缺省 `postEvidenceToIssue`，`{key,traceId,deviceSerial:device}`）→每条形如 `{traceId,ok,commentId?}`；异常/`ok:false` 记入 `writeback.errors`（不翻 `ok`）。
      - 结论评论：`upsertMarkedComment(client, key, {marker:verifyMarker(key), body:buildVerifyComment(input).adf, property:{key:"aos-verify",value:{issueKey:key}}})`→`action/commentId`；失败记 errors。
      - 关联：每集 `runId` 非空→逐 executed case `associateCase`（缺省 `(rt,input)=>rt.store.setCaseIssueKey({rootPath:rt.project.rootDir,...input})`）best-effort，失败记 errors。
      - `dryRun===true`：零调用；`writeback={outcome:"dryRun",conclusionText:buildVerifyComment(...).text,evidencePlanned:[traceIds]}`。
  12. payload：`{ok:true, ticket:{key,detailTier,summary}, ...(mappingAttempted?{mapping:{selected:mappedSelected}}:{}) , ...(scope?{scope:{keyword,hits}}:{}) , steps, artifacts:{sets:[{feature,jsonPath,manifestPath}], ...(mode==="ticket"?{testsFile}:{})}, run:{device,sets,total,executed,passed,failed,gate:conclusion,conclusion,composition,traceIds}, writeback:{outcome:"sent"|"dryRun",…}}`（`mappedSelected`＝映射选中的 caseIds 数；答"没有"时 0，供 usage `mapping.selected|none`）。
- 测试矩阵（全桩；fixture：stub runtime（`configDirAbs` 临时目录、`jiraConfig` configured、`activeEntry`）、stub client（记录 getIssue/getComments/createComment/updateComment/setCommentProperty）、stub chat、stub executeBatch（构造 report.preflight/scriptProvenance）、stub postEvidence/associateCase）：
  1. detailed＋映射命中→执行（`source:"verify_jira_issue"`、caseIds 透传）→`run.conclusion:"passed"`→写回 sent（create＋marker＋映射行＋属性）。
  2. 映射 `[]`＋库有候选→合成（payload `mapping.selected:0`）：`design/jira/<KEY>.tests.json` 落盘、执行该文件、评论来源=`单子即用例`。
  3. 库为空→直接合成（未调用映射 chat）。
  4. coarse→needs-info 三条问题；断言未调用设备盘点、未调用映射 chat、未写盘。
  5. Jira 未配置→needs-setup（`checks[0].target==="jira"`）且未调用 getIssue。
  6. 无设备→needs-setup 且未调用映射 chat。7. 多设备→needs-info。
  8. scope 命中→不调用映射 chat、caseIds 透传；scope 0 命中→needs-info。
  9. 强失败→`conclusion:"failed"`＋证据回写（postEvidence 收到失败 traceId）＋评论 FAIL。
  10. 全弱（strongTotal=0）→`conclusion:"inconclusive"`＋评论含弱披露句。
  11. dryRun→`createComment/updateComment/postEvidence/associateCase` 零调用＋payload 预览文本。
  12. 复验：getComments 返回含映射行的既有评论→prompt 含上次选择、评论走 update；quarantine 失败不计 strongFailed。
  13. 某集 `report.ok:false`→`failedStep:"run"`；映射 chat 抛错→`failedStep:"mapping"`。
  14. 关联：对每 executed case 调用 associateCase（runId/caseId/jiraKey）。
- [ ] **Step 1: 写失败测试**（矩阵 1–14）。**Step 2: 红→实现→绿**。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/workflow-verify-jira.test.js test/workflow-run-regression.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): verify_jira_issue orchestration (tier → map/synthesize → run → aggregate → writeback)"`

---

### Task 7: 工具接线＋usage 信号

**Files:**
- Modify: `src/tools/native-tools/workflow.ts`（数组增 `verify_jira_issue`）、`src/usage/capture.ts`（family/name 集＋结构化信号）
- Test: `test/native-workflow-tool.test.js`（追加）、`test/usage-capture.test.js`（追加）

**Interfaces:**
- schema ≡ `VerifyJiraIssueArgs`：`issueKey: z.string()`（必填；描述含"单号（AOS-123）或 browse URL"）、`device/scope/dryRun` 可选。
- 描述必须含字面（测试断言）：`Jira 验证`、`粗单`、`只能从清单中选`、`单子即用例`、`任一强断言失败`、`弱断言仅记录路径，不代表验证通过`、`AOS-VERIFY`、`dryRun`、`needs-setup`、`needs-info`、`回显`。
- usage：`WORKFLOW_TOOL_NAMES`/`NATIVE_TOOL_NAMES` 增 `verify_jira_issue`；`outcomeSignalsOf` 根字段提取（只读枚举/根字段）：
  - `ticket.detailTier`：`{code:"ticket.detailTier", field:"detailed"|"coarse"}`
  - `mapping`：`selected` 为 number 时 → `>0` `{code:"mapping.selected", field:String(n)}`，`0` → `{code:"mapping.none"}`
  - `writeback`：`outcome` 为 `"sent"|"dryRun"` → `{code:"writeback", field:outcome}`
- [ ] **Step 1: 写失败测试**（目录含 `verify_jira_issue`；schema 4 键；描述字面；zod 非法类型拒；usage：family=workflow、三类信号与根字段样例）。
- [ ] **Step 2: 红→实现→绿**＋`npm run test:file -- test/native-workflow-tool.test.js test/usage-capture.test.js test/server-smoke.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(tools): expose verify_jira_issue; usage signals for ticket/mapping/writeback"`

---

### Task 8: 文档＋全量＋收尾

**Files:**
- Modify: `README.md`（工具表 `verify_jira_issue` 行）、`AGENTS.md`（设计流水线段一句话：设计/回归/Jira 三入口并列）、`DESIGN.md`（§13.121 实施记录：范围、口径（分档/映射约束/聚合/回写幂等/dryRun/无 verdict）、测试数）。

- [ ] **Step 1: 文档三处**（口径与 T6 一致；实现记录含提交序列）。
- [ ] **Step 2: 全量回归** `npm run build && npm test && npm run lint`。
- [ ] **Step 3: 残留扫描**（`grep -rn "verify_jira_issue" src/ | wc -l` 对照装配点；确认无 console/TODO）。
- [ ] **Step 4: 提交**：`git commit -m "docs: verify_jira_issue (unified service ③) record"`

---

## Self-Review 记录（写稿人自查）

- **Spec 覆盖**：D8/D8b→T4/T5/T6；D9→T3/T6；D12→T7；D13→T6（scope 覆盖＋上次评论映射上下文）；D15→T6（回显先行/LLM ping/结构化失败）；§5 矩阵（执行类设备）→T2/T6；§9 测试口径逐条映射到 T6 矩阵；§10 留白在此收敛（分档阈值、提问模板、映射措辞、评论字段）。
- **类型一致性**：`CaseTarget`/`DetailTier`/`TicketCase`/`MappingCandidate`/`MappingSelection`/`VerifyCommentInput`/`VerifyJiraIssueDeps` 跨任务同名；`RunManifestSource` 只增 `"verify_jira_issue"`。
- **比例**：8 任务；测试以行为矩阵为主（T6 为 14 例矩阵），无整段实现转写；代码步骤只留签名与钉死值。
- **留白（随实现/复核收敛）**：分档阈值三档、映射 prompt 措辞与双上限（400/10）、评论行文案、合成正则、证据回写上限 10——均已在接口/行为处写明默认值，复核可调。

## Execution Handoff

计划就绪。建议 **Native（executing-plans）**：任务强顺序（T1→T3/T4/T5→T6 接口逐环相扣）、每任务独立测试、最终全量兜底；Subagent-driven 亦可但每个子代理需携带 spec＋前序接口。请审阅计划——确认后选择执行方式（Native／Subagent-driven）。
