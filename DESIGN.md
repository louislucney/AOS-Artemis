# mobile-testing（AOS × ARTEMIS）MCP 服务 — 当前设计

- **版本**：0.3.0
- **日期**：2026-11-09
- **状态**：已实现并持续维护；本文只记录**当前架构、契约与活跃决策**
- **仓库**：`src/`（TypeScript，ESM）＋ submodule `artemis/`、`design-context-bridge/`
- **文档分层**：
  - 本文：当前设计/契约/边界/未闭环项；
  - `docs/design-history.md`：旧版全文与 §13.x 实施记录（归档，不再维护）；
  - `docs/superpowers/specs/`：设计提案、复盘、专题设计；
  - `AGENTS.md`：agent 必须遵守的操作约定、命令与硬约束。

> 旧文档中的 “v0.3 待实现”、Maestro web-runner、HTTP 预留、旧测试数量等内容已过时；历史原文在归档文件中保留，仅供追溯。

---

## 1. 系统概览

mobile-testing-mcp 把三条能力收在一个 MCP 入口：

1. **设计上下文**：Figma REST/插件桥、`.pen` 解析、flows/截图/UI 契约；
2. **用例与回归**：设计→用例、Excel→用例、suite/runner、失败域与证据；
3. **真机执行**：Android（Artemis/MCP 原生）与 iOS（模拟器 idb/simctl、真机 Appium/WDA）。

部署形态：

```text
CLI（opencode / Claude Code / Cursor / …）
  │ stdio 或 HTTP（streamable-HTTP）
  ▼
mobile-testing-mcp（Node ≥20）
  ├─ 每个项目独立 Runtime（配置、LLM、store、工具代理）
  ├─ 中心面板 / 多项目 / 多主机 runner
  ├─ 设计流水线（Figma / pen / Excel 导入）
  └─ Artemis Python 子进程（Android 真机执行）
```

**双入口**：stdio 与 HTTP 共用 `createServerForRuntime()`；HTTP 每个项目独立 Runtime，中心只做路由/存储/面板。

---

## 2. 项目与配置

### 2.1 项目身份

- 定位顺序：`AOS_PROJECT_DIR` → 向上查找 `aos.config.jsonc` → 当前目录。
- `aos.config.jsonc` 的 `project.name` 覆盖台账/面板显示名；缺省用目录 basename。
- 项目配置来源优先级：**PG store > `aos.config.jsonc` > `.env`**。
- 多项目工作区：HTTP `--workspace`、面板扫描、`AOS_PANEL_PROJECTS` 白名单；服务仓库默认隐藏。

### 2.2 LLM 契约

项目 `.env` 的 LLM 变量（新名优先）：

