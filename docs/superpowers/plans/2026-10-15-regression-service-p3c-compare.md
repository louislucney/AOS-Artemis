# 回归服务 P3c 实施计划（跨项目对比视图）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上统计维度的「项目」层：面板新增只读**多项目对比视图**（`?view=compare` ＋ `/panel.json?view=compare`）——按台账（中央 PG）跨项目呈现质量水位、趋势、失败域与待办，帮负责人找「哪个项目需要关注」。

**Architecture:** 数据源以台账为主（磁盘不可达的项目机同样可比）；窗口＝**份血统运行**最近 20 批（读取 limit 40 后过滤取前 20）；先做 `listSuiteRuns` 内部批量装载（消除逐 run N+1）使每项目 ≤3 次 DB 往返；聚合在 `src/panel/compare.ts`（复用 `collectVerdictExits` 做去重口径），路由/JSON 挂在既有 `/panel` handler，渲染服务端 HTML（内联 SVG 迷你图，零依赖）。

**Spec:** `docs/superpowers/specs/2026-10-15-regression-service-p3c-design.md`（决策 D1–D11 与口径的权威来源；总体设计见 `2026-10-14-regression-service-design.md` §5.4/§5.8/§7）

## Global Constraints

- 测试口径（仓库硬性）：pg-mem/内存 store、假目录、不触网；改动先 `npm run build`；单文件 `npm run test:file -- test/xxx.test.js`；测试跑 `dist/`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- 面板只读语义：无子进程/无网络/无写盘；全部输出 `escapeHtml`。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN.md（新增 §13.112）＋ README ＋ AGENTS.md。
- **拍板（设计 D1–D11 摘要）**：D1 维度＝项目级（功能级匹配不做）；D2 数据源＝台账；D3 载体＝面板视图＋JSON（不新增 CLI）；D4/D9 窗口＝份血统最近 20 批、两列待办语义不同（`pendingVerdicts`＝发生次数；`unissuedAppDefects`＝（份,用例）最新裁决去重且未建单）；D5 排序＝固定「关注优先」；D6 迷你图＝内联 SVG；D7 行级降级不整页失败；D8 最近批次/排序取台账（L1 列与灯不动）；D10 `listSuiteRuns` 内部批量装载（输出不变）；D11 flaky＝Σ run.flaky。

## Review Focus

1. **窗口与口径**：`limit 40 → featureKey!==null → 前 20` 的稀释场景；趋势时间升序 ≤10；失败域 top3（count 降序→域名升序）；flaky＝Σ`run.flaky`（对照登记口径）；两列待办各自正确（发生次数 vs 去重）。
2. **磁盘不可达项目**：只要有台账数据，最近批次与排序照常成立（D8）；不因磁盘不可读而空行/错序。
3. **行级降级与截断**：单项目查询抛错 → 该行 `error` 标注、其余行照常；项目数 >50 截断并标注。
4. **只读与转义/数值**：无网络/写盘；HTML 与 SVG 输出转义与数值钳制；JSON 形状稳定。
5. **共享方法改造回归**：`listSuiteRuns` 批量装载后全部既有调用方输出逐字不变（`db-suite-runs`/`panel-stats`/`panel-overview`/`suite-*` 等测试为锁）。

---

### Task 1: `listSuiteRuns` 批量装载 suite_run_cases（D10）

**Files:**
- Modify: `src/db/postgres.ts`
- Test: `test/db-suite-runs.test.js`（追加装配锁）

**Interfaces:**
- 对外**行为不变**：`listSuiteRuns(rootPath, query): Promise<SuiteRunRecord[]>`——runs 顺序（新→旧、limit 语义）与逐 run `cases`（按 `case_id ASC`，与现状 `postgres.ts:879` 的 ORDER BY 一致）逐字不变；仅内部由「逐 run 查 cases」改为**单查询批量装载**（收集 runIds → 动态占位 `IN (...)` 一次读取 → 按 run_id 分组装配）。
- 无新方法、无签名变化。

- [ ] **Step 1: 写装配锁定测试**（`test/db-suite-runs.test.js`；pg-mem + memory 双跑沿用该文件既有 fixture 模式）
  - `多 run 装配：3 个 run（cases 数不等、含 0 case 的 run）→ 每个 run 的 cases 完整、逐 run 内按 case_id 升序、runs 顺序与 limit 语义不变`。
  - （若既有测试已覆盖单 run 场景，本测试锁定多 run×批读路径。）
