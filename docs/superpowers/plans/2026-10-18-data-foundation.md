# 记录底座（强制持久＋详细记录）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AOS-ARTEMIS 的测试结果/过程/数据**默认且强制持久**——未配置 PostgreSQL 时使用项目文件台账（`.artemis/ledger/`），并新增内部编排审计、产物索引与三口径导出。

**Architecture:** 新增 `FileStore`（组合 `MemoryStore` 状态＋每项目 `state.json` 原子快照＋`usage.jsonl`/`journal.jsonl` 追加日志＋进程级 `registry.jsonl`）；`createProjectStore` 装配顺序改为 PG → 文件台账 → 会话内存（仅最后兜底且如实标注）；`ProjectStore` 增加审计事件读写，接线到既有服务内部动作；产物索引与导出作为控制台（Plan B）的数据接口。

**Tech Stack:** TypeScript ESM（NodeNext、相对导入带 `.js`）、`node:fs/promises`、`node:crypto`、pg-mem（SQL 测试）、`node --test`。

**Spec:** `PRODUCT.md`（记录即产品）＋ `docs/superpowers/specs/2026-10-18-web-console-shape.md`（§7 工作流 A、决策落定）

## Global Constraints

- 完工标准：`npm run build && npm test && npm run lint` 全绿；行为变更同步 `DESIGN.md`（唯一架构事实源），用法变更同步 `README.md`。
- 测试不依赖真实 PG/设备/外网：SQL 走 `pg-mem`（沿用 `test/db.test.js` 模式）；文件台账测试用临时目录。
- 用户可见文案中文、代码标识符英文；代码默认不加注释（仅解释非显然契约的 JSDoc）。
- 禁止出现"内存降级"类误导表述；如实口径＝「未配置 X → 影响 Y → 启用 Z；数据已落盘 `.artemis/`」。
- 台账目录固定：`<项目根>/.artemis/ledger/`（`state.json`、`usage.jsonl`、`journal.jsonl`）。
- 审计 summary ≤300 字符、不含密钥/token（调用方负责脱敏，复用 `maskSecret` 语义）。
- 日志走 `log()`（stderr）；stdout 仅 MCP 协议或 CLI 输出。

## Review Focus

1. **写入中途进程被杀**：`state.json` 必须原子（tmp+rename）；任意时刻读取都必须得到合法 JSON 或如实空态——决定"强制保留"是否成立，应测"损坏容忍＋tmp 清理"（Task 2）。
2. **PG 已配置但连不上**：必须落到**文件台账**而不是内存丢数据；reason 文案必须实证（Task 3）。
3. **高量 usage**：5 万条事件时启动/写入不得线性劣化（追加＋尾部裁剪），越界时保留最新（Task 2）。
4. **并发写同项目**（stdio 服务＋runner 两进程）：追加写原子、快照单写者假设要写进 DESIGN，冲突不得导致整库丢失（Task 2/3）。
5. **审计事件本身泄漏**：summary/refs 不得出现 token/key；导出内容同口径（Task 4/6）。
6. **注册表跨重启**：`listProjects()`（面板/统计项目选择器）重启后仍稳定（Task 2）。

---

### Task 1: 存储种类扩充＋审计事件接口（Memory/Postgres 双实现）

**Files:**
- Modify: `src/db/types.ts`（`kind: "postgres" | "memory"` → 增加 `"file"`；新增审计类型与两个接口方法）
- Modify: `src/db/memory.ts`（实现审计读写；内存数组按 rootPath 分组，`at` 用 `new Date().toISOString()`）
- Modify: `src/db/postgres.ts`（MIGRATIONS 增表＋两个方法）
- Modify（编译联动，仅把 `"postgres" | "memory"` 联合类型就地扩为三值）: `src/panel/web.ts:372` 一带、`src/panel/overview.ts:103`、`src/panel/deep.ts:23`、`src/panel/compare.ts:50`、`src/usage/web.ts:81-82`、`src/usage-command.ts:52,69,142,152`、`src/tools/usage.ts:25`、`src/runtime.ts:910`
- Test: `test/db-audit.test.js`（新建）、`test/db.test.js`（如断言了 kind 枚举则同步）

