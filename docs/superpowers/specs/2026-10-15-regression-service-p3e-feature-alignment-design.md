# 回归服务 P3e 设计（跨项目功能对齐：同源功能对照）

> 2026-10-15 · 前置：P3c（§13.112 跨项目对比视图）已落地；本设计补 P3c 明确推迟的「功能级跨项目匹配」——**先定匹配规则与误报口径**（P3c 设计 §3 非目标第 1 条）。
> 状态：builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

P3c 的对比视图是**项目级**。当同一条产品线以多份项目并存（同设计源、不同仓库/环境/客户变体）时，负责人还需要**功能级**对照：「登录流程」在 A/B/C 三个项目里的通过率、失败域、待办各如何？

难点＝「什么算同一个功能」：feature key 项目内独立（各自生成时分配），因此跨项目匹配**不能靠 key**。可用信号：

| 信号 | 可靠性 |
|------|--------|
| `case_sets.source`＝设计源（`figma:<fileKey>` / `pen:<相对路径>`） | 强——同设计源意味着同流程结构 |
| 功能名（`featureName`，如「登录流程」） | 中——同源时由同一流程切分产生、命名一致；跨源时是巧合 |
| feature key | 无——项目内独立分配 |

**v1 规则（保守优先，宁缺勿蹭）**：匹配组＝「**同设计源身份 ＋ 归一化功能名**」，且组内 ≥2 个项目才展示。

## 2. 范围

### 2.1 匹配规则（D1/D2/D5）

- **源身份归一化**（D8）：
  - `figma:<fileKey>` → 取 `figma:` 后首个 token 为身份（忽略其后的 ` (文件名)` 装饰）；
  - **绝对/相对文件路径**（如管道产出的 `<项目>/.artemis/design/flows.json`）→ **相对该项目根做 posix 化＋小写**（同布局项目即可对齐；越界/不可相对化则原样小写）——默认 `.artemis/design/flows.json` 相对形式在三项目间一致；
  - `pen:<relPath>` → posix 化＋小写；
  - 其余形式原样小写参与匹配。
  - **已声明边界（误报口径注明）**：同一 Figma 文件「工具 url 形式（`figma:<key>`）vs 管道路径形式（相对路径）」**不互相匹配**（v1 纯文本归一化；P3+ 可经 flows.json 内 fileKey 增强）。
- **功能名归一化**：NFC → trim → 连续空白折叠为单空格 → 小写（CJK 不变）。**不改词形**（不剥离「流程/页」等后缀、不做同义词）。名称**权威来源＝case set 的 `features[].name`**（本任务加载全量 case sets，见 D10）；无 case-set 映射的运行不进对齐表（仅计数）。
- **组键**＝`<源身份>|<归一化名>`；**仅组内项目数 ≥2 展示**；未匹配不列出。
- **未匹配计数（D10）**：`unmatched`＝「仅出现在 **1 个项目**中的组键数量」（distinct `<源身份>|<归一化名>` 组键中项目数 <2 的个数）。
- **误报口径（必须随视图展示）**：对齐基于「同设计源＋名称归一化」，是**并列对照**而非统计合并；同名不同源不匹配；不做自动别名。

### 2.2 数据与窗口（D2/D7）

- 数据源＝对比视图**同一窗口**：各项目「份血统运行最近 20 批」（读取 limit 40 → 过滤 → 前 20）。
- 每项目新增一次 `listCaseSets(rootPath)`（**缺省全量**——P3b 先例：默认全量、展示路径显式传 50）得到 `caseSetId → { source, featureNames }` 映射；**保证窗口内老份也能映射**（限 20 会漏旧份，builder-check Q2）。无映射的运行不进对齐表（仅计数）。
- **聚合单位＝(caseSetId ?? "", featureKey)**（跨代 feature key 可能在窗口内跨多个份/源，Q3）；随后**按（项目, 源身份, 归一化名）合并**（Σ passed/Σ total、Σ runs、Σ flaky、Σ pendingVerdicts、max latestAt）。
- 每（项目 × 功能）指标（窗口内汇总，口径注明）：`passRate`＝Σ passed / Σ total（total=0 → null）、`runs`＝批次数、`flaky`＝Σ run.flaky、`pendingVerdicts`＝窗内该功能未裁决发生次数（**run.featureKey 过滤 ＋ P3c 同款谓词** `status !== "passed" && verdict === null`）、`latestAt`＝最近批次时间。

### 2.3 展示与 JSON（D3/D4）

