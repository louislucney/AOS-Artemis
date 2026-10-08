# AGENTS.md — AOS-ARTEMIS

AOS × ARTEMIS 合并 MCP 服务：Figma 设计上下文（内嵌 design-context-bridge）+ ARTEMIS 真机自动化（Python 子进程）+ 项目级 LLM 关联与切换（PostgreSQL）。里程碑 M0–M5 与 M7 已完成，M6 部分实施（M6a/M6b/M6c 已落地，其余见 DESIGN.md）。

## 完工标准

每次改动以达到以下三项为准：

1. `npm run build && npm test && npm run lint` **全绿**（380+ 测试）；
2. 行为/接口变更同步更新 `DESIGN.md`（架构与决策的唯一事实源），用法变更同步 `README.md`；
3. 测试不依赖真实 PG / 设备 / 外网（SQL 用 `pg-mem`，artemis 用假子进程，Figma REST 不打网）。

## 仓库结构与边界

- `src/` — 本服务源码（TypeScript，ESM + NodeNext + strict；相对导入一律带 `.js` 后缀）。
- `src/vendor/design-context-bridge/` — 内嵌的 MIT 上游代码。可打补丁，但每处补丁必须带 `PATCH (aos-mcp)` 注释并同步更新同目录 `NOTICE`；lint 已忽略该目录。
- `artemis/`、`design-context-bridge/` — **git submodule**（上游 `google/artemis`、`CristinaFores/design-context-bridge`）。克隆需 `git clone --recurse-submodules` 或事后 `git submodule update --init --recursive`。`artemis` 仅作为 Python 子进程依赖（`python -m mcp_server`），避免不必要的改动；其 venv 由 `doctor --install-deps`/依赖包机制处理（或 `cd artemis && uv sync`）。
- `.artemis/`（生成的 `artemis.jsonc` 项目配置与 state）、`dist/`（构建产物）。

## 常用命令

