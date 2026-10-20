# 字重检测设计（regular / medium / semibold / bold）

> 2026-10-20 · rev 2（已吸收评审：内容变化守卫、跨源可用性门槛、覆盖会计、量纲/暗色/字号/切片顺序）。
> 状态：设计稿，待评审；**未实施**。
> 关联：`2026-10-20-ui-interpretation-retro.md` P3.1、`2026-10-16-design-device-detail-verification-design.md`（区域核验与 D12 跨源基线）。

## 1. 问题

设计稿里同一段文字可能用 regular、medium、semibold、bold；真机实现可能统一用了 regular，或把 semibold 写成 bold。现有测试只验证流程/文案，`design_device_diff` 只能报“这个区域有像素差异”，不能回答“字重是不是变粗了”。需要在不依赖字体名/OCR 的前提下，给出**相对字重提示**，并明确哪些情况不可判。

## 2. 当前事实（代码核对）

- `.pen` 的文本节点有 `fontFamily` / `fontWeight` / `fontSize` / `content`，但很多节点没有显式几何；`ui-contract` 目前只做**整屏 token 汇总**（`src/ui/contract.ts`），没有文本节点级记录。
- 真机可访问性层级通常不暴露 `fontWeight`；iOS/Android 都只能从截图测量。
- `design_device_diff` 已有区域核验：文本区域可归为 `text` 类，`regionDetails` 输出设计/真机 1:1 双图；但没有字重指标。
- `screen-map.elements` 有设计文本 ↔ 观察标签的映射与**设计侧**归一化 bounds，没有真机 bbox；不能直接据此裁剪真机文本。
- `suite baseline` 是设备对设备比较，能避开跨平台字体差异；目前只用于整体/区域差异，没有字重分类。
- 跨源（设计渲染 × 真机渲染）噪声基线仍未验证（D12）；JPEG、`design-upscaled` 会降低细节可信度。

## 3. 目标与非目标

**目标**

- 对指定文本区域输出：`weightHint: lighter | similar | heavier`、`designWeight`、`confidence`、`sourceFormat`、`experimental`。
- 覆盖会计闭合：契约中每个文本节点都必须进入 `checked` 或 `unverified(reason)`，不允许静默消失。
- 同平台同设备 baseline 下可做字重回归门禁；设计×真机先只做提示（`experimental`）。
- 兼容 regular/medium/semibold/bold；medium↔regular 允许低置信。

**非目标**

- 不识别字体家族名（真机侧没有可靠来源）。
- 不做通用 OCR（除非后续单独立项）。
- 不在跨源噪声基线未验证前做硬门禁。
- 不要求所有文本节点都覆盖；覆盖不到标 `unverified`。

## 4. 设计

### 4.1 契约：文本节点级 token（全量收录，几何分态）

在 `ui-contract` 的屏幕下新增 `texts`。**所有文本节点都收录**，几何缺失不丢弃：

```json
{
  "id": "node-id",
  "content": "早安, Amy",
  "fontFamily": "SoDo Sans",
  "fontWeight": 600,
  "fontSize": 24,
  "bbox": { "x": 24, "y": 96, "width": 180, "height": 32 },
  "bboxSpace": "design-px",
  "geometryStatus": "extracted | partial | unverifiable",
  "render": ".artemis/design/screens/pen-untitled/LE6yl.png",
  "renderScale": 2
}
```

- 字重归一：`normal/regular=400`、`medium=500`、`semibold/semi-bold=600`、`bold=700`、`heavy=800`、`black=900`；数字原样保留。
- `geometryStatus: unverifiable` 的文本仍计入 `textsTotal`，后续计为 `unverified(no-geometry)`。
- `bbox` 为 `.pen` 设计坐标；裁 `render` PNG 时按 `renderScale` 换算（复用区域核验的设计侧裁剪口径）。
- 契约 fingerprint 覆盖 `.pen` 与 flows，设计变更可检测。

### 4.2 文本定位（v1）

真机侧目前没有文本 bbox。v1 提供两种来源，按可靠性排序：

