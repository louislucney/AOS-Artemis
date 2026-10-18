# Web 控制台（CSDC 原地升级＋下发闭环）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/panel` 与 `/usage` 原地升级为 CSDC 风格的可操作控制台——能看（总览/项目/任务/档案/审计）、能做（下发/导入/计划/裁决建单/资产/导出六类动作，全部带确认与审计）。

**Architecture:** 新增 `src/console/`（tokens／shell／components，服务端渲染 HTML＋单一 CSS 变量源）；页面按现有查询参数契约原地迁移；动作层沿用 `/panel/api/*` 命名空间扩展端点，HTTP 模式行为不变，独立进程在 `AOS_PANEL_ACTIONS=1` 且 loopback 时开放同一动作处理器；全部写操作接线 Plan A 的 `recordAudit`。

**Tech Stack:** TypeScript ESM、服务端渲染 HTML/CSS（无前端构建链）、`node --test`、现有 `PanelWebDeps`/`handlePanelActionRequest` 模式、`node:http`。

**Spec:** `docs/superpowers/specs/2026-10-18-web-console-shape.md`（§6 信息架构与交互）＋ `PRODUCT.md`；参考 `web-console/DESIGN.md`（本计划 Task 1 产出）。

## Global Constraints

- 完工标准：`npm run build && npm test && npm run lint` 全绿；`DESIGN.md`＋`README.md` 同步；测试不依赖真实 PG/设备/外网。
- **JSON 契约不动**：`/panel.json`、`/usage.json` 的字段与参数（`project/batch/task/view=review|stats/ios`、`days/tool/status/limit/offset/refresh`）保持兼容；旧链接不得 404。
- CSDC token 原样（`#FFE600`/`#34C759`/`#FF3B30`/`#FF9500`/`#0066CC`、`#1D1D1F/#6E6E73/#86868B`、`#F5F5F7/#FFFFFF/#EFEFF2`、`#D2D2D7`、圆角 6/10/14/18/980、`blur(20px)`、SF Pro/PingFang）；先只做亮色。
- 动作层安全：HTTP 模式行为不变（`AOS_PANEL_ACTIONS=0` 关）；独立进程仅 `AOS_PANEL_ACTIONS=1` 且 loopback 时开放动作；每个写操作**必须**写审计（Plan A `recordAudit`）。
- 用户可见文案中文；所有页面数据真实（空态就空态，不造假样本）；HTML 用户数据一律转义。
- 日志走 `log()`（stderr）。

## Review Focus

1. **XSS/转义**：项目名、路径、用例标题、审计摘要进入 HTML 必须转义——决定控制台能否安全展示任意项目数据（Task 2/3/4/8）。
2. **动作安全**：独立进程默认无动作；`AOS_PANEL_ACTIONS=1` 仅 loopback 生效；外部副作用（建单）dryRun 预览后才允许提交；每次动作含失败也落审计（Task 7）。
3. **契约兼容**：`/panel.json`/`/usage.json` 字段与旧查询参数不变；旧书签（`?view=review` 等）不 404（Task 3–5 迁移时回归）。
4. **上传边界**：Excel 上传限 `.xlsx`、单文件 ≤20MB、边界解析不吞挂进程内存、临时文件必清理（Task 7）。
5. **刷新风暴**：仅活跃态（运行中任务/进行中批次）自动刷新，非活跃页不得轮询；`meta refresh` 或轻量 fetch 二选一（Task 6/8）。
6. **降级如实**：存储/runner/设备缺失一律「未配置 X → 影响 Y → 启用 Z」，无"内存降级"字样（Task 5 与 Plan A Task 7 同口径）。

---

### Task 1: CSDC token 源＋控制台外壳＋视觉体系文档

**Files:**
- Create: `src/console/tokens.ts`（`export const CSDC_TOKENS_CSS: string`）
- Create: `src/console/shell.ts`（`export interface ConsoleShellInput {...}; export function renderConsoleShell(input: ConsoleShellInput): string`）
- Create: `web-console/DESIGN.md`（CSDC 映射与组件规范：token 表、版式、组件类名、状态色、间距节奏；来源 `.scratch/web-console/references/csdc/`）
- Modify: `src/panel/web.ts`（先把现有总览页包进 shell，内容区暂保持原渲染）
- Test: `test/console-shell.test.js`（新建）、`test/panel-web.test.js`（更新外壳断言）

