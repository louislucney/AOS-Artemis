# 设计多分叉 UI「不许静默漏」最小闭环

> 2026-10-19 · 前置：M6b/M6c（provenance / 双源对账）、§13.127–§13.132（视觉能力判定 / 全量屏 / 功能身份 / 生成上限）。
> 本设计解决：多类型/多状态分叉 UI 上的**静默漏检**——设计理解必须自己、及时把分叉摆到台面上，不能等用户发现"这里少了个东西"。
> 状态：brainstorm 定稿 → builder-check 已复核（§11）；实施计划另出。

## 1. 意图与判据

### 1.1 用户尺子（确认口径）

- 设计图是末端 UI 呈现，**主观反馈很难**；要的是链路在多个类型分叉的 UI 上**自己、及时**识别，而不是等用户反馈。
- 判据＝**召回 + 主动性**；底线是**不许静默漏**：识不出必须响亮标注、进对账/探索；不要求第一遍全部理解正确。

### 1.2 审计事实（2026-10-19，三路只读）

| 层级 | 现状 | 判据结论 |
|------|------|----------|
| 屏级跳过（vision） | 无几何 / 无渲染 / 单屏失败 / 拒图均有 warning；starbuckstw 实测 23/23 | 基本达标 |
| 截图 / 结构告警 | `screenshot-*`、`unreachable-screens`、`unresolved-destinations`、`no-interactions` 全量具名 | 达标 |
| 边与生成 | to:null 有探索用例；hard/explore 分档；截断 fail-closed；身份碰撞告警 | 基本达标 |
| **元素级完整度** | 只有识别到 **0 个**才告警；N 个设计候选只认出 M 个（M≥1）无信号 | **不达标（P0）** |
| **一条龙可见面** | `design_to_test` 只取 counts；generate/check/loop/report/panel/archive 不读 flows warnings | **不达标（P0）** |
| **变体分叉** | 30 个变体只做状态归并；只有主屏参与 vision；变体独有元素不进入识别 | **不达标（P0）** |
| 生成/对账细节 | 0 用例功能组、to:null 帽截停明细、旧 tests.json 缺 generation、反向观测未匹配 | 部分（P1） |

已核实的静默路径（本设计必须逐条堵）：

- `collectVisionScreens` 帧查不到时静默 `continue`（`src/pen/flows.ts:700-701`）；
- vision 回复 >40 条静默丢弃（`src/design/vision.ts:139`）；
- 单屏节点几何 >300 静默截断（`src/pen/flows.ts:731`）；
- 元素识别 M≥1 但明显偏少时无任何完整度信号；
- 变体帧不进入 vision，主屏识别无法代表变体；
- 下游可见面吞掉 flows warnings（`src/workflow/design-to-test.ts:208-224`、`src/figma/test-gen.ts:986-996`）。

## 2. 目标 / 非目标 / 反目标

**目标**

1. 每个屏、变体、候选交互元素、未决边：要么被识别，要么以**具名 warning / 计数 / 四态清单**暴露；任何新跳过路径必须过守恒不变量。
2. 一条龙入口（`design_to_test`）及生成、校验、报告、面板、档案都能看到设计源警告。
3. 真实分叉案例（starbuckstw：23 屏 / 30 变体 / 237 边 / 215 条 to:null）在无用户提示下可见其不确定性与覆盖缺口。

**非目标**

- 不承诺"视觉召回 100%"；候选清单是**可审计的逼近**，不是保证。
- 不做第二遍"找漏"视觉审计（P1+ 候选）；不引入新的阻断门禁。
- 不把 Figma 接入 vision；不改 taskDesc / 三件套契约 / hard-explore 门禁语义。
- 不在本批引入 pen 布局引擎/解析后几何（auto-layout 的 `unverifiable` 如实标注）。

**反目标（即使功能"能跑"也算失败）**

- 新增一个跳过分支但没有具名/计数；
- 一条龙响应里看不到设计源警告；
- 变体仍只做归并、不进入识别；
- 用"调大上限/再跑一次"替代暴露；
- 把 `unverifiable` 当成 `covered`。

## 3. 范围与分期

**P0-A 提取完整性（元素级 + 变体）**

- 堵住 §1.2 的静默路径；新增候选清单与四态覆盖（covered / uncovered / unverifiable / not-evaluated）。
- 变体（`screen.states`）作为一等 vision target：逐变体渲染、识别、覆盖与告警；上限优先保主屏。
- 守恒统计（屏 / 变体 / 元素）与 mismatch 告警。

**P0-B 警告可见面**

- 统一警告读取/合并/汇总；`design_to_test`、`figma_generate_tests`、`suite check/loop`、`suite report`/manifest、面板、`project_archive`、`design-pipeline.mjs` 同源可见。
- 警告仍不阻断（现有门禁不变）。

