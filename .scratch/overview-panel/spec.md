# 多项目总览面板（overview-panel）— spec

**Status:** ready-for-agent（本地暂存稿：Jira 沙箱凭证就绪后，按 `docs/agents/issue-tracker.md` 发布为 Task；发布后本目录仅作归档）

## Problem Statement

AOS-MCP 已支持多项目接入（HTTP 工作区多 Runtime、PG 共享台账），但没有"全局可见性"的落脚点，信息散在三层：接入状态只能逐项目调用 `aos_status`；测试台账在 PG（跨项目，但只有逐用例的行）；套件闭环的批次结果、失败域分类、崩溃/对账/baseline 资产在项目磁盘且"跑完即走"（`suite run` 报告只在内存与终端，默认不落盘）。日常巡检（哪些项目接入坏了）、质量抽查（这轮失败主要归在哪个域）、失败下钻（证据在哪）都要人工逐项目敲命令；现有 `/usage` 看板只覆盖工具调用统计，不承载测试语义。

## Solution

新增一个**跨项目只读总览面板**（零依赖服务端渲染 HTML，与 `/usage` 看板同构），三层视图：

- **L1 项目总览**：项目 × 接入健康灯 × 最新批次摘要（通过率、失败域概览）；
- **L2 项目详情**：接入信息面板（注册/配置健康 + 修复提示）＋ 测试历史（批次列表 + 独立运行）+ 设计流水线资产与保留期摘要；
- **L3 批次详情**：一次 suite run 的归纳分类（通过/失败/挂起、失败域分布与置信度、flaky/隔离/重试、崩溃签名、API 错误 verdict、覆盖率与门禁、对账升级）→ 用例结果表 → 证据链（trace/notes/日志/报告文件）。

为支撑"每次测试"这一实体，先落地**批次清单埋点**：`suite run/loop` 结束时原子写一批次一文件（原判保留、可审计），面板以清单为权威源；无清单的旧数据与单跑用例如实降级标注（不猜测、不合成）。分期：**P0** = 批次清单 + 面板聚合层 + L1/L2/L3（HTTP `/panel`、`/panel.json`）；**P1** = 接入软读全量（深探）、趋势、磁盘资产（崩溃/对账/baseline/保留期）、CLI `panel --web`；**P2** = 动作与集成（导出、Jira 上报入口）。

## User Stories