| 新变量 | 兼容旧名 | 说明 |
|---|---|---|
| `AOS_LLM_NAME` | — | 条目名（缺省 model） |
| `AOS_LLM_MODEL` | — | 模型名 |
| `AOS_LLM_BASE_URL` | `OPENAI_BASE_URL` | OpenAI 兼容端点 |
| `AOS_LLM_API_KEY` | `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | 密钥 |

- 条目可多条，PG 保存 active 指针；切换对下一个任务生效；provider/key/baseUrl 变化会重启网关子进程（只杀直接子进程）。
- 模型目录：8 家国产厂商预设；已配置条目定时刷新 `GET {baseUrl}/models`（`AOS_MODEL_REFRESH_HOURS`，默认 12h）；模型下线自动修复（`AOS_LLM_AUTO_REPAIR=0` 关闭）。
- 非 Google provider 会自动重指 artemis 钉死的 `object_detector`/`hopper` 节点，并带精度警告。
- 密钥只存项目 `.env` 或 PG；响应只回 masked；日志不落 key。

### 2.2.1 LLM 资源池与用量记账（v1）

- **范围**：v1 只计量**中心 LLM 代理**与 Node `chat.ts`（design/pen/iOS/验证等本地调用）；本地 Android Artemis 直连厂商的请求不在范围内，继续用项目自有 key。
- **存储**：PG 新增 `llm_pool_tokens`、`llm_price_book`、`llm_usage_events`、`llm_budget_counters`、`llm_reservations`；`project_llms` 增加 `pool_token_id`/`pool_mode`(`pinned|auto`)/`pool_model`。FileStore 用 `~/.aos/ledger/llm-pool.json`（0600）存 token/价格/计数/预留，usage 写项目台账 JSONL（`AOS_LLM_POOL_FILE`/`AOS_LLM_USAGE_FILE` 可改）。没有原子预留就不宣称硬额度：PG 严格跨进程，FileStore/MemoryStore 仅单进程 best-effort。
- **归一 usage**：`base_input_tokens` / `cache_creation_tokens` / `cache_read_tokens` / `output_tokens`；不做通用 `prompt - cache_read`。OpenAI 含缓存时 `base_input = prompt - cached`，Anthropic `input_tokens` 本身是未命中，DeepSeek 用 hit/miss 映射；adapter 只做厂商差异，不内置某家价格。
- **预留与结算**：请求前用 `js-tiktoken` 估算 prompt+输出并原子预留；成功按真实 usage 多退少补，无 usage/超时/断流按估算或已收 chunk 强制入账；HTTP/JSON 错误释放，网络超时/连接重置按估算结算（provider 可能已处理）。未结算预留超过 `AOS_LLM_RESERVATION_TTL_MS`（默认 600000）由 reconciler 按估算结算（`status=settled_estimated`、`errorClass=reservation-ttl`）。**没有任何请求是免费的**。
- **流式**：只有 pool token 的 `supports_stream_usage=true` 才注入 `stream_options.include_usage`；`false`/unknown 正常转发，用量按预扣+估算/部分结算；客户端中途断开按 partial 或预扣结算，绝不悬挂 reserved。
- **预算**：默认周期 `monthly`，本位币 `CNY`（`AOS_LLM_COST_CURRENCY` 覆盖）；token 级 `max_concurrency` 默认 10；未定价模型按惩罚价 `AOS_LLM_UNPRICED_MICROS_PER_MTOK`（默认 20,000,000）预留，金额统计只用 `cost_micros_base`，缺 FX 单独计数、不混加。`pinned` 固定 token，`auto` 同模型按优先级/健康度换 token，不静默降级模型。
- **环境变量**：`AOS_LLM_COST_CURRENCY`、`AOS_LLM_UNPRICED_MICROS_PER_MTOK`、`AOS_LLM_RESERVATION_TTL_MS`、`AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS`、`AOS_LLM_IMAGE_TOKEN_ESTIMATE`、`AOS_LLM_POOL_FILE`、`AOS_LLM_USAGE_FILE`、`AOS_LLM_USAGE_RETENTION_DAYS`（默认 365，0 关闭）。
- **入口**：CLI `llm pool list|add|update|disable|bind|unbind`、`llm price list|set`、`llm usage`；只读工具 `llm_pool_list`/`llm_usage`（限当前项目）；面板运维页「LLM 资源池与用量」卡片与 `GET /panel/api/llm/pool|usage`（只读）。所有响应只回 masked key。
- **旧台账兼容**：LLM 池上线（`pool_token_id` 之前）写入的项目条目在加载台账时归一化为 `poolTokenId: null` / `poolMode: "pinned"` / `poolModel: null`；否则 `poolTokenId !== null` 会把 `undefined` 误判为"已绑定池 token"，中心 `/panel/api/runners/suite/llm` 返回 `found:false`，runner 预检报「中心未配置 active LLM」。`resolveCenterLlmCandidates` 同样按空值安全判断。
- **v1 缺口（明确未实现）**：token 行记录 `createdBy`/`updatedAt`，但服务级审计历史 `llm.pool.create/update/disable` 尚未落审计表；不要把它当成已实现。预留释放/TTL 回收也没有独立审计事件。`supports_stream_usage=unknown` 在 v1 按 false 处理（可用 `llm pool add --probe-stream` 写入 true），不做自动探测。项目绑定池 token 只覆盖中心代理与 Node `chat.ts`；Android Artemis 直连厂商仍需项目自有 key，缺失时会显式失败。

### 2.3 Figma / pen

- Figma REST：`FIGMA_ACCESS_TOKEN`；插件桥端口固定 3055，CORS 仅允许插件 iframe + loopback。
- REST 限流：有界 Retry-After、按 token 冷却、响应缓存（`AOS_FIGMA_CACHE_TTL_MS`，默认 10min）。
- `.pen`：pen CLI 托管安装；`AOS_PEN_CLI_PATH` → `AOS_PEN_CLI_DIR` → PATH；项目 `.env` 白名单透传 `PEN_CLI_KEY`/`PEN_AGENT_API_KEY`/`ANTHROPIC_*`。

### 2.4 存储

**装配顺序（强制持久）**：

```text
MOBILE_TESTING_DATABASE_URL（PG）
  → 项目文件台账 .artemis/ledger/（默认持久）
    → 会话内存（仅目录不可写时兜底，并如实标注）