- [ ] **Step 2: 跑测试**（此刻应绿——行为锁；重构前后都必须绿）：`npm run test:file -- test/db-suite-runs.test.js`。
- [ ] **Step 3: 实现批量装载**（postgres `listSuiteRuns`：既有 runs 查询 → 收集 id → 单条 `SELECT ... FROM suite_run_cases WHERE run_id IN ($2,...,$n) ORDER BY run_id, case_id`（动态占位；pg-mem 兼容）→ 按 run_id 分组装配；`getSuiteRun` 不动）。
- [ ] **Step 4: 跑测试确认通过** + 消费方锁：`npm run test:file -- test/panel-stats.test.js` 与 `npm run test:file -- test/db-suite-runs.test.js`；`npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "perf(db): batch-load suite run cases in listSuiteRuns"`

### Task 2: 对比聚合与路由/JSON（`src/panel/compare.ts`）

**Files:**
- Create: `src/panel/compare.ts`
- Modify: `src/panel/web.ts`（`PanelView` 增 `kind:"compare"`；`buildView` 路由；`toJsonView` 分支；`renderPanelHtml` 增**最小**渲染分支——表格骨架，T3 增强）
- Test: `test/panel-compare.test.js`（新；聚合＋路由/JSON）

**Interfaces:**
- Consumes：Task 1（批量装载）、`buildPanelOverview`（项目集合与灯）、`collectVerdictExits`（`src/tasks/verdict-exits.ts`）、`listRegressionTasks`/`listRunners`/`listSchedules`。
- Produces：
  ```ts
  export interface PanelCompareProject {
    name: string; rootPath: string; lamp: PanelLamp; lampReasons: string[];
    latestBatch: { at: string | null; gate: "pass" | "fail" | null; passRate: number | null } | null;
    trend: Array<{ at: string | null; passRate: number | null }>;   // 时间升序 ≤10
    flaky: number;
    domains: Array<{ domain: string; count: number }>;             // top3
    pendingVerdicts: number; unissuedAppDefects: number;
    taskBacklog: { pending: number; claimed: number; running: number; failed: number };
    runners: { online: number; devices: number };
    schedules: { enabled: number; lastFiredAt: string | null };
    error: string | null;                                           // 行级降级
  }
  export interface PanelCompareView {
    ok: true; generatedAt: string;
    store: { kind: "postgres" | "memory"; degraded: boolean };
    window: { runs: 20 };
    projects: PanelCompareProject[];
    truncated: boolean;
    warnings: string[];
  }
  export async function buildPanelCompare(deps: PanelDeps): Promise<PanelCompareView>;
  ```
- 语义（D4/D8/D9/D11 逐条落地）：
  - 行集合＝`(await buildPanelOverview(deps)).projects`（灯/lampReasons 复用）；**>50 截断**→`truncated:true`＋warning。
  - 每行 try/catch（行级降级，`error` 行其余字段给空默认）：
    - `runs = await store.listSuiteRuns(rootPath, { limit: 40 })`；`lineage = runs.filter(r => r.featureKey !== null).slice(0, 20)`。
    - `latestBatch`＝`lineage[0]`（新→旧）：`at = finishedAt ?? startedAt`；`gate`＝`gateResult === "pass" ? "pass" : gateResult === "fail" ? "fail" : null`（实现时核对登记值，其余归 null）；`passRate = total > 0 ? passed / total : null`。
    - `trend`＝`lineage.slice(0, 10)` 映射后**反转为时间升序**。
    - `flaky`＝Σ `run.flaky`；`domains`＝合并 `run.failureDomains` 计数 → 按 count 降序、domain 升序 → top3。
    - `pendingVerdicts`＝Σ over `lineage` cases：`status !== "passed" && verdict === null`。
    - `unissuedAppDefects`＝`collectVerdictExits(lineage).appDefects.filter(c => c.jiraKey === null).length`（去重口径自动继承）。
    - `tasks = await store.listRegressionTasks(rootPath, 200)` → 计数 `pending/claimed/running/failed`（其余状态不计）。
    - `runners = await store.listRunners(rootPath)`：在线判定复用既有 runner TTL helper（实现时定位既有函数，如 `runnerTtlFrom(env)`＋`now`；TTL 默认 90s）；`devices`＝在线 runner 的设备数之和。
    - `schedules = await store.listSchedules(rootPath)`：`enabled` 计数；`lastFiredAt`＝非空最大值。
  - **排序**：`rank = latestBatch === null ? 0 : latestBatch.gate === "fail" ? 1 : 2`；rank 升序 → `passRate` 升序（null 排在数字之后）→ `name` 升序（稳定）。
  - `window = { runs: 20 }`；`warnings` 透传 overview warnings。