**P1 生成/对账收口（同设计，下一批）**

- 0 用例功能组 `feature-without-cases`；
- to:null 帽截停明细 + `exploration-truncated`；
- 旧 tests.json 缺 `generation` 显式 `generation-unknown`；
- 对账未匹配计数（反向观测并列/无匹配、Android 全未命中 pending）与元素映射 unmatched。

> 实施/发布节奏：**P0-A 与 P0-B 同一里程碑发布**（推荐 B 先行把既有警告接到可见面，再 A 接入新信号；也可 A→B 连续完成，但不单独发布 A——A 的新警告只到 flows.json/flow-map，入口层价值为零）。P1 紧随其后。每阶段独立可测试，均须全量构建/测试/lint。

## 4. 关键决策

### D1 元素完整度＝候选四态，不冒充召回保证

设计侧候选来自设计稿自身的**命名/组件语义**，不是视觉猜测：

- `name` 按 `/` 分段**任一段**命中受控词表（大小写不敏感；`Sticky button` 允许空格）：英文 `Button`、`Tab`、`Link`、`Input`、`Toggle`、`Switch`、`Checkbox`、`Search`、`Menu`、`Cart`、`Bag`、`CTA`、`Sticky button`；中文 `按钮`、`标签`、`链接`、`输入框`、`开关`、`搜索`、`菜单`、`购物车`、`购物袋`、`返回`、`关闭`。
  - 口径示例：`Button/My Order` 命中 `Button`；`Icon/Bag` 命中 `Bag`；`Tab/Icon+Text` 命中 `Tab`。**不是**只看首段——这是校准证据里 `Icon/Bag` 必须能命中的原因。
- 或 `type === "ref"` / `reusable === true`（组件实例）；
- 排除 `Flow/*` 批注子树；嵌套候选保留最外层（如 `Icon/Bag` 在 `Button/My Order` 内只算外层，但独立 `Icon/Bag` 仍可命中）；
- 项目可经 `AOS_VISION_CANDIDATE_TOKENS`（逗号分隔）追加词表（大小写不敏感），用于中文/业务专有命名；
- 每屏候选上限 200，超出记 `candidatesTruncated` + 告警（不静默）；
- **零候选兜底**：某屏 processed 且 `designNodes > 0` 但 `candidateNodes === 0` 时，出 `vision-candidate-vocabulary-unmatched`（advisory，提示词表可能不适配该设计稿），避免中文命名项目"候选全部静默缺席"。
- 词表校准线（P1）：`element-map-unmatched` / `reconciliation-unmatched` 暴露的未知交互元素名，作为下一轮词表扩充输入；v1 不自动学习。

每个候选的覆盖状态（四态，互斥）：

- `covered`：**同 state 作用域内**的识别元素 `nodeId` 命中，或 bbox IoU ≥ 0.2，或元素中心落在候选 bbox 内；
- `uncovered`：候选有几何/文本可比对，但同 state 内没有任何识别元素覆盖 → `vision-candidate-uncovered`；
- `unverifiable`：候选缺数值几何且无可匹配文本（auto-layout 常见）→ `vision-candidate-unverifiable`，如实说明"无法核验"，不当作覆盖；
- `not-evaluated`：该屏/state 根本没有进入 vision（`vision-off` / `capped` / `render-missing` / `frame-missing` / `rejected` / `failed`）→ 候选计入 `notEvaluatedCandidates`，并附原因；屏级已有同因警告，不重复刷屏。

匹配严格**按 state 作用域**：主屏元素只能覆盖主屏候选，某变体元素只能覆盖该变体候选；禁止跨 state 文本 fallback（否则主屏的"提交"会替未检查的变体"盖章"）。

文本 fallback：候选子树文本与同 state 识别元素 `label` 归一化后互相包含（长度 ≥ 2）即视为 covered；用于无几何但有文案的按钮。**同 state 内多个候选共享同一归一化文本**（如「确定」「取消」重复）时不自动判 covered，转 `unverifiable`（reason=`ambiguous-text`）并在 details 附匹配计数，避免假 covered。

告警显著性分层：`uncovered` 逐候选具名（真正的漏检信号）；`unverifiable` 只进 coverage 计数与每屏一条汇总，不逐候选告警；`not-evaluated` 由屏级同因警告承担。

**坐标空间（必须写死）**：识别元素 bbox 先由归一化坐标 × `VisionScreenInput.width/height` 转为**设计 px**（`bboxInPx` 既有换算），候选 bbox 也取同一**屏幕局部设计 px**（`collectVisionScreens` 的 `visit` 累加偏移）；两者直接做 IoU/中心判定。当前 pen 渲染固定 `scale=1`（`src/pen/render.ts`），所以图像像素与设计 px 一致；若未来引入非 1× 渲染，必须在进入覆盖判定前把元素 bbox 除以 `renderScale`，否则四态会静默失准。复用既有 `groundNodeId` 的节点几何与换算，不另建坐标系。

