# UI Semantic Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一层与项目无关的 UI 语义契约，把“稳定结构/分类树/标签”和“动态商品/价格/图片”分开，检测分类层级被拍平、视觉截断、信息架构漂移与动态资产缺失；用 draft 脚手架降低维护成本，用模式匹配与基线实现渐进式采用，并对“只验证了半屏”显式报 `insufficient-coverage`，不产生假绿。

**Architecture:** 手写/脚手架生成的 `ui-semantics.json`（逐屏区域/角色/分类树/别名/动态示例/动态模式/视口/资产期望）→ `src/ui/semantics.ts` 解析 → `src/ui/parity.ts` 纯函数审计 → `suite ui-parity` / `design_device_diff` / `suite check` 三个消费端；`src/ui/parity-baseline.ts` 提供增量治理。**两条 lane**：内容空间（设计全页节点树 × AX 全量内容树）做分类树/文本/IA；视口空间（截图 × designCrop × 视觉文本）做截断/资产/像素。全部 additive，缺文件不阻断存量项目。

**Tech Stack:** TypeScript ESM（NodeNext、strict）、Node 内置 `node:test`、现有 `UiContract` / `design_device_diff` / `suite` CLI / `pg-mem` 测试夹具。

**Spec:** `docs/superpowers/specs/2026-10-20-ui-interpretation-retro.md`（P1/P3、动态数据与覆盖缺口）、`DESIGN.md` §13.227（接入检查），以及 2026-10-26 菜单列表“设计稿 vs 实现”对比分析。

## Global Constraints

- 不写死任何项目名、商品名、分类名或语言；示例只能出现在测试夹具/文档中。
- `ui-semantics.json` **整个文件缺失**、为空或未知字段 → 存量行为不变；不把“没有语义文件”当失败。
- **已声明但空转的语义**必须响亮化：semantics 存在但某屏 `invariantTexts` 总数为 0 → `no-invariants`，不能返回 `layout-compatible`。
- **draft 不等于 confirmed**：脚手架只生成草稿骨架，不自动写入 invariant/dynamic 判定；未经 owner 确认的 draft 屏只能得到 `no-invariants`，不能假绿。
- **半屏不等于通过**：单视口只验证了部分 invariant 时，必须报 `insufficient-coverage`；`matched + unverified + offscreen == invariant` 必须守恒，`unverified/offscreen > 0` 不得返回 `layout-compatible`。
- **AX 文本不是视觉文本**：trace 的 `texts[]` 是内容空间、完整文本（`每日精選咖啡`），截图才可能出现 `每...咖啡`；截断检测只认 `source:"visual"` 的文本，AX 文本不能证明“未截断”。
- **分类是树，不是平文本**：`category-list` 必须有 group/child/alias 关系；`飲料`/`餐點` 是非交互 group header；后端叶子分类到设计顶层分类是多对一 `categoryMap`。
- **动态资产不等于忽略**：`dynamicAssets` 只表示“像素值可变”，仍必须检查资产存在性/非 placeholder；Hero 空白、商品图 fallback 不得被 `data-diff` 吞掉。
- **虚拟类目允许重复**：`推薦` 是 merchandising 虚拟类目，允许同一商品跨类目重复、允许同一文本出现在 rail/section/card tag；用 `allowedRoles`/`allowDuplicates` 表达，不能按“跨区多现”一律 warning。
- **来源分级**：只有 `figma-explicit`/高置信元素能进硬断言；`pen-vision`/inferred 只做探索。设计来源必须带 provenance，防止把别的屏的 `關閉` 带进当前页。
- **设计注释不是 UI**：Figma 的 `Flow/Header`、`Flow/Remarks`、状态栏是 chrome/annotation；`designCrop` 按 section 裁，不能整帧 diff。
- 动态内容与稳定结构必须显式区分；未标注的动态文本不得被静默当成 invariant。
- `dynamicPatterns` 是项目自有的可信配置，但必须有长度上限（≤200 字符）、必须能编译；不得作为用户输入执行。
- 基线只抑制已登记的 finding；**新 finding 不得被基线吞掉**；更新基线必须显式命令。
- 不自动修改应用代码，不自动判断 API 是否存在，不自动生成 owner/日期例外。
- 测试不依赖设备、网络、真实 Figma/pen；使用临时项目、合成 PNG 与本地 JSON。
- 用户可见文案中文；代码标识符英文；相对导入带 `.js`。
- 每个任务结束必须 `npm run build` + 对应测试通过；最终 `npm test` + `npm run lint` 全绿。

## Coordinate Spaces

这六个空间必须在代码/文档中始终带单位与锚点；任何转换都要在测试中锁住。

| 空间 | 字段/入口 | 单位/锚点 | 受 `designCrop` 影响 | 受缩放影响 | 校验阶段 |
|---|---|---|---|---|---|
| design-source | `semantics.designBbox`、`alignment.designCrop` | 设计原图像素，左上角为 (0,0) | 否（use-time 再减 crop 原点） | 是（引擎 downsample factor） | Task 4 use-time |
| cropped-design | `alignment.ignoreRegions`、引擎 `DiffOptions.designNodes` | 裁剪后设计图像素，左上角为 (0,0) | 是 | 引擎内部再乘 factor | Task 4 |
| device-viewport | `semantics.deviceBbox`、`UiRuntimeText.space:"viewport"` | 设备截图像素；同一 `viewport` 内有效 | 否 | 否 | Task 2/3 |
| device-content | trace `run.json` 的 `texts[].x/y/width/height`、`UiRuntimeText.space:"content"` | 设备逻辑内容坐标；可超出视口（y 可到数千） | 否 | 乘 `scale` → 设备像素 | Task 3 adapter |
| visual-text | `--snapshot`/`--visual-text` 的 `source:"visual"` 文本 | 视口截图像素；由 OCR/人工标注产生 | 是（按 current viewport） | 否 | Task 3/6 |
| output-regions | `DiffResult.regions[].bbox` | 设计工作区坐标（引擎现有口径） | 是 | 是 | 现有 engine |

- `deviceBbox` 必须配合 `UiScreenSemantics.viewport`（`{width,height,scale?}`）；运行时视口不匹配 → role 检查降级 warning `viewport-mismatch`，不报 error。
- **trace `texts[]` 是 content-space，不是 viewport-space**：`readTraceTexts` 现在返回全量内容树（含屏外文本）；adapter 必须设置 `space:"content"`，并按截图视口计算 `visible`/`offscreen`。不能把 content y=6091 直接当 viewport y。
- `--snapshot` 默认按 **device-viewport** 解释；需要内容树时显式 `space:"content"`。`source:"visual"` 的文本只用于截断/资产，不冒充完整 AX 树。
- `ignoreRegions` 在 `designCrop` 后按 **cropped-design** 传入；语义动态区域由 Task 4 减 crop 原点后追加。
- parse-time 只校验类型/有限数/宽高 >0；**画布内越界只能在 use-time 校验**（loader 不知道图片尺寸）。
- **覆盖率**：`counts.visible + counts.unverified + counts.offscreen == counts.invariant`；`unverified/offscreen > 0` → `insufficient-coverage`，不得 `layout-compatible`。

## Review Focus

