# Web 控制台（CSDC 原地升级＋下发闭环）Implementation Plan — v2（评审修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/panel` 与 `/usage` 原地升级为 CSDC 风格的可操作控制台——能看（总览/项目/任务/档案/审计）、能做（下发/导入/计划/裁决建单/资产/导出六类动作，全部带确认与审计）。

**Architecture:** 新增 `src/console/`（tokens／shell／components，服务端渲染 HTML＋单一 CSS 变量源）；页面按现有查询参数契约原地迁移；动作层沿用 `/panel/api/*` 扩展端点（**v2：全部写端点加同源校验**），HTTP 模式行为不变，独立进程仅 `AOS_PANEL_ACTIONS=1` 且 loopback＋同源头时开放同一动作处理器；写操作一律接线 Plan A `recordAudit`。

**Tech Stack:** TypeScript ESM、服务端渲染 HTML/CSS（无前端构建链）、`node --test`、`node:http`、Node 内置 `Response.formData()`（multipart 解析，失败回退最小手写解析）。

**Spec:** `docs/superpowers/specs/2026-10-18-web-console-shape.md`＋`PRODUCT.md`；`web-console/DESIGN.md`（Task 1 产出）。

## Global Constraints

- 完工标准：`npm run build && npm test && npm run lint` 全绿；`DESIGN.md`＋`README.md` 同步；测试不依赖真实 PG/设备/外网。
- **JSON 契约不动**：`/panel.json`、`/usage.json` 字段与参数保持兼容；旧链接不 404。
- CSDC token 原样（`#FFE600`/`#34C759`/`#FF3B30`/`#FF9500`/`#0066CC`、`#1D1D1F/#6E6E73/#86868B`、`#F5F5F7/#FFFFFF/#EFEFF2`、`#D2D2D7`、圆角 6/10/14/18/980、`blur(20px)`、SF Pro/PingFang）；**v2 对比度口径**：正文级次要文字用 `#6E6E73`（对白底 ≈5.1:1 达标）；`#86868B`（≈3.6:1）仅装饰/大字号（≥24px·粗体或 ≥18.7px·粗体）用途——Task 9 断言按此分类写；先只亮色（深色列后续，token 源结构预留）。
- **v2 动作安全**：写端点要求 `Sec-Fetch-Site: same-origin`（或自定义头 `X-AOS-Console: 1`，两者任一；跨站表单/预检被挡）＋独立进程 Host 白名单（`127.0.0.1`/`localhost`）；`AOS_PANEL_ACTIONS=0` 关；HTTP 模式行为不变；每个写操作（含失败）落审计。
- **v2 刷新纪律**：整页 `meta refresh` 仅用于**无表单**列表页（任务/批次/运行机/审计）且存在活跃任务时；含未提交表单的页（下发向导/导入/运维表单）**永不**自动刷新。
- **v2 上传加固**：读体前 `Content-Length` 预检拒绝超限；读体上限 20MB；导入动作单飞（同进程并发 1）；临时文件随机名＋必清理；multipart 解析用内置 `Response.formData()`（确证不可用再回退手写）。
- 用户可见文案中文；数据真实（空态就空态）；HTML 用户数据一律转义（组件层兜底，见 Task 2）。
- 日志走 `log()`（stderr）。

## Review Focus

1. **XSS/转义**：数据叶子字段走组件自动转义通道；HTML 通道仅组件构建行（Task 2/3/4/8）。
2. **CSRF/动作安全**：同源校验＋Host 白名单＋确认分级＋全量审计（Task 7）。
3. **契约兼容**：`/panel.json`/`/usage.json` 与旧查询参数不变（Task 3–5 每迁移一次回归）。
4. **上传边界**：Content-Length 预检、单飞、临时文件清理、filename 不回显不落盘（Task 7）。
5. **刷新 vs 表单**：含表单页面零自动刷新；轮询仅活跃列表页（Task 6/8）。
6. **对比度**：`#86868B` 不出现在正文级文字；Task 9 断言按用途分类（Task 9）。
7. **降级如实**：无"内存降级"字样；存储三态标签与 Plan A Task 7 同口径（Task 5）。

---

### Task 1: CSDC token 源＋控制台外壳＋视觉体系文档

**Files:**
- Create: `src/console/tokens.ts`（`CSDC_TOKENS_CSS`；含对比度用途注释：secondary=`#6E6E73`、muted=`#86868B` 仅装饰/大字号）
- Create: `src/console/shell.ts`（`renderConsoleShell`；`autoRefreshSeconds` 仅由无表单页传入）
- Create: `web-console/DESIGN.md`（token 表、用途规则、组件类名、状态色、间距节奏）
- Modify: `src/panel/web.ts`（总览页套壳，内容区暂保持）
- Test: `test/console-shell.test.js`、`test/panel-web.test.js`（更新）