**真实校准证据**：starbuckstw `.pen` 中 `Button/My Order`、`Icon/Bag`、`Tab/Icon+Text` 等语义命名存在；大量 auto-layout 节点只有 `w` 或只有 `h`，因此 `unverifiable` 是常态而非异常，必须显式呈现。

### D2 变体是一等 vision target

- `synthesizePenFlows` 已产出 `screen.states`（id/label/frameName）；本设计把每个 state 作为独立 vision target：`{ id: state.id, name: "主屏 · 状态", stateOf: screen.id }`。
- 渲染：主屏 + 变体一并进入同一次 pen 渲染批次；`screens` 关闭时仍为 vision 渲染（沿用既有行为）。
- 识别：变体元素带 `state` 标记存入 `screen.states[].elements`（**不并入主屏 `elements`**，与 v1 生成边界一致）；变体边存 `screen.states[].edges`（不进 `result.edges`）；`FlowEdge` 增可选 `state` 供审计；候选覆盖按 state 分别记录与告警。
- **v1 生成边界**：state 元素/边只做**审计与覆盖元数据**，不进入 `figma_generate_tests` 的用例生成（避免从主屏起点生成"变体独有控件不存在"的假失败用例）；state 级未覆盖/不可核验仍响亮告警。state-aware 生成留后续票。
- 上限：`AOS_VISION_MAX_SCREENS` 统计主屏 + 变体；**排序主屏优先**，帽截断先裁变体；若主屏本身超过上限，主屏也会被裁但必须具名。`vision-screen-cap` details 具名被裁 target，并在 `vision.states` 计数；消息附行动提示「设 `AOS_VISION_MAX_SCREENS=0` 全量」。
- **env 语义迁移**：变量名保留（兼容），语义从"屏数"变为"vision target 数（主屏+变体）"；新增首选别名 `AOS_VISION_MAX_TARGETS`（同时设置时新名优先），README/doctor/`.env.example` 明示。
- 验收口径：默认 50 下要求"每个 target 要么 processed、要么具名 capped"；"30 个变体全部 processed"只在 `AOS_VISION_MAX_SCREENS=0`（或显式放大）的真实验收复核中要求，不在默认 CI 断言。
- 成本：每变体一次多模态调用；文档明示线性成本与 `AOS_VISION_MAX_SCREENS=0` 的全量开关。

### D3 逐条堵静默路径

| 路径 | 新行为 |
|------|--------|
| 帧查不到（缺/重复 id） | 进 `dropped`，reason=`frame-missing`；`vision-screen-frame-missing` 具名；重复 id 另告警 `pen-duplicate-node-ids` |
| 回复 >40 条 | `parseVisionReply` 返回 `truncated` 计数；`vision-response-truncated` 含屏名与条数 |
| 节点几何 >300 | 不再"先到先得"：候选优先、叶子优先、容器兜底；记录 `groundingTruncated` 并在 coverage 中可见 |
| 上限截断 | `vision-screen-cap` details 具名（主屏/变体分列）；stats 增 `screensCapped`/`statesCapped` |
| 无几何 | 全量 `dropped` 清单进 stats/flow-map（warning 仍可只列前 5） |
| 拒图后剩余屏 | 当前屏 + 其后未处理屏都进 `screensSkipped`；warning 列出剩余屏名（≤10 + 总数） |
| 会计不平 | `vision-accounting-mismatch` / `screenshot-accounting-mismatch`（数字入消息） |

> `>300` 的"候选优先、叶子优先"是 **grounding 行为变更**，不是纯记账：大屏的 `nodeId` 结果会变。必须用既有 fixture 锁定新的确定性结果，并在 DESIGN 记为行为变更（D9 的 additive 承诺不覆盖这一处）。

### D4 警告单一管道

