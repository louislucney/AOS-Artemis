# 业务梳理（2026-10-22，rev 2）

> 依据：`PRODUCT.md`、`README.md`、`DESIGN.md`、`docs/接入指南.md`、`AGENTS.md`、`docs/superpowers/specs/2026-10-20-ui-interpretation-retro.md`，以及 `src/` 下的工具面、CLI、面板与模块边界。本文只做业务结构梳理，不改代码。

## 0. 一句话结论

AOS × ARTEMIS 已经不是“MCP 工具集”，而是**项目级测试数据底座 + 设计→用例→执行→证据→回归/Jira 的闭环服务**；当前主要矛盾不在能力，而在业务叙事与入口结构落后于能力。rev 2 补上 UI 保真度、事件/反馈两条横向线，给“记录是产品”接上行动，并为术语工程划定作用域。

## 0.1 P0 进展（2026-10-23）

- 面板术语第一刀完成（DESIGN §13.184）：用例集/设备运行/引用用例集/按用例集下发/用例集来源。
- CLI、README、AGENTS、DESIGN、接入指南术语收口与过期内容清理（DESIGN §13.185）；DB/API/代码标识符未改。
- 仍待：UI 保真入口（P1）、事件/反馈入口（P1）、记录/档案一等导航（P1）、角色权限/机队/CMS 产品化（P2）。

## 1. 现有业务事实

### 1.1 四种交付形态

| 形态 | 面向谁 | 主要能力 |
|---|---|---|
| MCP stdio | 单项目开发者/QA，在 AI 客户端里用 | 44 个原生工具 + Figma 工具 + `mobile_*` 透传；工作流入口 `design_to_test` / `run_regression` / `verify_jira_issue` / `project_archive` |
| MCP HTTP | 一台服务多项目、多机 | 每项目独立 Runtime、`POST /mcp/<project>`、`/events/<project>`、面板/使用统计 |
| 面板（panel/usage） | 人看/人操作 | 总览、项目、结果、下发、用例库、档案、运维、使用统计 |
| CMS Open | 外部 CMS/设计侧系统 | 静态 Figma/.pen → `design.md` + `cases.xlsx` zip；只生成、不执行 |

### 1.2 五类入口

- **对话入口**：四条工作流 + 细粒度原生工具。
- **CLI**：`suite`（run/check/calibrate/loop/flake/evidence/baseline/report/feedback/retention/reconcile/task/queue/runner/schedule/backfill/ui-contract）、`host`、`jira`、`usage`、`panel`、`cms-open`、`export`。
- **面板**：总览 / 项目 / 结果 / 下发 / 用例库 / 档案 / 运维 / 使用统计。
- **HTTP/事件**：MCP 端点、`/events/<project>`、只读产物服务。
- **开放 API**：CMS Open 的 `/jobs` 异步任务。

### 1.3 核心业务对象

| 对象 | 现有含义 | 代码落点 |
|---|---|---|
| 项目 | 被测仓库/目录，自带 `.env` 与 `.artemis/` | `src/projects/`、`src/config/` |
| 设计源 | Figma 文件或 `.pen` | `src/figma/`、`src/pen/` |
| 流程/用例集 | flows、tests 三件套、case-set（“份”） | `src/figma/test-gen.ts`、`case-sets.ts` |
| **UI 契约/设计 token** | 逐屏 token、文本字重/几何、四态覆盖 | `src/ui/contract.ts`、`suite ui-contract` |
| **UI 核验/差异** | `passed/failed/unverified/not-applicable`、逐区域对图、设备基线 | `src/ui/verification.ts`、`design_device_diff`、`suite run --ui-diff` |
| 批次/设备运行 | 一次 suite 运行、一次份×设备运行 | `src/figma/run-manifest.ts`、`suite-runner.ts` |
| 任务 | 回归任务（pending→claimed→running→…） | `src/tasks/`、`src/runner/` |
| 执行机/设备 | runner 心跳、设备租约 | `src/runner/`、`src/host/` |
| 证据 | trace、截图、日志、崩溃、API 错误、差异报告 | `src/artemis/`、`src/crash/`、`src/diff/` |
| **项目事件** | `run.*/case.*/artifact.created/log.entry/feedback.request`，游标/已消费 | `src/events/`、`aos_event_*`、`/events` |
| 裁决/失败域 | 失败定性、隔离、反馈 | `src/figma/reconciliation.ts`、`failure-taxonomy.ts` |
| Jira | 单号、评论、附件、证据回写 | `src/jira/` |
| 记录底座 | PG / 文件台账 / 会话内存 | `src/db/`、`src/ledger/` |
| 用量/审计 | 工具调用、内部编排审计 | `src/usage/`、`src/events/` |