| 目的 | 命令 |
|------|------|
| 构建 | `npm run build` |
| 全量测试 | `npm test`（先构建，再 `node --test test/*.test.js`） |
| 单文件测试 | `npm run test:file -- test/figma.test.js`（先构建，不会跑旧 dist） |
| 名称过滤 | `npm run test:name -- "<pattern>"`（先构建） |
| 覆盖率 | `npm run test:coverage`（Node 内置 `--experimental-test-coverage`，无第三方依赖） |
| Lint | `npm run lint` |
| 体检 | `node dist/cli.js doctor` |
| 挂载客户端 | `node dist/cli.js install [--mode local\|docker\|http] [--force]` |
| stdio 服务 | `node dist/cli.js serve` |
| HTTP 服务 | `node dist/cli.js serve --http --port 8765 --workspace <dir>`（端点 `POST /mcp/<project>`，健康检查 `GET /healthz`） |
| 本地 PG | `docker compose --profile local-db up -d postgres` → `AOS_DATABASE_URL=postgres://aos:aos_local_dev@127.0.0.1:5433/aos` |
| 构建依赖包 | `node dist/cli.js deps build`（跨平台）；macOS/Linux 亦可用 `./scripts/artemis-deps.sh build`（可 `--skip-sync` 复用缓存） |
| 测试闭环（CLI） | `node dist/cli.js suite run\|check\|calibrate\|loop\|flake\|evidence <traceId>\|api-errors <traceId>\|baseline save\|compare\|report\|feedback`（退出码 0 全通过 / 1 用例失败 / 2 执行错误或 --fail-on 命中；`--project <dir>`、`--json`；`check` 静态覆盖不连设备、`calibrate` 对 xcresult/JUnit XML 差分校准、`loop` 一步闭环报告、`flake` 重复采样（通过率/翻转矩阵/flaky 率）、quarantine 名单（owner 签字，失败不计门禁，`--no-quarantine` 严格跑）；API 错误经 `.artemis/design/error-codes.json` 匹配，见 DESIGN §13.36；流程完整性契约与闭环编排见 DESIGN §6.10；`--device` 传 iOS 模拟器 UDID 时由 AOS iOS 执行器跑用例：idb 复位、`ios-log-unsupported` 日志降级，见 DESIGN §13.47） |
| 安装/更新依赖 | `node dist/cli.js doctor --install-deps`（serve 首次运行自动执行） |
| 镜像 | `docker build -t aos-mcp:local .` |
| 真机验收（手动） | `node scripts/e2e-device.mjs "…"`（需 artemis venv + 已授权设备） |
| 崩溃取证验收（手动） | `node scripts/e2e-crash.mjs --package <pkg> [--serial S] [--collect-only]`（需 adb + 已授权设备；`am crash` 或手动触发后采集） |
| 使用统计（CLI） | `node dist/cli.js usage [--json\|--all\|--project <名\|根路径>\|--days <n>]`（默认当前项目摘要、最近 7 天；`AOS_USAGE=0` 标注采集关闭、历史仍可查） |
| 使用统计看板 | `node dist/cli.js usage --web [--port 8766] [--host 127.0.0.1]`（只读看板复用 `/usage`+`/usage.json`，默认 loopback；端口占用 exit 2） |
| 设计流水线（一条命令） | `node scripts/design-pipeline.mjs "<figma-url>" [--import] [--scaffold]`（无 token 时给出指引并 exit 2） |
| MCP 工具调试调用（手动） | `node scripts/aos-call.mjs <calls.json> [projectDir]`（stdio 启动 `dist/index.js`，`AOS_PROJECT_DIR` 指向目标项目；`calls.json` 为 `[{name,args,out?}]`，`out` 落盘结果） |
| 设备命令（跨项目复用） | `node scripts/adb-safe.mjs <devices\|wait\|install\|shell\|screencap\|push\|pull>`（硬超时 + 超时杀进程组；默认 push 安装；`shell` 拦截 `pm install`；退出码 0/2/3/4/124/125，`--json`；测试 `test/adb-safe.test.js`） |

## 硬性约定

- **stdout 属于 MCP stdio 协议**：日志走 `log()`（stderr）；CLI 子命令（init/doctor/install）的输出除外。
- **mobile_* 工具 schema 原样透传**：`ListTools`/`CallTool` 不做 zod 镜像、不改字段（`conversation_id` 等影响唤醒路由）；新增原生工具一律用 zod。例外：`device_serial` 为模拟器 UDID 时由 AOS iOS 后端接管（`mobile_get_device_state` 截图/层级、`mobile_run_task` 内置执行器（无唤醒，轮询）、`mobile_manage_task` status/stop/inject、`mobile_inspect_trace` 四动作；路由在 Runtime 代理包装层，内部调用同样生效，响应形态对齐 artemis，见 DESIGN §13.42–§13.46）。
- 密钥只存项目 `.env`（或按产品要求在 PostgreSQL）；工具响应只回 masked 预览（`maskSecret`）；日志不落 key。
- 用户可见文案与文档用中文；代码标识符用英文。代码默认不加注释；例外：解释非显然契约的 JSDoc 可保留（如覆盖率口径、失败分类），复述代码的注释不写；vendor 补丁仍须带 `PATCH (aos-mcp)` 标记。
- 测试跑的是 `dist/`：改动后先 `npm run build` 再 `node --test`。
- **重建后必须重启**：`dist/` 变化后当前 MCP 进程仍执行旧代码（ESM 启动时加载）；重启客户端会话加载新构建，`aos_status.build.stale=true` 会提示（启动日志同时 WARN）。
- **生成物三件套是强制的**：`figma_generate_tests` 在 `save !== false` 时 tests.json + tests.md + tests.xlsx 同时落盘（响应 `savedTo` 三个路径；模版渲染失败则三份都不写）；"只有 md" 不是预期行为。