```

- PG 启动自动回流：扫描本地 ledger/design 产物，幂等补 usage/regression_tasks/runs/case-sets；成功后写 `.artemis/ledger/.pg-sync.json`；`AOS_LEDGER_AUTO_IMPORT=0` 关闭，失败仅 WARN。
- 文件台账：`state.json` 原子快照 + `usage.jsonl`/`audit.jsonl`/`journal.jsonl`；读取前重读合并（同 id 磁盘胜）。
- 快照剥离 `apiKey`/`figmaToken`；运行时按条目专属变量回填。
- 保留：审计 90 天/5 万条；usage 默认 90 天/5 万条（`AOS_USAGE_RETENTION_DAYS` / `AOS_USAGE_MAX_EVENTS`）。
- 主要表：`projects`、`project_llms`、`task_stats`、`usage_events`、`project_events`、`case_sets`/`case_set_features`、`suite_runs`/`suite_run_cases`、`regression_tasks`、`hosts`/`host_addresses`/`host_sessions`/`device_leases`、`runners`、`schedules`、`web_*`、`excel_*`、`llm_model_cache`、LLM 池 `llm_pool_tokens`/`llm_price_book`/`llm_usage_events`/`llm_budget_counters`/`llm_reservations`。
- 存量库迁移：`MIGRATIONS` best-effort；依赖新列的索引必须在补列之后创建（见历史 §13.262/§13.330）。

---

## 3. 工具面

原生工具按域放在 `src/tools/native-tools/`，server 只装配不定义；`mobile_*` schema 原样透传。主要域：

| 域 | 能力 |
|---|---|
| 设计 | `figma_extract_flows`、`figma_gap_analysis`、`figma_generate_tests`、`figma_import_assets`、`figma_export_brief`；`pen_inspect`/`pen_extract_flows`/`pen_import_*`/`pen_export`/`pen_apply_*`/`pen_agent` |
| 设计→测试 | `design_to_test`（一条龙）、`suite ui-contract`、`suite ui-semantics`、`suite ui-parity`、`suite ui-lint` |
| Excel/回归 | `design_assisted_import`（映射预览）、`run_regression`、`suite run/check/calibrate/loop/flake/report/feedback`、`suite task`、`suite runner`、`suite schedule` |
| 真机 | `mobile_run_task`、`mobile_manage_task`、`mobile_get_device_state`、`mobile_inspect_trace`、`mobile_diagnose`、`aos_crashes` |
| Jira | `jira_issue_get/search/comment/attach`、`jira_evidence_post`、`verify_jira_issue` |
| 项目/LLM | `llm_list`/`llm_switch`、`llm_pool_list`/`llm_usage`（池/用量只读）、`aos_configure`、`aos_status`、`aos_usage`、`aos_event_*` |
| 面板/运维 | `GET /panel`、`GET /panel.json`、`POST /panel/api/tasks|cancel|stop|release|rerun|queue/pause|queue/resume|hosts/register|verdicts|issues` |

**iOS 路由**：`device_serial` 是 iOS 模拟器 UDID/真机 UDID 时由 AOS iOS 后端接管（截图/层级、任务执行、manage、trace），设备解析唯一入口 `Runtime.iosDevice(serial)`。

---

## 4. 设计→用例

### 4.1 设计源

- Figma：`figma_extract_flows` → `flows.json`（屏幕/边/元素/文本 hints/provenance）+ `flow-map.md`；默认渲染截图。
- pen：`pen_extract_flows` 在无交互数据时合成流程（状态归并、画布排布、`INFERRED` 标注）；可选视觉识别（`vision`）。
- 共享设计目录：`AOS_SHARED_DESIGN_DIR`（进程 env > 项目 `.env` > config）；同机双端共享，跨主机仍用 `suite parity`/Git 同步。

### 4.2 生成用例

- `figma_generate_tests` 默认落三件套：`tests.json` + `tests.md` + `tests.xlsx`；三份同时成功或都不写。
- taskDesc 注入 `【真实数据】` 硬约束（禁止伪造页面/假数据/mock；数据须经真实请求链路）。
- `【AOS-EXPECT】`：iOS 执行器逐步确定性核对；Android 提交前剔除（仅文本 hints 供 LLM）。
- `design_to_test`：缺前置返回 needs-setup，`run` 缺省 false；显式 `run:true` 才执行，默认逐屏对比设计并回传 `ui`/`uiCoverage`。
- 验收口径：设计 `Flow/AC*`、`AC:`/`验收：` 批注或 `.artemis/design/acceptance.json` 作为硬断言期望来源；无口径沿用运行期文本（建议级）。

### 4.3 Excel 导入

- Excel → `importTestDocument`：按 **Section**（有则）或 Module 拆集；同内容幂等复用；同名文档更新以最新用例集取代。
- 可见列：用例名、步骤、预期、前置、模块、Section、**Wireframe/设计引用**、Related TC；隐藏「执行器」sheet 仍支持 `taskDesc`/`humanStepsHash`/`designRefs` 回环。
- Wireframe：换行分隔设计屏名（兼容 `)0.` 粘连），写入 `screens`/`designRefs`/taskDesc「设计引用」；URL/图片/路径不误用。
- `run_regression` 的 `columns` 可显式覆盖表头；面板 `excel_mappings` 支持 Section/Wireframe/Related TC 的预览/保存，资产导入优先复用，同模板新资产按表头兼容性复用。
- 导入响应 `design` 摘要：`available/sources/excelImages/designRefs/columns/warnings/nextAction`；有设计基线但无设计引用、有内嵌图片、有参考图无契约等显式提醒。

### 4.4 设计辅助 enrich

目标：Excel 步骤不动，设计补 `screens/designRefs/expectations/preflight`；确定性匹配优先，LLM 只处理歧义；默认 preview，不覆盖原 Excel。完整范围/数据结构/验收见：

`docs/superpowers/specs/2026-11-09-design-assisted-excel-enrich.md`

**P0 已实现（2026-11-09）**：MCP `design_assisted_import`——输入 Excel + `flows.json`/`screenIndexPath`，按**显式 Wireframe**（精确/包含/词元）做逐行映射；无 Wireframe 的行用步骤/预期文本匹配设计屏 textHints/elements，输出**结构候选**并标 `review`（不自动接受）。响应输出 `matched/review/unmapped/no-wireframe`、候选屏/id/score；mapping 报告落 `.artemis/design/enrich/`；只读预览，**不写用例集、不改 Excel**。`save:false` 不落盘；缺设计索引显式报错。

**P1 apply 已实现（2026-11-09）**：`apply:true` 生成新的 enriched 用例集（`source=imported:...+design:<fingerprint>`，不覆盖普通导入/原 Excel）；exact 映射自动写 `designRefs.nodeIds`，`allowNear` 可放开 near，`requireAllMapped` 可拒绝 unmapped/review；原 Excel 字节不变。

**ambiguous 已实现（2026-11-09）**：同名多 id（如真实索引 526 个重名屏）或 near 前二分差 <0.1 时记 `ambiguous`，`design:null`、候选全列出，**不静默取第一个**；apply 不写 ambiguous，需 overrides 人工确认（或 `llmMapping:"auto"` 从封闭候选中选择）。缓存 schema v2，旧 v1 缓存自动失效重算。

**人工确认回流已实现（2026-11-09）**：`overrides` 接受 `screen+screenId`（省略 `rowNumber`＝屏级映射，应用到所有引用该屏的行）或 `rowNumber+screen+screenId`（行级优先），匹配优先级高于 exact/near/ambiguous/unmapped（`matchedBy:"human"`）；`saveOverrides:true` 合并写 `.artemis/design/enrich/enrich-overrides.json`，后续预览/apply 自动复用；人工映射的 nodeId 也会进入 enriched 用例集。

**needs-info 已实现（2026-11-09）**：预览遇到“Wireframe 列无有效屏”返回 `needsInfo`；apply 遇到无可应用映射（`excel-mapping-no-exact`，含全 near/ambiguous/unmapped）、`requireAllMapped` 有需确认行（`excel-mapping-review`）或部分映射（`excel-mapping-partial`）时返回结构化 `needs:"info"`，不执行、不猜；部分 exact 仍可 apply，但附提醒。`allowNear:true` 时 near 视为可应用，ambiguous 仍需 overrides；`requireAllMapped` 只放行 exact（+ allowNear 的 near）。

**逐屏 delta 已实现（2026-11-09）**：映射缓存 `.artemis/design/enrich/mapping-cache.json`，按 `excelSha8 + rowHash + screen + 设计屏指纹` 复用；设计只改某屏时仅重算该屏关联行，报告 `delta {reused,remapped,added,removed}`；`delta:false` 关闭，`save:false` 不写缓存。

**LLM 歧义映射已实现（可选，默认 off，2026-11-09）**：`llmMapping:"auto"` 只对 deterministic 后仍 `unmapped`/`ambiguous` 且有候选屏的行逐行调用 active LLM；候选集封闭（只允许返回已有 candidate id），置信度低于阈值不采纳，`maxLlmCalls`（默认 20）限制调用次数；命中记 `matchedBy:"llm"` 并写回映射缓存，报告 `summary.llmMapped/llmCalls`。测试用注入 `chat`，不依赖真实网络。

**设计索引独立审计已实现（2026-11-09）**：`design_index_audit` 只读校验屏索引完整性（条目/重复 id/重名屏/空 id/短名/nodes 类型过滤/textHints 与 elements 覆盖）；显式 `screenIndexPath` 时可与 flows/ui-contract 交叉比对（id/名称重叠、只在索引/只在参考源）；可选带 Excel 输出 Wireframe 覆盖率（exact/near/ambiguous/unmapped、未被引用的索引屏）。默认落盘 `.artemis/design/enrich/index-audit.json`，不改 Excel、不写用例集、不调用 LLM。

**Android 脚本断言已实现（2026-11-09）**：Android 仍由 Artemis 执行，`【AOS-EXPECT】` 在校验前从 taskDesc 剔除；运行终态后从 `data_engine.db` 的逐步 OCR 标签（OCR 为空时回退 UI tree 文本）计算 adherence（起始屏命中、断言命中/未命中、探索达成），写入 `testSummary.adherence` 与 trace 的 `android-adherence.json`；`suite report` 读取该 artifact 输出「脚本断言」列并参与失败分类；`suite evidence` 自动把 artifact 纳入证据引用；缺 DB/OCR 显式 `observations-unavailable`/`no-ocr-labels`，不伪造命中。`--fail-on-unresolved` 可把非隔离用例未命中断言升级为 exit 2（iOS/Android 同口径；无 adherence 的旧产物不阻断）。

**Phase 1 结构化动作已实现（2026-11-09）**：`tests.json flows[]` 可携带 `actions[]` / `engine` / `engineReason`；生成器按项目 `stack` 选择 target kind（android-native `resource-id`、React Native `view-tag`、Flutter `content-desc`），仅在有标识符时生成 `tap`，`wait`/`back` 可无目标；含 explore、缺动作或 continuation/prelude 的用例显式回退 `engine:"artemis"` 并记录原因，不伪造 native。`suite check`/preflight 对 `engine:"native"` 的非法/不完整 actions 做硬门禁。**执行层未接**，当前仍走 Artemis。

**Phase 2 iOS 已接入 suite（2026-11-09）**：`src/ios/structured-runner.ts` + `case-runner` 直连；`engine:"native"` 在 iOS 上不提交 `mobile_run_task`，直接按 `actions[]` 执行 tap/type/wait + AX 可见性断言；原生失败不回退 Artemis（环境/断言失败分别归 environment/behavior-or-design）。`suite run` 逐例输出引擎（`native-ios`/`native-android`/`proxy`），trace 的 `native-ios.json`/`native-android.json` 纳入 `suite evidence`。iPhone 17 / iOS 27 模拟器端到端：`type` 中文通过、tap 用例通过 `suite run`；`type` 的 `input.kind=secretRef` 执行期解析项目 secret materials/`AOS_WEB_SECRET_*`（缺失报 `secret-unresolved:<ref>`，证据文本脱敏）。back/swipe 显式不支持；Android `engine:"native"` 由 adb 适配器复用同一 structured runner（`native-android`，不提交 Artemis；单测覆盖，真机 Phase 0/真机验收仍待设备）。运行手册 `docs/ios-structured-runner.md`。

**仍未实现**：Android 更底层的确定性执行层（点击/输入后的状态机断言）；当前 Android 为事后 OCR 核对 + 可选门禁，OCR 质量决定可核对性。iOS/Android Phase 2 均已接入（`engine:"native"` 直走共享 structured runner；Android 经 adb 适配器，真机验收待 Phase 0 设备）。设计草案见 `docs/superpowers/specs/2026-11-09-android-deterministic-executor-design.md`。

---

## 5. 真机执行

### 5.1 Android

- Artemis Python 子进程（`python -m mcp_server`）；LLM 基于层级/OCR/截图逐步决策。
- 执行栈：Excel → taskDesc → `mobile_run_task`/suite → Artemis；不生成 Maestro YAML，不需要 JDK/Maestro。
- 任务轨迹/截图/notes/stdout/stderr/data_engine.db 默认写 `<项目>/.artemis/traces/`。
- 设备接入：本机 USB、远程 adb（`ADB_SERVER_SOCKET`/`deviceHosts.android.adbHost`）、adb-host 小包；Windows 宿主只需 adb。
- **安装与数据安全**：任务安装包只做 `adb install -r -t`（保留应用数据），每任务至多一次；`AOS_ANDROID_INSTALL_MODE=artemis` 已停用（设置后仅告警并回退 adb）。`suite run --app-path`/MCP 的 Android `app_path` 也在套件开始前安装一次，用例内不再透传；安装冲突/降级直接失败，**绝不卸载或执行 `pm clear`**（Artemis/adbutils 的卸载兜底会清空 app 数据）。
- **键盘输入（native）**：`type` 不再重复点击输入框；`secretRef` 默认先清空（按现有值长度，最多 200）、输入后自动收键盘；`clear`/`hideKeyboard` 可显式覆盖。Android 用 `KEYCODE_MOVE_END + KEYCODE_DEL...`（一次 shell）清空、`dumpsys input_method` 确认键盘显示后 BACK；iOS Appium 用 W3C Backspace 与 `hide_keyboard`（idb 模拟器路径为可选不实现）。taskDesc/Excel 路径仍由 Artemis 的 input_text（clipboard paste/FastInputIME）驱动，不走此逻辑。

### 5.2 iOS

- 模拟器：idb/simctl；真机：Appium + WDA。
- 签名：`AOS_IOS_XCODE_ORG_ID` 必填；iOS 18+ 真机需保持 Remote XPC 隧道（`appium driver run xcuitest tunnel-creation`，AOS 只给指引）。
- **执行预检**：`suite run --task` 在装包/启动前检查真机 Appium 后端；本地 Appium 已安装但缺 XCUITest 驱动时直接失败（`appium-driver-missing`，进度 5%），不下载/安装 IPA、不占用设备；`AOS_APPIUM_URL` 直连外部服务时跳过本地 CLI 探测（由会话错误兜底）。 真机未配置 `AOS_IOS_XCODE_ORG_ID`（WDA 签名团队）同样在预检失败（`ios-signing-missing`）。
- 观察统一 `src/ios/observation.ts`；busy 降级含帧龄/陈旧标注；执行器为门面 + 分模块。
- 真机崩溃：`devicectl systemCrashLogs`；设备日志：`idevicesyslog` 实时尾采样（窗口近似 + `clockWarning`）。
- 安装：真机 `.ipa` 经 Appium `mobile: installApp`（本地路径）或 `appium:app`（URL/远程宿主下载）安装；企业证书（In-House）IPA 可直接安装，需设备先信任企业开发者证书；模拟器不支持 `app_path`，需 `simctl install` 预装后用 `locked_app_package`。
- **套件安装节奏**：`suite run` 对真机 IPA 只在套件开始前**每设备安装一次**，后续用例不再携带 `app_path`（避免逐例重装 74MB 级 IPA）；模拟器忽略 `app_path` 并告警。任务模式同一任务的多份用例集共享这次安装。 真机默认 `appium:showXcodeLog=true`（`AOS_IOS_SHOW_XCODE_LOG=0` 关闭），Appium/xcodebuild 输出落 `<项目>/.artemis/logs/appium.log`；`xcodebuild failed` 的失败信息会附带该日志位置。**任务结束清理**：`suite run --task` 结束时（含预检/版本/装包失败）关闭 iOS 真机 Appium/WDA 会话（`runtime.disposeIosWda`），避免设备长时间停留在 Automation Running；下一条任务按需重新启动。
- **不下发 IPA（TestFlight 已安装）**：面板「② 参数」可勾选「不下发 iOS 安装包」，此时不选 IPA，必须勾选确认设备已通过 TestFlight 安装；`suite task create --skip-ios-install [--expect-version <v>]` 为 CLI 等价入口。任务记录 `appInstallMode=installed`，可选 `appVersionExpected`；runner 在创建 Appium session/WDA 之前读取**真机**上已安装版本的 `CFBundleShortVersionString`/`CFBundleVersion`（iOS 17+ `xcrun devicectl device info apps --json-output -`，旧系统回退 `ideviceinstaller --format json`；模拟器不校验）。期望版本为空时只记录实际版本（显示 `-`，不阻断）；非空时逐台精确匹配（兼容 `2.0.0`、`2`、`2.0.0 (2)`），不一致/读不到/未安装分别以 `app-version-mismatch`/`app-version-unavailable`/`app-not-installed` 在跑用例前失败。任务详情显示安装方式、期望/实际版本、校验结果、版本读取时间与测试时间（`startedAt`~`finishedAt`）。
- **Appium 归属与自愈**：默认只使用托管实例（`appium --port`）；端口已被其他实例占用时**不静默复用**，自动改用后续空闲端口并在日志标注（旧实例的驱动/`APPIUM_HOME` 可能与当前 CLI 不一致）。显式 `AOS_APPIUM_URL` 或 `AOS_APPIUM_REUSE_EXISTING=1` 才复用外部实例。会话创建遇到驱动缺失/连接断开时，托管服务自动重启并重试一次；外部服务不自动重启，错误信息带实际地址与排查指引。

### 5.3 runner / 多主机

- `suite runner`：心跳 → 原子领取 → 复用 `suite run --task` → 回写；中心 PG 或 `MOBILE_TESTING_RUNNER_CONTROL_URL` HTTP 控制面 + 本地 FileStore。
- 跨机：中心默认项目 + tests/flows 下发；runner **不持有** provider key、中心项目路径；LLM 走中心代理（`AOS_LLM_FROM_CENTER=1`）。跨机 runner 复用中心项目登记，不在 runner host 重复建项目行；面板「去下发」与 `suite task create --host` 按该 runner 注册识别跨机项目。
- 鉴权：`AOS_RUNNER_HOST_TOKENS`/文件优先；全局 `MOBILE_TESTING_RUNNER_JOB_TOKEN` + `X-AOS-Host-Id` 兼容；中心侧 `AOS_RUNNER_SHARED_LLM=1` + `AOS_RUNNER_DEFAULT_PROJECT`。
- 共享 token：全局 token 下 Host ID 仍每机唯一；仅 `/panel/api/runners/suite/llm/proxy/*` 允许不带 `X-AOS-Host-Id`（Artemis/OpenAI 客户端只带 Authorization；项目 host 校验由 `assertLlmProject` 负责），其他控制面仍强制 host。
- 队列/租约：host 级 `queue_paused`；`claim→毒丸→devices→acquireDeviceLeases→beginExecution`；30s 续租/心跳；失联回收（超龄+离线双条件）。runner 启动脚本默认 `AOS_SUITE_CASE_TIMEOUT_MS=600000`（单用例 10 分钟，可覆盖）；超时失败提示可用该变量延长，并调用 `mobile_manage_task(action="stop")` 停止 Artemis 子任务，避免孤儿进程占用设备。
- **设备选择**：任务显式 `deviceSerial` 时只用该串号；否则每个平台选**一台**，优先 `kind=device`（真机），再模拟器/模拟机；同平台其余设备不租用、不执行。找不到匹配设备时释放回 `pending` 并记录日志。
- 失败证据：runner 上传到 `.artemis/remote-evidence/<taskId>/<traceId>/`（status/stderr/stdout）；`suite evidence` 在本地 traces 缺失时回退读取，不再误报 trace 缺失。
- **测试资料占位符**：套件回归任务可挂 **secret materials**（面板「② 参数 → 测试资料」或 `suite task create --materials <id>`）；runner 通过控制面 `/tasks/:id/materials` 下载并用 `alias=value`/JSON 解析，用例 `taskDesc` 的 `<secret:alias>` 提交前替换；台账/审计保留模板、不落明文；缺 alias 按 `data-environment` 失败且不提交 Artemis。非 secret 资料不可挂。**自动注入**：勾选资料后，runner 会把未被用例显式引用的 alias 以 `【任务测试资料】` 段（label/alias/screen + `<secret:alias>`）追加到每个非 native 用例的执行 taskDesc，因此用户不需要预先改写用例；显式占位符仍优先且不会重复追加，台账仍保存原始模板。**测试邮箱自动递增**：值形如 `base+202@domain` 时，runner 按 base/domain/起始号分组，同一用例内 `reg_email`/`reg_email_confirm` 共用下一个号（+203），下一条用例继续 +204、+205…；状态落项目 `.artemis/secret-sequences.json`，源 JSON/台账不修改，避免注册用例复用已注册邮箱。
- **字段映射（native 确定性填写）**：secret JSON 可为每个 alias 附 `target`/`fallbackTargets`/`screen`；native `type` + `secretRef` 省略 target 时按映射定位，填写后回读 AX value/label 比对（密码跳过；不一致 `field-mismatch`，屏幕不符 `field-screen-mismatch`）。`suite field-map probe --device <serial>` 只读列出可编辑控件（不输出输入值）。taskDesc/Excel 路径仍只有文本替换，不承诺多字段位置确定性。
- 任务进度：`progress`（seq/phase/percent/caseId/traceId/message/errorCode）；失败证据上传（白名单/大小限制/面板链接）；失败即停。Web/LLM 任务执行前把 Excel 生成的 `taskDesc` 落盘 `.artemis/web/jobs/<taskId>/case-plan.json`，便于追溯脚本依据。
- 失败域（确定性）：`app-defect`/`environment`/`api-error`/`data-environment`/`behavior-or-design`/`design-inference`/`case-defect`/`unclassified`；只有经裁决的 `app-defect` 自动建 Jira。
- **runner 包**：0.3.0 双端；offline 包的 `runner.cmd` 会检测 `deps/win32-site-packages.zip` 并走 `setup-offline.cmd`；包契约 `npm run check:runner-bundle`。

---

## 6. 面板与可观测性

- 只读总览：`GET /panel` / `/panel.json`；`?view=compare` 多项目对比；`?section=devices|runners|events`。
- 项目发现：默认 `AOS_PANEL_PROJECT_DISCOVERY=marker`——只认 `aos.config.jsonc`、`.artemis/design/tests.json`、`.artemis/design/flows.json`，或台账 `state.projects` 中确实登记该 root；**空 `.artemis/ledger/state.json` 不算项目**（避免误跑目录变重复项目）。
- 主机/执行机：`hosts`、`runners`、`device_leases`、`host_addresses`/`host_sessions`；面板设备/执行机区块。
- 任务：任务台账、实时进度、取消/释放/重跑、队列暂停；产物只读服务（`.artemis` 范围，可选令牌）。
- 产物浏览：浏览器（`Accept: text/html`）打开日志/文本/JSON/Markdown/目录得到带返回导航的只读查看器（复制/原始/上级/返回任务）；**所有错误也渲染 HTML 错误页**（文件缺失、越权、类型不支持），非浏览器请求仍保持 JSON/原始内容；任务页仅在证据目录实际存在时显示「查看失败证据」，否则标注「失败证据未上传」，不再产生 404 死链。
- 下发向导：安装包下拉始终列出该项目的全部 `package` 资产（选项带 `data-platform` 与 `（ios/android）` 标注），勾选目标端时前端**即时**隐藏/禁用不匹配项，不需要先点「刷新预览」；创建任务时后端仍校验 APK↔Android、IPA↔iOS，防止绕过。iOS 增加「不下发 iOS 安装包」勾选：选中后隐藏/清空 IPA、显示 TestFlight 提示与必选确认、可选期望版本；未勾选且未选 IPA 时后端拒绝（CLI 保留旧行为，按设备已安装处理）。**默认值自适应**：无显式参数时沿用该项目最近一条回归任务的平台、应用包名、测试资料、期望版本与 iOS 安装方式；没有历史时按所选执行机上报的设备平台；仍无则回退 Android。选择 IPA/APK 时前端自动勾选对应平台（不清除另一端）。服务端推导出的默认值纳入 `formSignature`/`previewId`，首次打开不会被误判为过期。
- 资产：Excel/安装包/测试资料/参考图版本化；支持「归档」（`archivedAt`，默认隐藏、不可再选，历史任务仍可读，可恢复）与「彻底删除」（仅未被任务/映射引用；共享 `storagePath` 保留文件，secret 资料 unlink 明文；被引用返回 409 + 清单）。
- 测试资产：Excel/安装包/资料/参考图统一版本化；**本地注册项目（非网页创建）也可上传/保存映射**，归档项目拒绝写入；按 kind 校验扩展名/大小，secret materials 落盘 0600。Excel「导入用例库」先做设计预检：检测 Wireframe 与 `flows.json`/`ui-contract`，有索引时可选「设计增强导入 / 普通导入」，显示 exact/ambiguous/unmapped 覆盖；无索引或点「更换设计来源」时进入统一设计来源选择——**Figma URL 与 `.pen` 文件是等价适配器**，都经提取产出同一 `flows.json`，再回到同一映射预览；也可选择无设计稿普通导入。Figma/pen 提取走后台 job（`202 + jobId` 轮询，面板显示已用时长），不阻塞 HTTP 请求。
- 统计：`aos_usage` / `usage` CLI / `/usage`+`/usage.json`；调用量/耗时是成本代理，不是计费。
- 事件：`project_events`（run/case/artifact/log/feedback.request）；`aos_event_report/aos_events/aos_event_poll`；面板事件页只读。
- 日志：`<项目>/.artemis/logs/mobile-testing-mcp.log`（工具审计/usage 互链/启停/崩溃）与 `artemis-child.log`。

---

## 7. 安全

- 密钥只存项目 `.env` 或 PG；工具响应 masked；日志不落 key；快照剥离 key/token。
- HTTP：可选静态 `MOBILE_TESTING_HTTP_TOKEN`、命名用户 `AOS_HTTP_USERS`/`AOS_HTTP_USERS_FILE`（角色 viewer/dispatcher/maintainer/admin；token 只存 SHA-256；文件 mtime 热加载）；非 loopback 无令牌拒绝启动（`AOS_HTTP_ALLOW_INSECURE=1` 显式放行 + WARN）。
- TLS/mTLS：`AOS_HTTP_TLS_CERT/KEY`、`AOS_HTTP_TLS_CA` + `AOS_HTTP_MTLS=1`、CRL、热加载；TLS 上 HTTP/2 + HTTP/1.1；OCSP 由前置代理。
- runner 不变量：不持有 provider key/中心项目路径/中心内部 baseUrl；`/llm` 只返回中心代理 URL + `apiKey:null`；项目解析只在中心。
- 文件/命令：artifact 路径限制 `.artemis`；上传大小/文件名/类型校验；不执行不可信脚本。

---

## 8. 测试与验收

### 8.1 自动测试

- `npm run build`、`npm test`（构建后 `node --test test/*.test.js`）、`npm run lint`、`npm run test:types`、`npm run bundle:mcp-runner`、`npm run check:runner-bundle`。
- 单测不依赖真实 PG/设备/外网：SQL 用 `pg-mem`，artemis 用假子进程，Figma REST 不打网；合同测试覆盖 runner 包/HTTP auth/迁移顺序等。
- `test:file`/`test:name` 可单文件/名称过滤；覆盖率用 `test:coverage`。

### 8.2 真机验收（manual）

- 设备接入按 `docs/device-access-and-execution.md`；Android 先 `doctor`，iOS 真机先 Appium/WDA/隧道。
- 0.2.6 runner 交付闸门（P0）：
  1. 干净 Windows 解压 → `setup.cmd`/`runner.cmd` 走内置依赖；
  2. `configure.cmd` 只填中心 URL/token/host；
  3. 60s 内面板显示主机在线；
  4. 单任务下发、面板进度、App 动作、trace/结果回写；
  5. 失败注入 180s 内 failed/typed error；
  6. 回归可用另需：同一用例 5 次一致、每条用例至少 1 条可核对断言（Android 事后 OCR/UI tree adherence 已接；更底层状态机执行层未实现前不宣称确定性硬校验）。
- 0.2.6 端到端全绿证据仍待补；0.2.5/历史失败域/原因见 `docs/superpowers/specs/2026-11-08-android-runner-delivery-retro.md`。

### 8.3 当前未闭环

- Figma 大文件/flow board：`figma_extract_flows` 已支持 `nodeId`/URL `node-id` 走 `/files/:key/nodes` 仅取节点子树；新增 `figma_list_frames`（REST `?depth=2`）列出页面/顶层画板，面板先选范围再提取，避免整文件下载。剩余：提取后台 job 化/进度、跨页合并。
- 设计辅助 Excel enrich：链路已闭环（needs-info/overrides/ambiguous/delta/索引审计）；Android 已接事后 OCR 脚本断言（`--fail-on-unresolved` 可选门禁），更底层的确定性执行层 Phase 1（结构化 actions 契约/生成/校验）已实现，Phase 2 原生 runner 已实现（共享 structured runner + adb 适配器，单测覆盖；Phase 0 真机 Spike/验收仍待设备）；设计草案见 `docs/superpowers/specs/2026-11-09-android-deterministic-executor-design.md`。
- 面板设计增强导入：面板「导入用例库」仍是普通 Excel 导入，不检测 Wireframe、不提示设计索引/覆盖率，也不支持在线上传/解析 Figma/pen；设计增强只能走 MCP `design_assisted_import`。需先决定面板导入用「已有 flows/ui-contract」还是「在线上传/解析设计源」。
- 确定性：LLM 规划的 5 次一致性/失败域校验尚未在真实批次上完成；`suite flake`/quarantine 已有工具。
- Token/成本预算：v1 已实现（token 池/价格表/原子预留/用量报表，见 §2.2.1）；剩余为服务级审计历史与跨进程 FileStore 严格额度。

---

## 9. 历史与维护

- 历史全文（含旧 §13.x 实施记录）：`docs/design-history.md`。
- 新决策写入本文；不要再把逐条实施日志追加到本文。需要追溯时按标题/编号搜索归档。
- 变更用户可见用法时同步 `README.md`；变更 agent 操作约定时同步 `AGENTS.md`；专题设计/复盘放 `docs/superpowers/specs/`。

### 9.1 最近关键变更（2026-11）

| 日期 | 变更 | 去向 |
|---|---|---|
| 11-06 | Android 执行从 Maestro 转向 MCP 原生；移除 Maestro runner/脚本生成 | 归档 §13.317 |
| 11-08 | runner 0.2.3：进度/失败证据/失败即停；0.2.4 代理绕过 | 归档 §13.328–329 |
| 11-09 | runner 0.2.5：offline `runner.cmd` 自动使用内置依赖 | 归档 §13.331 |
| 11-09 | Excel 导入检测设计上下文/内嵌图片；Section/Wireframe/Related TC；面板模板映射 | 归档 §13.332–333 |
| 11-09 | 面板工作区发现：空台账不再算项目，修复同名重复行 | 归档 §13.334 |
| 11-10 | runner 0.2.6：iOS structured runner 接入 suite；Phase 1 actions 契约；Android Phase 2 未实现 | 本文 §4.4/§8.3 |
| 11-11 | LLM 资源池与用量记账 v1（原子预留/价格/流式计量/CLI/面板只读） | §2.2.1 |
| 11-13 | iOS 不下发 IPA（TestFlight 已安装）+ 可选期望版本运行前校验；任务记录安装方式/版本/测试时间 | §5.2/§6 |