- **动态数据被误判为设计缺失**：商品名/价格/库存/图片在 UAT 与设计样例不同时，应归为 `data-diff`，不是 `ia-mismatch`。
- **截断误报与漏报**：中缀省略号（`每...咖啡`）必须能检出；商品名原生省略号（`禮盒…`）与合法短标签（`冰茶`）不得误报；截断命中不得再计 missing。
- **空语义屏假绿**：semantics 存在但屏零 invariant → `no-invariants`，不得 exit 0；整文件缺失才豁免。
- **半屏假绿**：单视口只覆盖部分 invariant（分类栏 27 项、单屏约 14–17 项）→ `insufficient-coverage`，不得 `layout-compatible`；`visible/matched/unverified/offscreen` 必须守恒。
- **截断输入源**：AX 文本是完整的 `每日精選咖啡`，截图才是 `每...咖啡`；截断结论只能来自 `source:"visual"`，trace AX 文本必须标 `truncated: unverified`。
- **分类树被拍平**：设计 17 项两级（`飲料`/`餐點` + 15 分类）vs 实现 27 项扁平 → `ia-mismatch` + `unexpected-runtime-text`，不是单纯 `truncated-labels`。
- **动态资产被忽略**：Hero 空白、商品图 fallback 不能被 `dynamicAssets` 隐藏；必须有 `expectedAssets`/placeholder 检查。
- **虚拟类目/重复文本**：`推薦` 允许 rail + section header + card tag 多角色出现，允许商品跨类目重复；不能按“跨区多现”一律 warning。
- **来源分级**：`figma-explicit`/高置信才进硬断言；`pen-vision`/inferred 只探索，防止 `關閉` 这类别的屏的元素被带进来。
- **draft 假绿**：脚手架生成的空骨架不得被当成已确认语义；draft 屏必须 `no-invariants`。
- **坐标空间**：`designBbox`/`deviceBbox`/trace content bbox/`visualText`/`designCrop`/`ignoreRegions` 六个空间不得混用；越界/视口不匹配要显式。
- **IA 漂移双向**：运行时多出的未注册文本不能静默；`expectedCount` 双向比较。
- **角色归属**：同一文本多处出现时按 occurrence 消歧；优先“中心点被 region 严格包含”，再最小面积/最内层；跨区多现 → warning，全部在错误区域才 error。
- **动态忽略遮挡 invariant**：自动忽略动态商品行不得把分类标签、标题、搜索框一起遮掉。
- **闸门召回边界**：`--fail-on-dynamic` 只认 `dynamicExamples` + `dynamicPatterns`，必须声明非穷尽；新动态值需 owner 更新。
- **基线不吞新问题**：baseline 只抑制已登记 key；`--update-*` 显式写盘，不能默认开启。

---

### Task 1: UI 语义文件与解析器

**Files:**
- Create: `src/ui/semantics.ts`
- Test: `test/ui-semantics.test.js`

**Interfaces:**
- Consumes: `Bbox` from `src/diff/engine.ts`。
- Produces:
  ```ts
  export type UiRegionRole =
    | "header" | "category-list" | "product-list" | "search" | "banner" | "footer"
    | "group-header" | "unknown";
  export interface UiViewport { width: number; height: number; scale?: number; }

  export type UiTaxonomyKind = "category" | "group-header" | "virtual";
  /** 分类栏的树节点；group-header 非交互，virtual 允许重复商品/自定义名称。 */
  export interface UiTaxonomyNode {
    id: string;
    label: string;
    kind: UiTaxonomyKind;
    aliases?: string[];
    children?: UiTaxonomyNode[];
    allowDuplicates?: boolean;
    expectedCount?: number;
  }

  export interface UiRegionSemantics {
    id: string;
    role: UiRegionRole;
    designBbox?: Bbox;
    deviceBbox?: Bbox;
    /** 该 region 的文本是动态内容（商品名/价格/库存等）。 */
    isDynamic?: boolean;
    /** 资产像素可变；仍需 expectedAssets/presence 检查。 */
    dynamicAssets?: boolean;
    /** 设计侧稳定文本；与 isDynamic 互斥。 */
    invariantTexts?: string[];
    /** 设计侧样例动态值，供 check 扫描；不是 invariant。 */
    dynamicExamples?: string[];
    /** 动态格式正则（价格/日期/库存等），项目可信配置，≤200 字符。 */
    dynamicPatterns?: string[];
    /** 该 region 期望出现的稳定资产数量（Hero/商品图）；不设置则不检查。 */
    expectedAssets?: number;
    /** 分类栏树；与 invariantTexts 二选一或互补。 */
    taxonomy?: UiTaxonomyNode[];
    /** 同一文本允许出现的角色（如 推薦 = category-list + product-list + header）。 */
    allowedRoles?: UiRegionRole[];
    /** 允许同一文本/商品重复出现（推薦虚拟类目）。 */
    allowDuplicates?: boolean;
    /** 同一文本的期望出现次数；不设置则不检查。 */
    expectedOccurrences?: number;
    expectedCount?: number;
  }
  export interface UiDataProfile {
    design: string;
    runtime: string;
    allowedDynamicFields: Array<"name" | "price" | "image" | "availability" | "order">;
  }
  export interface UiScreenSemantics {
    screenId: string;
    screenName?: string;
    viewport?: UiViewport;
    displayNames?: Record<string, string[]>;
    dataProfile?: UiDataProfile;
    regions: UiRegionSemantics[];
  }
  export interface UiSemanticsFile {
    version: 1;
    /** 脚手架生成、尚未 owner 确认；draft 屏不得假绿。 */
    draft?: boolean;
    generatedAt?: string;
    source?: {
      contract?: string;
      contractFingerprint?: string;
      figma?: string;
      nodeId?: string;
      designFingerprint?: string;
    };
    screens: UiScreenSemantics[];
  }
  export function parseUiSemantics(raw: string): { file: UiSemanticsFile | null; errors: string[] };
  export function loadUiSemantics(
    configDirAbs: string,
    options?: { path?: string }
  ): { file: UiSemanticsFile | null; path: string; errors: string[] };
  export function semanticsForScreen(
    file: UiSemanticsFile | null,
    screenIdOrName: string
  ): UiScreenSemantics | null;
  export function matchesDynamicExample(caseText: string, example: string): boolean;
  export function matchesDynamicPattern(text: string, patterns: readonly string[]): boolean;
  ```
- 默认路径：`<configDirAbs>/design/ui-semantics.json`；`--semantics`/`options.path` 可覆盖。
- `displayNames` key = 设计侧稳定文本，value = 运行时允许别名数组；分类栏多对一映射优先用 `taxonomy[].aliases`。
- 命名区分：`isDynamic` 是布尔（region 语义）；`dynamicExamples` 是样例列表；`dynamicPatterns` 是格式正则；`dynamicAssets` 只表示像素可变，不等于忽略。
- parse-time 只校验：version=1、screenId/region.id 非空且唯一、role 合法、bbox 有限且宽高 >0、`invariantTexts`/`dynamicExamples` 非空字符串、二者不重叠、pattern 编译成功且 ≤200 字符、taxonomy id/label 唯一且 kind 合法、group-header 必须有 children、`expectedAssets`/`expectedOccurrences`/`expectedCount` 为非负整数、`allowedRoles` 合法；**不做画布越界检查**。
- 任一错误 → `file:null`（fail-closed）；`errors[]` 必须包含 `screens[i]`/`regions[j]`/`taxonomy[k]` 定位。
- `matchesDynamicPattern` 用 `new RegExp(pattern, "u")` 编译，空数组 → false；pattern 已在 parse-time 校验，运行时仍 try/catch 防手工对象。
- `matchesDynamicExample`：归一后双向子串（各方向最小长度 3）；含货币/数字时按数字 token 匹配，避免 `120` 命中 `1200`。

