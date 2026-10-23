# 双层测试产物与跨端一致性：当前风险与收敛评估（rev 2）

> 日期：2026-10-23（rev 3 吸收二次审核：补 R12 URL 内容指纹、R13 semanticId 碰撞、R1 重建字段、R11 台账持久化）
> 状态：部分实施（R1/R2/R5/R6/R7/R8/R10/R11/R12 已完成，见 DESIGN §13.204–§13.206；R3/R4/R9 待排期）
> 关联设计：`docs/superpowers/specs/2026-10-23-design-to-test-dual-layer-design.md`
> 关联实现：提交 `8217b7d` / `82ef0ca` / `da9d133` / `a9966ed`（DESIGN §13.202–§13.203）

## 1. 背景

在完成「人类层 / 执行器层双层产物」「API 变更四态」「跨端 `semanticId` 与 `suite parity`」并在 `starbuckstw`（Android）与 `starbucks-ios-taiwan`（iOS）上完成同源生成核验后，本文档汇总当前系统中仍然存在的真实风险点。

rev 2 对照代码现状核实并吸收了评审意见：

- 补入 **R1 对偶面（步骤编辑后重建的执行质量降级）**、**`semanticId` 派生稳定性（防对账/口径微调打断配对）**、**`apiReview` 在面板/中心台账的可回溯性**；
- 推翻 R4 原“将 `apiSpec` 注入 `taskDesc`”的方案（避免破坏 `taskDesc` 精确匹配回填 `case_id` 的契约），改为挂接 `error-codes.json` / `api-errors` 归类；
- 为 R2 补齐 **runner 领取路径** 与 **导入集 `n/a (imported)` 豁免**；
- 为 R3 补齐 **写者仲裁、版本步调校验与单机/多机边界声明**。

---

## 2. 风险总览

| # | 等级 | 风险项 | 触发条件 | 修正后方案 | 工作量 |
|---|---|---|---|---|---|
| R1 | **P0** | Excel 编辑回环：改预期/数据不触发重建；改步骤重建时丢失设计引用/定位提示 | 测试人员改预期/测试数据（静默忽略）或改步骤（重建后丢 grounding） | 哈希扩为 `steps + preconditions + expected + testData`；已编辑分支保留原 `designRefs` 与可复用 locator 提示并给出明确 warning | 小（~50 行） |
| R2 | **P0** | `apiReview.status = pending` 时未阻断执行（含 runner 路径） | 声明有新/改 API 但未补说明就直接跑 `suite run` 或被 runner 领取 | `check` / `run` / `runner` / `design_to_test(run:true)` 默认拦截 pending（`--allow-pending-api` 放行；导入集 `n/a (imported)` 自动豁免） | 小–中（~70 行） |
| R3 | **P0** | Android / iOS 各自存放 `flows.json` 与 `reconciliation.json`，且直接共享写会制造新漂移 | 单端重提设计或单端跑出新对账升级边；或两端并发写共享文件 | 限定单机双项目可选 `design.sharedDir`：canonical `flows.json` 只读共享 + `tests.json` 强校验 `flowsFingerprint` 步调；对账升级走写前指纹 CAS 或显式 promote，不破坏多机独立取舍 | 中（半天） |
| R10 | **P1（偏 P0）** | `semanticId` 派生包含 `expectations.hints/provenance`，易被单端对账或文案微调打断配对 | 一端有 `reconciliation.json` 升级边或 `acceptance.json` 覆盖，另一端没有 | `semanticId` 基底收紧为**纯路径结构**（归一化屏幕序列 + 动作类型 + 目标屏）；期望/来源差异留给 `suite parity` 报字段级 diff，不打断用例配对 | 小（~35 行） |
| R4 | **P1**（原 P0） | `apiSpec` 只留档，未进入运行期 API 错误校验（**禁改 `taskDesc`**） | 新接口返回异常状态码/业务码，执行器与失败分域无感知 | **不注入 `taskDesc`**（保护 `task_stats.case_id` 精确匹配与稳定性）；改为从 `apiSpec` 提取/校验 `error-codes.json` 规则并在 `api-errors` 分域与 preflight 中消费 | 中（半天） |
| R5 | **P1** | `displayId`（`TC_xxxxxx`）与 `caseId`（`case-xxx`）双轨，消费端只认 `caseId` | 两端 locator 不同导致 `caseId` 不同但 `TC_` 相同 | 统一解析器：支持 `caseId` / `semanticId` / `displayId` 定位（`--case`、`flake`、`quarantine`），内部台账主键仍为 `caseId` | 小–中（~60 行） |
| R6 | **P1** | 功能分组命名（`module`）的 LLM 非确定性，且需与既有 `feature key` 体系对齐 | 无候选名时两端分别调 LLM 起名 | 挂靠既有 `applyIdentity`（`feature key` + 屏幕重叠继承）：将命名结果持久化到 `flows.json` 的 feature 元数据中，同源 flows 直接继承 | 小（~45 行） |
| R11 | **P1** | `apiReview` 虽已入 `RunManifest`，但未进面板批次详情与中心台账摘要 | 远端 runner 清单不可达或清单清理后，事后归因查不到当时是否缺 API 说明 | `PanelBatchDetail` 暴露 `apiReview` 快照；`suite_runs` / 批次摘要回显 `api-pending` 标记 | 小（~40 行） |
| R7 | **P2** | 设计稿无文字且图层名技术化时退化为「点击『按钮』」 | 同屏多个无文字图标/按钮 | `humanElementLabel` 在 `textHints` 缺失时优先消费 `flows.json` 中已 grounding 的 `vision` 语义 label，其次才回退通用控件名 | 小–中 |
| R8 | **P2** | `tests.md` 每条用例最多嵌入 3 张设计图，长流程后半段无图 | 4 屏以上的长流程用例 | 按用例内**去重后的屏幕顺序**嵌入，上限由 3 提高到 **8**（兼顾长流程可读性与 Markdown/面板渲染性能） | 小（~20 行） |
| R9 | **P2** | 面板角色与 CMS 限流/配额为单进程内存级 | 反向代理部署或进程重启 | 维持内网边界声明；跨实例时再落 PG/网关 | 暂不改 |