### 1.4 现有闭环

```text
Figma/.pen
  → flows / gaps / tokens / strings / brief
  → tests.{json,md,xlsx} + case-set
  → suite check（静态覆盖门禁）
  → suite run / mobile_run_task（真机）
  → traces / crashes / api-errors / 差异报告
  → 失败域 / 裁决 / 隔离
  → suite feedback / loop
  → 回归任务 / runner / 定时回归
  → 报告 / Jira 回写 / 项目档案

设计保真支线：
ui-contract（token/文本/几何）
  → 实现/页面
  → suite run --ui-diff / design_device_diff
  → UI 核验四态 + 区域对图/基线
  → 设计/实现修订（ui-lint 机械规则为 retro P2，尚未落地）

事件/反馈支线：
项目 run/case/artifact/feedback 事件
  → POST /events 或 aos_event_report（幂等）
  → GET /events 查询 / poll 游标 / consume 标记
  → 项目侧重试/补数据/停止
```

## 2. 用户与 JTBD

| 用户 | 最想完成的事 | 当前主要入口 | 成功标准 |
|---|---|---|---|
| QA 工程师 | 每天跑回归、看失败、留证据、修用例 | 面板「下发/结果/用例库」、`run_regression`、`suite` | 回归覆盖、失败定位时长、返工率 |
| 多项目管理员 | 看项目健康、派任务、管 runner/队列/存储 | 面板「总览/运维/执行机」、`host`、`suite queue` | 队列时延、设备利用率、存储合规 |
| 研发自查 | 设计稿→用例→跑一轮→看差异 | `design_to_test`、`suite loop`、`compare_design_and_device` | 首跑通过率、UI 保真通过率 |
| CMS/设计侧 | 静态稿→可交付用例包（不执行） | CMS Open `/jobs` | 生成成功率、交付时延、可导入率 |
| 平台集成方 | 在 CI/外部系统里调用与取数 | CLI、HTTP MCP、`export`、事件入口 | 契约稳定性、回写成功率 |
| **AI agent/客户端** | 选对工具、补齐前置、复用产物、不猜设备 | MCP 工作流工具 + 工具描述契约 | 工具选择准确率、needs-setup 恢复率、schema 零漂移 |

## 3. 当前业务结构的 8 个问题

1. **入口按实现形态组织，而非按用户任务**：同一件事在 MCP/CLI/面板/CMS 各有入口，术语和参数不完全一致。
2. **术语分裂**：份/用例集、批次/运行、任务/设备运行、裁决/失败域/隔离/基线等概念在文档、页面、CLI 中混用；需要作用域与兼容边界。
3. **“记录是产品”没有成为业务主线**：文档强调强制持久，但入口仍以“跑任务”为主；记录/检索/复用/导出更像附属能力。
4. **生成侧与执行侧的成功标准不同**：设计→用例看覆盖率/三件套；执行看门禁/失败域；Jira 看回写结论；缺少统一的交付物定义。
5. **CMS Open 是第二产品形态，但叙事上仍是附属服务**：输入（静态稿）、输出（design.md+cases.xlsx）、SLA 与主服务不同，需要独立边界与数据流。
6. **多机/多项目是运维能力，但缺少单一管理员视图**：项目页锚点、运维、执行机、计划分散；队列/容量/租约没有一处总览。
7. **失败闭环分散**：发现失败→定性→修用例/建单→复跑，跨结果/任务/用例库/Jira 多个页面。
8. **权限/安全边界按部署形态分裂**：stdio 无鉴权、HTTP token、CMS bearer、面板动作开关；缺少统一角色模型。现行取舍是“受控内网 + 风险标注 + 可选令牌”，P2 角色模型是演进而非补漏。

## 4. 重组后的业务地图

### 4.1 六个业务域

#### A. 设计资产与用例生产（Design → Cases）

- **目标**：把设计源稳定转成可执行、可追溯、覆盖可证明的用例集。
- **对象**：DesignSource、FlowGraph、DesignToken、UIContract、CaseSet、三件套、Coverage/Gaps。
- **入口**：`design_to_test`（对话主入口）、`figma_*`/`pen_*`（细项）、面板「用例库」。
- **指标**：硬覆盖完整率、三件套齐全率、生成后首跑通过率、人工返工率。

#### B. 执行与设备编排（Execution）