- 载体＝**P3c 对比页第二区块**「功能对齐（跨项目）」（不新增视图）；`/panel.json?view=compare` 响应增 `featureAlignment`（加性字段，向后兼容）。
- 区块渲染：每组＝表头（显示名＋源身份＋项目数）＋小表（项目/通过率/批次/flaky/未裁决/最近）；**组间排序**：项目数降序 → 通过率极差（max-min，null 视为不参与）降序 → 显示名升序；空态（无 ≥2 项目组）：一行说明＋未匹配计数。
- **只并列、不合并**：不产出跨项目聚合通过率/总分；每行数据均标注来源项目。
- 口径说明行：匹配规则、窗口、误报口径、未匹配计数。

## 3. 非目标

- 手动别名/映射文件（P3+）；模糊/AI 匹配；同名不同源的「疑似」分组提示（v1 不展示，避免噪声）。
- 跨项目聚合统计（合并通过率、总分、排名）；跨项目动作（建任务/建单/重跑）。
- 历史对齐演进/趋势（仅当前窗口）；独立 CLI 子命令（JSON 面即导出）。
- 改变 P3c 项目级区块与窗口口径。

## 4. 硬约束

- 只读：无子进程/无网络/无写盘（沿用 `/panel`）；全部输出 `escapeHtml`。
- 性能：每项目新增 1 次 store 读（`listCaseSets`，**缺省全量**——保证窗口内老份可映射）——对比视图每项目 ≤5 次 DB 往返（原 4＋本 1），仍入 `PanelWebCache`。
- 测试口径：pg-mem/内存 store、假目录、不触网；测试跑 `dist/`。
- 文案中文、代码英文；默认无注释；相对导入 `.js`。
- 完工同步：DESIGN.md 新增 §13.114、README（对比视图章节）、AGENTS.md（面板行，如需）。

## 5. 关键决策（本次方案判断；可被否决/修订）

| # | 决策 | 理由 | 若否决的代价 |
|---|------|------|--------------|
| D1 | 匹配＝**同设计源身份 ＋ 归一化功能名**；组内 ≥2 项目才展示 | 同源是强信号；名称在源内由同一流程切分产生；双条件把误报压到最低 | 若允许跨源同名匹配（或仅名称），误报率上升、需另行定义人工裁决面 |
| D2 | 数据＝**对比视图同窗口**（份血统最近 20）；新增每项目一次 `listCaseSets` 做源映射 | 与 P3c 口径同源、成本有界；不引入新窗口概念 | 若改用 case-set 静态库存（含无运行功能），会混入无数据行 |
| D3 | 载体＝**P3c 对比页第二区块＋JSON 加性字段**；不新增视图 | 与项目级对照同页最自然；避免视图/f导航膨胀 | 若独立视图，路由/渲染/文档面变大 |
| D4 | **只并列、不合并统计**；每组标注源与匹配规则 | 跨项目合并口径误导性高（不同应用变体语境不同） | 若要「合并分数/排名」，需先定义可比的合并口径 |
| D5 | 名称归一化**保守**（NFC/空白折叠/小写；不剥词形） | 宁缺勿蹭；剥「流程」等后缀会制造假匹配 | 若要求更宽，匹配率升、误报口径需重定 |
| D6 | 无手动别名（P3+）；未匹配项仅计数 | v1 控制面；别名机制需定义存储与冲突 | 若要立刻支持别名，需要中央存储与操作面 |
| D7 | 指标＝窗口内该功能汇总（Σ passed/Σ total 等），窗口口径与 P3c 一致 | 与项目级列同源可比；细节以统计视图为准 | 若按最新单批次，会受单次波动影响 |
| D8 | **源归一化含路径形式**：绝对/相对文件路径 → **相对该项目根** posix＋小写（跨项目同布局即可对齐）；同文件「url 工具式 vs 路径式」不互相匹配为**已声明边界** | 管道（无 url）是常见生成路径，其 source 为绝对路径——不处理则强信号静默失效 | 若要跨形式匹配，需读 flows.json 内 fileKey（额外磁盘读取，列 P3+） |
| D9 | **聚合单位＝（caseSetId, featureKey）**，再按（项目, 源身份, 归一化名）**合并**；名称权威＝case set `features[].name`；`listCaseSets` **缺省全量** | feature key 跨代稳定但可跨多份/多源；按 key 单聚合会错assign源；全量列表保证老份可映射 | 若限 limit 20，窗口内老份丢失（静默漏行）；若按 run.featureName 命名，或与冻结名漂移 |
| D10 | `unmatched`＝「仅出现在 1 个项目中的组键数」；无 case-set 映射的运行不进表（仅计数） | 一个数字、语义明确、可断言 | 若改为「条目数/组数」需重定测试口径 |

