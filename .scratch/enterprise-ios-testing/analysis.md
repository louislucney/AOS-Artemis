# iOS 自动化测试连续性治理与企业级标准 — 四声部分析（待 review）

> 日期：2026-10-08
> 方法：council 技能（四声部：Architect / Skeptic / Pragmatist / Critic；三个外部声部为独立子代理，反锚定）
> 背景：本工作区无 `stormbrain` 技能（已全盘搜索），以 council 作为最接近的等价展开
> Status: ready-for-human —— 本文件为分析 + 建议，等 review 后再决定是否拆票据实施
> 第二轮（2026-10-08）：外部反馈已评估，修正结论见 §8；票据拆分待确认
> 第三轮（2026-10-08）：票据已拆（`issues/01–09`）并执行；实施记录见 §10
> 关联：`.scratch/flow-completeness/review.md`（流程完整性三闸已落地）、DESIGN §6.10、`.scratch/test-loop-deepening/issues/07-preflight-coverage.md`

---

## 1. 问题

两个诉求：

1. **不连续性**：现有 iOS 自动化测试"一段一段"，不成流程——用例之间无状态连贯，也不走设计定义的真实用户路径。
2. **企业级标准**：如何确保自动化测试这个功能满足严格企业测试要求（流程连续、可追溯、可重复、CI 可门禁、审计可查）。

---

## 2. 实测证据（不连续性的成因）

| # | 事实 | 影响 |
|---|------|------|
| 1 | 每用例重启 app + 用调试入口 `-MOPItemDetailDemo` 直进目标页，跳过真实导航（首页→门市→取餐→列表→单品页） | 断言通过≠用户路径可用；真实入口/登录/门市可用性从未被覆盖 |
| 2 | `testcases.md` 声明前置链（TC-07 前置 TC-06），代码中每个 case 各自重启重建，无状态传递 | 用例彼此孤立，无法验证"上一步的产物是下一步的输入" |
| 3 | 33.4s 单用例中 ~15s 是失败等待（5s 弹窗空等 + 10s toast 空等），toast 快照其实出现过、轮询错过 | 运行慢、且失败原因被等待掩盖 |
| 4 | E2E demo 数据不连贯：选南山门市→订单状态断言善化门市；加购可可玛奇朵→检视订单断言另一商品 | 很可能长期掩盖真 bug；换任何测试架构都修不好 |
| 5 | 无 UI 设计符合度断言（测试只查 identifier/文案/金额/状态） | 设计走样无法在自动化里暴露 |
| 6 | 调试后门（demo 入口）随包编译 | 出厂即审计/安全发现项 |

**根因**：XCTest 进程隔离（按测试方法重启）+ 测试文档按屏拆分 + demo 后门造态捷径。其中只有"进程隔离"是框架事实；"按屏拆分"与"后门造态"是设计选择（Skeptic 的前提检验）。

---

## 3. Council 记录

### Architect（会前立场，未受外部声部影响）

**B+C**：MCP 做唯一企业验收门禁；XCUITest 降级为可选本地回归。
理由：① 可追溯链（design→case→task→trace→evidence）只有 MCP 产得出；② XCUITest 碎片化补齐成本高，且违背"项目最小介入"；③ MCP 一次连续任务 + 已落地三闸天然端到端。
风险：视觉 agent 确定性弱于 XCTest，单点门禁可能 flaky。

### Skeptic

- **立场**：拒绝 B，也拒绝"碎片化是架构性的"前提；取 C 硬版本——门禁只能由确定性 XCTest 承担，MCP 只做生成/证据/编排，不做验收执行器。"最小项目介入"是病根，不是约束。
- **理由**：门禁=可重复+可归因，LLM 不回放、失败不可分类；XCTest 隔离的是测试方法而非会话，单方法内可一次启动、连续真实导航，demo 后门是作者选择；xcresult 按 case_id 对齐 tests.json 即可闭环，最便宜修法=3–5 条流级 E2E + 固定种子 fixture。
- **风险**：组织不让步"最小介入"→ 流级用例无人维护、半年腐烂；XCTest flake 真实存在，重试与 quarantine 预算必须提前明说。
- **意外**：调试后门随包出厂=审计/安全发现项；数据矛盾（南山/善化、商品 A/B）是产品数据缺陷，现在很可能一直在掩盖真 bug。

