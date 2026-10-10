# CR 交互理解强化：来源模型（provenance）/ 双源对账 / 探索式用例

Status: ready-for-agent（本地 tracker；2026-10-10 评审收敛于 Q1–Q10；根决策见 ADR-0007/0008；tickets 见 `issues/01–11`；凭证就绪后机械迁 Jira）

## Problem Statement

用户的输入通常是一个 **Figma 或 pen 的设计 URL/文件**（CR 的设计载体），期望链条「交互理解 → 测试用例撰写 → 代码编写 → 开展测试 → 输出测试结果」跑通。现实是：

- **设计源往往不携带交互语义**：Figma 侧只读原型 `interactions`，设计师不连线时静默产出 0 边的孤岛图（无结构化告警）；pen 侧当前**无条件**按画板顺序链式合成，trigger 固定为推断，不检测文件里是否本有交互数据。
- **推断被当事实、批注被当断言**：不确定性只存在于 warnings 文案；hints 收集不过滤 `Flow/*` 批注层。starbucks 现场：22 条推断边全部进入硬断言，22 步中 19 步核不上，第 4 步因「刊頭廣告 - 活動跑馬燈」「Flow/Section」「Promo hero banner」这类**设计批注文本**被当作期望而"失败"——这是链路脱轨，不是应用缺陷。
- **结果不可归因、不回写**：失败域没有「设计推断错误」类，只能塞进用例缺陷/行为设计；执行结果不回流修正设计理解（feedback 只读）。

链条脱轨点：生成的是**不可定位步骤** → 断言里混有**批注文本**、前置数据缺失 → 执行只能探索/猜 → 失败归因失真、理解不收敛。

## Solution

按评审决议（Q1–Q10）实现一套「来源模型 + 双源对账 + 升级」机制，输入主通道保持 Figma/pen URL：

1. **来源模型**：screen/edge/step 携带机器可读 `provenance`（显式交互 / 推断 / 真机观测 / 人工确认）与 `confidence`；文本分三类（运行期文本 / 批注 / 图层名）。
2. **推断边降级**：默认只生成**探索步骤**（可执行、不断言、不参与 PASS/FAIL 与硬覆盖门禁），探索产物进对账。
3. **双源对账 + 人工确认**：设计与真机观测双向对账，持久化差异清单；**导航级**证据可随观测自动升级，**硬断言级**需验收标准（设计标注/人工确认；Jira AC 为可选后接）背书；人工只仲裁不一致。
4. **元素级定位**：执行/探索时自动发现 design node ↔ accessibility id 映射并持久化，人工只补关键路径；同时成为代码侧 accessibilityIdentifier 建议来源。
5. **结果防脱轨**：新增 `design-inference` 失败域；覆盖闸区分硬覆盖/探索覆盖；弱断言可选 `--strict` 升门禁。

## User Stories

1. 作为测试工程师，我希望给一个 Figma/pen URL 就能得到「带来源标注」的交互理解产物，以便知道每条跳转/文本证据有多可信。
2. 作为测试工程师，我希望设计稿有显式原型交互时直接按显式交互生成硬断言用例，以便零人工跑主链。
3. 作为测试工程师，我希望设计稿没有交互数据时收到结构化告警（而不是静默孤岛图），以便立即知道需要补设计或走探索。
4. 作为测试工程师，我希望设计批注（`Flow/*`、note 类图层）永远不成为断言文本，以便消除 starbucks 式假失败。
5. 作为测试工程师，我希望推断边被生成成探索步骤（可执行、记录实际路径、不断言），以便在真机上把推断变成事实。
6. 作为测试工程师，我希望探索步骤不参与 PASS/FAIL 与硬覆盖门禁，以便门禁保持可信。
7. 作为测试工程师，我希望真机观测走通的导航自动升级为可用证据，以便下一轮生成直接少一次探索。
8. 作为测试工程师，我希望升级/冲突有持久化的对账资产（可审阅、可复用、可审计），以便团队共享同一份理解。
9. 作为测试工程师，我希望人工只仲裁「设计 ↔ 观测」不一致，而不是逐条确认所有推断，以便成本可控。
10. 作为测试工程师，我希望硬断言的期望来自验收口径或人工确认（设计标注先行，Jira AC 可选集成），以便断言有"应该"的背书。
11. 作为测试工程师，我希望执行观测能自动发现「设计元素 ↔ accessibility id」映射并持久化，以便推断边逐步变成可定位路径。
12. 作为 iOS 开发者，我希望获取生成的 accessibilityIdentifier 建议（来自元素映射），以便代码与测试共享稳定锚点。
13. 作为测试工程师，我希望用例产物区分探索步骤与硬断言（taskDesc/清单可辨识），以便执行与评审都清楚边界。
14. 作为 CI 维护者，我希望 `suite check` 区分硬覆盖与探索覆盖，以便 `requireFullCoverage` 不被推断边虚高。
15. 作为 CI 维护者，我希望弱断言可选 `--strict` 升级为门禁，以便质量策略可调。
16. 作为排障者，我希望失败归域能标出 `design-inference`（并在报告中显示来源/置信度），以便知道该改设计还是改应用。
17. 作为仓库维护者，我希望旧 artifacts（无来源字段）按保守等级兼容并可回填来源，以便既有项目平滑升级。
18. 作为仓库维护者，我希望 `generation-feedback` 增加「推断边/弱断言」维度建议（保持只读），以便生成持续变好。
19. 作为双端使用者，我希望 iOS/Android 消费同一份平台中立产物，行为差异显式标注、不静默。
20. 作为仓库维护者，我希望全部新行为有不依赖真机/PostgreSQL/外网的测试。