1. 作为服务管理员，我想在一屏看到所有已注册项目的接入健康灯，以便巡检时不逐个调用 `aos_status`。
2. 作为服务管理员，我想一眼识别 `setup_required` 的项目并看到修复入口（`aos_configure`），以便快速处置接入失败。
3. 作为服务管理员，我想看到每个项目的 LLM 条目数 / active 条目 / 模型刷新与自动修复状态，以便发现配置漂移。
4. 作为服务管理员，我想看到 Figma / Jira / pen 凭证的"存在性 + masked 预览"，以便确认配置完整且不泄漏密钥。
5. 作为服务管理员，我想看到 deviceHosts（iOS Appium URL / Android adbHost）的配置状态与来源，以便排查远程设备宿主问题。
6. 作为服务管理员，我想看到宿主级依赖（artemis venv / deps stamp）的新鲜度并附修复命令（`doctor --install-deps`），以便依赖过期时自助处理。
7. 作为服务管理员，我想看到项目栈（Flutter/RN/Android/iOS/Web）与设计流水线资产（flows/tests/reconciliation/quarantine/error-codes 的存在性与更新时间），以便了解项目处于哪个阶段。
8. 作为服务管理员，我想看到构建 stale 提示（dist 比进程新），以便知道需要重启客户端会话。
9. 作为 QA 负责人，我想看某个项目的测试历史批次列表（时间、用例数、通过/失败/挂起、门禁结果、来源 run/loop），以便抽查质量趋势。
10. 作为 QA 负责人，我想看每个批次的失败域分布（应用缺陷/环境/API 错误/数据环境/设计推断/行为或设计/用例缺陷/未分类）与置信度，以便判断"该催谁修"。
11. 作为 QA 负责人，我想看批次的 flaky（重试转绿）、隔离失败与门禁命中原因，以便理解门禁口径。
12. 作为 QA 负责人，我想看批次关联的崩溃签名 Top，以便发现根因线索。
13. 作为 QA 负责人，我想看 API 错误 verdict 汇总（unhandled/handled/observed）与覆盖率缺口（硬/探索），以便评估用例质量。
14. 作为 QA 负责人，我想看到对账升级/待审阅边数（reconciliation），以便知道硬断言在增长。
15. 作为开发者，我想从批次下钻到用例行（状态、失败域、置信度、理由、脚本来源"断言N/探索M"），以便定位问题；用例已从当前 tests.json 移除时如实标注而非静默留空。
16. 作为开发者，我想一键打开证据（trace 目录、notes、stderr/stdout 日志路径；批次报告 xlsx/JUnit 存在时给链接），以便复现与修复。
17. 作为开发者，我想把"未纳入批次的单跑用例"单列折叠，以便区分套件运行与即兴运行。
18. 作为开发者，我想看用例/批次的时间与时长（status.json 优先、台账回退），以便识别慢用例。
19. 作为接入验收者，我想在新项目接入后确认"设计资产齐 → 批次可跑 → 分类与证据齐全"，以便验收闭环。
20. 作为接入验收者，我想看到三件套（tests.json/md/xlsx）与真实数据标记的快检结果，以便发现生成物缺失。
21. 作为使用者，我想状态词汇全站一致（submitted 内部态 pending、展示为"运行中"；completed→通过；failed/cancelled/orphaned→失败；套件 timeout/submit-error →"失败·执行异常"），以便不产生歧义。
22. 作为使用者，我想批次详情区分"原判"（运行时记录）与"按当前规则重算"（显式标注），以便历史可审计、规则演进可见。
23. 作为使用者，我想在数据被清理（trace/报告/清单缺失）时看到"已清理/不可用"占位而非猜测，以便信任面板。
24. 作为使用者，我想在项目磁盘不可达（跨机注册）时看到"仅台账"降级视图与标注，以便知道数据边界。
25. 作为使用者，我想用查询参数（project / limit）筛选与刷新（只读快照），以便把面板当常驻页。
26. 作为使用 HTTP 模式的团队，我想面板挂在服务同端口（`/panel`、`/panel.json`），以便内网浏览器直接访问。
27. 作为 CLI 用户，我想用 `panel --web` 本地起同构看板（P1），以便不开 HTTP 服务也能看。
28. 作为服务开发者，我想面板零副作用（不拉起 artemis 子进程、不触网、除读缓存外不写任何状态），以便安全常驻。
29. 作为服务开发者，我想零泄漏（密钥只 masked、日志不落密钥），以便满足仓库安全约定。
30. 作为服务开发者，我想 `suite run --no-save` 与 `AOS_SUITE_RUNS=0` 可关闭批次清单，以便特殊场景不落盘。
31. 作为服务开发者，我想批次清单纳入 `suite retention` 分类，以便保留期口径与既有资产一致。
32. 作为服务开发者，我想新代码在 pg-mem + 临时目录 + 假采集器下可测，以便不依赖真 PG / 设备 / 外网。

## Implementation Decisions

