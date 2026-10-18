# 记录底座（强制持久＋详细记录）Implementation Plan — v2（评审修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AOS-ARTEMIS 的测试结果/过程/数据**默认且强制持久**——未配置 PostgreSQL 时使用项目文件台账（`.artemis/ledger/`），并新增内部编排审计、产物索引与三口径导出。

**Architecture:** 新增 `FileStore`（组合 `MemoryStore` 状态＋写前重读合并＋每项目 `state.json` 原子快照＋`usage.jsonl`/`audit.jsonl`/`journal.jsonl`）；`createProjectStore` 装配顺序＝PG → 文件台账 → 会话内存（仅最后兜底且如实标注）；`ProjectStore` 增加审计读写；产物索引与导出作为控制台（Plan B）的数据接口。

**Tech Stack:** TypeScript ESM（NodeNext、相对导入带 `.js`）、`node:fs/promises`、`node:crypto`、pg-mem（SQL 测试）、`node --test`。

**Spec:** `PRODUCT.md`＋`docs/superpowers/specs/2026-10-18-web-console-shape.md`（§7 工作流 A）

## Global Constraints

- 完工标准：`npm run build && npm test && npm run lint` 全绿；行为变更同步 `DESIGN.md`，用法变更同步 `README.md`。
- 测试不依赖真实 PG/设备/外网：SQL 走 `pg-mem`（沿用 `test/db.test.js` 模式）；文件台账测试用临时目录；`chmod` 类用例在 `win32` 跳过。
- 用户可见文案中文、代码标识符英文；代码默认不加注释（仅解释非显然契约的 JSDoc）。
- 禁止"内存降级"类误导表述；如实口径＝「未配置 X → 影响 Y → 启用 Z；数据已落盘 `.artemis/`」。
- 台账目录固定：`<项目根>/.artemis/ledger/`（`state.json`、`usage.jsonl`、`audit.jsonl`、`journal.jsonl`）。
- **多写者口径（v2 新增）**：每次写操作前检查 `state.json` mtime，变更则重读并**按 id 并集合并**（单值字段最后写者胜；毫秒级同窗文档化）；`usage`/`audit` 纯追加不触发快照。
- **凭证口径（v2 新增）**：`state.json` **不落** `apiKey`/`figmaToken`（写侧剥离；运行时按既有 `figmaTokenInfo` 链回落 `.env`；LLM store 条目 key 为空时按 provider 约定从 env 回填——含回归测试）。
- **审计保留（v2 新增）**：`AOS_AUDIT_RETENTION_DAYS` 默认 90、`AOS_AUDIT_MAX_EVENTS` 默认 50000（与 usage 对齐）。
- 审计 summary ≤300 字符、不含密钥/token；日志走 `log()`（stderr）；stdout 仅 MCP 协议或 CLI 输出。
- 台账 PG 表对齐仓库先例：**时间戳 TEXT**、**结构化列存 JSON 文本**（pg-mem 兼容）。

## Review Focus

1. **写入中途进程被杀**：`state.json` 必须原子（tmp+rename）；损坏容忍＋tmp 清理（Task 2）。
2. **多写者互相抹库**：跨写者存活性测试（A 写 x→B 写 y→A 写 z→全新实例 x/y/z 全在）；合并窗口毫秒级（Task 2）。
3. **PG 已配置但连不上**：落到文件台账而非内存；reason 实证；分裂脑（故障期数据不回流）文档化（Task 3/7）。
4. **凭证落盘**：state.json 无 apiKey/figmaToken；`.env` 回落可用（Task 2/3 测试）。
5. **审计三连**：默认路径持久（audit.jsonl）、跨重启存活、导出非空；summary 脱敏（Task 2/4/6）。
6. **kind 行为位完备性**：17 处逐点分类（正确性/展示），runner 保持 PG-only、backfill 放行 file、project-archive 对 file 不判降级（Task 1/3/7）。

---

### Task 1: 存储种类扩充＋审计事件接口（Memory/Postgres 双实现）

**Files:**
- Modify: `src/db/types.ts`（`kind` 增 `"file"`；新增审计类型与接口方法）
- Modify: `src/db/memory.ts`（审计读写；`exportState()/importState()`）
- Modify: `src/db/postgres.ts`（SCHEMA 增 `audit_events` 表＋索引入 MIGRATIONS；两个方法）
- Modify（编译联动，联合类型就地扩三值）: `src/panel/web.ts`、`src/panel/overview.ts`、`src/panel/deep.ts`、`src/panel/compare.ts`、`src/usage/web.ts`、`src/usage-command.ts`、`src/tools/usage.ts`、`src/runtime.ts:910`
- Test: `test/db-audit.test.js`（新建）

