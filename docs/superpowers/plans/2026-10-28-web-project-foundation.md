# Web 项目与 Excel 资产基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员能在现有 panel 网页创建全局唯一的托管项目，上传任意 Excel 并保存列映射，生成可写工作副本，并在空白系统列中安全写回建议/结果。

> 本计划是 4 个子系统计划中的第 1 个（Project/Asset/Excel 基础）；后续依次为 Script/Discovery、Remote Runner/Execution、Billing。每个计划独立可运行、可测试。

**Architecture:** 在现有 panel/store 上增加 `web_projects`、`web_assets`、`excel_mappings`、`excel_writeback_journal` 四个领域；项目目录由中心按名称创建，Excel 原件进 CAS 且不可变，工作副本是派生物，写回由中心单一写者加锁执行。脚本/远程 runner/计费不在本计划内，后续计划复用这些接口。

**Tech Stack:** TypeScript (ESM/NodeNext, strict)、exceljs、现有 Memory/File/PostgreSQL store、现有 panel/HTTP action 层、node:test + pg-mem。

**Spec:** `docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md`

## Global Constraints

- TypeScript strict、ESM、相对导入带 `.js`；不新增运行时依赖（exceljs 已在依赖中）。
- 所有测试不触网、不依赖真实 PG/设备；store 测试用 Memory/File，PG 测试用 pg-mem。
- 项目名 NFKC + 大小写归一后全局唯一；目录由系统创建，禁止路径分隔符/`..`/控制字符。
- Excel 原件不可变；工作副本可写；staleness/assetSnapshot 挂原件 `sha256`，写回不改变原件 sha。
- 系统列固定 8 列；以 `testcase_id` 为锚，表头行向右扫描；只写空白格或未被人工改动的系统格；人工格永不覆盖。
- 写回只在中心服务执行，runner 不写 Excel；同工作副本串行加锁。
- 不在 stdout 打日志；服务日志用 `log()`；所有写动作写审计。
- 完工必须 `npm run build && npm test && npm run lint` 全绿，并同步 `DESIGN.md` §13.x。

## Review Focus

- Excel 表头行存在孤立远列、合并单元格、公式、drawings/images 时，系统列定位/写回必须拒绝或跳过，不能写坏工作簿。
- 用例编号重复/为空/步骤为空时，必须按行报告，不能静默覆盖或丢弃。
- 两个任务同时写同一工作副本时，不能出现覆盖/重复列/损坏文件。
- 人工修改了系统写过的单元格后，重跑不能覆盖人工值；人工清空也不能自动回填。
- 中文/空格/大小写项目名、同名冲突、路径穿越输入必须得到明确错误，不能创建半成品目录。

---