- **决策索引（D1–D7，来自前置分析）**：D1 承载=HTTP `/panel` + 同构 CLI `panel --web`（零依赖服务端渲染）；D2 数据策略=读时聚合 + 短缓存；D3 批次建模=文件型批次清单（本节下一条）；D4 分类来源=运行期原判入清单 + 重算对照标注；D5 口径=接入三层 + 测试两层 + 状态映射 + 降级；D6 安全=只读、零副作用、零泄漏、内网受信；D7 实时性=读时快照、无推送。
- **批次清单（D3，一等实体）**：新增文件型批次清单 `<configDir>/design/runs/run-<UTC时间戳>-<随机6位>.json`（原子写、append-only、永不覆写；O_EXCL 独占创建、撞名重试 ≤3 次，同秒碰撞概率 ~1/16.7M）。模块提供：构建（纯函数映射 + `failureDomains`/`gate` 汇总）、保存、读取（**判别式结果** `ok | missing | invalid | newer`：missing（含裁剪竞态的 ENOENT）→ 界面"已清理/不可用"占位；invalid=坏 JSON/缺 schemaVersion；newer=高版本仅做**白名单安全映射**（`BaseRunManifest`：runId / startedAt / finishedAt / ok / summary{total, passed, failed}——逐字段类型校验，不匹配即忽略）并标注 `schema_newer_than_panel`）、列表（按文件名倒序——UTC 定宽时间戳，字典序即时间序）、裁剪（`AOS_SUITE_RUNS_MAX` 默认 200、写后 best-effort；prune 是唯一删除者、面板永不删除；**不做软删**——判别式读取已覆盖"列表与存在性不一致"竞态）。为何不纯推导：批次边界（轮询间隔、并发单跑）、运行选项、预检/门禁结论、分类原判都无法从台账可靠恢复。
- **清单契约 v1**（`schemaVersion: 1`）：runId / source（suite-run|suite-loop）/ startedAt / finishedAt / ok / error / tests{path, sha256, generatedAt} / options{deviceSerial, lockedAppPackage, model, maxCases, stopOnFailure, apiErrors, failOnApiErrors, strict, failOnUncovered, retry, quarantinedCaseIds} / preflight 摘要 / apiErrorCatalog 摘要 / summary{total, executed, skipped, passed, failed, flaky, quarantinedFailed} / gate{result, exitCode, reasons} / failureDomains / cases[{caseId, name, status, traceId, failure{domain, confidence, reason}, scriptProvenance, apiErrors, apiErrorsDegraded, quarantined, retry, evidence}] / reconciliation 摘要（有则记）。**不存 taskDesc**（体积与隐私；由 caseId 回查）。
- **写入点**：`suite run` 与 `suite loop` 的 run 步骤显式接线（`suite flake` 的重复采样不写，避免污染批次列表）；写失败仅 `logWarn`、不影响退出码；新增 `--no-save` 跳过；`AOS_SUITE_RUNS=0` 全局关闭。
- **分类原判 + 版本**：failure-taxonomy 增加版本常量并随清单记录；面板默认展示原判，可切换"按当前规则重算"（显式 `recomputed` 标记，不覆盖原判）。
- **保留期**：`RETENTION_CATEGORIES` 增加 runs 分类，`suite retention` 自动覆盖"过期批次清单"。
- **共享口径**：台账状态映射（completed→passed、submitted→**内部态 pending**（对齐 run-report `outcomeOf`；界面展示文案"运行中"）、其余→failed）提取为共享模块，面板与 run-report 共用；时长优先 status.json（start/end）、回退台账 submitted/finished。
- **接入三层口径（D5）**：① 注册层（PG 项目行：rootPath/name/lastSeenAt/figmaToken 存在性）；② 配置层软读（`loadProject` 级：LLM 三元组完整度、Figma/Jira/pen key 存在性 masked、`aos.config.jsonc` validation、deviceHosts 静态解析、栈检测、设计资产与三件套快检、宿主级 deps stamp——明确标注"宿主级共享"）；③ 深探层（P1）：点击详情懒建 Runtime，默认只取**纯读子集**（明确 bypass `iosAppiumInfo` 这类 CLI 探测——实测其会 spawn `appium --version`/`appium driver list --installed`）；"iOS 环境检测"为显式动作（结果带时间缓存），执行时允许白名单本地 CLI 探测（≤45s 超时预算）。整体口径：不拉起 artemis 子进程、不触网打外部 API。
- **状态灯（判定短路顺序固定）**：先判磁盘可达性——不可达直接置灰并短路后续判定（灰行仍展示注册层信息）；可达后再判红=无可用 LLM（setup_required）；无红则黄=可用但有缺项（**固定聚合顺序：凭证缺 → deps stale/missing → 三件套不齐 → store 降级 → build stale**，展开态证据同序）；全无则绿。每盏灯可展开"证据 + 修复提示"。
- **证据链渲染（防死链）**：L2/L3 的所有证据路径（trace 目录 / notes / stderr/stdout / 报告文件）渲染前逐一做存在性校验（存在/缺失两态）；缺失渲染灰色"已清理/不可用"占位，不生成未校验的链接；P0 以路径文本 + 复制为主（浏览器对 http 页面的 `file://` 导航普遍受限），可点击的文件服务列为 P2 可选项。
- **面板承载**：HTTP 模式挂 `GET /panel`（服务端渲染 HTML，内联 CSS、零依赖、零前端构建）与 `GET /panel.json`（同源视图）；查询参数 project / limit（L2 默认 20、上限 100）；**L1 轻量索引与判定边界：仅注册层 + 可达性 + 配置层软读（宿主级 deps 只算一次）；每项目只列 `runs/` 目录、按文件名倒序取最新 1 件解析（零额外 stat；不引入 latest 指针文件），不全量遍历；禁止深探类动作（子进程 / 网络）**；进程内短缓存（TTL 默认 5s）；只读；`AOS_PANEL_WEB=0` 关闭路由（对齐 usage）。**安全前提**：默认 loopback（HTTP 沿用 `AOS_HTTP_HOST` 默认 127.0.0.1；CLI `--web` 默认本机）、面向内网受信使用；敏感面=项目路径 / 证据路径 / 崩溃签名 / API 错误摘要 / masked 凭证预览（与 usage 同口径，不新增密钥暴露面）。stdio 模式不提供跨项目面板（无多项目上下文）；CLI `panel --web`（复用同一 handler，独立端口）为 P1。
- **范围与降级**：项目集合 = HTTP 工作区目录 ∪ PG 注册项目；按 rootPath 检测磁盘可达性，不可达 → "仅台账"降级并标注；数据缺失一律如实占位——批次空态给出**原因清单**（从未跑过 / 清单写入被 runner 关闭（`--no-save` 或 `AOS_SUITE_RUNS=0`）/ 已被保留期清理），面板不做断言式归因（无法读取 runner 进程 env）；用例回查失败时主结果表照常渲染，仅 taskDesc 补充位缺失并标注"已从当前 tests.json 移除"。
- **不动物理模型**：P0 不改 PG schema、`task_stats`、tests.json、`mobile_*` schema 与现有 CLI 退出码语义；批次清单文件为权威源（PG 镜像列为 P1 可选项）。
- **文档同步**：DESIGN 里程碑表 + 实施记录（批次清单契约、面板口径）、README 小节、AGENTS 速查；用户可见文案用中文。