---

## 3. 逐项详细评估与方案定稿

### R1（P0）：Excel 编辑回环的完整性（哈希范围 + 已编辑分支保真）

- **代码现状核实**：
  1. **未编辑分支**（`src/figma/test-xlsx.ts`）：`humanStepsHash` 目前只计算 `steps + preconditions`。测试人员若只修改 Excel 的「预期结果」或「测试数据」列而未改「步骤」列，导入时哈希一致，会**静默复用旧 `taskDesc`**，新预期/新测试数据丢失。
  2. **已编辑分支**（`src/workflow/excel-import.ts:346`，评审缺席项 A）：代码已实现“哈希不一致 → 按人类列重建 `taskDesc` + 保留原 `caseId` + 推入 `importWarnings`”，不会报错阻断；**但重建出的合成 `taskDesc` 丢失了隐藏 sheet 里的 `设计引用`（`designRefs`）以及原有的起止屏结构**，导致轻微编辑后真机执行可靠性陡降。
- **定稿方案**：
  1. 将隐藏 sheet 的哈希升级为 `humanCaseHash(steps, preconditions, expectations, testData)`；
  2. 细化变更检测：区分「完全未改（直接复用原 `taskDesc`）」「仅预期/测试数据已编辑」「步骤已编辑」；
  3. 重建 `taskDesc` 时，从隐藏「执行器」sheet 继承 `designRefs`（设计页面/节点引用）附在末尾，并在 `importWarnings` 中精确提示修改了哪些列（如 `第 2 行预期结果已编辑：执行描述已同步更新，保留原 caseId`）。

### R2（P0）：`apiReview.status = pending` 的执行门禁（含 runner 与豁免族）