**Interfaces:**
- Produces:
```ts
export type ConsoleNavKey = "overview" | "project" | "tasks" | "dispatch" | "library" | "archive" | "runners" | "schedules" | "ops" | "audit" | "usage";
export interface ConsoleNavItem { key: ConsoleNavKey; label: string; href: string; badge?: string }
export interface ConsoleShellInput {
  title: string; active: ConsoleNavKey; body: string;
  nav?: ConsoleNavItem[];     // 缺省用 DEFAULT_CONSOLE_NAV（/panel?section= 链接；usage 用精简 nav）
  meta?: string;              // 副标题/项目上下文
  headExtra?: string;         // 页面级 style/script（现有交互脚本）
  autoRefreshSeconds?: number; // 仅活跃态传入
}
export function renderConsoleShell(input: ConsoleShellInput): string; // 完整 <html>，内联 CSDC_TOKENS_CSS
```
- Shell 结构：毛玻璃顶栏（品牌＋搜索＋存储徽章）＋左栏导航（active 高亮）＋主区（`<main>`）＋页脚（构建信息）；`<html lang="zh-CN">`。

- [ ] **Step 1: 写失败测试** `test/console-shell.test.js`：shell 输出含 `lang="zh-CN"`、`--accent: #FFE600`、active 导航项标记、`title` 转义（传 `<script>` 不出现在输出）。
- [ ] **Step 2: 跑测试确认失败**（`npm run test:file -- test/console-shell.test.js`）。
- [ ] **Step 3: 实现 tokens/shell**（token 值从 `.scratch/web-console/references/csdc/design-tokens.css` 照抄所需子集）；`src/panel/web.ts` 总览页套壳。
- [ ] **Step 4: 通过＋更新 `test/panel-web.test.js`**（原断言迁移到新结构）；全量 `npm test`。
- [ ] **Step 5: 写 `web-console/DESIGN.md`**；**Commit**：`git commit -m "feat(console): CSDC tokens + shell + visual system doc"`

---

### Task 2: 组件层

**Files:**
- Create: `src/console/components.ts`、`test/console-components.test.js`
- 复用: `src/panel/web.ts` 既有 `escapeHtml`（若为私有则提升导出，勿复制两份）

**Interfaces:**
- Produces（全部返回字符串，输入已转义，属性输出双引号）：
```ts
export function cCard(input: { title?: string; subtitle?: string; tone?: "default" | "accent"; actions?: string; body: string }): string;
export function cBadge(input: { label: string; tone: "neutral" | "accent" | "success" | "error" | "warning" }): string;
export function cBanner(input: { tone: "info" | "accent" | "warn"; title: string; body?: string; actions?: string }): string;
export function cTable(input: { columns: string[]; rows: string[][]; empty?: string; caption?: string }): string; // 行内容视为已构建 HTML
export function cStat(input: { label: string; value: string; hint?: string }): string;
export function cEmpty(input: { title: string; body: string; action?: string }): string;
export function cConfirmForm(input: { action: string; project: string; fields: Record<string,string>; label: string; confirm: string; danger?: boolean }): string; // data-confirm 属性＋内联确认脚本
```
- 语义：表格用 `<table>`＋`<th scope="col">`；状态不只用颜色（badge 带文字）；`cConfirmForm` 的确认短语由 `confirm` 提供（danger 时要求输入短语才可提交）。

- [ ] **Step 1: 写失败测试**：每个组件的结构断言（类名/语义标签/空态）＋转义断言（`<b>` 输入输出为 `&lt;b&gt;`）。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(console): CSDC component builders"`

---

### Task 3: 总览／项目／对比页迁移

**Files:**
- Modify: `src/panel/web.ts`（总览表、项目驾驶舱区块）、`src/panel/overview.ts`（区块数据不变，渲染改由 web 层）、`src/panel/compare.ts`（`?view=compare` 页）
- Test: `test/panel-web.test.js`、`test/panel-overview.test.js`、`test/panel-compare.test.js`（断言更新）

**Interfaces:**
- Consumes: `cCard/cBadge/cBanner/cTable/cStat/cEmpty`（Task 2）；总览数据口径不变（健康灯/存储/待办/最近批次）。
- 项目页第一屏＝「一屏三问」：健康（凭据/存储/设备/runner）｜在跑什么（活跃任务卡）｜下一步（待办＋下发入口按钮，链到 `?section=dispatch`）。

- [ ] **Step 1: 写失败测试**（新结构断言：项目页含三问区块与下发入口；compare 表在 `?view=compare` 下渲染）。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 迁移渲染**（不动数据口径与 JSON）。**Step 4: 通过＋`/panel.json` 契约回归**（既有测试全绿）。**Step 5: Commit**：`git commit -m "feat(console): migrate overview/project/compare pages to CSDC"`

---

### Task 4: 任务／批次／归因／运行机页迁移

**Files:**
- Modify: `src/panel/web.ts`（任务列表/详情、批次区块）、`src/panel/deep.ts`（运行机/深探区块渲染）、`src/panel/stats.ts`
- Test: `test/panel-deep.test.js`、`test/panel-stats.test.js`、`test/panel-web.test.js`（断言更新）