### Task 1: Web 项目领域存储

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/file.ts`
- Modify: `src/db/postgres.ts`
- Test: `test/web-project-store.test.js`

**Interfaces:**
- Produces:
```ts
export type WebProjectStatus = "active" | "archived";
export interface WebProjectRecord {
  id: string;
  projectId: string | null;
  rootPath: string;
  name: string;
  normalizedName: string;
  platforms: string[];
  appPackage: string | null;
  customerName: string | null;
  owner: string | null;
  status: WebProjectStatus;
  createdAt: string;
}
```
- Store methods on `ProjectStore`:
```ts
createWebProject(input: {
  rootPath: string; name: string; normalizedName: string;
  platforms: string[]; appPackage?: string | null;
  customerName?: string | null; owner?: string | null;
  projectId?: string | null;
}): Promise<WebProjectRecord>;
getWebProject(rootPath: string): Promise<WebProjectRecord | null>;
listWebProjects(): Promise<WebProjectRecord[]>;
archiveWebProject(rootPath: string, at: string): Promise<boolean>;
```

- [ ] **Step 1: Write failing store tests**

`test/web-project-store.test.js` covers MemoryStore + pg-mem:
```js
const created = await store.createWebProject({
  rootPath: "/w/acme", name: "星巴克", normalizedName: "星巴克",
  platforms: ["android"], appPackage: "com.starbucks.tw", owner: "admin"
});
assert.equal(created.name, "星巴克");
assert.equal((await store.getWebProject("/w/acme")).appPackage, "com.starbucks.tw");
await assert.rejects(
  store.createWebProject({ rootPath: "/w/other", name: "星巴克", normalizedName: "星巴克", platforms: [] }),
  /UNIQUE|已存在|duplicate/i
);
assert.equal(await store.archiveWebProject("/w/acme", "2026-10-28T00:00:00.000Z"), true);
assert.equal((await store.getWebProject("/w/acme")).status, "archived");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/web-project-store.test.js`
Expected: FAIL (`createWebProject is not a function`).

- [ ] **Step 3: Add types and MemoryStore implementation**

`MemoryStoreState` 增加 `webProjects: WebProjectRecord[]`；`createWebProject` 用 `normalizedName` 查重（大小写已归一），生成 `randomUUID()`，写入数组；`getWebProject` 按 rootPath；`listWebProjects` 新→旧；`archiveWebProject` 改 status/archivedAt（若记录无 archivedAt 字段，可只改 status，计划不新增该字段）。

- [ ] **Step 4: Add FileStore persistence**

`ProjectBucket` 的 state 快照包含 `webProjects`，加载时 import；`createWebProject` 调 Memory 实现后 `persist(bucket, "createWebProject")`；`archiveWebProject` 同理。文件台账只在项目桶内保存，不写到 registry。

- [ ] **Step 5: Add PostgreSQL table + migration**

`CREATE TABLE IF NOT EXISTS web_projects (...)`：`id TEXT PRIMARY KEY`, `project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`, `root_path TEXT NOT NULL UNIQUE`, `name TEXT NOT NULL`, `normalized_name TEXT NOT NULL UNIQUE`, `platforms TEXT NOT NULL DEFAULT '[]'`, `app_package TEXT`, `customer_name TEXT`, `owner TEXT`, `status TEXT NOT NULL DEFAULT 'active'`, `created_at TEXT NOT NULL`.
MIGRATIONS 增加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 对应字段（若第一版表已含则不需要）。
实现 `createWebProject`/`getWebProject`/`listWebProjects`/`archiveWebProject`，唯一冲突抛错。

- [ ] **Step 6: Run tests**

Run: `npm run test:file -- test/web-project-store.test.js`
Expected: PASS（Memory + pg-mem；FileStore 至少一个重启后仍可读用例）。

- [ ] **Step 7: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/db/file.ts src/db/postgres.ts test/web-project-store.test.js
git commit -m "feat: add web project store"
```

---

### Task 2: 项目创建服务（名称/目录/配置）

**Files:**
- Create: `src/web/project-service.ts`
- Test: `test/web-project-service.test.js`

**Interfaces:**
- Produces:
```ts
export function normalizeProjectName(raw: string): { name: string; normalized: string };
export function projectSlug(name: string): string;
export async function createWebProject(input: {
  store: ProjectStore;
  workspaceRoot: string;
  name: string;
  platforms: string[];
  appPackage: string;
  customerName?: string | null;
  owner?: string | null;
}): Promise<{ project: ProjectRecord; web: WebProjectRecord; rootPath: string }>;
```

- [ ] **Step 1: Write failing tests**

Cases: 中文名创建成功；`name` 前后空白/全半角归一；含 `/`、`..`、控制字符拒绝；同名（大小写/NFKC）拒绝；目录已存在拒绝；成功后存在 `aos.config.jsonc`、`.artemis/web/{assets,workbook,scripts,results}`，且 store 有 project + web 记录。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/web-project-service.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement normalization/slug**