- **现状**：生成阶段允许 `apiChange = "new" | "modified"` 在缺 `apiSpec` 时先生成并标 `status: "pending"`。但 `preflightGeneratedTests`、`suite check`、`suite run`、`suite runner` 与 `design_to_test(run:true)` 均未拦截 `pending`。
- **评审修正点**：
  1. **必须覆盖 runner 领取执行路径**：`suite runner` 自动领取回归任务并调用 `suite run --task` 时，若引用的用例集 `apiReview.status === "pending"`，同样应在执行前阻断并标记失败原因，防止无人值守跑批污染统计；
  2. **导入集豁免**：经 Excel 导入的用例集（`isImportedTestsFile`，覆盖闸为 `n/a (imported)`）天然无 `apiReview`，门禁必须自动豁免；
  3. **CI / 非交互口径**：默认 fail-closed（exit 2，提示补充 `apiSpec` 或传 `--allow-pending-api`）；`status === "unknown"`（未显式声明 `apiChange` 的存量产物）只出 warning，不硬拦截。

### R3（P0）：跨端共享设计真源（解决写者仲裁、版本步调与多机边界）

- **现状**：手工同步 `flows.json` + `reconciliation.json` 后两端 `parity=0`，但日常各自目录独立存放，单端重提或单端对账升级即再次分叉。
- **评审指出的三个方案缺陷及定稿解法**：
  1. **多机边界声明**：多机设计（§16.2）已确定“跨主机项目独立、不共享本地磁盘”。因此 `design.sharedDir`（或 `AOS_SHARED_DESIGN_DIR`）**明确限定为“同机双端工作区（单机同时开发 Android 与 iOS）”的可选能力**；跨主机场景不共用目录，而是通过 Git 提交共享设计包或用 `suite parity` 校验。
  2. **写者仲裁（防并发互相覆盖）**：共享目录只放**设计真源与经确认的契约**（`flows.json`、`acceptance.json`、`ui-contract.json`、`screens/`）；提取写入采用原子替换 + 源指纹记录。运行期自动产生的 `reconciliation.json` **默认仍写项目本地**，仅在人工执行 `suite reconcile confirm`（或显式同步）时才将 `human-confirmed` 边合并进共享源，避免两端跑批并发覆写。
  3. **版本步调校验**：`tests.json` 已记录 `flowsFingerprint`。`suite check` 与 `suite parity` 增加步调检查：若当前 `tests.json.flowsFingerprint` 与生效的 `flows.json` 指纹不一致，显式告警/阻断（提示 `flows.json 已更新，请重新生成用例以保持跨端同步`），防止 A 端已升 v2 而 B 端仍拿 v1 的旧 `tests.json` 跑。

### R10（P1 偏 P0，新增）：`semanticId` 派生的跨端稳定性

- **现状**：`semanticIdFor`（`src/figma/test-gen.ts:590`）当前把 `screens`、`humanSteps`、`preconditions` 和 `expectations(screen, hints, kind, provenance)` 全部纳入哈希。
- **问题（本轮实测已复现）**：当一端有 `reconciliation.json` 把某条边从 `inferred` 升级为 `runtime-observed`（或一端配了本地 `acceptance.json`），`expectations` 与 `humanSteps` 里的断言描述就会变化，导致**同一条业务路径在两端的 `semanticId` 与 `TC_xxxxxx` 直接分叉**，`suite parity` 报成“少一条 + 多一条”，而不是报“同一条用例的第 2 步不一致”。
- **定稿方案**：
  - 将 `semanticId` 的派生基底收紧为**纯路径骨架**：`起点屏 + 每步(fromScreen, toScreen, triggerType, back)`（或归一化后的 `screens` 序列 + 边序号）；
  - 剥离易受对账状态、文案微调和本地验收口径影响的 `hints`、`provenance`、`humanSteps` 文本；
  - 效果：只要两端走的是同一条页面跳转路径，`semanticId` 与 `TC_xxxxxx` 就恒定一致；步骤文案、断言口径或对账状态的差异由 `suite parity` 在该 `semanticId` 下精确报告为 `field` 差异。

### R4（P1，原 P0）：`apiSpec` 与执行/错误码校验联动（严禁污染 `taskDesc`）

