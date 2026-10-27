# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **测试/QA 工程师（主要日常使用者）**：在自己负责的项目里下发回归、看结果与证据、定位失败、维护用例文档。
- **多项目管理员/平台维护者**：关注多项目健康、runner 在线、存储与保留、权限与审计。
- **研发自查者**：改完代码/设计稿后自己跑一轮验证，顺手看报告。

（用户答复：以上三类"全部"覆盖；控制台需同时服务单项目日常与跨项目运营。）

## Product Purpose

mobile-testing 既是 MCP 工具服务，也是**项目的测试数据底座**：

- 提供设计→用例、真机执行、回归、Jira 验证、项目档案等 MCP 能力；
- **强制、详细地持久记录**每次测试的**结果、过程、所用数据**，并保留在**项目本机**（`.artemis/`）与服务集中台账；
- 让后续测试能**基于既有数据展开**：复用用例与范围、历史基线与对比、证据链、裁决与反馈闭环。

Web 控制台（多项目总览 / 项目详情 / 下发与运行控制 / 档案与检索）是服务的人面向入口；它既"看"也"做"（含下发测试任务），不是纯记录展示。

## Positioning

相邻的"MCP 工具集"只提供一次调用能力；本服务的差异是**记录即产品**：测试的结果/过程/数据三类记录均为**强制保留**（默认持久、零配置可用），并与控制台、回归复用、证据回写共用同一个数据底座——工具、记录、运营面同源。

## Operating Context

- 两种承载：stdio（本机单项目）与 HTTP（一台服务多项目，端点 `POST /mcp/<项目名>`）；另有独立看板进程（现 `panel --web` / `usage --web`，将升级为可操作控制台）。
- **项目机 runner** 常驻领取回归任务；产物全部落项目 `.artemis/`。
- 本机 PostgreSQL 17 可用于集中台账；**未配置 PG 时也必须强制持久**（项目内文件台账），不得回落为"内存即弃"的默认。
- 真实工作流：Figma/.pen → 用例三件套 → `suite check` → `suite run/loop` → 报告/证据 → 回归任务（runner 自动领取）→ Jira 回写与裁决。

## Capabilities and Constraints

已实现能力：设计流水线五工具＋pen 族、suite 闭环（run/check/calibrate/loop/flake/report/feedback/evidence/api-errors/baseline/reconcile）、回归任务/runner/定时回归/backfill、Jira 工具族与一键建单、统一服务四入口（`design_to_test`/`run_regression`/`verify_jira_issue`/`project_archive`）、usage 统计与面板/看板。

记录与持久化（用户强制要求）：

- **强制持久**：测试结果/过程/数据全量记录；项目本机保留＋服务强制保留；默认零配置可用；PostgreSQL 作为集中/多机升级项。
- **记录层全选**：① 全量台账默认持久（项目注册、LLM、任务统计、运行/用例结果、用例库登记、裁决/Jira 单号、usage、runner/schedule）② 服务内部编排审计（导入/执行/回写/降级/跳过等内部动作成事件）③ 产物清单与索引（批次/轨迹/报告/差异/崩溃可检索）④ 查询与导出接口（JSON/HTTP，供报表与外部系统消费）。
- **"测试用的数据"范围**：用例与测试文档（Excel 原文件＋合成用例）、前置/测试数据声明、被测应用包与版本、设备与环境快照、运行时真实数据痕迹（trace/data_engine.db/API 错误/日志窗口）、设计源版本锚（fileVersion/lastModified）。

其他约束：动作层安全沿用现有约定（仅 HTTP 模式提供写动作、`AOS_PANEL_ACTIONS` 开关、`AOS_HTTP_TOKEN` 鉴权；一键建单属外部副作用）；危险动作必须显式确认与可审计。技术栈沿用现有代码库（TypeScript ESM、服务端渲染 HTML/CSS），不引入前端构建链（除非实现计划另议）。

开放项：控制台与看板进程的最终命名与路由（如 `/console`）；视觉设计文档落点（根 `DESIGN.md` 是架构文档，视觉体系将另立文件，不覆盖）。

## Brand Commitments

- **视觉基准 = CSDC 开发者设计系统**（`https://html.temvo.com/CSDC/`，用户明确指定为绑定风格）：tokens 原样采纳——强调黄 `#FFE600`（hover `#FFF9CC`、surface `#FFF9CC`、subtle `#FFFDE6`）、文字 `#1D1D1F`/`#6E6E73`/`#86868B`、面色 `#F5F5F7`/`#FFFFFF`/`#EFEFF2`、边框 `#D2D2D7`、链接 `#0066CC`、成功 `#34C759`、错误 `#FF3B30`、警告 `#FF9500`；字体栈 SF Pro/PingFang；圆角 6/10/14/18/980；毛玻璃顶栏 `blur(20px)`。
- 参考文件已存：`.scratch/web-console/references/csdc/`（`design-tokens.css`＋`index.html`）。
- 术语沿用：AOS-ARTEMIS、统一服务四入口、runner、份/用例集、裁决、失败域、批次清单。

## Evidence on Hand

- 本仓库自身 `.artemis/` 有真实数据：设计产物、用例集三件套、批次清单、轨迹、崩溃、日志。
- 本机 PostgreSQL 17（`aos`/`mobile-testing` 就绪）；运行中的看板演示（`127.0.0.1:8767/panel`、`127.0.0.1:8766/usage`）。
- 2100+ 条自动化测试全绿（2026-10-26 基线）。
- 不可虚构：客户/案例数据、性能基准；如未来展示必须真实取材。

## Product Principles

1. **记录是产品**：结果、过程、数据三类强制保留；任何"易失"模式都不是默认。
2. **数据可复用**：每一次测试都为下一次提供基础（范围复用、基线对比、证据链、裁决）。
3. **操作与档案一体**：控制台既能看也能下发与运维，同一数据面、同一口径。
4. **零配置可用**：不依赖外部服务的功能开箱即用；PG/Jira/Figma 为增强项而非前置。
5. **风险动作显式化**：外部副作用（建单/释放/跑机）必须确认、可审计、可回放。

## Accessibility & Inclusion

- 目标标准：WCAG AA（对比度、键盘可达、字号下限），按工艺底线执行。
