# 设计交互识别方案（v6 草案）

> 状态：v6 草案，未实施。评审通过后再决定是否写入 `DESIGN.md` 并进入实现。
> 范围：滚动折叠、吸顶 header、页内状态变化等交互的自动识别与证据分级。
> 前提：**不要求设计师遵守命名、标注、节点 id 复用或额外 metadata 规范**。

## 0. 评审反馈评估与 v6 变更

### 0.1 先给结论

反馈总体成立，且比 v1 更接近可实施状态；但其中一条具体判断与实测不符。v2/v3 采纳绝大部分意见，并把“判定表能否跑出自己的旗舰案例”作为硬验收项。

### 0.2 逐项核对

| 反馈项 | 结论 | 实测/依据 |
|---|---|---|
| K1① 规则表跑不出 MOP 旗舰对 | **成立** | `OFftq → pEfey` 最佳 `d=360`，全帧 `NCC=0.683`，低于 v1 的 `0.85` 门槛；纯视觉轨会拒绝旗舰对 |
| K1② 搜尋对过不了自己的门 | **不成立（具体判断）** | `j6XA0 → RVg6w` 最佳 `d=0`，`NCC=0.975`，高于 `0.85`；真正的问题是 v1 没有定义“内容变化”如何判定，而不是相似度不够 |
| K1③ 灰区静默 / 兄弟屏落灰区 | **成立** | v1 的 `0.7 ≤ score < 0.85`、`8 ≤ d < 50`、重复帧均无行为；必须补第二信号与配对会计 |
| K1④ 配对失败静默 | **成立** | v1 失败时只输出 `interactions: []`，无法区分“没有交互”和“没识别出来” |
| K2 design-px 与设备坐标未对账 | **成立** | v1 的 `Assertion.delta` 同时出现 design-px 与设备侧 `thresholdPx`，单位悬空 |
| M1 delta 定义与 360/404 矛盾 | **成立，但真值是 360** | MOP 84 个匹配文本节点位移全部为 `360`；`44 → -360 = 404` 是内容容器原点变化（含 header 移除），不是纯滚动 |
| M2 `confirmed` 无类型、`state-change` 死成员 | **成立** | v1 的 `Provenance` 没有 `confirmed`；`Assertion.state-change` 在 `toAssertion` 中无条件返回 null |
| M3 sticky 规则推不出 App Bar | **成立** | App Bar 只在滚动态出现，主态无配对节点，`abs(Δy) <= 8` 规则够不着；需要 takeover-bar 规则 |
| M4 阈值裸常数、无校准 | **成立** | v2 用实测数据校准：MOP `0.683`、搜尋 `0.975`，证明单一视觉阈值不可用 |
| M5 探测预算/30 步上限/缓存陈旧 | **成立** | 23 屏 × 6 段探测若内插进 case 会撞 30 步；缓存只按设备指纹会在 app 改版后命中旧行为 |
| M6 NodeRef 不是设备查询语言 | **成立** | 探测输出是设计节点名，执行层需要 AX 文本/role/位置查询 |
| M7 与 design_reading 同文件竞态 | **成立** | v1 直接改 `reading/types.ts`、`run.ts`、`reading.json`；需声明依赖顺序与范围 |
| 低优先项（O(n²) 措辞、viewport null、d 符号、changed 定义等） | **成立** | v2 逐项补齐 |

### 0.3 v2 的核心变化

1. **双轨配对**：结构锚（文本/几何/位移分布）为主，视觉 NCC 兜底；不再用单一全帧相似度决定一切。
2. **单位钉死**：设计侧 `design-px @1x`，运行侧统一**逻辑单位**（iOS `pt` / Android `dp`）；`adb`/`uiautomator` 的物理 px 只在适配器边界换算，断言不携带精确 delta。
3. **delta 用位移众数**：MOP 的 84/84 文本节点位移为 360，360 是 scroll delta；404 是容器原点异常值。
4. **confirmed 进类型**；`Assertion` 只保留 `scroll-collapse`，且只能由 `observed | confirmed` 构造。
5. **sticky 拆两条规则**：双态位置不变 + takeover-bar 新出现。
6. **探测独立通道**：不内插 case；只探测有候选的屏；缓存指纹含 app 版本/构建。
7. **配对会计**：frames / pairs / scroll / state-change / duplicate / gray / unpaired 全部计数并进 stats。
8. **断言结构不变量**：不携带精确 360/300；只断言“tabs 文本消失 + App Bar 标题出现 + 回滚恢复”。

### 0.4 v2 评审反馈（本轮）

| 反馈项 | 结论 | v3 处理 |
|---|---|---|
| 结构轨“文本依赖症” | **成立** | 增加几何锚（图标/图片占位/稳定矩形）作为结构轨第二类锚；纯图形界面不再直接瘫痪 |
| 真机探测固定步进太粗 | **成立（需加单调性保护）** | 先粗扫再二分逼近首次变化；非单调/噪声场景回退线性扫描 |
| takeover 文本严格相等太严 | **成立** | 改为归一化包含或编辑距离 ≥0.8；加短文本/通用词防误配 |
| 缓存 app 版本/build 作软键 | **不采纳为默认** | observed 断言必须匹配 app 版本/build；软缓存只允许用于 inferred/非断言证据，且标记 stale |
| DeviceQuery 缺相对位置 | **成立** | 增加 `region` / `role` / `ordinal`，避免顶部/底部同名控件误判 |
| `vision-inferred` 术语与类型不一致 | **成立（文档/命名问题）** | 明确 `basis:"vision"` 即 vision-inferred；新增 `VisionInferred` 类型别名，避免术语漂移 |
| 用 `return null` 替代 `assertNever` | **不采纳** | `assertNever` 是扩展保护：Phase 2 加 state-change 时必须显式处理；用独立 `toScrollAssertion` 而不是放宽联合 |
| ROI 局部特征匹配 | **成立** | 加局部 NCC；ROI 不写死 30/70，按检测到的 header/content 自适应 |
| Auto Layout/Mask 坐标未展平 | **成立且关键** | Stage 0 必须取绝对 bounding box（pen CLI `Get` / Figma `absoluteBoundingBox`）；禁止对 auto-layout 子节点裸累加 y |
| 其余“Keep”项（双轨、deltaMode、结构不变量、独立探测、升权门） | **同意** | 保留，作为 v3 的不变部分 |

### 0.5 v3 核心变化

1. **结构轨双锚**：文本锚 + 几何锚（图标/图片/稳定矩形）；`matchedTexts` 或 `matchedAnchors` 满足其一即可。
2. **绝对几何**：Stage 0 使用布局引擎/设计 API 的 absolute bbox；auto-layout、mask、clip 不再靠祖先 y 裸加。
3. **探测二分**：粗扫定位变化区间 → 二分逼近 threshold → 回滚验证；非单调回退线性。
4. **takeover 相似匹配**：contains / Levenshtein ≥0.8 + 几何约束 + 通用词黑名单。
5. **DeviceQuery 空间约束**：`region` / `role` / `ordinal`，解决同名控件。
6. **缓存分级**：observed 断言强指纹（app build/版本）；inferred 证据可软缓存，但不得升断言。
7. **断言入口拆分**：`toScrollAssertion` 保持穷尽；Phase 2 的 state-change 另加入口，不用 `return null` 掩盖未处理分支。
8. **术语统一**：`VisionInferred` 别名 + 文档统一使用 `vision-inferred`。

### 0.6 先做 POC，不直接实施（必须先过）

为避免“文档很完整、落地才发现不成立”，在写生产代码前先做一个**可失败**的全量 POC。对 starbucks `.pen` 的 70 个 board 子 frame 做 text-only 结构配对，结果：

```text
可评估文本重叠对：882
scroll 候选：106
state 候选：36
```

关键发现：

- **误报很多**：`單品頁` 的多个状态帧在画布上垂直排布，被识别成 `mode=892` 的“滚动”；这是画布排布，不是滚动。
- **目标全屏对失败**：`Z4OR6X → n6dGB`（主屏 → 下滑屏）被判 `different-screen`，`mode=-544`，`rare=0`；因为真正的滚动对是嵌套内容容器 `OFftq → pEfey`，不是整屏 frame。
- **信号层仍成立**：单独比较内容容器 `OFftq → pEfey` 时，84/84 文本位移 360、支持度 1.0、App Bar takeover；搜尋 `j6XA0 → RVg6w` 为 `state-change`。

所以结论必须分成两层：

1. **信号层已实证**：几何 + 文本位移能推出 MOP 折叠，搜尋不会误判为滚动。
2. **自动化层未证明**：文档里的“pair frames”太粗；必须先解决**容器级配对 + 状态栈排除 + 全屏/内容容器区分**，否则直接实现会产出大量误报。