**Interfaces:**
- Consumes: 组件层（Task 2）；任务状态机显示不变（pending/claimed/running/completed/partial/failed ＋ 领取方在线/失联）；任务详情区块补「释放重跑」按钮（Task 7 接 API 前先渲染禁用态并给出说明）。

- [ ] **Step 1: 写失败测试**（状态徽章语义、领取方字段、释放按钮禁用态文案）。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 迁移**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(console): migrate task/batch/attribution/runner pages"`

---

### Task 5: 统计页迁移（usage 并入控制台体系）

**Files:**
- Modify: `src/usage/web.ts`（外壳＋组件迁移；存储徽章用 Plan A Task 7 口径：PostgreSQL／文件台账／会话内存）
- Modify: `src/usage-command.ts`（启动日志文案同步；`/`→`/usage` 重定向保留）
- Test: `test/usage-web.test.js`、`test/usage-command.test.js`、`test/usage-server.test.js`（断言更新）

**Interfaces:**
- Consumes: shell（Task 1）＋组件层（Task 2）；`/usage.json` 契约为**不可变**接口。
- 与 Plan A 依赖：文案口径需 Plan A Task 7 的标签函数落地；若并行未合入，先在本任务内实现同口径映射并在合并时删重。

- [ ] **Step 1: 写失败测试**（shell 标记、存储徽章三态、JSON 契约快照不变）。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 迁移**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(console): migrate usage dashboard into console shell"`

---

### Task 6: 下发向导页＋预览回显

**Files:**
- Create: `src/console/dispatch.ts`（向导页渲染＋预览计算）
- Modify: `src/panel/web.ts`（`?section=dispatch` 路由到向导页；总览/项目页下发入口）
- Test: `test/console-dispatch.test.js`（新建）

**Interfaces:**
- Produces:
```ts
export interface DispatchPreview {
  source: { mode: "case-set" | "keyword" | "excel"; label: string; caseCount: number };
  refs: string[];                 // 份 id 或功能关键词
  platforms: ("ios" | "android")[];
  devices: string[];              // 显式设备或空（＝runner 自动）
  runnerCandidates: { id: string; host: string; online: boolean }[];
  warnings: string[];             // 例："无在线 runner，将只能手动指定设备"
}
export function computeDispatchPreview(deps: PanelWebDeps, rootPath: string, params: URLSearchParams): Promise<DispatchPreview>;
export function renderDispatchPage(deps: PanelWebDeps, rootPath: string, params: URLSearchParams): Promise<string>;
```
- 四段式单页（渐进增强）：来源（选份／关键词／Excel 路径，互斥）→ 参数（端、设备、基线 latest/none）→ 预览回显（份×条数×来源×设备×runner 候选）→ 确认（本任务渲染为禁用态"提交按钮"，Task 7 接线动作 API）。
- 预览纯读（不写库、不跑命令）；份/关键词来源用 `listCaseSets`；runner 候选用 `listRunners`。

- [ ] **Step 1: 写失败测试**：三种来源各一预览（条数/警告/回显）；无 runner 时含警告；向导四段均渲染；禁用提交按钮存在。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(console): dispatch wizard with preview (read-only)"`

---

### Task 7: 动作 API 扩展＋上传＋确认分级＋审计（依赖 Plan A Task 1）

**Files:**
- Create: `src/panel/multipart.ts`（最小 multipart 单文件解析器；`parseMultipartFile(body: Buffer, boundary: string, opts: {maxBytes: number}): {filename: string; content: Buffer}`）
- Modify: `src/panel/actions.ts`（新增端点）
- Modify: `src/panel-command.ts`（`AOS_PANEL_ACTIONS=1` 且 loopback 时把 `/panel/api/*` POST 交给 `handlePanelActionRequest`；非 loopback 一律 404）
- Modify: `src/http-server.ts`（动作请求体支持 multipart：仅 `/panel/api/import`；其余仍 JSON）
- Modify: `src/console/dispatch.ts`（提交按钮启用并接 `/panel/api/tasks`）
- Test: `test/panel-actions.test.js`、`test/panel-command.test.js`（扩展）、`test/panel-multipart.test.js`（新建）

**Interfaces:**
- Consumes: `recordAudit`＋`listAudit`（Plan A Task 1）；既有 `createTask/saveVerdicts/createIssues`。
- 新增端点（全部 POST、JSON，`/panel/api/`前缀；成功与失败均 `recordAudit(domain:"panel")`）：
  - `/panel/api/import`：`{project, path}` 或 multipart `file`（≤20MB、仅 `.xlsx`）→ 复用 `src/workflow/excel-import.ts` 导入 → 返回 `{ok, caseSetId, caseCount}`。
  - `/panel/api/tasks/release`：`{project, taskId}` → `releaseRegressionTask`（存在则 `updateRegressionTask` 状态回 `pending`）。
  - `/panel/api/schedules`：`{project, action:"create"|"enable"|"disable"|"delete", ...}` → `createSchedule/updateSchedule/deleteSchedule`。
  - `/panel/api/quarantine`：`{project, action:"add"|"remove", caseId, owner?, until?}` → 写 `<项目>/.artemis/design/quarantine.json`（复用 `suite` quarantine 读取路径；若不兼容，抽公共 reader/writer）。
  - `/panel/api/export`：`{project, what, format}` → `exportProjectData`（Plan A Task 6）→ `{ok, filename, content?}`（列表下载；不落临时文件）。
