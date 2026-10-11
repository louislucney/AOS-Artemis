# CONTEXT — AOS-ARTEMIS 领域术语表

> 本文件只放术语（glossary），不放实现与规格。

## 设计与真机对比

- **设计渲染（design render）**：设计源的可视快照，作为对比的基准侧。例如 Figma 节点导出图、`.pen` 文件的渲染图。与具体来源工具无关（来源可替换）。
- **真机截图（device capture）**：ARTEMIS 从设备获取的屏幕图，作为对比的观察侧。按获取时机分为「实时截图」与「步骤截图」。
- **步骤截图（step screenshot）**：某一次任务执行中，某一交互步骤的截图（含动作标注 overlay）；用于把差异锚定到具体执行步骤。
- **对比单元（comparison unit）**：一次对比中的配对单位——一个设计渲染与一张真机截图，配对依据是同一屏幕/节点。
- **对齐（alignment）**：把设计渲染与真机截图放到同一坐标系所需的缩放/平移/裁剪；结果必须可复现、可写入报告。
- **差异判定（diff judgment）**：判定两张图是否存在「明显差异」并给出候选差异区域。分层：确定性判定产生候选与证据；模型只做归类与解释，不承担判定。
- **差异报告（diff report）**：差异的机器可读产物。每条差异包含类型、区域、严重度、证据与置信度；是反馈与定位的共同输入。
- **定位（localization）**：把一条差异映射到实现侧的组件/文件（粗粒度），或映射到设计稿节点、测试用例步骤、执行步骤（作为分类标签）。
- **屏幕映射（screen map）**：设计屏幕/组件与实现侧路由、组件、文件之间的持久对应表；差异报告经由它完成实现侧定位。
- **差异分类（diff category）**：差异的类别（缺失/多余/位置尺寸/颜色/文案/资源）与严重度（blocker/major/minor/info），由确定性规则给出，模型不参与。
- **修复建议（fix suggestion）**：针对一条已定位差异给出的修改方向；解释层产物，不参与判定。

## 使用统计

- **调用事件（invocation event）**：一次客户端发起的 MCP 工具调用及其结果的结构化记录（工具、成败、耗时、错误/信号）；是使用统计的最小单位。
- **使用统计（usage stats）**：对调用事件的按项目聚合与查询（计数、成功率、耗时、信号分布）；只统计客户端发起的调用，不含服务内部编排的调用。
- **信号（signal）**：调用事件中值得关注的结构化旁证——错误分类（含 `unclassified` 兜底）、响应 `warnings[]` 码、显式降级标记、参数键集合；用于发现现有实现未覆盖的情况。
- 不要把「使用统计」说成「任务统计」（`task_stats` 是 `mobile_run_task` 的生命周期台账），也不要与设计资源的 `usageCount`（引用计数）混用。

## 平台对等

- **平台对等（platform parity）**：iOS 路径与 Android/ARTEMIS 路径在工具契约（入参语义、响应字段、产物与闭环）上的一致要求；内部实现机制允许不同，iOS 执行器不要求复刻 ARTEMIS Pro。
- **显式降级（explicit degradation）**：iOS 无法与 ARTEMIS 等价的能力，必须以结构化标记体现在响应中，并配文档与测试；静默忽略参数、返回伪造数据不属于降级。
- 不要把「平台对等」说成「对齐」：对齐（alignment）已专指设计渲染与真机截图的坐标对齐。

## Jira 接入

- **issue 上下文（issue context）**：Jira issue 的读取产物——元数据（summary/status/type/labels/project/assignee 等）+ 描述纯文本 + 启发式验收标准（标注 `heuristic`，不保证完整/准确）+ 原始 ADF；是生成测试用例的输入。
- **验收标准抽取（acceptance criteria extraction）**：从描述 ADF 的标题段（Acceptance Criteria / 验收标准 / AC）延续到下一标题，或 `AC:` 行回退的启发式清单；属于标注，不是权威字段。
- **证据回写（evidence post）**：把任务/套件失败证据（失败步骤截图、diff 标注图、报告摘要、崩溃签名）以幂等评论与去重附件写回 issue（M8b 范围）；评论按 issue+trace 就地更新而非追加。
- 不要把「Jira 接入」的 issue 与仓库自身的 issue tracker 混同：前者是产品能力（读写客户 Jira），后者是 agent 工作流的载体；M8c 迁移后两者共用同一 Jira 客户端。

## iOS 真机后端

- **WDA 会话（WDA session）**：AOS 经 Appium 与 WebDriverAgent 建立的设备会话；同 UDID 同时最多一个，任务级 lease + 观测会话空闲回收。
- **观测会话（observation lease）**：截图/层级等只读调用共享的会话；被任务占用时有界等待后返回 `device_busy`（结构化变体携带最近缓存帧：截图可降级为缓存帧并标注 `capturedAt`，层级仅结构化报错；非无限排队）。
- **设备 façade（device facade）**：执行器使用的设备能力抽象（tap/swipe/inputText/launch/terminate/nodes/screenshot）；模拟器由 idb/simctl 实现，真机由 WDA 实现。
- **backend**：观测/对比产物中标注的实现来源（`wda` 真机 / `idb`|`simctl` 模拟器），出现在截图 note 中。
- **设备解析（device resolution）**：由 serial 种类（模拟器 UDID / 真机 UDID）选择设备后端的唯一入口（`Runtime.iosDevice` → `src/device/ios-facade.ts`）；非 iOS serial 返回空，真机缺少 WDA provider 显式报错（不静默错造模拟器设备）。

## CR 交互理解

- **CR（变更需求）**：一次待交付的变更单元——Jira 工单、要做的功能/设计、设计稿（Figma/.pen）与验收标准是同一件事的不同侧面，不独立成概念。
- **交互理解（interaction understanding）**：CR 的页面/元素/跳转/前置数据/验收口径的结构化产物；测试用例与代码编写的共同输入。
- **来源（provenance）**：一条交互或文本证据出处的机器可读标注（显式（设计稿明确给出）/ 推断 / 真机观测 / 人工确认）；旧产物缺字段记 `legacy-unknown`。生成、执行、门禁与报告按来源分流。
- **置信度（confidence）**：与来源绑定的粗粒度可信等级（`high` / `low`；显式/观测/确认 = high，推断/旧产物 = low）。
- **文本类别（text class）**：设计文本的分类（`runtime-text` 运行期文本 / `annotation` 批注 / `layer-name` 图层名）。
- **对账（reconciliation）**：设计来源与真机观测的双向比对；不设单一权威源，不一致与断言升级经人工确认后改判。
- **人工确认（human confirmation）**：对账冲突的仲裁与推断升级为可信输入的环节；只处理不一致，不是全量劳动。
- **推断边（inferred edge）**：来源为推断的跳转（无交互数据时按画板排布等启发式合成）；默认生成探索步骤，不生成硬断言。
- **探索步骤（exploration step）**：由推断边生成的可执行、不断言的步骤；产出对账证据。
- **升级（promotion）**：证据可信级别的提升（推断 → 真机观测 / 人工确认）。
- **批注文本（annotation text）**：设计稿里的说明性文字（`Flow/*` 分组、note 类图层等），非运行期界面文本；只作提示，不能成为断言。