### 0.7 关键修正：视口固定，超出视口是全页展开

用户指出：**设计稿应按固定宽高评估；超过固定视口的，多数是设计师给出的“整页内容展开”，对 App 来说它们是可滚动内容，不是一个新屏或滚动状态。**

这直接推翻了 v3 POC 的“全 frame 两两配对”前提：

- `w8OHy → CSMVD/uorYu`（單品頁状态）在 855 视口内：
  - CSMVD：47/49 个文本 `Δy=0`（另 2 个 Δy=-1）：`state-change`；
  - uorYu：46/48 个文本 `Δy=0`（另 2 个 Δy=-1）：`state-change`。
- 之前把整帧画布 y 相比，得到 `mode=892`，是把“画布上垂直排布的状态”误当成滚动。
- `OFftq`（1713 高）是 `行動預點` 的**整页展开内容**，不是独立屏；下滑状态 `n6dGB`（渲染 375×855）里的内容容器 `pEfey`（812 高）才是视口内的滚动内容。正确配对是“整页内容 + 下滑视口状态”，不是两个整帧。

因此 v5 在配对前增加 **Stage 0.5 视口归一化**：

1. 每个屏/画板先确定固定 `Viewport`（设备 artboard、状态帧中位宽高、或 App 配置）。
2. 把 frame 分为：
   - `viewport-state`：宽高≈视口；
   - `full-content`：高度 > 视口 ×1.1（整页展开，可滚动）；
   - `component`：嵌套组件/局部 frame。
3. `full-content` 不是新屏/新状态，只是同一屏的滚动内容；不能和另一个 `full-content` 组成“滚动前后对”。
4. 状态比较只在 `viewport-state` 之间、偏移 0 处做；`Δy≈0` + 内容变化 → `state-change`。
5. 滚动折叠只在 `full-content + viewport-state`（按内容对齐偏移 d）或两个不同滚动位置的 `viewport-state` 之间推断。

### 0.8 v4 评审反馈（本轮）

| 反馈项 | 结论 | v5 处理 |
|---|---|---|
| K1 视口自举循环 | **成立** | 增加“渲染宽高分布”第 0 步；视口按宽度聚类 + board artboard；分类改宽高比判据；59/70 raw height 为空，禁用 raw `height` 自举 |
| K1 “855/812 骑 ±5% 界” | **不成立（具体数值）** | 第 0 步实测主视口是 **375×855**（12 帧），不是 812；搜尋 `386×855` 宽/宽高比差 2.9%，不骑 5.3% 高度界。宽高比原则仍保留 |
| K1 (1.05,1.1] / <0.95 未定义带、嵌套语义 | **成立** | 定义 `viewport-state` / `full-content` / `overlay` / `component`；明确“只看尺寸不看层级” |
| K2 threshold（首次变化）与 delta（总位移）语义不同 | **成立** | 交叉校验改为“设计 delta 处 DeviceQuery 成立性”；probe 记录 `firstChange` / `fullEffect`；threshold 取结构信号 |
| K3 toScrollAssertion 同文本 absent+present 矛盾 | **成立** | NodeRef 加 `origin`；DeviceQuery 填 `region`；afterRestore 反转 takeover（absent） |
| M1 contentDiff 公式未定义、搜尋骑 0.2 界 | **成立** | 固定 Jaccard 距离 `1 - inter/union`；搜尋 14/47=0.298 |
| M2 整帧/嵌套容器双计 | **成立** | 按子树包含 + delta 相近去重；stats 加 `deduped` |
| M3 POC gate 缺问题预算/state-change FP/106 归因表 | **成立** | gate 补三项 |
| M4 tab/bar 同文本污染位移众数 | **成立** | takeover 匹配器与位移统计分离；报告未碰撞原因 |
| L1 预筛“视口宽高比”歧义 | **成立** | 明确“各自所属屏的视口宽高比”，不是帧宽高比 |
| fixture 8 仍引用 0.85 | **不成立（原文无 0.85）** | 仍按当前 bands 更新边界值，避免歧义 |
| fixture 15 与 §0.7 数字不一致 | **成立** | 统一为 47/49、46/48 Δy=0 |
| candidate provenance 含 observed | **成立** | 设计侧候选只允许 `inferred` |
| `toScrollAssertion` 的 `null` 返回是死分支 | **成立** | 改为返回 `Assertion` |
| 粗扫步长固定 | **成立** | 从 `overflow` 派生 |
| “主态可见”未定义 | **成立** | 定义为视口窗 `y ∈ [0, viewportHeight)` |
| §0 变更史应拆分 | **建议** | DESIGN.md 落笔时正文与评审记录分节；本文件保留完整变更史 |

### 0.9 v5 核心变化

1. **视口归一化可执行**：渲染宽高分布 → 宽度聚类 → board artboard/高度簇 → 宽高比分类；`overlay` 单独一类。
2. **交叉校验结构验证**：设计 delta 处跑 `afterScroll` 查询，通过即通过；不再用 firstChange 数值硬比对。
3. **升权入口修正**：`origin` + `region` + takeover 回滚 absent；同文本不再矛盾。
4. **contentDiff 固定 Jaccard**：搜尋 0.298，旗舰不骑界。
5. **候选去重**：整帧/嵌套容器只留一条；`deduped` 可见。
6. **POC gate 加账**：70 帧分布、questions ≤20、state-change FP 清单、106→≤5 归因表。

### 0.10 v5 评审反馈（本轮）

| 反馈项 | 结论 | 处理 |
|---|---|---|
| 架构无需再改、可直接进 POC | **方向同意，措辞过强** | 架构自洽；但“彻底扫清所有盲区”在 POC 前无法证明；POC gate 不跳过 |
| Jaccard 归一化粒度要统一 | **成立** | 新增 `normalizeTextForSet` / `normalizeForMatch` 共用规范；Stage 1/2 复用 |
| takeover 两遍扫描、隔离副作用 | **成立** | Pass 1 只标记候选，Pass 2 从位移池剔除；evidence 保留原数据 |
| `overflow` 派生步长可能越界 | **成立** | `step = min(overflow, min(400, max(100, round(overflow/4))))`；`overflow<=0` 不探测 |
| `assertNever` 严格实现 | **成立** | `never` 返回 + `strict`；加编译期/单测守护 |
| 评审通过先固化 `DESIGN.md` | **建议调整顺序** | 先跑 Phase 0 POC；POC 通过后再把“已实现/已验证”写入 `DESIGN.md`，避免把未验证细节写成事实 |

### 0.11 v6 核心变化

1. `normalizeTextForSet` / `normalizeForMatch` 统一归一化（NFKC、空白、大小写、标点、动态值占位）。
2. takeover 两遍扫描，位移统计与 evidence 隔离。
3. 粗扫步长 `min(overflow, ...)` 边界保护；`overflow<=0` 直接 `not-scrollable`。
4. `assertNever` 实现与严格模式守护。
5. POC 先行；`DESIGN.md` 落笔放到 POC gate 之后。

POC 成功标准（不达标就停止，不进入 Phase 1）：

- MOP：自动找到“整页内容 + 下滑视口状态”对，`deltaMode=360`、`support>=0.95`、App Bar takeover；
- 搜尋：`state-change`，不产生 scroll 候选；
- `單品頁`/`訂單狀態` 等状态栈：不产生 scroll 候选；
- 全屏 `Z4OR6X → n6dGB` 不被误判为滚动；
- 23 屏项目最终 scroll 候选 ≤5（去重后），且每条可人工复核；
- questions 预算：按屏分组、每屏上限后，总问题数 ≤20，并附清单；
- state-change FP 清单：`單品頁`/`訂單狀態` 等状态栈的每一对逐条列出“应为 state-change”及理由，可人工核对；
- **106→≤5 归因表**：每条候选/误报标注死因（视口归一化、容器化、去重、视觉轨否决、状态栈排除、different-screen），作为 `PAIRING_BANDS` 校准依据；
- 目标对召回 100%，误报可解释。

## 1. 背景

### 1.1 真实项目暴露的问题

`starbucks-ios-taiwan` 的 `.pen` 设计稿里同时存在：

- 主状态 `行動預點`（`Z4OR6X`）
- 下滑状态 `行動預點-下滑`（`n6dGB`）

当前 `reading.json` 把状态名放在 `knownStates`，但 `states: []`，没有保留状态帧的几何，也没有把“滚动后 header 折叠、取货方式 tabs 移出视口”变成交互候选。结果是：

- 测试用例只能生成 23 步“探索”，0 条硬断言；
- 真机执行到 `30` 步上限仍未完成；
- UI 对比只覆盖前 3 屏，后续屏幕的折叠/吸顶差异不可见。