- 新增 `src/design/warnings.ts`：`DesignWarning = FlowWarning`；`readDesignWarnings()`（读 flows.json 原文，容错）、`mergeDesignWarnings()`（按 code+message 去重、稳定序）、`summarizeDesignWarnings()`（total/byCode/codes）。
- 所有下游面共用同一汇总形状；详情保留在 flows.json / flow-map.md，下游至少给 total + byCode + codes（面板/档案可只给摘要）。
- 警告**不改变退出码**；现有 check 门禁只认覆盖/截断/三件套/真实数据。
- **来源与快照优先级**（保证历史可解释）：
  - `design_to_test`：本次 extract 的实时 warnings；`reuseExistingFlows` 时读当前 flows.json。
  - `figma_generate_tests`：文件模式读当前 flows.json 原文 + 本次生成警告；URL 模式现算 `flowGraphWarnings(graph)` + 生成警告；写入 tests.json 的 `designWarnings` 快照（含 `source: "flows" | "generated"`）。
  - `suite check` / `suite loop`：优先 tests.json 快照；缺失时回退当前 flows.json；响应/文本标注 `source` + `snapshotAt`/`generatedAt`；tests 快照早于当前 flows.json mtime 时附 `stale-snapshot` 提示（不阻断）；两者并存时按 `code+message` 去重并保留来源列表。
  - `suite report` / manifest：运行时写入 manifest 快照（来源同 check 的优先级）；历史批次始终读 manifest，不随 flows.json 变化。
  - 面板/档案：项目级读当前 flows/tests；批次详情读 manifest；缺快照显示 `unknown`，不伪造。
  - 生成期警告（`feature-without-cases` / `exploration-truncated` / `generation-unknown`）归属 tests.json 快照与 generate 响应；对账运行期计数归属 manifest。`WarningSummary.available` = 任一来源可读。

### D5 一条龙入口契约

`design_to_test` 响应新增：

- `warnings: DesignWarning[]`（设计 + 生成合并去重）；
- `designWarnings: { available, total, byCode, codes }`；
- `artifacts.flowMap`（存在即返回）；
- `steps[extract].warnings` 计数（便于快速判断）。

`reuseExistingFlows:true` 时从 flows.json 读取同一套 warnings。失败响应（extract/generate/check）也携带已获得的 warnings。

### D6 生成/校验/报告同源

- `figma_generate_tests`：文件模式读 flows.json 原文 warnings；URL 模式现算 `flowGraphWarnings(graph)`；合并进 payload `warnings`，新增 `designWarnings` 汇总；`tests.md` 顶部新增「设计源警告」小节；`tests.json` 增 `designWarnings`（additive）。
- `preflight`：增 `designWarnings`；`suite check` 文本一行摘要 + JSON 字段；`suite loop` 报告/markdown 同步。
- `suite report` / run manifest：运行时把 `designWarnings` 摘要写入 manifest；报告摘要区展示。
- `run_regression` / `verify_jira_issue`：工具响应自身带 `designWarnings` 摘要（来源同 check 优先级）；其 run manifest 同样冻结快照。两个入口是真实用户最常走的"一条龙"，不能只靠 manifest 间接可见。
- 面板：项目页「设计资产」显示 warning 总数与 codes；批次详情读 manifest 摘要。
- `project_archive`：`design.warnings` 摘要；`scripts/design-pipeline.mjs` 打印摘要。

### D7 守恒不变量（新增测试的硬要求）

提取：

```
screensInput = screensProcessed + screensSkipped + screensFailed
             + screensCapped + screensNoGeometry + screensFrameMissing
statesInput  = statesProcessed + statesSkipped + statesFailed
             + statesCapped + statesNoGeometry + statesFrameMissing
targetsRequested = screensRequested + statesRequested
screensRequested = screensProcessed + screensSkipped + screensFailed   // 进入 pass 的主屏
statesRequested  = statesProcessed + statesSkipped + statesFailed      // 进入 pass 的变体
elements         = groundedElements + ungroundedElements
rawElements      = elements + invalidItems + truncatedItems            // 解析层：有效/非法/超 40 截断
```

截图（开启时）：`screens + states = rendered + skipped`。

生成：

```
unresolvedTotal = unresolvedExplored + unresolvedDropped
keptPaths + droppedPaths = dedupedPaths
featuresTotal = featuresWithCases + featuresWithoutCases
```

任一不成立 → `*-accounting-mismatch` warning（消息带数字）并测试锁定。

**分类互斥与优先级**（每个 target 恰好落一桶，按此顺序判定）：

1. `frameMissing`：合成屏 id 在文档里找不到 frame；
2. `noGeometry`：有 frame，但无数字宽高且无渲染图尺寸；
3. `capped`：有资格但未被选入本轮（仅对通过 1–2 的 target）；
4. `skipped`：已选入但当轮无渲染图；或模型拒图时**当前屏 + 其后所有未处理屏**；
5. `failed`：调用失败且不属于"模型拒图"；
6. `processed`：拿到回复（含 0 元素）。

`failures` 保留为"调用失败次数"（现有语义，不参与守恒）；`screensFailed`/`statesFailed` 是互斥桶。`invalidItems` 是**解析层丢弃计数**，不属于 elements，也不参与 target 守恒；`rawElements = elements + invalidItems + truncatedItems` 单独校验。主屏/变体分别按同一规则分类（变体同样有 `frameMissing`/`noGeometry`，因为 `states` 的 id 也可能缺失或为合成占位 id）；变体先被 cap 裁，主屏后裁。测试需覆盖"同时缺几何且超上限"的 target 只进 `noGeometry` 一桶。