### Pragmatist

- **立场**：选 B——MCP 做唯一验收门禁；XCUITest 冻结为可选本地冒烟，不再投入修连续性。
- **理由**：B 已建成九成（flows→taskDesc、三闸、evidence/baseline/report、case_id、崩溃取证、设计对比），落地只差接线与纪律；A 要重做跨进程状态传递+去后门+真实导航，直接撞"最小介入"；审计链只有 B 产得出。
- **风险**：LLM 视觉执行确定性弱，CI 门禁可能因抖动失信。对策：门禁建在"覆盖完整+证据齐全"而非单次像素稳定；接受单次成本更高。
- **意外**：现有 E2E 错位根因是 demo 数据不连贯而非跳步——A 修好连续性照样断言失败；真瓶颈是证据链与设计对齐，不是框架选型。

### Critic

- **立场**：选 C，但纠正定位——"XCUITest 仅做本地细粒度回归"是错的；它应保留为 MCP 门禁的**确定性差分校准器（同 commit 交叉校验）**，否则双轨必然债化。
- **理由**：B 独任门禁=把审计信誉押在 LLM 可重复性上（每步 5–30s 推理、无确定性保证、单设备 FIFO）；门禁一 flaky，组织必然"重跑到绿/上 force"，evidence 链再完整也只是记录了不确定判定；双轨若无仲裁规则会退化为政治（MCP pass / XCTest fail，谁签字）。
- **风险**：双轨所有权分裂；XCTest 轨道无 owner/预算则两季度内腐烂成僵尸套件。
- **意外**：**无人定义 oracle**——flows.json 源自 Figma 原型，真实 app 导航常与原型脱节；Jira/PRD 与 Figma 冲突无优先级规则；baseline 缺设计冻结锚点，"可重复"在 Figma 被编辑那刻失效。

### Verdict

- **共识**：MCP 独占"设计→用例→台账→证据"审计链（XCTest 产不出）；demo 数据错位（南山/善化、商品 A/B）与调试后门是真问题，与架构选型无关；**测试数据治理必须先修**。
- **最强异议**：LLM 视觉执行能否独任企业验收门禁——Skeptic/Critic 明确否定，Pragmatist 认为可行。
- **前提检验**：①"碎片化是架构性的"只对一半（隔离按方法、非按会话；流级用例可连续；后门是选择）——Skeptic；②"项目侧最小介入"是病根而非约束——Skeptic；③ oracle 与设计冻结缺失，任何门禁方案都会失真——Critic。
- **Architect 立场修正（明确记录）**：两个外部声部（Skeptic + Critic）一致反对"LLM 独任门禁"，我接受该信号——**C 从"可选本地回归"改为"必需的确定性差分校准器"**；Pragmatist 的"门禁建在覆盖完整+证据齐全而非单次像素稳定"被吸收为 MCP 侧门禁口径。

---

## 4. 修正后的推荐架构（三层门禁）

```
L3 企业治理层   oracle/设计冻结 · 可追溯矩阵 · flake 治理 · 数据/环境种子 · CI 门禁与审计留痕
L2 确定性校准层 流级 XCUITest E2E（真导航/状态贯穿/固定 fixture） ── xcresult ──▶ MCP 差分校准与漏报率
L1 流程契约层  MCP：三闸（提取/生成/执行，已落地）+ case_id 台账 + evidence + report + 设计对比
```