- **目标**：把任务可靠地跑在 Android/iOS、真机/模拟器、本机/远程宿主上。
- **对象**：Runner、Device、Lease、Batch、DeviceRun（子运行）。
- **入口**：`suite runner`、面板「执行机」；**消费 D 域创建的任务**，不负责“建任务”。
- **指标**：领取时延、设备利用率、执行成功率、重试/毒丸率。

#### C. 结果、证据与质量判定（Evidence & Verdict）

- **目标**：让每次失败可解释、可追溯、可行动。
- **对象**：Trace、Crash、ApiError、Diff、UIContract/UIDiff、FailureDomain、Verdict、Quarantine。
- **入口**：面板「结果」、`suite evidence/api-errors`、`aos_crashes`、`design_device_diff`、`reconciliation`。
- **指标**：失败域准确率、裁决覆盖率、证据完整率、复现时间。

#### D. 回归与持续验证（Regression & Scheduling）

- **目标**：把“这一次”变成“每一次”，按范围/计划自动回归。
- **对象**：CaseSet 引用、RegressionTask、Schedule、Baseline、Report。
- **入口**：`run_regression`、`suite task/schedule`、面板「下发」；**任务创建/引用/队列归 D，执行资源归 B**。
- **指标**：回归覆盖率、计划执行率、门禁通过率、flaky 率。

#### E. 记录、证据与运营治理（Ledger & Ops）

- **目标**：结果/过程/数据强制持久，可查、可导、可审计、可运维。
- **对象**：Project、Host、Ledger、ProjectEvent、UsageEvent、AuditEvent、Retention、Export。
- **入口**：`project_archive`、`aos_usage`、`aos_event_*`、`export`、面板「档案/运维/使用统计」。
- **指标**：写入成功率、查询时延、保留合规、存储成本、审计完整率。
- **边界**：记录/证据是产品主线，不并入“运维”作为附属；运营治理负责机队、存储、权限、保留。

#### F. 开放集成与交付（Open Integration）

- **目标**：让外部系统（MCP 客户端、CI、CMS、Jira）以稳定契约接入。
- **对象**：MCP Tool Contract、HTTP Endpoint、Event、CMS Job、Deliverable。
- **入口**：MCP、HTTP、CLI、CMS Open、Jira。
- **指标**：接入时间、契约稳定性、任务成功率、外部回写成功率。

### 4.2 两条横向能力线

#### G. 实现保真（UI Fidelity）

- **定位**：横跨 A/B/C 的横向门禁线，不是独立运营域。
- **已落地**：`suite ui-contract` 从 flows + 逐屏 `.pen` 投影 `ui-contract.{json,md}`（token/文本字重/几何/四态）；`design_device_diff` 做区域级设计 vs 真机差异；`suite run --ui-diff` 产出 `passed/failed/unverified/not-applicable`；逐屏 diff 证据可回写批次/任务。
- **未落地**：`ui-lint` 机械规则（retro P2，需先解决存量/例外/白名单），不在当前能力清单里冒充已实现。
- **闭环**：契约 → 实现 → `suite run --ui-diff` / `design_device_diff` → 保真门禁/基线 → 设计或实现修订。
- **入口/指标**：`suite ui-contract`、`design_device_diff`、面板结果/任务 UI 列；指标＝UI 通过率、unverified 率、区域误报率、保真返工次数。

#### H. 事件/反馈（Event & Feedback）

- **定位**：项目 ↔ 服务之间的执行事件与反馈通道，横跨 B/E/F。
- **已落地**：`project_events`、`aos_event_report`/`aos_events`/`aos_event_poll`、HTTP `/events`、`consumed_at` 消费语义、保留期。
- **闭环**：项目上报 → 服务查询/长轮询 → 消费标记 → 项目侧重试/补数据/停止；服务端不维护反向指令队列。
- **入口/指标**：MCP 事件工具、HTTP `/events`；指标＝事件延迟、消费成功率、重复/丢失率、反馈闭环率。

## 5. 端到端业务主线

