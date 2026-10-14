# 回归服务 P3b 实施计划（改进出口接线：生成反馈联路 / 环境清单 / Jira 一键建单）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把归因裁决的三个改进出口接线：案例问题→生成侧呈现反馈（不自动改）；执行偏差→环境改进清单（视图＋导出）；应用缺陷→面板一键建 Jira 单（证据＋回写单号）。

**Architecture:** 出口聚合收敛为共享模块（`src/tasks/verdict-exits.ts`，单一事实源，收编面板与 feedback 既有两处重复循环）；面板动作层增 `POST /panel/api/issues`（HTTP 模式注入懒建 Runtime 缝；Jira 证据走自 `jiraEvidencePost` 提取的服务层）；生成侧（`figma_generate_tests`）只读消费案例问题反馈并如实呈现（响应块＋tests.md 段），不静默自动改。

**Tech Stack:** TypeScript ESM（NodeNext/strict）＋ Node test runner；pg-mem/内存 store；既有 `src/jira/*` 客户端；面板服务端渲染零依赖。

**Spec:** `docs/superpowers/specs/2026-10-14-regression-service-p3b-design.md`（决策 D1–D10 的权威来源；总体设计见 `2026-10-14-regression-service-design.md` §5.4/§5.7）

## Global Constraints

- 测试口径（仓库硬性）：pg-mem、内存 store、假 Jira（注入 client/证据函数）、假子进程、不触真实 PG/设备/外网；测试跑 `dist/`（改动先 `npm run build`）；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- stdout 属于 MCP stdio：面板动作走 HTTP 响应、CLI 输出照旧（`io.log`）。
- 动作层口径沿用 P1c：`AOS_PANEL_ACTIONS=0` 整体关闭；body ≤256KB；写成功清面板缓存；错误不泄露底层原文（详情仅日志）；**v1 内网无鉴权**（一键建单＝外部副作用，README/DESIGN 点名）。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN.md（新增 §13.111）＋ README ＋ AGENTS.md ＋ `.env.example`。
- **拍板（设计 D1–D10，摘要）**：D1 生成侧只呈现不改产物；D2 共享聚合单一事实源＋`suite feedback` 扩导出（不新增子命令）；D3 建单粒度＝每条一张；D4 新增 `suite_run_cases.jira_issue_key`（MIGRATIONS）；D5 Jira 默认值项目 `.env`（`JIRA_ISSUE_PROJECT`/`JIRA_ISSUE_TYPE`(默认 Bug)/`JIRA_ISSUE_LABELS`），payload 优先；D6 证据 best-effort；D7 环境清单按 (device, platform) 分组；D8 面板经 HTTP 注入 `runtimeFor` 拿 Runtime，证据服务层同源；D9 建单准入：存在且 `status ≠ passed`，既有裁决 ≠ app-defect → skipped，无裁决允许；D10 无功能段允许建单（模板省略），证据「路径必附、URL 尽力」。

## Review Focus

1. **Jira 未配置/失败**：未配置 → 400＋指引且不触网；create 失败 → 该条 `error`、**不回写单号**、不误报 created；429 走既有有界等待。
2. **重复建单**：已有 `jira_issue_key` → `existing` 直接返回（顺序重复幂等）；**并发双开为已接受限制**（内网单操作员，与 tasks 路由「重复提交不幂等」同口径，文档点名）。
3. **越权/坏输入**：跨项目 runId、未知 run/case、items>20、labels 类型错误 → 先校验后建单（不允许部分副作用后才发现格式错），400/skipped 语义明确。
4. **注入转义**：用例名/备注/单号进入面板 HTML 与 JS 上下文均转义（`escapeHtml`＋`JSON.stringify` 嵌入）。
5. **生成侧降级**：store 不可用/无匹配功能 → 响应省略 `feedback` 块（＋warning），生成与落盘不受影响。

---

