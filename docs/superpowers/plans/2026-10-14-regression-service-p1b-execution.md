# 回归服务 P1b：执行与对比（`suite task` / `suite run --task` / 登记 / 同份对比 / 结果表）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通回归任务的"创建（CLI）→ 执行（`suite run --task`：引用解析、子运行展开）→ 登记（`suite_runs`/`suite_run_cases`）→ 同份对比 → 结果表"闭环；所有 suite 运行（含普通 run/loop）best-effort 登记 DB。

**Architecture:** DB 增 `regression_tasks`/`suite_runs`/`suite_run_cases` 三表（事务写入，复用 P1a 的 pool.connect 模式并提取公共辅助）；新增纯函数 `src/tasks/run-compare.ts`（对比）与 `src/tasks/run-registry.ts`（报告→登记映射、基线查询、引用解析）；`suite-command.ts` 增 `task create|list|show` 子命令与 `run --task` 模式；`run-report.ts` 增「功能」「端」列与任务报告（`suite report --task <id>`）。

**Tech Stack:** TypeScript（ESM + NodeNext + strict）；node:test（跑 `dist/`）；pg-mem；exceljs。测试注入：`runSuiteCommand(argv, deps)`（`test/suite-command.test.js` 的 `runCli`/`SuiteProxy` 模式）。

**Spec:** `docs/superpowers/specs/2026-10-14-regression-service-design.md`（§5.3/§5.5/§5.6）。前置：P1a 已交付（case_sets 表、`savedTo.caseSets`、feature key 继承）。

## Global Constraints

- `npm run build && npm test && npm run lint` 全绿（测试跑 dist）。
- 登记一律 **best-effort**：store 不可用/写失败 → `logWarn` + 输出如实标注，不阻断执行、不影响退出码。
- 多行写入必须事务（P1a 评审 #3 教训）；pg-mem 不支持回滚 → 回滚语义用"事务协议桩测试"覆盖。
- `suite run` 既有行为（live tests.json、门禁、退出码 0/1/2、批次清单）不回归；新登记为增量。
- 用户可见文案中文；代码标识符英文；相对导入带 `.js`。
- 行为变更同步 `DESIGN.md` 与 `README.md`。

## Review Focus

1. 引用解析：feature key 不存在 / 无历史份 → exit 2 且列出可用 key；同 key 多份 → 取最新（新→旧首次出现）。
2. 子运行展开：多份×多设备笛卡尔积；跨份重复 caseId 去重只跑一次；任一份/端失败不吞错（如实汇总，退出码 1/2）。
3. 对比血统：baseline 必须同（caseSetId, featureKey, platform）且排除当前 run 自身；无 baseline → "基准建立"（不误报修复/回归）。
4. 登记降级：store 抛错 → 执行成功 + 警告；任务状态机（待执行→执行中→已回写/部分失败）不被登记失败卡死。
5. 任务报告命名：单功能 `<stamp>_<功能>_回归.xlsx`、多功能 `<stamp>_多功能N项_回归.xlsx`；文件可被 exceljs 读回。

---