- 路由（`web.ts`）：`buildView` 中 `projectKey === null` 分支：`view=compare` → `{ kind: "compare", view: await buildPanelCompare(panelDeps) }`；否则维持 overview。`toJsonView`：`{ ...view.view, view: "compare" }`。`renderPanelHtml`：`kind === "compare"` → 最小表格（项目/最近批次/趋势文本/质量/待办/运行；escape 全字段）。
- [ ] **Step 1: 写失败测试**（`test/panel-compare.test.js`；内存 store + 假项目/workspace 沿用 `panel-overview.test.js` harness）
  - `聚合：窗口（limit 40→lineage→20 稀释：40 条中 25 条 adhoc → 窗口只剩 15 条 lineage，如实短窗）；趋势升序 ≤10；域 top3 排序；flaky=Σ run.flaky；pendingVerdicts=发生次数；unissuedAppDefects=最新裁决去重且 jiraKey null；任务计数按状态；runner 在线 TTL 与设备数；schedules enabled/lastFiredAt`。
  - `排序：无批次→门禁 fail→通过率升（null 后置）→名称；含磁盘不可达但有台账的项目`。
  - `行级降级：store 方法抛错 → 该行 error、其余行正常`；`>50 截断标注`；`空项目集 → 空数组`。
  - `路由/JSON：GET /panel.json?view=compare → { ok, view:"compare", window:{runs:20}, projects:[…] }；GET /panel?view=compare 200 HTML 含表格骨架；带 project 参数 + view=compare 不命中 compare（回退项目页路径）`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/panel-compare.test.js`。
- [ ] **Step 3: 实现**（按「语义」；`compare.ts` 新模块；`web.ts` 接线与最小渲染）。
- [ ] **Step 4: 跑测试确认通过** + `npm run test:file -- test/panel-web.test.js`（既有渲染不回归）＋ `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): cross-project compare aggregation + route/JSON"`

### Task 3: 对比视图渲染（迷你图、列组、互链）

**Files:**
- Modify: `src/panel/web.ts`
- Test: `test/panel-web.test.js`（追加）

**Interfaces:**
- Consumes：Task 2 的 `PanelCompareView` 形状。
- 渲染增强（替换 T2 最小表格）：
  - 页头「多项目对比」＋ 口径说明行（窗口＝份血统最近 20 批；「精确待办以归因队列为准」；数据源＝台账）。
  - 列组：项目（名链接＋灯）｜最近批次（时间·门禁·通过率）｜趋势（**内联 SVG 迷你图**：≤10 点折线/柱，`trendPassRateSvg(points)` 纯字符串函数；null 点断开；数值钳制 0–100）｜质量（flaky、失败域 top3 chips）｜待办（未裁决失败·条 / 未建单缺陷·项 / 任务积压 p+c+r / failed）｜运行（runner 在线/设备、定时回归 enabled/最近触发）。
  - 降级行：`error` 非空 → 该行可见标注（`读取失败：…`），其余列 `—`；空态（无项目）提示。
  - L1 页头加「多项目对比」链接；对比页回链 L1（项目名链接项目页）。
  - 全部字段 `escapeHtml`；SVG 仅由数值生成（钳制后拼接）。
- [ ] **Step 1: 写失败测试**（`test/panel-web.test.js` 追加）
  - `表格与列组标记（含 SVG 迷你图元素、域 chips）；口径说明行；降级行；空态；L1↔compare 互链；escape（项目名/域注入）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): compare view rendering (sparkline, groups, links)"`

### Task 4: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`（§13.112）、`README.md`、`AGENTS.md`

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.112：P3c 实施记录（对比视图/指标集/窗口与两列待办口径/台账优先与行级降级/D10 批量装载/L1 互链/JSON 面；`panel --web` 自动可用）。
  - README：面板章节补「多项目对比」（入口、口径、与 L1/统计视图关系）。
  - AGENTS.md：HTTP 面板行补 `?view=compare`（或面板相关行，按文件实际结构放置）。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P3c (cross-project compare)"`

---

## 范围外（另立计划）

- 功能级跨项目匹配（同名功能矩阵，需先定义匹配规则与误报口径）；跨项目动作（批量建任务/建单）；CSV 导出/阈值告警/快照对比；鉴权升级（P3d）；P3b 缓办 minors（裁决表单 `split('|')` 等，按需顺手）。
