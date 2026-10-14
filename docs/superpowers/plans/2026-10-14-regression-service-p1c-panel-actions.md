# 回归服务 P1c：面板动作层（回归引用 / 任务页 / 归因队列 / 统计下钻 / 裁决写库）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给只读面板长出"动作层"：网页上勾选引用份创建回归任务、看任务执行与对比、对失败用例裁决归因（写 `suite_run_cases.verdict`）、看功能/用例/归因统计与改进清单；只读层语义不破坏。

**Architecture:** 新增 `src/panel/actions.ts`（POST `/panel/api/*`，仅 HTTP 模式接线，`AOS_PANEL_ACTIONS=0` 关闭）与 `src/panel/stats.ts`（纯聚合）；`web.ts` 增 `task`/`review`/`stats` 三个视图与内联 vanilla JS 表单；`overview.ts` 增 `regressionRefs`/任务列表/任务详情/归因队列/统计聚合（只读层，无子进程/无网络/无写盘不变）；`ProjectStore` 增 `updateCaseVerdict`；`generation-feedback.ts` 增裁决维度建议（按需计算，无新存储）。

**Tech Stack:** TypeScript（ESM + NodeNext + strict）；node:test（跑 `dist/`）；pg-mem；服务端渲染 HTML + 内联 vanilla JS（零前端构建，沿用现有 `PAGE_CSS`）。

**Spec:** `docs/superpowers/specs/2026-10-14-regression-service-design.md`（§5.4/§5.7/§5.8）。前置：P1a/P1b 已交付（case_sets、suite_runs/suite_run_cases 含 verdict 列、任务 CLI）。

## Global Constraints

- `npm run build && npm test && npm run lint` 全绿（测试跑 dist）。
- **只读层语义不变**：`buildPanelOverview`/`ProjectDetail`/`BatchDetail` 仍无子进程/无网络/无写盘；写操作全部走 `actions.ts`（独立 handler）。
- 动作层**仅 HTTP 模式**（`http-server.ts` 接线）；独立 `panel --web` 保持只读（无 Runtime/写面）。
- v1 内网无鉴权（设计定论）——落实**风险标注**（页面/README/DESIGN）+ `AOS_PANEL_ACTIONS=0` 运维兜底开关。
- 写接口校验：未知项目 404 / 非法 body 400 / 非 POST 405；错误 JSON 化，不 500 裸露。
- 用户可见文案中文；代码标识符英文；相对导入带 `.js`。
- 行为变更同步 `DESIGN.md` 与 `README.md`。

## Review Focus

1. 动作层安全面：无鉴权下的写接口仅限本工具用途（任务创建/裁决）；`AOS_PANEL_ACTIONS=0` 全关；body 大小/字段白名单校验；不泄露密钥（响应不含 token）。
2. 视图参数解析：`task`/`view=review|stats` 与既有 `batch`/`limit`/`ios` 参数共存；未知 task → 404；参数互斥时的优先级钉死。
3. 裁决写库：`updateCaseVerdict` 未知 case → false（400）；重复裁决覆盖（幂等）且 `verdictAt` 更新；`listSuiteRuns` 读回一致。
4. 统计确定性：`buildRegressionStats` 同输入同输出（排序钉死）；空 runs/无 verdict 不崩。
5. 内联 JS：无 JS 时显式提示行（"需启用 JavaScript 提交（或使用 `suite task create`）"）；XSS：所有用户数据经 `escapeHtml`（含 task id / 路径 / 裁决备注回显）。

---

### Task 1: 裁决写入 store（`updateCaseVerdict`）

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`
- Modify: `src/db/memory.ts`
- Modify: `test/db-suite-runs.test.js`

**Interfaces:**
- Produces（`src/db/types.ts`）：
  ```ts
  export type CaseVerdict = "case-defect" | "execution-deviation" | "app-defect" | "uncertain";
  export interface UpdateCaseVerdictInput {
    rootPath: string; runId: string; caseId: string;
    verdict: CaseVerdict; verdictBy?: string | null; verdictNote?: string | null;
  }
  // ProjectStore 增：
  updateCaseVerdict(input: UpdateCaseVerdictInput): Promise<boolean>; // 未命中 false；幂等覆盖
  ```
- 写口径：`UPDATE suite_run_cases SET verdict=$3, verdict_by=$4, verdict_at=$5, verdict_note=$6 WHERE run_id=$1 AND case_id=$2`（`verdict_at`＝当前 ISO）；memory 同语义（查找 run.cases 内 caseId → 覆盖四字段）。

- [ ] **Step 1: 写失败测试**（`test/db-suite-runs.test.js` 追加）
  - `updateCaseVerdict: pg-mem + memory 往返（裁决落库、listSuiteRuns 读回、重复覆盖更新 verdictAt）`。
  - `updateCaseVerdict: 未知 run/case → false`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-suite-runs.test.js`。