- **评审关键纠正**：
  - `mobile_run_task` 提交后，`src/tasks/ledger.ts` 依靠 `taskDesc` 全文精确匹配来回填 `task_stats.case_id`；且双层设计 §12.1 锁死了机器步骤与 `taskDesc` 契约不动。
  - 若在原位补充 `apiSpec` 时把接口说明拼进 `taskDesc`，会导致 `taskDesc` 变化、破坏历史回填与稳定性契约。
- **定稿方案**：
  1. **绝不修改 `taskDesc`**；
  2. 在 `preflightGeneratedTests` 与运行报告中暴露 `apiReview` 状态；
  3. 提供轻量辅助：当 `apiSpec` 中包含显式错误码/HTTP 路径声明，且项目未配置 `.artemis/design/error-codes.json`（或缺少对应规则）时，在生成/校验期给出可操作的提示，由现有的 `api-errors` 日志匹配机制在运行期做确定性捕获与失败分域。

### R5（P1）：三类用例 ID（`caseId` / `semanticId` / `displayId`）的统一解析

- **现状**：内部台账与历史资产用 `caseId`（`case-xxx`），跨端对齐用 `semanticId`（`sem-xxx`），测试人员沟通与 Excel 主表用 `displayId`（`TC_xxxxxx`）。
- **定稿方案**：
  - 在 `design-store.ts` 提供统一解析函数 `resolveCaseSelector(selector, cases)`：输入任意一种 ID，均解析为目标用例的机器 `caseId`；
  - 接线到 `suite run --case`、`suite flake --cases`、`suite baseline --case` 与 `quarantine.json` 匹配逻辑；
  - 若同一个 `displayId` / `semanticId` 因罕见碰撞对应多条 `caseId`，显式列出候选并要求传完整 ID（不静默猜首条）。

### R6（P1）：功能分组命名挂靠既有 `feature key` 体系

- **现状**：`nameFeatures` 在无候选名时调 LLM；既有 `applyIdentity`（`src/figma/features.ts:271`）已通过 `prior: PriorFeature[]`（按屏幕集合相等或 ≥50% 重叠）继承历史 `key` 与 `name`。
- **评审修正点**：不要在 `applyIdentity` 之外另建一套孤立缓存，否则两套机制打架。
- **定稿方案**：
  - 直接复用 ` PriorFeature` 结构：在 `flows.json` 顶层可选保存 `features: Array<{ key, name, screens }>`；
  - `figma_generate_tests` 读取 `flows.json.features` 作为最高优先级的 `prior` 传给 `applyIdentity`，并在首次命名后写回 `flows.json.features`；
  - 这样同一份 `flows.json` 无论在 Android 还是 iOS 生成，都走同一套 `applyIdentity` 继承完全相同的 `feature key` 与中文 `module` 名，零 LLM 随机漂移。

### R11（P1，新增）：`apiReview` 在面板批次详情与台账中的可回溯性

- **现状**：`RunManifest` 顶层已冻结 `apiReview` 快照（`src/figma/run-manifest.ts:340`），但 `PanelBatchDetail`（`src/panel/overview.ts`）与 `renderBatchPage`（`src/panel/web.ts`）尚未读取和渲染它。
- **定稿方案**：
  - `PanelBatchDetail` 增加 `apiReview: RunManifest["apiReview"]`；
  - 批次详情页「结果概览」在 `apiReview.status === "pending"` 时渲染醒目黄色 chip `API 说明待补`（`provided` 渲染 `API 已核备`）；
  - 让半年后翻查历史失败批次时，一眼能看到“当时是在缺少 API 说明的情况下跑的”。

### R7（P2）：无文字节点优先消费 `vision` 语义标签

- **定稿方案**：`humanElementLabel` 优先级固定为：
  `运行期可见文本 (textHints)` → `已 grounding 的 vision 元素 label` → `剥离通用词后的可读图层名` → `通用控件名（按钮/图标/…）`。

### R8（P2）：`tests.md` 截图嵌入去重与上限调整

- **定稿方案**：
  - 对单条用例的 `screens` 先按首次出现顺序**去重**（例如 `首頁 → … → 首頁` 不重复贴两张首頁图），再将单用例嵌入上限从 `3` 调为 **`8`**；
  - `screenshotEmbedWarning` 同步按 `Math.min(deduped.length, 8)` 校验，兼顾 7–8 步完整业务链路的看图需求与 Markdown 体积上限。