### Task 1: store——`jira_issue_key` 列 + `setCaseIssueKey` + `getSuiteRun`

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-suite-runs.test.js`（追加）

**Interfaces:**
- Produces：
  ```ts
  // types.ts：SuiteRunCaseRecord 增字段
  jiraIssueKey: string | null;
  export interface SetCaseIssueKeyInput {
    rootPath: string; runId: string; caseId: string; jiraKey: string | null;
  }
  // ProjectStore 新增：
  setCaseIssueKey(input: SetCaseIssueKeyInput): Promise<boolean>;   // 项目作用域校验；`null` 清空；未命中 → false
  getSuiteRun(rootPath: string, runId: string): Promise<SuiteRunRecord | null>;  // 含 cases；项目作用域
  ```
- 语义：`setCaseIssueKey` 完全镜像 `updateCaseVerdict`（`src/db/postgres.ts:887`）的项目作用域子查询形状；`getSuiteRun`＝`SELECT * FROM suite_runs WHERE id=$1 AND project_id=$2` ＋ 既有 cases 读取（`postgres.ts:879` 同款）；memory 同语义（找不到 → null）。

- [ ] **Step 1: 写失败测试**（`test/db-suite-runs.test.js`；memory + pg-mem 双跑，沿用该文件既有 fixture 模式）
  - `setCaseIssueKey：写入后可经 getSuiteRun 读回（jiraIssueKey===key）；null 清空；未知 run/case → false；跨项目 rootPath → false（先给对方项目也建一份同名 run 场景或断言 false——按该文件既有跨项目模式）`。
  - `getSuiteRun：返回含 cases 的运行；未知 id → null；项目不匹配 → null`。
  - `迁移：存量库（无列）启动后 setCaseIssueKey 可用`（pg-mem 建旧表→跑 MIGRATIONS 的同款既有模式；若该文件无先例，随 Task 1 一并示例）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-suite-runs.test.js`。
- [ ] **Step 3: 实现**
  - DDL：`suite_run_cases` CREATE 内 `verdict_note TEXT,` 后加 `jira_issue_key TEXT,`。
  - MIGRATIONS 追加：`` `ALTER TABLE suite_run_cases ADD COLUMN IF NOT EXISTS jira_issue_key TEXT` ``。
  - 行映射：`jiraIssueKey: nullableString(row.jira_issue_key)`（与既有 verdict 字段同款）。
  - postgres/memory 实现两个新方法（镜像既有写法；memory 的 `getSuiteRun` 深拷贝 cases）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): jira_issue_key + setCaseIssueKey + getSuiteRun (store)"`

### Task 2: 共享出口聚合 `src/tasks/verdict-exits.ts`＋收编既有两处

**Files:**
- Create: `src/tasks/verdict-exits.ts`
- Modify: `src/panel/overview.ts`（`buildPanelStatsView` 改用共享模块；`PanelImprovementItem` 扩展）、`src/figma/generation-feedback.ts`（`collectVerdictSuggestions` 改用共享模块）
- Test: `test/verdict-exits.test.js`（新）；回归锁 `test/panel-stats.test.js`、`test/generation-feedback.test.js`

**Interfaces:**
- Consumes：Task 1 的 `SuiteRunCaseRecord.jiraIssueKey`。
- Produces：
  ```ts
  export interface VerdictExitCase {
    runId: string; caseId: string; name: string;
    featureKey: string | null; featureName: string | null;
    platform: string; device: string | null;
    traceId: string | null; verdictAt: string | null; note: string | null;
    jiraKey: string | null;
  }
  export interface VerdictEnvironmentGroup {
    device: string | null; platform: string; count: number;
    features: string[]; lastAt: string | null; notes: string[];
  }
  export interface VerdictExits {
    caseDefects: VerdictExitCase[];
    environment: VerdictEnvironmentGroup[];
    appDefects: VerdictExitCase[];
  }
  /** 最新裁决口径（与 §13.108 统计口径逐字一致）：入参自排 createdAt 新→旧；
   * 按（caseSetId ?? "" + "|" + caseId）首见即最新；caseDefects/appDefects 按 caseId 升序
   * （tie → featureName 升序 → runId 升序）。 */
  export function collectVerdictExits(runs: Array<{
    id: string; createdAt: string; caseSetId: string | null;
    featureKey: string | null; featureName: string | null;
    platform: string; device: string | null;
    cases: Array<{
      caseId: string; name: string; featureKey: string | null; platform: string;
      status: string; traceId: string | null;
      verdict: string | null; verdictAt: string | null; verdictNote: string | null;
      jiraIssueKey: string | null;
    }>;
  }>): VerdictExits;
  ```