- 确认分级：表单带 `data-confirm`（常规）或确认短语（danger：release/quarantine remove/schedule delete）；建单沿用 dryRun 预览→确认两步。

- [ ] **Step 1: 写失败测试**：multipart 解析（正常/超限/坏边界）；每个端点成功路径＋参数校验失败＋审计事件落账（`listAudit` 断言）；独立进程 loopback＋`AOS_PANEL_ACTIONS=1` 放行、缺 env 或非 loopback 404。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(console): action APIs (import/release/schedules/quarantine/export) + audit wiring"`

---

### Task 8: 用例库／档案与产物／审计／运维与数据页（依赖 Plan A Task 5/6）

**Files:**
- Create: `src/console/pages-library.ts`、`src/console/pages-ops.ts`（档案/审计/运维渲染）
- Modify: `src/panel-command.ts`、`src/http-server.ts`（新增 `?section=library|archive|audit|ops` 路由；GET 下载 `/panel/api/export`）
- Test: `test/console-pages.test.js`（新建）

**Interfaces:**
- Consumes: `listArtifacts`（Plan A Task 5）、`listAudit`（Plan A Task 1）、`exportProjectData`（Plan A Task 6）、`listCaseSets`。
- 页面：
  - 用例库：份列表（来源/功能/条数/时间/truncated 标注）＋quarantine 区（active 名单）＋「按份下发」（链到 dispatch 预填）。
  - 档案与产物：`kind/since/q` 筛选表单＋结果表（下载链接指向文件产物服务器的既有 `/artifact*`）。
  - 审计：`domain/result/since` 筛选＋事件表（每条 refs 显示关联 id）＋分页。
  - 运维与数据：存储状态（kind/位置/降级原因如实）、保留期摘要（复用 `src/tasks/retention.ts` 只读摘要）、导出表单（what×format 下载）。
- 活跃态自动刷新：仅当存在 running/claimed 任务时 shell 传 `autoRefreshSeconds: 15`。

- [ ] **Step 1: 写失败测试**（四页渲染＋筛选参数生效＋下载 GET 的 Content-Disposition/CType）。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现**。**Step 4: 通过＋全量**。**Step 5: Commit**：`git commit -m "feat(console): library/archive/audit/ops pages"`

---

### Task 9: 响应式＋可访问性＋impeccable 收尾＋文档

**Files:**
- Modify: `src/console/tokens.ts`（媒体查询：≥1280 三栏、768–1280 折叠、<768 抽屉/表格转卡片；`:focus-visible` 样式；`prefers-reduced-motion`）
- Create: `scripts/console-fixtures.mjs`（用演示数据渲染 `/panel`、`/usage` 各页 HTML 落 `.scratch/console-fixtures/*.html`，供 detect）
- Modify: `README.md`（控制台章节）、`DESIGN.md`（§13.126 记录）、`web-console/DESIGN.md`（最终组件清单）
- Test: `test/console-a11y.test.js`（结构断言：每页唯一 h1、`<h1>` 递增层级抽样、表格 `th scope`、图片 alt、对比度按 token 抽查（黄底黑字/白底灰字均 ≥4.5:1 按静态计算））

**Interfaces:**
- Consumes: 全部页面。detect 运行按 `.agents/skills/impeccable` 的命令表执行一次（引擎不可用则记录豁免与原因，不阻塞）。

- [ ] **Step 1: 写失败测试**（a11y 结构断言）。
- [ ] **Step 2: 跑测试确认失败**。**Step 3: 实现适配＋修正**。**Step 4: 生成 fixtures → 跑 impeccable detect（一次）→ 修 findings（记录未修项与理由）**。
- [ ] **Step 5: 全量 `npm run build && npm test && npm run lint` 全绿；更新文档；Commit**：`git commit -m "feat(console): responsive + a11y pass; impeccable detect cleanup; docs"`

---

**并行依赖（与 Plan A）**：Task 5 依赖 Plan A Task 7 文案口径（可先本地同口径后去重）；Task 7/8 依赖 Plan A Task 1（审计）与 Task 5/6（索引/导出）。Task 1–4、6 与 Plan A 完全独立可并行。