**Interfaces:**
- Produces:
```ts
export interface AuditEventInput {
  domain: string;   // "suite" | "import" | "verify" | "panel" | "schedule" | "registry" | "storage"
  action: string;   // 例 "run.recorded" | "excel.imported" | "task.released"
  result: "ok" | "skipped" | "failed";
  summary: string;  // ≤300 字符，不含密钥
  refs?: Record<string, string | undefined>;
}
export interface AuditEventRecord extends AuditEventInput { id: string; rootPath: string; at: string }
export interface AuditQuery { domain?: string; result?: AuditEventInput["result"]; since?: string; limit?: number }
// ProjectStore 新增：
recordAudit(rootPath: string, input: AuditEventInput): Promise<AuditEventRecord>;
listAudit(rootPath: string, query?: AuditQuery): Promise<AuditEventRecord[]>; // 新→旧
// 行为位盘点（本任务产出，供 Task 3/7 消费）：
// grep -rn 'kind === "memory"\|kind !== "postgres"\|kind === "postgres"' src/ --include="*.ts" | grep -v vendor
```
- PG 表（对齐先例：TEXT 时间戳、JSON 文本）：
  `audit_events(id TEXT PRIMARY KEY, root_path TEXT NOT NULL, at TEXT NOT NULL, domain TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, summary TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}')`＋`CREATE INDEX IF NOT EXISTS audit_events_root_at_idx ON audit_events(root_path, at)`（索引语句入 MIGRATIONS）。

- [ ] **Step 1: 写失败测试** `test/db-audit.test.js`：Memory 与 pg-mem 各一轮——record 两条（不同 domain/result）→ `listAudit` 新→旧、`domain`/`since`/`limit` 过滤；summary 超 300 截断（实现侧）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-audit.test.js`。
- [ ] **Step 3: 实现类型＋双实现＋行为位盘点**（grep 输出记入本任务提交说明/后续 DESIGN）。
- [ ] **Step 4: 通过＋全量 `npm test` 无回归。**
- [ ] **Step 5: Commit**：`git commit -m "feat(db): audit event API + store kind 'file'"`

---

### Task 2: FileStore（项目文件台账·v2：合并写＋审计落盘＋凭证剥离）

**Files:**
- Create: `src/db/file.ts`、`test/db-file.test.js`
- Modify: `src/db/memory.ts`（`exportState/importState`，Task 1 已备）

**Interfaces:**
- Produces:
```ts
export interface FileStoreOptions { homeDir?: string; env?: NodeJS.ProcessEnv }
export class FileStore implements ProjectStore {
  readonly kind = "file" as const;
  static async create(options?: FileStoreOptions): Promise<FileStore>; // 目录不可写 → 抛错
}
export function resolveLedgerHome(env?: NodeJS.ProcessEnv, cwd?: string): string;
// home（仅 registry 索引）解析：AOS_LEDGER_DIR → 最近项目根（resolveProject）→ ~/.aos/ledger（绝不落 cwd）
// 项目数据永远在 <rootPath>/.artemis/ledger/
```
- 写语义（v2）：
  1. 每次写操作前 `stat state.json`；mtime 变化 → 重读 `importState` 并**与本地态按 id 并集合并**（既存 id 冲突 → 本地（新写入者）胜；`projects`/单值字段最后写者胜）→ 执行操作 → 原子写回；
  2. `usage.jsonl` / `audit.jsonl`：纯追加，**不触发快照**；超限尾部裁剪（usage：既有 policy；audit：90 天/5 万）；
  3. `journal.jsonl`：每次写操作追加 `{at, op, rootPath, refs}`；**定案＝纯取证（不承诺回放）**，写入 DESIGN；
  4. `state.json` 写入前**剥离凭证**（`llms[].apiKey → null`、`projects[].figmaToken → null`；读侧由运行时回落 `.env`）；
  5. 损坏容忍：`state.json` 非法/形状错误 → try/catch → 空态＋`log()` 警告；tmp 残留清理；
  6. `listProjects()` 读 home 的 `registry.jsonl` 去重（同 rootPath 最新）按 updatedAt 新→旧。
- 写操作清单（同 v1；追加 `recordAudit`；usage/audit 走各自 jsonl 不写快照）。

- [ ] **Step 1: 写失败测试** `test/db-file.test.js`（临时目录；`chmod` 用例 win32 跳过）：
  1. 重启恢复：各集合写→`close()`→新实例→读一致；
  2. **跨写者存活性**：A 写 x → B（新实例）写 y → A 再写 z → 全新实例读：x/y/z 全在（合并语义）；
  3. 原子性＋损坏容忍：非法 state.json → 空态不抛错；tmp 残留清理；写后恒可解析；
  4. 多项目隔离；registry 重启稳定（重建实例后 `listProjects()` 仍两条）；
  5. usage 保留（`AOS_USAGE_MAX_EVENTS=5`→剩最新 5）；**audit 保留**（`AOS_AUDIT_MAX_EVENTS=3`→限 3）＋**审计跨重启存活**；
  6. journal 一行/写操作、读操作不追加；
  7. **凭证剥离**：`upsertLlm(apiKey)`/`setFigmaToken` → 重载后 `apiKey/figmaToken === null`（状态其余字段不变）；
  8. 不可写目录 → `create` 抛错；
  9. `resolveLedgerHome`：无项目上下文 → 不落 cwd（落 `~/.aos/ledger`）。
- [ ] **Step 2: 跑测试确认失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(db): FileStore — merge-on-write file ledger (state/usage/audit/journal)"`

