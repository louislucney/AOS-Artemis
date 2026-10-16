# 设计×真机「细节核验（区域核验）」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `design_device_diff` 增加「区域核验」——区域提议 → 设备原生栅格成对裁剪 → 1:1 局部判定 → 对图输出与工作流契约，根治「整屏缩略对比漏细节」。

**Architecture:** 新增 `src/diff/detail.ts` 纯函数模块（提议/几何/局部判定/对图合成），`src/diff/tool.ts` 接线双源与报告；`pen-source`（`--export-scale`）与 `device-source`（lossless 标记）小改；工具描述与文档同步。测试全部程序化合成图像，不依赖设备/网络。

**Tech Stack:** TypeScript（ESM/NodeNext/strict）、pngjs、node:test（测试跑 `dist/`，改动先 build）。

**Spec:** `docs/superpowers/specs/2026-10-16-design-device-detail-verification-design.md`（决策 D1–D12）。实验证据在 `.artemis/design/zoom-exp/`（本机、gitignored）——测试以代码合成复刻四类差异，**不依赖该目录**。

## Global Constraints

- 每任务收尾：`npm run build` 后跑该任务测试全绿；最终全量 `npm run build && npm test && npm run lint` 全绿。
- 测试不依赖真实设备/网络/PG：Figma 走 `stubFigmaFetch`，设备走 `stubDevice` / deps 注入（`capturePng`/`captureIosPng`/`exec`/`ensure`）。
- ESM+NodeNext+strict；相对导入带 `.js`；代码默认不加注释（解释非显然契约的 JSDoc 例外）。
- 输出 **additive**；`regions:"none"` 严格回到旧契约（报告键列表与响应图片数不变）；整屏通道零回归（源/参数/阈值/产物名都不动）。
- 常量（spec 钉死）：细节档 `pixelThreshold 0.05 / minAreaRatio 0.0005 / clusterGap 4`；降级档 `pixelThreshold 0.1`；`zoom` 默认 2（1–4）；`returnCrops` 默认 8；`maxRegions` 默认 20（沿用 `diff.maxRegions` 如已给）；对图单侧 ≤640px、总高 ≤1200px、gap 24px；区域 padding 16 / mergeGap 12 / tile 768 / tileOverlap 128（均为细节渲染 px，模块常量）；越界可见性下限单边 ≥4px。
- 文案中文；标识符英文；不改 vendor。

## Review Focus（spec 隐含、最可能咬人的输入类；测试已归入各任务）

1. **视口外/滚动屏幕**：区域越界应截断记账（`out-of-bounds` 计数）而非崩溃或空图 —— Task 2 单测 + Task 5 工具级。
2. **跨倍率**（Figma 2x/3x、Android 2.75x、pen 1x 兜底）：裁剪位置必须正确、降级如实标注、不得整体偏移 —— Task 2/3/5。
3. **降级源**（JPEG 回退、设计上采样）：阈值切 0.1＋warning；细线类按文档预期漏报（行为锁定断言）—— Task 3/5。
4. **区域数超限**：不丢 diff 命中与小细节（小面积优先）、`truncated` 标记、内联按 hasDiff 优先 —— Task 1/5。
5. **旧契约逃生门**：`regions:"none"`/`save:false`/`dryRun` 与旧版逐项一致 —— Task 5。

---

### Task 1: 区域提议（纯函数）

**Files:**
- Create: `src/diff/detail.ts`
- Test: `test/diff-detail.test.js`

**Interfaces:**
- Consumes: `Bbox`、`DesignNode`（`../dist/diff/engine.js` 类型）
- Produces（Task 5 依赖，名称/类型钉死）:

```ts
export type DetailRegionSource = "node" | "diff" | "tile" | "manual";
export interface DetailRegion { idx: number; source: DetailRegionSource; bbox: Bbox; name?: string; }
export interface ProposeRegionsInput {
  designWidth: number; designHeight: number;
  nodes: DesignNode[];        // 已换算到细节渲染 px
  screenRegionBboxes: Bbox[]; // 已换算到细节渲染 px
  mode: "auto" | "nodes" | "tiles" | "none" | Bbox[];
  maxRegions: number;
  padding?: number; mergeGap?: number; tileSize?: number; tileOverlap?: number;
}
export interface ProposeRegionsResult { regions: DetailRegion[]; truncated: boolean; tilesUsed: boolean; }
export function proposeDetailRegions(input: ProposeRegionsInput): ProposeRegionsResult;
export function scaleDetailNodes(nodes: DesignNode[], factor: number): DesignNode[];
```