- 语义：
  - 入口排序：`[...runs].sort((a,b) => b.createdAt.localeCompare(a.createdAt))`（稳定 tie 保持入参序）。
  - `caseDefects`＝verdict `"case-defect"`；`appDefects`＝`"app-defect"`；其余（execution-deviation/uncertain）不进 1/3 清单。
  - `environment`：对 verdict `"execution-deviation"` 的条目按 `${device ?? ""}|${platform}` 分组；`count` 条目数；`features`＝`featureName ?? featureKey ?? caseId` 去重字典序；`lastAt`＝组内非空 `verdictAt` 最大（ISO 字符串比较）；`notes`＝非空 note 去重（按入参自排后的出现序，新→旧）；组排序：count 降序 → device 升序（null 视为 ""）→ platform 升序。
  - 面板扩展：`PanelImprovementItem` 增 `runId: string; platform: string; device: string | null; traceId: string | null; jiraKey: string | null`；`PanelStatsView.improvement` 形状变为：
    ```ts
    improvement: { caseDefects: PanelImprovementItem[]; environment: VerdictEnvironmentGroup[]; appDefects: PanelImprovementItem[] }
    ```
    （environment 由条目列表改为**分组列表**——`test/panel-stats.test.js` 针对该形状的断言随更新，数量与统计口径不变，其余断言为回归锁；`guidance` 文案结构保留，P3「后续接线」句本任务先保留、Task 5 移除）
  - `collectVerdictSuggestions`：改为取 `listSuiteRuns(limit 50)`（本任务暂保留独立取数窗口，行为最小变化）→ `collectVerdictExits` → 按 `featureKey ?? featureName` 分组的 `caseDefects`；消息文本本任务保持现状（caseId 列表），Task 6 再增强名称与备注。

- [ ] **Step 1: 写失败测试**（`test/verdict-exits.test.js`）
  - `最新裁决：同（份,用例）多条 → 取最新非空（入参乱序亦自排）`。
  - `caseDefects/appDefects 过滤与排序（caseId 升序；tie 决出）`。
  - `environment 分组：device+platform、count、features 去重字典序、lastAt 取最大、notes 去重保序`。
  - `空 runs → 三清单为空数组`；`verdict 为 null 跳过`；`jiraKey 透传`。
- [ ] **Step 2: 跑测试确认失败** + `npm run test:file -- test/panel-stats.test.js && npm run test:file -- test/generation-feedback.test.js`（先看既有锁现状）。
- [ ] **Step 3: 实现**（按「语义」；`buildPanelStatsView`/`collectVerdictSuggestions` 改为消费共享模块，删除本地重复循环）。
- [ ] **Step 4: 跑测试确认通过**（新测试 + 两个回归锁全绿）。
- [ ] **Step 5: 提交**：`git commit -m "refactor(panel): shared verdict exits aggregation (single source)"`

### Task 3: Jira 服务层提取＋建单模板

**Files:**
- Create: `src/jira/resolve.ts`、`src/jira/post.ts`、`src/jira/issue-template.ts`
- Modify: `src/tools/jira.ts`（`clientFor`/`missingConfigResult`/`jiraEvidencePost` 改为薄封装）
- Test: `test/jira-issue-template.test.js`（新）；回归锁 `test/jira-tools.test.js`、`test/jira-evidence.test.js`

