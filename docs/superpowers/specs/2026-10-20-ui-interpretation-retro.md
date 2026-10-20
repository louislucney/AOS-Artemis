# Retro（rev 2）：设计图解读 → UI 实现

> 方法：Matt Pocock `retro`（改进 agent 环境，不改一次性代码）＋ `writing-for-agents`。
> rev 2（2026-10-20）吸收评审意见：契约与 `flows.json` 同源、P2 三个前提、P3 截图/噪声前置、PNG 适配器，以及“功能通过 ≠ UI 通过”的测试循环缺口。

## 1. 事实

- **测试循环只证明流程**：`suite run` 的 `SuiteCaseResult` 没有 UI 字段；本次 iOS 跑出 `passed: 1`，但同屏首頁仍有 1 个 blocker、2 个 minor、2 个 info。功能通过不能推出 UI 通过。
- **设计源有规格，但没被消费**：`.pen` 首頁商品卡 `cornerRadius` 10/11.25、CTA 16、圆形 100；`flows.json` 只有屏幕/元素/状态/边，没有 token、几何完整性、`presentation`。
- **契约/流程产物高度重叠**：`flows.json` 已有 `screens/elements/state/provenance/elementsCoverage`；若另起一套 `ui-contract.json` 提取管线，必然出现第二份 schema 漂移。
- **设计→代码映射未解决**：`screen-map.json` 有 `code.file/component` 形状，但 iOS 当前 `entries=0`；17 条 `elements` 是设备观察↔设计文本，不是设计节点→app 代码。P2 的“检查 bottom-sheet 锚点”不能假装已有映射。
- **视觉验证是事后可选**：`design_device_diff` 能出区域报告，但本次是用户指出后才运行；跨源噪声基线（D12）仍未验证。
- **截图格式不一致**：iOS AOS trace 写 PNG（`src/ios/trace-persist.ts:219`）；Android artemis 先在 `accessibility_client.py` 用 `adb exec-out screencap -p` 取 PNG，再在 `pil_to_base64` 以 JPEG quality 80 重编码（`artemis/third_party/mobile_use/clients/ui_automator_client.py:150`，RGBA→RGB），trace 的 `data_engine` 也按 `.jpg` 落盘（`artemis/artemis/data_engine/engine.py:834/851`）。`design_device_diff` 对 step 非 PNG 会标 `lossy-source` 并把细节阈值降到 0.1；live Android 细节会二次抓 PNG，但整屏通道仍可能用初始 JPEG。
- **`design/screens/*.png` 完整但被工具拒绝**：`design_device_diff` 的 `design.source` 只接受 `figma|pen`；现成 PNG 不能作为源。拒绝原因是接口形态，不是保真；但 PNG 750×1710 vs 设备 1320×2868 会触发 `design-upscaled`，只能作为廉价适配器，不能替代高倍渲染。
- **基线缺失**：当前没有“UI 差异平均多晚被发现/每屏多少差异”的分母；本次只有 1 次人工触发、5 屏审计、首頁 5 个区域、自动 UI 门禁 0 个。

## 2. 根因

1. **没有 UI 契约**：token、组件几何、状态、弹层形态没有进入实现侧可读的单一事实源。
2. **没有 UI 接受标准**：`tests.json`/taskDesc/Jira ticket 只描述流程，不描述“这屏的圆角/层级/弹层/资源必须是什么”。
3. **测试结果不区分功能与 UI**：`passed` 掩盖 `ui-unverified`；没有“功能通过、UI 未验证”的状态。
4. **验证在生产末端**：diff 是手动工具，不是实现/测试的完成条件；且缺设计→代码映射与逐屏截图覆盖。

## 3. 改进候选

### P0：UI 契约是 `flows.json` 的投影，不是第二份 schema

- **同源**：在现有 `pen_extract_flows`/`figma_extract_flows` 的提取结果上扩展 `FlowScreen.ui`（或从同一 `FlowGraph` 渲染 `ui-contract.{json,md}`），共享 `screen.id`、`nodeId`、`fingerprint`、重生成时序。禁止独立再扫一遍 `.pen`。
- **token 审计先行**：先只读回答“`.pen` 里到底有什么”：颜色、字体/字重、间距、圆角、阴影、图片位；每项标 `extracted | partial | unverifiable | missing`，未审计的字段不得写成“已提取”。
- **几何四态**：沿用“不许静默漏”的纪律；auto-layout 只有单边尺寸、无几何、组件实例未解析等都要显式分态。
- **presentation 字段**：每个 overlay 明确 `modal | bottom-sheet | full-screen | inline`；设计源没有的状态标 `no-baseline`，**阻塞实现**，先补设计或登记有 owner/日期的例外。
- **产物**：`ui-contract.json`（机器）+ `ui-contract.md`（人/agent）；md 每屏两栏：“必须一致 / 平台可差异”。