- [ ] **Step 3: 实现**（types + postgres + memory）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): case verdict write (updateCaseVerdict)"`

### Task 2: 统计聚合纯函数 `panel/stats`

**Files:**
- Create: `src/panel/stats.ts`
- Create: `test/panel-stats.test.js`

**Interfaces:**
- Consumes: `SuiteRunRecord`（db/types）、`crossPlatformDeltas`（tasks/run-compare）。
- Produces：
  ```ts
  export interface FeatureStat {
    featureKey: string; featureName: string | null;
    runs: number; total: number; passed: number; failed: number; passRate: number | null;
    trend: Array<"pass" | "fail">;           // 最近 ≤10 次运行门禁（新→旧）
    failureDomains: Record<string, number>;
    verdicts: Record<string, number>;        // 归因构成（case-defect/execution-deviation/app-defect/uncertain）
  }
  export interface CaseStat {
    caseId: string; caseSetId: string; name: string; featureName: string | null;
    runs: number; failed: number; consecutiveFailures: number; flaky: number;
    lastStatus: string | null; lastFailureDomain: string | null; verdict: string | null;
  }
  export interface PanelRegressionStats {
    features: FeatureStat[];                 // 按 featureKey 排序
    unstableCases: CaseStat[];               // failed desc → consecutiveFailures desc → caseId
    verdictTotals: Record<string, number>;
    crossPlatform: Array<{ caseId: string; name: string; results: Record<string, string> }>;
  }
  export function buildRegressionStats(runs: SuiteRunRecord[]): PanelRegressionStats;
  ```
- 口径（钉死，遵设计 §5.8 血统语义）：`runs` 按 createdAt 新→旧入参（调用方保证）；**case 级统计按（caseSetId ＋ caseId）分组**（同份内累计，禁止跨份按 caseId 聚合）；`passRate`＝passed/total（total 0 → null）；`consecutiveFailures`＝该（份, caseId）序列自最新往回连续非 passed 次数；verdict 取最新非空；`crossPlatform` 仅在同 caseSetId 内跨 platform 比较；空输入 → 空结构。

- [ ] **Step 1: 写失败测试**
  - `buildRegressionStats: 功能聚合（通过率/趋势/失败域/归因构成）`。
  - `buildRegressionStats: 最不稳用例（连败/flaky/最近状态与裁决）`。
  - `buildRegressionStats: 跨端差异仅同份内（同 caseId 不同 platform；跨份同 id 不混）`。
  - `buildRegressionStats: 空输入不崩`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/panel-stats.test.js`。
- [ ] **Step 3: 实现**（纯函数，确定性排序）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): regression stats aggregation (features/cases/verdicts)"`

### Task 3: 动作层路由骨架 + http-server 接线

**Files:**
- Create: `src/panel/actions.ts`
- Modify: `src/panel/web.ts`（`resolveProjectKey` 导出）
- Modify: `src/http-server.ts`（POST `/panel/api/*` 分支；body 读取复用现有 MCP 分支的读体方式）
- Create: `test/panel-actions.test.js`
- Modify: `test/http-server.test.js`

**Interfaces:**
- Produces：
  ```ts
  export interface PanelActionRequest { method: string; url: URL; body: string }
  export function panelActionsEnabled(env: NodeJS.ProcessEnv): boolean; // AOS_PANEL_ACTIONS !== "0"
  export async function handlePanelActionRequest(
    request: PanelActionRequest,
    deps: PanelWebDeps
  ): Promise<PanelWebResponse>;
  ```
- 路由（全部 POST + JSON）：
  - `POST /panel/api/tasks`：body `{ project: string; refs: Array<{ caseSetId: string; featureKey: string }>; platforms?: string[]; baseline?: "latest" | "none" }` → `resolveProjectKey`（web.ts 导出）→ 校验 refs 非空、platforms ⊆ {ios, android}、baseline 合法 → `store.createRegressionTask` → `200 { ok: true, task }`。
  - `POST /panel/api/verdicts`：body `{ project: string; items: Array<{ runId: string; caseId: string }>; verdict: CaseVerdict; note?: string; by?: string }` → 逐条 `updateCaseVerdict` → `200 { ok: true, updated: number, missed: number }`；全部未命中 → `400`。
  - 错误映射：开关关闭/未知项目 → 404；非 POST → 405；JSON 解析失败 / 字段非法 → 400；未处理异常 → 500 `{ ok:false, error }`（不裸抛）。
  - body 上限 256KB（防误用；超限 413）。