**Interfaces:**
```ts
export type ConsoleNavKey = "overview"|"project"|"tasks"|"dispatch"|"library"|"archive"|"runners"|"schedules"|"ops"|"audit"|"usage";
export interface ConsoleNavItem { key: ConsoleNavKey; label: string; href: string; badge?: string }
export interface ConsoleShellInput { title: string; active: ConsoleNavKey; body: string; nav?: ConsoleNavItem[]; meta?: string; headExtra?: string; autoRefreshSeconds?: number }
export function renderConsoleShell(input: ConsoleShellInput): string;
```

- [ ] **Step 1: 写失败测试**（shell 标记/active/title 转义/token 关键值）。**Step 2: 失败。** **Step 3: 实现＋总览套壳。** **Step 4: 通过＋全量。** **Step 5: `web-console/DESIGN.md`＋Commit**：`git commit -m "feat(console): CSDC tokens + shell + visual system doc"`

---

### Task 2: 组件层（v2：转义双通道）

**Files:** Create `src/console/components.ts`、`test/console-components.test.js`；Modify `src/panel/web.ts`（提升导出 `escapeHtml`）

**Interfaces:**
```ts
export function cCard(input: { title?: string; subtitle?: string; tone?: "default"|"accent"; actions?: string; body: string }): string;
export function cBadge(input: { label: string; tone: "neutral"|"accent"|"success"|"error"|"warning" }): string;
export function cBanner(input: { tone: "info"|"accent"|"warn"; title: string; body?: string; actions?: string }): string;
// v2：rowsText = 自动转义通道（数据默认走这里）；rows = 已构建 HTML（仅限组件行，如链接/按钮），文档注释写明契约
export function cTable(input: { columns: string[]; rows?: string[][]; rowsText?: string[][]; empty?: string; caption?: string }): string;
export function cStat(input: { label: string; value: string; hint?: string }): string;
export function cEmpty(input: { title: string; body: string; action?: string }): string;
export function cConfirmForm(input: { action: string; project: string; fields: Record<string,string>; label: string; confirm: string; danger?: boolean }): string;
```

- [ ] **Step 1: 写失败测试**（结构/语义/双通道转义：`rowsText` 输入 `<b>` 输出 `&lt;b&gt;`；`rows` 原样）。**Step 2: 失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(console): CSDC components with escape-by-default tables"`

---

### Task 3: 总览／项目／对比页迁移

**Files:** Modify `src/panel/web.ts`、`src/panel/overview.ts`、`src/panel/compare.ts`；Test `test/panel-web.test.js`、`test/panel-overview.test.js`、`test/panel-compare.test.js`

**Interfaces:** Consumes 组件层；项目页第一屏＝一屏三问（健康/在跑什么/下一步＋下发入口）。

- [ ] **Step 1: 写失败测试**（三问区块/下发入口/compare 表；数据叶子走 `rowsText` 的转义断言）。**Step 2: 失败。** **Step 3: 迁移。** **Step 4: 通过＋`/panel.json` 契约回归。** **Step 5: Commit**：`git commit -m "feat(console): migrate overview/project/compare pages"`

---

### Task 4: 任务／批次／归因／运行机页迁移

**Files:** Modify `src/panel/web.ts`、`src/panel/deep.ts`、`src/panel/stats.ts`；Test 三件更新（含释放按钮禁用态文案）。

- [ ] **Step 1–5**：同 Task 3 节奏；Commit：`git commit -m "feat(console): migrate task/batch/attribution/runner pages"`

---

### Task 5: 统计页迁移（usage 并入控制台体系）

**Files:** Modify `src/usage/web.ts`、`src/usage-command.ts`；Test `test/usage-web.test.js`、`test/usage-command.test.js`、`test/usage-server.test.js`

**Interfaces:** Consumes shell/组件；`/usage.json` 契约不可变；**v2 导航口径**：usage 独立进程显示 `DEFAULT_CONSOLE_NAV` 的**显式子集**（`overview? no／usage active／其余不显示跨进程链接`）——子集定义为常量 `USAGE_STANDALONE_NAV` 并写进 `web-console/DESIGN.md`，避免两套顶栏观感；存储徽章三态（PostgreSQL/文件台账/会话内存）。

- [ ] **Step 1–4**：同节奏（含 JSON 契约断言）。**Step 5: Commit**：`git commit -m "feat(console): migrate usage dashboard into console shell"`

---

### Task 6: 下发向导页＋预览回显

**Files:** Create `src/console/dispatch.ts`、`test/console-dispatch.test.js`；Modify `src/panel/web.ts`（`?section=dispatch`）

**Interfaces:**
```ts
export interface DispatchPreview { source: { mode: "case-set"|"keyword"|"excel"; label: string; caseCount: number }; refs: string[]; platforms: ("ios"|"android")[]; devices: string[]; runnerCandidates: { id: string; host: string; online: boolean }[]; warnings: string[] }
export function computeDispatchPreview(deps: PanelWebDeps, rootPath: string, params: URLSearchParams): Promise<DispatchPreview>;
export function renderDispatchPage(deps: PanelWebDeps, rootPath: string, params: URLSearchParams): Promise<string>;
```
- 四段式单页（来源→参数→预览→确认）；预览纯读；**v2：本页永不自动刷新**；提交按钮 Task 7 接线（先前禁用态）。