- [ ] **Step 1: 写失败测试**

  `test/ui-semantics.test.js`：
  - 合法多屏文件；按 id/name 查屏；`displayNames`/`viewport`/`isDynamic`/`dynamicExamples`/`dynamicPatterns`/`expectedAssets`/`allowedRoles` 保留。
  - taxonomy：`飲料` group-header + `咖啡飲品`/`茶瓦納` 子节点；`咖啡飲品.aliases` 含多个运行时叶子名；`推薦` 为 virtual + `allowDuplicates:true`；按 id 唯一。
  - 重复 screenId、重复 region id、非法 role、bbox 宽/高 ≤0、`dynamicExamples` 与 `invariantTexts` 重叠、version≠1、非法/超长 pattern、taxonomy 重复 id/label、group-header 无 children、负数 `expectedAssets` → errors，`file:null`，错误含屏/region/taxonomy 路径。
  - 缺失文件 → `{ file:null, errors:[] }`；非法 JSON → errors。
  - 旧文件只有 `{version:1,screens:[...]}`（无 regions）也能解析；draft 字段保留。
  - 未知字段忽略；`isDynamic` 与 `dynamicAssets` 可同时为 true。
  - `matchesDynamicPattern("價格 $150", ["\\$[0-9]+"])` → true；`"$1200"` 不被 `\$[0-9]{3}$` 误判；非法 regex 不抛到调用方。

- [ ] **Step 2: 运行测试确认失败**

  `npm run build && node --test test/ui-semantics.test.js`
  预期：找不到 `dist/ui/semantics.js` 或导出缺失。

- [ ] **Step 3: 实现解析/加载/查询**

  - `parseUiSemantics` 用 JSON.parse + 逐字段归一；`version` 只接受 1。
  - pattern 校验：trim、非空、长度 ≤200、`new RegExp(source, "u")` 可编译；保存原始 source。
  - taxonomy 递归校验：id/label 在整棵树唯一、kind 合法、group-header 必须有 children、virtual 可 `allowDuplicates`；深度上限 8，防止病态文件。
  - `loadUiSemantics` 只读文件，不写盘；缺失文件不报错。
  - `semanticsForScreen` 先 screenId，再 screenName（空白/大小写归一）。
  - 不引入 CLI/contract 读取。

- [ ] **Step 4: 运行测试确认通过**

  `npm run build && node --test test/ui-semantics.test.js`
  预期：PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/ui/semantics.ts test/ui-semantics.test.js
  git commit -m "feat(ui): add ui semantics schema and loader"
  ```

---

### Task 1b: Semantics 脚手架（draft-only）

**Files:**
- Create: `src/ui/semantics-init.ts`
- Modify: `src/suite-command.ts`（`ui-semantics init` 子命令/帮助）
- Test: `test/ui-semantics-init.test.js`

**Interfaces:**
- Produces:
  ```ts
  export interface UiSemanticsInitOptions {
    contractPath: string;
    outPath: string;
    force?: boolean;
    generatedAt?: string;
  }
  export interface UiSemanticsInitResult {
    path: string;
    screens: number;
    created: boolean;
    warnings: string[];
  }
  export function initUiSemantics(options: UiSemanticsInitOptions): UiSemanticsInitResult;
  ```
- CLI：
  ```text
  mobile-testing-mcp suite ui-semantics init
    [--contract <json>] [--out <json>] [--force] [--json]
  ```
- 默认 `--contract` = `.artemis/design/ui-contract.json`；默认 `--out` = `.artemis/design/ui-semantics.json`；路径相对项目根。
- 行为：读 contract 屏 id/name，输出
  ```json
  {
    "version": 1,
    "draft": true,
    "generatedAt": "...",
    "source": {"contract": "...", "contractFingerprint": "..."},
    "screens": [{"screenId": "...", "screenName": "...", "regions": []}]
  }
  ```
  不自动写 `invariantTexts`/`dynamicExamples`/`designBbox`；所有屏 `regions:[]`。
- 已有文件且无 `--force` → exit 2，不覆盖；`--force` 覆盖但保留 `.bak`（原子写）。
- 缺/坏 contract → exit 2；空 contract 屏 → 生成空 screens + warning，不假绿。

- [ ] **Step 1: 写失败测试**

  `test/ui-semantics-init.test.js`：
  - 临时项目写 `ui-contract.json` 两屏 → init 生成 draft，screens 2、regions 全空、`draft:true`，文件存在。
  - 再次 init 无 `--force` → exit 2，内容不变；`--force` → 覆盖且 `.bak` 存在。
  - 缺 contract、坏 JSON → exit 2。
  - `--json` 输出 `{path,screens,created,warnings}`。

- [ ] **Step 2: 运行测试确认失败**

  `npm run build && node --test test/ui-semantics-init.test.js`
  预期：未知子命令/无导出。

- [ ] **Step 3: 实现 init 与 CLI**

  - `initUiSemantics` 读 contract（复用 `UiContract` 解析/`readFileSync`），只取 `screens[].id/name`；写临时文件 + rename；`force` 前把旧文件复制为 `${out}.bak`。
  - CLI 加入 `ui-semantics` 子命令组；`init` 解析 flags、退出码 0/1/2。
  - 不自动调用 pen/Figma，不推断 invariant/bbox；文档说明“带骨架但坐标为空”的退化模式。
  - 帮助行加入 `suite help`。

- [ ] **Step 4: 运行测试确认通过**

  `npm run build && node --test test/ui-semantics-init.test.js`
  预期：PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/ui/semantics-init.ts src/suite-command.ts test/ui-semantics-init.test.js
  git commit -m "feat(ui): scaffold draft ui semantics from contract"
  ```

---

### Task 2: 纯函数 UI 一致性审计

**Files:**
- Create: `src/ui/parity.ts`
- Test: `test/ui-parity.test.js`