### R9（P2）：面板角色与 CMS 配额的进程级边界

- **定稿方案**：保持现状与文档声明，不在本阶段引入多租户 DB 表。

---

## 4. 实施批次建议（更新后）

1. **第一批（立即可做，修复静默错误与核心分叉，约 1–2 小时）**：
   - **R1**：Excel `humanCaseHash` 覆盖 `steps + preconditions + expectations + testData`，编辑重建时保留 `designRefs`；
   - **R10**：`semanticId` 改为纯路径骨架派生，彻底消除因单端对账/文案微调导致的跨端 ID 断裂；
   - **R2**：`apiReview.status === "pending"` 接入 `check` / `run` / `runner` / `design_to_test(run:true)` 门禁（含导入集豁免与 `--allow-pending-api`）；
   - **R8**：`tests.md` 截图去重 + 上限提升至 8 张。
2. **第二批（可观测性与跨端体验收口）**：
   - **R11**：面板批次详情展示 `apiReview` 冻结快照；
   - **R5**：`--case` / `flake` / `quarantine` 统一支持 `caseId` / `semanticId` / `displayId`；
   - **R6**：`flows.json` 持久化 `features` 并接入 `applyIdentity`，消除跨端 `module` 命名漂移。
3. **第三批（增强项）**：
   - **R3**：单机双端 `design.sharedDir` 与 `flowsFingerprint` 步调检查；
   - **R4**：`apiSpec` 与 `error-codes.json` 校验提示联动；
   - **R7**：`humanElementLabel` 消费 `vision` 标签。


## 5. rev 3 二次审核补充

### 5.1 R1 的可执行细节补齐

- `humanCaseHash` 明确输入为 CSV 单元格等价值：`步骤列 + 前置列 + 预期结果列 + 测试数据列`；导入器需新增解析「测试数据」列。
- 重建分支（步骤/预期/数据任一变化）必须把新预期、新测试数据写回 `taskDesc`，并把隐藏 sheet 的 `设计引用` 追加到机器描述末尾；否则“检测到变化但执行描述仍旧”仍是静默错误。
- 若隐藏执行器 sheet 被用户删除或 Excel 重存剥离，导入应显式 warning「执行器层缺失：按人类列重建」，不得假装复用。

### 5.2 R10 的碰撞约束

- 纯路径骨架（起点屏 + 归一化屏幕序列 + 动作类型/目标屏）之外，必须再加一个稳定的区分项：`variant`/`testData` 摘要或路径出现序号；否则同一路径不同数据的用例共享 semanticId。
- `suite parity` 对 semanticId 相同但字段不同的条目按 field diff 报告，不把不同用例合并。

### 5.3 R11 的持久化要求

- 不能只从 `RunManifest` 读：`apiReview` 状态必须随 `SuiteRunRecord`（PG/file/memory）持久化，或在 case-set JSON 中保留；面板优先读台账，清单仅作为补充。
- `suite runs` / 批次详情在清单被清理后仍能显示“当时 API 说明 pending”。

### 5.4 R12（新增，P1）：URL 类设计源的指纹不检测内容变化

- 当前 `designFingerprintFor` 对 `args.url` 只哈希 URL；同一 Figma URL 的设计内容更新后，`designFingerprint`/`flowsFingerprint` 不变，parity 会误判同源。
- 修复：`flowsFingerprint` 哈希实际生成的 `FlowGraph`（屏幕/边/文本提示/来源）；或记录 Figma `version`/`lastModified` 参与指纹。

### 5.5 R13（新增，P1）：`apiSpec` 的结构化校验边界

- `apiSpec` 是自由文本，自动从中提取错误码/路径不可靠；R4 只在 `apiSpec` 含显式规则或项目已有 `error-codes.json` 时联动，不能承诺自动覆盖全部接口。
- 若未来要硬门禁，应增加结构化 `apiChecks`（method/path/expectedStatus/errorCode）而不是解析自由文本。