- [ ] **Step 1: 写失败测试**（三来源预览/无 runner 警告/四段渲染/无 meta refresh 断言）。**Step 2: 失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(console): dispatch wizard with preview (read-only)"`

---

### Task 7: 动作 API 扩展＋上传加固＋同源校验＋审计（依赖 Plan A Task 1）

**Files:**
- Create: `src/panel/http-guard.ts`（`assertSameOrigin(request, {standalone}): boolean`——`Sec-Fetch-Site` 允许 `same-origin`/`none` 或头 `X-AOS-Console: 1`；standalone 时 Host 必须 `127.0.0.1|localhost`（含端口））
- Create: `src/panel/upload.ts`（Content-Length 预检＋读体上限＋`Response.formData()` 解析；确证不可用回退最小手写；随机临时名＋必清理）
- Modify: `src/panel/actions.ts`（新端点＋守卫＋审计）、`src/panel-command.ts`（standalone 动作接线：`AOS_PANEL_ACTIONS=1` 且 loopback）、`src/http-server.ts`（multipart 路由到 `/panel/api/import`）、`src/console/dispatch.ts`（提交启用）
- Test: `test/panel-actions.test.js`（扩展）、`test/panel-guard.test.js`、`test/panel-upload.test.js`、`test/panel-command.test.js`（扩展）

**Interfaces:**
- 新端点（全部 POST `/panel/api/*`；成功/失败均 `recordAudit(domain:"panel")`）：
  - `import`：`{project, path}` 或 multipart `file`（≤20MB、仅 `.xlsx`、单飞）→ 复用 `src/workflow/excel-import.ts` → `{ok, caseSetId, caseCount}`；
  - `tasks/release`：`{project, taskId}`；`schedules`：`{project, action, ...}`；`quarantine`：`{project, action, caseId, owner?, until?}`；`export`：`{project, what, format}`（GET 下载变体）。
- 同源校验失败 → 403（JSON `{error}`）；standalone 无 env → 404（保持现行为）。

- [ ] **Step 1: 写失败测试**：守卫矩阵（跨站 `Sec-Fetch-Site: cross-site` 403；无头无标记 403；standalone 非 loopback Host 403）；上传（超限 413、非 xlsx 400、坏 multipart 400、临时文件清理断言）；每端点成功＋校验失败＋审计落账。**Step 2: 失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(console): guarded action APIs (import/release/schedules/quarantine/export)"`

---

### Task 8: 用例库／档案与产物／审计／运维与数据页（依赖 Plan A Task 1/5/6）

**Files:** Create `src/console/pages-library.ts`、`src/console/pages-ops.ts`、`test/console-pages.test.js`；Modify `src/panel-command.ts`、`src/http-server.ts`（`?section=library|archive|audit|ops`＋GET 导出下载）

**Interfaces:** Consumes `listCaseSets`、`listArtifacts`、`listAudit`、`exportProjectData`；运维页展示存储三态＋**审计保留摘要（90 天/5 万）**；活跃自动刷新仅任务/批次/运行机/审计四页（无表单页），下发/导入/运维表单页不刷新。

- [ ] **Step 1: 写失败测试**（四页渲染/筛选/下载头/刷新矩阵断言：表单页无 `http-equiv="refresh"`）。**Step 2: 失败。** **Step 3: 实现。** **Step 4: 通过＋全量。** **Step 5: Commit**：`git commit -m "feat(console): library/archive/audit/ops pages"`

---

### Task 9: 响应式＋可访问性＋impeccable 收尾＋文档

**Files:** Modify `src/console/tokens.ts`（媒体查询/`:focus-visible`/`prefers-reduced-motion`；深色预留注释）；Create `scripts/console-fixtures.mjs`；Modify `README.md`、`DESIGN.md`（§13.126）、`web-console/DESIGN.md`；Test `test/console-a11y.test.js`

**Interfaces:** a11y 断言（每页唯一 h1/层级抽样/`th scope`/alt/**对比度按用途**：正文级色 `#1D1D1F/#6E6E73/#0066CC` 对白底 ≥4.5:1；`#86868B` 仅允许出现在大字号/装饰类名上——静态断言扫描 fixture 输出的"正文类名＋#86868B"组合不存在）。

- [ ] **Step 1: 写失败测试**（结构＋对比度用途断言）。**Step 2: 失败。** **Step 3: 实现适配。** **Step 4: fixtures → impeccable detect（一次）→ 修 findings 或记录豁免。** **Step 5: 全绿＋文档＋Commit**：`git commit -m "feat(console): responsive + a11y pass; impeccable detect cleanup"`

---

**并行依赖（与 Plan A）**：Task 7/8 依赖 Plan A Task 1（审计）与 Task 5/6（索引/导出）——**前置门禁**：这些 Plan A 任务合入前，B 的 Task 7/8 不开工；Task 5 先本地同口径、合并时删重。执行记录在 `.superpowers/sdd/2026-10-18-web-console-csdc/progress.md`。