验收：任一 UI 实现/评审前，`ui-contract.md` 覆盖该屏；缺契约或 `no-baseline` 不得进入实现。

### P1：测试用例与 ticket 必须携带 UI 接受标准

- **测试用例**：`tests.json` 每例增加 `ui`：`contractRef`、`screenId`、`presentation`、`mustMatch`（token/组件/资源）、`allowedPlatformDiffs`。
- **执行结果**：`SuiteCaseResult` 增加 `ui`：`passed | failed | unverified | not-applicable` + 区域/证据；`suite run` 汇总分开报“功能”和“UI”。`ui-unverified` 不能算全绿；面板/报告显示“功能通过 / UI 未验证”。
- **taskDesc**：除 `【真实数据】` 外，加入 `【UI 契约】<contractRef>` 与逐屏 must-match；没有契约的用例显式标 `ui-unverified`，不静默。
- **Jira**：沿用现有 `verify_jira_issue`/`jira_evidence_post` 轨道；ticket 模板加 `Design contract` 与 `Verification` 两节，verify 阶段可机械检查是否缺失。
- **范围**：先覆盖已访问屏；未访问屏记 `ui-unverified` 覆盖率缺口，不伪造通过。

### P2：机械规则（先解决三个前提）

| 前提 | 处理 |
|------|------|
| **执行拓扑** | 检查器放 AOS 服务仓，以 `ui:lint --project <dir>` 扫项目代码；或项目仓自带脚本。二者择一写清，不假设 app 代码在服务仓 |
| **design→code 映射** | 优先 `screen-map.json` 的 `code.file/component`；缺失时退化为文件/类名启发式，并输出 `mapping-confidence`；不得把启发式当权威 |
| **存量与例外** | 只扫变更文件/新 ticket；`ui-lint-allowlist.json` 记录 owner/reason/expiry；被接受的差异回写契约/白名单，避免每次回归重报 |

规则（先代码字面量，Android 资源/iOS asset 后置）：

- 圆角字面量必须来自契约 token；未登记值失败。
- `presentation=bottom-sheet` 的组件必须底部锚定 + 顶部圆角；`centerYAnchor` 失败（需接受启发式误报并走 allowlist）。
- hero/图片位必须有 asset/URL，或契约明确标 `dynamic` 并登记例外。

### P3：视觉验证进入测试循环，但先窄后宽

- **截图来源**：`suite run` 现有 trace 截图只覆盖用例访问过的屏。第一版门禁 = “访问屏 diff + 契约屏覆盖率报告”；未访问屏 `ui-unverified`。不做“自动导览所有屏”的承诺，除非另立执行器能力。
- **噪声基线先行**：D12 未验证前 report-only；阻断只开高精度类（元素缺失/多出、presentation 错、hero 空）；像素簇的 blocker/major 待基线校准后再入阻断。
- **平台 profile**：iOS/Android 的 `insets`/`ignoreRegions` 持久化到项目配置；不允许每屏手填。
- **源保真**：`ui:passed` 只接受 PNG 源（iOS 原生 PNG；Android live 用 `lossless:true` 的 `screencap -p`）。Android trace `.jpg`（artemis JPEG quality 80、无 alpha）只能 `report-only`/`ui-unverified`，不得作为细节门禁；结果记录 `sourceFormat`/`lossless`/`detailThreshold`。JPEG 的 alpha 丢失对不透明设备截图通常不是主要问题，**主要风险是压缩振铃/块效应**；细节阈值被降到 0.1 后，1–4px 细节可能漏报。设计侧透明占位/阴影按统一背景合成后再比，避免把 alpha 当成内容差异。
- **边界**：提取警告（`extraction-warning`）永不阻断；阻断的是**已验证的实现差异**，两个信号不得耦合。

### P4：review 增加 UI 轴

`code-review` Standards 轴增加：是否按 `ui-contract.md` 实现 token/组件/状态/presentation；平台差异是否有契约依据；是否有逐屏 diff 证据。属于 judgement，不写成机械规则。

### P5：触发面是 MCP 工具描述 + 项目指南 + Jira，不是服务仓 AGENTS 单独承担

- `design_to_test`/`run_regression`/`design_device_diff` 的工具描述写入“先读契约、逐屏核验、`no-baseline` 不猜”。
- 生成的 `taskDesc` 带 `【UI 契约】`；项目仓 `AGENTS.md` 由 `install`/`init` 生成指针。
- 服务仓 AGENTS 只加一条导航指针，不承担 app 实现 agent 的触发。

### P3.1 字重（regular / medium / semibold / bold）检测口径

详细方案见 [`2026-10-20-font-weight-detection-design.md`](./2026-10-20-font-weight-detection-design.md)。摘要：`ui-contract` 记录文本节点级 `fontWeight`（归一 400/500/600/700）；真机侧从 1:1 截图测 `inkRatio`/`runLength`，输出 `weightHint: lighter|similar|heavier`；同平台 baseline 才做硬门禁，设计×真机只提示；medium↔regular 允许低置信，JPEG/上采样/文本变化一律 `unverified`。