**Interfaces:**
- Produces：
  ```ts
  // src/jira/resolve.ts（自 tools/jira.ts 逐字迁移 clientFor）
  export function resolveJiraClient(runtime: Runtime): { client: JiraClient; siteUrl: string } | null;
  export function jiraMissingConfigPayload(runtime: Runtime): { ok: false; error: string; howToFix: string[] };

  // src/jira/post.ts（自 jiraEvidencePost 提取主体，输出 payload 与现工具 JSON 形状一致）
  export interface JiraEvidencePostArgs { key: string; traceId: string; platform?: "android" | "ios"; deviceSerial?: string; dryRun?: boolean; }
  export async function postEvidenceToIssue(runtime: Runtime, args: JiraEvidencePostArgs): Promise<Record<string, unknown>>;

  // src/jira/issue-template.ts
  export interface RegressionIssueFacts {
    projectName?: string | null;
    runId: string; taskId?: string | null;
    featureName?: string | null;
    platform: string; device?: string | null; appVersion?: string | null; runAt?: string | null;
    caseId: string; caseName: string;
    failureDomain?: string | null; failureConfidence?: string | null; failureReason?: string | null;
    traceId?: string | null;
    evidencePaths: string[]; artifactUrl?: string | null;
    verdictNote?: string | null;
  }
  export function buildRegressionIssueSummary(facts: RegressionIssueFacts): string;
  export function buildRegressionIssueDescription(facts: RegressionIssueFacts): AdfNode;
  ```
- 语义：
  - `resolveJiraClient`/`jiraMissingConfigPayload`：与现 `clientFor`/`missingConfigResult` 逐字一致（消息与 howToFix 文本不变——`test/jira-tools.test.js` 为锁）。
  - `postEvidenceToIssue`：把 `jiraEvidencePost` 函数体（凭证检查 → key 解析 → trace 存在性 → `traceEvidence` → 证据评论幂等＋附件去重 → 返回 JSON payload）原样迁入；**返回普通 payload 对象**（含 `ok` 及既有字段；错误分支含 `error`＋必要时 `hints`/`howToFix`），不再包 `CallToolResult`。工具侧：`jsonResult(await postEvidenceToIssue(runtime, args), payload.ok === false)`——输出与现状一致（锁测试保障）。
  - `buildRegressionIssueSummary`：`[回归] ${featureName ? `${featureName} · ` : ""}${caseName} 失败`（D10：无功能段省略功能段）。
  - `buildRegressionIssueDescription`：ADF 文档＝标题段（summary 同文）＋ bullet 事实（项目名/运行 ID/任务 ID/用例 ID＋名/端/设备/应用版本/运行时间/失败域（置信）/失败理由/traceId/裁决备注/证据路径（逐条）/产物 URL）；空字段省略；文本中不带 token。实现用 `src/jira/adf.ts` 的 `adfDoc`/`adfParagraph`/`adfBulletList`。
- [ ] **Step 1: 写失败测试**（`test/jira-issue-template.test.js`：summary 有无功能段两态；description 文本含各事实、空字段省略、ADF 形状 `{type:"doc","content":[…]}` 且可 JSON 序列化）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（迁移＋模板；tools/jira.ts 改薄封装；`clientFor`/`missingConfigResult` 删除本地定义改 import）。
- [ ] **Step 4: 跑测试确认通过** + `npm run test:file -- test/jira-tools.test.js && npm run test:file -- test/jira-evidence.test.js`（逐字回归锁）。
- [ ] **Step 5: 提交**：`git commit -m "refactor(jira): extract evidence core + regression issue template"`

### Task 4: 面板动作——`POST /panel/api/issues` 建单核心与路由

**Files:**
- Create: `src/panel/issues.ts`
- Modify: `src/panel/actions.ts`（路由分支）、`src/panel/web.ts`（`PanelWebDeps` 增 `runtimeFor`）、`src/http-server.ts`（注入 `runtimeFor: deepRuntimeFor`）
- Test: `test/panel-actions.test.js`（追加）