**Interfaces:**
- Produces:
```ts
export interface AuditEventInput {
  domain: string;   // "suite" | "import" | "verify" | "panel" | "schedule" | "registry" | "storage"
  action: string;   // 例 "run.recorded" | "excel.imported" | "task.released"
  result: "ok" | "skipped" | "failed";
  summary: string;  // ≤300 字符，不含密钥
  refs?: Record<string, string | undefined>; // traceId/caseId/taskId/runId/issueKey/path
}
export interface AuditEventRecord extends AuditEventInput { id: string; rootPath: string; at: string }
export interface AuditQuery { domain?: string; result?: AuditEventInput["result"]; since?: string; limit?: number }
// ProjectStore 新增：
recordAudit(rootPath: string, input: AuditEventInput): Promise<AuditEventRecord>;
listAudit(rootPath: string, query?: AuditQuery): Promise<AuditEventRecord[]>; // 新→旧
```
- PG 表：`audit_events(id text primary key, root_path text not null, at timestamptz not null, domain text not null, action text not null, result text not null, summary text not null, refs jsonb)`＋索引 `(root_path, at desc)`。

- [ ] **Step 1: 写失败测试** `test/db-audit.test.js`：MemoryStore 与 pg-mem PostgresStore 各做一轮——record 两条（不同 domain/result）→ `listAudit` 默认新→旧、`domain` 过滤、`limit` 生效、`since` 过滤。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-audit.test.js`（预期 `recordAudit is not a function`）。
- [ ] **Step 3: 实现类型＋双实现**；把编译联动文件中的联合类型扩为三值（不改行为）。
- [ ] **Step 4: 跑测试确认通过**；再全量 `npm test` 确认无回归。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(db): audit event API + store kind 'file'"`

---

### Task 2: FileStore（项目文件台账）

**Files:**
- Create: `src/db/file.ts`、`test/db-file.test.js`
- Modify: `src/db/memory.ts`（新增 `exportState(): unknown` / `importState(data: unknown): void`，仅内部契约，用于 FileStore 快照）

**Interfaces:**
- Produces:
```ts
export interface FileStoreOptions { homeDir?: string; env?: NodeJS.ProcessEnv }
export class FileStore implements ProjectStore {
  readonly kind = "file" as const;
  static async create(options?: FileStoreOptions): Promise<FileStore>; // 目录不可写 → 抛错
}
export function resolveLedgerHome(env?: NodeJS.ProcessEnv, cwd?: string): string;
// 解析顺序：AOS_LEDGER_DIR → 最近的 aos.config.jsonc 项目根（复用 src/config/loader.ts resolveProject）→ cwd；返回 <base>/.artemis/ledger
```
- 每项目目录 `<rootPath>/.artemis/ledger/`：`state.json`（除 usage 外全部集合的快照，tmp+rename 原子写）、`usage.jsonl`（仅追加，加载时读全量；超 `AOS_USAGE_MAX_EVENTS`（默认 50000）重写保留最新）、`journal.jsonl`（审计轨迹：`{at, op, rootPath, refs}`，每次**写操作**追加一行，不用于回放——`state.json` 是唯一事实源）。
- 写操作清单（执行后：更新该 rootPath 快照＋追加 journal 行）：`upsertProject/setFigmaToken/upsertLlm/setActiveLlm/putModelCache/recordTask/markTaskFinished/recordCaseSet/createRegressionTask/updateRegressionTask/claimRegressionTask/releaseRegressionTasks/releaseRegressionTask/releaseStaleClaims/createSchedule/updateSchedule/deleteSchedule/claimScheduleWindow/recordSuiteRun/updateCaseVerdict/setCaseIssueKey/upsertRunner/recordUsageEvent`；读操作直通。rootPath 从各方法首参或 `input.rootPath` 提取（`recordUsageEvent`/`upsertProject`/`recordTask`/`claimRegressionTask`/`releaseStaleClaims`/`claimScheduleWindow`/`updateCaseVerdict`/`setCaseIssueKey`/`upsertRunner`/`recordSuiteRun` 在 input 内）。
- 进程级 `registry.jsonl`（home 目录）：`upsertProject` 时追加 `{rootPath, name, updatedAt}`；`listProjects()` 读入内存去重（同 rootPath 取最新）按 updatedAt 新→旧。
- 首次触碰某 rootPath 时懒加载：读 `state.json`→`importState`；文件缺失=空态；**JSON 非法→空态＋`log()` 警告**（不抛错），tmp 残留清理。