### P6：廉价 PNG 适配器（局部缓解）

给 `design_device_diff` 增加 `design.source:"image"`（`imagePath`）读取 `design/screens/*.png`；报告标 `design-upscaled` 与来源，细节阈值按降级档。它解决“现成截图不能用”的接口问题，不替代高倍 pen/Figma 渲染。

### P7：基线与 token 版本化

- **基线**：记录当前“人工触发、5 屏、首頁 5 区域、自动 UI 门禁 0、suite 无 UI 字段”；改进后按月统计“UI 差异在实现前/后被发现的占比”。
- **token 版本化**：契约 `fingerprint` 绑定设计源（复用 case-set 指纹模式）；设计源变化但 token 未更新时告警，避免下一轮静默漂移。

## 4. 落地顺序

1. P0 契约投影 + token 审计（iOS `.pen` 先行）。
2. P5 触发面 + P1 测试/ticket 模板（低成本，立即改变行为）。
3. P6 PNG 适配器（局部可用）。
4. P2 `ui:lint` 三规则（先变更范围）。
5. P3 测试循环门禁（report-only → 窄阻断 → 基线后再开像素）。
6. P4 review 轴 + 一次 retro 验证。

## 5. 不做什么

- 不把“所有像素必须一致”作为目标：平台字体/安全区/系统控件允许差异，但必须在契约登记。
- 不用截图肉眼对比替代契约：截图是验证，不是规格。
- 不在缺设计画板时猜 UI：缺状态先补设计或登记例外。
- 不把提取警告当 UI 失败：两者信号分离。

## 6. 成功标准

- UI ticket 100% 带 `Design contract` 与 `Verification`；按屏/按 ticket 统计覆盖率，不用“100%”纸面指标。
- 每屏实现前能回答：圆角/间距/字重来自哪个 token；overlay 是 modal 还是 bottom-sheet；hero/图片位是什么资源；哪些状态允许平台差异。
- `suite run` 输出同时有功能与 UI 状态；`ui-unverified` 不被标成通过；`ui:passed` 只来自 PNG 源，JPEG 源最多 `report-only`。
- UI 差异在实现完成前被机械检查或逐屏 diff 捕获；捕获不到的进 `ui-unverified` 覆盖率报告，而不是等用户指出。

## 7. 评审意见处理

| 评审点 | 处理 |
|--------|------|
| ui-contract 与 flows.json 第二份 schema 风险 | P0 改为同一提取的投影；共享 id/fingerprint；四态；token 审计先行 |
| P2 执行拓扑/映射/存量例外 | P2 表格逐条写清；映射缺失时如实降级 |
| P3 截图获取/噪声基线 | P3 改为访问屏 + 覆盖率报告；report-only → 窄阻断；D12 前置 |
| `design/screens/*.png` 被拒无候选 | P6 增加 image 适配器，并声明其保真边界 |
| no-baseline 组织依赖 | P0 要求 owner/日期例外；无 SLA 不死锁 |
| P5 落点/P1 错过 Jira | P5 改为 MCP 描述/项目指南/Jira；P1 接 `verify_jira_issue` |
| 缺基线度量 | P7 记录当前分母与月度指标 |
| token 版本化 | P7 契约 fingerprint + 漂移告警 |
| 低优先备注 | 补充 app fix 单独立项；P2 先代码字面量；P2 先于 P3 |

## 8. 本次事故的修复跟踪

- `MOPLandingComponents.m:963` 居中弹窗是否改底部弹层，单独开 Jira/项目 ticket 跟踪，不混在流程改造里。
- iOS 首頁/單品頁/搜索页差异按 `ui-audit-2026-10-20.md` 另开实现 ticket。

## 9. 执行进度（2026-10-20）

- **P0 首版完成**：`suite ui-contract` 从 `flows.json` + 逐屏 `.pen` 投影 `ui-contract.{json,md}`；共享 screen id/指纹；逐屏 token + 几何四态 + `presentation`。iOS 样例 19 屏：4 partial、15 no-baseline（缺逐屏 `.pen`）。
- **P1 部分完成**：`SuiteCaseResult.ui` / `SuiteRunReport.ui` / 批次清单 `summary.ui` + `cases[].ui` 已落地；默认 `unverified`，CLI 逐例与汇总、面板批次徽标显示 UI 状态，不改变功能门禁。
- **P3 源保真部分完成**：`design_device_diff` 报告新增 `unit.device.sourceFormat/lossless` 与 `detail.deviceSource`；`isUiPass` 只接受 PNG + lossless。Android trace JPEG 仍为 `ui-unverified`/report-only。
- **未完成**：P1 逐例 UI 实际对比（trace/访问屏）、P2 `ui:lint`、P3 批量门禁、P4 review 轴、P6 PNG 适配器。