| 层 | 职责 | 归属 | 现状 |
|----|------|------|------|
| L1 | 设计→用例→执行→证据闭环；流程完整性三闸；失败分类；设计-真机视觉对比 | MCP | **已落地**（三闸见 DESIGN §6.10 / flow-completeness review.md） |
| L2 | 同 commit 交叉校验：确定性套件结果按 case_id 映射进同一台账，输出差分校准与 MCP 漏报率 | MCP 接入 + 项目侧薄层 | **待建设**（这是本轮核心新增） |
| L3 | oracle 优先级与设计冻结；追溯矩阵；门槛与 flake 政策；审计报告 | 流程 + MCP 报告 | 部分缺失 |

**项目侧最小介入的"硬底"**（Skeptic 的病根论妥协版）：3–5 条流级 XCUITest——单测试方法内真实导航、状态贯穿、固定 fixture、release 构建禁用 demo 后门、明确 owner。除此之外生成/编排/证据/报告全在 MCP。

---

## 5. 差距清单（按优先级）

### P0 · 立即修（与架构无关的真问题）

- [ ] demo fixture 连贯性：南山/善化门市、商品 A/B 错位——定位为产品/数据缺陷并修复（很可能在掩盖真 bug）
- [ ] 调试后门审计：`-MOPItemDetailDemo*` / `-MOPHomeDemo*` 等入口 **release 构建屏蔽、Debug 保留**（现有 demo 直进用例在 Debug 下不受影响），作为安全项登记
- [ ] **新 MOP 模块接入真实导航**：`AppDelegate` 目前仅在启动参数下 present demo 模块——这是 L2 "真实导航 E2E"的物理前提（先于流级用例落地）

### P1 · 企业闭环必需

- [ ] **静态覆盖检查出口**：`suite check`（或 `suite run --check-only`）——纯静态判定 tests.json×flows.json 覆盖，不连设备，供 pre-merge CI（当前 preflight 仅是内部函数，无 CLI 出口）
- [ ] **MCP xcresult 接入**：`xcodebuild -resultBundlePath` → `xcrun xcresulttool get test-results summary/tests`（Xcode 16+）→ 按 case_id 对齐台账；输出"确定性套件 vs MCP 执行"差分校准与漏报率（JUnit 仅外部 CI 需要时由 xcbeautify 转换）
- [ ] **流级 XCUITest 薄层**（项目侧）：3–5 条真实导航 E2E，单方法连续、状态贯穿、固定种子 fixture、显式 owner
- [ ] **oracle 与设计冻结**：Figma/PRD/Jira 冲突优先级规则；flows.json 生成时写入设计版本锚点（Figma `version`/`lastModified`）；route reconciliation 区分「设计偏差（警告）/路线缺口（fail）」
- [ ] **可追溯矩阵**：design 节点 ↔ case_id ↔ trace ↔ evidence 双向视图（含未覆盖与孤立项），`suite report` 输出

### P2 · 严格企业治理

- [ ] flake 治理：quarantine 标记、重试策略上限、重跑不计绿（审计如实标注）、按用例 flake 率统计
- [ ] 测试数据/环境治理：固定种子、状态 seed 与清理、环境隔离声明
- [ ] CI 门禁统一：退出码语义（已部分落地：suite exit 0/1/2）、JUnit 报告接入、审计留痕与保留期
- [ ] 企业标准对照（ISO/IEC/IEEE 29119 / ISTQB 词汇）：测试过程、入口/出口准则、事件（缺陷）管理映射，形成可签字报告

---

## 6. 企业标准对照（ISO/IEC/IEEE 29119 / ISTQB 映射，2026-10-08）