- `http-server.ts`：在 MCP 路由**之前**插入 `if (req.method === "POST" && url.pathname.startsWith("/panel/api/"))` → 读体（沿用现有 readBody/分块模式）→ `handlePanelActionRequest` → 写响应。

- [ ] **Step 1: 写失败测试**（`test/panel-actions.test.js`，memory store + 临时项目）
  - `AOS_PANEL_ACTIONS=0 → 404`；非 POST → 405；非法 JSON → 400。
  - `POST tasks: 创建成功（断言 store 任务与 refs）`；未知项目 → 404；refs 空 → 400；`--platform windows` 非法值 → 400。
  - `POST verdicts: 批量裁决（updated 计数；重复裁决幂等覆盖）`；未知 run/case → 400（missed=全部）。
  - `http-server: 真实 POST /panel/api/tasks 往返（200 + store 可查）`（`test/http-server.test.js` 追加）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/panel-actions.test.js`。
- [ ] **Step 3: 实现**（actions.ts + web.ts 导出 + http-server 接线）。
- [ ] **Step 4: 跑测试确认通过**；`npm run test:file -- test/http-server.test.js` 无回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): action layer (POST /panel/api tasks + verdicts, HTTP mode only)"`

### Task 4: 回归引用屏（L2 区块 + 内联 JS）

**Files:**
- Modify: `src/panel/overview.ts`（`PanelProjectDetail` 增 `regressionRefs`；`buildPanelProjectDetail` 填充）
- Modify: `src/panel/web.ts`（L2 HTML 增「新建回归测试」区块 + 内联 JS）
- Modify: `test/panel-overview.test.js`
- Modify: `test/panel-web.test.js`

**Interfaces:**
- Produces（overview.ts）：
  ```ts
  export interface PanelRegressionRef {
    caseSetId: string; featureKey: string; featureName: string;
    caseCount: number; createdAt: string; source: string; jsonPath: string;
    lastPassRate: number | null;   // 同份同端最近一次（任一端）
  }
  // PanelProjectDetail 增：regressionRefs: PanelRegressionRef[]
  ```
  数据：`store.listCaseSets(rootPath, 50)` 展平 + `store.listSuiteRuns(rootPath, { limit: 50 })` 计算最近通过率；store 不可用 → `[]` + warnings。
- web.ts L2 区块：表格（时间/功能名/用例数/最近通过率/来源 + 复选框 `name="ref" value="<caseSetId>|<featureKey>"`）＋ 端复选（ios/android 默认全选）＋ baseline 下拉（latest/none）＋ `[创建回归任务]` 按钮；内联 `<script>`（零构建 vanilla）：收集勾选 → `fetch("/panel/api/tasks", { method:"POST", headers, body })` → 成功 `location.href = "/panel?project=…&task=" + task.id`；失败 `alert(error)`；无 JS 时显示提示行"需启用 JavaScript 提交（或使用 `suite task create`）"。

- [ ] **Step 1: 写失败测试**
  - `panel-overview: regressionRefs 聚合（两份同 key → 两条记录；最近通过率）`。
  - `panel-web: L2 HTML 含回归区块（复选框 value 编码、端/基线控件、fetch("/panel/api/tasks")、无 JS 提示）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): regression reference block with create form"`

### Task 5: 任务页 + 项目页任务列表

**Files:**
- Modify: `src/panel/overview.ts`（`PanelTaskDetail` + `buildPanelTaskDetail`；`PanelProjectDetail` 增 `tasks`）
- Modify: `src/panel/web.ts`（视图 `task`：`/panel?project=…&task=<id>`；L2 任务列表链接）
- Modify: `test/panel-overview.test.js`
- Modify: `test/panel-web.test.js`
- Modify: `test/http-server.test.js`

**Interfaces:**
- Produces：
  ```ts
  export interface PanelTaskRunView {
    runId: string; platform: string; device: string | null; status: string;
    total: number; passed: number; failed: number;
    failureDomains: Record<string, number>;
    comparison: { baseline: string; fixed: number; regressed: number; newFailed: number; vanished: number } | null;
    manifestPath: string | null; createdAt: string;
  }
  export interface PanelTaskDetail {
    task: RegressionTaskRecord;
    refs: Array<{ caseSetId: string; featureKey: string; featureName: string | null; caseCount: number | null; jsonPath: string | null }>;
    runs: PanelTaskRunView[];
    crossPlatform: Array<{ caseId: string; name: string; results: Record<string, string> }>;
    warnings: string[];
  }
  export async function buildPanelTaskDetail(deps: PanelDeps, rootPath: string, taskId: string): Promise<PanelTaskDetail | null>;
  ```