### Task 1: DB 三表 + store 方法（事务写入）

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`（提取 `withTransaction` 辅助；`recordCaseSet` 改用之；新增三表 DDL 与方法）
- Modify: `src/db/memory.ts`
- Create: `test/db-suite-runs.test.js`

**Interfaces:**
- Produces（`src/db/types.ts`）：
  ```ts
  export interface RegressionTaskRef { caseSetId: string; featureKey: string }
  export interface RegressionTaskRecord {
    id: string; projectId: string | null; createdAt: string; createdBy: string | null;
    refs: RegressionTaskRef[]; platforms: string[]; baseline: "latest" | "none";
    status: "pending" | "running" | "completed" | "partial" | "failed"; runIds: string[];
  }
  export interface SuiteRunCaseRecord {
    caseId: string; featureKey: string | null; platform: string; status: string;
    traceId: string | null; failureDomain: string | null; failureConfidence: string | null;
    failureReason: string | null; durationMs: number | null; quarantined: boolean; flaky: boolean;
    verdict: string | null; verdictBy: string | null; verdictAt: string | null; verdictNote: string | null;
  }
  export interface SuiteRunRecord {
    id: string; projectId: string | null; createdAt: string; trigger: string;
    regressionTaskId: string | null; caseSetId: string | null; featureKey: string | null;
    featureName: string | null; platform: string; device: string | null; appVersion: string | null;
    status: string; startedAt: string; finishedAt: string; total: number; passed: number;
    failed: number; flaky: number; quarantined: number; failureDomains: Record<string, number>;
    gateResult: string | null; exitCode: number; manifestPath: string | null;
    comparison: unknown; cases: SuiteRunCaseRecord[];
  }
  export interface RecordSuiteRunInput { rootPath: string; run: Omit<SuiteRunRecord, "id"|"projectId"|"cases"|"createdAt">; cases: SuiteRunCaseRecord[]; createdAt?: string }
  export interface CreateRegressionTaskInput { rootPath: string; refs: RegressionTaskRef[]; platforms: string[]; baseline: "latest"|"none"; createdBy?: string | null }
  // ProjectStore 增：
  createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord>;
  getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null>;
  listRegressionTasks(rootPath: string, limit?: number): Promise<RegressionTaskRecord[]>;
  updateRegressionTask(rootPath: string, id: string, patch: { status?: RegressionTaskRecord["status"]; runIds?: string[] }): Promise<boolean>;
  recordSuiteRun(input: RecordSuiteRunInput): Promise<SuiteRunRecord>;
  listSuiteRuns(rootPath: string, query?: { taskId?: string; caseSetId?: string; featureKey?: string; platform?: string; limit?: number }): Promise<SuiteRunRecord[]>; // 新→旧
  ```
- DDL：`regression_tasks(id PK, project_id, created_at, created_by, refs TEXT JSON, platforms TEXT JSON, baseline TEXT, status TEXT, run_ids TEXT JSON)`；`suite_runs(id PK, project_id, created_at, trigger, regression_task_id, case_set_id, feature_key, feature_name, platform, device, app_version, status, started_at, finished_at, total, passed, failed, flaky, quarantined, failure_domains TEXT JSON, gate_result, exit_code, manifest_path, comparison TEXT JSON)`；`suite_run_cases(run_id, case_id, feature_key, platform, status, trace_id, failure_domain, failure_confidence, failure_reason, duration_ms, quarantined INT, flaky INT, verdict, verdict_by, verdict_at, verdict_note, PRIMARY KEY (run_id, case_id))`。
- `withTransaction`（postgres.ts 私有）：`connect()` 可用 → BEGIN/COMMIT/ROLLBACK + release；否则直连（协议同 P1a recordCaseSet，`recordCaseSet` 一并改用）。

- [ ] **Step 1: 写失败测试**（`test/db-suite-runs.test.js`，memory + pg-mem）
  - `regression_tasks: create/get/list/update 往返（refs 数组、runIds 累积）`。
  - `recordSuiteRun: 往返完整（cases 嵌套、failureDomains、comparison JSON）`。
  - `listSuiteRuns: 过滤（taskId/caseSetId/featureKey/platform）与新→旧、limit`。
  - `recordSuiteRun: 事务协议——失败时 BEGIN→ROLLBACK→release，不 COMMIT`（桩 pool，模式同 `test/db-case-sets.test.js`）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-suite-runs.test.js`。
- [ ] **Step 3: 实现**（types + postgres + memory；`withTransaction` 提取并改造 recordCaseSet）。
- [ ] **Step 4: 跑测试确认通过**；再跑 `npm run test:file -- test/db-case-sets.test.js` 确认无回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): suite_runs/regression_tasks registry (transactional)"`

### Task 2: 对比纯函数 `run-compare`

**Files:**
- Create: `src/tasks/run-compare.ts`
- Create: `test/run-compare.test.js`

**Interfaces:**
- Produces：
  ```ts
  export type RunCaseOutcome = "passed" | "failed" | "pending";
  export interface CompareCaseInput { caseId: string; name: string; outcome: RunCaseOutcome }
  export interface RunComparison {
    baseline: "compared" | "established";
    stillPassed: number; fixed: number; regressed: number;
    newFailed: number; newPassed: number; vanished: number;
    regressedCases: Array<{ caseId: string; name: string }>;
    fixedCases: Array<{ caseId: string; name: string }>;
    newFailedCases: Array<{ caseId: string; name: string }>;
    vanishedCases: Array<{ caseId: string; name: string }>;
  }
  export function compareRuns(baseline: CompareCaseInput[] | null, current: CompareCaseInput[]): RunComparison;
  export function crossPlatformDeltas(
    runs: Array<{ platform: string; cases: CompareCaseInput[] }>
  ): Array<{ caseId: string; name: string; results: Record<string, RunCaseOutcome> }>; // 仅列出结果不一致的用例
  ```