**Interfaces:**
- Consumes：Task 1（`getSuiteRun`/`setCaseIssueKey`）、Task 3（`resolveJiraClient`/`postEvidenceToIssue`/模板）。
- Produces：
  ```ts
  // src/panel/issues.ts
  export interface IssueClientLike {
    createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }>;
  }
  export interface CreateIssuesOptions {
    store: ProjectStore;
    runtimeFor?: (rootPath: string) => Promise<Runtime | null>;   // 缺省 → 无 Runtime，返回指引错误
    clientFor?: (runtime: Runtime) => { client: IssueClientLike; siteUrl: string } | null;  // 缺省 resolveJiraClient
    postEvidence?: (runtime: Runtime, args: JiraEvidencePostArgs) => Promise<Record<string, unknown>>;  // 缺省 postEvidenceToIssue
  }
  export type IssueItemStatus = "created" | "existing" | "skipped" | "error" | "preview";
  export interface IssueItemResult {
    runId: string; caseId: string; status: IssueItemStatus;
    key?: string; url?: string;
    evidence?: "posted" | "skipped" | "error";
    summary?: string; attachments?: string[];        // dryRun 预览
    reason?: string;                                  // skipped/error 归因（中文短语）
  }
  export type IssuesOutcome =
    | { ok: true; results: IssueItemResult[]; created: number; existing: number; skipped: number; failed: number }
    | { ok: false; error: string; hints?: string[] };
  export async function createRunCaseIssues(
    options: CreateIssuesOptions,
    input: {
      rootPath: string;
      items: Array<{ runId: string; caseId: string }>;
      projectKey?: string; issueType?: string; labels?: string[]; summary?: string; dryRun?: boolean;
    }
  ): Promise<IssuesOutcome>;
  ```
- 语义（逐条，顺序处理；第一条失败不阻断后续）：
  1. **前置解析**（整请求一次）：runtime＝`runtimeFor(rootPath)`；null → `{ok:false, error:"项目运行时不可用（仅 HTTP 模式支持建单）"}`。`clientFor(runtime)` null → `{ok:false, error:"尚未配置 Jira 凭证…", hints:[…]}`（复用 `jiraMissingConfigPayload` 的 error/howToFix 文本）。`projectKey`＝input ?? `runtime.project.resolver.getValue("JIRA_ISSUE_PROJECT").value`；仍空 → `{ok:false, error:"缺少 Jira 项目 key（payload.projectKey 或项目 .env JIRA_ISSUE_PROJECT）"}`。`issueType`＝input ?? resolver `JIRA_ISSUE_TYPE` ?? `"Bug"`；`labels`＝input ?? resolver `JIRA_ISSUE_LABELS` 逗号拆分 ?? `[]`（去空串）。
  2. **逐条**：`store.getSuiteRun(rootPath, runId)` → null 或 case 不存在 → `status:"skipped", reason:"未知运行或用例"`；case `status === "passed"` → `skipped, reason:"用例已通过，无需建单"`；verdict 非空且 ≠ `"app-defect"` → `skipped, reason:`裁决为 ${verdict}，与建单不符``；`jiraIssueKey` 非空 → `status:"existing"`＋key/url（`siteUrl + "/browse/" + key`）。
  3. `dryRun` → `status:"preview"`＋`summary`（模板）＋`attachments`（`postEvidence` 以 `dryRun:true` 调用并取 payload 的候选附件名列表；无 trace → `[]`；**不触网**）。
  4. 建单：`client.createIssue({ project: { key: projectKey }, issuetype: { name: issueType }, summary, description: buildRegressionIssueDescription(facts), labels })`；`summary`＝input.summary ?? 模板。`facts` 组装：run（featureName/device/appVersion/startedAt/regressionTaskId）＋case（name/failureDomain/failureConfidence/failureReason/traceId）＋证据路径（trace 目录；尽力，同归因队列口径）＋artifactUrl（尽力：经 regressionTaskId → runners.artifact_base_url 拼接，缺则 null——口径同面板 `artifactUrl`）＋verdictNote。create 抛错 → `status:"error", reason: errorMessage`（不回写）。
  5. 证据：`traceId` 非空 → `postEvidence(runtime, { key, traceId, platform, deviceSerial: device, dryRun:false })`；payload.ok !== true → `evidence:"error"`（建单保持 created）；无 trace → `skipped`；成功 → `posted`。
  6. 回写：`store.setCaseIssueKey({ rootPath, runId, caseId, jiraKey: key })` best-effort（失败仅日志，不改变结果）。
  7. 汇总：`ok:true`＋计数（preview 不计入 created/existing/skipped/failed）。
