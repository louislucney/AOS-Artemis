# 设计×真机「细节核验（放大核验）」设计 —— 区域级原生分辨率对比

> 2026-10-16 · 前置：D1（design_device_diff 票据 01–07）已落地。本设计解决两个缺口：「细节级差异检出」与「多模态整屏对比看漏」。
> 状态：brainstorm 初稿（含受控实验证据）；builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

### 1.1 痛点（用户观察）

- 真机实现与设计稿常走样：**大出入**＋**细节缺失**（间距/字重/图标/细线/元素缺失），目前发现靠**人工看图**。
- 多模态对比（`compare_design_and_device` 给模型两张整图）在模型视觉预算下被压缩：小字号、1–4px 特征"糊掉"，判断滑向"大概相似"；历史会话出现过"补充细节后才发现"的漏看（"没怎么放大，以为它们是大概相似就做了标识"）。

**目标**：系统能像人眼（或更强）那样发现真机与设计的差异并说清差在哪——**大走样要报、细节也要报**；可靠路径内建为默认能力，不靠模型自觉。

### 1.2 受控实验证据（2026-10-16；`.artemis/design/zoom-exp/`，可复跑）

同一对图（真实 iOS 截图 + 4 处已知注入细节差异：字重加粗／chevron 缺失／开关偏移 10px／分割线缺失）：

| 方式 | 检出 | 说明 |
|------|:---:|------|
| 整屏 diff · 默认参数 | **0/4** | maxEdge 降采样（0.55×）＋ pixelThreshold 0.1 ＋ minAreaRatio 0.005（本实验图上≈**42×42pt 见方**以下一律不报）三重盲区叠加 |
| 整屏 diff · 调敏感参数 | 2/4＋噪声 | 报出 20–52 个区域、多数为噪声；小元素/细线仍不可见 → **调参不可行** |
| **区域放大 diff**（原生分辨率） | **4/4** | 同几处差异，裁到区域即全部命中（细线需 threshold≈0.05） |
| 盲测：不知真值的模型找差异 | 4/4（但非"肉眼"） | 成功方式＝自写逐像素差分＋放大复核＋同类对照 → **「机算＋放大复核」是可靠路径，应内建** |

结论：**可靠性不取决于模型的认真程度，取决于对比发生在哪个尺度。**

### 1.3 现有机制盘点

- `compare_design_and_device`（`src/tools/composite.ts`）：拉设计渲染＋真机截图 → 两张整图给多模态；无区域、无放大。
- `design_device_diff`（`src/diff/tool.ts`）：整屏确定性 diff（工作尺度降采样、节点几何分类 missing/extra/text/asset/position-size/color、screen_map 定位、severity、标注图与产物目录）；**无区域级裁剪/放大**；Figma 渲染 scale=1。
- 设备源：live（Android JPEG 默认/无损可选；iOS 模拟器 idb→simctl；真机 WDA）与 step（trace 截图，作失败复核入口）。

## 2. 范围（v1）

**增强 `design_device_diff`：新增「区域核验」（region-scale verification）**——在既有整屏判定之外，增加：区域提议 → 原生分辨率成对裁剪放大 → 局部 1:1 判定与对图输出；并把"逐区核对"写进工作流契约。

1. **区域提议**：`auto`＝设计叶子节点区域 ∪ 整屏 diff 命中区域（节点主导、diff 补充）；无节点源时 tiles 平铺兜底；支持显式区域。
2. **区域裁剪**：从**原生分辨率**设计渲染（区域模式 scale≥2）与设备截图（无损优先）按对齐映射裁剪，输出 device｜design 并排**对图**（zoom 默认 2×，尺寸对齐模型视觉预算）。
3. **局部判定**：小图在 **1:1** 下跑同一引擎（细节档参数）；产物与报告 additive 扩展；响应内联前 K 张对图。
4. **工作流纪律**：工具描述/文档写入核对协议（结论引用区域证据；整屏图仅定位）。
5. **与 compare 的关系**：不改其行为；描述中指引"细节核验走 design_device_diff"。

**术语**：*区域核验*＝对提议的屏幕局部区域，在原生分辨率下成对裁剪、放大、局部判定；*对图*＝同一区域的 `device｜design` 并排图。

## 3. 非目标（本票不做）

- 流水线自动化（suite run 自动比对/报告/Jira 联路）→ 后续票（本票纯能力＋工作流）。
- 大走样对齐增强（滚动错位、异形屏、整体结构错位）→ 另立。
- 文本内容精确比对（OCR／文本差分）→ 后续（可复用 elements/screen_map 机制）。
- LLM 自动写差异描述／自动评鉴 → 后续（现在由 agent/人看对图）。
- 全局默认参数变更——整屏既有字段与判定**零回归**。
- iOS 真机截图无损链路如已有缺口 → 记录，不在本票扩。