- [ ] **Step 1: 写失败测试**（`test/diff-detail.test.js`；用 `createImage`/`fillRect` 不用图像文件）。用例：
  1. `nodes 过滤与 padding/合并`：构造屏幕 390×844 细节坐标；节点含整屏背景（390×844，深 0）、细线（宽 300 高 3）、文本（100×20）；断言背景被剔除、细线保留、输出 bbox = 节点 bbox 外扩 16px；两个相距 8px 的节点被合并为一个区域。
  2. `截断优先级`：2 个 diff 命中（面积大）＋4 个节点（面积 2000/1000/500/100，maxRegions=3）→ 输出恰为 2 diff + 面积 100 的节点（小面积优先）；`truncated === true`。
  3. `tiles 重叠`：mode:"tiles"，design 1600×1600、tileSize 768 / overlap 128；把 3px 特征放在 x=760..765 接缝 → 存在一个 tile 完整包含它（`tile.x < 760 && tile.x + tile.width > 765`）；`tilesUsed === true`。
  4. `auto 分支`：nodes 非空 → nodes∪diff、`tilesUsed=false`；nodes 空 → tiles∪diff、`tilesUsed=true`。
  5. `manual`：`mode=[{x,y,width,height}]` → 原样转 region（source "manual"，按 y,x 排序、idx 从 1 递增）；数量 > maxRegions → 截断 + `truncated`。
  6. `确定性`：同输入两次 `deepEqual`；叶子口径——无更深节点与自身重叠 ≥90% 者视为叶子（构造父容器含子节点 → 父被剔除）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/diff-detail.test.js`（期望：模块/导出缺失）。
- [ ] **Step 3: 实现**（`src/diff/detail.ts`）：常量 `DEFAULT_PADDING=16`、`DEFAULT_MERGE_GAP=12`、`DEFAULT_TILE_SIZE=768`、`DEFAULT_TILE_OVERLAP=128`；叶子口径＝「无更深（depth 更大）节点与其重叠面积 ≥ 90% 自身面积」；排除零面积与面积 ≥95% 屏者；合并＝按 (y,x) 排序后贪心，间隙 ≤ mergeGap 者并集；截断＝diff 优先、其后面积升序；最终按 (y,x) 稳定排序、idx 1..N。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(diff): detail region proposal (nodes/diff/tiles with overlap, detail-first truncation)"`

---

### Task 2: 几何映射与原生栅格裁剪

**Files:**
- Modify: `src/diff/detail.ts`
- Test: `test/diff-detail.test.js`（追加）

**Interfaces:**
- Produces:

```ts
export interface DetailGeometry { ratio: number; offset: { x: number; y: number }; }
export function resolveDetailGeometry(
  designSize: { width: number; height: number },
  deviceSize: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number }
): DetailGeometry;   // ratio = (deviceW-left-right)/designW；offset = {x:left, y:top}
export interface DetailPairExtraction {
  design: RgbaImage; device: RgbaImage;
  upscaled: boolean;        // 设计裁剪被升采样到设备栅格
  designDownscaled: boolean; // 设计裁剪被>2%降采样（异常，标注）
  clipped: boolean;          // 区域越界被截断
}
export function extractDetailPair(input: {
  design: RgbaImage; device: RgbaImage; region: Bbox; geometry: DetailGeometry; minVisiblePx?: number;
}): DetailPairExtraction | null;  // null = 越界不可见（调用方记 out-of-bounds）
```

- [ ] **Step 1: 写失败测试**。用例：
  1. `几何`：design 390×844、device 1170×2532、insets {top:100} → ratio=3；区域 (40,80,120,60) → device 映射 (120,340,360,180)；1:1 等宽时 ratio=1。
  2. `越界截断`：区域部分越出右下 → `clipped=true`、device 裁剪被钳制到边界、裁剪尺寸与钳制后一致；越出后单边 <4px → 返回 null。
  3. `尺寸对齐`：design 裁剪 300×200、device 裁剪 600×400 → 输出两侧均 600×400 且 `upscaled=true`（升采样）；反向（design 大于 device >2%）→ `designDownscaled=true`；|比率-1|≤2%（如 601 vs 600）→ 两者皆 false。
  4. `像素保真`：构造左右半色图案，断言裁剪内容位置正确（抽样像素），排除整体偏移。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：`cropImage`（本地私有，参照引擎 `cropInsets` 写法）；对齐用引擎导出的 `resize`（`../diff/engine.js`）；采样定义：目标尺寸与源差 ≤2% 时直接使用（不重采样）否则 resize。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(diff): detail geometry mapping and native-grid pair extraction"`

