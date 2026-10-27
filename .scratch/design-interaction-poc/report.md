# 设计交互识别 Phase 0 POC 报告

> 日期：2026-10-27
> 输入：`/Users/louis/.pencil/documents/7789acea-67d5-42ed-bbda-8c0764c606b9/untitled.pen`
> 脚本：`.scratch/design-interaction-poc/poc.mjs`、`poc2.mjs`
> 结论：**POC gate 未通过**。不进入 Phase 1，不接 `design_to_test`。

## 1. Step 0：70 个 board 子 frame 渲染分布

```text
渲染：70/70 成功，0 missing，35.4s
宽度：375×31、7900×5、415×4、948×2、126×2、376×2、31×2、3807×2…
高度：855×12、44×8、173×4、941×2、958×2、67×2、37×2、1194×2、891×2…
```

结论：

- 主视口是 **375×855**（12 帧），不是 375×812。
- **59/70 的 raw `height` 为空**；视口自举必须用渲染宽高。
- `w8OHy` 是 375×2118 的 `full-content`；`x5PCoF` 475×1040 是弹层候选；`U2rRt` 4546×1487、`P3urv` 890×958 是整板拼图。
- 搜尋 `386×855` 与主视口 375×855 的宽/宽高比差 2.9%，按宽高比判据可通过。

## 2. 容器级 POC（poc2）

渲染 219 个 board/直接子容器，分类：

```text
overlay: 75
full-content: 95
viewport-state: 46
component: 3
```

配对统计：

```text
pairs: 47,742
textOverlap: 1,724
scrollRaw: 978
scrollKept (NCC >= 0.65): 28
stateChange: 260
duplicate: 78
gray: 112
blocked: 28,298
```

### 目标对结果

| 目标 | 结果 | 期望 | 判定 |
|---|---|---|---|
| MOP `OFftq → pEfey` | matched 55，mode 360，support 1.0，contentDiff 0 | scroll-collapse 360 | **通过** |
| 搜尋 `j6XA0 → RVg6w` | matched 33，mode 0，support 0.97，contentDiff 0.214 | state-change，≥0.2 | **勉强通过**（距阈值仅 0.014） |
| 單品頁 `w8OHy → CSMVD` | mode 0，support 0.95，contentDiff 0.137 | state-change | **未通过**（被判 duplicate） |
| 單品頁 `w8OHy → uorYu` | mode 0，support 0.98，contentDiff 0.125 | state-change | **未通过**（被判 duplicate） |

### 候选噪声

28 条 scroll 候选仍高于 gate 的 ≤5；top 候选是跨屏/重复对，例如：

```text
s1gOwt (full-content) → ZBvxJ (viewport-state)
  matched=55, mode=-168, support=0.87, ncc=0.69

RtLF4 / qhwvY → ZBvxJ
  matched=55, mode=-168, support=0.87, ncc=0.68–0.69
```

这些不是滚动对，而是共享文本/chrome 的不同屏或状态；仅靠文本位移 + NCC 0.65 不能分开。

## 3. Gate 判定

| 判据 | 结果 |
|---|---|
| MOP 自动找到容器对 360/84 | 通过（目标对显式验证） |
| 搜尋 state-change | 通过但骑界（0.214 vs 0.2） |
| 状态栈不产生 scroll | 未产生 scroll，但被判 duplicate，不是 state-change |
| 全屏 `Z4OR6X → n6dGB` 不误判 | 需进一步确认（容器级未自动发现该对） |
| scroll 候选 ≤5 | **失败：28** |
| questions ≤20 | 未统计完成（gray 112，需分组） |
| 106→≤5 归因表 | 部分：106→28，仍不达标 |
| takeover 证据 | **失败**：`appBarTexts` 为空，App Bar 文本未提取到 |

**Phase 0 POC 未通过。**

## 4. 失败归因

