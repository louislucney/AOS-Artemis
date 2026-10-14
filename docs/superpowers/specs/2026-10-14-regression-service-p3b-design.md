# 回归服务 P3b 设计（改进出口接线：生成反馈联路 / 环境清单 / Jira 一键建单）

> 2026-10-14 · 前置：P1（§13.106–13.108）/ P2（§13.109）/ P3a（§13.110）已落地；总体设计见 `2026-10-14-regression-service-design.md`（§5.4/§5.7/§7 P3「改进出口自动化」）。
> 状态：builder-check 复核后修订；实施计划另出。

## 1. 意图与背景

裁决（verdict）已能记录，但「裁决之后做什么」仍靠人工翻译。三个改进出口在 P1c 只有静态清单＋指引行（`overview.ts` 改进出口三清单）。P3b 把出口接上：

- **案例问题（case-defect）** → 生成反馈**联路**：让「下一轮重新生成」带上上轮裁决上下文（呈现与追溯，**不静默自动改**——§5.7 口径）；
- **执行偏差（execution-deviation）** → **环境改进清单**：把散落的执行偏差裁决聚成可视图表＋可导出数据；
- **应用缺陷（app-defect）** → **Jira 一键建单**：面板把失败（含证据）一键变成 Jira 单，回写单号供追踪。

现状盘点（已存在，P3b 只需接线，不重建）：

| 能力 | 现状 |
|------|------|
| 裁决写入 | `POST /panel/api/verdicts`（P1c）→ `suite_run_cases.verdict/verdict_by/verdict_at/verdict_note` |
| 案例问题建议 | `suite feedback` 已含 `kind:"verdict"` 建议（按功能分组，只读按需、无新存储；P1c） |
| Jira 面 | `jira` CLI（issue create/comment/…）、MCP `jira_evidence_post`（证据评论幂等＋附件去重）、`src/jira/*` 服务层 |
| 面板 | 统计下钻 `?view=stats` 改进出口三清单（`PanelImprovementItem`）＋静态指引行；动作层已含 tasks/verdicts 两路由 |

## 2. 范围

### 出口 A：案例问题 → 生成反馈联路（消费侧接线）

- **A1** `suite feedback` 增强：verdict 建议附**用例名与备注摘要**（现状仅 caseId 列表）。
- **A2** 生成侧消费（`figma_generate_tests`，含 pen flows 通道）：生成时**只读**读取案例问题反馈（与面板同口径聚合；按 featureKey 对应到本次生成的功能）：
  - 响应增 `feedback.caseDefects`（按功能分组：featureKey/featureName/条数/用例清单含备注；为空则省略——对齐 `reconciliation` 块先例）；
  - `tests.md` 增「上轮案例问题修订提示」段（重新生成后供人工对照）；
  - **不改动用例产物本身**；store 不可用 → 跳过该块＋warning，不阻断生成。
- **A3** 不做自动重生成、不把裁决备注注入生成提示词（需要新的设计输入，另议）。

### 出口 B：执行偏差 → 环境改进清单

- **B1** 共享聚合模块（单一事实源）：**仅份血统运行参与**（`featureKey === null` 跳过——§13.108 口径），按（份,用例）取最新裁决 → 三出口清单；执行偏差按 **(device, platform)** 分组：条数 / 涉及功能 / 最近裁决时间 / 备注摘要。功能维度以 **featureKey 为主键**（featureName 仅展示；跨份连续性口径同 §5.8）。
- **B2** 视图：面板 `?view=stats` 改进出口区把静态指引行替换为**结构化环境清单表**（设备/端/次数/功能/最近/备注）。
- **B3** 导出：`suite feedback` JSON 增 `exits`（`caseDefects`/`environment`/`appDefects`；appDefects 带 `jiraKey` 若非空）；文本模式打印「出口清单」段。

### 出口 C：应用缺陷 → Jira 一键建单（面板动作层）

- **C1** 路由 `POST /panel/api/issues`（与 tasks/verdicts 同层；`AOS_PANEL_ACTIONS=0` 整体关闭；body ≤256KB）。
  - 请求：`{ project, items:[{runId,caseId}…], projectKey?, issueType?, labels?, summary?, dryRun? }`（items ≤20）。
  - 逐条：读运行用例（项目作用域校验；准入规则见 D9）→ 生成确定性模板 → `JiraClient.createIssue` → 证据评论＋附件 → 回写单号。
  - 响应：`{ ok, results:[{runId,caseId,status:"created"|"existing"|"skipped"|"error"|"preview",key?,url?,reason?,evidence?,summary?,attachments?}], created, existing, failed }`（部分失败容忍，口径同 verdicts 路由；`reason?` 承载 skipped/error 归因，`summary?`/`attachments?` 为 dryRun 预览）。