`name.trim().normalize("NFKC")`；`normalized = name.toLowerCase()`；校验长度 1–64、非空、不含 `/`、`\`、`..`、控制字符；`projectSlug` 保留 Unicode 字母数字，空白转 `-`，其余转 `-`，压缩连续 `-`，空则 `project-<sha256(name).slice(0,8)>`。

- [ ] **Step 4: Implement creation**

- 目标目录 `path.join(workspaceRoot, slug)`；存在即报错。
- `mkdir` 项目与 `.artemis/web/{assets,workbook,scripts,results}`。
- 写 `aos.config.jsonc`：`{ project: { name, stack: platforms }, llm: { profiles: {} }, artemis: {} }`；用 `writeFileAtomic`。
- 先 `store.createWebProject`，再 `store.upsertProject({ rootPath, name })`；任一步失败清理目录并回滚已建记录（best-effort）。
- 返回 records。

- [ ] **Step 5: Run tests**

Run: `npm run test:file -- test/web-project-service.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/project-service.ts test/web-project-service.test.js
git commit -m "feat: create managed web projects"
```

---

### Task 3: 项目创建 API + 权限 + 审计 + 入口表单

**Files:**
- Modify: `src/panel/actions.ts`
- Modify: `src/panel/roles.ts`
- Modify: `src/console/pages.ts`
- Modify: `src/panel/web.ts`
- Test: `test/web-project-api.test.js`

**Interfaces:**
- `POST /panel/api/projects` body `{ name, platforms, appPackage, customerName? }` → `{ ok:true, project:{ rootPath, name, platforms, appPackage } }`；role `admin`；失败 400/409 JSON。
- `POST /panel/api/projects/archive` body `{ project }` → `{ ok:true }`；admin。
- `panelRequiredRoleForPath` 将两个路径映射到 `admin`。

- [ ] **Step 1: Write failing API tests**

`handlePanelActionRequest` with MemoryStore + admin identity:
- 成功创建后 store 有记录、审计有 `project.create`。
- 重名 409。
- dispatcher 请求 403。
- 非法名 400。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/web-project-api.test.js`
Expected: FAIL (404/未实现).

- [ ] **Step 3: Implement action branch**

在 `handlePanelActionRequest` 的 POST 分支前加 `projects` 路由；解析 body，调用 `createWebProject({ store, workspaceRoot: deps.workspaceRoot ?? process.cwd(), ... })`；`recordAuditSafe` 写 `domain:"project", action:"project.create"`；返回 JSON。错误用 `json(400/409,{error})`。

- [ ] **Step 4: Implement overview create form**

`renderOverviewPage` 增加 admin 可见的「新增项目」卡片：字段 name/platforms/appPackage/customerName，提交到 `/panel/api/projects`，成功后 `location.href=/panel?project=<rootPath>`；无 `AOS_PANEL_ACTIONS` 时隐藏/禁用。使用现有 `aosFlash`/站内确认风格。

- [ ] **Step 5: Run tests**

Run: `npm run test:file -- test/web-project-api.test.js test/console-pages.test.js`
Expected: PASS；旧 overview 断言不回归。

- [ ] **Step 6: Commit**

```bash
git add src/panel/actions.ts src/panel/roles.ts src/console/pages.ts src/panel/web.ts test/web-project-api.test.js
git commit -m "feat: add web project creation API and form"
```

---

### Task 4: Web 资产存储 + Excel 上传/CAS

**Files:**
- Modify: `src/db/types.ts` / `memory.ts` / `file.ts` / `postgres.ts`
- Create: `src/web/assets.ts`
- Modify: `src/panel/actions.ts`（multipart 上传）
- Test: `test/web-assets.test.js`

**Interfaces:**
```ts
export type WebAssetKind = "excel" | "materials" | "package";
export interface WebAssetRecord { id; projectId; rootPath; kind; version; filename; sha256; size; storagePath; uploadedBy; createdAt; metadata: Record<string, unknown>; }
export async function storeWebAsset(input: {
  store: ProjectStore; rootPath: string; kind: WebAssetKind;
  filename: string; buffer: Buffer; uploadedBy?: string | null;
}): Promise<WebAssetRecord>;
export async function listWebAssets(store: ProjectStore, rootPath: string, kind?: WebAssetKind): Promise<WebAssetRecord[]>;
```
- `POST /panel/api/projects/assets` multipart with fields `project`, `kind=excel`；role maintainer；≤20MB；只 `.xlsx`。

- [ ] **Step 1: Write failing tests**