- 路由（`actions.ts`）：`/panel/api/issues` → 解析：`items` 数组（元素 runId/caseId 非空字符串，≤20，非法项忽略后为空 → 400）；`projectKey/issueType/summary` 字符串或 undefined；`labels` ＝ string[]（非空元素）或逗号串；`dryRun` boolean；否则 400。`deps.runtimeFor` 透传；`!outcome.ok` → 400（clientFor 未配置含 hints → 一并回传）；成功且 created+existing>0 → `deps.cache?.clear()`；响应 200 outcome。异常 → 既有 500 通用形状。
- [ ] **Step 1: 写失败测试**（`test/panel-actions.test.js` 追加；假 store（内存）＋假 runtimeFor/clientFor/postEvidence 注入）
  - `成功：createIssue 收到模板字段；postEvidence 收到 key/trace；setCaseIssueKey 落库；响应 created=1＋url；缓存清空（既有 cache 假体断言）`。
  - `existing：预置 jiraIssueKey → 不调 createIssue，status existing`。
  - `skipped：未知 run/case；passed；verdict=case-defect 冲突`——三种 reason；不触 Jira。
  - `dryRun：不调 createIssue/postEvidence 网络面（dryRun 证据以 dryRun:true 调用）；返回 preview＋summary`。
  - `未配置 Jira → ok:false error 含 JIRA_BASE_URL；runtimeFor 缺失 → ok:false 指引`。
  - `projectKey 缺省经 resolver 取 JIRA_ISSUE_PROJECT；issueType 缺省 Bug；labels 逗号解析/去重`。
  - `部分失败容忍：第 1 条 create 抛错 error、第 2 条成功 created；计数正确`。
  - `items 超 20 → 400；labels 非字符串类型 → 400`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/panel-actions.test.js`。
- [ ] **Step 3: 实现**（按「语义」；路由分支插入既有 `handlePanelActionRequest` 的 path 分派）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): one-click Jira issue creation action (/panel/api/issues)"`

### Task 5: 面板渲染——环境清单表＋建单 UI

**Files:**
- Modify: `src/panel/web.ts`
- Test: `test/panel-web.test.js`（追加）

**Interfaces:**
- Consumes：Task 2（`PanelImprovementItem` 扩展字段）、Task 4（路由形状）。
- 渲染（stats 视图「改进出口」区）：
  - 案例问题：列表保持（caseId＋名＋功能），指引行改「修订用例期望后重新生成（`figma_generate_tests` / pen 生成工具）；重新生成时响应与 tests.md 会附上轮案例问题提示。」
  - **环境改进清单**（新表格）：列＝设备（null → `—`）/端/次数/涉及功能/最近裁决/备注摘要（多条以 `；` 连接，截断 ~120 字）；空态「无执行偏差裁决」。
  - 应用缺陷：每行前加 checkbox（value=`runId|caseId`，转义）；行显示 key chip（`jiraKey` 非空 → `<a href="siteUrl/browse/KEY">`——siteUrl 无面板侧来源时退化为纯文本 KEY）；区尾内联表单：projectKey（placeholder `默认 JIRA_ISSUE_PROJECT`）/issueType（placeholder `Bug`）/labels（placeholder 逗号分隔）/按钮「预览」「建单」→ `submitIssues(event, dryRun)`：收集勾选 → `POST /panel/api/issues`（`{project, items, projectKey?, issueType?, labels?, dryRun}`）→ 结果渲染到 `<div id="issues-result">`（逐条：key 链接 / reason / error）；成功（非 dryRun）后 `location.reload()`。
  - 移除「自动化（P3）…后续接线」指引行。