### D8 P1 收口

- `feature-without-cases`：功能组 `caseIds` 为空时逐组/聚合告警（details 含 key/name/screens）；面板/响应可见。
- `exploration-truncated`：`unresolvedDropped > 0` 或 `truncated` 时告警；`generation.accounting` 增加 `unresolvedTotal/Explored/Dropped` 与 `droppedEdgeKeys`（≤50 + 总数）。
- `generation-unknown`：tests.json 缺 `generation` 时 check 文本/JSON 显式标注；非阻断，`--strict` 可升级为失败（保持默认兼容）。
- 对账：`bestScreenForSummary` 并列/无匹配计数、Android 全未命中仍登记 pending、元素映射 unmatched 计数，进 suite run 响应/manifest/面板。

### D9 兼容与默认

- 全部字段 additive；`screensRequested` 语义保持为"进入 vision 的主屏数"（变体另计 `statesRequested`，合计 `targetsRequested`），新增 `screensInput` 等；旧 flows/tests 缺字段显示 `unknown`，不伪造 0。
- `AOS_VISION_MAX_SCREENS` 默认 50 不变；主屏优先；`0`/`all` 仍为不限；新增首选别名 `AOS_VISION_MAX_TARGETS`（同时设置时新名优先），语义按 targets（主屏+变体）解释。
- 脚本/README/DESIGN/AGENTS 同步；`npm run build && npm test && npm run lint` 全绿。

## 5. 接口与数据形状（草案）

```ts
// src/design/vision.ts（additive）
interface VisionStats {
  // 既有字段保持不变
  screensRequested: number;
  screensSkipped: number;
  screensProcessed: number;
  elements: number;
  navigationalEdges: number;
  invalidItems: number;
  failures: number;
  // 新增
  screensInput: number;
  screensNoGeometry: number;
  screensFrameMissing: number;
  screensCapped: number;
  screensFailed: number;
  truncatedItems: number;
  groundedElements: number;
  ungroundedElements: number;
  candidateNodes: number;
  coveredCandidates: number;
  uncoveredCandidates: number;
  unverifiableCandidates: number;
  notEvaluatedCandidates: number;
  targetsRequested: number;        // screensRequested + statesRequested
  statesRequested: number;
  statesInput: number;
  statesProcessed: number;
  statesSkipped: number;
  statesFailed: number;
  statesCapped: number;
  statesNoGeometry: number;
  statesFrameMissing: number;
}

type CandidateStatus = "covered" | "uncovered" | "unverifiable" | "not-evaluated";

interface FlowElementCoverage {
  state: string | null;            // null = 主屏
  designNodes: number;
  candidateNodes: number;
  recognizedElements: number;
  groundedElements: number;
  ungroundedElements: number;
  coveredCandidates: number;
  uncoveredCandidates: number;
  unverifiableCandidates: number;
  notEvaluatedCandidates: number;
  candidatesTruncated?: number;
  details: Array<{
    nodeId: string;
    name: string;
    status: CandidateStatus;
    reason?:
      | "no-geometry"
      | "no-text"
      | "vision-off"
      | "capped"
      | "render-missing"
      | "frame-missing"
      | "rejected"
      | "failed";
    bbox?: { x: number; y: number; width: number; height: number };
  }>; // uncovered/unverifiable 全量；响应可截断，产物全量
}

interface FlowScreen {
  // 既有字段…
  elementsCoverage?: FlowElementCoverage[]; // 主屏 + 各 state
}

interface FlowElement { state?: string; /* 既有字段 */ }
interface FlowEdge { state?: string; /* 既有字段 */ }

// src/design/warnings.ts
interface WarningSummary {
  available: boolean;
  total: number;
  byCode: Record<string, number>;
  codes: string[];
  bySource?: Record<string, number>;   // flows / tests-snapshot / manifest
  snapshotAt?: string;                 // 快照生成时间（ISO）
  stale?: boolean;                     // 快照早于当前 flows.json mtime
}
```

新增 warning codes：

```
vision-screen-frame-missing
pen-duplicate-node-ids
vision-response-truncated
vision-candidate-uncovered
vision-candidate-unverifiable
vision-accounting-mismatch
screenshot-accounting-mismatch
feature-without-cases
exploration-truncated
generation-accounting-mismatch
generation-unknown
reconciliation-unmatched
element-map-unmatched
```

## 6. 可见面矩阵