- `storeWebAsset` 写 `assets/excel/<sha>.xlsx`，重复内容复用同一文件但 version 递增。
- 非 `.xlsx` 抛错；>20MB 抛错。
- API 上传后 list 返回记录，审计 `asset.upload`。
- FileStore 重启后资产记录仍在。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/web-assets.test.js`
Expected: FAIL.

- [ ] **Step 3: Add store types/methods**

`web_assets` 表 + Memory/File 实现；唯一 `(root_path, kind, sha256)` 用于内容去重；`version` 为同 kind 最大 +1。

- [ ] **Step 4: Implement assets service**

sha256 计算；扩展名白名单；目录 `path.join(rootPath, ".artemis", "web", "assets", kind)`；`writeFileAtomic`；若目标已存在则复用；`store.createWebAsset`。

- [ ] **Step 5: Implement upload action**

在 `handlePanelActionRequest` 的 multipart 分支增加 `POST /panel/api/projects/assets`：解析 `parseMultipartUpload`，校验项目属于请求者可见范围，调用 `storeWebAsset`，写审计，返回记录摘要（不含文件内容）。

- [ ] **Step 6: Run tests**

Run: `npm run test:file -- test/web-assets.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/db/file.ts src/db/postgres.ts src/web/assets.ts src/panel/actions.ts test/web-assets.test.js
git commit -m "feat: add web asset CAS upload"
```

---

### Task 5: 任意 Excel 解析 + 列映射 + 语义指纹

**Files:**
- Create: `src/web/excel-columns.ts`
- Modify: `src/workflow/excel-import.ts`（复用别名表）
- Create: `src/web/excel.ts`
- Test: `test/web-excel.test.js`

**Interfaces:**
```ts
export const CANONICAL_FIELDS = ["caseId","name","steps","expected","preconditions","module","priority","testData","testId"] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export type ExcelColumnMap = Partial<Record<CanonicalField, string>>;
export interface ParsedExcelCase { caseId; name; steps: string[]; expected: string|null; preconditions: string[]; module: string|null; priority: string|null; testData: string|null; testId: string|null; rowNumber: number; }
export interface ParsedExcel { sheetName; headers: string[]; cases: ParsedExcelCase[]; rejected: Array<{row:number; reason:string}>; }
export function suggestExcelMapping(headers: string[]): ExcelColumnMap;
export function semanticFingerprint(sheetName: string, headers: string[]): string;
export function parseExcel(buffer: Buffer, input: { sheetName?: string; headerRow?: number; mapping: ExcelColumnMap }): ParsedExcel;
```

- [ ] **Step 1: Write failing tests**

Use exceljs to build buffers:
- 表头别名 `用例编号/步骤/预期` 自动建议。
- 列顺序调整/加无关列仍建议同样映射。
- 重复 `caseId`：第一条保留，后续进 `rejected`。
- 空 caseId/空 steps 进 rejected。
- 数字 caseId 变字符串；公式单元格读取缓存值或拒绝。
- `semanticFingerprint` 在列顺序变化时相同、在必填字段缺失时不同。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/web-excel.test.js`
Expected: FAIL.

- [ ] **Step 3: Extract alias table**

把 `src/workflow/excel-import.ts` 的 `ALIASES`（用例编号/名称/步骤/预期/前置/模块/优先级/测试数据等）导出到 `src/web/excel-columns.ts`，原导入器改为引用；保持现有导入测试全绿。

- [ ] **Step 4: Implement parser**

`Workbook.xlsx.load(buffer)`；选 sheet（缺省第一个）；headerRow 默认 1；按 mapping 的 header 文本定位列；缺失必填列抛 `ExcelMappingError`；逐行 trim；重复 caseId 保留第一条；rejected 带行号/原因；steps 按换行拆成数组但保留原文。

- [ ] **Step 5: Implement fingerprint**

`semanticFingerprint = sha256(JSON.stringify({sheet: sheetName, fields: CANONICAL_FIELDS.filter(f => mappingHas(f)).sort()}))`；不包含列顺序/表头文本，避免错别字/换序导致失效。

- [ ] **Step 6: Run tests**

Run: `npm run test:file -- test/web-excel.test.js test/excel-import.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/excel-columns.ts src/web/excel.ts src/workflow/excel-import.ts test/web-excel.test.js
git commit -m "feat: parse arbitrary excel with column mapping"
```

---

### Task 6: 映射持久化 + 预览 API