### 1.2 现有数据其实足够推断

同一份 `.pen` 中：

| 节点 | 主状态 `OFftq` | 下滑状态 `pEfey` |
|---|---|---|
| 内容容器 | `y = 44` | `y = -360` |
| 取货方式 tabs 绝对 y | `44`（可见） | `-316`（移出视口） |
| 顶部 App Bar | 无 | `y = 0`，标题「到店自取」 |

实测：

```text
d = 360（最佳垂直偏移）
NCC = 0.683（全帧）
MAE = 6.61
匹配文本节点 = 84
位移众数 = 360，支持度 = 84/84
```

由此可以推断：

```text
滚动约 360px
→ 取货方式 tabs 被卷走
→ header 折叠为 App Bar
→ 选中的「到店自取」保留在 App Bar 标题
```

这不需要 `-下滑` 这个名字，也不需要设计师补任何字段；需要的是**结构锚配对 + 位移分布 + 可见性判断**。

### 1.3 仅截图不够

用户提供的「產品搜尋 / 產品搜尋-已搜尋」两张图：

```text
d = 0
NCC = 0.975
匹配文本节点 = 33，其中 32 个位移 0，1 个位移 8
文本集合：43 vs 37（内容有变化）
```

应判定为 `state-change`，不能误判为 `scroll-collapse`。注意：它其实**能过** v1 的 `0.85` 视觉门槛；真正需要补的是“内容变化”的定义，而不是提高相似度门槛。

## 2. 目标与非目标

### 2.1 目标

1. 从任意设计稿中自动找出“同一屏的不同滚动位置”候选，不依赖命名、id、注解。
2. 输出结构化交互候选：`scroll-collapse`、`state-change`、`different-screen`（仅计数）、`unknown`。
3. 用真机滚动探测把候选升级为 `observed`，不依赖设计工具的原型数据。
4. 在类型层面保证：`inferred` / `unconfirmed` 永远不能直接变成硬断言。
5. 与现有 `design_to_test`、`suite run`、`ui-contract`、`reading.json` 集成，不破坏旧字段。
6. 识别失败时显式输出问题/告警，不猜、不假绿。
7. 断言面向**结构不变量**，不绑定精确像素 delta 或单一设备。

### 2.2 非目标

- 不推断动画曲线、缓动、回弹细节。
- 不要求 100% 自动识别所有交互；识别不到时降级为问题。
- 不替代设计师确认“应该怎样折叠”的产品意图。
- 不引入必须由设计师维护的 sidecar 文件。
- 不做完整 CV 框架；先做最小可验证的结构锚 + 位移分布 + 视觉兜底方案。
- Phase 1 不把 `DesignSnapshot` 全量替换现有四套产物；只服务交互推断。

## 3. 设计原则

1. **Parse, don't validate**：在 `.pen` / Figma 边界解析成 `DesignSnapshot`，下游只吃类型化数据。
2. **Make impossible states impossible**：`Interaction` 用 discriminated union；`Assertion` 只能由 `observed` / `confirmed` 构造。
3. **核心纯函数**：推断不读文件、不调 LLM、不写盘；输入 frame，输出候选。
4. **测试先行**：先写 fixture，让“搜尋对不误判”“MOP 对识别为折叠”失败，再实现。
5. **No boolean blindness**：不用 `scroll: boolean`，用带 `kind`、`evidence`、`score` 的联合类型。
6. **LLM 只做 labeler**：视觉模型输出必须 zod 校验，只能标 `vision-inferred`，不能直接生成断言。
7. **Fail closed**：低置信 → `unknown + question`，不生成硬断言。
8. **单一事实源（Phase 1 限定）**：交互推断只依赖一份 `DesignSnapshot`；flows/reading/contract/tests 的派生重构另行立项。
9. **不依赖命名，但可用命名**：命名相似度只做 tie-breaker，不作为门槛；改名不变性测试必须通过。
10. **配对会计**：任何“没配对”都要计数，不能静默。

## 4. 数据模型（v5）

### 4.1 单位

```ts
type Unit =
  | {
      space: "design-px";
      /** 设计坐标 → 逻辑单位的换算系数；由 frame 宽度 / 设备逻辑宽得出。 */
      toLogical: number;
    }
  | { space: "logical"; nativeUnit: "pt" | "dp" };
```

约束：

- 设计节点一律 `design-px @1x`。
- 运行期探测一律 `logical`：iOS 为 `pt`，Android 为 `dp`；`adb`/`uiautomator` 的物理 px 只在适配器内换算。
- 只在边界换算一次；`InteractionCandidate` 内同时保留 `design` 与 `device` 两个值，禁止混用。
- `Assertion` 不携带精确 delta/threshold；精确数字只进 `evidence`。

### 4.2 几何与 provenance

```ts
type Box = { x: number; y: number; width: number; height: number };

type Geometry =
  | {
      kind: "exact";
      box: Box;
      space: "design-px";
      /** 必须来自布局引擎/设计 API 的绝对坐标；禁止 auto-layout 子节点裸累加。 */
      absolute: true;
    }
  | { kind: "missing"; reason: "no-bbox" | "auto-layout" | "clipped" };

/** 绝对几何来源：pen CLI Get / Figma absoluteBoundingBox / 逐屏渲染。 */
type GeometryProvider = {
  absoluteBox(nodeId: string): Geometry;
};

type Provenance =
  | { kind: "observed"; evidence: string[] }
  | {
      kind: "inferred";
      basis: "structural" | "vertical-offset" | "vision" | "naming";
      score: number;
    }
  | { kind: "confirmed"; answerId: string; evidence: string[] }
  | { kind: "unconfirmed"; questionId: string };

/** 文档统一术语：basis:"vision" 即 vision-inferred。 */
type VisionInferred = Extract<Provenance, { kind: "inferred"; basis: "vision" }>;
```

### 4.3 节点、帧、配对

```ts
type DesignNode = {
  id: string;
  name: string;
  text: string | null;
  geometry: Geometry;
  children: DesignNode[];
};

type Viewport = {
  width: number;
  height: number;
  source: "device-frame" | "state-median" | "app-config";
};

type FrameKind =
  | "viewport-state"   // 宽高/宽高比≈视口，可直接作为屏/状态
  | "full-content"     // 宽高比明显高于视口：整页展开，可滚动
  | "overlay"          // 弹层/浮层：不参与屏配对，走 pre/post 或真机探测
  | "component";       // 嵌套组件/局部 frame

type DesignFrame = {
  id: string;
  name: string;
  viewport: Viewport | null;
  kind: FrameKind;
  /** full-content 的溢出高度；viewport-state 为 0。 */
  overflow: number;
  nodes: DesignNode[];
};

type Pairing = {
  track: "structural" | "visual";
  score: number;
  /** 结构轨：匹配文本节点数 / 位移众数支持度。 */
  matchedTexts: number;
  /** 结构轨第二类锚：图标/图片占位/稳定矩形。 */
  matchedAnchors: number;
  anchorSupport: number;
  support: number;
  offset: number;
  /** 位移分布：众数、离散度、样本数。 */
  deltaMode: number | null;
  deltaSpread: number | null;
};

type NodeRef = {
  id: string;
  name: string;
  text: string | null;
  /** takeover：滚动态新出现、回滚后应消失；persistent：双态都在。 */
  origin?: "persistent" | "takeover";
  /** 几何顶部带=header；底部带=footer；其余=content。 */
  region?: "header" | "content" | "footer";
};

type PairingStats = {
  frames: number;
  pairsEvaluated: number;
  structuralPairs: number;
  visualPairs: number;
  scrollCandidates: number;
  stateChanges: number;
  duplicates: number;
  gray: number;
  differentScreen: number;
  unpaired: number;
  /** 整帧/嵌套容器双计去重掉的候选数。 */
  deduped: number;
};

type InteractionCandidate =
  | {
      kind: "scroll-collapse";
      beforeFrameId: string;
      afterFrameId: string;
      pairing: Pairing;
      delta: { designPx: number; devicePoints: number | null };
      sticky: NodeRef[];
      collapsed: NodeRef[];
      titleTakeover: { bar: NodeRef; from: NodeRef } | null;
      provenance: Extract<Provenance, { kind: "inferred" }>;
      evidence: string[];
    }
  | {
      kind: "state-change";
      beforeFrameId: string;
      afterFrameId: string;
      pairing: Pairing;
      changed: NodeRef[];
      provenance: Extract<Provenance, { kind: "inferred" }>;
      evidence: string[];
    }
  | { kind: "unknown"; frameIds: string[]; questionId: string };
```

### 4.4 观测、确认、断言