| 消费面 | design warnings | 形态 |
|--------|-----------------|------|
| extract 工具响应 | ✅（已有） | 全量 warnings + 计数 |
| flow-map.md / flows.json | ✅（已有 + 扩展 coverage） | 全量 |
| `design_to_test` 响应 | ✅（新增） | 合并 warnings + summary + flowMap 路径 |
| `figma_generate_tests` 响应 / tests.md / tests.json | ✅（新增） | summary + md 小节 + json 字段 |
| `suite check` 文本 / `--json` | ✅（新增） | 一行摘要 + 结构化字段 |
| `suite loop` 报告 / markdown | ✅（新增） | check 摘要透传 |
| `suite report` / manifest | ✅（新增） | manifest 摘要；报告摘要区 |
| `run_regression` 响应 | ✅（新增） | 工具响应 + manifest 双可见 |
| `verify_jira_issue` 响应 | ✅（新增） | 工具响应 + manifest 双可见 |
| 面板项目页 / 批次详情 | ✅（新增） | 总数 + codes；批次读 manifest |
| `project_archive` | ✅（新增） | `design.warnings` 摘要 |
| `design-pipeline.mjs` | ✅（新增） | 终端摘要 |

## 7. 测试口径

全部离线（假 pen exec / 假 chat / fetch 打桩），不依赖真实 PG/设备/外网。

**Fixture 策略**：CI 提交一个**合成 trimmed fixture**（3 主屏 + 2 变体、语义命名 `Button/Icon/Tab`、部分 auto-layout 缺几何、含一条 to:null），不 vendor 21MB 真实 `.pen`（体积/归属风险）；真实 starbuckstw 回放作为**本地手动验收**（`AOS_VISION_MAX_SCREENS=0`，非 CI），只记录结果不提交大文件。

**P0-A**

1. 帧缺 id / 重复 id：屏幕进 dropped 且具名 warning；stats 守恒。
2. 回复 >40 条：`truncatedItems` 与 warning 锁定；第 40 条后的元素不静默。
3. 候选四态：`Button` 被元素覆盖 → 无告警；未覆盖 → 具名 `vision-candidate-uncovered`；无几何无文本 → `unverifiable` 且不当 covered；vision 未跑/被 cap → `not-evaluated` 且附原因；嵌套候选去重；`Flow/*` 排除。
3a. 词表粒度与双语：`Icon/Bag` 命中 `Bag`（任一段）、`Button/My Order` 命中 `Button`、`Frame 1234` 不命中；中文 `购物袋按钮` 命中；`AOS_VISION_CANDIDATE_TOKENS` 追加词命中；`designNodes>0 && candidateNodes===0` → `vision-candidate-vocabulary-unmatched`。
3b. 坐标空间：scale=1 下元素 bbox 与候选 bbox 同为设计 px；用非 1× 的假渲染输入锁定"先除以 renderScale 再判定"（或显式断言当前只支持 scale=1 并拒绝其他值）。
3c. 重复文本：同 state 两个候选同归一化文本（确定/取消）→ `ambiguous-text`/`unverifiable`，不得假 covered。
4. 变体：主屏 + 2 个 state，变体独有 `Button` 仅在 state 图出现 → state 被识别/告警；`state` 标记进 elements/edges；上限先裁 state 不裁主屏。
5. 守恒：构造 cap/no-geometry/frame-missing/失败混合，断言公式成立；`statesFrameMissing` 单独构造一例；`rawElements = elements + invalidItems + truncatedItems`；`screensRequested = processed+skipped+failed`；人为破坏时 `vision-accounting-mismatch` 触发。
6. 合成 fixture：3 主屏 + 2 变体全部进入 target；`Button/Icon/Tab` 候选可见；`unverifiable` 有计数；默认 50 下所有 target 要么 processed、要么具名 capped（本地 starbuckstw 手动回放用 `AOS_VISION_MAX_SCREENS=0` 验证 23+30 全量）。
6a. grounding 行为变更：`>300` 候选优先/叶子优先后，既有大屏 fixture 的 `nodeId` 结果锁定；变化写入 DESIGN 行为变更记录。

**P0-B**

7. `design_to_test`：extract 响应 warnings 出现在最终响应；`artifacts.flowMap` 存在；reuse 模式同样读取。
8. `figma_generate_tests`：tests.md 含「设计源警告」，tests.json 含 `designWarnings`；URL 模式现算结构警告。
9. `suite check` 文本/JSON、`suite loop`、manifest、面板、archive 各有一条断言（同源 code 出现）。
9a. `run_regression` / `verify_jira_issue` 工具响应各带 `designWarnings` 摘要；manifest 同样冻结。
9b. 快照陈旧：tests.json 早于 flows.json mtime 时标 `stale-snapshot`；响应含 `snapshotAt`/`generatedAt`。
9c. env：`AOS_VISION_MAX_TARGETS` 与旧名同时设置时新名优先；旧名单独设置仍生效（兼容）。
10. 去重：同一 warning 不重复；details 截断但 total/byCode 保留。

**P1**