- 口径（钉死）：pending 不参与对比计数；`baseline=null` → `baseline:"established"`（全部计 newPassed/newFailed）；baseline 有而 current 无 → vanished；同名同 id 才配对（caseId 精确）。

- [ ] **Step 1: 写失败测试**
  - `compareRuns: 修复/回归/仍通过/新增失败/新增通过/消失`（六个计数 + 清单）。
  - `compareRuns: 无基线 → 基准建立`。
  - `compareRuns: pending 不参与计数`。
  - `crossPlatformDeltas: 两端结果不同才列出`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/run-compare.test.js`。
- [ ] **Step 3: 实现**（纯函数，输入输出确定性排序：按 caseId）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(tasks): run comparison (same-lineage deltas + cross-platform)"`

### Task 3: 登记映射与基线查询 `run-registry`

**Files:**
- Create: `src/tasks/run-registry.ts`
- Create: `test/run-registry.test.js`

**Interfaces:**
- Consumes: `SuiteRunReport`/`SuiteCaseResult`（suite-runner）、`ProjectStore`（Task 1）、`compareRuns`（Task 2）、`classifyIosSerial`（device/ios.js）、`loadGeneratedCases`（design-store，读 `feature` 字段——**本任务同时给 `GeneratedCaseRecord` 增 `feature: string | null` 解析**）。
- Produces：
  ```ts
  export function platformOf(serial: string | null): "ios" | "android" | "unknown";
  export function buildSuiteRunInput(input: {
    report: SuiteRunReport; trigger: string; regressionTaskId?: string | null;
    caseSetId?: string | null; featureKey?: string | null; featureName?: string | null;
    platform: string; device: string | null; appVersion?: string | null;
    exitCode: number; startedAtMs: number; finishedAtMs: number; manifestPath?: string | null;
    comparison?: RunComparison | null;
  }): { run: Omit<SuiteRunRecord, "id"|"projectId"|"cases">; cases: SuiteRunCaseRecord[] };  // 纯映射
  export async function resolveRunRefs(runtime: Runtime, testsPath: string): Promise<{ caseSetId: string; featureKey: string; featureName: string } | null>;  // 按 case_set_features.jsonPath 精确匹配
  export async function registerSuiteRun(runtime: Runtime, input: Parameters<typeof buildSuiteRunInput>[0]): Promise<string | null>;  // best-effort：失败 logWarn + 返回 null
  export async function baselineFor(runtime: Runtime, ref: { caseSetId: string; featureKey: string; platform: string }, excludeRunId?: string): Promise<CompareCaseInput[] | null>;  // listSuiteRuns 过滤 → 最近一条 → cases 映射
  ```
- 映射口径：`SuiteCaseResult.status`（passed/failed/timeout/submit-error）→ `status` 原样；`outcome`（对比用）：passed→passed，pending 不存在于套件结果（submit-error/timeout→failed）。durationMs：`now() - startedAtMs` 不可得逐例 → `null`（诚实留空）。

- [ ] **Step 1: 写失败测试**
  - `buildSuiteRunInput: 逐例映射（failure 域/置信/理由、quarantined、flaky、traceId）`。
  - `platformOf: iOS UDID → ios；adb serial → android；null → unknown`。
  - `resolveRunRefs: jsonPath 精确匹配命中/未命中 null`（memory store 预置 case_set）。
  - `registerSuiteRun: store 抛错 → 返回 null 且不抛`。
  - `baselineFor: 同 ref 最近一条、排除 excludeRunId；无 → null`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/run-registry.test.js`。
- [ ] **Step 3: 实现**（含 `GeneratedCaseRecord.feature` 解析 + design-store 测试补充）。
- [ ] **Step 4: 跑测试确认通过**；`npm run test:file -- test/design-store.test.js` 无回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(tasks): suite-run registry mapping + baseline lookup"`

### Task 4: `suite run` / `suite loop` 登记接线

**Files:**
- Modify: `src/suite-command.ts`
- Modify: `test/suite-command.test.js`