| 标准概念（29119/ISTQB） | AOS 承载 | 证据/产物 | 缺口/后续 |
|------------------------|----------|-----------|-----------|
| 测试策略/计划 | DESIGN §6.10 接入契约 + 本文件三层门禁（L1/L2/L3） | DESIGN、analysis.md | 客户级测试计划模板 |
| 测试设计（条件/用例） | flows.json（设计流程）→ tests.json/tests.md/tests.xlsx（case_id 冻结） | `.artemis/design/*` | 设计冻结 baseline-lock（RC 锚点） |
| 可追溯性 | `suite report` 追溯矩阵（屏幕/跳转 ↔ case ↔ trace ↔ 证据）；`suite check` 覆盖与漂移 | xlsx「追溯矩阵」、JSON、check 输出 | 需求（Jira）↔ 设计 ↔ 用例跨系统追溯 |
| 覆盖准则 | 三闸 + `--fail-on-uncovered` + `requireFullCoverage` | coverage 区块、退出码 | 风险驱动覆盖优先级 |
| 测试执行 | `suite run`（MCP 台账+证据）；L2 确定性套件（xcresult） | 台账、evidence、xcresult | L2 接入（ticket 07/08） |
| 测试依据与 oracle | 设计版本锚点（fileVersion/lastModified）+ route drift 警告 | flows.json、check 输出 | oracle 仲裁规则（PRD/Jira 优先）与冻结流程 |
| 结果比对/缺陷管理 | `suite calibrate`（漏报/误报率）；失败分域六类 | calibration-*.json、失败域、`suite evidence` | 缺陷单回写（Jira M8b） |
| 测试度量 | 通过率、漏报/误报率、flake 标注（`--retry`）、覆盖率 | 报告/JSON | flake 率趋势、quarantine 流程 |
| 配置/环境管理 | 数据/环境种子；iOS 执行器（idb/Appium，项目 .env 打底） | run 配置、证据 | 数据/环境治理清单 |
| 确认与签字 | `suite report`（xlsx+JUnit）+ 三段式（设计版本/执行 trace/差分校准） | reports/ | 保留期与签字格式（待合规口径） |
| 独立性 | MCP（生成/执行/证据）与 L2 确定性套件互为校准 | 差分校准报告 | owner 与预算（防僵尸套件） |

> 说明：本表是能力映射，不等价于认证合规；D5 保留期/签字格式仍待团队或客户合规口径。

---

## 7. 待决策问题（review 时逐条给结论）

| # | 问题 | 我的建议 |
|---|------|----------|
| D1 | 是否接受"L2 确定性校准器必须存在"（即项目侧保留 3–5 条流级 XCUITest + owner）？ | 接受——Skeptic/Critic 一致反对 LLM 独任门禁；这是"最小介入"的硬底 |
| D2 | MCP xcresult 接入的实施范围：先只做 case_id 对齐+通过/失败映射（薄），还是一次做全（步骤级、截图、指标）？ | 先薄：对齐+差分+漏报率；步骤级后续按需 |
| D3 | flake 门禁口径：重试几次算 pass？重跑后转绿是否计入门禁？quarantine 谁批准？ | 重试≤2 且如实标注；重跑转绿不计首跑门禁；quarantine 需 owner 签字 |
| D4 | oracle 仲裁规则落点：项目 AGENTS/测试规范（项目侧）还是 MCP 报告内置提醒（MCP 侧）？ | 规则文本在项目侧；MCP 在 flows/coverage 报告中对"推定跳转"与设计版本做标注 |
| D5 | 审计留痕保留期与签字格式（ISO 29119 风格还是团队既有模板）？ | 需要你给出团队/客户合规口径后定 |

---

## 8. 决策记录（第二轮：外部反馈评估后，2026-10-08）

外部反馈总体成立（约 80%）：D1/D3 直接采纳，D2 机制修正，D4 补 route reconciliation，D5 修正前提；四项补强修订采纳；另补两个双方都漏掉的前置。

### 8.1 D1–D5 修正结论