- **C2** 幂等：新增 `suite_run_cases.jira_issue_key` 列（MIGRATIONS 补列；读取宽容）。已有单号 → `status:"existing"` 直接返回，不重复建单；证据评论本身按 trace 幂等（既有 marker 机制）。
- **C3** 证据：复用 `traceEvidence`/`buildEvidenceComment`/`candidateAttachments`（自 `jiraEvidencePost` 提取**服务层核心**，MCP 工具与面板动作同源）；无 trace 或无附件 → `evidence:"skipped"`，不阻塞建单；附件超限/失败如实标注（既有口径）；`dryRun:true` 只回预览（summary/描述/附件清单），不触网。
- **C4** 凭证与默认值：`JIRA_BASE_URL/EMAIL/API_TOKEN` 项目 `.env`（现状不变）；可选默认 `JIRA_ISSUE_PROJECT` / `JIRA_ISSUE_TYPE`（缺省 `Bug`）/ `JIRA_ISSUE_LABELS`（逗号分隔）；payload 优先。Jira 未配置或 projectKey 缺失 → 400＋指引（不触网）。
- **C5** 模板（确定性，可被 payload 覆盖）：summary＝`[回归] <功能> · <用例名> 失败`（无功能段时省略功能段，见 D10）；description＝结构化事实（项目/任务/运行/用例/端/设备/应用版本/失败域＋置信＋理由/traceId/证据路径与产物 URL/裁决备注）。
- **C6** 界面：应用缺陷行「建单」按钮（单条＋批量勾选）→ 内联表单（projectKey/type/labels/预览=dryRun）→ 提交显示 `KEY` 链接；已建单行显示链接 chip。
- **C7** 风险声明更新：一键建单＝**外部副作用**（内网无鉴权面扩大——任何可访问者可在真实 Jira 建单）；README/DESIGN 点名（与动作层既有声明并列）。

## 3. 非目标

- 重跑本条 / 隔离的**真动作**（P3c/P3d 动作层扩展）；动作层与产物服务鉴权升级（P3d）。
- **自动**重生成 / 自动改用例（§5.7 明文禁止：不静默自动改）。
- Issue 级 JQL 去重搜索（v1 以回写单号为准）；批量合并为一张单（v1 每条一张）。
- 跨项目对比（P3c）；cron/每日定点、面板调度管理（P3+）。
- 一键建单仅在 HTTP 面板可用（动作层）；stdio 部署沿用 `jira` CLI 手路径。

## 4. 硬约束

- 测试口径（仓库硬性）：pg-mem / 内存 store、假 Jira（注入 fetch 或 client）、假子进程、不触真实 PG/设备/外网；测试跑 `dist/`（先 `npm run build`）。
- 用户文案中文、代码英文；默认不加注释；相对导入带 `.js` 后缀；stdout 归 MCP（面板走 HTTP、CLI 照旧）。
- 完工同步：DESIGN.md 增 §13.111、README（面板/出口/建单段）、AGENTS.md（命令表与机制速查补一句）、`.env.example`（`JIRA_ISSUE_*` 可选默认值）。
- 动作层口径沿用 P1c：v1 内网无鉴权（风险点名）、写成功清面板缓存、错误不泄露底层原文（日志除外）、body 上限 256KB。

## 5. 关键决策（本次方案判断；可被否决/修订）

| # | 决策 | 理由 | 若否决的代价 |
|---|------|------|------|
| D1 | 「重生成联动」最小实现＝生成响应与 `tests.md` **如实呈现**上轮案例问题（提示＋追溯），不自动改用例 | §5.7「下一轮人工触发生成、不静默自动改」 | 若期望生成时**应用**裁决备注（如注入生成提示词），属新设计输入，需另议 |
| D2 | 三出口聚合收敛为**共享模块单一事实源**；既有两处重复的「最新裁决」循环（`collectVerdictSuggestions`、`buildPanelStatsView`）一并收编为该模块的渲染器；CLI 导出面用 `suite feedback` 扩展（不新增子命令） | 消除三处口径漂移风险；`suite feedback` 已是「改进建议」出口 | 若只共享新出口、不动既有两处，重构面小但口径仍三处维护 |
| D3 | 建单粒度＝每条失败一张单（批量勾选＝多条各建一张） | 应用缺陷通常彼此独立，一张单一条更便于分派 | 合并单/分单策略调整需改模板与回写粒度 |
| D4 | 新增 `suite_run_cases.jira_issue_key` 列（MIGRATIONS） | 面板显示与幂等需要**服务端可读**的单号；密钥口径不变（只存单号） | 若忌列膨胀，可改旁路 JSON，但跨机可见性差 |
| D5 | Jira 默认值经项目 `.env`（`JIRA_ISSUE_*`，可选）；payload 优先 | 「一键」常用路径零输入；凭证口径不变（`.env`、masked、不落 PG） | 无默认值时表单每次手填 projectKey |
| D6 | 证据回写 best-effort：无 trace/附件超限/上传失败 → 建单仍成功，结果如实标注 | 建单价值＞证据完整性；沿用 `jira_evidence_post` 既有降级口径 | 若要求证据必需，会阻塞建单（不推荐） |
| D7 | 环境清单维度＝（device, platform）分组；不带 runner 在线态 | 面板 runner 区块已承担在线态；清单聚焦「哪些环境在出问题」 | 增加 runner 维度成本低，可按需补 |
| D8 | 面板动作层经 **HTTP 模式注入的懒建 Runtime 缝**（`runtimeFor(rootPath)`；复用 deep 探针的 workspace 一级子目录约束）获取项目配置与 trace 证据；`jiraEvidencePost` 核心提取为 `src/jira/` 服务层（MCP 工具与面板动作同源） | 建单需要项目 `.env` 凭证解析与 trace 证据（均为 runtime 面）；HTTP 进程本就持有各项目 Runtime，不新增能力面 | 若改窄服务（rootPath＋resolver＋traces 目录），重构面更大、且需另建凭证解析缝 |
| D9 | 建单路由准入：case 必须存在且 `status ≠ passed`；已有裁决且 ≠ app-defect → 该条 `skipped`（防矛盾建单）；无裁决或 app-defect → 允许 | 按钮在 app-defect 清单上，但允许「先建单后补裁决」的现实路径，同时防误建 | 若要求严格 `verdict === "app-defect"`，加一道校验、前端需先裁决再建单 |
| D10 | 无功能段运行（`featureKey === null`）允许建单（模板省略功能段）；描述中证据「路径必附、产物 URL 尽力」（有 runner `artifact_base_url` 时拼接，口径同面板 `artifactUrl`） | 失败即失败，不为血统拒绝；中心只拼 URL 不取文件（P1/P2 口径）。**仅建单路由准入**——出口清单/裁决建议仍按 §13.108 份血统口径排除无份运行 | 若严格限份血统，加一道过滤（standalone 运行不进建单面） |