- [ ] **Step 1: 写失败测试** `test/db-file.test.js`（临时目录 fixture，逐条）：
  1. 重启恢复：store A 写 project/llm/task/case-set/regression-task/suite-run/verdict/runner → `close()` → 新 FileStore 同 home → 各读接口与写入前一致；
  2. 原子性：循环 50 次写后读 `state.json` 恒可 `JSON.parse`；
  3. 损坏容忍：手工写入非法 `state.json` → `create` 与首读不抛错、返回空态；
  4. 多项目隔离：两个 rootPath 互不串数据；
  5. usage 保留：写入 `maxEvents+10` 条（构造 env `AOS_USAGE_MAX_EVENTS=5`）→ 重载后剩最新 5 条；
  6. journal：一次写操作 = 一行；读操作不追加；
  7. registry：两个项目 upsert → `listProjects()` 两条、新→旧；重建实例后仍两条（重启稳定）；
  8. 不可写目录（`chmod 0o555` 临时目录）→ `FileStore.create` 抛错；
  9. 并发交错写：两个 FileStore 实例（同 home、同项目）交错写 10 次 → 各自读到自己最后一次写；`state.json` 每步后恒可解析（合并语义由"单写者假设"承担，写入 DESIGN）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 `FileStore`＋`MemoryStore.exportState/importState`**。
- [ ] **Step 4: 跑测试确认通过**；`npm test` 全量无回归。
- [ ] **Step 5: Commit**：`git commit -m "feat(db): FileStore — project file ledger (state.json + usage.jsonl + journal.jsonl)"`

---

### Task 3: 默认装配（PG→文件→内存）＋用例集自愈＋降级语义

**Files:**
- Modify: `src/db/index.ts`（重写 `createProjectStore`；`CreateStoreResult` 增 `kind` 字段）
- Create: `src/db/hydrate.ts`（用例集自愈）
- Test: `test/db-default.test.js`（新建）

**Interfaces:**
- Consumes: `FileStore`（Task 2）、`recordAudit`（Task 1）、`src/figma/case-sets.ts` 的文件读取器与 `src/tasks/backfill.ts:156` 一带的 `recordCaseSet` 归一化用法。
- Produces:
```ts
export interface CreateStoreResult { store: ProjectStore; kind: "postgres" | "file" | "memory"; degraded: boolean; reason: string | null }
// 语义：degraded=true 仅当连文件台账都不可用（最后兜底内存），其余为 false。
// 装配顺序：
// 1) 配了 URL → PG ping 成功 → postgres；
// 2) 配了 URL 但失败 → FileStore；reason="PostgreSQL 连接失败（…）：已改用项目文件台账（.artemis/ledger，数据仍持久）。"
// 3) 未配 URL → FileStore；reason="未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账（.artemis/ledger，随项目持久）。"
// 4) FileStore 创建失败 → MemoryStore；degraded=true；reason 如实说明（"文件台账不可写（…）：本次会话使用内存，数据不会持久。"）
export function hydrateProjectLedger(store: ProjectStore, rootPath: string): Promise<number>; // 返回登记条数
```
- FileStore 首次懒加载某 rootPath 后：若 `listCaseSets(rootPath)` 为空且 `<rootPath>/.artemis/design/case-sets/*.json` 存在（≤200 份），逐份归一化登记（复用 backfill 的解析路径）；失败逐份记 audit（domain `"registry"`, result `"failed"`）；幂等（第二次加载不重复）。