**Interfaces:**
- `suiteRun`：执行后（`persistRunManifest` 附近）best-effort：`resolveRunRefs`（`--tests` 指向归档时能解析出份血统）→ `baselineFor` → `compareRuns` → `registerSuiteRun`（trigger `cli`、platform 由 `--device` 判定）→ 输出一行摘要（`登记: run <id> · 对比 修复N/回归N` 或 `登记降级: …`）；`--no-save` 时跳过（与批次清单同口径）。
- `suiteLoop` 的 run 步骤同样登记（trigger `cli`）。

- [ ] **Step 1: 写失败测试**（`test/suite-command.test.js`，沿用 `setupRun`/`runCli` + MemoryStore）
  - `suite run: 登记 suite_runs + 逐例（memory store 断言计数与 caseId 列表）`。
  - `suite run: 指向归档 JSON 时解析份血统并写对比（预置一条基线 run → 断言 修复/回归）`。
  - `suite run: store 抛错 → 执行仍成功、输出含降级标注、退出码不变`。
  - `suite run --no-save: 不登记`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现接线**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): best-effort run registration for suite run/loop"`

### Task 5: `suite task create|list|show`

**Files:**
- Modify: `src/suite-command.ts`（分发器白名单 + `suiteTask`；usage 文本）
- Create: `test/suite-task.test.js`

**Interfaces:**
- `suiteTask(runtime, flags, io)`：
  - `create`：`--ref <featureKey>`（可重复/逗号分隔）→ `listCaseSets(rootDir, 50)` 展平取**每个 key 的最新一份**（新→旧首次出现）；缺失 → exit 2 + 列出可用 key；`--platform <ios|android>`（可重复，默认 `["ios","android"]`）；`--baseline latest|none`（默认 latest）；写入 `regression_tasks`（status `pending`）；输出任务 id 与解析结果（`--json` 支持）。
  - `list`：`listRegressionTasks` 表格输出（id/status/refs 数/platforms/createdAt）。
  - `show <id>`：展示每个 ref 的 `caseSetId/featureName/caseCount/jsonPath/created_at` + runIds。
- 分发器：白名单加 `"task"`。

- [ ] **Step 1: 写失败测试**（预置 case_sets：两个 key 各两份不同 createdAt）
  - `suite task create: 解析最新份并落库`。
  - `suite task create: 未知 key → exit 2 且列出可用 key`。
  - `suite task create: --platform 覆盖默认`。
  - `suite task list/show: 输出包含状态与解析路径`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/suite-task.test.js`。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): task create/list/show (feature-key refs, latest case-set)"`

### Task 6: `suite run --task <id>`

**Files:**
- Modify: `src/suite-command.ts`（suiteRun 增 task 模式；usage）
- Modify: `test/suite-task.test.js`

**Interfaces:**
- `suite run --task <id> --device <serial>`（`--device` 可重复，至少 1 个；`--task` 与 `--tests` 互斥 → exit 2）。
- 流程：
  1. `getRegressionTask`；缺失 → exit 2。
  2. 设备解析：每个 serial → `platformOf`；要求覆盖 task.platforms（缺端 → 输出标注"该端未执行"，不报错）。
  3. 展开子运行 = refs × devices（每个 ref 读存档 JSON 的 `flows[].id` 为 caseIds，**跨份/跨设备去重**：同 caseId 只跑一次，第二次出现记 `deduped`）。
  4. 逐子运行 `runGeneratedTests(runtime, { ...runOptions, testsPath: jsonPath, deviceSerial, caseIds })`；随后 `baselineFor`（同份同端，排除本次）→ `compareRuns` → `registerSuiteRun`（trigger `cli`、regressionTaskId、refs、platform、device）。
  5. 任务状态：开始 `running` → 结束 `completed`（全通过）或 `partial`（有失败）或 `failed`（无子运行成功）；`runIds` 累积。
  6. 输出：逐子运行摘要（`[ios] 登录流程: pass 10/12 · 修复1 回归1`）+ 跨端差异（`crossPlatformDeltas`）+ 总计；`--json` 全量。
- 退出码：0 全通过；1 任一子运行有失败；2 执行错误。
- 门禁口径（钉死）：子运行**不做全图覆盖门禁**（子集天然不完整；全图完整性由生成时 `requireFullCoverage` 保障）——输出固定一行说明；`--fail-on-uncovered` 在 task 模式忽略并提示。