## Implementation Decisions

1. **输入范围**：主输入 = Figma URL / pen 路径；Jira AC 摄取为可选集成，本批不做（见 Out of Scope）。
2. **来源模型（ADR-0008）**：`provenance ∈ {explicit-interaction, inferred, runtime-observed, human-confirmed}` + `confidence`，落在流程 screen/edge 及其派生的 case step/expectation；文本类别 `{runtime-text, annotation, layer-name}` 随 hints 输出。
3. **兼容**：缺来源字段 = legacy-unknown，一律按保守级（推断）处理；解析升级可回填（Figma 显式交互 → explicit；pen 合成 → inferred）。
4. **解析侧**：pen 检测 `.pen` 是否携带交互数据（有则不合成/或显式标注）；Figma 无交互数据时新增结构化告警码（不再静默）。
5. **文本分类（Q6）**：结构规则（`Flow/*` 分组、note 类图层）先过滤批注；断言只消费运行时文本；「设计有 + 真机见过」= 硬断言级，「设计有 + 未见」= 提示/待对账，「真机有 + 设计无」= 额外观测。
6. **生成侧（Q4/Q8）**：推断边 → 探索步骤表示（GeneratedTest 新标记/字段）；expectations 携带来源；AC/确认背书才转硬断言；taskDesc/AOS-EXPECT 扩展且保持 Android 中立。
7. **覆盖口径（Q9）**：硬覆盖（explicit/observed/confirmed）与探索覆盖分开统计；`requireFullCoverage` 按硬覆盖（探索覆盖单独报告）。
8. **对账资产（Q5）**：持久文件（模式照 screen-map，ADR-0004 先例）记录：边/元素的对账结果、升级状态、冲突与人工裁决；纯函数模块 + CLI/MCP 审阅面。
9. **升级规则（Q5）**：导航级 promotion 由 runtime-observed 自动触发；硬断言级需 human-confirmed 或验收口径背书。
10. **元素级映射（Q7）**：执行观测（文本 + 几何匹配）自动发现并写资产（带 confidence）；人工补关键路径；输出 accessibilityIdentifier 建议。
11. **执行侧首批（iOS）**：探索步骤执行语义（不硬失败、记录实际路径、deferred 标记）；adherence 只对硬断言核对。
12. **结果侧（Q9）**：failure-taxonomy 增 `design-inference` 域；门禁 `--strict`；报告显示来源/置信度。
13. **反馈**：`generation-feedback` 增推断边/弱断言维度建议（保持只读，不自动改产物）。
14. **根决策引用**：ADR-0007（双源对账 + 人工确认，不设单一权威源）、ADR-0008（来源/置信度进数据模型）。

## Testing Decisions

- **好测试**：只测外部行为——fixture 进、产物/退出码出；不测内部实现细节。沿用仓库既有「产物边界」三条缝（最高稳定接口）：
- **解析缝**（FlowGraph）：fixture 的 Figma/pen JSON → 图结构、来源/类别/告警断言；先例：既有解析类单测（fixture → 图结构）。
- **生成与门禁缝**（GeneratedTest）：flows.json fixture → tests.json/三件套、探索步骤、覆盖口径、AC 落点；CLI 层 `suite check` 行为与退出码；先例：既有生成单测 + suite 命令测试。
- **执行与结果缝**：假设备/假 WDA 驱动 iOS 执行器跑（探索不挂门禁、deferred、design-inference 归域）；对账资产纯函数单测（模式同 screen-map）；先例：既有执行器单测、failure-taxonomy、screen-map 测试。
- **兼容测试**：无来源字段的旧 flows.json/tests.json 走保守路径。
- 全部测试不依赖真机 / PostgreSQL / 外网（仓库硬约定）。

## Out of Scope

- Jira AC 摄取（可选集成，凭证与撮合后续另开票）。
- 自动修改设计稿 / 回写 pen 交互数据。
- 全量人工确认 UI/编辑器（只做持久文件 + CLI/MCP 审阅面）。
- Android/ARTEMIS 执行器内部改造（产物同源；如需对齐另开 spec）。
- 设计批注的视觉识别（先结构化规则；OCR 级后置）。

## Further Notes

- 现场证据：starbucks-ios-taiwan pen 合成链路（22 推断边全进硬断言；22 步 19 步 unresolved；第 4 步批注文本假失败）。
- 与历史 spec 的关系：承接 `design-device-diff` 的 screen_map 资产模式、`flow-completeness` 的覆盖闸、`test-loop-deepening` 的闭环思路。
- tracker：本地 `.scratch/cr-interaction-understanding/`（本 spec + issues/）；Jira 沙箱凭证就绪后按 `docs/agents/issue-tracker.md` 迁移。
