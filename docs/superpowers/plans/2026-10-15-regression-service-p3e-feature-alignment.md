# 回归服务 P3e 实施计划（跨项目功能对齐）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P3c 项目级对比之上补「功能对齐」：对同设计源（figma fileKey / 路径相对化 / pen 路径）且归一化同名的功能，跨项目并列展示窗口内通过率/批次/flaky/未裁决——只并列、不合并。

**Architecture:** 纯函数模块 `src/panel/feature-alignment.ts`（归一化＋跨项目分组，输入为各项目已收集的窗口数据）；`compare.ts` 在既有 per-project 循环中增一次 `listCaseSets(rootPath)`（缺省全量）并调用对齐；`PanelCompareView` 加性字段 `featureAlignment`；`web.ts` 对比页增第二区块与口径说明行。

**Spec:** `docs/superpowers/specs/2026-10-15-regression-service-p3e-feature-alignment-design.md`（D1–D10 与复核记录 §9）

## Global Constraints

- 测试口径：pg-mem/内存 store、假目录、不触网；测试跑 `dist/`；`npm run build` 后跑测试；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- 只读面板语义：无子进程/无网络/无写盘；全部输出 `escapeHtml`；视图入 `PanelWebCache`。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；同步 DESIGN（新增 §13.114）＋ README（对比视图章节）＋ AGENTS.md（面板行，如适用）。
- **拍板（D1–D10 摘要）**：匹配＝同设计源身份＋归一化名，组内 ≥2 项目才展示；源归一化含「绝对/相对路径→相对项目根 posix+lower」（跨形式 url vs 路径不匹配为声明边界）；名归一化保守（NFC/空白/小写）；数据＝对比窗口（份血统最近 20）＋每项目 `listCaseSets` **全量**；聚合单位 (caseSetId, featureKey) 后按（项目,源,名）合并；名称权威＝case set 冻结名；`unmatched`＝仅单项目出现的组键数；只并列不合并统计。

## Review Focus

1. **源归一化边界**：figma 装饰剥离；绝对路径→相对根（跨项目同布局相等）；越界/不可相对化/无分隔符/`figma:`/`pen:` 前缀分支；**跨形式不匹配**（url vs 路径）边界锁定；大小写/posix 化。
2. **映射与合并**：窗口老份可映射（全量 listCaseSets）；跨份同 key 合并 Σ；名称取 case set 冻结名（非 run.featureName）；无映射运行不进表。
3. **分组与计数**：≥2 项目才展示；同名不同源/同源异名不成组；`unmatched`＝单项目组键数；组排序（项目数→极差（null 不参与）→名）。
4. **降级与回归**：单项目 `listCaseSets` 抛错 → 该项目不参与对齐、项目级区块照常；P3c 既有字段/测试零回归；JSON 加性。
5. **渲染与转义**：区块标记/口径说明行/空态（无组＋未匹配计数）；全字段 escape；每项目 +1 读的总成本与缓存口径。

---

### Task 1: 归一化与对齐聚合（`src/panel/feature-alignment.ts`）

**Files:**
- Create: `src/panel/feature-alignment.ts`
- Test: `test/feature-alignment.test.js`（新）