```ts
type ObservedInteraction = {
  kind: "scroll-collapse";
  provenance: Extract<Provenance, { kind: "observed" }>;
  screenId: string;
  unit: "logical";
  nativeUnit: "pt" | "dp";
  thresholdSignal: "structural";
  firstChangePoints: number;
  fullEffectPoints: number;
  sticky: NodeRef[];
  collapsed: NodeRef[];
  restored: boolean;
  evidence: { before: string; after: string };
};

type ConfirmedInteraction = {
  kind: "scroll-collapse";
  provenance: Extract<Provenance, { kind: "confirmed" }>;
  screenId: string;
  sticky: NodeRef[];
  collapsed: NodeRef[];
};

type DeviceQuery =
  | {
      kind: "absentText";
      text: string;
      region?: "header" | "content" | "footer";
      role?: string;
      ordinal?: number;
    }
  | {
      kind: "presentText";
      text: string;
      region?: "header" | "content" | "footer";
      role?: string;
      ordinal?: number;
    }
  | { kind: "headerTitle"; text: string };

type Assertion = {
  kind: "scroll-collapse";
  source: "observed" | "confirmed";
  /** 结构不变量：不携带精确 delta。 */
  afterScroll: DeviceQuery[];
  afterRestore: DeviceQuery[];
};
```

升权入口：

```ts
/** Phase 1 只处理 scroll-collapse；Phase 2 的 state-change 另加入口。
 * 保留 assertNever：新增成员时必须显式处理，不用 return null 掩盖未处理分支。 */
function toScrollAssertion(
  interaction: ObservedInteraction | ConfirmedInteraction
): Assertion {
  switch (interaction.kind) {
    case "scroll-collapse": {
      const persistent = interaction.sticky.filter((node) => node.origin !== "takeover");
      const takeover = interaction.sticky.filter((node) => node.origin === "takeover");
      const collapsed = interaction.collapsed.filter((node) => node.text !== null);
      return {
        kind: "scroll-collapse",
        source: interaction.provenance.kind,
        afterScroll: [
          ...collapsed.map((node) => ({
            kind: "absentText" as const,
            text: node.text!,
            region: node.region ?? "content"
          })),
          ...persistent.flatMap((node) =>
            node.text
              ? [
                  {
                    kind: "presentText" as const,
                    text: node.text,
                    region: node.region ?? "content"
                  }
                ]
              : []
          ),
          ...takeover.flatMap((node) =>
            node.text
              ? [{ kind: "presentText" as const, text: node.text, region: "header" as const }]
              : []
          )
        ],
        afterRestore: [
          ...persistent.flatMap((node) =>
            node.text
              ? [
                  {
                    kind: "presentText" as const,
                    text: node.text,
                    region: node.region ?? "content"
                  }
                ]
              : []
          ),
          ...collapsed.map((node) => ({
            kind: "presentText" as const,
            text: node.text!,
            region: node.region ?? "content"
          })),
          ...takeover.flatMap((node) =>
            node.text
              ? [{ kind: "absentText" as const, text: node.text, region: "header" as const }]
              : []
          )
        ]
      };
    }
    default:
      return assertNever(interaction);
  }
}
```

说明：

- `state-change` 只做候选，不进 `Assertion`（Phase 1）；Phase 2 若做 observed state-change，再单独加联合成员。
- `confirmed` 是测试人员确认，不是设计师规范；没有 `confirmed` 时只能走 observed。
- `NodeRef` 保留在候选/证据层；断言落成设备可执行的 `DeviceQuery`。
- `Assertion` 断言结构不变量：滚动后 tabs 文本在 content 区消失、App Bar 标题在 header 区出现；回滚后 tabs 回来、App Bar 消失。同文本靠 `region` 消歧，不产生 absent+present 矛盾对。
- `origin` 必须由几何推断填充：双态不变 → `persistent`；滚动态新出现且标题承接 collapsed → `takeover`。

### 4.5 状态帧

```ts
type StateFrame = {
  stateId: string;
  label: string;
  frame: DesignFrame;
};

type DesignSnapshot = {
  frames: DesignFrame[];
  stateFrames: StateFrame[];
  warnings: string[];
};
```

`reading.json`：

- 新增 `states: StateFrame[]`（保留几何）。
- `knownStates` 变为派生只读视图：去重、按出现顺序排序。
- `interactions: InteractionCandidate[]`。
- `pairingStats: PairingStats`。

## 5. 识别流水线

### 5.1 Stage 0：解析

- 输入：`.pen` / Figma REST / 现有 flows。
- 输出：`DesignSnapshot { frames; stateFrames; texts; warnings; }`。
- **绝对几何**：一律通过 `GeometryProvider` 取布局引擎/设计 API 的绝对 bounding box：
  - pen：`Get` 脚本解析后的 absolute bounds（文本已有 `src/pen/bounds.ts` 先例）；
  - Figma：`absoluteBoundingBox`；
  - 逐屏渲染：设计坐标系绝对 box。
  - **禁止**对 auto-layout / mask / fill-container 子节点裸累加祖先 y；无法取绝对 box 时记 `Geometry.missing`，不猜。
- 规则：缺失 bbox 一律 `Geometry.missing`，不补 0、不猜坐标。
- 失败：结构化 `warning`，不抛到 UI。
- `viewport` 为 null 的帧：只走结构轨；不参与视觉轨，记 `visual-skipped-no-viewport`。

### 5.1.5 Stage 0.5：视口归一化（v5 新增）

先确定固定视口，再谈配对：

0. **第 0 步必须产出**：70 个候选 frame 的**渲染宽高分布**（不是 raw `height`；实测 59/70 的 raw height 为空），报告各宽度簇、各高度簇、`clip` 数量。它是后续视口自举和 POC gate 的第一份证据。
1. **视口来源**（按优先级，避免自举循环）：
   - 设计稿中的设备 artboard 宽高（最可靠）；
   - 同一 board 内 `viewport-state` 候选的渲染宽高中位数；
   - App 配置/设备 points（如 375×855、390×844）。
   - 顺序：先按渲染宽度聚类（±5%，375/386 应聚为一类）→ 在每个宽度簇内看渲染高度分布 → 结合 board artboard 选定视口；**不要先用视口高度排除 `full-content`，再用排除结果求视口高度**。
2. **分类（只看尺寸，不看嵌套深度）**：
   - 宽度在视口 ±5% 且**宽高比**在视口 ±5% → `viewport-state`；
   - 宽高比高于视口 ×1.05（明显更长）→ `full-content`（`overflow = renderedHeight - viewportHeight`）；
   - 宽高明显小于视口或为弹层（圆角/阴影/覆盖层）→ `overlay`；
   - 其他 → `component`（会计可见）。
   - 明确：`pEfey` 是嵌套子容器，但尺寸/宽高比匹配视口 → 判 `viewport-state`；**层级不参与判定**。
3. **旗舰边界**：搜尋 `386×855` vs 视口 `375×855`：
   - 宽度差 `386/375 = 1.029`（2.9%），宽高比 `0.4515` vs `0.4386`（2.9%）→ 按宽高比判据通过，不会落 `component`；
   - 第 0 步实测主视口为 375×855（12 帧），不存在旧假设里的 `855/812=1.053` 高度骑界。
4. **语义**：
   - `full-content` 是同一屏的可滚动内容，不是新屏/新状态；
   - 两个 `full-content` 不能组成“滚动前后对”；
   - `viewport-state` 之间的 `Δy≈0` 比较才表示状态变化；
   - `overlay` 不参与屏配对，弹层用 runtime pre/post；fixture 16 不再假定管线已有 pre/post。
5. **输出**：`FrameKind` + `overflow` + `viewport`；`pairingStats` 增加 `fullContent` / `viewportStates` / `overlays` / `components`。

### 5.2 Stage 1：双轨配对（不依赖名称/id）

> 配对对象是**视口归一化后的容器**（`viewport-state` / `full-content` / `component`），不是画布上的整帧。配对前先按 `FrameKind` 限定组合，否则会把“整页展开”或“画布上垂直排布的状态”误判成滚动。

**允许的配对组合**：

| A | B | 允许 | 说明 |
|---|---|---|---|
| `viewport-state` | `viewport-state` | 是 | 偏移≈0 → state-change/duplicate；不同滚动位置 → scroll |
| `full-content` | `viewport-state` | 是 | 按内容匹配偏移 d → scroll-collapse |
| `full-content` | `full-content` | 否 | 两个整页展开是同一屏内容，不是滚动对 |
| `component` | 任意 | 否 | 组件/局部 frame 不参与屏配对 |

#### 轨 A：结构锚（主轨）

