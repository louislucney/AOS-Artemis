# project_archive 实施计划（统一服务 ④：项目档案只读摘要）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 MCP 工具 `project_archive`——一个**只读摘要面**：项目与栈；设计血统（flows 来源/落盘时间/屏数/边数/provenance 构成）；用例库（各功能最新份：来源/条数/时间）；最近运行（近 10 批清单摘要：gate/通过率/失败域）；裁决与 Jira 关联摘要；前置状态（figma/pen/jira/llm 静态就绪、masked、显式「未复核」）。无网络、无子进程、不写盘。

**Architecture:** 新增 `src/workflow/readiness.ts`（纯静态就绪探针，复用 `checkFigma`/`resolvePenCliPath`/`jiraConfig`/`activeEntry`，禁 ping/子进程）与 `src/workflow/project-archive.ts`（装配：读 `flows.json`＋批次清单＋登记（用例集/运行→裁决），复用 `runManifestFileNames/loadRunManifest`、`latestFeatures/provenanceOf`、`collectVerdictExits`）；工具定义进 `src/tools/native-tools/workflow.ts`（schema `{}`，spec §7）；usage family 增列。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、zod、node:test。

**Spec:** `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（④ 阶段：D7/D14、§7 `project_archive {}`、§9；三工具×三态不适用于本工具——archive 无前置失败路径，恒 `ok:true`＋`degraded[]`）。

## Global Constraints

- 每任务收尾：`npm run build`＋该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- **只读铁律**：不触网、不跑子进程、不写盘——数据只来自 `flows.json`、批次清单（`design/runs/*.json`）、登记（`store.listCaseSets/listSuiteRuns`）与环境变量/项目 `.env` 的**静态读取**；测试禁 `fetch`（全局替换为抛错）＋调用前后项目目录快照不变。
- **「未复核」不漏标**（D14）：readiness 每项 `verified: false`；**不** ping LLM、**不** 跑 `pen status`；真实复核属流程工具首步，本工具不做。
- **masked 只回预览**：LLM `apiKey`、Jira `email` 一律 `maskSecret`；任何字段不落完整密钥。
- **降级如实**：store 不可用／`flows.json` 坏／清单坏件 → `null` 或计数 ＋ `degraded[]` 中文说明，绝不猜测（不新增任何存储）。
- ESM+NodeNext+strict、相对导入 `.js`；中文文案；默认无注释（契约 JSDoc 例外）；既有面零回归（usage family 只增列，不动既有信号）。

## Review Focus（最可能咬人；测试已归入各任务）

1. **只读铁律**：不触网／无子进程／不写盘——T2 测试禁网＋目录快照＋readiness 不触发 ping（T1）。
2. **「未复核」标注**：每项 `verified:false`；pen 只看静态配置（key/路径/托管存在性），不执行 `pen status`（T1）。
3. **masked 不漏**：`llm.key`＝`****<last4>`、`jira.email` masked；无凭据时字段为 `null` 而非空串（T1）。
4. **降级如实**：store 抛错→对应段 `null`＋`degraded`；坏清单只计数 `unreadable`；坏 `flows.json` 不崩整包（T2）。
5. **口径同源**：来源文案用 `provenanceOf`、用例最新份按 feature.key 首见（列表新→旧）、裁决计数用 `collectVerdictExits`（§13.108 口径）——与既有面逐字一致（T2）。

---

### Task 1: 静态就绪探针（`src/workflow/readiness.ts`）

**Files:**
- Create: `src/workflow/readiness.ts`
- Test: `test/workflow-readiness.test.js`

**Interfaces:**
- Consumes: `checkFigma`（`./setup.js`）、`penEnvFrom/resolvePenCliPath`（`src/pen/cli.js`）、`runtime.jiraConfig()`、`runtime.activeEntry()`、`maskSecret`（`../util.js`）。
- Produces:
```ts
export interface StaticReadinessDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}
export interface ReadinessReport {
  figma: { ready: boolean; missing: string[]; detail: string; verified: false };
  pen: { ready: boolean; detail: string; verified: false };
  jira: { ready: boolean; missing: string[]; site: string | null; email: string | null; detail: string; verified: false };
  llm: {
    ready: boolean; missing: string[]; name: string | null; model: string | null;
    baseUrl: string | null; key: string | null; detail: string; verified: false;
  };
}
export async function staticReadiness(runtime: Runtime, deps?: StaticReadinessDeps): Promise<ReadinessReport>;
```
- 行为钉死：
  - **figma**：`checkFigma(runtime)`；ready=`need===null`；missing=`need?.missing ?? []`；detail `FIGMA_ACCESS_TOKEN 已配置（未复核）`／`缺 FIGMA_ACCESS_TOKEN`。
  - **pen**：`env = penEnvFrom(runtime.project.dotenvValues ?? {}, deps.env ?? process.env)`；`PEN_CLI_KEY` 存在→ready true、detail `PEN_CLI_KEY 已配置（登录状态未复核）`；否则 `cli = resolvePenCliPath(env, deps.platform ?? process.platform, deps.exists ? { exists: deps.exists } : {})`：`source==="env"`→ready true、detail `AOS_PEN_CLI_PATH=${cli.path}（登录状态未复核）`；`source==="managed"`→ready true、detail `托管安装：${cli.path}（登录状态未复核）`；`source==="path"`→ready **false**、detail `未检测到 pen 配置（PATH 兜底未复核；howTo：pen login / 项目 .env 写 PEN_CLI_KEY / AOS_PEN_CLI_PATH；首次调用可自动托管安装）`。
  - **jira**：`config = runtime.jiraConfig()`；ready=`config.configured`；missing=`config.missing`；site=`config.siteUrl`；email=`config.email === null ? null : maskSecret(config.email)`；detail `站点 ${site}（凭证未复核）` 或 `缺 ${missing.join(" / ")}`。
  - **llm**：`entry = await runtime.activeEntry()`；ready=`entry!==null && model/baseUrl/apiKey 均非空`；missing 按缺失列出 `["model"|"base_url"|"api_key"]`；name/model/baseUrl 原样、key=`apiKey===null?null:maskSecret(apiKey)`；detail `条目「${name}」（未复核）` 或 `未配置（aos_configure / 项目 .env）`。
  - 全部 `verified: false`；实现**不得**出现 fetch/child_process。

- [ ] **Step 1: 写失败测试**（stub runtime：`{project:{dotenvValues}, jiraConfig, activeEntry}`）：figma 三态；pen 四态（key／env 路径／托管：`AOS_PEN_CLI_DIR`＋`exists:()=>true`／兜底）；jira configured（site 原样、email `****`尾4）与缺（missing 逐字）；llm 完整（key masked）与缺 key（ready false＋missing）；全项 `verified===false`；全局 `fetch` 替换为抛错（禁网）。
- [ ] **Step 2: 红**（`npm run test:file -- test/workflow-readiness.test.js`）。
- [ ] **Step 3: 实现**。**Step 4: 绿**。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): static readiness probes for project archive"`

---

### Task 2: 档案装配（`src/workflow/project-archive.ts`）

**Files:**
- Create: `src/workflow/project-archive.ts`
- Test: `test/workflow-project-archive.test.js`

**Interfaces:**
- Consumes: `staticReadiness`（T1）、`detectProjectStacks`（`src/projects/stack.js`）、`readFlowDocumentMeta/loadDesignFlowGraph/designDir`（`src/figma/design-store.js`）、`runManifestFileNames/loadRunManifest`（`src/figma/run-manifest.js`）、用例最新份按 feature.key 首见（与 `latestFeatures` 同口径，另带 `createdAt`）、`provenanceOf`（`./case-selection.js`）、`collectVerdictExits`（`src/tasks/verdict-exits.js`）、`resolveProvenance`（`src/provenance.js`）、`errorMessage`。
- Produces:
```ts
export const ARCHIVE_RUNS_LIMIT = 10;
export const ARCHIVE_CASE_SETS_LIMIT = 200;
export const ARCHIVE_VERDICT_RUNS_LIMIT = 200;
export interface ProjectArchiveDeps {
  listCaseSets?: (runtime: Runtime, limit: number) => Promise<CaseSetRecord[]>;
  listRuns?: (runtime: Runtime, limit: number) => Promise<SuiteRunRecord[]>;
  readiness?: typeof staticReadiness;
}
export async function projectArchive(runtime: Runtime, deps?: ProjectArchiveDeps): Promise<CallToolResult>;
```
- payload 钉死（顶层恒 `ok:true`）：
```ts
{
  ok: true,
  project: { name: string; root: string; stacks: Array<{ id: string; displayName: string }> }, // name=path.basename(rootDir)
  design: null | {
    source: string | null;   // "figma:<fileKey>" | "pen:<path>" | null（meta 缺）
    savedAt: string | null;  // flows.json mtime ISO
    screens: number; edges: number; entryScreens: number; unresolved: number;
    provenance: { screens: Record<string, number>; edges: Record<string, number> }; // resolveProvenance 计；缺省计 legacy-unknown
  },
  caseSets: null | {
    total: number; imported: number; generated: number; features: number;
    latest: Array<{ feature: string; cases: number; provenance: string; createdAt: string }>; // 每 feature.key 首见，≤10
  },
  runs: {
    total: number; unreadable: number;
    recent: Array<{ runId: string; source: string; startedAt: string; finishedAt: string; total: number; passed: number; failed: number; gate: "pass" | "fail"; exitCode: number; failureDomains: Record<string, number> }>; // kind==="ok" 的前 10 件
  },
  verdicts: null | { runsScanned: number; caseDefects: number; environment: number; appDefects: number; jiraKeys: number },
  readiness: ReadinessReport,
  degraded: string[]
}
```
- 行为钉死：
  - `design`：`flowsPath = <design>/flows.json`；不存在→`null`；存在但 `loadDesignFlowGraph` 为 null→`null`＋degraded `flows.json 存在但不可解析（已略过设计血统）`；正常→按上形状（`savedAt` 取 `fs.statSync` mtime，读失败→null）；`source` 由 `readFlowDocumentMeta`（penPath 优先→`pen:<path>`，否则 fileKey→`figma:<fileKey>`，都缺→null）。
  - `caseSets`：`(deps.listCaseSets ?? (rt,limit)=>rt.store.listCaseSets(rt.project.rootDir,limit))(runtime, ARCHIVE_CASE_SETS_LIMIT)`；抛错→`null`＋degraded `用例库读取降级：<err>`；否则 imported/generated 按 `source` 前缀 `imported:` 计，`features`=去重 `feature.key` 数，`latest` 按列表序（新→旧）每 key 首见（`provenanceOf(set.source)`、`set.createdAt`）取前 10。
  - `runs`：`runManifestFileNames(configDirAbs)`（新→旧）——`total`=文件数；前 `ARCHIVE_RUNS_LIMIT` 件逐一 `loadRunManifest`：`kind==="ok"`→recent 行（gate=`manifest.gate.result`、exitCode=`manifest.gate.exitCode`、failureDomains=原样），否则 `unreadable++`。
  - `verdicts`：`(deps.listRuns ?? (rt,limit)=>rt.store.listSuiteRuns(rt.project.rootDir,{limit}))(runtime, ARCHIVE_VERDICT_RUNS_LIMIT)`；抛错→`null`＋degraded `裁决摘要读取降级：<err>`；否则 `collectVerdictExits(runs)`→三组长度＋`jiraKeys`=三组中出现过的非空 `jiraKey` 去重数；`runsScanned`=入参行数。
  - `readiness`：`deps.readiness ?? staticReadiness`(runtime)。
  - 只读：除上述读取外无 fetch/child_process/写盘。
- 测试矩阵（temp 目录＋stub runtime＋deps 注入）：
  1. 空项目：`design:null`、`runs:{total:0,unreadable:0,recent:[]}`、`caseSets` 空计数、`verdicts` 0、readiness 全 not ready、`degraded:[]`。
  2. 写一份 figma 形状 `flows.json`（含 explicit/inferred/缺省 provenance 的屏与边、fileKey、entryScreens、unresolved）→ design 段计数/来源/`savedAt`/provenance 三键（含 legacy-unknown）。
  3. 坏 `flows.json`→ design null＋degraded 提及。
  4. 批次清单 3 件（2 件正常、1 件坏 JSON）→ `recent` 2 行（runId/gate/failureDomains 回显）、`unreadable:1`。
  5. caseSets：生成份＋导入份混合、同 featureKey 多份（新→旧）→ `imported/generated/features` 计数、`latest` 首见与 `provenance` 文案（`导入自`/`生成自`）。
  6. verdicts：stub runs（含 verdict + jiraIssueKey 重复项）→ 三组计数与 `jiraKeys` 去重。
  7. store 抛错→对应段 `null`＋`degraded` 两条，其余照常 `ok:true`。
  8. 禁网（全局 fetch 抛错）＋调用前后项目目录文件清单快照一致（不写盘）。
- [ ] **Step 1: 写失败测试**（矩阵 1–8）。**Step 2: 红→实现→绿**。
- [ ] **Step 4: 绿**＋`npm run test:file -- test/workflow-project-archive.test.js test/workflow-case-selection.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(workflow): project_archive read-only summary assembly"`

---

### Task 3: 工具接线＋usage

**Files:**
- Modify: `src/tools/native-tools/workflow.ts`（数组增 `project_archive`）、`src/usage/capture.ts`（`WORKFLOW_TOOL_NAMES`/`NATIVE_TOOL_NAMES` 增列）
- Test: `test/native-workflow-tool.test.js`（追加）、`test/usage-capture.test.js`（追加）

**Interfaces:**
- schema：`z.object({})`（spec §7 `{}`；无参数）。
- 描述必须含字面（测试断言）：`档案`、`只读`、`不触网`、`无子进程`、`不写盘`、`未复核`、`设计血统`、`用例库`、`最近运行`、`裁决`、`前置状态`、`masked`。
- usage：family=`workflow`（两集合增 `project_archive`）；**不新增信号提取**（D12 未列 archive 专用事件）。
- [ ] **Step 1: 写失败测试**：目录含 `project_archive`；schema 无参数（`properties` 为空）；描述字面；harness 内实调 `{}`→`ok:true` 且非 isError（harness 项目为临时目录，只读安全）；usage `usageFamilyOf("project_archive")==="workflow"`。
- [ ] **Step 2: 红→实现→绿**＋`npm run test:file -- test/native-workflow-tool.test.js test/usage-capture.test.js test/server-smoke.test.js`。
- [ ] **Step 5: 提交**：`git commit -m "feat(tools): expose project_archive (read-only)"`

---

### Task 4: 文档＋全量

**Files:**
- Modify: `README.md`（工具表 `project_archive` 行）、`AGENTS.md`（设计流水线段一句：档案入口）、`DESIGN.md`（§13.122 实施记录：范围、口径（只读/未复核/masked/降级/口径同源）、测试数）。

- [ ] **Step 1: 文档三处**（与 T2 payload 口径一致）。
- [ ] **Step 2: 全量回归** `npm run build && npm test && npm run lint`。
- [ ] **Step 3: 残留扫描**（新文件无 `fetch`/`child_process`/`writeFile`，确认只读铁律；新工具名装配点对照）。
- [ ] **Step 4: 提交**：`git commit -m "docs: project_archive (unified service ④) record"`

---

## Self-Review 记录（写稿人自查）

- **Spec 覆盖**：D7 六段（项目与栈/设计血统/用例库/最近运行/裁决与 Jira/前置状态）→T2/T1；D14（静态＋未复核＋无子进程）→T1/T2；§7 `project_archive {}`→T3；§9（archive 不适用三态；只读）→T2 矩阵 8；`design` 缺源文件→null 不误报。
- **类型一致性**：`ReadinessReport`/`ProjectArchiveDeps`/常量跨任务同名；`CaseSetRecord`/`SuiteRunRecord` 沿用既有类型；`collectVerdictExits` 入参形状与 `SuiteRunRecord` 兼容（featureKey/caseSetId/cases 字段齐）。
- **比例**：4 任务；T2 行为矩阵 8 例；无整段实现转写；payload 钉死字段树供实现与测试共用。
- **留白（随实现/复核收敛）**：`degraded` 文案措辞、`latest` 条数上限 10、`unreadable` 是否含 `newer`（本稿计入）、pen 兜底态文案——均在行为处写明，复核可调。

## Execution Handoff

计划就绪。建议 **Native（executing-plans）**：T1→T2 强顺序（T2 消费 T1 接口）、T3 接线、T4 收尾；每任务独立测试、最终全量兜底。请审阅计划——确认后选择执行方式（Native／Subagent-driven）。