**Interfaces:**
- Produces：
  ```ts
  /** NFC → trim → 连续空白折叠单空格 → 小写。 */
  export function normalizeFeatureName(name: string): string;
  /** figma:<fileKey>[ (名)] → figma:<fileKey>；**先判 `figma:`/`pen:` 前缀**，其余含路径分隔符/绝对路径 → path.relative(rootPath, src) posix+lower
   * （相对结果以 `..` 开头或仍为绝对路径（跨盘符）→ 原样 lower）；pen:<rel> → posix+lower（含分隔符仍走 pen 归一化）；其他 → lower。 */
  export function normalizeDesignSource(source: string, rootPath: string): string;

  export interface FeatureAlignmentEntry {
    project: string; featureKey: string;
    passRate: number | null; runs: number; flaky: number; pendingVerdicts: number; latestAt: string | null;
  }
  export interface FeatureAlignmentGroup {
    sourceLabel: string; displayName: string; entries: FeatureAlignmentEntry[];
  }
  export interface FeatureAlignmentInput {
    name: string; rootPath: string;
    runs: Array<{                       // 窗口内份血统运行（新→旧 ≤20）
      caseSetId: string | null; featureKey: string | null; featureName: string | null;
      passed: number; total: number; flaky: number; finishedAt: string;
      cases: Array<{ status: string; verdict: string | null }>;
    }>;
    sets: Array<{ id: string; source: string; features: Array<{ key: string; name: string }> }> | null;  // null＝读取失败（该项目不参与）
  }
  export function alignFeatureRuns(projects: FeatureAlignmentInput[]): {
    groups: FeatureAlignmentGroup[]; unmatched: number;
  };
  ```
- 语义（严格按设计 §2）：
  - 收集（每项目）：仅 `caseSetId !== null` **且 `featureKey !== null`**（防御守卫）且能在 `sets` 中命中的运行（无映射 → 跳过；**被跳过的运行不产生组键、不参与 unmatched 计数**）；单位键 `${caseSetId}|${featureKey}`；`name`＝`sets` 中该 featureKey 的冻结名（**set 存在但缺该 featureKey → 回退 `run.featureName`**，仍空 → 跳过该运行）；累计 `passed/total/flaky`、`runs++`、`pendingVerdicts += cases.filter(c => c.status !== "passed" && c.verdict === null).length`、`latestAt = max(finishedAt)`。
  - 合并（项目内）：按 `(normalizeDesignSource(source, rootPath), normalizeFeatureName(name))` 合并 Σ；`featureKey` 取首个。
  - 分组（跨项目）：键同上；**仅保留 groups ≥2 项目**；`unmatched`＝键的项目数 == 1 的数量；`entries` 按项目名升序；`displayName`＝升序后首个 entry 的名称（冻结名）；`sourceLabel`＝组内首个原始 source。
  - 组排序：项目数降序 → 极差（组内非 null passRate 的最大-最小；参与值 <2 → 0）降序 → `displayName` 升序。
- [ ] **Step 1: 写失败测试**（`test/feature-alignment.test.js`）
  - `normalizeDesignSource：figma 装饰剥离；绝对路径→相对根 posix+lower（同布局两项目相等）；`..` 越界与跨盘符绝对结果原样 lower；pen posix/lower（**含分隔符 `pen:sub/a.pen` 仍走 pen 归一化——前缀优先**）；其他 lower；跨形式（figma:KEY vs 路径）不等`。
  - `normalizeFeatureName：NFC/trim/空白折叠/大小写；CJK 不变`。
  - `align：同源同名跨 2 项目成组（entries 升序、指标 Σ、total=0→passRate null）；单项目组 → 不进 groups 且 unmatched=1；同名不同源/同源异名不成组（各计 1）；跨份同 key 合并 Σ；无映射/`featureKey=null`/无冻结名运行不进表且**不抬高 unmatched**；set 缺 featureKey 但 `run.featureName` 非空 → 回退命名并进组；pendingVerdicts 谓词；latestAt 取 max；组排序三级与极差 null 处理`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/feature-alignment.test.js`。
- [ ] **Step 3: 实现**（按「语义」；纯函数、无 IO；归一化用 `node:path` 与既有 regex 提取）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): feature alignment core (normalize + cross-project grouping)"`

### Task 2: compare 接线＋渲染区块

**Files:**
- Modify: `src/panel/compare.ts`、`src/panel/web.ts`
- Test: `test/panel-compare.test.js`、`test/panel-web.test.js`（追加）