**Interfaces:**
- Consumes: `UiScreenContract`（`src/ui/contract.ts`）；`UiScreenSemantics`、`UiViewport`、`matchesDynamicExample`、`matchesDynamicPattern`（Task 1）；`Bbox`（`src/diff/engine.ts`）。
- Produces:
  ```ts
  export interface UiRuntimeText {
    text: string;
    bbox?: Bbox;
    /** 默认 viewport；trace AX 树必须标 content。 */
    space?: "content" | "viewport";
    /** 是否落在当前截图视口内；默认 true。 */
    visible?: boolean;
    /** ax = 无障碍树；visual = 截图 OCR/人工标注；manual = 测试夹具。 */
    source?: "ax" | "visual" | "manual";
  }
  export interface UiRuntimeAsset {
    kind: "image" | "banner" | "icon";
    bbox?: Bbox;
    space?: "content" | "viewport";
    present: boolean;
    placeholder?: boolean;
    source?: "ax" | "visual" | "manual";
  }
  export interface UiParityInput {
    screen: UiScreenContract;
    semantics: UiScreenSemantics | null;
    runtime: {
      screen?: string;
      viewport?: UiViewport;
      texts: UiRuntimeText[];
      assets?: UiRuntimeAsset[];
      /** 运行时文本空间；trace AX 树通常为 content。 */
      space?: "content" | "viewport";
      /** 调用方声明这次文本覆盖是完整的（region-scoped/全量内容树）。 */
      coverageComplete?: boolean;
      /** 只审计该 region（taxonomy/expectedCount 用）。 */
      regionId?: string;
    };
  }
  export type UiParityVerdict =
    | "layout-compatible" | "data-diff" | "truncated-labels"
    | "ia-mismatch" | "no-invariants" | "insufficient-data"
    | "insufficient-coverage";
  export interface UiParityFinding {
    kind:
      | "missing-invariant" | "truncated-label" | "dynamic-diff"
      | "role-mismatch" | "role-ambiguous" | "unexpected-runtime-text"
      | "expected-count-mismatch" | "viewport-mismatch" | "missing-semantics"
      | "coverage-gap" | "taxonomy-mismatch" | "missing-asset" | "placeholder-asset";
    severity: "info" | "warning" | "error";
    text: string;
    designText?: string;
    runtimeText?: string;
    role?: UiRegionRole;
    /** 基线命中时为 true（由 Task 3 写入）。 */
    baselined?: boolean;
  }
  export interface UiParityReport {
    ok: boolean;
    verdict: UiParityVerdict;
    screenId: string;
    dataProfile?: UiDataProfile;
    counts: {
      invariant: number;
      matched: number;
      missing: number;
      truncated: number;
      dynamic: number;
      unexpected: number;
      /** 覆盖率：visible + unverified + offscreen == invariant。 */
      visible: number;
      unverified: number;
      offscreen: number;
      /** 分类树：expected/matched/missing/unexpected。 */
      taxonomyExpected: number;
      taxonomyMatched: number;
      taxonomyMissing: number;
      taxonomyUnexpected: number;
      /** 资产：expected/present/missing/placeholder。 */
      assetsExpected: number;
      assetsPresent: number;
      assetsMissing: number;
      assetsPlaceholder: number;
    };
    findings: UiParityFinding[];
    warnings: string[];
  }
  export function normalizeUiText(text: string): string;
  export function auditUiParity(input: UiParityInput): UiParityReport;
  ```
- `counts.invariant === counts.matched + counts.missing + counts.truncated + counts.unverified + counts.offscreen` 必须恒成立；`dynamic`/`unexpected` 不计入 invariant。
- **覆盖率守恒**：`counts.visible === counts.matched + counts.missing + counts.truncated`，且 `counts.visible + counts.unverified + counts.offscreen === counts.invariant`；`offscreen` 指 `visible:false` 或 `bbox` 落在视口外；`unverified` 指没有足够证据（如 AX 文本无法判断视觉截断、content-space 不做 role）。
- 命名说明：finding `truncated-label` 是单条，verdict `truncated-labels` 是整体结果；二者故意单/复数不同，不是拼写漂移。
- `ok`：`layout-compatible`/`data-diff` 为 true，但必须 `unverified === 0 && offscreen === 0`；`no-invariants`/`insufficient-data`/`insufficient-coverage`/`truncated-labels`/`ia-mismatch` 为 false。

**判定语义：**

1. 无 semantics → `insufficient-data` + `missing-semantics`；不把设计全量文本报 missing。
2. 有 semantics 但 `invariantTexts` 与 `taxonomy` 总数为 0 → `no-invariants` + warning「该屏未定义任何 invariant，结构未实际验证」；`ok=false`。draft 文件同样走这里。
3. **分类树优先于平文本**：如果 region 有 `taxonomy`，先做 taxonomy 审计：
   - 递归展开 tree，得到每个 `category`/`group-header`/`virtual` 节点的 label + aliases。
   - 运行时文本按 label/alias 归一匹配；`group-header` 非交互，只检查存在；`virtual`/`allowDuplicates` 允许同一商品多次出现。
   - `taxonomyExpected` = 节点数；`taxonomyMatched` = 至少匹配一次的节点数；`taxonomyMissing` = 未匹配节点数；`taxonomyUnexpected` = 在 region 范围内未映射到任何节点的运行时文本数（有 bbox 时按 region 过滤，无 bbox 时只报告 missing，不臆造 unexpected）。
   - 缺失 → `missing-invariant`（error）；多余 → `unexpected-runtime-text`（warning）；整体不一致 → `taxonomy-mismatch` finding。
   - 分类树命中后，不再把同一文本按平 invariant 重复计数；`counts.invariant` 包含 taxonomy 叶子节点。
4. **覆盖率（先于 verdict）**：
   - 每个 invariant 归入 `visible` / `unverified` / `offscreen`；`visible + unverified + offscreen == invariant`。
   - `content` space 且无 `viewport`/scroll 映射 → role 检查跳过，相关 invariant 记 `unverified`（warning `coordinate-space-mismatch`）。
   - 需要视觉截断检查（category-list 默认需要）但 runtime 文本全为 `source:"ax"` → 相关 invariant 记 `unverified`（warning `visual-truncation-unverified`）。
   - `unverified/offscreen > 0` → `insufficient-coverage`，`ok=false`；除非这些 invariant 已被显式 `dynamic`/`virtual` 覆盖。
5. 每个平 invariant 先精确匹配 → `displayNames` 别名 → 截断检测 → 缺失。
6. **截断检测**（任一命中即 `truncated`，该 invariant 不进入 matched/missing）：
   - 只对 `source:"visual"` 或文本本身含省略号的 runtime 文本执行；AX 完整文本不能证明未截断。
   - 尾部：runtime 以 `…`/`...` 结尾，去掉省略号后是 invariant 前缀（前缀 ≥3）。
   - 中缀：runtime 按 `…`/`...` 拆成前后两段（可多段取首尾）；首段是 invariant 前缀（≥1 个字符）且尾段是 invariant 后缀（≥2 个字符）。
   - 精确匹配优先；因此 `禮盒…` 若本身就是 invariant 文本则不是截断；`冰茶` 无省略号且不是更长 invariant 的截断。
   - 命中 → finding `truncated-label` 单条，severity **error**；抑制同文本的 `missing-invariant`。
7. **动态内容**：`region.isDynamic || region.dynamicAssets`、`dynamicExamples` 精确样例或 `dynamicPatterns` 命中 → 归为动态；差异/未命中 → `dynamic-diff` info；不得报 missing/unexpected。
8. **动态资产**：region 的 `expectedAssets > 0` 时，统计落在 region bbox 内且 `present` 的资产；少于期望 → `missing-asset`（error）；`placeholder:true` → `placeholder-asset`（error）。`dynamicAssets` 只跳过像素值比较，不跳过存在性。
9. **IA 双向**：
   - `expectedCount` 少于/多于 → warning `expected-count-mismatch`，文本列出缺失/多出的项。
   - region 内未匹配任何 invariant/dynamic/alias/taxonomy 的运行时文本 → warning `unexpected-runtime-text`（不静默）。
   - `counts.unexpected` 记录未注册运行时文本数量（不含 `expectedCount` 差额）。
10. **角色归属（仅 viewport-space，occurrence 级）**：
   - 只对 `space:"viewport"` 的 runtime 文本做几何归属；`space:"content"` 或 `visible:false` → 跳过几何，记 warning。
   - 取 runtime text 的 **中心点**：优先归属中心点被严格包含的 region；多个包含 → 最小面积；面积相同 → 最内层；仍无法判定 → `role-ambiguous` warning。
   - 若无 region 严格包含中心点但存在 bbox 相交 → 按最小面积归属，并 warning `role-ambiguous`（不静默）。
   - 期望 region 内有任一 occurrence → matched；全部 occurrence 都在错误 region 且不在 `allowedRoles` → `role-mismatch` error；跨区多现且在 `allowedRoles`/`allowDuplicates` 内 → matched + `role-ambiguous` info；否则 warning。
   - 无 `deviceBbox` 或无 runtime viewport → 不做 role error，只 warning。
   - 若 screen 有 regions 但全部没有 `deviceBbox` → `warnings` 追加 `coordinate-coverage-missing：仅文本级校验`；不失败，保持可退化。
   - `viewport` 不匹配 → `viewport-mismatch` warning，role 检查降级。