1. 预筛：**各自所属屏的视口宽高比**接近（±10%），不是帧宽高比；文本集合或几何锚有交集。
2. **文本锚**：按归一化文本 + 相对几何匹配；不看 id。
3. **几何锚**（纯图标/无文本界面）：按稳定尺寸/长宽比/相对位置/patch hash 匹配图标、图片占位、稳定矩形；至少 `minMatchedAnchors`（默认 4）个，且不能是任意背景块。
4. 对每对匹配节点计算 `Δy = yBefore - yAfter`。
5. 取位移众数 `deltaMode` 与支持度 `support`（文本锚与几何锚可合并，分别记 `support` / `anchorSupport`）。
6. 计算内容差 `contentDiff`：**固定用 Jaccard 距离** `1 - |A∩B| / |A∪B|`（归一化文本集合；`changed` 仍保留并集明细供解释）。
   - 搜尋例：`|A|=43`、`|B|=37`、`|A∩B|=33`、`|A∪B|=47` → `1 - 33/47 = 0.298 >= 0.2` → `state-change`。
   - 不采用 `对称差/(|A|+|B|)`（该式会给 0.175，把旗舰分到 duplicate 一侧）。

判定：

| 条件 | 分类 |
|---|---|
| `(matchedTexts >= 8 或 matchedAnchors >= 4)` 且 `abs(deltaMode) >= 50` 且 `support >= 0.8` | `scroll-collapse` 候选（结构轨） |
| `abs(deltaMode) <= 8` 且 `(matchedTexts >= 8 或 matchedAnchors >= 4)` 且 `support >= 0.8` 且 `contentDiff >= 阈值` | `state-change` 候选（结构轨） |
| `abs(deltaMode) <= 8` 且 `(matchedTexts >= 8 或 matchedAnchors >= 4)` 且 `contentDiff < 阈值` | `duplicate`（重复帧，不输出交互） |
| 其他 | 进灰区（轨 B + 内容差二次拆分） |

#### 轨 B：视觉兜底（仅结构锚不足时）

1. 渲染缩略图，灰度化，垂直位移搜索（NCC/相位相关）。
2. 输出 `offset`、`NCC`、`MAE`；同时计算 **ROI 局部 NCC**：
   - `headerBand`：由检测到的顶部 bar/header 节点决定（不写死 30%）；
   - `contentBand`：其余区域；
   - 顶部低、内容高且有垂直位移 → 典型的 header 折叠/局部滚动信号。
3. 判定：
   - `NCC >= 0.9` 且 `offset >= 50` 且结构轨支持 → 提升结构轨置信；
   - `NCC >= 0.9` 且 `offset < 8` 且 `contentDiff >= 阈值` → `state-change`；
   - `NCC < 0.6` → `different-screen`（静默计数，不提问）；
   - 其他 → 灰区。

#### 灰区二次拆分

灰区对在最佳偏移处计算内容差：

| 内容差 | 分类 | 是否提问 |
|---|---|---|
| 小 | 弱 `state-change` 候选 | 是（按屏分组、每屏上限） |
| 大 | `different-screen` | 否（兄弟屏是常态，静默计数） |

#### 配对会计

每次运行输出：

```json
{
  "frames": 23,
  "pairsEvaluated": 253,
  "structuralPairs": 8,
  "visualPairs": 3,
  "scrollCandidates": 2,
  "stateChanges": 5,
  "duplicates": 12,
  "overlays": 1,
  "gray": 4,
  "differentScreen": 220,
  "unpaired": 2,
  "deduped": 3
}
```

零候选时必须输出 `pairingStats` + `warning: "no-pair-candidates"`，不能只给空数组。

**去重**：整帧 `n6dGB` 与其子容器 `pEfey` 内容近乎相同，可能同时对 `OFftq` 成候选。按“同 before/after 子树包含关系 + delta 相近（±8）”合并：保留更深/支持度更高的容器，`deduped` 计数；POC gate 的“≤5 条”按去重后计。

#### 其他规则

- **方向**：`deltaMode > 0` 表示 after 的内容上移；若为负则交换 before/after。`d` 的符号约定写进类型注释与测试。
- **viewport null**：只走结构轨；视觉轨跳过，记 `visual-skipped-no-viewport`。
- **命名**：仅当结构轨/视觉轨同分时作为 tie-breaker；改名不变性测试必须仍通过。
- **动态文本**：匹配前做归一化（数字/日期/价格/点数/问候语替换为占位）；title takeover 需排除纯动态文本，避免假阳。

### 5.3 Stage 2：几何折叠推断

对每个 `scroll-collapse` 候选：

1. **绝对几何**：通过 `GeometryProvider.absoluteBox` 取绝对 `y`；auto-layout/mask/fill-container 已由布局引擎解析，禁止裸累加祖先 y；缺 box 走 `Geometry.missing`。
2. 按文本 + 相对几何 + 几何锚匹配主态/滚动态节点；匹配不上时按子树相似度。
3. `deltaMode` 取匹配文本/几何锚位移众数；`deltaSpread` 取 MAD/IQR；`support` 取众数占比。
   - **takeover 匹配器独立运行**：先按 title 相似度找 takeover 对，再从位移统计中排除；避免 tab 文本与 bar 标题同为「到店自取」时 Δy≈44 污染众数。
   - POC 报告记录“未发生碰撞”的原因（文本附加内容/不同节点/归一化差异），不能只报结果。
4. 判定：
   - **sticky（双态不变）**：`abs(Δy) <= 8` 且滚动态仍在视口内；
   - **takeover-bar（新出现）**：滚动态顶部出现新 bar，`y <= 8`，且其标题文本承接自某个 collapsed 节点；
   - **collapsed**：主态可见，滚动态 `y + height <= 0` 或超出视口/被 clip；
   - **title takeover 匹配**：takeover-bar 文本与 collapsed 节点文本满足以下之一：
     - 归一化包含（bar 是 collapsed 的子串，或反之）；
     - Levenshtein 相似度 ≥ 0.8；
     - 二者均有长度 ≥ 4，且排除通用词（返回/关闭/確認/首頁/更多等）。
     纯动态文本（日期/价格/问候语）不参与 takeover 判定。
5. 输出候选：

```json
{
  "kind": "scroll-collapse",
  "delta": { "designPx": 360, "devicePoints": 360 },
  "pairing": {
    "track": "structural",
    "score": 0.91,
    "matchedTexts": 84,
    "matchedAnchors": 0,
    "anchorSupport": 0,
    "support": 1.0,
    "offset": 360,
    "deltaMode": 360,
    "deltaSpread": 0
  },
  "sticky": [
    {
      "id": "eYA0l",
      "name": "App Bar",
      "text": "到店自取",
      "origin": "takeover",
      "region": "header"
    }
  ],
  "collapsed": [
    { "id": "rB7Ea", "text": "到店自取", "region": "content" }
  ],
  "titleTakeover": { "bar": { "id": "eYA0l" }, "from": { "id": "rB7Ea" } },
  "provenance": { "kind": "inferred", "basis": "structural", "score": 0.91 },
  "evidence": [
    "84/84 text nodes at delta 360",
    "tabs y 44 -> -316",
    "App Bar at y=0 with title 到店自取",
    "container y 44 -> -360 (origin shift, excluded)"
  ]
}
```

> 注：容器 `44 → -360 = 404` 不参与 delta；它是 header 移除后的原点变化。v5 的 delta 以文本位移众数为准，避免 v1 的 360/404 矛盾。

### 5.4 Stage 3：LLM 复核（可选）

- 只对低置信、结构轨与视觉轨冲突、或灰区弱候选调用。
- 输入：前后帧截图 + 结构化问题。
- 输出经 zod 校验：

```ts
const VisionLabel = z.object({
  pair: z.enum(["same-screen-scroll", "state-change", "different-screen"]),
  sticky: z.array(z.string()),
  collapsed: z.array(z.string()),
  reason: z.string()
});
```

- 结果只能标记 `vision-inferred`，不能直接升断言。
- 几何与 LLM 冲突 → `unknown + question`，不猜。
- LLM 结果不参与“是否生成问题”的唯一决定；结构轨优先。

### 5.5 Stage 4：真机滚动探测（observed）

**独立仪表化通道，不内插测试步骤**，避免撞 30 步上限。

范围与预算：

- 只探测**有 inferred 候选**的屏；不做全屏清扫。
- **粗扫 + 二分**：
  1. 粗扫步长从 `overflow` 派生（如 `min(400, max(100, overflow/4))`），不固定 0/400/800/1200；找到首个发生变化的区间 `[prev, firstChange]`；
  2. 在区间内二分 4–6 次，逼近首次变化偏移，精度目标 ≤16pt；
  3. 记录 `firstChangePoints`、`fullEffectPoints`（logical：iOS pt / Android dp）、方向、`probeMode: "coarse+binary"`；
  4. 回滚验证恢复（`restored`）。