- 视图优先级（钉死）：`task` > `batch` > `view`（review/stats）> 默认项目页；`task` 未知 → 404。
- L2 增「回归任务」列表（id/status/platforms/refs 数/createdAt → 任务页链接）。
- 任务页渲染：任务状态、引用解析表（份路径/用例数）、子运行表（端/设备/通过/失败/失败域/对比摘要/清单路径，P1 只显示路径不内联）、跨端差异表、提示"触发执行：`suite run --task <id> --device …`（P2 面板一键下发）"。

- [ ] **Step 1: 写失败测试**
  - `panel-overview: buildPanelTaskDetail（状态/引用解析/子运行/对比/跨端；未知 task → null）`。
  - `panel-web: 任务视图 HTML（状态徽标、子运行表、CLI 指引行）；未知 task → 404`。
  - `http-server: GET /panel?project=…&task=<id> 200`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): task detail view + project task list"`

### Task 6: 归因队列屏（裁决表单 + 批量）

**Files:**
- Modify: `src/panel/overview.ts`（`PanelReviewItem` + `buildPanelReviewQueue`）
- Modify: `src/panel/web.ts`（视图 `review`：`/panel?project=…&view=review`；裁决表单 + 内联 JS）
- Modify: `test/panel-overview.test.js`
- Modify: `test/panel-web.test.js`
- Modify: `test/http-server.test.js`

**Interfaces:**
- Produces：
  ```ts
  export interface PanelReviewItem {
    runId: string; caseId: string; name: string; featureName: string | null;
    platform: string; device: string | null; status: string;
    failureDomain: string | null; failureConfidence: string | null; failureReason: string | null;
    traceId: string | null; evidencePath: string | null;
    verdict: string | null; verdictBy: string | null; verdictAt: string | null; verdictNote: string | null;
    createdAt: string;
  }
  export async function buildPanelReviewQueue(deps: PanelDeps, rootPath: string, options?: { limit?: number }): Promise<{ items: PanelReviewItem[]; warnings: string[] }>;
  ```
  数据：`listSuiteRuns(rootPath, { limit: 10 })` 展平失败用例（`status !== "passed"`）；未裁决在前（verdict null），再按 createdAt 新→旧；`evidencePath`＝traceDir（存在性标注由视图做两态：存在路径 / `[已清理]`）。
- web.ts `review` 视图：列表（勾选批量 + 每条：用例/功能/端/初判(域+置信)/理由/证据/裁决状态）+ 裁决区（radio：案例问题 `case-defect` / 执行偏差 `execution-deviation` / 应用缺陷 `app-defect` / 不确定 `uncertain` + 备注 + `[提交裁决]`；批量：勾选多条 → 同一裁决）→ 内联 JS POST `/panel/api/verdicts` → reload；动作指引行（重跑：`node dist/cli.js suite run --task <id> --device <s>` / `suite run --tests <json> --case <caseId>`；隔离：`.artemis/design/quarantine.json` 指引）。

- [ ] **Step 1: 写失败测试**
  - `panel-overview: 队列聚合（未裁决在前、初判字段、已裁决展示）`。
  - `panel-web: review HTML（radio 四选项、批量复选框、fetch("/panel/api/verdicts")、证据两态、指引命令）`。
  - `http-server: GET view=review 200 + POST 裁决后队列更新（未裁决项减少）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): attribution review queue with verdict form"`

### Task 7: 统计下钻屏 + 改进出口

**Files:**
- Modify: `src/panel/overview.ts`（`PanelStatsView` + `buildPanelStatsView`）
- Modify: `src/panel/web.ts`（视图 `stats`：`/panel?project=…&view=stats`）
- Modify: `test/panel-overview.test.js`
- Modify: `test/panel-web.test.js`

**Interfaces:**
- Produces：
  ```ts
  export interface PanelStatsView {
    stats: PanelRegressionStats;               // Task 2
    improvement: {
      caseDefects: Array<{ caseId: string; name: string; featureName: string | null }>;   // verdict=case-defect
      environment: Array<{ caseId: string; name: string; featureName: string | null }>;   // execution-deviation
      appDefects: Array<{ caseId: string; name: string; featureName: string | null }>;    // app-defect
    };
    guidance: string[];                        // 指引命令（重新生成/环境清单/Jira 建单）
    warnings: string[];
  }
  export async function buildPanelStatsView(deps: PanelDeps, rootPath: string): Promise<PanelStatsView>;
  ```