1. **baseline 同平台**：沿用上次保存的文本区域 bbox（同一设备/同一屏），本次截图按同 bbox 裁剪；最可靠，适合回归。
2. **设计 bbox + 屏幕对齐**：用 `design_device_diff` 的 width-scale/top-align 把设计文本 bbox 映射到设备截图；只在该屏整体对齐误差低时使用，`confidence` 降级。

不做：OCR 定位、基于 LLM 的文本搜索。需要时另立“OCR/文本定位”票。

**内容/换行守卫（关键，v1 必须有机制）**：没有 OCR/真机 bbox 时，无法直接知道设备文本是否变了。用**投影形状**兜底，而不是原始 mask IoU——原始 mask IoU 会把 regular→bold 自己判成内容变化：

- 对齐后计算 row profile 相关系数；
- column profile 先做半径 4 的平滑再算相关系数（吸收笔画变宽造成的峰形变化）；
- 设备/设计 ink extent 宽高比；
- 任一项越界 → `unverified(content-or-wrap-mismatch)`，不进入字重比较：
  - `rowProfileCorrelation < 0.80`；
  - `smoothedColumnProfileCorrelation < 0.75`；
  - ink width/height ratio 不在 `0.70–1.40`（换行/截断通常超界）。
- 换行是窄屏常态：高度比超界直接 `unverified`，不能拿半截文本比字重。
- 有 `screen-map.elements` 命中时，可借观察标签核对内容；覆盖面窄，仅作增强，不作依赖。

定位失败（bbox 越界、对齐误差过大、文本内容/换行守卫失败）→ `unverified`，不硬判。

### 4.3 测量算法

对同一文本区域分别裁剪设计渲染与设备截图，统一到设备原生栅格（1:1），执行：

1. **极性感知二值化**：从 bbox 边缘估计背景亮度；背景暗则反转。默认“文字=ink”，但支持浅字深底；极性不确定时 `unverified`。
2. 计算：
   - `inkRatio = inkPixels / bboxArea`（尺度不变，不做线性 fontSize 除法）；
   - `meanRun = 每行连续 ink 游程的平均长度`，归一为 `meanRunNorm = meanRun / textPixelHeight`；
   - 可选 `strokeWidth`（distance transform）作为校准辅助。
3. 字号影响：不使用 `inkRatio / (fontSize * scale)` 这种失效量纲；改为**字号档校准**（如设备文本像素高 `<14`、`14–28`、`>28` 三档分别定阈值）。
4. 比较：
   - 设计×真机：`delta = (deviceInkRatio - designInkRatio) / designInkRatio`；
   - 同平台 baseline：`delta = (currentInkRatio - baselineInkRatio) / baselineInkRatio`。
5. 方向语义固定：`delta > 0` 表示 **device/current 比 design/baseline 更粗**；输出文档写死符号约定。

**硬下限**：设备文本像素高 `<10` → `unverified(text-too-small)`，防止小分母放大噪声。

### 4.4 分类与置信度

初始候选（未校准前只作 `experimental`）：

| delta | hint | 说明 |
|---|---|---|
| < -8% | lighter | 变细 |
| -8%…+8% | similar | 含 medium↔regular 的大部分噪声区 |
| +8%…+18% | heavier（低置信） | 常见 semibold |
| > +18% | heavier（高置信） | 常见 bold |

- `confidence` 由源格式（PNG/JPEG）、scale（是否上采样）、文本面积、对比度、定位来源（baseline/design-bbox）、字号档共同决定；低置信不升级为失败。
- `medium` 与 `regular` 的差异通常落在噪声区，只输出 `similar(low-confidence)` 或 `heavier(low-confidence)`，**不承诺绝对分类**。
- 跨源路径在通过 §6 的真实样本门槛前，输出 `experimental: true`，只作提示，不参与门禁。

### 4.5 输出与覆盖会计

`design_device_diff` 的 `regionDetails[]` 增加（仅文本区域）：