- **单调性保护**：header 折叠可能非单调（下滑隐藏/上滑显示）；若二分结果不稳定或变化点来回跳，回退线性 50/100px 扫描，并记 `probeMode: "linear-fallback"`。
- 每段截屏 + AX/元素 bbox；检测：
  - header 高度/位置何时变化；
  - 取货方式 tabs 何时离开视口；
  - 顶部是否出现新 bar/标题；
  - 下滑是否恢复。
- 失败步骤中途采集的观察不得直接入缓存；至少标 `context: "failure-path"`，默认不升断言。

缓存：

- 路径：`.artemis/design/interactions.observed.json`。
- **observed 强指纹**：项目 + screenId + 设备型号/OS + **app 版本/build** + 设计指纹。
- app 版本/build 变化时，observed 缓存不得用于生成断言；标记 `stale`，重新探测或降级为 `unknown`。
- **inferred 软缓存**：可按设计指纹复用，只用于候选/问题，不进入断言；后台可静默复核。
- 缓存只存 observed，不存 inferred 的断言结论。

输出：

```json
{
  "kind": "scroll-collapse",
  "provenance": { "kind": "observed", "evidence": ["probe:300pt"] },
  "screenId": "Z4OR6X",
  "unit": "logical",
  "nativeUnit": "pt",
  "thresholdSignal": "structural",
  "firstChangePoints": 120,
  "fullEffectPoints": 300,
  "sticky": ["App Bar"],
  "collapsed": ["Pickup method tab"],
  "restored": true,
  "evidence": { "before": "...", "after": "..." }
}
```

### 5.6 Stage 5：升权与交叉校验

- `inferred` → 只能进 `reading.interactions` / `reading.questions`。
- `observed` → 可生成结构不变量断言（`toScrollAssertion`）。
- 人工确认（测试人员）→ `confirmed`，可生成断言；必须回写 flows/reading，避免问题每天重生。
- **交叉校验（结构验证，不做数值硬比对）**：
  1. probe 记录 `firstChange`（首次结构变化）与 `fullEffect`（afterScroll 的 DeviceQuery 全部成立的最早偏移）；`threshold` 明确取**结构变化信号**，不取内容像素位移。
  2. 在设计 `deltaMode` 换算到逻辑单位（iOS pt / Android dp）的偏移处，直接执行 `afterScroll` 的 DeviceQuery：
     - 全部成立 → 通过；
     - 不成立 → 降级 `unknown + question`，视为潜在误配。
  3. `fullEffect` 与设计 delta 的差异只作 info 记录，不单独触发降级；渐进折叠下二者天然不同。
- `Assertion` 不携带精确 delta；精确值留在证据/报告。

## 6. 与现有模块的集成

| 模块 | 变更 |
|---|---|
| `src/design/reading/types.ts` | 新增 `Geometry` / `Provenance`（含 confirmed）/ `InteractionCandidate` / `ObservedInteraction` / `PairingStats` |
| `src/design/reading/scroll.ts`（新） | 纯函数 `pairFrames`、`classifyPair`、`inferScrollCollapse`、`pairingStats` |
| `src/design/reading/run.ts` | 保留 state frame + geometry；输出 `states` / `interactions` / `pairingStats`；`knownStates` 派生 |
| `src/design/reading/answers.ts` | 交互问题确认；确认结果回写 flows/reading |
| `src/figma/test-gen.ts` | 只消费 `Assertion`；`inferred` 只生成 `explore` |
| `src/figma/suite-runner.ts` | 失败步骤/滚动探测补充 observed 证据；UI diff 优先失败屏 |
| `src/ui/contract.ts` | 状态帧纳入契约；保留 per-screen `.pen` |
| `reading.json` | 新增 `states` / `interactions` / `pairingStats` |
| `flows.json` | `states` 保留 `stateId/frameName/geometry`；confirmed 交互写入 |
| 响应 | `reading.interactions` 摘要；推断仅 warning；`pairingStats` 可见 |

依赖顺序：

- 本方案依赖 **design_reading 当前在途实现** 落地后的 `reading.json` 形状；先合 design_reading，再合本方案。
- Phase 1 的 `DesignSnapshot` **只服务交互推断**；不做 flows/reading/contract/tests 的全量派生重构（避免原则 8 的越界授权）。
- 旧 `knownStates` 保留派生；新字段默认空数组；旧项目缺 geometry 走 `missing`。

## 7. 测试与校准计划

### 7.1 纯函数 fixture

> fixture 从 `.pen` 渲染/合成帧生成，不使用用户截图；截图只作为人工复核参考。

1. **搜尋空态 vs 已搜尋**
   - 实测：`d=0`、`NCC=0.975`、33 个匹配文本、32 个 delta 0、文本集合 43 vs 37。
   - 期望：`state-change`，不是 `scroll-collapse`。
2. **行動預點主态 vs 下滑态**
   - 实测：`d=360`、`NCC=0.683`、84/84 文本 delta 360、App Bar 仅滚动态出现。
   - 期望：`scroll-collapse`，`deltaMode=360`，`sticky=App Bar`，`collapsed=Pickup tabs`，`support=1.0`。
3. **复制/改名**
   - frame 改名、节点 id 不同；期望结果不变。
4. **无关页面/兄弟屏**
   - 共享 chrome、内容不同；期望 `different-screen` 或灰区小内容差 → question，不静默。
5. **重复帧**
   - `d=0`、无内容差；期望 `duplicate`，不输出交互。
6. **缺 bbox / viewport null**
   - 期望 `Geometry.missing`，只走结构轨；视觉轨记 `visual-skipped-no-viewport`。
7. **小位移**
   - `d=44`（搜索栏收缩量级）；期望进入灰区并输出 question，不静默。
8. **边界值**
   - `0.899/0.9`、`0.599/0.6`、`0.799/0.8`、`49/50`、`7.9/8`、`support 0.799/0.8`、`contentDiff 0.199/0.2`、`takeover 0.799/0.8`。
9. **动态文本**
   - 日期/价格/问候语变化；期望不被误判为 title takeover 或 state-change。
10. **纯图标界面**
    - 无文本、8 个同尺寸图标/图片占位一致位移；期望走几何锚识别为 scroll，不瘫痪。
11. **同名控件**
    - 顶部/底部各有一个「確認」；顶部折叠后只断言 `region:"header"` 的 `absentText`，不误伤底部。
12. **Auto Layout / Mask**
    - 父节点 auto-layout、子节点无裸 y；期望 Stage 0 取绝对 box，结果与展平坐标一致，不出现错误 delta。
13. **takeover 截断/相似**
    - App Bar 标题是原 tab 文本的子串或 Levenshtein ≥0.8；期望识别；短通用词（確認/返回）不误配。
14. **ROI 局部匹配**
    - 顶部 NCC 低、内容区 NCC >0.9 且有垂直位移；期望进入 scroll 候选，不入灰区提问。
15. **视口归一化**
    - 1713 高的 `OFftq` 是 `full-content`，不是独立屏；855 高的状态帧是 `viewport-state`。
    - `w8OHy → CSMVD/uorYu` 在 855 视口内分别为 47/49、46/48 个文本 `Δy=0` → `state-change`，不是 scroll。
    - 两个 `full-content` 不配对；`component` 不参与屏配对。
16. **长页/弹层**
    - 长页只比较视口内；弹层归 `overlay`，不参与屏配对；pre/post 由 runtime probe 提供，不假定管线已有。
    - `full-content` before 的“可见”定义为视口窗 `y ∈ [0, viewportHeight)`；窗外的节点不算可见。

### 7.2 离线校准

- 用 starbucks 真稿 + 兄弟屏跑一次配对分布：
  - 每屏对数、结构轨/视觉轨命中、灰区、different-screen、questions 数。
- 常量集中为 `PAIRING_BANDS`（对齐 `CHECKUP_BANDS` 先例）：

```ts
const PAIRING_BANDS = {
  minMatchedTexts: 8,
  minMatchedAnchors: 4,
  minScrollDelta: 50,
  minSupport: 0.8,
  stateDeltaMax: 8,
  visualNccStrong: 0.9,
  visualNccDifferent: 0.6,
  contentDiffStateChange: 0.2,
  takeoverSimilarity: 0.8,
  probeCoarseStep: 400,
  probePrecision: 16
} as const;
```

- 校准结果写入交付说明；阈值变更需更新 fixture。

### 7.3 集成测试

- `design_to_test`：reading 输出 interactions；inferred 不生成 assert；observed/confirmed 生成结构不变量。
- `suite run`：探测独立通道；不增加 case 步数；缓存指纹含 app 版本。
- 探测非单调：mock 在 250px 折叠、600px 恢复；二分不稳定时回退线性，仍记录 250。
- 缓存 build 变化：旧 build 的 observed 不得生成断言，标 stale 并重探。
- 回归：旧项目无 state frames 时行为不变。