- web.ts `stats` 视图：功能表（通过率/趋势小方块/失败域/归因构成 chips）、最不稳用例表（连败/flaky/最近裁决）、跨端差异表、改进出口三清单 + 指引（案例问题 → `figma_generate_tests` 重新生成指引；应用缺陷 → `node dist/cli.js jira issue create` 指引；P3 自动化）。

- [ ] **Step 1: 写失败测试**
  - `panel-overview: buildPanelStatsView（三清单来自裁决；指引行非空；空数据不崩）`。
  - `panel-web: stats HTML（功能表/用例表/三清单区块存在）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): stats drilldown + improvement lists"`

### Task 8: P1b 遗留落地（状态回写 best-effort + CLI 参数校验 + suite_runs 执行机字段）

**Files:**
- Modify: `src/suite-command.ts`
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/tasks/run-registry.ts`
- Modify: `test/suite-task.test.js`
- Modify: `test/db-suite-runs.test.js`

- [ ] **Step 1: 写失败测试**
  - `suite run --task: 任务状态回写失败 → 运行结果不受影响`（monkey-patch `store.updateRegressionTask` 抛错 → 退出码不变、结果摘要行仍在、输出含"状态回写失败"提示）。
  - `suite task create: --platform windows → exit 2`；`--baseline latestt → exit 2`（白名单校验）。
  - `suite_runs: runner 字段（登记填 os.hostname()；pg-mem + memory 读回）`（`test/db-suite-runs.test.js`）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：`suiteRunTask` 两处 `updateRegressionTask` 调用包 try/catch（`logWarn` + `say("注意: 任务状态回写失败（运行结果不受影响）")`）；`suiteTaskCreate` 校验 `--platform` ⊆ {ios, android}、`--baseline` ∈ {latest, none}，非法 → `io.errorLog` + exit 2；`suite_runs` 增 `runner TEXT`（types + DDL + 映射 + memory），`registerSuiteRun` 填 `os.hostname()`。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "fix(suite): best-effort task status writes + CLI arg whitelists + runner field"`

### Task 9: `suite feedback` 裁决维度建议

**Files:**
- Modify: `src/figma/generation-feedback.ts`
- Modify: `test/generation-feedback.test.js`（若不存在则并入 `test/suite-command.test.js` 既有 feedback 断言文件）

**Interfaces:**
- `FeedbackSuggestion.kind` 增 `"verdict"`；`buildGenerationFeedback` 增：从 `listSuiteRuns(rootPath, { limit: 50 })` 收集 `verdict === "case-defect"` 的用例 → 按功能分组 → 每组一条建议：
  ```
  { kind: "verdict", message: `功能「X」有 N 条用例被判案例问题（caseId…），建议下一轮重新生成该功能用例`, caseIds: [...], traceIds: [...] }
  ```
- 只读按需计算（无新存储）；store 不可用 → 跳过该维度（不阻断既有建议）。

- [ ] **Step 1: 写失败测试**
  - `suite feedback: 案例问题裁决 → kind:"verdict" 建议（按功能分组、带 caseIds）`。
  - `suite feedback: 无裁决/无 store → 无 verdict 建议、既有建议不受影响`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/suite-command.test.js`（feedback 断言所在文件）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(feedback): verdict-based regeneration suggestions"`

### Task 10: 全量回归 + 文档

**Files:**
- Modify: `DESIGN.md`（§13.108 实施记录：动作层路由/开关/无鉴权风险标注/统计口径/裁决写库/视图参数优先级；独立 `panel --web` 保持只读；`suite_runs` 增 `runner`（P1 hostname / P2 runner 名）；**两条 P1b 评审遗留口径**：`task.runIds` 为替换语义（历史按 taskId 查 `suite_runs`）；失败子运行对比保持现状（task 模式 `report.ok=false` 为不可达路径，P2 runner 引入后重审））
- Modify: `README.md`（面板动作层用法 + 风险提示；`panel` 章节更新）
- Modify: `AGENTS.md`（命令表「测试闭环（CLI）」行同步 `suite task` / `run --task` / `report --task`）

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 更新 DESIGN.md + README.md**。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P1c (panel action layer)"`

---

## 范围外（另立计划）

- **P2**：runner 心跳 + 面板一键下发（自动领取执行；任务页进度实时化；只读产物路由内联预览）。
- **P3**：改进出口自动化（生成反馈联路自动触发、环境清单工单化、Jira 自动建单）、定时回归、跨项目对比；动作层鉴权升级。