- [ ] **Step 1: 写失败测试** `test/db-default.test.js`：① 无 URL → `kind === "file"`；写入→`close()`→重建→数据仍在（"重启不丢"证据）；② 坏 URL（`postgres://127.0.0.1:1/x`）→ `kind === "file"` 且 reason 含"文件台账"；③ 不可写项目目录 → `kind === "memory"`、`degraded === true`、reason 含"不会持久"；④ 自愈：case-sets 目录放 2 份 fixture、state 空 → 首读后 `listCaseSets` 返回 2 且再次加载不翻倍。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（`createProjectStore` 重写、`hydrate.ts`、FileStore 挂载 hydrate）。
- [ ] **Step 4: 跑测试确认通过**；`npm test` 全量（含既有 CLI/面板测试的 reason 断言修复——预期若干处按新文案更新）。
- [ ] **Step 5: 更新 `DESIGN.md`**（新章节记录：装配顺序、单写者假设、目录形态、自愈范围）与 `git commit -m "feat(db): persistent-by-default store assembly + case-set self-heal"`。

---

### Task 4: 内部编排审计接线

**Files:**
- Modify: `src/tasks/run-registry.ts`（`recordSuiteRun` 成功后 → audit `domain:"suite", action:"run.recorded", refs:{runId, taskId}`）
- Modify: `src/workflow/excel-import.ts`（`recordCaseSet` 后 → `"import.excel"`，refs `{file, caseSetId}`；失败 → `result:"failed"`）
- Modify: `src/runner/schedules.ts`（窗口 CAS 命中并建任务后 → `"schedule.fired"`，refs `{scheduleId, taskId}`）
- Modify: `src/panel/actions.ts`（每个动作成功/失败 → `"panel.action"`，refs `{action, taskId|runId|issueKey}`；错误摘要 ≤300 且脱敏）
- Modify: `src/workflow/verify-jira.ts`（回写 `setCaseIssueKey` 后 → `"verify.writeback"`，refs `{issueKey, runId, caseId}`）
- Modify: `src/panel/issues.ts`（`setCaseIssueKey` 后 → `"issues.linked"`，refs `{issueKey}`）
- Test: `test/audit-wiring.test.js`（新建，逐点断言事件落账）

**Interfaces:**
- Consumes: `recordAudit`（Task 1）、各接线点既有函数签名。
- 接线原则：**best-effort**——audit 写入失败仅 `log()` 警告，绝不影响主流程返回值。

- [ ] **Step 1: 写失败测试**：六个接线点各构造一次最小调用（复用各文件既有测试的 fixture 方式），断言 `listAudit(rootPath)` 含对应 domain/action 与 refs；并断言 summary 长度 ≤300 且不含注入的 token 字串（脱敏）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现接线**（每点一行）。
- [ ] **Step 4: 跑测试确认通过**；`npm test` 全量。
- [ ] **Step 5: Commit**：`git commit -m "feat(audit): record internal orchestration events (suite/import/verify/panel/schedule)"`

---

### Task 5: 产物索引

**Files:**
- Create: `src/artifacts/index.ts`、`test/artifacts.test.js`
- 参考: `src/tasks/retention.ts` 的资产族定义（runs/case-sets/reports/diffs/crashes/traces 的 segments）——索引口径与保留期**同源**。

**Interfaces:**
- Produces:
```ts
export interface ArtifactRecord {
  kind: "run" | "case-set" | "report" | "diff" | "crash" | "trace";
  path: string;            // 项目根相对路径
  title: string;           // 人读名（文件名或清单内标题）
  at: string;              // 文件 mtime ISO
  size: number;            // bytes
  meta?: Record<string, string>;
}
export interface ArtifactQuery { kind?: ArtifactRecord["kind"]; since?: string; q?: string; limit?: number }
export function listArtifacts(rootPath: string, query?: ArtifactQuery): Promise<ArtifactRecord[]>; // at 新→旧
```
- 范围：各资产族目录**浅扫**（一层）＋ report/diff/crash 目录内文件直读；`q` 对 title/path 子串匹配；目录缺失＝空数组（不抛错）。

- [ ] **Step 1: 写失败测试**：fixture 项目目录造 6 类文件各 1–2 个 → 全量返回、`kind`/`since`/`q`/`limit` 过滤、排序；空项目 → `[]`。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(artifacts): project artifact index for console archive"`

---

### Task 6: 三口径导出（结果/过程/数据）＋CLI

**Files:**
- Create: `src/export/index.ts`、`test/export.test.js`
- Modify: `src/cli.ts`（注册 `export` 子命令）、`src/commands.ts`（`--help` 文案）
- Test: `test/cli-export.test.js`（新建）