### 7.4 真机验收

- Starbucks `行動預點`：探测到 `firstChange` 约 100–150pt、`fullEffect` 约 300–400pt；tabs 隐藏；App Bar 出现；下滑恢复。
- Starbucks `產品搜尋`：无折叠，仅键盘/搜索状态变化；不生成 scroll 断言。
- 失败时证据截图 + AX 落盘；失败路径观察默认不升断言。

### 7.5 性能与预算

- 帧配对预筛仍枚举 n²，但只对候选对跑贵操作（缩略图 NCC/渲染）；200 屏需 `AOS_PAIRING_MAX_PAIRS` 上限与降级。
- 缩略图最长边 ≤ 480px；结果缓存。
- 23 屏项目目标：离线配对 < 2s；真机探测只对有候选的屏，每屏一次，缓存复用。
- 大稿（>50 屏）显式声明不在首版性能目标内，或按 cap 截断并告警。

## 8. 分阶段落地

### Phase 0：POC gate（无设备，先证明不是想象）

- 用 starbucks 真稿跑容器级配对 POC，产出 `PAIRING_BANDS` 初值与分布报告。
- 必须验证：
  - 视口归一化：`w8OHy → CSMVD`（47/49 Δy=0）、`w8OHy → uorYu`（46/48 Δy=0）→ state-change，不是 scroll；
  - `full-content`（OFftq 1713）不被当成独立屏；`full-content + viewport-state` 才允许 scroll；
  - 内容容器/视口对 MOP 360/84；
  - 搜尋 0/33/文本集合差异；
  - 状态栈（單品頁/訂單狀態）不产生 scroll；
  - 全屏 `Z4OR6X → n6dGB` 不被误判；
  - 候选数量与误报在可复核范围。
- 验收：**POC 报告 + go/no-go**；报告必须含 70 帧渲染宽高分布、questions 预算、state-change FP 清单、106→≤5 归因表。不达标停止，不改运行时代码。

### Phase 1：类型与离线推断（无设备）

- 引入类型；保留 state frame geometry。
- 实现**容器级** `pairContainers`（先选 scroll container / state frame，再配对）+ `classifyPair` + `inferScrollCollapse` + `pairingStats`。
- 全屏 frame 只作为容器宿主，不直接作为滚动对。
- `reading.json` 输出 `interactions` / `pairingStats`；不升断言。
- 验收：搜尋对 `state-change`；MOP 对 `scroll-collapse` delta 360；改名不变性通过；纯图标 fixture 走几何锚；auto-layout fixture 使用绝对 box。

### Phase 2：真机探测（observed）

- 独立探测通道；只探测有候选的屏；缓存指纹含 app 版本。
- 首次 observed 后生成结构不变量断言；未探测到的屏仍只探索。
- 验收：真实设备上观察到 tabs 隐藏/App Bar 出现/恢复；断言不含精确 delta。

### Phase 3：LLM 复核与 UI diff 联动

- 低置信候选交给视觉模型；zod 校验；仅 `vision-inferred`。
- UI diff 优先比较“有 observed 交互的屏”和失败步骤屏。
- 面板展示 `interactions` / 证据 / 置信度 / pairingStats。

## 9. 待决问题与建议答案

| # | 问题 | 建议 |
|---|---|---|
| 1 | 两阶段是否接受；探测是否默认开 | 接受；默认开，但 scope=有候选的屏 + 独立探测通道 |
| 2 | inferred 是否进 questions | 进；按屏分组、每屏上限、带 score/evidence |
| 3 | observed 是否自动升断言 | 升，但只落结构不变量；可选前 N 次 probation 只报告 |
| 4 | 范围 | 候选做 scroll-collapse + state-change；断言只做 scroll-collapse；sticky 随折叠免费产出；tab-switch 推迟 |
| 5 | knownStates 是否保留 | 保留派生（兼容面板）；`states` 为几何事实源 |
| 6 | 缓存是否按 app build 软失效 | observed 断言必须匹配 app 版本/build；inferred 证据可软缓存，但不得升断言 |

## 10. 验收标准

- Starbucks 真稿：
  - `產品搜尋` 两态 → `state-change`，无 scroll 断言；
  - `行動預點` 主态/下滑态 → `scroll-collapse`，`deltaMode=360`，`support=1.0`，sticky=App Bar，collapsed=Pickup tabs；
  - 改名/复制 id 后结果不变；
  - `inferred` 不产生硬断言；
  - 真机探测记录 `firstChange` / `fullEffect` 并生成 observed 证据；
  - 设计 delta 处的 `afterScroll` 结构查询成立性交叉校验生效，不成立才降级 unknown。
  - 纯图标 fixture 通过几何锚识别；auto-layout/mask fixture 的绝对坐标与展平结果一致。
  - 同名控件（顶部/底部「確認」）只命中 `region:"header"`；底部不被误伤。
  - 非单调探测回退线性，记录 firstChange/fullEffect；app build 变化时旧 observed 不生成断言。
- 配对会计：零候选/灰区/未配对可见，不静默。
- 全量测试通过，lint 0 error。
- 文档：评审通过后把最终决策写入 `DESIGN.md`，本文件保留为设计说明或归档。

## 11. 附录：Starbucks 实测

### 11.1 配对指标

> 测量方法：pen CLI 将两帧渲染为 PNG，灰度化后扫描垂直偏移，取 NCC 最大值为最佳 `d`；文本节点按归一化文本匹配，统计 `Δy` 众数与支持度。

| 对 | 尺寸 A→B | 最佳 d | NCC | MAE | 匹配文本 | 位移众数 | 支持度 |
|---|---|---|---|---|---|---|---|
| `OFftq → pEfey`（MOP） | 375×1713 → 375×812 | 360 | 0.683 | 6.61 | 84 | 360 | 84/84 |
| `j6XA0 → RVg6w`（搜尋） | 386×855 → 386×855 | 0 | 0.975 | 2.08 | 33 | 0 | 32/33 |

### 11.2 位移分布

- MOP：84 个匹配文本节点全部 `Δy=360`；容器 `44 → -360 = 404` 是原点变化，排除。
- 搜尋：32 个 `Δy=0`，1 个 `Δy=8`；文本集合 43 vs 37，存在内容变化 → `state-change`。

### 11.3 当前差距

- `reading.json`：`knownStates` 有值，`states: []`。
- `flows.json`：所有边 `inferred/vision-inferred`，`confidence=low`。
- `tests.json`：228 条，`assertions=0`。
- UI diff：每个 case 只比较前 3 屏。

## 12. 编码前实现细节（v6）

### 12.1 归一化：一个函数，两个视图

Stage 1 的 `contentDiff` 和 Stage 2 的文本锚匹配必须用同一套归一化，否则会出现“匹配上了但 Jaccard 算错”。

```ts
/** 用于集合比较与文本锚匹配；原始文本保留在 evidence。 */
export function normalizeTextForSet(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, "")
    .replace(/[，。！？、；：""''（）【】《》]/g, "")
    .toLowerCase();
}

/** 动态值占位；避免日期/价格/问候语/账号名污染匹配与 Jaccard。 */
export function normalizeForMatch(raw: string): string {
  return normalizeTextForSet(raw)
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, "<date>")
    .replace(/\d{1,2}:\d{2}/g, "<time>")
    .replace(/[$＄]\s?\d+/g, "<price>")
    .replace(/\d+\s*(元|起|杯|件|點|星)/g, "<count>")
    .replace(/^(早安|午安|晚安|goodmorning|goodafternoon|goodevening).*/i, "<greeting>");
}
```

约束：

- `normalizeTextForSet` 只做字符级归一化；动态值占位只在 `normalizeForMatch` 做，避免把商品名里的数字误吞。
- 两个函数在 Stage 1/2 复用；evidence 保留原始文本与归一化文本。
- 单测覆盖：NFKC、全半角标点、空白、日期/时间/价格、问候语、账号名。

### 12.2 takeover 两遍扫描

```ts
// Pass 1：只标记候选，不修改节点
const takeoverIds = new Set<string>();
for (const bar of topBars(after)) {
  const from = findBestTitleMatch(bar, beforeNodes); // contains / Levenshtein >= 0.8
  if (from) takeoverIds.add(bar.id);
}

// Pass 2：位移统计排除 takeover 候选
const displacementPool = matched.filter((m) => !takeoverIds.has(m.afterId));
const deltaMode = mode(displacementPool.map((m) => m.dy));
```