11. **verdict 优先级**：`no-invariants` > `insufficient-data` > `ia-mismatch` > `truncated-labels` > `insufficient-coverage` > `data-diff` > `layout-compatible`；`ia-mismatch` 只在存在真实 missing/role error/taxonomy mismatch 时成立，截断已互斥。
12. `dataProfile` 原样带入报告；profile 不同不单独失败，只解释动态差异。`normalizeUiText` 不做繁简转换，别名由 `displayNames`/`taxonomy.aliases` 兜底。

- [ ] **Step 1: 写失败测试**

  `test/ui-parity.test.js` 至少覆盖：
  1. invariant「推薦」+「咖啡飲品」存在且 `source:"visual"` → `layout-compatible`，counts 守恒（`matched + missing + truncated + unverified + offscreen == invariant`）。
  2. **中缀截断合成场景**：`source:"visual"` 的「每...咖啡」「熱...飲料」→ `truncated-labels`；finding 单条/文本、severity error；`counts.truncated=2`，`missing=0`，守恒。
  3. **AX 完整文本不能证明未截断**：`source:"ax"` 的「每日精選咖啡」→ 不产生 `truncated`，相关 invariant 记 `unverified`，verdict `insufficient-coverage`；补 `source:"visual"` 后才可能 `layout-compatible`。
  4. 尾部截断 `每日精…` → `truncated-labels`；`禮盒…` 本身是 invariant → 精确匹配、不截断；`冰茶` 不误报。
  5. 动态样例/模式（价格 `\$[0-9]+` 或日期）与运行时不同 → `data-diff`，不报 missing/unexpected。
  6. `displayNames` 把「每日精選咖啡」映射为「咖啡飲品」→ 合法别名。
  7. 无 semantics → `insufficient-data`；屏注册但零 invariant → `no-invariants`（**不是** `layout-compatible`），`ok=false`；draft 同样。
  8. **分类树**：设计 17 项两级（`飲料`/`餐點` group + 15 分类）vs 运行时 27 项扁平 → `ia-mismatch`；alias 归一后 `taxonomyExpected=17`、`taxonomyMatched=13`、`taxonomyMissing=4`（`飲料`/`餐點`/`調理咖啡`/`包裝食品`）、`taxonomyUnexpected=6`（`氮氣冷萃咖啡`/`咖啡豆`/`VIA`/`掛耳式咖啡`/`零食點心`/`禮盒`）；`推薦` virtual 允许重复不误报。
  9. **半屏覆盖**：27 个 invariant、14 个 visible、13 个 offscreen → `insufficient-coverage`，`ok=false`，不得 `layout-compatible`。
  10. **动态资产**：`expectedAssets:1` + 无资产 → `missing-asset`；`placeholder:true` → `placeholder-asset`；`dynamicAssets:true` 不能跳过存在性。
  11. role：viewport-space 中心点包含多 region → 最小面积/最内层；期望区+其他区多现且在 `allowedRoles` → matched + `role-ambiguous` info；全部在错区 → `role-mismatch` error；content-space → 不做 role error，只 warning。
  12. 运行时多出未注册文本 → `unexpected-runtime-text` warning，counts.unexpected≥1；`expectedCount` 少于/多于实际 → `expected-count-mismatch` warning。
  13. 动态 pattern 命中的运行时文本不被计为 unexpected；pattern 不匹配的相似值（`$1200` vs `$120`）不被误吞。

- [ ] **Step 2: 运行测试确认失败**

  `npm run build && node --test test/ui-parity.test.js`
  预期：找不到 `dist/ui/parity.js`。

- [ ] **Step 3: 实现审计算法**

  - 归一化：trim、连续空白折叠、大小写不敏感；**不做繁简转换**。
  - 先算 invariant 总数（含 taxonomy 叶子）与零 invariant 守卫（no-invariants）。
  - taxonomy 展开/匹配 → missing/unexpected/group-header；`allowDuplicates`/`virtual` 允许多次出现。
  - 逐 invariant 执行「精确 → alias → 截断（仅 visual） → missing」，截断与 missing 互斥。
  - 覆盖率：visible/unverified/offscreen；content-space 或 AX-only 记 unverified，不假装通过。
  - 动态区/`dynamicExamples`/`dynamicPatterns` 单独统计，不参与 invariant 守恒；pattern 命中优先于 unexpected。
  - 资产 presence/placeholder 检查；`dynamicAssets` 不跳过。
  - occurrence/region 匹配仅对 viewport-space；content-space 只做文本级 warning。
  - `unexpected` 双向；`expectedCount` 超出也 warning。
  - verdict 与 `ok` 按上述规则。

- [ ] **Step 4: 运行测试确认通过**

  `npm run build && node --test test/ui-parity.test.js`
  预期：PASS（含 counts 守恒断言）。

- [ ] **Step 5: 提交**

  ```bash
  git add src/ui/parity.ts test/ui-parity.test.js
  git commit -m "feat(ui): audit invariant, truncation and dynamic content"
  ```

---

### Task 3: `suite ui-parity` CLI、快照与基线

**Files:**
- Create: `src/ui/parity-source.ts`
- Create: `src/ui/parity-baseline.ts`
- Modify: `src/suite-command.ts`（帮助、flags、subcommand dispatch）
- Test: `test/ui-parity-command.test.js`
- Test: `test/ui-parity-baseline.test.js`

**Interfaces:**
- Produces:
  ```ts
  export interface UiRuntimeSnapshot {
    screen?: string;
    step?: number;
    viewport?: UiViewport;
    source: "trace" | "file";
    /** trace 默认 content；--snapshot 默认 viewport。 */
    space: "content" | "viewport";
    texts: UiRuntimeText[];
    assets?: UiRuntimeAsset[];
    /** 视口覆盖：visible/unverified/offscreen 计数。 */
    coverage?: { visible: number; unverified: number; offscreen: number };
  }
  export function loadUiRuntimeSnapshot(
    runtime: Runtime,
    input: {
      traceId?: string;
      stepNumber?: number;
      snapshotPath?: string;
      visualTextPath?: string;
    }
  ): UiRuntimeSnapshot;

  export type UiParityBaselineTool = "ui-parity" | "check-dynamic";
  export interface UiParityBaselineEntry {
    tool: UiParityBaselineTool;
    screenId?: string;
    caseId?: string;
    kind: string;
    text: string;
    role?: string;
  }
  export interface UiParityBaselineFile { version: 1; entries: UiParityBaselineEntry[]; }
  export function loadUiParityBaseline(file: string): {
    file: UiParityBaselineFile;
    path: string;
    errors: string[];
  };
  export function baselineEntryKey(entry: UiParityBaselineEntry): string;
  export function partitionByBaseline(
    findings: UiParityFinding[],
    file: UiParityBaselineFile,
    context: { screenId: string; tool: "ui-parity" }
  ): { fresh: UiParityFinding[]; baselined: UiParityFinding[] };
  export function writeUiParityBaseline(file: string, entries: UiParityBaselineEntry[]): void;
  ```