## 关键机制速查

- **项目身份**：`AOS_PROJECT_DIR` → 向上查找 `aos.config.jsonc` → 回退 cwd（`src/config/loader.ts`）。
- **LLM 首扫导入**：`AOS_LLM_*` 优先，兼容 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`（`src/projects/scan.ts`）；缺项 → `setup_required`，由 `aos_configure` 补全（写 PG + 项目 `.env`）。
- **切换语义**：模型变更对下一个任务生效；provider/key/base_url 变更重启网关子进程（只杀直接子进程，detached 任务不动）；运行中任务由 `mobile_diagnose.tasks` 守卫，`force: true` 跳过（`src/runtime.ts`）。
- **条目优先级**：store(PG) > config（可选高级层 `aos.config.jsonc`）> env（`src/llm/registry.ts`）。
- **模型目录**：8 家国产厂商预设（`src/llm/providers.ts`）；已配置条目定时 `GET {baseUrl}/models` 缓存到 PG `llm_model_cache`（`AOS_MODEL_REFRESH_HOURS` 默认 12h，0 关闭；读项目 `.env`，进程 env 优先）；模型下线自动修复（别名/同族等价，capability 名不降级；`AOS_LLM_AUTO_REPAIR=0` 关闭）+ `mobile_run_task` 预检拦截；`llm_models` list/refresh；`aos_configure` 支持 `vendor` 一键配置（`src/llm/catalog.ts`）。
- **自动重指**：非 Google provider 自动覆盖 artemis 钉死的 `object_detector`/`hopper` 节点（附精度警告）。
- **Figma 桥**：端口锁定 3055；CORS 白名单（`null` 插件 iframe + loopback）；被占用时 `skipped_occupied` 而非文件共享（`src/vendor/design-context-bridge/figma-bridge/ws-server.ts`）。
- **Figma REST 限流**：vendored 客户端补丁（NOTICE 第 5 条）——Retry-After 有界等待（`AOS_FIGMA_RETRY_MAX_WAIT_MS` 默认 60s，超过即快速失败并抛 `FigmaRateLimitError`）、按 token 冷却记忆（冷却期不发请求）、响应缓存（`AOS_FIGMA_CACHE_TTL_MS` 默认 10min，0 关闭）；访客席位 low 档 + 大文件可能触发多日冷却，需换编辑席位/token。
- **Jira 接入（M8a 读取 + M8b 已完成）**：`jira_issue_get` / `jira_issue_search`（Cloud REST v3，搜索走 `/rest/api/3/search/jql` 游标分页）；`jira_issue_comment`（纯文本→ADF，traceId 幂等 marker）/ `jira_issue_attach`（multipart、确定性命名+哈希去重、超限跳过）/ `jira_evidence_post`（失败证据 composite：截图/标注图/失败清单/失败域/崩溃摘要 → 幂等评论+去重附件，`dryRun`）；CLI `jira issue create|comment|label|transition|link`（与工具同客户端，exit 0/1/2）；凭证在项目 `.env`（`JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`，可经 `aos_configure` 三件套写入；站点仅 `https://*.atlassian.net`；masked、不落 PG）；429 有界等待 + 按凭证冷却、无缓存；tracker 迁移与沙箱验收（M8c，06）见 `.scratch/jira-integration/`、DESIGN §6.8/§13.55。
- **iOS 真机（M9a/M9c）**：真机 UDID 走 Appium+WDA（模拟器保持 idb/simctl）——`ios/appium` 服务（`AOS_APPIUM_URL` 直连或托管懒启动）、同 UDID FIFO + 观测缓存帧、输入走 `POST /keys`（`mobile: typeText` 已移除）、签名团队 `AOS_IOS_XCODE_ORG_ID` 必填（iOS/Appium 配置项目 `.env` 打底、进程 env 覆盖，多项目团队各异时各写各的，DESIGN §13.57）、iOS 18+ 需一次性 `sudo appium driver run xcuitest tunnel-creation`；真机崩溃取证经 `devicectl systemCrashLogs`（来源 `devicectl-systemCrashLogs`），设备日志经 `idevicesyslog` 实时尾采样（窗口近似 + `clockWarning` 标注；工具缺失/窗口已过显式降级 `ios-log-tool-missing`/`window-elapsed-live-tail`，`AOS_IDEVICESYSLOG_PATH` 可指定）；doctor / `aos_status.ios` 可见；套件复位/`.ipa` 安装已接线（`.scratch/ios-real-device/`、DESIGN §6.9/§13.56）。
- **双入口**：stdio 与 HTTP 共用 `createServerForRuntime()`（`src/server.ts`）；HTTP 每项目独立 Runtime（`src/http-server.ts`）。
- **任务统计**：`mobile_run_task` 每次调用都记入 `task_stats`（成功→submitted；即时报错/无 trace→failed 终态，`local-<uuid>` 占位）；生成用例的 `case_id` 由任务描述精确匹配回填（`aos_tasks` 可见）；完成态由后台 30s 循环 + `aos_tasks` 轮询 `mobile_manage_task(status)` 回写。
- **崩溃取证**：任务终态自动采集设备 crash buffer → 签名去重（包名+根因异常+首个应用帧）落盘 `<项目>/.artemis/crashes/`；`aos_crashes` list/get/scan；iOS trace 改采宿主机 `~/Library/Logs/DiagnosticReports/*.ips`（kind=`ios`，见 DESIGN §13.48）；`AOS_CRASH_CAPTURE=0` / `AOS_ADB_PATH` / `AOS_CRASH_TIMEOUT_MS` / `AOS_CRASH_MAX_RECORDS` 可配（`src/crash/`）。
- **项目内产物**：任务轨迹/步骤截图/notes/stdout/stderr/data_engine.db 默认写 `<项目>/.artemis/traces/`（子进程 `ARTEMIS_TRACES_DIR`，显式 env 优先、相对项目根解析、纳入指纹）；`mobile_get_device_state` 的 live_screenshot 上游仍写 artemis 仓库根，AOS 自动镜像到 `.artemis/traces/live_screenshots/`（响应透传）；测试文档在 `.artemis/design/`（`src/artemis/artifacts.ts`、DESIGN.md §6.7）。
- **日志**：`<project>/.artemis/logs/aos-mcp.log`（工具调用审计 name/ok/ms + `usage=<id>` 事件互链 + 启停 + 崩溃堆栈）与 `artemis-child.log`（子进程 stderr 落盘）；`AOS_LOG_LEVEL/DIR`、`AOS_LOG_DISABLE_FILE=1`、`AOS_LOG_MAX_MB`（轮转）。
- **使用统计**：客户端经 stdio/HTTP 的每次工具调用（`aos_usage` 自身除外；ADR-0006 只采客户端调用，内部编排直接走 `runtime.proxy.callTool` 不入账）记一条调用事件（工具/族/成败/耗时/错误类/信号/参数键集合——不记参数值本身，错误摘要为回显片段 ≤300），存 PG `usage_events`（不可用降级内存；写入时按 `AOS_USAGE_RETENTION_DAYS` 默认 90 / `AOS_USAGE_MAX_EVENTS` 默认 50000 清理；`AOS_USAGE=0` 停采集但历史仍可查）；审计行 `usage=<id>` 双向可查；三消费面同源——`aos_usage` 工具（summary/signals/events）、`usage` CLI（文本/JSON/`--web`）、HTTP `/usage`+`/usage.json`（`AOS_USAGE_WEB=0` 关闭路由）；`aos_status.usage` 显示 enabled/storage（`src/usage/`、DESIGN §13.54）。
- **依赖更新检测**：`artemis/.venv/.aos-deps.json` 的 lock 哈希 stamp 对比 `uv.lock`；过期时 serve / `doctor --install-deps` 自动更新（依赖包 `AOS_ARTEMIS_DEPS_URL` 优先，旧包回退在线 `uv sync`；`AOS_DEPS_NO_ONLINE=1` 禁在线）。仅代码更新无需操作（venv 只装依赖，代码从仓库读取）。
- **pen CLI 托管**：解析链 `AOS_PEN_CLI_PATH` → 托管目录（`AOS_PEN_CLI_DIR`，默认 `~/.aos/pen-cli`）→ PATH；缺失时首次调用自动安装 `@pen.dev/cli[@AOS_PEN_VERSION]`（Node ≥ 22.19、需网络；`AOS_PEN_NO_INSTALL=1`/`AOS_DEPS_NO_ONLINE=1` 关闭；超时 `AOS_PEN_INSTALL_TIMEOUT_MS` 默认 600s；失败 5min 冷却 + 并发去重；`dryRun` 不触发）；项目 `.env` 白名单透传子进程（`PEN_CLI_KEY`/`PEN_AGENT_API_KEY`/`ANTHROPIC_*`/`AOS_PEN_*`，进程 env 优先、active LLM 凭证最后覆盖）；doctor 显示状态、`--install-deps` 预装（`src/pen/install.ts`、`src/pen/cli.ts`）。
- **技术栈检测**：`src/projects/stack.ts`（Flutter / React Native / 原生 Android / iOS / Web）；gap 扫描规则、定位/代码/文件命名约定按栈选择，`aos_status.stack` 可见。