---

### Task 3: 局部判定与对图合成

**Files:**
- Modify: `src/diff/detail.ts`
- Test: `test/diff-detail.test.js`（追加）

**Interfaces:**
- Produces:

```ts
export interface DetailLocalSummary {
  hasDiff: boolean;
  clusters: Array<{ bbox: Bbox; severity: string; pixelDiffRatio: number }>;
  pixels: number;   // Σ round(簇面积 × pixelDiffRatio)
}
export function runDetailDiff(
  design: RgbaImage, device: RgbaImage,
  options?: { degraded?: boolean; thresholds?: { pixelThreshold?: number; minAreaRatio?: number; clusterGap?: number } }
): DetailLocalSummary;
export function composeDetailPair(
  device: RgbaImage, design: RgbaImage,
  options?: { zoom?: number; maxSide?: number; maxHeight?: number; gap?: number }
): { png: Buffer; width: number; height: number; scale: number };
```

- [ ] **Step 1: 写失败测试**。代码合成复刻实验四类（白底卡片区 + 深色内容）：
  1. `四类命中（细节档）`：字重加粗（文字块外扩 1px 涂深）／元素缺失（擦除 20×30 灰色块）／位置偏移（块平移 10px）／细线缺失（擦除 3px 灰线 10 段）→ 四个独立 crop 对 `runDetailDiff` 全部 `hasDiff=true`；同图无注入 → `hasDiff=false`。
  2. `降级档行为锁定`：degraded:true 下细线用例 **不命中**（0.1 阈值，文档化预期）；加粗用例仍命中。
  3. `不降采样`：700px 宽 crop 对 → 检出正确（`maxEdge` 视为 ≥ crop 尺寸）；簇 bbox 位于裁剪坐标系内。
  4. `composeDetailPair`：输出宽=device+gap+design、device 在左（抽样像素断言左侧来自 device）；zoom 钳制（构造 800 宽 crop × zoom2 → 单侧缩至 640）；高度 >1200 时同钳制；返回 `scale` 正确；两次调用输出逐字节一致。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：`runDetailDiff` 包装引擎 `diffScreens(design, device, { pixelThreshold: degraded?0.1:0.05, minAreaRatio:0.0005, clusterGap:4, maxEdge: Math.max(宽,高), designNodes: [] })`，把 `regions[]` 映射为 clusters（D5「拆子块」以等价机制落地：**局部判定把引擎 `maxEdge` 提升至 crop 尺寸、factor=1 直判**——不降采样语义不变、无需拆分与归并；大区域成本由 `maxRegions` 与区域合并约束）；`composeDetailPair` 用引擎 `resize` + `encodePng`，gap 纯白。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(diff): detail local diff (native grid) and paired crop composition"`

---

### Task 4: 保真源支撑（pen scale 渲染 + 设备 lossless 标记）

**Files:**
- Modify: `src/diff/pen-source.ts`、`src/diff/device-source.ts`
- Test: `test/diff-pen-source.test.js`（扩展；该文件已有 `--export-scale` 断言模式）、`test/device-screenshot.test.js`（扩展）、`test/ios-screenshot.test.js`（如需）

**Interfaces:**
- Produces:
  - `renderPenDesign(runtime, options: PenRenderOptions & { scale?: number })`：scale 透传 `runPenExport`（缺省 1=现行为）；返回 `PenRender` 增 `renderScale: number`；**返回的 `nodes` 坐标 = scale × 几何**（屏幕趟缺省仍 1，零回归）。
  - `DeviceCapture` 增 `lossless?: boolean`：`captureLiveScreenshot` 中 adb PNG/wda/simctl → `true`；artemis JPEG 默认路径与无损失败回退 → `false`；`captureStepScreenshot` 不设。