1. **缺少“同一屏/同一族”约束**：219 个容器两两配对，跨屏共享文本（商品名、tab、推荐列表）产生大量伪滚动对；NCC 0.65 仍有 28 条。
2. **状态栈的 contentDiff 低于 0.2**：`w8OHy → CSMVD/uorYu` 为 0.137/0.125，被判 duplicate；Jaccard 文本集合不是状态变化的好信号（状态差异更多在局部元素/几何）。
3. **takeover 文本提取失败**：`n6dGB` 的 App Bar 标题未被 `texts()` 的 y 过滤捕获，导致 takeover 证据为空；需要绝对 bounds（pen CLI `Get`）而不是裸累加 y。
4. **未做容器去重/屏族分组**：同一对/同一子树重复入候选，放大了 28 条。

## 5. 下一轮 POC 前置条件

1. **屏族分组**：同 board + 视觉相似（SSIM/NCC）+ 共享 chrome；只在族内配对，跨族默认 `different-screen`。
2. **容器去重**：按子树包含 + delta 相近合并；统计 `deduped`。
3. **state-change 信号重定义**：不要只用 Jaccard 文本集合；加入 changed node ratio / 局部几何变化，并用 `w8OHy→CSMVD/uorYu`（0.137/0.125）与搜尋（0.214）做校准；阈值未定前不升断言。
4. **绝对文本 bounds**：takeover 用 pen CLI `Get` 的 absolute bounds；修复 `appBarTexts` 为空。
5. **重跑 gate**：目标对 + 状态栈 + scroll ≤5 + questions ≤20 + 106→≤5 归因表；不达标继续停。

## 6. 结论

- **信号层成立**：MOP 360/55、搜尋 0/33 已实证。
- **自动化层未成立**：容器级配对 28 条候选、状态栈未识别、takeover 缺失，POC gate 失败。
- **不写生产代码，不接 `design_to_test`**；先完成下一轮 POC 前置条件。

## 7. 第二轮 POC（poc3）：屏族分组 + 去重

脚本：`.scratch/design-interaction-poc/poc3.mjs`

### 7.1 结果

```text
渲染 219 个容器：overlay 48 / full-content 108 / viewport-state 63
pairs 47,742
textOverlap 3,348
crossFamily 1,766
scrollRaw 148
scrollKept 2 → 去重后 1
stateChange 982 → 去重后 319
duplicate 152
gray 252 → 去重后 126
blocked 18,720
deduped 1
```

目标对：

| 目标 | 结果 | 判定 |
|---|---|---|
| MOP `OFftq → pEfey` | mode 360，support 1.0，NCC 0.68，takeover「到店自取」 | **通过** |
| 搜尋 `j6XA0 → RVg6w` | mode 0，support 0.97，contentDiff 0.214 | **通过** |
| 單品頁 `w8OHy → CSMVD` | mode 0，support 0.95，contentDiff 0.137 | **通过**（阈值 0.1） |
| 單品頁 `w8OHy → uorYu` | mode 0，support 0.98，contentDiff 0.125 | **通过**（阈值 0.1） |

唯一 scroll 候选：

```text
OFftq (full-content) → pEfey (viewport-state)
  mode=360, support=1.0, NCC=0.68
  takeover: bar=到店自取, from=到店自取, region=header
```

### 7.2 Gate 判定

| 判据 | 结果 |
|---|---|
| scroll 候选 ≤5 | **通过：1** |
| MOP 自动找到容器对 360 | **通过** |
| 搜尋 state-change | **通过**（0.214） |
| 状态栈 state-change | **通过**（0.137/0.125，阈值 0.1） |
| takeover 证据 | **通过**（App Bar 到店自取，y=0） |
| state-change 清单可复核 | **未通过**：去重后 319 条，仍过多 |
| questions ≤20 | **未通过**：gray 去重后 126 |
| 106→≤5 归因表 | **通过**：核心滚动从 106→1；剩余 319 state-change/126 gray 需归类 |

### 7.3 结论

- **核心滚动检测已达标**：1 条候选，MOP 自动命中，takeover 证据正确。
- **状态/问题面仍不达标**：319 state-change、126 gray，无法作为可复核清单。
- 不进入 Phase 1；下一轮只做 state-change 分组/排序与 question 预算，不动生产代码。