```json
{
  "textStyle": {
    "text": "早安, Amy",
    "designWeight": 600,
    "weightHint": "heavier",
    "delta": 0.14,
    "confidence": 0.72,
    "method": "ink-ratio | run-length | baseline",
    "sourceFormat": "png",
    "lossless": true,
    "localization": "baseline-bbox | design-bbox",
    "experimental": true,
    "unverifiedReason": null
  }
}
```

**覆盖守恒**（必须成立）：

```text
textsTotal（契约全部文本，含 no-geometry）
  = checked（有 textStyle 且非 unverified）
  + unverified（按 reason 计数：no-geometry / too-small / content-or-wrap / no-localization / lossy / no-baseline）
```

- 文本检查独立于区域提议迭代 `ui-contract.texts`；即使某文本没被区域核验提议，也要计入 `unverified(no-region)`，不能从 summary 消失。
- `summary.textStyles` 输出 `textsTotal / checked / lighter / similar / heavier / unverifiedByReason`；`checked = lighter+similar+heavier`。
- 不改变现有 `regions[]` 字段语义；新增字段 additive。

## 5. 集成

1. **`ui-contract`**：输出 `texts`（4.1，全量收录 + geometryStatus）。
2. **`design_device_diff`**：独立文本 pass 计算 `textStyle`；无定位/低保真 → `unverified` 并给原因；文本全量进 summary。
3. **`suite run --ui-diff`**：字重检查先 **report-only**（不改变 `ui.passed/failed`）；`experimental` 阶段只展示。
4. **`suite baseline`**：切片 4 接入文本 bbox 基线；同平台 regular→semibold 可做硬门禁。
5. **面板/报告**：`regionDetails`/报告里显示 `weightHint`；暂不新增独立页面。

## 6. 测试与验收

**合成 fixture 矩阵**

- 同字体、同字号：regular / medium / semibold / bold 四档；
- 不同字号：12/16/24/32（对应设备像素高覆盖三个字号档与 `<10px` 下限）；
- 深色/反相（浅字深底）；
- letter-spacing 变体（`meanRun` 敏感）；
- JPEG quality 80、`design-upscaled`、轻微位移/抗锯齿；
- 文本内容变化（短文本→长文本、单行→换行）。

**验收标准**

- 同源 PNG、1:1、同文本、同字号：
  - regular→bold：`heavier` 高置信 **≥98%**；
  - regular→semibold：`heavier` **≥95%**；
  - medium→regular：允许 `similar` 或低置信 `heavier`，**不纳入必须命中统计**；
  - 同字重对照：高置信误报 **= 0**。
- 内容/换行/定位失败：必须 `unverified`，不能报高置信 `heavier`。
- 暗色/反相、letter-spacing 档不能出现整批翻转；极端档可 `unverified`，但不能静默通过。
- 极小字号（设备像素高 <10）：`unverified(text-too-small)`。
- 跨源真实样本门槛（report-only 放行条件）：
  - 同字重真实文本 **N≥20**、PNG、1:1；
  - 高置信误报 **= 0**；
  - 记录 `delta` 均值/方差/分布进文档；
  - 并入 D12 基线实验：同一批真实设计渲染 × 真机截图增加 ink 指标采样。
- 同平台 baseline：真实项目小矩阵（n≥5，regular↔semibold↔bold 双向）能命中；误报门槛同“高置信误报=0”。

**真实项目验收**

- 同设备同屏，手动把 regular 改成 semibold/bold，`suite baseline` 能命中；
- 设计×真机在跨源门槛通过前只做 `experimental` 提示，不硬门禁。

## 7. 风险与边界