- [ ] **Step 1: 写失败测试**（`SuiteProxy` 造完成/失败状态；预置 task + case_sets + 归档 JSON 文件）
  - `suite run --task: 展开 refs×devices、逐例登记带 task 关联、状态 → completed`。
  - `suite run --task: 有失败 → 退出码 1、状态 partial、对比含回归`。
  - `suite run --task: 跨份重复 caseId 去重（proxy 调用次数断言）`。
  - `suite run --task: 缺端设备 → 标注该端未执行`。
  - `suite run --task: 未知任务/与 --tests 同用 → exit 2`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): run --task (sub-run expansion + registration + comparison)"`

### Task 7: 结果表「功能」「端」列 + `suite report --task`

**Files:**
- Modify: `src/figma/run-report.ts`
- Modify: `src/suite-command.ts`（`suite report --task <id>`）
- Modify: `test/run-report.test.js`
- Modify: `test/suite-task.test.js`

**Interfaces:**
- `RunReportCase` 增 `feature: string | null`、`platform: string | null`；`renderWorkbook` 增「功能」「端」两列（位置：用例ID 之后）；`buildRunReport`（台账源）填 feature（经 `loadGeneratedCases` 的 `feature` 反查 caseId→feature 名）与 platform `null`。
- 新增 `buildTaskRunReport(runtime, options: { taskId: string; outputDir?: string; save?: boolean; stamp?: string }): Promise<RunReport>`：cases 来自 `listSuiteRuns({ taskId })` 展平（feature/platform 填充、失败分类沿用 run 记录的域/理由）；`saved` 命名：
  - 单功能 → `<stamp>_<功能名>_回归.xlsx` / `.xml`；多功能 → `<stamp>_多功能N项_回归.xlsx` / `.xml`（`N`=任务 refs 数）；`stamp` 默认 `YYYYMMDDTHHmmss`（UTC）。
  - 落盘目录与 run-report 一致（`.artemis/design/reports/`）。
- `suite report --task <id>`：调用 `buildTaskRunReport`；输出 `xlsx:`/`junit:` 行；`--no-save`/`--json` 支持。

- [ ] **Step 1: 写失败测试**
  - `renderWorkbook: 功能/端列存在且取值正确`（含空值显示 `—`）。
  - `buildTaskRunReport: 逐例来自 suite_runs、命名单功能/多功能规则`（exceljs 读回断言 sheet 与列）。
  - `suite report --task: 输出两路径且文件存在`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**；`npm run test:file -- test/suite-command.test.js` 无回归。
- [ ] **Step 5: 提交**：`git commit -m "feat(report): feature/platform columns + task regression report naming"`

### Task 8: 子集门禁口径落地 + 并列决胜修复

**Files:**
- Modify: `src/figma/features.ts`（`assignCaseFeature` 并列时**仅在并列领先组内**找用例首屏；首屏不在并列组 → 取并列组字典序首者）
- Modify: `test/figma-features.test.js`
- Modify: `test/suite-task.test.js`（门禁说明断言）

- [ ] **Step 1: 写失败测试**
  - `assignCaseFeature: 并列决胜仅在并列组内（首屏在次相关组时不越级）`。
  - `suite run --task: 输出含"子集运行不做全图覆盖门禁"说明；--fail-on-uncovered 被忽略并提示`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "fix(figma): tie-break scope for case feature + task subset gate note"`

### Task 9: 全量回归 + 文档

**Files:**
- Modify: `DESIGN.md`（§13.107 实施记录：三表/事务/登记口径/对比血统/任务报告命名/子集门禁豁免；**评审遗留口径两条**：`case_sets.basename`＝生成时 live 用例文件名（informational，引用解析以 feature key 为准）；归档子集 `counts.screens/edges`＝设计全量（`flows` 为子集数，子集覆盖看 `coverage`））
- Modify: `README.md`（`suite task`/`suite run --task`/`suite report --task` 用法；登记与降级口径）

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 更新 DESIGN.md + README.md**。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P1b (task run / registration / comparison / report)"`

---

## 范围外（另立计划）

- **P1c**：面板动作层（回归引用屏、任务页、归因队列 v1、统计下钻、鉴权口径）。
- **P2**：runner 心跳 + 面板一键下发（自动领取执行，契约同本计划）。