## 6. 接口草案（细节留给计划）

- **聚合**（`src/panel/compare.ts` 扩展或新小模块）：在既有 per-project 循环内收集 `Map<caseSetId|featureKey, { caseSetId, featureKey, name, passed, total, runs, flaky, pendingVerdicts, latestAt }>`；循环后按（项目, 源身份, 归一化名）合并 → **跨项目分组**：
  ```ts
  export interface PanelFeatureAlignmentEntry {
    project: string; featureKey: string;        // 合并后取首个（展示用）
    passRate: number | null; runs: number; flaky: number; pendingVerdicts: number; latestAt: string | null;
  }
  export interface PanelFeatureAlignmentGroup {
    sourceLabel: string;          // 原样 source（显示用；组内取首个）
    displayName: string;          // 组内首个名称（case set 冻结名）
    entries: PanelFeatureAlignmentEntry[];   // 每项目一行（≥2 项目）
  }
  // PanelCompareView 增（加性）：featureAlignment: { groups: PanelFeatureAlignmentGroup[]; unmatched: number }
  ```
- **归一化助手**（纯函数，便于单测）：`normalizeFeatureName(name)`；`normalizeDesignSource(source, rootPath)`（figma fileKey 提取 / **绝对或含分隔符路径 → `path.relative(rootPath, source)` 后 posix＋lower**（越界/不可相对化则原样 lower）/ pen 路径 posix＋lower / 其他 lower）。
- **渲染**（`web.ts`）：对比页第二区块（表头＋小表＋口径说明行）；escape 全字段。
- **降级**：单项目 `listCaseSets` 失败 → 该项目不参与对齐（项目级区块照常），计数如实；`error` 行不改。

## 7. 测试口径（映射，具体用例随计划）

| 面 | 覆盖点 |
|----|--------|
| 归一化 | figma source 带/不带「 (名)」装饰 → 同身份；**绝对路径 → 相对项目根 posix+lower**（跨项目同布局相等）；pen 路径 posix/大小写；**跨形式（url vs 路径）不匹配**（边界断言）；NFC/空白/大小写名归一 |
| 分组 | 同源同名跨 2 项目 → 成组；仅 1 项目 → 不展示且 `unmatched` 计数（定义：仅单项目出现的组键数）；同名不同源 → 不成组；同源异名 → 不成组；组排序（项目数→极差→名） |
| 指标 | Σ passed/Σ total、total=0→null、runs/flaky/latestAt 口径；**跨份同 key 合并**（Σ）与 name 来源＝case set 冻结名；无 caseSetId 映射的运行不进表；pendingVerdicts＝run.featureKey 过滤＋P3c 谓词 |
| 降级 | 单项目 listCaseSets 抛错 → 该项目不进组、其余照常、计数正确 |
| 路由/JSON | `featureAlignment` 加性字段形状；HTML 区块与口径说明行；空态＋未匹配计数；escape |
| 回归 | P3c 项目级区块/JSON 字段与既有测试不回归 |

## 8. 留给实现/计划的（不阻塞）

- 模块落点（compare.ts 内 vs `src/panel/feature-alignment.ts`）；组内 entries 排序（项目名升序）；极差计算的 null 处理；渲染列宽/表版式；文案措辞。

## 9. builder-check 复核记录（2026-10-15）

独立 subagent（只读文档＋相关代码）提出 5 个实质问题，全部在文档内定案、无遗留待用户问题：

1. **管道路径的 source 为绝对路径（`…/flows.json`），纯文本匹配会静默失效** → D8：源归一化含「绝对/相对路径 → 相对项目根 posix＋lower」；跨形式（url vs 路径）不匹配列为已声明边界。
2. **`listCaseSets(limit 20)` 可能漏窗口内老份** → D9：`listCaseSets` **缺省全量**（P3b 先例）。
3. **聚合单位 key vs (caseSetId,key)** → D9：按 (caseSetId, featureKey) 收集 → 按（项目,源,名）合并。
4. **名称权威来源** → D9：case set `features[].name`（冻结名）。
5. **`unmatched` 计数单位** → D10：仅出现在 1 个项目中的组键数。
- 低优先（已定）：`pendingVerdicts`＝run.featureKey 过滤＋P3c 同款谓词（`status !== "passed" && verdict === null`）。