## 设计流水线（Figma → 测试/代码）

五个原生 zod 工具，产物都在 `<项目>/.artemis/design/`：
`figma_extract_flows`（交互→flows.json）→ `figma_gap_analysis`（缺口+技术栈规则→gaps.json）→ `figma_generate_tests`（流程→tests.{json,md} + tests.xlsx；`excelTemplate` 传 `.xlsx` 模版填充 `{{meta.*}}/{{counts.*}}/{{case.*}}/{{index}}` 占位符，内含可直接执行的 `mobile_run_task` 任务描述）→ `figma_import_assets`（缺失资源按栈命名/目录写入；PNG 默认倍率集（Android xhdpi/xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x，`densities:false` 关闭）；路径幂等 + 内容 sha256 去重，重复记 `duplicate_of`；dryRun 可预览）→ `figma_export_brief`（tokens/组件/编码约定→build-brief.{json,md}；`scaffold` 出组件骨架）。
M6 增补（可选）：`figma_import_tokens`（颜色→tokens.json（DTCG+modes）+ 栈 token 文件 Android/Flutter/RN/Web；值冻结命名；裸色扫描）与 `figma_import_strings`（文案→strings.json + 资源写入 Android/Flutter/RN/Web/iOS；key 冻结（改名不改 key）、source_changed/unused/硬编码扫描、conflict 经 resolutions.json 闭环；复数经 `.artemis/design/string-context.json` 人工确认 → Android `<plurals>`、Flutter/RN/Web ICU、iOS `.stringsdict`）。
pen.dev（原 pencil.dev）接入（P1）：离线工具 `pen_inspect` 解析 `.pen`（id/ref/`$变量` 校验 + 摘要）、`pen_extract_flows`（无交互数据时合成流程：标签命名 + 状态归并 + 画板排布推断 → flows.json + flow-map.md，推断边标 `INFERRED`）、`pen_import_tokens`（变量名即 token、modes 主题取值/`$别名`/usage → tokens.json + 栈文件）、`pen_import_strings`（文本 → 冻结 key → strings.json + 五栈资源）、`pen_export_brief`（→ build-brief.{json,md}，scaffold 出骨架）；CLI 四件套（`pen` CLI 缺失自动托管安装到 `~/.aos/pen-cli`（Node ≥ 22.19、需网络，`AOS_PEN_NO_INSTALL=1` 关闭）；登录用 `pen login` 或项目 `.env` 的 `PEN_CLI_KEY`（自动透传子进程）；`AOS_PEN_CLI_PATH`/`AOS_PEN_CLI_DIR`/`AOS_PEN_VERSION`/`AOS_PEN_TIMEOUT_MS`/`AOS_PEN_INSTALL_TIMEOUT_MS` 可配；doctor 显示状态、`--install-deps` 预装）：`pen_export`（PNG/JPEG/WEBP/PDF）、`pen_apply_tokens`/`pen_apply_strings`（写回 .pen，原位=临时文件→回读校验→原子替换，失败不动原文件）、`pen_agent`（prompt→.pen；凭证自动复用 active LLM：DeepSeek 自动映射 `ANTHROPIC_BASE_URL=/anthropic`（已实测）；Kimi/Z.AI/百炼 映射 Anthropic 端点 + Bearer + 模型 env（待真实 key 冒烟）；其他 provider 仅注入 `PEN_AGENT_API_KEY`，可 `AOS_PEN_ANTHROPIC_BASE_URL` 覆盖）。Figma→.pen 旁路原型 `scripts/figma-to-pen.mjs`（响应缓存 + 429 退避冷启动安全）。