---

### Task 3: 默认装配（PG→文件→内存）＋凭证回落＋自愈＋守卫再决策

**Files:**
- Modify: `src/db/index.ts`（`createProjectStore` 重写；`CreateStoreResult` 增 `kind`）
- Create: `src/db/hydrate.ts`（用例集自愈：按 jsonPath 逐份幂等；批量一次写；>200 份 → 记 audit `skipped`）
- Modify: `src/llm/registry.ts`＋调用侧（store 条目 `apiKey` 为空 → 按 provider 约定从 env 回填；仅对 `source:"store"` 且声明了 provider 的条目）
- Modify（守卫再决策）: `src/suite-command.ts:1900`（runner 保持 PG-only；文案改"runner 需要中心 PG（文件台账不支持多进程）；请配置 MOBILE_TESTING_DATABASE_URL"）、`src/suite-command.ts:2045`（backfill 放行 file、仅拒 memory；文案"backfill 需要持久台账（当前为会话内存）…"）、`src/workflow/project-archive.ts:72`（file 不判降级）
- Test: `test/db-default.test.js`（新建）、`test/suite-command.test.js`（守卫行为）、`test/registry-env-fallback.test.js`（新建）

**Interfaces:**
- Produces:
```ts
export interface CreateStoreResult { store: ProjectStore; kind: "postgres" | "file" | "memory"; degraded: boolean; reason: string | null }
// degraded=true 仅当文件台账也不可用（最后兜底内存）。
// 装配：① PG 可连→postgres；② PG 失败→FileStore，reason="PostgreSQL 连接失败（…）：已改用项目文件台账（.artemis/ledger，数据仍持久；PG 恢复后历史不自动回流）。"
// ③ 未配 URL→FileStore，reason="未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账（.artemis/ledger，随项目持久）。"
// ④ FileStore 创建失败→Memory，degraded=true，reason="文件台账不可写（…）：本次会话使用内存，数据不会持久。"
```
- 自愈触发：FileStore 首次懒加载某 rootPath 后调用 `hydrateProjectLedger(store, rootPath)`（按 jsonPath 幂等，读 `src/figma/case-sets.ts` 读取器复用 backfill 归一化路径）。

- [ ] **Step 1: 写失败测试**：① 无 URL → `kind==="file"`；写→close→重建→数据在；② 坏 URL → file＋reason 含"文件台账"与"不自动回流"；③ 不可写 → memory＋degraded；④ 自愈幂等（2 份 fixture→登记 2；再次加载不翻倍；第 1 份坏 → 继续第 2 份）；⑤ **凭证回落**：file store 下 `aos_configure` 等价（upsertLlm＋.env）→ 重建 → 激活条目 key 自 env 可用；⑥ runner 守卫 message 新文案且 file 仍 exit 2；⑦ backfill file 放行、memory exit 2；⑧ project-archive 对 file 无"内存存储"降级项。
- [ ] **Step 2: 跑测试确认失败。** **Step 3: 实现。** **Step 4: 通过＋全量**（既有断言按新文案修复）。**Step 5: 更新 DESIGN**（装配顺序、合并写、单写者窗口、守卫决策、凭证链）＋**Commit**：`git commit -m "feat(db): persistent-by-default assembly + env credential fallback + self-heal + guard rulings"`

---

### Task 4: 内部编排审计接线

**Files:**
- Modify: `src/tasks/run-registry.ts`（`recordSuiteRun` 后 → `"suite"/"run.recorded"`）
- Modify: `src/workflow/excel-import.ts`（`"import"/"excel.imported"`；失败 `result:"failed"`）
- Modify: `src/runner/schedules.ts`（`"schedule"/"fired"`，refs `{scheduleId, taskId}`）
- Modify: `src/panel/actions.ts`（每个动作 → `"panel"/"action.<name>"`，失败也记）
- Modify: `src/workflow/verify-jira.ts`（`"verify"/"writeback"`）、`src/panel/issues.ts`（`"issues"/"linked"`）
- Test: `test/audit-wiring.test.js`（新建）