11. 0 用例功能组 → `feature-without-cases`，响应/面板可见。
12. `maxFlows` 帽截停 → `unresolvedDropped` 明细 + `exploration-truncated`；`maxFlows=300` 时 starbuckstw 215 条全保留。
13. 旧 tests.json 缺 generation → `generation-unknown`。
14. 反向观测并列/无匹配、Android 全未命中、元素映射 unmatched 均有计数/告警。

**收口**：`npm run build && npm test && npm run lint` 全绿；DESIGN/README/AGENTS 同步。

## 8. 验收标准（按用户尺子）

1. **购物袋类**：fixture 中一个 `Button`/`Icon` 候选未被识别 → 无须用户提示，响应/产物出现具名告警；覆盖后告警消失。
2. **变体分叉**：只在某个 state 出现的交互元素 → 该 state 进入识别；识别不到时 state 级告警/`unverifiable` 可见；不会因主屏通过而静默。
3. **一条龙**：`design_to_test` 单次调用即可看到 `pen-no-interactions`、`pen-state-merges`、`vision-*`；不再需要单独跑 extract 或手翻 flows.json。
4. **守恒**：新增任一跳过路径，若未接告警/计数，守恒或 mismatch 测试变红。
5. **真实项目（手动）**：starbuckstw 回放中 23 主屏 + 30 变体全部有 target 记录；**默认 50 下 53 targets 会裁掉 3 个变体（具名 `not-evaluated`），这是预期而非达标失败**；`AOS_VISION_MAX_SCREENS=0` 时 53 全部 processed；`unverifiable` 数量如实；215 条探索边在 `maxFlows=300` 下全保留；所有 warnings 在一条龙/检查/面板可见。

## 9. 风险与边界

- **候选启发式**：名称词表可能漏掉无命名的裸矢量按钮（如某些 FAB）；`unverifiable`、`not-evaluated` 与"零候选"告警会如实暴露，但不等于零漏检。中英文词表 + `AOS_VISION_CANDIDATE_TOKENS` + P1 对账校准线降低风险，仍需真实项目校准。
- **坐标空间**：当前 pen 渲染固定 scale=1，元素/候选同在 design px；若未来引入非 1× 渲染，必须先换算，否则四态静默失准（测试锁定）。
- **变体成本**：每变体一次视觉调用；默认上限 50 可能裁掉部分变体，帽告警具名；`0` 全量由用户显式承担成本。
- **auto-layout 几何缺失**：`unverifiable` 是常态；本批不解析 pen 布局，后续可评估 pen CLI 解析后几何。
- **告警量**：`unverifiable` 只进计数/每屏一条汇总，**不逐候选告警**；显著告警留给 `uncovered`。下游只给摘要，details 上限。
- **兼容/行为变更**：新增字段 additive；旧产物显示 unknown；`screensRequested` 语义不变（主屏）；`AOS_VISION_MAX_SCREENS` 语义扩展为 targets（新别名 `AOS_VISION_MAX_TARGETS`）；`>300` 候选优先会改变 grounding 结果，单独记行为变更并锁 fixture。
- **不做**：第二遍找漏、视觉召回保证、Figma vision、把 warnings 变成阻断门禁。

## 10. 留给实施计划

- 候选词表/嵌套去重/文本 fallback 的具体实现与真实 fixture 校准；
- 变体渲染在 `capturePenScreens` 中的分批、命名（`state-` 前缀）与 screenshot 摘要口径；
- 各下游面的字段落点与面板排版；
- P1 对账计数的字段与 manifest 版本；
- 迁移/文档：`AGENTS.md`、`README.md`、`DESIGN.md`（新增实施记录 + schema 说明）。

## 11. 复核记录（builder-check，2026-10-19/20）

fresh subagent 按 `builder-check-prompt.md` 提出 8 个会改变计划的问题；逐条处置如下（均为设计侧调用，无遗留"用户裁决"项）：