**Interfaces:**
- Consumes: `listArtifacts`（Task 5）、store 读接口（Task 1/2）。
- Produces:
```ts
export type ExportWhat = "results" | "process" | "data";
export interface ExportRequest { what: ExportWhat; format?: "json" | "csv"; since?: string; limit?: number }
export interface ExportResult { what: ExportWhat; format: "json" | "csv"; filename: string; contentType: string; content: string; counts: Record<string, number> }
export function exportProjectData(rootPath: string, store: ProjectStore, req: ExportRequest): Promise<ExportResult>;
// results: suite runs＋verdicts＋issue keys；process: audit 事件＋regression tasks＋schedules＋runners；data: case sets＋task stats＋artifacts 索引
// csv：每个 what 一张主表（results→运行行；process→审计行；data→用例集行）
```
- CLI：`node dist/cli.js export --project <dir> --what results|process|data [--format json|csv] [--out <file>] [--since <ISO>] [--limit <n>]`；成功 exit 0、参数错/存储不可用 exit 2；未传 `--out` 时打印到 stdout（CLI 例外允许）。

- [ ] **Step 1: 写失败测试**：三个 what 的 JSON 计数与关键字段；csv 表头＋行数；`since/limit` 过滤；CLI 端到端（临时项目＋文件台账）exit 0 且 `--out` 落文件。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现**（含 CLI 注册与 help）。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(export): results/process/data export (JSON/CSV + CLI)"`

---

### Task 7: 全量文案整改＋文档收尾

**Files:**
- Modify（逐处改文案/标签/判据，`kind === "memory"` 才是降级；`"file"` 不降级）:
  `src/panel-command.ts:120,213`、`src/panel/web.ts:372,566`、`src/panel/overview.ts:657,725,793`、`src/panel/deep.ts:23,128`、`src/panel/compare.ts:50,244`、`src/usage/web.ts:101,255,370,449`、`src/usage-command.ts:79,142,153`、`src/commands.ts:325`、`src/tools/aos.ts:36`、`src/tools/llm.ts:98,137,168,204`、`src/tools/usage.ts:25,102`、`src/tools/configure.ts:162`、`src/runtime.ts:910,1089`、`src/workflow/project-archive.ts:73`、`src/suite-command.ts:456`
- Create: `test/copy-gate.test.js`（防回归闸）
- Modify: `README.md`、`docs/接入指南.md`、`DESIGN.md`（新增 §13.125 记录）
- Test: 既有 `test/panel-web.test.js`、`test/usage-web.test.js`、`test/panel-command.test.js`、`test/usage-command.test.js`、`test/panel-overview.test.js` 等断言文案处同步

**统一口径（照抄）**：postgres→`PostgreSQL`；file→`文件台账（.artemis/ledger）`；memory→`会话内存（仅本次进程，数据不持久）`。原因串＝「未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账（.artemis/ledger，随项目持久）」/「PostgreSQL 连接失败（…）：已改用项目文件台账（…）」/「文件台账不可写（…）：本次会话使用内存，数据不会持久。」

- [ ] **Step 1: 写失败测试** `test/copy-gate.test.js`：读取 `src/**/*.ts`（排除 `vendor/`）源码文本，断言不含 `"内存降级"`、`"降级为会话内存存储"`、`"（降级）"` 字样（正则 `降级.*内存|内存.*降级`）。
- [ ] **Step 2: 跑测试确认失败**（当前有多处命中）。
- [ ] **Step 3: 逐处整改＋更新既有测试断言**。
- [ ] **Step 4: 跑测试确认通过**；全量 `npm run build && npm test && npm run lint` 全绿。
- [ ] **Step 5: 更新文档**（README 存储说明、接入指南配置表、DESIGN §13.125）；**Commit**：`git commit -m "fix(copy): honest storage wording across surfaces; copy gate test"`

---

**并行依赖（与 Plan B）**：B 的 Task 7/8 消费本计划 Task 1（审计接口）与 Task 5/6（索引/导出）；本计划 Task 1 先合入后 B 才能接线。A 内部顺序按任务号即可。