| # | 最终结论 |
|---|----------|
| D1 | **采纳**：L2 确定性校准器必须存在（3–5 条流级 XCUITest + 明确 owner） |
| D2 | **采纳"先薄"，机制修正**：`xctestrun` 只是测试包配置，不产 JUnit；薄路径 = `xcodebuild -resultBundlePath` → `xcrun xcresulttool get test-results summary/tests`（Xcode 16+ 结构化 JSON）→ case_id 对齐 + 通过/失败 + 漏报率；case_id 先用测试方法命名约定绑定（附件解析留全量版）；JUnit 仅外部 CI 需要时用 xcbeautify 转换 |
| D3 | **采纳**：重试≤2 且如实标注；重跑转绿不计首跑门禁；quarantine 需 owner 签字；**L1 与 L2 重试预算分开记录**（防夜班时长失控） |
| D4 | **采纳半量 + 补 route reconciliation**：视觉 diff 走"规则在项目、标注在 MCP、设计偏差不直接 fail"；但覆盖率闸对原型推定的 fail 语义需对账——flows 与真实导航核对，偏差分「设计偏差（警告）/路线缺口（fail）」，避免误杀合法产品路径 |
| D5 | **修正**：保留期可配置（默认 90d，对齐 `AOS_USAGE_RETENTION_DAYS`）；审计/签字产物保留期与格式待合规口径输入；三段式报告（设计版本/执行 Trace/差分校准）采纳 |

### 8.2 四项补强：修订采纳

1. **CI 双轨时序**：采纳。pre-merge = L2 + L1 静态闸；nightly = 全量 L1 + L2 + L3 差分校准与报告。**落地前置** = 静态覆盖检查出口（§5 P1）+ 可追溯矩阵。
2. **L2 范式**：修订采纳——不硬禁 POM/helper；硬约束 = 单方法状态贯穿、真实导航（**不引入 `USE_REAL_NAV` 之类开关**，开关即新后门）、固定种子、owner、case_id 命名绑定。
3. **Data Drift**：修订采纳——归入既有失败域「数据环境」（不新增并行类别，防分域膨胀）；增量 = fixture 期望值显式写进 taskDesc，不匹配即确定性归类。
4. **baseline-lock 设计冻结**：采纳并细化——锁 Figma `version`/`lastModified` + 相关节点渲染图（非全文件哈希）；RC 时冻结、解冻走变更单；extraction 时写入、对比时引用。

### 8.3 两个前置（P0 级，原 doc 与反馈均漏）

1. **新 MOP 模块接入真实导航**：`AppDelegate` 目前仅 demo 启动参数 present 模块；L2 流级 E2E 的物理前提。
2. **后门收口因果修正**：release 屏蔽、Debug 保留；现有 demo 直进用例（Debug）不受影响；真实风险在"测试包与 release 包不一致"场景。

### 8.4 待确认

票据拆分（P0 前置三项 → P1 静态出口/xcresult 接入/薄层 E2E/oracle/追溯矩阵 → P2）等你确认后执行；MCP 侧改动遵仓库全绿（build/test/lint）。

## 9. 下一步

1. 你 review §8 决策记录；
2. 确认后拆票据到 `.scratch/enterprise-ios-testing/issues/`（P0 → P1 → P2），MCP 侧先做静态覆盖检查出口与 xcresult 接入（纯 `src/` 改动，遵守仓库测试约束）；项目侧流级 E2E 与真实导航接线单独出工单；
3. P0 三项（fixture 连贯性、后门收口、模块接真实导航）可立即在 iOS 仓库执行，不依赖 MCP 侧改动。

---

## 10. 实施记录（第三轮：执行落地，2026-10-08）

MCP 侧（AOS 仓库；`npm test` 690 例全绿、lint 干净）：