- CLI：
  ```text
  mobile-testing-mcp suite ui-parity
    (--trace <traceId> --step <n> | --snapshot <json>)
    [--visual-text <json>] [--region <id>]
    [--screen <id|name>] [--semantics <path>] [--contract <path>]
    [--baseline <json>] [--update-baseline] [--json]
  ```
- 路径根：`--snapshot`/`--visual-text`/`--contract`/`--semantics`/`--baseline` 相对 **`runtime.project.rootDir`**；绝对路径原样。
- `--snapshot` 格式：`{screen?, viewport?, space?, texts:[{text,x?,y?,width?,height?,source?,visible?}], assets?}`；默认 `space:"viewport"`。
- `--visual-text` 格式：`{texts:[{text,x?,y?,width?,height?,source:"visual"}]}`；用于截断/资产生成；不与 AX 文本混为同一来源。
- `--trace` 复用 `readTraceTexts(runtime, traceId, stepNumber)`；`--step` 必填；adapter 设置 `space:"content"`，按截图视口计算 `visible/offscreen`，**不把 content y 当 viewport y**。
- `--region <id>` 只审计指定 region（如 `category-rail`），用于 taxonomy 计数和避免拿整屏 300 条文本做 unexpected。
- 屏幕解析：`--screen` 按 contract id/name；省略时用 snapshot.screen 或 trace step 与 contract 屏名归一匹配；歧义 exit 2。
- **交叉校验**：semantics 中存在但 contract 不存在的 screen → error exit 2（死条目）；contract 有但 semantics 无 → warning。
- **基线**：
  - `--baseline` 只抑制 key 匹配的 finding；`baselined` findings 不计入 exit 1，但在 JSON 里标 `baselined:true`。
  - `--update-baseline` 显式把当前非 info findings 写入 `--baseline`（缺省 `.artemis/design/ui-parity-baseline.json`），原子写；**替换整个文件为当前快照**（无 findings → 空 entries），旧 key 由显式 update 清理；更新完仍按“无基线”报告，退出码由剩余错误决定。
  - 不默认启用基线；不自动更新。
- 退出码：
  - `0`：`layout-compatible` / `data-diff`（含全部 baseline，且 `unverified/offscreen == 0`）；
  - `1`：`no-invariants` / `truncated-labels` / `ia-mismatch` / `insufficient-coverage`（有新 finding；baseline 命中不算）；
  - `2`：`insufficient-data`（缺 semantics 文件或无法校验）/ 缺 contract / 缺 snapshot / 缺 `--step` / 屏幕解析失败 / semantics 死屏 / 路径/JSON 非法 / 基线非法。
- **覆盖输出**：文本/JSON 必须显示 `visible/matched/unverified/offscreen`，以及 `taxonomyExpected/Matched/Missing/Unexpected`、`assetsExpected/Present/Missing/Placeholder`。

- [ ] **Step 1: 写失败测试**

  `test/ui-parity-command.test.js`：
  - 临时项目写 contract/semantics/snapshot；`--snapshot` JSON，exit 0，verdict/counts 正确。
  - 中缀截断（`source:"visual"`）→ exit 1；零 invariant → exit 1；运行时多出文本 → warning 但 exit 0。
  - **半屏覆盖**：snapshot 14 visible/13 offscreen → exit 1 `insufficient-coverage`，不能 `layout-compatible`。
  - **AX 全量 trace**：`texts` 300 条、y 到 6091，adapter 标 content/offscreen；只审计 region 内文本，不能把屏外项当 matched。
  - 缺 `--trace/--snapshot`、缺 `--step`、未知屏幕、缺 contract、semantics 死屏 → exit 2。
  - trace 路径：写 `run.json` `steps:[{step:2,screen,texts,scale:3}]`，`--trace t1 --step 2` 同一报告；content-space 标 `space:"content"`，不按 viewport 误判。
  - 缺 semantics 文件 → exit 2，提示先建 `ui-semantics.json`。
  - `--contract`/`--semantics`/`--baseline` 相对项目根解析；`--region` 只审计该 region。
  - 基线：`--baseline` 命中既有 finding → exit 0/JSON `baselined:true`；新增 finding → exit 1；`--update-baseline` 写文件且不动原文件（原子）。
  - 坏基线 → exit 2；`--update-baseline` 缺路径/不可写 → exit 2。

  `test/ui-parity-baseline.test.js`：
  - key 归一（screen/case/kind/text/role）；缺字段稳定；重复 key 去重；读非法 JSON error；写原子（临时文件不留）。

- [ ] **Step 2: 运行测试确认失败**

  `npm run build && node --test test/ui-parity-command.test.js test/ui-parity-baseline.test.js`
  预期：未知子命令/无导出。

- [ ] **Step 3: 实现快照、基线与 CLI**

  - `loadUiRuntimeSnapshot`：trace 用 `readTraceTexts`，设置 `space:"content"`，按截图视口/size 计算 `visible/offscreen`；文件用 `fs.readFileSync`，默认 `space:"viewport"`；`--visual-text` 合并为 `source:"visual"` 文本。
  - CLI 加载 contract（默认 `.artemis/design/ui-contract.json`）、semantics（默认 `.artemis/design/ui-semantics.json`）。
  - 屏集交叉校验：semantics 未匹配 contract → error；contract 未匹配 semantics → warning。
  - `auditUiParity` 后，若有 baseline：`partitionByBaseline`，baselined 标 `true`；只有 `fresh` 的 error/truncated/ia/coverage 影响退出码。
  - `--update-baseline` 只写当前非 info findings；文件原子写；不自动清理旧 key（owner 手动清理，docs 声明）。
  - 文本输出：
    ```text
    UI 一致性: <screen> · <verdict> · invariant <matched>/<total> · visible <n> · truncated <n> · unverified <n> · offscreen <n> · taxonomy <matched>/<expected> · assets <present>/<expected> · baselined <n>
    - [severity] <kind> <text>（role/design/runtime；baselined 标记）
    ```
  - 帮助行加入 `suite help`。