1. **真实 fixture 从哪来**（21MB `.pen` 是否入库/授权）→ CI 用合成 trimmed fixture（3 主屏 + 2 变体 + 语义命名 + 部分 auto-layout 缺几何 + 一条 to:null）；真实 starbuckstw 只做本地手动回放，不 vendor 大文件。
2. **50 上限 vs 23+30=53** → 默认 50 不变；主屏优先、变体先裁；若主屏自身超限也裁但具名。验收口径改为"默认下每个 target 要么 processed 要么具名 capped"；全量 53 只在 `AOS_VISION_MAX_SCREENS=0` 的手动验收中要求。
3. **未进入 vision 的候选状态** → 新增第四态 `not-evaluated`（附 `vision-off/capped/render-missing/frame-missing/rejected/failed` 原因），计入 `notEvaluatedCandidates`；屏级同因警告已存在，不重复刷屏。
4. **跨 state 覆盖** → 严格按 state 作用域匹配；主屏元素不得覆盖变体候选，变体元素不得覆盖主屏候选；禁止跨 state 文本 fallback。
5. **state 元素/边是否进入生成** → v1 只做审计/覆盖元数据，不进入 `figma_generate_tests`（避免"主屏起点不存在变体控件"的假失败）；state-aware 生成留后续票，state 级未覆盖仍告警。
6. **下游 warning 是实时/快照/合并** → 生成时快照进 tests.json；check/loop 优先 tests.json、回退当前 flows 并标注来源；report/manifest 写 run 时快照，历史批次读 manifest；面板/档案项目级读当前、批次级读 manifest；缺快照显示 unknown。
7. **会计桶是否互斥** → 定义唯一分类顺序 `frameMissing → noGeometry → capped → skipped(render-missing/rejected) → failed → processed`；每个 target 恰落一桶；`failures` 仅保留调用失败次数（不参与守恒）；变体先 cap、主屏后 cap。
8. **P1 警告持久化** → 生成期警告（feature-without-cases / exploration-truncated / generation-unknown）归 tests.json 快照与 generate 响应；对账运行期计数归 manifest；`WarningSummary.available` = 任一来源可读，汇总保留 `bySource`。

## 12. 外部评审（2026-10-20）逐条核验

外部评审结论：设计合理、机制扎实，建议小修后出计划。逐条核验如下（全部成立；其中两条为"doc 规格缺失"而非当前实现 bug，已按更严格口径写死）：

| # | 反馈 | 核验 | 处置 |
|---|------|------|------|
| 关键 1 | states 守恒漏 `statesFrameMissing`；`invalidItems` 归位 | **成立**：`states.id` 可为合成占位（`src/pen/flows.ts:305`），帧查不到同样适用；`invalidItems` 确实在 elements 之外 | D7 补 `statesFrameMissing`/`statesNoGeometry`；新增 `rawElements = elements + invalidItems + truncatedItems` 与 `screensRequested/statesRequested` 等式 |
| 关键 2 | bbox 坐标空间未定义 | **成立（doc 缺失）**：当前 pen 渲染固定 `scale=1`（`src/pen/render.ts:50`），设计 px＝图像 px；但未写死，未来换 scale 会失准 | D1 明确复用 `bboxInPx`→设计 px；非 1× 必须先除 `renderScale`；测试锁定 |
| 关键 3 | 词表粒度自相矛盾＋纯英文召回边界 | **成立**：正文"前缀"与校准证据 `Icon/Bag` 冲突；中文命名会零候选 | 改为按 `/` 分段任一段命中；补中文词表；加 `AOS_VISION_CANDIDATE_TOKENS`、零候选 `vision-candidate-vocabulary-unmatched`、P1 对账校准线 |
| 中 4 | 可见面缺 `run_regression`/`verify_jira_issue` | **成立**：两工具均执行 suite 并产 manifest，但响应未设计 warnings | D6/§6 补两入口；测试 9a |
| 中 5 | `AOS_VISION_MAX_SCREENS` 语义静默变化 | **成立**：文档写"屏数"，扩展后计主屏+变体 | 旧名兼容、语义改 targets；新增首选别名 `AOS_VISION_MAX_TARGETS`；README/doctor/.env.example 迁移说明 |
| 中 6 | 旗舰案例默认体验未写进验收 | **成立**：53 > 50，默认裁 3 变体 | §8.5 明示"默认 3 个变体 not-evaluated 是预期"；cap 消息附 `=0` 行动提示 |
| 中 7 | P0-A 单独落地用户价值为零 | **部分成立**：产物层 flow-map/flows.json 可见，入口层为零；单独发布会造成"警告存在但没人看见" | §3 改为 A+B 同一里程碑，推荐 B 先行，不单独发布 A |
| 低 1 | 重复标签文本 fallback 假 covered | **成立** | 同 state 多候选同文本 → `ambiguous-text`/`unverifiable`，details 带匹配计数 |
| 低 2 | `unverifiable` 告警疲劳 | **成立** | 只进计数/每屏一条汇总，不逐候选告警；显著性留给 `uncovered` |
| 低 3 | >300 选取变更非纯记账 | **成立** | 记为 grounding 行为变更，锁既有 fixture 的 `nodeId` 结果，DESIGN 记录 |
| 低 4 | 快照/新旧标注 | **成立** | `WarningSummary` 增 `snapshotAt`/`stale`/`bySource`；check 陈旧快照标 `stale-snapshot` |
| 低 5 | `screensRequested` 与桶的关系式 | **成立** | D7 增 `screensRequested = processed + skipped + failed`（states 同理） |

无"不成立"项；无遗留用户裁决项。评审建议的"中 7"按更严格口径采纳（A/B 同批），其余按原文并入。