| # | 主线 | 输入 | 主入口 | 交付物 | 门禁/失败后下一步 |
|---|---|---|---|---|---|
| 1 | 设计→用例→首跑→裁决→改进 | Figma/.pen | `design_to_test` | 用例三件套 + case-set | 硬覆盖门禁；失败→证据→裁决→修用例/重新生成 |
| 2 | 用例库→回归→runner→报告 | CaseSet 引用/Excel | `run_regression`、面板「下发」 | 批次报告 + `*_回归.xlsx` + 对比/统计 | 门禁；失败→任务/结果→重跑/释放 |
| 3 | Jira 单→验证→回写 | Jira issue | `verify_jira_issue` | 结论评论 + 失败证据附件 | 强断言/无法判定；失败→证据→人工裁决 |
| 4 | 静态稿→CMS 用例包 | 静态 Figma/.pen | CMS Open `/jobs` | `design.md` + `cases.xlsx` + screens | 生成成功/no_cases；后续可经 Excel 导入进用例库（漏斗） |
| 5 | 设计契约→实现→保真门禁 | ui-contract + 实现 | `suite ui-contract` / `design_device_diff` | UI 核验四态 + 区域对图/基线 | UI gate；失败→区域证据→设计/实现修订 |
| 6 | 项目事件→消费→反馈 | run/case/artifact/feedback 事件 | `/events` / `aos_event_*` | 事件游标 + 消费状态 | 幂等/游标；失败→重试/补数据/停止 |

> 前四条是主业务主线；5/6 是横向闭环，但同样需要主入口、交付物、门禁与“失败后下一步”。

## 6. 入口重组原则与矩阵

### 6.1 原则

- **一个任务一个主入口**：对话用工作流工具；CI/自动化用 CLI；人看/人操作用面板；外部系统用 HTTP/CMS Open。
- **入口不复制业务逻辑**：共享对象、状态机、术语与存储。
- **每个入口标注副作用**：只读 / 可写 / 外部副作用（Jira、设备、建单）。
- **域是管护边界，旅程是页面内叙事**：导航按域组织；项目/结果/任务页内按旅程组织。
- **面板一级导航**：总览、项目、用例、执行、结果、**记录/档案**、运营。档案不再并入运营。

### 6.2 入口矩阵

| 业务任务 | 对话/MCP | CLI | 面板 | 外部 API | 副作用 |
|---|---|---|---|---|---|
| 设计→用例 | `design_to_test`、`figma_*`/`pen_*` | design-pipeline、`suite check` | 用例库（查看/导入） | — | 读写项目文件 |
| 执行/回归 | `run_regression` | `suite run/task/runner` | 下发、执行机 | — | 设备/任务 |
| UI 保真 | `design_device_diff`、`compare_design_and_device` | `suite ui-contract`、`suite run --ui-diff` | 结果/任务 UI 列 | — | 只读/截图 |
| 失败处理 | `suite evidence/api-errors`、`aos_crashes`、`reconciliation` | `suite loop/report/feedback` | 结果、任务 | — | Jira 外部副作用 |
| 记录/运营 | `project_archive`、`aos_usage`、`aos_event_*` | `export/usage/panel` | 档案、运维、使用统计 | `/panel.json`、`/usage.json`、`/events` | 只读（事件写入除外） |
| CMS 用例包 | — | `cms-open` | — | `POST /jobs` | 读设计源、生成 zip |

## 7. 术语与对象规范化

### 7.1 作用域声明

- **统一层**：UI 文案、README/接入指南/面板帮助、CLI 帮助与输出、新文档。
- **不动层**：数据库表/列名、现有 API 字段、代码标识符、文件格式键名。
- **兼容层**：历史文档可保留旧名，但新文档以 canonical 为准；面板/README 各只翻译一次，禁止在入口层二次映射。
- **常备对照**：canonical ↔ 存储/API 名，见 7.2。

### 7.2 术语表

| canonical | 适用层 | 存储/API/代码现状 | 处理 |
|---|---|---|---|
| 用例集（CaseSet） | UI/文档/CLI | `case_sets`、`case-sets/`、`caseSet` | UI 用“用例集”；“份”仅作量词 |
| 批次（Batch） | UI/文档/CLI | `suite_runs`、run manifest、`suite run` | UI 用“批次”；API/DB 不改 |
| 设备运行（DeviceRun） | UI/文档 | `suite_run_cases`、子运行字段 | UI 用“设备运行”；旧“子运行”仅兼容 |
| 回归任务（Task） | UI/文档 | `regression_tasks`、`suite task` | 面板可简称“任务” |
| 裁决（Verdict） | UI/文档 | verdict 字段/API | 不改 |
| 失败域（Failure Domain） | UI/文档 | failureDomain | 不改 |
| 隔离（Quarantine） | UI/文档 | quarantine | 不改 |
| 台账（Ledger） | UI/文档 | ledger/PG/file ledger | 不改 |
| UI 契约（UIContract） | UI/文档 | `ui-contract.json` | 新术语，统一使用 |
| 用例包（CMS Package） | UI/文档 | `cases.xlsx` + `design.md` + screens | 与“用例集”区分：外部交付包，可导入 |

## 8. 交付物与指标

### 8.1 六类交付物