- [ ] **Step 1: 写失败测试**（`test/panel-web.test.js`）
  - `环境清单表格：设备/端/次数/最近/备注渲染；空态`。
  - `应用缺陷行：checkbox、已建单 chip（key）；表单字段与按钮存在`。
  - `JS：submitIssues 函数存在且 URL/字段名正确；HTML 转义（名称注入 <script> 不裸出）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（服务端渲染＋既有内联 JS 模式扩展；全部字段 `escapeHtml`，JS 数据 `JSON.stringify`）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): improvement exits UI (environment list + issue creation)"`

### Task 6: `suite feedback`——出口导出与建议增强

**Files:**
- Modify: `src/figma/generation-feedback.ts`、`src/suite-command.ts`
- Test: `test/generation-feedback.test.js`、`test/suite-command.test.js`（追加）

**Interfaces:**
- Consumes：Task 2（`collectVerdictExits`）、Task 1（`jiraIssueKey`）。
- Produces：
  ```ts
  // generation-feedback.ts
  export interface GenerationFeedback {
    …现状字段;
    exits?: VerdictExits;    // store 不可读 → 省略（不置 null；ok 不受影响）
  }
  // suite-command.ts：suiteFeedback 输出
  //   --json：feedback 对象（含 exits）
  //   文本：建议后追加——
  //   出口清单（按最新裁决）：
  //   - 案例问题：3 条（功能：登录、设置）
  //   - 执行偏差：2 条（设备：emulator-5554(1)、R58M(1)）
  //   - 应用缺陷：1 条（已建单 1）
  ```
- 语义：
  - `buildGenerationFeedback`：在 `suggestions` 组装前取 `exits`：`listSuiteRuns(rootDir, { limit: 100 })` → `collectVerdictExits`；成功 → `exits`；抛错 → 省略（沿用静默降级口径，不新增 error）。`collectVerdictSuggestions` 改为**消费同一份 exits**（去掉独立的 50 取数窗口）：分组按 `featureKey ?? featureName ?? "未分组"`，消息：`功能「X」有 N 条用例被判案例问题（case-a「名称A」（备注摘要）；case-b「名称B」…），建议下一轮重新生成该功能用例。`（备注截断 40 字；无备注省略括号）。
  - 文本输出：三行（案例问题功能列表去重、执行偏差 `device(count)` 列表、应用缺陷条数＋已建单数）；全空 → `出口清单为空（暂无已裁决失败）。`
- [ ] **Step 1: 写失败测试**
  - `generation-feedback：exits 形状（caseDefects/environment/appDefects；jiraKey 透传）；store 抛错 → exits 省略且 ok true`。
  - `verdict 建议：含用例名与备注摘要（截断）；无备注不产生空括号`。
  - `suite-command：--json 含 exits；文本含「出口清单」三行；空态行`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): verdict exits in feedback (JSON + text export)"`

### Task 7: 生成侧消费——响应 `feedback` 块＋tests.md 段

**Files:**
- Modify: `src/figma/generation-feedback.ts`（新增读函数）、`src/figma/test-gen.ts`（响应块＋markdown 渲染＋两处落盘调用）
- Test: `test/generation-feedback.test.js`、`test/figma-testgen.test.js`（追加；`test/figma-test-screens.test.js` 为 renderMarkdown 回归锁）