## 6. 接口草案（细节留给计划）

- **`suite feedback` JSON**：`{ …现状, exits: { caseDefects: [{featureKey, featureName, cases:[{caseId,name,note?}], traceIds}], environment: [{device, platform, count, features:[{featureKey,featureName}], lastAt, notes:[…]}], appDefects: [{runId,caseId,name,featureKey,featureName,platform,device,traceId,note?,jiraKey?}] } }`；文本模式在建议后加「出口清单（按最新裁决）」段。
- **生成响应**：`feedback: { caseDefects: { total, byFeature: [{featureKey, featureName, count, cases:[{caseId,name,note?}]}] } }`（为空省略；tests.md 对应段同数据）。
- **面板**：`PanelImprovementItem` 扩展（+runId/platform/device/traceId/note/jiraKey，源同共享聚合）；`POST /panel/api/issues` 见 C1、准入见 D9；`PanelWebDeps` 增 HTTP 模式注入的 `runtimeFor` 缝（D8，仅建单路由使用；独立 `panel --web` 不注入、issues 路由报 400 指引）。
- **数据**：`suite_run_cases.jira_issue_key TEXT`（DDL＋MIGRATIONS；写入缝 `setCaseIssueKey` 语义同 `updateCaseVerdict` 的项目作用域校验）。

## 7. 测试口径（映射，具体用例随计划）

| 面 | 覆盖点 |
|----|--------|
| store | `jira_issue_key` 读写＋迁移列（memory/pg-mem 双跑）；项目作用域校验 |
| 共享聚合 | 最新裁决口径（（份,用例）最新非空）；设备分组；featureKey 主键；空/降级 |
| suite feedback | exits 形状（JSON/文本）；verdict 建议带名称与备注；store 不可用不阻断 |
| 生成侧 | 响应 feedback 块（有/无/降级）；tests.md 段落；不改变用例产物（锁） |
| 面板动作 | issues 路由：成功/部分失败/无凭证 400/未知 run-case/超限/dryRun 不触网/幂等 existing/缓存清空；假 Jira 注入 |
| 面板渲染 | 环境清单表；建单按钮与已建单 chip；HTML 转义 |
| Jira 服务层 | 证据核心提取后工具回归锁（既有 jira 测试）＋面板路径复用 |

## 8. 留给实现/计划的（不阻塞）

- 路由/模块命名与文件划分；ADF 描述版式细节；错误与提示文案；`MAX_ISSUE_ITEMS` 等常量；issueType 白名单；环境清单排序；表单交互细节；迁移与读取兼容的测试形状；`.env.example` 文案。

## 9. builder-check 复核记录（2026-10-14）

独立 subagent（只读文档＋相关代码）提出 3 个实质问题，全部在文档内定案、无遗留待用户问题：

1. **面板动作层如何取到项目 Jira 凭证与 trace 证据** → D8（HTTP 注入懒建 Runtime 缝＋证据服务层提取）。
2. **建单路由是否要求裁决为 app-defect** → D9（准入：存在且非 passed；冲突裁决 skipped；无裁决允许）。
3. **无功能段运行与「产物 URL」来源** → D10（允许并省略功能段；路径必附、URL 尽力经 runner 基址）。
4. **共享聚合边界（Minor）** → D2 修订：共享模块为唯一事实源，既有两处重复循环收编为渲染器。