- Pass 1 不 mutate 原始节点/匹配数组；evidence 仍保留全部候选与相似度。
- 若节点无稳定 id，用 `text + path + bbox` 生成稳定 key；不要把可变文本当唯一 key。
- 记录“未发生碰撞”的原因（文本附加内容、不同节点、归一化差异），不能只报结果。

### 12.3 overflow 派生步长

```ts
export function probeStep(overflow: number): number | null {
  if (!Number.isFinite(overflow) || overflow <= 0) return null; // not-scrollable
  return Math.min(
    overflow,
    Math.min(400, Math.max(100, Math.round(overflow / 4)))
  );
}
```

- `overflow <= 0` → `not-scrollable`，不探测、不生成 scroll 候选。
- 粗扫 offsets 必须包含 `0`、`step`、`2*step`…以及 `overflow`；若 `step === overflow`，直接做单区间二分。
- 二分精度目标 ≤16pt；非单调时回退线性 50/100px。

### 12.4 assertNever 与严格模式

```ts
export function assertNever(value: never): never {
  throw new Error(`unexpected variant: ${JSON.stringify(value)}`);
}
```

- `tsconfig` 已 `strict: true` 且 `noFallthroughCasesInSwitch: true`；保留 `assertNever`，Phase 2 新增成员时让编译器报红。
- 单测/类型测试至少覆盖：新增 `state-change` 到联合但未处理时，`tsc` 失败（可用 `@ts-expect-error` 或独立 type-test 文件）。
- 不在生产路径用 `return null` 代替未处理分支。

### 12.5 落笔顺序

1. 先跑 Phase 0 POC，产出 70 帧渲染宽高分布、106→≤5 归因表、questions 预算、state-change FP 清单。
2. POC 通过后再把“已实现/已验证”的决策写入 `DESIGN.md`；未通过的假设留在本文件，不写成事实。
3. 本文件保留完整变更史；`DESIGN.md` 只放规范正文与最终决策。

### 11.4 POC 第 0 步：70 帧渲染宽高分布（已实测）

```text
渲染：70/70 成功，0 missing，35.4s
宽度：375×31、7900×5、415×4、948×2、126×2、376×2、31×2、3807×2、2945×1、475×1…
高度：855×12、44×8、173×4、941×2、958×2、67×2、37×2、1194×2、891×2、1202×1、1040×1、2118×1…
```

结论：

- **主视口是 375×855**（12 帧），不是之前假设的 375×812。
- **59/70 的 raw `height` 为空**，视口自举必须用渲染宽高，不能用 raw `height`。
- `w8OHy`（單品頁）是 375×2118 的 `full-content`；`x5PCoA` 475×1040 是弹层/`overlay` 候选；`U2rRt` 4546×1487、`P3urv` 890×958 是整板拼图，需容器级处理。
- 搜尋 `386×855` 与主视口 375×855 的宽/宽高比差为 2.9%，按宽高比判据通过；旧假设的 `855/812=1.053` 不成立。

> 这一步就是“先证明不是想象”：70 帧分布、视口聚类和旗舰边界都由实测决定，不再由假设决定。

## 13. Phase 0 POC 实测结果（v6，2026-10-27）

> 详细报告：`.scratch/design-interaction-poc/report.md`；脚本：`poc.mjs` / `poc2.mjs`。

### 13.1 Step 0

```text
70 board 子 frame：70/70 渲染成功，35.4s
主视口：375×855（12 帧），不是 375×812
59/70 raw height 为空 → 必须用渲染宽高
```

### 13.2 容器级 POC

```text
渲染 219 个容器：overlay 75 / full-content 95 / viewport-state 46 / component 3
pairs 47,742；textOverlap 1,724；scrollRaw 978；scrollKept(NCC>=0.65) 28
stateChange 260；duplicate 78；gray 112；blocked 28,298
```

目标对：

| 目标 | 结果 | 判定 |
|---|---|---|
| MOP `OFftq → pEfey` | mode 360，support 1.0，matched 55 | 通过 |
| 搜尋 `j6XA0 → RVg6w` | mode 0，support 0.97，contentDiff 0.214 | 勉强通过（距 0.2 仅 0.014） |
| 單品頁 `w8OHy → CSMVD` | mode 0，support 0.95，contentDiff 0.137 | 未通过（duplicate） |
| 單品頁 `w8OHy → uorYu` | mode 0，support 0.98，contentDiff 0.125 | 未通过（duplicate） |

### 13.3 Gate 判定

**未通过**：

- scroll 候选 28 > 5；
- 状态栈被判 duplicate，不是 state-change；
- takeover `appBarTexts` 为空（文本过滤/绝对 bounds 问题）；
- 跨屏共享文本产生伪滚动对（top 候选 `s1gOwt → ZBvxJ` 等）。

### 13.4 结论与下一步

- 信号层成立（MOP 360/55、搜尋 0/33）；
- 自动化层未成立；
- **不进入 Phase 1、不接 `design_to_test`、不写 `DESIGN.md`**；
- 下一轮 POC 前置：屏族分组（同 board + 视觉相似 + 共享 chrome）、容器去重、state-change 改用 changed node/局部几何信号、takeover 用绝对 bounds。

### 13.5 第二轮 POC（poc3，屏族 + 去重）

```text
219 容器：overlay 48 / full-content 108 / viewport-state 63
scrollRaw 148 → scrollKept 2 → 去重后 1
stateChange 982 → 去重后 319
gray 252 → 去重后 126
```

目标对全部通过：

| 目标 | 结果 |
|---|---|
| MOP `OFftq → pEfey` | mode 360，support 1.0，NCC 0.68，takeover「到店自取」 |
| 搜尋 `j6XA0 → RVg6w` | mode 0，support 0.97，contentDiff 0.214 |
| 單品頁 `w8OHy → CSMVD` | mode 0，support 0.95，contentDiff 0.137（阈值 0.1） |
| 單品頁 `w8OHy → uorYu` | mode 0，support 0.98，contentDiff 0.125（阈值 0.1） |

Gate：

- **通过**：scroll 候选 1（≤5）、MOP 自动命中、搜尋/状态栈 state-change、takeover 证据。
- **未通过**：state-change 去重后 319 条、gray 去重后 126 条，仍不可复核；questions ≤20 未达标。
- 结论：核心滚动检测达标；状态/问题清单未达标。不进入 Phase 1。

下一轮只做 state-change 邻接/分组、gray 收敛与归因表；不改生产代码。

### 13.6 第三轮 POC（poc4）：gate 通过

```text
scrollRaw 146 → scrollKept 1
stateRaw 190 → stateAll 60 → stateKept 11
grayRaw 6 → grayKept 3
```

- 唯一 scroll：`OFftq → pEfey`，mode 360，support 1.0，NCC 0.68，takeover「到店自取」。
- 目标对全部通过：MOP / 搜尋 / 單品頁两个状态。
- state-change 复核清单 11 条；questions 3 条。
- Gate：scroll ≤5（1）、state 清单 ≤20（11）、questions ≤20（3）、106→1 归因完成 → **通过**。

保留意见：state 清单中仍有 NCC0 <0.5 的跨屏候选（如 `OuQxr → Z4OR6X`），Phase 1 必须标低置信、不直接升断言。

### 13.7 Phase 1b：核心接入 reading

- `src/design/reading/interaction.ts`：纯函数 + 类型；`src/design/reading/frames.ts`：从 flows/逐屏 `.pen` 组装 frame、渲染内容容器、缓存 pen 文本绝对 bounds。
- `ReadingFile` 增 `interactionCandidates` / `pairingStats`；`reading.json` 已落盘，仍不升断言。
- 真实 starbucks：100 帧 → scroll 2（MOP 360/takeover + `Myrgb→A5MwD` 待复核）、state 15、questions 20；首跑 343s（pen bounds），缓存后 1.4s。
- 测试 2381 绿；lint 0 error。

### 13.8 Phase 2：真机滚动探测

- `probe.ts`：分段上滑 + 二分 fullEffect + 回滚恢复；输出 observed（`unit: "logical"`，`nativeUnit: "pt" | "dp"`；firstChange/fullEffect）。
- 内部库，**不新增独立用户命令**；产品入口仍为 `design_to_test`。缓存 `.artemis/design/interactions.observed.json`（screen+device+appVersion+designFingerprint）。
- `toScrollAssertion` 用 origin/region 生成结构不变量；仍不自动写 tests。
- 平台无关：iOS（points/idb/WDA）与 Android（adb/uiautomator，适配器内 px→dp）共用同一个探测与缓存；平台差异只是设备 I/O 适配器；需设备已停在目标屏。
- **RN/Flutter 不单独分叉**：它们是跨端框架，运行时仍是 iOS/Android；只按设备 serial 选适配器。若 accessibility/semantics 未开启导致 AX 文本为空，返回 `observation-no-ax-text`，不按框架猜。