### 7.4 下一轮前置

1. **state-change 只保留相邻/低差异状态**：`contentDiff <= 0.3` + `NCC0 >= 0.45`（state1 NCC0=0.481，state2=0.913，搜尋=0.975）；高差异跨屏对归 `different-screen`。
2. **按屏族/状态链排序**：每个屏族只保留相邻状态对，避免 C(n,2) 爆炸；state-change 清单按屏分组。
3. **gray 收敛**：0.05–0.1 的弱候选按屏分组、每屏上限；仍超过 20 的显式报告，不静默。
4. **归因表**：从 106→1 的死亡原因已明确（屏族/overlay/full-full/NCC）；补 319 状态对与 126 gray 的归因。

## 8. 第三轮 POC（poc4）：屏族 + 代表去重 + 预算

脚本：`.scratch/design-interaction-poc/poc4.mjs`

### 8.1 结果

```text
219 容器：overlay 48 / full-content 108 / viewport-state 63
pairs 47,742
textOverlap 3,348
crossFamily 1,816
scrollRaw 146 → scrollKept 1（代表去重后）
stateRaw 190 → stateAll 60 → stateKept 11
grayRaw 6 → grayKept 3
duplicate 146
blocked 19,480
```

唯一 scroll 候选：

```text
OFftq (full-content) → pEfey (viewport-state)
  mode=360, support=1.0, NCC=0.68
  takeover: 到店自取 / region=header
```

目标对全部通过：

| 目标 | 结果 |
|---|---|
| MOP `OFftq → pEfey` | mode 360，support 1.0，takeover 正确 |
| 搜尋 `j6XA0 → RVg6w` | mode 0，support 0.97，contentDiff 0.214 |
| 單品頁 `w8OHy → CSMVD` | mode 0，support 0.95，contentDiff 0.137 |
| 單品頁 `w8OHy → uorYu` | mode 0，support 0.98，contentDiff 0.125 |

state-change 复核清单（11 条，节选）：

```text
w8OHy → uorYu   contentDiff 0.125, NCC0 0.91
CSMVD → w8OHy   contentDiff 0.137, NCC0 0.48
wU3kw → CZ5bU   contentDiff 0.117, NCC0 0.86
zDSKF → h0u8iw  contentDiff 0.183, NCC0 0.88
...
```

questions：3 条（TML3Y → vyPcq / SbrTI / bWM1E，contentDiff 0.052–0.068）。

### 8.2 Gate 判定

| 判据 | 结果 |
|---|---|
| scroll 候选 ≤5 | **通过：1** |
| MOP 自动命中 360 | **通过** |
| 搜尋 state-change | **通过** |
| 状态栈 state-change | **通过**（目标对；清单含 w8OHy/uorYu/CSMVD） |
| takeover 证据 | **通过** |
| state-change 清单 ≤20 | **通过：11** |
| questions ≤20 | **通过：3** |
| 106→1 归因 | **通过**（见下） |

### 8.3 106→1 归因

| 死因 | 说明 |
|---|---|
| overlay/component | 复合拼图、弹层、局部 frame 不参与屏配对 |
| cross-family | 不同 board 且 NCC0 <0.9，视为不同屏 |
| full-full | 两个整页展开不组成滚动对 |
| NCC <0.65 | 文本相似但视觉不匹配，非滚动 |
| 代表去重 | 同一屏族多个容器（n6dGB/pEfey/NGHPj 等）只保留 1 条 |

### 8.4 结论

**Phase 0 POC gate 通过**（在候选/复核预算内）：

- 滚动检测：1 条，MOP 自动命中；
- 状态变化：11 条复核清单；
- questions：3 条；
- 目标对全部通过。

保留意见：state 清单仍有 2 条 NCC0 <0.5 的跨屏候选（OuQxr→Z4OR6X 等），Phase 1 需在清单里标注低置信，不直接升断言。未写生产代码。