- [ ] **Step 4: 运行测试确认通过**

  `npm run build && node --test test/ui-parity-command.test.js test/ui-parity-baseline.test.js`
  预期：PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/ui/parity-source.ts src/ui/parity-baseline.ts src/suite-command.ts test/ui-parity-command.test.js test/ui-parity-baseline.test.js
  git commit -m "feat(suite): add ui-parity command with baseline"
  ```

---

### Task 4: `design_device_diff` 设计裁剪与动态区域忽略

**Files:**
- Modify: `src/diff/engine.ts`
- Modify: `src/diff/tool.ts`
- Modify: `src/tools/native-tools/design.ts`
- Test: `test/diff-crop.test.js`（新增）；扩 `test/design-device-diff.test.js`

**Interfaces:**
- `DiffOptions` 增加 `designCrop?: Bbox`（design-source pixels；裁剪后再按设计宽度缩放）。
- `DiffAlignment` 增加 `designCrop: Bbox | null`。
- `DesignDeviceDiffArgs` 增加：
  ```ts
  ui?: {
    semanticsPath?: string;
    screenId?: string;
    ignoreDynamicRegions?: boolean;
    /** 动态 region 内仍要求资产存在（Hero/商品图），不因 dynamicAssets 跳过。 */
    expectedAssets?: boolean;
  };
  ```
- `alignment.designCrop?: Bbox`：
  - 校验：有限数、宽高 >0、`x+width <= 设计宽`、`y+height <= 设计高`；越界 → 明确错误，不写产物。
  - 裁剪后 designNodes 坐标减去 crop 原点并过滤；`ignoreRegions` 按 cropped-design 坐标传入；report 记 `alignment.designCrop`。
- `ui.ignoreDynamicRegions=true`：
  - `semanticsPath` 相对项目根（绝对路径原样）；加载 semantics，取目标屏 `isDynamic || dynamicAssets` 且含 `designBbox` 的 region；无 `designBbox` → warning 并列出跳过数；转换到 cropped-design 后追加 `ignoreRegions`。与 `designCrop` 相交时裁剪到可见部分；完全在 crop 外 → warning `dynamic-region-outside-crop`，不静默。
  - 响应/report 增 `dynamicIgnoreRegions`；缺 semantics/屏 → warning，不阻断。
  - 只忽略标记动态的 region；invariant 文本（如 `推薦`）继续参与像素比较。
- `ui.expectedAssets=true`：
  - 对 `dynamicAssets` region 统计资产存在性；`expectedAssets` 未满足 → 报告 `missing-asset`；placeholder（fallback 杯子/空白 Banner）→ `placeholder-asset`；不因动态而放行。
  - 设计源为 Figma 时，**排除 `Flow/Header`、`Flow/Remarks` 和系统栏**；`designCrop` 按 section 裁，不整帧 diff。

- [ ] **Step 1: 写失败测试**

  - 设计 390×1000，列表 y=600..1000；设备 390×400 只含列表。`designCrop:{x:0,y:600,width:390,height:400}` + 相同内容 → `alignment.scale=1`、无差异；不裁剪 → 大量差异。
  - 越界/0 宽高/非有限 → 错误且不写产物。
  - 动态区域：设计样例商品/设备真实商品，`ignoreDynamicRegions` 指向该 region → 差异被忽略/标记；`推薦` 仍参与比较。
  - **动态资产存在性**：Hero `expectedAssets:1` + 空白 → `missing-asset`；商品图 `placeholder:true` → `placeholder-asset`；`ignoreDynamicRegions` 不能把这些一起忽略。
  - **设计 chrome**：Figma 源带 `Flow/Header`/`Flow/Remarks` 时被排除，不写入 crop 范围；状态栏 mask。
  - 动态 region 无 `designBbox` / 完全在 crop 外 → warning 列出跳过数。
  - 缺 semantics → warning，按原图比较。
  - schema 参数校验；`dryRun` 计划含 crop/semantics/assets。

- [ ] **Step 2: 运行测试确认失败**

  `npm run build && node --test test/diff-crop.test.js test/design-device-diff.test.js`
  预期：裁剪/动态参数不生效。

- [ ] **Step 3: 实现裁剪与动态区域**

  - engine：`normalizeDesignCrop`（use-time）→ 裁剪设计图 → 节点坐标减 crop 原点/过滤；`alignment.designCrop` 写入；ignoreRegions 为 cropped-design 坐标，引擎内部再乘 factor。
  - tool：解析 `alignment.designCrop`；decode 后裁剪设计图；detail 使用同一裁剪图；report/response 增 `alignment.designCrop`。
  - tool：`ui.ignoreDynamicRegions` 加载 semantics（Task 1），只取动态 region，减 crop 原点，追加 ignoreRegions；warning 说明忽略数/跳过数。
  - native schema：`alignment.designCrop`、`ui` 字段描述；dryRun 只回计划。

- [ ] **Step 4: 运行测试确认通过**

  `npm run build && node --test test/diff-crop.test.js test/design-device-diff.test.js`
  预期：PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/diff/engine.ts src/diff/tool.ts src/tools/native-tools/design.ts test/diff-crop.test.js test/design-device-diff.test.js
  git commit -m "feat(diff): support design crop and semantic dynamic regions"
  ```

---

### Task 5: `suite check` 动态断言告警、模式匹配与增量基线

**Files:**
- Modify: `src/figma/preflight.ts`
- Modify: `src/suite-command.ts`（`check` flags/JSON/文本）
- Test: `test/test-preflight.test.js`
- Test: `test/suite-command.test.js`（CLI 退出码）

**Interfaces:**
- `PreflightReport` 增加：
  ```ts
  dynamicContent: {
    cases: Array<{ caseId: string; name: string; texts: string[]; baselined: boolean }>;
    total: number;
    fresh: number;
    baselined: number;
    semanticsPath: string | null;
  };
  ```
- 匹配 helper（Task 1 已导出）：
  ```ts
  export function matchesDynamicExample(caseText: string, example: string): boolean;
  ```
  - 归一后：example 包含于 caseText（example 长度 ≥3）或 caseText 包含于 example（caseText 长度 ≥3）。
  - 含货币/数字的 example（`$120`、`120 起`）：提取数字 token，数字相等且上下文含货币/“起”即算命中；避免 `120` 命中 `1200` 的子串。
  - `dynamicPatterns` 用 `matchesDynamicPattern`（Task 1）直接匹配 caseText；pattern 命中即动态。
- 扫描每条 tests 记录的 `taskDesc` 与 `steps`；命中任一 `dynamicExamples`/`dynamicPatterns` → 记入 `dynamicContent`；默认 warning，`--fail-on-dynamic` 时 exit 2。
- **样例来自设计**：`dynamicExamples` 应同时包含设计样例商品名（如 `冰蘋果山茶花風味美式`）和运行时真实名；否则生成用例会把设计样例写成硬断言，UAT 菜单没有该商品时误判 UI 缺陷。
- **基线（增量治理）**：
  - `--dynamic-baseline <json>`（默认 `.artemis/design/ui-dynamic-baseline.json`，仅在显式传入/存在时启用）；`--update-dynamic-baseline` 把当前命中条目写入基线（tool=`check-dynamic`，key=`caseId|text`），原子写并替换为当前快照。
  - 有基线时 `--fail-on-dynamic` 只对**新 key** exit 2；baseline 命中不阻断；`--update` 仍报告新/旧。
  - 基线文件格式复用 Task 3 的 `UiParityBaselineFile`；缺/坏基线 → exit 2。
- **非穷尽声明**：帮助/文档明确「只匹配已登记的 dynamicExamples/dynamicPatterns；新运行时商品/价格需 owner 更新词表，本闸门不是穷尽检测」。

- [ ] **Step 1: 写失败测试**

  - semantics region `dynamicExamples:["冰蘋果山茶花風味美式","$120 起"]`、`dynamicPatterns:["\\$[0-9]+"]`；tests 一个 taskDesc 含样例，一个只含 `推薦`/`咖啡飲品`。
  - `preflightGeneratedTests` → `dynamicContent.total=1`，caseId/name/texts 正确；缺语义 → 0。
  - 匹配方向：example 在长句中命中；长句在 example 中且长度≥3 命中；`$120` 模式命中 `$150`；`120` 不误报 `1200`。
  - `suite check --json` 字段；`--fail-on-dynamic` exit 2；默认 exit 0（无其他门禁）。
  - 基线：先 `--update-dynamic-baseline` 记录既有命中；再次 `--fail-on-dynamic --dynamic-baseline` exit 0；新增动态文本 → exit 2；坏基线 → exit 2；JSON 的 `fresh/baselined` 计数正确。
  - 不含动态文本的用例不误报。

- [ ] **Step 2: 运行测试确认失败**

  `npm run build && node --test test/test-preflight.test.js test/suite-command.test.js`
  预期：字段/flag 缺失。