## 4. 硬约束

- 测试不依赖真实设备/网络；沿用既有 deps 注入模式；合成图 fixtures 可复现实验四类差异。
- 全部输出 **additive**（旧字段语义不变）；`save:false` 语义保持；`dryRun` 维持既有语义（仅计划不取图；区域提议依赖设计节点，不做离线预估）。
- **裁剪源必须是原生分辨率原图**；任何降级（JPEG 回退、trace 截图保真度）显式 warning（沿用既有风格）。
- ESM＋NodeNext＋strict；中文文档（DESIGN/README 同步）。

## 5. 关键决策（本次方案判断；可被否决/修订）

- **D1 两级对比**：整屏（保留现状，粗定位）＋区域（新增，细核）。区域局部判定的「1:1」＝**以设备原生栅格为公共网格**：设计侧经更高 scale 渲染（Figma REST 支持 0.01–4 小数 scale，向设备倍率对齐）或上采样对齐到设备栅格，**任一侧都不下采样**（向设备栅格的等采样/上采样允许；显示放大另算）。pen 渲染低于设备栅格时上采样＋`design-upscaled` 标注。这是能力成立的前提；引擎整屏通道的既有换算（设备重采样到设计宽度）只属于整屏通道，不用于区域判定。
- **D2 区域提议不能依赖整屏 diff**（实验已证细节在整屏不可见）：`auto`＝节点 ∪ diff；`nodes`＝仅节点；`tiles`＝固定网格；显式 `Bbox[]` 覆盖一切。节点提议覆盖"设计有、真机缺/变"；diff 提议覆盖"节点外差异"；tiles 兜底"无节点源"场景。
- **D3 区域几何与覆盖口径**：叶子节点 bounds 外扩 padding（默认 8 设计 px）；相邻 ≤gap 合并；上限 `maxRegions`（默认 20）。**叶子口径＝内容型节点优先、小细节不得被过滤**：排除整屏背景（面积 ≥95% 屏的底层）与零面积/不可见项，**保留细线/小图形类填充节点**（如 2px 分隔线）。**超限截断优先级＝diff 命中 ＞ 小面积 ＞ 大面积**（本能力面向细节；大差异由整屏通道兜底），截断置 `detail.truncated=true`＋warning；合并策略尽量让每个叶子节点被某区域覆盖。合并启发式细节留计划。
- **D4 对图形态**：device 左｜design 右、同尺寸相邻；zoom 默认 2×（1–4）；目标：**单张 ≲1MP**、2× 下原分辨率可读（细字号 ≥20px 字高）；超预算区域按需缩至预算（纯展示）或分块输出。**展示缩放不影响判定**（判定走 D5 分块 1:1）。布局/分块细节留计划。
- **D5 局部判定（细节档参数）**：在设备栅格上 1:1 判定（crop 对进引擎，factor=1）；区域超出 `maxEdge` 时**拆子块逐一判定、结果归并到区域级**（不降采样）。默认 `pixelThreshold 0.05`、`minAreaRatio 0.0005`、`clusterGap 4`；**有损源（JPEG/压缩迹）区域 → 阈值回退 0.1＋`lossy-source` warning**；参数可经 `detail` 覆盖。每区域输出 `localSummary{hasDiff, clusters[], pixels}`（子块簇已归并）；映射越出设备图边界的部分截断＋`out-of-bounds` warning（不造空图）。
- **D6 源保真（区域通道独立双源）**：**整屏通道维持现状**（源/参数/降采样/字段不变，零回归）；区域通道独立取材：Figma render 按设备倍率取 scale（≥2；同轮区域间复用同一张贴图，REST 缓存 TTL 内重复调用可控）；pen 复用现有渲染（低栅格上采样＋标注）；设备侧 live 默认请求无损（Android adb PNG／iOS idb→simctl PNG），失败回退 JPEG＋warning，用户显式 `lossless:false` 时尊重并标注；step 模式用 trace 原图（保真随执行器，warning 注明）。代价：默认开启时每次调用约 **＋1 次 Figma 渲染＋1 次设备抓图**（可被缓存摊薄）。
- **D7 接口（草案）**：`design_device_diff` 新增参数 `regions` / `zoom` / `returnCrops` / `only` / `detail`；报告新增**独立** `regionDetails[]`（**不动既有 `regions[]` 语义**）＋ `detail` 元信息；落盘 `regions/<idx>-<slug>.png`；响应内联前 K 对图。
- **D8 默认开启**：区域核验默认 `auto` 开启（痛点即"默认漏细节"）；`regions:"none"` 恢复纯整屏行为（escape hatch）。内联张数/尺寸控制模型预算。
- **D9 工作流契约**：工具描述＋报告 `howTo`＋README/DESIGN 写入："对比结论必须来自区域级对图核对（引用区域编号）；整屏图仅用于定位；报告格式＝区域 → 类型 → 期望 vs 实际"。`compare_design_and_device` 描述加一行指引。
- **D10 命名与模块**：能力名「区域核验」；实现落点建议 `src/diff/detail.ts`（提议/裁剪/局部判定）＋ `tool.ts` 接线（细节留计划）。
- **D11 双通道隔离（零回归边界）**：D6 的独立双源意味着区域通道**不影响**整屏通道的源、工作尺度、阈值与产物 `design.png/device.png` 的既有口径（新增区域产物只落 `regions/`）；§3「零回归」按此严格执行。