- **文本定位是最大风险**：没有真机 bbox 时，设计 bbox 映射在布局偏移/滚动后会裁错；v1 必须用 `confidence`、内容/换行守卫和 `unverified` 兜底。
- **跨平台字体形状**：iOS SF/Android Noto 与设计字体不同，绝对字重不可比；同平台 baseline 才是硬门禁来源。
- **medium 与 regular 太接近**：不要把低置信结果升级为失败，也不纳入必须命中统计。
- **压缩/上采样**：JPEG、`design-upscaled` 的高频损失会直接吞掉字重差异；这两种源只能低置信/`unverified`。
- **暗色/反相**：二值化极性必须显式处理，否则整批输出作废。
- **动态字体/多语言**：Dynamic Type、繁简/日文假名会改变字面宽度；按内容/字体族/字号档分别校准。
- **文本内容变化/换行**：不能比字重，必须 `unverified`；墨水相异度守卫是 v1 唯一可落地的机制，阈值需 fixture 校准。
- **覆盖会计**：区域提议不等于文本清单；文本 pass 必须独立遍历契约文本，否则会静默漏。

## 8. 实施切片（顺序已按可用性修正）

1. **契约文本节点**：`ui-contract.texts`（全量收录、geometryStatus、字重归一）+ fixture。
2. **测量库**：极性感知二值化、`inkRatio`/`meanRun`、字号档校准、内容/换行守卫（不接 UI）。
3. **diff 接线（report-only）**：`regionDetails.textStyle` + 覆盖会计；此时只有 design-bbox 可用，baseline 尚未接入，输出 `experimental`。
4. **baseline**：文本 bbox bootstrap（design-bbox→锁定）与重基线口径；同平台回归测试。
5. **门禁**：仅在真实样本高置信误报=0 后，对同平台 baseline 的高置信 `heavier` 开启阻断。

## 9. 评审结论与待确认

已采纳评审意见：

1. **同平台 baseline 才硬门禁，设计×真机只提示**；跨源提示加真实样本门槛 + `experimental` 标注。
2. **design-bbox v1 够用**，但必须带内容/换行守卫；OCR 不进 v1。
3. **medium 不承诺**，不纳入必须命中统计；semibold/bold 是校准目标。
4. **测量代码平台无关**，真实校准先 iOS，Android 跟进但不阻塞 report-only。
5. **先单独报告**；进入 `ui.failed` 仅限同平台 baseline 路径，且需数值门槛（真实样本同字重高置信误报=0）。

仍需你确认：

1. 跨源真实样本 N≥20 是否足够，还是要求更大样本/更多机型？
2. 同平台 baseline 的文本 bbox bootstrap 用 design-bbox 首次锁定，是否接受？
3. 文本内容/换行守卫的阈值（rowProfile 0.80 / smoothed column 0.75 / extent 0.70–1.40）是否先按 fixture 校准后再定稿？
4. 暗色/反相是否必须 v1 支持，还是先 `unverified` 并在 v1.1 补 fixture？

## 10. 实施进度（2026-10-20）

- **切片 1 完成**：`ui-contract.texts` 全量收录、字重归一、`bboxSpace/renderScale/geometryStatus`；iOS 首頁 53 条文本（400/600/700）。`suite ui-contract` 默认经 pen CLI `Get((n,c)=>c.bounds)` 补 auto-layout 文本绝对 bbox（`--no-bounds` 关闭；4 屏约 19s），首頁 53/53 `extracted`。
- **切片 2 完成**：`src/ui/text-weight.ts` 极性感知、`inkRatio`/`meanRunNorm`、row/平滑 column profile 守卫、extent 守卫、tiny/JPEG 降级；单测 5 例。
- **切片 3 完成**：`design_device_diff` 的 `regionDetails[].textStyle` + `detail.textStyles`；找到 `ui-contract` 屏幕时走契约全量 pass（`scope:"contract"`，`textsTotal = checked + unverified`，`items[]` 逐文本），找不到时回退 `scope:"text-regions"`。iOS 首頁实测 53 条：52 条 `no-geometry`、1 条 `no-text-ink`，全部 `unverified`——如实暴露 `.pen` auto-layout 缺几何。
- **切片 4/5 未开始**：baseline bbox、同平台硬门禁。
- **重要修正**：原稿的 `maskIoU < 0.55` 会把 regular→bold 误判为内容变化；实现改用 row profile 相关 + 平滑 column profile 相关 + extent 比。