- [ ] **Step 1: 写失败测试**：
  - pen：`renderPenDesign({ scale: 3 })` → exec 收到 `--export-scale 3`；返回 nodes 坐标 3×（对齐渲染图）；缺省调用仍 `--export-scale 1`（保持既有断言）。
  - device：android 默认 → `lossless:false`；`lossless:true` + `capturePng` 成功 → `true`；`capturePng` 失败回退 → `false`；ios 模拟器桩路径 → `true`。既有 deepEqual 断言如受新字段影响 → 同步更新（改断言语义，不加条件分支）。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/diff-pen-source.test.js`、`test/device-screenshot.test.js`。
- [ ] **Step 3: 实现**（两文件小改）。
- [ ] **Step 4: 跑测试确认通过** + build。
- [ ] **Step 5: 提交**：`git commit -m "feat(diff): high-fidelity detail sources (pen export scale, device lossless flag)"`

---

### Task 5: 工具接线（`design_device_diff` 区域核验）

**Files:**
- Modify: `src/diff/tool.ts`、`src/tools/native-tools/design.ts`（zod schema）
- Test: Create `test/diff-detail-tool.test.js`；Update `test/design-device-diff.test.js`（键列表/content 长度断言）

**Interfaces:**
- Consumes: Task 1–4 全部导出（见各任务 Interfaces）。
- Produces（报告与响应 additive；仅当 `regions !== "none"`）：

```ts
// args 增（zod 与 handler 同步）
regions?: "auto" | "nodes" | "tiles" | "none" | Bbox[];  // 默认 "auto"
zoom?: number;          // 1..4，默认 2
returnCrops?: number;   // 0..maxRegions，默认 8；0=不内联
detail?: { pixelThreshold?: number; minAreaRatio?: number; clusterGap?: number };
// 报告（置于 summary 之后、elapsedMs 之前）与响应 text 同步新增：
detail: { enabled: true; zoom: number; returned: number; regionCount: number; tilesUsed: boolean; truncated: boolean; degraded: boolean };
regionDetails: Array<{
  idx: number; source: DetailRegionSource; bbox: Bbox; name?: string;
  localSummary: DetailLocalSummary; crops?: { pair: string };  // 相对产物目录；save:false 省略
}>;
```

数据流（钉死，实现按此）：
- `regions==="none"` → 全跳过：不取二次源、报告/响应无 `detail`/`regionDetails`、content 长度 2。
- 细节设计源（Figma）：`S = clamp(round(设备裁剪宽 / 根节点宽 * 100)/100, 1, 4)`；`S>1.02` 用 `fetchFigmaRenderPng(url, nodeId, S)` 另取（失败 → 复用屏幕趟渲染并置 `designUpscaled=true`）；否则复用屏幕趟渲染。
- 细节设计源（pen）：同式 S（分母 = 屏幕趟渲染图宽）；`S>1.02` 时 `renderPenDesign({ scale: S, renderOut: '<configDir>/design/pen/<name>.detail.png' })`（失败 → 复用+`designUpscaled`）。
- 细节设备源：step → 复用；ios → 复用（本身无损）；android live 且屏幕趟非无损 → 再次 `captureLiveScreenshot(runtime, serial, { lossless: true, capturePng, captureIosPng })`；`deviceLossless = 新 capture.lossless === true`。
- 降级：`degraded = (deviceLossless === false) || designUpscaled`；阈值档 = degraded?0.1:0.05；warning `lossy-source` / `design-upscaled` 各按条件添加。
- 提议输入：nodes=`scaleDetailNodes(屏幕趟 designNodes, S)`；空（拉取失败或为空）→ auto 走 tiles∪diff 分支；`screenRegionBboxes = diffResult.regions.map(r => 缩放 r.bbox × S)`。
- 逐区域：`extractDetailPair`（null → `out-of-bounds` 计数）→ `runDetailDiff` → `composeDetailPair` → 保存 `regions/<idx>-<slug>.png`（slug=节点名/`r<idx>` 转写）。
- 内联：hasDiff 优先（severity 等级序 blocker>major>minor>info，同级面积降序），取前 `returnCrops`；`content = [text, annotated, ...pairs]`。
- 截断 warning `detail-truncated`；越界聚合 warning `out-of-bounds`（含计数）。
- `dryRun` 语义不变；`save:false` 不写盘（crops 路径省略、内联照常）。

- [ ] **Step 1: 写失败测试 5a（基础路径）**：`test/diff-detail-tool.test.js`——Figma×live 默认 auto：设计 390×844（根 390）、device 390×844（S=1 复用渲染）、`deps.capturePng` 成功桩（无损）；断言 `payload.detail{enabled,regionCount≥1,degraded:false}`、`regionDetails[0].localSummary` 形状、`content.length === 2 + 内联数`、`saved.dir/regions/` 有对图文件、报告键列表（含新两键、位于 summary 与 elapsedMs 之间）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现接线**（上述数据流；同时补 zod schema）。
- [ ] **Step 4: 更新既有测试**：`test/design-device-diff.test.js` 默认调用 → 断言新形状（content 长度、键列表、`warnings` 为空需注入无损桩避免降级）；新增 `regions:"none"` 用例断言旧键列表与 content 长度 2。跑绿。
- [ ] **Step 5: 写失败测试 5b（降级/截断/tiles）**：
  - 降级：capturePng 失败桩 → `detail.degraded=true`、warnings 含 `lossy-source`；细线用例在降级档不命中（复用 Task 3 合成）。
  - 截断：`diff.maxRegions` 2 且节点多 → `truncated=true`、保留 diff 命中与最小节点。
  - tiles：Figma nodes 404（stub options 使 nodes 拉取失败）→ `tilesUsed=true`、仍有区域、warnings 含节点几何降级文案（沿用既有 `nodeWarning`）。
- [ ] **Step 6: 跑测试确认失败 → 实现 → 通过。**
- [ ] **Step 7: 写失败测试 5c（分页/逃生门）**：
  - 分页：首轮取 `regionDetails[].bbox` → 二调 `regions: bboxList` → `regionDetails[].bbox` 与入参逐一相等（source "manual"、顺序按 y,x）。
  - `save:false`：无盘上文件、`crops` 省略、内联仍在；`dryRun` 与旧断言一致。
- [ ] **Step 8: 跑测试确认失败 → 实现 → 通过**；再跑 `npm run test:file -- test/design-device-diff.test.js test/diff-detail.test.js test/diff-engine.test.js` 不回归 + build。
- [ ] **Step 9: 提交**：`git commit -m "feat(diff): region-scale verification in design_device_diff (proposal → crops → local verdicts)"`

---

### Task 6: 描述、文档与全量回归

**Files:**
- Modify: `src/tools/native-tools/design.ts`（描述文案）、`README.md`、`DESIGN.md`（新增 §13.118）、`AGENTS.md`（设计流水线段落补一句）
- Test: 无新测试（文案）；全量回归

**要点（写入文案与文档）：**
- `design_device_diff` 描述：新增区域核验段（区域提议三种来源、成对放大图、1:1 细节档、降级档语义、`regions:"none"` 逃生门、分页姿势＝回传 `regionDetails[].bbox` 走 `regions: Bbox[]`）；**iOS 口径修正**——列明真机 WDA PNG/模拟器 idb→simctl（去掉"仅 macOS 模拟器"）。
- `compare_design_and_device` 描述：加一行「细节核验（逐区域放大对图）走 `design_device_diff` 区域核验」+ iOS 口径同修。
- 工作流契约（D9 原文）：对比结论必须来自区域级对图核对（引用区域编号）；整屏图仅用于定位；报告＝区域 → 类型 → 期望 vs 实际。
- **跨源验证状态（D12）**：README/DESIGN 如实标注「区域核验在无渲染差异源下已实证；跨源细节档验证中（需真实项目对跑基线）」——未完成前不得宣称跨源细节可用；基线达标后另行更新口径。
- README：工具参数与分页示例、平台保真分等简表（D6 摘要）。
- DESIGN §13.118：实施记录（决策 D1–D12 落地摘要、测试数、口径）。

- [ ] **Step 1: 文案与文档编辑**（按上述要点）。
- [ ] **Step 2: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录测试总数增量）。
- [ ] **Step 3: 提交**：`git commit -m "docs: region-scale verification — tool descriptions, README, DESIGN §13.118"`

---

## Self-Review 记录（写稿人自查）

- **Spec 覆盖**：区域提议 D2/D3、几何 D1/D5、局部判定 D5、对图 D4/D7、双源 D6/D11、默认与逃生门 D8、纪律契约 D9、跨源验收 D12（§7 测试口径含"跨源基线"——本计划将其列为实施后**放行验证项**：需真实项目对，不在自动化测试内；实施任务不含）。`truncated`/`out-of-bounds`/`lossy-source`/`design-upscaled` warnings 均落 Task 5。
- **类型一致性**：`DetailRegionSource`/`DetailRegion`/`DetailLocalSummary`/`DetailGeometry` 跨任务引用同名；`crops.pair` 相对路径语义一致。
- **比例**：6 任务、测试以行为断言为主，无整段实现转写。
- **遗留给执行者的细节**：`regions/` 保存与失败回滚沿用现有事务写法；slug 转写沿用 `diffSlug` 风格；tiles 网格起点 (0,0)、步长 `tileSize - tileOverlap`；降级档的实际阈值写入 `detail.thresholds`?（不写，`degraded` 布尔已足）。