**Files:**
- Modify: `src/db/types.ts` / `memory.ts` / `file.ts` / `postgres.ts`
- Create: `src/web/excel-mapping.ts`
- Modify: `src/panel/actions.ts`
- Test: `test/web-excel-mapping.test.js`

**Interfaces:**
```ts
export interface ExcelMappingRecord { id; rootPath; assetId; sheetName; headerFingerprint; columnMap: Record<string,string>; createdBy; createdAt; }
export async function saveExcelMapping(input): Promise<ExcelMappingRecord>;
export async function findExcelMapping(store, rootPath, assetId, fingerprint): Promise<ExcelMappingRecord|null>;
```
- `POST /panel/api/projects/excel/preview` body `{ assetId, headerRow? }` → `{ headers, suggested, fingerprint, rejectedPreview }`
- `POST /panel/api/projects/excel/mapping` body `{ assetId, sheetName, headerRow, columnMap }` → saved record.
- role maintainer.

- [ ] **Step 1: Write failing tests**

- 保存后同 asset+fingerprint 能查回；列顺序变化后语义指纹相同仍命中。
- 预览返回 headers/suggested；缺必填列 400。
- 非项目资产 404。

- [ ] **Step 2-6:** 按 Task 1/4 的 store 模式加 `excel_mappings` 表/Memory/File；实现 mapping service 与 action；运行 `npm run test:file -- test/web-excel-mapping.test.js`；提交 `feat: persist excel mappings`。

---

### Task 7: 工作副本 + 写回 Journal + 8 列写回引擎

**Files:**
- Modify: `src/db/types.ts` / `memory.ts` / `file.ts` / `postgres.ts`
- Create: `src/web/workbook.ts`
- Create: `src/web/writeback.ts`
- Create: `src/web/lock.ts`
- Test: `test/web-writeback.test.js`

**Interfaces:**
```ts
export const SYSTEM_COLUMNS = [
  { key: "scriptFile", header: "建议｜脚本文件" },
  { key: "expectedHint", header: "建议｜关键预期" },
  { key: "result", header: "执行｜结果" },
  { key: "device", header: "执行｜设备与系统" },
  { key: "package", header: "执行｜安装包" },
  { key: "startedAt", header: "执行｜开始时间" },
  { key: "finishedAt", header: "执行｜结束时间" },
  { key: "traceId", header: "执行｜traceId" }
] as const;
export type SystemColumnKey = (typeof SYSTEM_COLUMNS)[number]["key"];
export interface WritebackRow { caseId: string; values: Partial<Record<SystemColumnKey, string>>; }
export interface WritebackResult { written: number; skipped: number; failed: number; columns: string[]; warnings: string[]; }
export async function ensureWorkbookCopy(originalPath: string, workbookPath: string): Promise<void>;
export async function writebackWorkbook(input: {
  workbookPath: string;
  assetId: string;
  sheetName: string;
  caseIdHeader: string;
  rows: WritebackRow[];
  lastSystemValue: (caseId: string, key: SystemColumnKey) => Promise<string | null>;
}): Promise<WritebackResult>;
```
- `lastSystemValue` 读 `excel_writeback_journal`。
- `withFileLock(lockPath, fn)` 供 API 层串行写回。

- [ ] **Step 1: Write failing tests**