**Interfaces:**
- Consumes：Task 1（`alignFeatureRuns`/类型）。
- 语义：
  - `compare.ts`：per-project 循环内**独立 try/catch** 读 `listCaseSets(rootPath)`（**无 limit＝全量**）并**投影**为 `{id, source, features:[{key,name}]}`；失败 → 该项目 `sets:null`（不置行级 error、项目级区块照常）；`buildCompareRow` 增返 `{ runs, sets }`（或循环内并行收集等价形状，**计划此处允许实现自选但须单点收集**），循环后统一调 `alignFeatureRuns`；`PanelCompareView` 增 `featureAlignment: { groups; unmatched }`（加性）。
  - `web.ts`：对比页第二区块「**功能对齐（跨项目）**」：每组＝表头（显示名＋`sourceLabel`＋项目数）＋小表（项目｜通过率｜批次｜flaky｜未裁决｜最近）；口径说明行（匹配规则、窗口、误报口径、「未匹配 N 个（仅单项目出现）」）；空态（无组 → 说明一行＋未匹配计数）；全字段 `escapeHtml`。
- [ ] **Step 1: 写失败测试**
  - `panel-compare：两项目同源同名（路径式 source 相对化后相等）→ groups=1 且 entries=2、指标正确；单项目 → unmatched=1；listCaseSets 抛错 → 该项目不进组、项目级行照常；JSON 含 featureAlignment（加性）`。
  - `panel-web：区块表头/小表/口径说明行/空态与未匹配计数；escape（显示名/源注入）`。
- [ ] **Step 2: 跑测试确认失败**（两个文件分别）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试确认通过** + `npm run test:file -- test/panel-compare.test.js` 与 `test/panel-web.test.js` 全绿 + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): feature alignment section in compare view"`

### Task 3: 文档＋全量回归

**Files:**
- Modify: `DESIGN.md`（§13.114）、`README.md`、`AGENTS.md`（如适用）

- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.114：P3e 实施记录（匹配规则与归一化、路径相对化与跨形式边界、全量 case sets 映射、聚合/合并/未匹配定义、只并列不合并、渲染与 JSON、D1–D10 口径收束；**注明**：set 缺 featureKey 时回退 run.featureName 的补丁口径、被跳过的运行不参与 unmatched、对齐区块全部展示（无封顶））。**并修订设计稿 §4** 的「limit 20／≤4 往返」旧表述为「全量／≤5 往返」。
  - README：对比视图章节补「功能对齐」段（入口同页、匹配规则、误报口径、窗口）。
  - AGENTS.md：面板行或对比视图描述补一句（按文件实际结构，最小改动）。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P3e (cross-project feature alignment)"`

---

## 独立复核修订记录（2026-10-15）

计划评审（deepseek/deepseek-v4-pro#high，只读）结论「可执行（无 Critical；2 Important 需补强）」；发现已全部并入：

- **I1**：`normalizeDesignSource` 前缀优先（`figma:`/`pen:` 先判 → 再判路径）；补 `pen:sub/a.pen`（含分隔符）用例。
- **I2**：设计稿 §4 旧表述（limit 20／≤4 往返）已修订为「全量／≤5 往返」（Task 3 同步执行）。
- **M3**：`featureKey === null` 运行跳过（防御守卫）＋断言。
- **M4**：set 缺 featureKey → `run.featureName` 回退的正向断言＋§13.114 注明补丁口径。
- **M5**：越界判定谓词明确（`..` 开头或跨盘符绝对结果 → 原样 lower）＋测试。
- **M6**：`buildCompareRow` 增返 `{ runs, sets }`（或循环内单点收集）——实现形状单点化。
- **M7**：被跳过运行不产生组键、不参与 unmatched（§13.114 注明＋断言）。
- **M8**：`listCaseSets` → `sets` 投影映射写明。
- **M9**：对齐区块无封顶（§13.114 注明全部展示）。
- **M10**：既有测试无回归风险（加性字段/子串断言）——无需动作。

---

## 范围外（另立计划）

- 手动别名/映射文件、模糊/AI 匹配、同名不同源「疑似」提示、跨项目合并统计与动作、历史对齐演进。