- ✅ **01 `suite check`**：静态覆盖检查（不连设备），完整 exit 0 / 未覆盖·截断·缺 flows exit 2；路线漂移仅警告；README/AGENTS/DESIGN §6.10 同步。
- ✅ **02 `suite calibrate`**：`--report`/`--xcresult`（`xcresulttool get test-results tests`）→ case_id 对齐 → 漏报/误报率、单边项、未对齐清单；落盘 `.artemis/design/reports/calibration-*.json`；`--fail-on-miss` 可门禁；已用真实 Xcode 27 xcresult（64 用例）验证解析器。
- ✅ **03 追溯矩阵**：`suite report` 增加 `traceability` JSON + 「追溯矩阵」工作表（屏幕/跳转 ↔ case ↔ trace ↔ 证据；未覆盖/无 trace/无证据标注）。
- ✅ **04 设计版本锚点**：flows.json 写入 Figma `fileVersion`/`lastModified`；route drift 进入 `suite check`。

iOS 侧（starbucks-ios-taiwan）：

- ✅ **05 后门收口**：5 个 DemoEntry 编译期收口（`DEBUG || DEV_VERSION || UAT_VERSION`，生产返回 NO）；`build-for-testing` 成功 + `MOPEndToEndFlowUITests` 实测通过（40.8s），Debug UAT 链路不受影响。
- ✅ **06 fixture 处置**：查明 ReviewOrder/Checkout/OrderStatus 为独立 demo fixture（非购物车状态）；采用断言校准 + 出处注释（消除"已验证连贯性"的误读），真实数据连通归 07/08。
- ⏸ **07 真实导航接线**：侦察完成（真实入口 `OrderRevampHomePageViewController` → 旧单品页 4 处调用；新模块无购物车/后端集成，直接接线会回归）→ **阻塞于产品决策**，已转 ready-for-human（方案：模型映射 + 开关路由 + 回滚，前置=购物车集成）。
- ◐ **08 L2 种子**：流级 E2E 走通（`build-for-testing` + `test-without-building`，1 用例 40.8s；xcresult 可被 AOS 解析）；case_id 命名约定与 fixture 出处已写入用例头部；扩展到 3–5 条依赖 07。
- ⏸ **09 P2**：flake retry 已实施（`suite run --retry N`，≤3；按 D3 口径重跑仅诊断、首跑决定门禁、`retry{attempts,finalStatus,finalTraceId,flaky}` 如实标注；测试 2 例）；企业标准映射表已落 §6；剩余：审计保留期（待合规口径）、quarantine 流程。
- ✅ **闭环编排 `suite loop`**（边界修正后新增）：一步编排"静态检查 → 执行(可选) → 反馈 → 差分校准(可选)"，产出 `loop-<stamp>.{json,md}`（步骤结果 + 确定性"下一步动作" + top 建议）；`--retry`/`--calibration`/`--allow-uncovered`/`--skip-run`；测试 4（纯）+2（CLI）例。

**边界修正（2026-10-08，用户指示）**：MCP 不深入项目实现细节——导航接线（07）、fixture 数据、后门收口等属**项目侧**事项，MCP 不以"改项目"为闭环手段；MCP 专注**测试闭环**：`suite loop` 的"测试 → 完善（改进 tests/flows/数据/错误码规则后重跑）"即验收路径。

**建议的下一动作**：用 `suite loop` 跑通一轮真实反馈（`check → run → feedback`，可选 `calibrate`），按"下一步动作"改进测试资产并复跑——不依赖 07 接线；07/08 由项目侧按产品节奏推进。

---

## 11. 第四轮评估结论（2026-10-08，外部反馈评估后）

外部反馈总体成立（约 80%）：D1 实测化、L2 角色收口为有效诉求；"L1 内部自校准算漏报率"方向对但机制错（漏报率需要 oracle，先做自一致性/flake 采样）；三项待输入给临时默认；ROI 先给成本框架（只填已知实测）。

### 11.1 L2 角色定稿（消除"校准器 vs 门禁"口径分裂）