## Testing Decisions

- 好测试只验证外部行为：批次清单的契约与映射（含汇总、容错、裁剪）、面板视图 JSON 契约与降级路径、HTML 关键区块存在性；不测私有渲染细节与 CSS。
- 接缝与先例（四个测试面）：
  1. **批次清单模块**：纯函数 + 临时目录——字段映射（flaky/quarantine/domains/gate 汇总）、原子写与独占创建、列表排序、裁剪、判别式读取（missing/invalid/newer 白名单映射）（先例：reconciliation / retention 测试）。
  2. **面板聚合层**：pg-mem 假 store + `makeTempProject` 假项目 + 假批次清单——L1/L2/L3 视图契约、状态映射复用共享 outcome 函数、L1 仅取最新清单（更旧的损坏件不影响）、磁盘不可达降级、数据缺失占位、证据链存在性校验（缺失→灰色占位）（先例：`test/usage-web.test.js`、`test/usage-aggregate.test.js`）。
  3. **HTTP 路由**：`/panel` 200 + 关键 HTML 区块、`/panel.json` 同源、查询参数与关闭开关（先例：`test/usage-server.test.js`）。
  4. **suite 接线**：默认生成清单、`--no-save` 与 `AOS_SUITE_RUNS=0`、写失败不影响退出码（先例：`test/suite-command.test.js` 的注入式 io）。
- 全程不依赖真 PG / 设备 / 外网；真实浏览器与真机冒烟为人工验收。

## Out of Scope

- 批次清单的 PG 镜像与跨机面板（P1 可选项；跨机项目先给"仅台账"降级）。
- 旧数据的时间窗批次推导器（P1 可选，届时显式标注 `inferred`）。
- 写操作：导出报告、Jira 上报、重跑、quarantine 处置（P2；P0/P1 保持只读）。
- 告警 / 订阅 / webhook / websocket 实时推送。
- 认证与授权（与内网无鉴权口径一致）。
- 视频等富媒体、附件打包下载。
- `suite flake` 采样轮次的批次清单（沿用其自有产物）。

## Further Notes

- 已按推荐拍板的四个默认项：① 旧数据如实"无批次记录"（推导器后置）；② 增加 `suite run --no-save`；③ PG 镜像后置；④ 独立运行单列折叠区。
- **上线即空是预期**：存量项目 P0 上线时没有批次清单（历史"跑完即走"），面板价值从上线后新跑的批次开始积累；接入验收者不要把空态当缺陷。
- Jira 发布（凭证就绪后，project key 由使用方提供）：`node dist/cli.js jira issue create --project-key <KEY> --summary "多项目总览面板（spec）" --type Task --label ready-for-agent --description "$(cat .scratch/overview-panel/spec.md)"`；随后按 to-tickets 拆票、Blocks 建依赖。
- 建议拆分（to-tickets 时细化）：T1 批次清单模块 + suite 接线；T2 面板聚合层（D5 口径）；T3 HTTP `/panel` 与 `/panel.json`；T4 L1/L2/L3 渲染；T5 文档同步；T6（P1）深探/趋势/磁盘资产/CLI `--web`；T7（P2）动作与集成。**进度**：T1–T5 已实施（DESIGN §13.95–§13.98；T5 随各步增量完成）；T6 已全部实施——磁盘资产 + 批次趋势（§13.103）、深探层（§13.104）、CLI `panel --web`（§13.105）；T7（P2）动作与集成待做。
- 已知风险：磁盘可达性依赖（单机假设）；trace/报告被保留期清理后的降级展示；多项目扫描性能（限制最近 N 批次/N 行 + 短缓存）。
- **演进触发条件**：若未来跨项目"条件筛选 / 趋势"使清单扫描成本不可接受，优先评估 PG 镜像（已列 P1 可选）；不引入第三种存储（如本地 SQLite 索引层）——当前规模（≤200 件/项目、目录级 readdir）不构成瓶颈。
- 与 `/usage` 看板互链（项目活跃度）；两者共享零依赖 HTML 模式与存储访问层。
- 落地时按仓库惯例同步：DESIGN 里程碑表 + §13 实施记录、README、AGENTS 速查。