- [ ] **Step 3: 实现 preflight 与 CLI**

  - `preflightGeneratedTests` 加载默认 semantics（缺文件 neutral）；用 `matchesDynamicExample`/`matchesDynamicPattern` 扫描；同 case 去重。
  - `suite check` 文本/JSON/退出码接线；`--fail-on-dynamic`、`--dynamic-baseline`、`--update-dynamic-baseline` 加入帮助行与文档；声明非穷尽。
  - 基线复用 Task 3 的读写/key 函数；`check-dynamic` 条目带 `caseId`、`text`，不带 `screenId`（未知屏幕也可记录）；报告区分 `fresh`/`baselined`。
  - `suite loop` 的 check 摘要可增加动态内容计数（可选，不改门禁）。

- [ ] **Step 4: 运行测试确认通过**

  `npm run build && node --test test/test-preflight.test.js test/suite-command.test.js`
  预期：PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/figma/preflight.ts src/suite-command.ts test/test-preflight.test.js test/suite-command.test.js
  git commit -m "feat(suite): flag dynamic assertions with patterns and baseline"
  ```

---

### Task 6: 文档、示例与全量验证

**Files:**
- Modify: `DESIGN.md`（新增 §13.228；§13.222/§13.227 交叉引用）
- Modify: `README.md`（`suite ui-semantics init`、`suite ui-parity`、`designCrop`、`--fail-on-dynamic`、baseline）
- Modify: `AGENTS.md`（suite CLI 行与 design_device_diff 行）
- Create: `docs/ui-semantics.md`（通用 schema、角色、坐标空间表、draft/确认、示例、owner 维护流程）
- Test: 全量

- [ ] **Step 1: 写文档**

  - `docs/ui-semantics.md` **开头**放 Coordinate Spaces 表（design-source/cropped-design/device-viewport/device-content/visual-text/output-regions；各字段锚点、受 crop/缩放影响、校验阶段）。
  - 表格区分 `isDynamic`（布尔）、`dynamicAssets`（像素可变但不忽略）、`dynamicExamples`（样例列表）、`dynamicPatterns`（格式正则，≤200）、`taxonomy`（分类树）、`expectedAssets`；`deviceBbox` 声明“仅对记录 viewport 有效”；无 `designBbox` 的动态 region 不会自动忽略，会 warning。
  - **draft 流程**：`suite ui-semantics init` → owner 填 invariant/region/taxonomy/pattern → 移除 `draft`/确认；draft/空屏只会 `no-invariants`，不会假绿。
  - **两条 lane**：内容空间做分类树/文本/IA（AX 全量树，覆盖屏外）；视口空间做截断/资产/像素（截图/OCR，按屏覆盖）。明确 `visible/unverified/offscreen` 与 `insufficient-coverage`。
  - **分类树**：`飲料`/`餐點` group-header 非交互；`推薦` virtual 允许重复/双角色；后端叶子到设计顶层用 `aliases`/`categoryMap` 多对一。
  - **provenance**：`figma-explicit`/`figma-inferred`/`pen-vision`/`manual`；只有 explicit/high-confidence 进硬断言。
  - README：`suite ui-parity` trace/snapshot/visual-text 示例、`design_device_diff` 的 `designCrop`/`ui.ignoreDynamicRegions`/`ui.expectedAssets`、`check --fail-on-dynamic` 的 opt-in 与非穷尽声明。
  - **基线**：`ui-parity-baseline.json`（parity）与 `ui-dynamic-baseline.json`（check）的 key 口径、`--update-baseline`/`--update-dynamic-baseline` 显式更新（替换为当前快照）、只抑制已登记 key、不自动后台清理；两个文件默认分离，避免互相覆盖。
  - DESIGN §13.228：记录原因（动态数据/分类树被拍平/视觉截断/IA/视口/维护成本）、实现边界（不自动判断 API/页面、不替代 owner；Phase 1 的视觉文本来自 snapshot/人工标注，OCR adapter 排 Phase 1.5）、fail-closed 粒度（文件级 null）与错误定位。
  - AGENTS：命令表补 `ui-semantics init`/`ui-parity`，`design_device_diff` 行补 `designCrop`/`ui`；注明 `ui-parity` 单屏只给部分覆盖，全屏需滚动/拼接。
- [ ] **Step 2: 噪声基线与 rollout 文档**

  - 文档写明：`--fail-on-dynamic` 进 CI 前先用默认 warn 跑全部存量项目，记录命中分布；再 `--update-dynamic-baseline` 固化历史，只对新命中开严格闸门。
  - `suite ui-parity` 同理：先无基线跑一遍，owner 审阅后 `--update-baseline`；新 IA/截断错误才阻断。
  - **首个真实 fixture**：用原版 Figma 节点（如 375×2088 的 `Mobile ordering-Landing page`）seed 17 项分类树 + group headers + `選擇門市`/`選擇取餐時間` + section header + 底部 tab；真实 verdict 期望 `ia-mismatch`（alias 归一后 4 缺失/6 多余；纯字面是 8/18），不是 `truncated-labels`；合成中缀用例保留。
  - 说明像素忽略盲区：动态 region 内稳定子元素的样式由文本 parity invariant 兜底；像素绿 ≠ 结构绿。Hero/商品图必须有 presence 检查，否则空白/fallback 会被 `dynamicAssets` 吞掉。
  - 说明设计 chrome：`Flow/Header`/`Flow/Remarks`/状态栏不是 App UI；`designCrop` 按 section 裁。
- [ ] **Step 3: 全量验证**

  ```bash
  npm run build
  npm test
  npm run lint
  git diff --check
  ```
  预期：全量绿；lint 仅允许既有 warning；无设备/网络依赖。
- [ ] **Step 4: 提交**

  ```bash
  git add DESIGN.md README.md AGENTS.md docs/ui-semantics.md
  git commit -m "docs: document ui semantic parity workflow"
  ```

---

## Rollout / Non-goals

- **Phase 1（本计划）**：语义文件/schema（taxonomy tree、group-header、allowedRoles、expectedAssets）+ draft 脚手架 + parity 审计（分类树/中缀截断/零 invariant/半屏 coverage/双向 IA/role occurrence/资产 presence）+ CLI/基线 + 设计裁剪 + 动态断言模式/基线。存量项目不建语义文件时行为不变。
- **Phase 1.5**：semantics↔contract/Figma 对账 lint（屏集/分类/文本自动派生候选，owner confirm）；`ui-semantics init --figma` 从节点树 seed draft；OCR adapter（把截图文本变成 `source:"visual"`，Phase 1 先用手工 snapshot）；UI parity 基线纳入 CI；面板展示 parity 报告。
- **Phase 2（后续）**：生成期在 `figma_generate_tests` 中直接用 semantics 抑制动态断言（当前策略是 check 告警）；从设计节点/截图自动 propose region 与角色（仍需 owner confirm）；资产级差异（SKU 图片/URL）对比。
- **Non-goals**：不自动改 app 代码、不自动判断 API 是否存在、不自动修复分类截断、不把没有语义文件的旧项目判失败、Phase 1 不做 OCR/视觉角色推断（视觉文本由 snapshot/人工提供）。
- **推荐执行顺序**：Task 1 → 1b → 2 → 3（先得到可用诊断）→ 4（对比口径）→ 5（CI 告警 + 增量基线）→ 6（文档）。菜单列表案例作为首个真实 fixture：内容空间期望 `ia-mismatch`，视口空间再补 `truncated-label` 证据；只做 1–3 即可得到诊断，4 解决视口/资产，5 作为后续闸门。