1. 用例三件套（tests.json/md/xlsx）
2. 批次报告（run manifest + xlsx/JUnit）
3. 回归对比报告（`*_回归.xlsx` + 同份对比/跨端差异/统计视图）
4. Jira 证据包（评论 + 附件）
5. CMS 用例包（design.md + cases.xlsx + screens）
6. 可检索证据底座（台账 + 档案 + 导出）

### 8.2 指标可测性

| 域 | 指标 | 现有遥测 | 需新增 |
|---|---|---|---|
| A 设计→用例 | 硬覆盖率、三件套齐全率、首跑通过率 | 部分（coverage/check） | 生成成本、返工率 |
| B 执行 | 领取时延、设备利用率、执行成功率 | 部分（usage/host_sessions/runner） | 容量/排队分布 |
| C 证据/裁决 | 裁决覆盖率、证据完整率 | 部分（verdict/usage） | 复现时间 |
| D 回归 | 计划执行率、gate 通过率、flaky | 有（runs/schedules/flake） | 回归覆盖趋势 |
| E 记录/运营 | 写入成功率、查询时延、保留合规 | 部分（store health/retention） | 查询时延、配额 |
| G UI 保真 | UI 通过率、unverified 率 | 有（ui 四态） | 区域误报率 |
| H 事件 | 事件延迟、消费成功率 | 部分（events） | 丢失/重复率 |

## 9. 优先级建议

### P0：统一业务语言（不改大功能）

- 评审并冻结本业务地图 + 术语作用域 + 入口矩阵；
- README/面板/工具描述统一术语与主入口；
- 明确六类交付物及其验收口径；
- 把 UI 保真、事件/反馈写进主地图，不再作为“证据工具/事件入口”的脚注。

### P1：收敛入口与信息架构

- 面板按域重排：总览、项目、用例、执行、结果、记录/档案、运营；档案保持一等导航；
- 项目页“下一步”单一主 CTA（已开始）；
- 结果页按“失败处理”旅程组织：发现→证据→裁决→修用例/建单→复跑；
- 补 UI 保真入口（结果/任务 UI 列、`suite ui-contract` 指引）；
- 补事件/反馈入口（项目事件查询/消费状态）；
- 明确 CMS 用例包→Excel 导入→用例库的漏斗与 E2E。

### P2：能力补强与产品化

- 角色/权限模型（看/派/改/建单），沿用内网假设的演进路径；
- 多机“机队视图”（队列/容量/租约/离线）；
- CMS Open 独立产品化（SLA、鉴权、配额、独立文档/品牌）；
- `ui-lint` 机械规则（retro P2）与 UI 基线治理；
- 质量趋势与成本指标（生成成本、执行成本、flaky、返工率）。

## 10. 业务决策（带建议）

| # | 决策 | 建议默认 | 依据/待验证 |
|---|---|---|---|
| 1 | 主用户优先级 | **QA 日常第一、管理员第二、研发自查第三**；CMS 作为外部产品面 | 用 `usage_events`/`host_sessions` 做 7/30 天读数验证；不凭感觉 |
| 2 | 面板写操作 | **HTTP 模式保留写操作 + `AOS_PANEL_ACTIONS`；独立 `panel --web` 只读** | 现行安全口径；角色模型 P2 再细化 |
| 3 | CMS Open 定位 | **独立产品面 + 漏斗**：独立部署/SLA，但用例包可经 Excel 导入进用例库 | 现有 `run_regression` Excel 导入已具备承接能力 |
| 4 | 保留与清理 | **保持 `suite retention` 只读报告；自动清理待合规口径确认后另开** | 现行 README 口径；不把“延后”误写成“已决定不做” |
| 5 | 是否拆产品面 | **主服务不拆**；设计→用例与回归共享数据底座，CMS 独立产品面 | 拆分成本高、数据底座是核心差异；先拆叙事/入口，不拆服务 |
| 6 | “份”是否保留 | **保留为 UI 量词，不作为对象名** | §7 已裁决；不再重开 |

## 11. 结论与事实核对

- 当前系统能力密度高，主要矛盾在**业务叙事、入口结构、术语作用域**；rev 2 把 UI 保真、事件/反馈、记录主线补回地图，并给出可执行的 P0/P1/P2。
- 事实核对：`suite calibrate`、`suite ui-contract` 均已在 CLI/README 中存在；`ui-lint` 是 retro P2 计划项，尚未落地，本文按“未落地”标注，不冒充已实现。
- 建议先通过 P0 语言/地图，再动 P1 面板与失败闭环；业务地图稳定前不新增并列入口。