**Interfaces:**
- Consumes: `recordAudit`（Task 1）；接线原则 = best-effort（失败仅 `log()`，不影响主流程）。

- [ ] **Step 1: 写失败测试**：六点各最小调用 → `listAudit` 含对应 domain/action/refs；summary ≤300 且**不含注入的 token 字串**。
- [ ] **Step 2: 跑测试确认失败。** **Step 3: 实现接线。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(audit): record internal orchestration events"`

---

### Task 5: 产物索引

**Files:**
- Create: `src/artifacts/index.ts`、`test/artifacts.test.js`
- 参考: `src/tasks/retention.ts` 资产族（口径同源；trace 深度按实际目录逐级核对，一层不足则按族定义补层）。

**Interfaces:**
- Produces:
```ts
export interface ArtifactRecord { kind: "run"|"case-set"|"report"|"diff"|"crash"|"trace"; path: string; title: string; at: string; size: number; meta?: Record<string,string> }
export interface ArtifactQuery { kind?: ArtifactRecord["kind"]; since?: string; q?: string; limit?: number }
export function listArtifacts(rootPath: string, query?: ArtifactQuery): Promise<ArtifactRecord[]>; // at 新→旧；目录缺失=[]，不抛错
```

- [ ] **Step 1: 写失败测试**（fixture 六类＋过滤/排序/空项目）。**Step 2: 失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(artifacts): project artifact index"`

---

### Task 6: 三口径导出（结果/过程/数据）＋CLI

**Files:**
- Create: `src/export/index.ts`、`test/export.test.js`、`test/cli-export.test.js`
- Modify: `src/cli.ts`（注册 `export`）、`src/commands.ts`（help）

**Interfaces:**
- Produces:
```ts
export type ExportWhat = "results" | "process" | "data";
export function exportProjectData(rootPath: string, store: ProjectStore, req: { what: ExportWhat; format?: "json"|"csv"; since?: string; limit?: number }): Promise<{ what: ExportWhat; format: "json"|"csv"; filename: string; contentType: string; content: string; counts: Record<string, number> }>;
// results: suite runs＋verdicts＋issue keys；process: audit 事件＋regression tasks＋schedules＋runners；data: case sets＋task stats＋artifacts
// csv：每 what 一张主表；**导出内容不含凭证**（state 已剥离＋导出侧再过滤）
```
- CLI：`export --project <dir> --what … [--format json|csv] [--out <file>] [--since] [--limit]`；exit 0/2。

- [ ] **Step 1: 写失败测试**（三 what JSON 计数；csv 表头/行数；filters；CLI 端到端；**含 file store 项目 process 导出非空**）。**Step 2: 失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(export): results/process/data export (JSON/CSV + CLI)"`

---

### Task 7: 全量文案整改＋行为位分类表＋文档收尾

**Files:**
- Modify（文案/标签/判据；`"file"` 不降级）：`src/panel-command.ts:120,213`、`src/panel/web.ts:372,566`、`src/panel/overview.ts:657,725,793`、`src/panel/deep.ts:23,128`、`src/panel/compare.ts:50,244`、`src/usage/web.ts:101,255,370,449`、`src/usage-command.ts:79,142,153`、`src/commands.ts:325`、`src/tools/aos.ts:36`、`src/tools/llm.ts:98,137,168,204`、`src/tools/usage.ts:25,102`、`src/tools/configure.ts:162`、`src/runtime.ts:910,1089`、`src/workflow/project-archive.ts:73`、`src/suite-command.ts:456`
- Create: `test/copy-gate.test.js`（`src/**/*.ts` 排除 vendor，禁「降级.*内存|内存.*降级」）
- Modify: `README.md`、`docs/接入指南.md`、`DESIGN.md`（新增 §13.125：记录底座全量记录——含**行为位分类表**、合并写/单写者窗口、凭证剥离链、规模包络「文件台账适用于 ≤ 数百次运行规模，超出请配 PG」、journal 纯取证定案、分裂脑说明、审计保留）

**统一口径（照抄）**：postgres→`PostgreSQL`；file→`文件台账（.artemis/ledger）`；memory→`会话内存（仅本次进程，数据不持久）`。

- [ ] **Step 1: 写失败测试** `test/copy-gate.test.js`（当前多处命中）。**Step 2: 失败。** **Step 3: 整改＋更新既有断言。** **Step 4: `npm run build && npm test && npm run lint` 全绿。** **Step 5: 文档更新＋Commit**：`git commit -m "fix(copy): honest storage wording; behavior-site table; docs"`

---

**并行依赖（与 Plan B）**：B Task 7/8 消费本计划 Task 1（审计）与 Task 5/6（索引/导出）；Task 1 先行合入。执行记录在 `.superpowers/sdd/2026-10-18-data-foundation/progress.md`。