**Interfaces:**
- Consumes：Task 2（`collectVerdictExits`）。
- Produces：
  ```ts
  // generation-feedback.ts
  export interface CaseDefectFeedback {
    byFeature: Array<{
      featureKey: string; featureName: string | null; count: number;
      cases: Array<{ caseId: string; name: string; note: string | null }>;
    }>;
  }
  /** 案例问题反馈（按 featureKey 分组；store 不可用 → null；供生成侧只读消费）。 */
  export async function collectCaseDefectFeedback(runtime: Runtime): Promise<CaseDefectFeedback | null>;

  // test-gen.ts：figmaGenerateTests 响应增（仅当 matched 非空）
  feedback: {
    caseDefects: {
      total: number;                       // 匹配到本次生成功能的用例数
      byFeature: CaseDefectFeedback["byFeature"];   // 过滤到本次 features 的 keys
    };
  };
  // renderMarkdown 第三参扩展（可选，向后兼容）：
  //   { images?, feedback?: CaseDefectFeedback }
  ```
- 语义：
  - `collectCaseDefectFeedback`：`listSuiteRuns(rootDir, { limit: 100 })`（try/catch → null）→ `collectVerdictExits` → `caseDefects` 按 `featureKey` 非空分组（featureName 取组内首个非空；cases 去重按 caseId；排序 featureKey 升序、cases caseId 升序）。
  - `figmaGenerateTests`：在 payload 组装前取 feedback；`features`（本次生成）的 key 集合过滤 `byFeature`；matched 空 → 不加字段；`collectCaseDefectFeedback` 返回 null → `warnings` 追加 `"案例问题反馈读取失败（跳过；不影响生成）"`（沿用 warnings 数组合并口径）。
  - `renderMarkdown`：`feedback` 非空时在用例清单后追加段：
    ```md
    ## 上轮案例问题修订提示（裁决反馈）

    - 功能「登录」：2 条（case-a「验证码登录」；备注：期望文案有误）（case-b「密码登录」）
    ```
    （仅列 matched 的 byFeature；无 feedback 或空 → 不出现该段。）
  - 两处 markdown 落盘调用（主路径 `test-gen.ts:1121`、子集路径 `:1165`）同参传 `feedback`。
- [ ] **Step 1: 写失败测试**
  - `collectCaseDefectFeedback：分组/排序/备注；store 抛错 → null`。
  - `figmaGenerateTests：存在匹配裁决 → 响应 feedback.caseDefects（total/byFeature 过滤）；无匹配 → 无字段；store 抛错 → warnings 标注且生成照常`。
  - `renderMarkdown：带 feedback → 段渲染；不带 → 无段（既有截图测试不回归）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**（含 `npm run test:file -- test/figma-test-screens.test.js`）。
- [ ] **Step 5: 提交**：`git commit -m "feat(figma): surface case-defect verdict feedback on regeneration"`

### Task 8: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`（§13.111）、`README.md`、`AGENTS.md`、`.env.example`

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.111：P3b 实施记录（共享出口聚合/D9 准入/证据服务层同源/runtimeFor 缝/`jira_issue_key`/生成侧只读呈现/CLI 导出/面板 UI；风险：一键建单外部副作用＋并发双开接受口径）。
  - README：回归服务面板段（出口清单/一键建单/`JIRA_ISSUE_*` 默认值）；`suite feedback` 说明补出口清单。
  - AGENTS.md：Jira 接入行补「面板一键建单」；面板行补建单路由；`.env.example` 增 `JIRA_ISSUE_PROJECT/TYPE/LABELS`（注释说明可选）。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P3b (improvement exits)"`

---

## 范围外（另立计划）

- P3c：跨项目对比。P3d：动作层与产物服务鉴权升级。
- 重跑本条/隔离的真动作；Issue 级 JQL 去重；批量合并单；自动重生成；LLM 辅助修订（设计 §3）。
- 调度增强（cron/每日定点等，§13.110 backlog）。