- L2 = 同一套 3–5 条流级确定性套件，**双重角色**：① pre-merge 阻塞门禁（**首跑判定**，禁止用重试洗绿）；② nightly 差分校准（输出 MCP 漏报/误报率）。
- 反馈对 Skeptic 的归因需纠正：Skeptic 的"不进门禁"指设计视觉对比降为 advisory；其主张恰是"门禁只能由确定性 XCTest 承担"。
- 分阶段：**Phase 1**（07 接通前）pre-merge 只跑 `suite check`；**Phase 2**（07/08 落地后）L2 入门禁 + `suite calibrate` 进 nightly。quarantine 用显式白名单并需 owner 签字。

### 11.2 flaky 采样协议（把"LLM 不可重复"从信念变实测，不依赖 07）

- 样本：同 fixture、同模型、固定 temperature、每轮复位；先取 **3 条代表性用例 ×10 轮**（全量 20 轮成本高、单设备 FIFO）。
- 指标：首跑通过率、逐例翻转矩阵、`retry.flaky` 计数（`suite run --retry N` 已有字段，可直接累积）。
- 解读口径：翻转率决定 **投入强度**（L2 条数/是否入门禁），**不决定 D1 存废**——审计要求"可证明可回放"，确定性 oracle 的价值与 LLM flake 高低无关。
- 工具：`suite flake --cases <id,…> --runs N`（**已实现**，票据 10 resolved；输出通过率/翻转矩阵/flaky 率与轮次方差，`--fail-on-flaky` 可门禁）。

### 11.3 工程默认值（替代长期 open，标注可被合规口径替换）

| 项 | 临时默认 |
|---|---|
| 审计保留期 | 90d 可配（沿用 `AOS_USAGE_RETENTION_DAYS` 口径；签字/发布产物另存） |
| oracle 优先级 | **PRD > Jira > Figma**（变更单可覆盖；产品为事实、Figma 为预期） |
| 签字格式 | 三段式（设计版本 / 执行 trace / 差分校准）+ `suite report` 的 xlsx+JUnit 附件 |

### 11.4 ROI 框架（只填已知实测）

- 成本侧：MCP 单例耗时（台账 `durationMs`，`suite report` 可导出）× 用例数；L2 编写/维护人天（估算）；双轨 TCO = 以上 + CI 机时。
- 收益侧：**不编造数字**——"少掩盖的线上 bug 数 / 审计交付节省"需真实运营数据后回填。
- 用途：D1/D2 一类"要不要投入"的决策依据。

### 11.5 平台适用性（ARTEMIS / Android 同样适用）

- AOS 中的"执行器"就是 **ARTEMIS**（`mobile_*` 由 Python 子进程执行）——三闸、`suite loop`、`calibrate`、`--retry`/flake、证据链本就是为这条执行路径设计的，天然适用。
- 三层治理与平台无关，只换 **L2 载体**：iOS = XCTest/XCUITest；Android = Espresso/UIAutomator（或项目现有仪器化测试）；漏报/误报率与 flake 采样协议完全复用。
- Android 侧走 `suite calibrate --report <json|junit.xml>`：**已支持直接解析 JUnit XML**（gradle connectedAndroidTest / instrumentation 结果），只需测试名内嵌 case_id；无需转换脚本。
- `google/artemis` 上游本身**不在治理范围**：AOS 仅以 schema 透传 + env 注入方式依赖它；其质量由 submodule 版本与依赖更新机制（lock 哈希/依赖包）管理。

---

## 附录 A：三声部逐字报告（子代理原始输出）

### Skeptic