## 6. 接口草案（细节留给计划）

```ts
// design_device_diff：参数 additive 扩展
regions?: "auto" | "nodes" | "tiles" | "none" | Bbox[]  // 默认 "auto"
zoom?: number          // 1–4，默认 2
returnCrops?: number   // 默认 8；0 = 不内联（仅落盘）
only?: number[]        // 只核验指定区域序号（分页轮次；与 auto 提议结果按 idx 对齐）
detail?: { pixelThreshold?: number; minAreaRatio?: number; clusterGap?: number }  // 局部档覆盖

// 报告：additive 扩展（schemaVersion 不变，只加字段）
detail: { enabled, zoom, returned, regionCount, tilesUsed?, truncated? }
regionDetails: [{
  idx, source: "node" | "diff" | "tile" | "manual", bbox, name?,
  localSummary: { hasDiff, clusters: [...], pixels },
  crops: { pair, device?, design? }   // 相对 diff 产物目录
}]
```

产物目录（沿用既有）：`<configDir>/design/diffs/<slug>-<stamp>/`，新增 `regions/` 子目录；`report.json` 同步扩展。

## 7. 测试口径（具体用例随计划）

- **合成受控变异 fixtures**（复刻实验四类：字重加粗／元素缺失／位置偏移／细线缺失；小尺寸去敏裁剪可入 test/fixtures）：区域核验 **4/4** 检出；整屏默认对四类保持原行为（不回归）。
- 无差异对照（含轻微重采样/噪声）：区域零误报（或低于阈值）；tiles 模式全覆盖断言。
- 细节档覆盖路径、JPEG 回退 warning、区域数截断 warning、`only` / `returnCrops` / `regions:"none"` 行为、dryRun 维持语义。
- 产物：对图文件存在、尺寸上限、report 扩展字段形状；既有 diff 测试全绿。
- 全量：`npm run build && npm test && npm run lint` 全绿。

## 8. 留给实现/计划的

- 区域合并启发式与去重细节；对图渲染（gap/序号标注/分块策略）细节；tiles 网格尺寸与上限；细节档参数精调；Figma scale=2 的成本/缓存权衡；区域模式下 `annotated.png` 是否叠加区域编号；性能上限（原图内存、区域数×裁剪耗时）。

## 9. builder-check 复核记录（2026-10-16）

独立复核（fresh subagent，读文档＋核对引擎源码与实验数据）提出 4 个 Important 级问题，逐条核实后**全部并入**（均为技术口径，按设计意图裁决，无遗留「用户裁决」项）：

1. **区域判定的公共网格**（Figma/pen/设备倍率几乎不相等；实验的 0.05 阈值只在零重采样下验证过）→ D1 修订：公共网格＝**设备原生栅格**；设计侧上采样/高 scale 对齐、**任一侧不下采样**；pen 低栅格上采样＋标注。
2. **整屏与区域是否共用高保真源**（与「零回归」承诺冲突）→ D6/D11 修订：**双通道隔离**——整屏原样零回归；区域独立取高保真源；代价 ≈ ＋1 渲染＋1 抓图/次（缓存摊薄）。
3. **叶子口径与截断优先级**（原优先级「面积大优先」会把目标小细节最先裁掉——复核发现的关键失误）→ D3 修订：小细节不得被过滤；**截断优先级＝diff 命中 ＞ 小面积 ＞ 大面积**＋`truncated` 标记。
4. **超 maxEdge 区域行为** → D5/D4 修订：判定**拆子块保 1:1、结果归并**；对图纯展示可缩至预算；越界截断＋`out-of-bounds` warning。