触发：① 客户端挂载后用自然语言（`install` 已生成项目级配置，重启客户端生效）；② 一条命令：`node scripts/design-pipeline.mjs "<figma-url>" [--import] [--scaffold]`；③ 对话中按序点名上述工具。前置：`FIGMA_ACCESS_TOKEN`（项目 `.env` 或 `aos_configure` 写入）。
执行生成的用例：`mobile_run_task(task_desc = tests.json 的 flows[i].taskDesc)`；生成物含确定性前置假设（`flows[].preconditions`，同时写入 md/xlsx 与 taskDesc）；套件运行失败按确定性规则分域（应用缺陷/环境/数据环境/行为或设计/用例缺陷/未分类，`SuiteCaseResult.failure`，见 DESIGN.md §13.26）；需要看图时用 `compare_design_and_device` 出"设计 vs 真机"双图，需要**确定性差异**（区域/严重度/标注图/落盘报告）用 `design_device_diff`（支持 `alignment.insets`/`ignoreRegions`、`dryRun`；设计源支持 Figma 或 `.pen`（`design:{source:"pen",penPath?}`，pen CLI 渲染、节点几何来自 .pen）；设备源可用实时截图（`device:{lossless:true}` 时经 adb 抓无损 PNG，避免 JPEG 伪影，失败自动回退 live JPEG；`device:{platform:"ios"}` 时改走 macOS 模拟器 idb→simctl 无损 PNG，仅 `mode:"live"`）或 `device:{mode:"step",traceId,stepNumber?,image?}` 对比失败步骤截图（省略 stepNumber 时按失败证据自动检索并记录 anchor/候选）；差异按设计节点几何分类 missing/extra/text/asset/position-size/color（阈值与设计节点数入报告）；区域经持久 `screen_map`（list/propose/save，`.artemis/design/screen-map.json`）输出 `localized` 定位）。

## 延伸阅读（按需）

- `DESIGN.md` — 架构、评审记录、里程碑、PG 数据模型、安全与风险；改运行时/工具/存储/传输前必读。
- `README.md` — 使用方式、本地 PG、容器部署、客户端安装；回答"怎么跑/怎么装"时读。
- `docs/接入指南.md` — 运行逻辑（进程/项目识别/LLM/子进程/任务/流水线/CLI 闭环）与其他项目的接入、挂载、排障；回答"整体怎么运转/别的项目怎么接"时读。
- `src/vendor/design-context-bridge/NOTICE` — 内嵌上游代码的修改清单；动 vendor 前读。
- `.env.example`、`aos.config.jsonc` — 配置契约示例（密钥只写变量名）。

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/<feature>/issues/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