Fixtures with exceljs:
- 首次写：8 列追加在 testcase_id 锚点后；值写入对应行。
- 二次写：系统格从 FAIL → PASS 可刷新；human 改成 `人工` 后跳过。
- 人工清空系统格后不自动回填。
- testcase_id 右侧有数据但无表头的游离列：不参与锚定，不覆盖。
- 合并单元格/公式：跳过并 warning；锚点与合并区重叠则抛错。
- 并发：两个 `writebackWorkbook` 串行（同一 lock）不重复列、文件可重新打开。
- 原件 sha 不变（服务层测试）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/web-writeback.test.js`
Expected: FAIL.

- [ ] **Step 3: Add journal store**

`excel_writeback_journal` 表/Memory/File；`recordExcelWriteback`、`lastExcelWriteback`；唯一/索引 `(rootPath, assetId, cellRef)` 取最后一条。

- [ ] **Step 4: Implement workbook copy + anchor + columns**

`ensureWorkbookCopy` 复制原件到工作副本；`writebackWorkbook` 打开工作副本，按 caseIdHeader 找列，扫描表头行从 caseId 列向右最后非空表头；找已有系统列（按 header）否则追加；不碰 caseId 左侧。

- [ ] **Step 5: Implement cell ownership**

读单元格当前值、`lastSystemValue`；规则：空+无 journal → 写；current === last → 写；否则跳过并 warning。写后 `worksheet.getCell(...).value = value`；保存后重新打开自检（可选 Task 8）。

- [ ] **Step 6: Implement file lock**

`withFileLock(lockPath, fn)` 用 `fs.open(lockPath, "wx")` + 30s 超时重试，finally 删除；多实例由 PG advisory lock 后续接入。

- [ ] **Step 7: Run tests**

Run: `npm run test:file -- test/web-writeback.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/db/file.ts src/db/postgres.ts src/web/workbook.ts src/web/writeback.ts src/web/lock.ts test/web-writeback.test.js
git commit -m "feat: write back excel system columns with journal"
```

---

### Task 8: 资产/映射页面 + 项目入口

**Files:**
- Modify: `src/panel/web.ts`
- Modify: `src/console/pages.ts`
- Test: `test/web-assets-ui.test.js`

**Interfaces:**
- `PanelView` 增加 `{ kind: "web-assets"; project: PanelProjectRow; assets: WebAssetRecord[]; mappings: ExcelMappingRecord[] }`。
- `section=assets` 页面：上传 Excel 表单、资产版本表、映射预览表、保存映射按钮。
- 项目页/项目列表增加「测试资产」入口。

- [ ] **Step 1: Write failing UI tests**

- `GET /panel?project=<root>&section=assets` 200，含上传表单、资产文件名、版本、映射列。
- 非 admin/maintainer 角色隐藏上传动作。
- 项目页含「测试资产」链接。

- [ ] **Step 2-5:** 加 view builder、page renderer、route；上传走 `POST /panel/api/projects/assets`，保存映射走 `/panel/api/projects/excel/mapping`；运行 `npm run test:file -- test/web-assets-ui.test.js`；提交 `feat: add web asset and mapping pages`。

---

### Task 9: 端到端与文档

**Files:**
- Create: `test/web-project-e2e.test.js`
- Modify: `DESIGN.md`

- [ ] **Step 1: Write E2E test**

MemoryStore + temp workspace：创建项目 → 上传 Excel → 预览/保存映射 → 创建 work copy → 写回 8 列 → 断言原件 sha 不变、工作副本有系统列、journal 有记录、第二次写回刷新系统格、人工格冻结。

- [ ] **Step 2: Run E2E**

Run: `npm run test:file -- test/web-project-e2e.test.js`
Expected: PASS.

- [ ] **Step 3: Update DESIGN.md**

在 §13 增加一条实施记录（日期、范围、store 表、文件路径、验收、后续计划 2–4），并注明 Excel 原件 CAS/工作副本/journal、testcase_id 锚定、单一写者。

- [ ] **Step 4: Full verification**

Run: `npm run build && npm test && npm run lint`
Expected: 全部通过（lint 0 error，允许既有 warning）。

- [ ] **Step 5: Commit**

```bash
git add test/web-project-e2e.test.js DESIGN.md
git commit -m "docs: record web project foundation"
```

---

## Self-Review

- Spec §3.1/§3.2/§4.2/§4.2b/§4.3/§5.1/§5.2 由 Task 1–9 覆盖；脚本/runner/计费不在本计划，进入后续计划。
- 所有 store 方法在 Memory/File/PG 三实现；PG 迁移有唯一约束；测试用 pg-mem。
- 项目名唯一、目录创建失败回滚、Excel 重复行、合并/公式、并发写回、人工格冻结均有测试。
- 交付物为 Plan 1 可独立运行：能建项目、上传/映射 Excel、生成工作副本并安全写回；不依赖脚本/计费模块。
- 范围口径：Plan 1 交付「写回引擎 + E2E 验收」；生产环境的写回接线（任务结果 → 工作副本 → journal → 面板/下载）在 Plan 2/3 落地，本计划不接执行结果。