```
1. Position — 拒绝 B，也拒绝"碎片化是架构性的"这一前提。取 C 的硬版本：门禁只能由确定性 XCTest 承担，MCP 只做生成/证据/编排，不做验收执行器。"最小项目介入"是病根，不是约束。

2. Reasoning
① 门禁=可重复+可归因。LLM agent 不回放、失败不可分类；当唯一门禁只会被绕开或被 flake 拖死团队——B 在自身约束下自相矛盾。
② 误诊：XCTest 隔离的是测试方法而非会话，单方法内可一次启动、连续真实导航；demo 后门是造态省事的作者选择，不是架构极限。最便宜修法=3–5 条流级 E2E + 固定种子 fixture，不是搬回 MCP 重造执行器。
③ 可追溯不绑定执行器：xcresult 按 case_id 对齐 tests.json 即可闭环 design→case→trace→evidence；MCP 的 flows 生成、证据汇总、视觉对比保留，但视觉对比降为 advisory，不进门禁。

3. Risk — 组织若不让步"最小介入"，流级用例无人维护，半年后照样腐烂；XCTest UI flake 真实存在，把它当"零成本确定门禁"是幻觉，重试与 quarantine 的维护预算必须提前明说。

4. Surprise — 两点被忽略：调试后门（-MOPItemDetailDemo）若随包出厂，本身就是审计/安全发现项，企业验收第一步就会查它；数据矛盾（选南山断言善化、加购 A 断言 B）是产品数据缺陷，换任何执行架构都修不好，它现在很可能一直在掩盖真 bug。
```

### Pragmatist

```
1. Position — 选 B：MCP 做唯一验收门禁；XCUITest 冻结为可选本地冒烟，不再投入修连续性。

2. Reasoning
- B 已建成九成（flows→taskDesc、三闸、evidence/baseline/report、case_id、崩溃取证、设计对比），落地只差接线与纪律；A 要重做跨进程状态传递+去后门+真实导航，全是项目侧工程，直接撞"最小介入"约束。
- 审计链 design→case→task→trace→evidence 只有 B 产得出；XCUITest 修到完美也产不出。
- 碎片化是 XCUITest 架构性的（进程隔离+按屏文档），逆框架修补成本高；MCP 单次连续任务天然端到端，路径更短。

3. Risk — LLM 视觉执行确定性弱，CI 门禁可能因抖动失信。对策：baseline compare + 失败分类 + taskDesc 固化确定性步骤，把门禁建在"覆盖完整+证据齐全"而非单次像素稳定；接受单次成本更高。

4. Surprise — 现有 E2E 错位（南山/善化、商品 A/B）根因是 demo 数据不连贯而非跳步：A 修好连续性照样断言失败；且"无设计截图比对"XCTest 永远补不上。真瓶颈是证据链与设计对齐，不是测试框架选型。
```

### Critic

```
1. Position — 选 C，但必须纠正其原文定位："XCUITest 仅做本地细粒度回归"是错的。它应保留为 MCP 门禁的确定性差分校准器（同 commit 交叉校验），否则双轨必然债化。

2. Reasoning
- A 已被事实否决：碎片化是架构性的（XCTest 进程隔离 + 按屏文档），删 demo 后门只会让用例全红，不恢复连续性；且在"项目侧最小介入"下是每项目重复付账。
- B 独任门禁是把审计信誉押在 LLM 视觉 agent 的可重复性上：每步 5–30s 推理、无确定性保证、单设备 FIFO。门禁一 flaky，组织行为可预测——重跑到绿、上 --force、信任崩坏；evidence 链再完整也只是记录了不确定判定。
- 双轨若无仲裁规则会退化为政治：MCP 判 pass、XCTest 判 fail，谁签字定责？XCUITest 必须以差分校验身份常驻，持续量化 MCP 的漏报率，而不是降格为自愿参与的本地工具。

3. Risk — 双轨的所有权分裂：XCUITest 轨道若无明确 owner 与预算，两季度内腐烂成僵尸套件，MCP 门禁失去唯一交叉验证源，"企业标准"只剩单点主张。

4. Surprise — 各方都在争门禁位置，却没人定义 oracle：flows.json 源自 Figma 原型，真实 app 导航常与原型脱节；Jira/PRD 与 Figma 冲突时无优先级规则；baseline 缺设计冻结锚点，"可重复"在 Figma 被编辑那一刻即失效。先定 oracle 与冻结机制，再谈门禁放哪——否则 A/B/C 哪条路都不通。
```
