# mobile-testing-mcp

**mobile-testing（AOS × ARTEMIS 合并）MCP 服务**：Figma 设计上下文（[design-context-bridge](https://github.com/CristinaFores/design-context-bridge)，MIT）+ ARTEMIS 真机自动化（[google/artemis](https://github.com/google/artemis)，Apache-2.0）+ **项目级 LLM 关联与切换（PostgreSQL）**。

> 设计文档（架构/评审/数据模型）：[DESIGN.md](./DESIGN.md)
> 项目接入指南（其他项目如何接入与使用：能提供什么、怎么配、怎么用、排障）：[docs/接入指南.md](./docs/接入指南.md)

## 核心模型（v0.3）

- **项目自带凭证**：每个项目在自己的 `.env` 声明 LLM（OpenAI 兼容三元组）与可选 Figma token；key 的支付方即项目方。
- **首次启用首扫导入**：服务扫描项目 `.env` → 导入 PostgreSQL（多条目 + active 指针）；缺失则返回 `setup_required`，用 `aos_configure` 工具补全。
- **全 OpenAI 兼容**：artemis 侧统一 `custom` provider（`OPENAI_BASE_URL` + `OPENAI_API_KEY` + model，参考 DeepSeek）。
- **Figma 可选**：token 存在则读（PG/.env），不存在忽略；REST 工具缺 token 时提示。

## 原生部署（Mac/Linux，推荐）

```bash
git clone --recurse-submodules https://github.com/louislucney/AOS-Artemis.git
cd AOS-Artemis && npm install && npm run build
node dist/cli.js doctor --install-deps   # 首次：安装 artemis venv 等依赖

# 目标项目侧（可选脚手架）：在「项目目录」执行 node <AOS-Artemis>/dist/cli.js init
#   → 写 aos.config.jsonc + .env.example，并打印三步指引（--force 覆盖已有）

# 单机 stdio：在 MCP 客户端里挂载 node <repo>/dist/index.js，env 注入 AOS_PROJECT_DIR 与 MOBILE_TESTING_DATABASE_URL
node dist/cli.js install                # 或由它生成客户端配置

# 多项目 HTTP 常驻（Mac mini 供其他机器接入；PG 连接串见下文"本地开发数据库"）
MOBILE_TESTING_DATABASE_URL=postgres://aos:aos_local_dev@127.0.0.1:5432/mobile-testing \
  node dist/cli.js serve --http --host 0.0.0.0 --workspace /srv/projects
node dist/cli.js install --mode http --url http://<mac-ip>:8765
```

## artemis 依赖包（加速首次安装与更新）

artemis 依赖较重（190 个包，直连下载约几分钟）。构建一次依赖包，目标机上即可**离线秒级安装**（实测 uv 安装 190 包 464ms，总耗时≈解压 240MB 包的时间）：

```bash
# ① 构建（跨平台：Windows / macOS / Linux 各自构建对应平台一份）
node dist/cli.js deps build
# → dist-deps/artemis-deps-<os>-<arch>.tar.gz + .sha256（示例约 240MB）
# macOS/Linux 亦可用 bash 脚本（额外支持 --zstd）：./scripts/artemis-deps.sh build

# ② 上传到内部文件服务，然后配置来源（env 优先，也可写进 aos.config.jsonc）
export AOS_ARTEMIS_DEPS_URL=http://files.internal/aos/artemis-deps-darwin-arm64.tar.gz
export AOS_ARTEMIS_DEPS_SHA256=<对应的 sha256>

# ③ 首次运行：自动下载 → 校验 → 解压 → 离线安装（serve 首次启动同样自动处理）
node dist/cli.js doctor --install-deps
```

> **Windows 说明**：用 `node dist/cli.js deps build` 在 Windows 机器上构建 Windows 包（uv 安装：`winget install --id astral-sh.uv`；解压用系统内置 `tar`，Win10 1803+ 自带；包为 `.tar.gz` 格式）。服务本体与 artemis 均支持 Windows；仅"孤儿进程清理检查"目前为 POSIX-only（不影响任务执行）。

**更新语义**（回答"artemis 更新了怎么办"）：

- **仅代码更新**（`uv.lock` 未变）：venv 只存依赖、代码始终从仓库读取 → 直接生效，无需操作。
- **依赖也更新**（`uv.lock` 变化）：venv 内的版本标记（`artemis/.venv/.aos-deps.json`，记录 lock 哈希）会让服务检测到"依赖已过期"并自动更新：
  1. 若你已**重建并发布**新依赖包 → 命中后**离线更新**；
  2. 若依赖包还是旧的 → 自动回退在线 `uv sync`，并提示"请重建依赖包"；
  3. 离线环境可设 `AOS_DEPS_NO_ONLINE=1` 禁止在线回退（强制刷新依赖包，否则明确失败）。
- 包按平台构建：Mac 用 `darwin-arm64`，Linux/CI 用对应 Linux 包（`scripts/artemis-deps.sh build` 在目标平台运行）。

## 日志与故障定位

**日志位置**

| 来源 | 位置 |
|------|------|
| 服务日志（启停/依赖/桥/每次工具调用审计） | `<项目>/.artemis/logs/mobile-testing-mcp.log`（`aos_status.logs.file` 直接返回路径；`AOS_LOG_DIR` 可改） |
| artemis 网关子进程 stderr | `<项目>/.artemis/logs/artemis-child.log`（进程退出也不丢） |
| HTTP/常驻模式 | 同上 + stderr 同步输出（服务进程日志） |
| artemis 任务明细（最细粒度） | `artemis/traces/<trace_id>/stdout.log` / `stderr.log` |
| 客户端侧（stdio） | 服务 stderr 同时被 opencode / Claude Code 捕获进各自 MCP 日志 |

每条工具调用都有审计行，例如：`2026-09-28T15:20:11.123Z INFO  [mobile-testing-mcp] tool=mobile_run_task ok=true ms=87 usage=<id>`（失败时附错误摘要，级别 WARN）；`usage=<id>` 对应使用统计里的调用事件，可从日志直接定位事件。

**按症状定位**

| 症状 | 排查路径 |
|------|----------|
| 工具列表少了 5 个 `mobile_*` / 提示"artemis 子进程未就绪" | `mobile-testing-mcp.log` 的 `依赖状态` 行 → `doctor` → `mobile_diagnose` |
| 任务失败 | `aos_tasks` 取 `trace_id` → `artemis/traces/<trace_id>/stderr.log` 尾部 + `mobile_inspect_trace(view_step_details)`；`mobile_diagnose` 会直接给出 `logs.last_failed_task.recent_errors` |
| LLM 401/超时/余额 | `llm_list` 看 active 与 key 来源；`artemis-child.log` 与任务 stderr 中的 provider 报错 |
| Figma 桥不通 | `mobile-testing-mcp.log` 的 `[bridge]` 行 + `aos_status.figma.bridge` / `GET /healthz` |
| MCP 连不上 / 服务秒退 | `mobile-testing-mcp.log` 末尾（`uncaughtException` 堆栈会落盘；初始化失败也落盘） |

**日志配置**：`AOS_LOG_LEVEL=debug|info|warn|error`（默认 info）、`AOS_LOG_DIR`（改目录）、`AOS_LOG_DISABLE_FILE=1`（关闭文件输出）、`AOS_LOG_MAX_MB`（轮转阈值，默认 5MB，保留 `.1` 备份）。

## 本地开发数据库（PostgreSQL）

Mac 原生部署直接用**本机 PostgreSQL**（系统安装的 EDB / Postgres.app，或 `brew install postgresql@17`）。以下示例以本机 5432 上的实例为准：

```bash
# 用你的超级用户建服务专用角色与库（只做一次）
psql -h 127.0.0.1 -p 5432 -U postgres -d postgres \
  -c "CREATE ROLE aos LOGIN PASSWORD 'aos_local_dev';" \
  -c "CREATE DATABASE \"mobile-testing\" OWNER aos;"

export MOBILE_TESTING_DATABASE_URL='postgres://aos:aos_local_dev@127.0.0.1:5432/mobile-testing'
node dist/cli.js doctor     # 应显示 "✓ PostgreSQL 连接正常"

# 挂载 MCP 客户端时把该变量带进客户端配置：
MOBILE_TESTING_DATABASE_URL='postgres://aos:aos_local_dev@127.0.0.1:5432/mobile-testing' node dist/cli.js install --mode local
# HTTP 集中部署时把该变量放进 serve 进程环境：
MOBILE_TESTING_DATABASE_URL='postgres://aos:aos_local_dev@127.0.0.1:5432/mobile-testing' node dist/cli.js serve --http --host 0.0.0.0 --workspace /srv/projects
```

若本机没有 PostgreSQL：`brew install postgresql@17 && brew services start postgresql@17`（默认 5432；被占用时可在 `/opt/homebrew/var/postgresql@17/postgresql.conf` 改 `port`）。
切换实例只需替换 `MOBILE_TESTING_DATABASE_URL`（表结构首次连接自动创建）。

> **缺省即持久**：未配置 `MOBILE_TESTING_DATABASE_URL` 时，台账落**项目文件台账**（`.artemis/ledger/`：state.json/usage.jsonl/audit.jsonl/journal.jsonl，随项目保留、重启不丢）；PostgreSQL 用于集中跨进程/跨项目查询。runner 与定时回归仍需中心 PG（文件台账不支持多进程）；仅文件台账目录不可写才退回会话内存（doctor/aos_status 会如实标注）。

## HTTP 模式（远程/多项目）

```bash
# 服务端（主机运行；workspace 下每个子目录是一个项目）
node dist/cli.js serve --http --port 8765 --workspace /srv/projects
# 端点: POST http://<host>:8765/mcp/<project>    健康检查: GET /healthz
# 事件入口: POST/GET http://<host>:8765/events/<project>（同样受 AOS_HTTP_TOKEN 保护）

# 客户端配置（或 mobile-testing-mcp install --mode http --url http://host:8765）
# 旧 aos-mcp bin 别名已移除；已生成的 MCP 配置使用 node dist/index.js，不受影响
```

无状态 streamable-HTTP：每个项目独立 Runtime（LLM 关联 / artemis 子进程 / 任务统计）；项目名限 `[A-Za-z0-9._-]`。stdio 与 HTTP 两种入口共用同一套工具。

`initialize` 响应携带 `instructions`（服务定位、常用入口、设备选择与凭证纪律；两种入口共用），客户端 agent 可直接看到；`package.json` 的 description 仅作 npm/服务元数据。

**项目执行事件入口（P0/P1）**：`POST /events/<project>` 上报 `run.*/case.*/artifact.created/log.entry/feedback.request` 事件（幂等 `eventId`，202 返回 `serverId/receivedAt/storage/degraded`）；`GET /events/<project>` 按 `runId/caseId/type/status/since/afterSeq/order/limit/includePayload` 查询（返回 `nextSeq` 游标）。`GET /events/<project>/poll?afterSeq=<nextSeq>&waitMs=<0-30000>&consume=true` 长轮询无丢失事件（`consume` 标记 `consumed_at`，`GET /events/<project>?consumed=false` 查未消费）；stdio/无 HTTP 的项目用 `aos_event_report` / `aos_events` / `aos_event_poll`。保留 `AOS_EVENTS_RETENTION_DAYS`（默认 30）/`AOS_EVENTS_MAX`（默认 50000）；`AOS_EVENTS_FSYNC=1` 开启文件事件写入 fsync（默认关，优先 ack 延迟）。反馈采用**拉取式**：项目轮询未消费事件并自行决定重试/补数据/停止，服务端不维护反向指令队列。终态事件若在 `payload.traceId` 携带 AOS trace id，会异步回写 `task_stats` 终态（30s 轮询仍作兜底）；`run.finished` 的 `runId` 命中 `suite_runs.run_id` 时回写批次终态。事件先写穿 store 再 ack，不执行 payload、不计入 usage；项目身份由路由解析，不接受任意路径。

远程设备（Android 真机/USB、iOS 真机）必须在**服务端机器**可达；项目在其他机器时用 `aos.config.jsonc` 的 `deviceHosts` 声明远程宿主（iOS Appium 端点与签名覆盖、Android adb 端点；config < 项目 `.env` < 进程 env），`app_path` 可传 `http(s)://` 产物 URL（iOS 宿主侧下载安装、Android 服务端下载后安装）；`doctor`/`aos_status.deviceHosts` 会探活并给隧道指引。细节见 `docs/接入指南.md` §3.7 与 ADR-0011。

## 多机部署（中心 + 项目机）

中心 Mac 跑 PostgreSQL、面板与中心 CLI；项目目录留在各自 Mac/PC，由该机的**本地 MCP**（stdio 或 HTTP）与 **`suite runner`** 执行。项目身份＝`(主机, 路径)`，同一路径在两台机器上是两个独立项目；任务可定向下发到「某台机器上的某个项目」。

```bash
# 中心：主机登记与查看（只连 PostgreSQL，不写本机 .artemis）
node dist/cli.js host list [--json]
node dist/cli.js host show <id|hostname> [--json]
node dist/cli.js host register <id|hostname> --label <名> --owner <人> \
        [--expected-os mac|pc|linux] [--expected-hostname <名>]

# 中心：定向创建回归任务（必须给目标机上的项目根路径）
node dist/cli.js suite task create --host <id|hostname> --project <rootPath> \
        --ref <featureKey>... [--platform ios|android]... [--baseline latest|none]
node dist/cli.js suite task list --host <id|hostname> [--project <rootPath>]
node dist/cli.js suite task cancel <taskId> --host <id|hostname> --project <rootPath> [--note <text>]

# 项目机：本地取消（本机 + 本项目作用域，写取消来源与审计）
node dist/cli.js suite task cancel <taskId> [--note <text>]

# 整机队列闸门（阻断 runner 自动领取；不影响已领取/手动执行）
node dist/cli.js suite queue status [--host <id|hostname>] [--json]
node dist/cli.js suite queue pause  [--host <id|hostname>] [--note <text>]
node dist/cli.js suite queue resume [--host <id|hostname>]
```

**升级/迁移顺序**（详见 DESIGN §13.165）：

1. **升级中心 PG**：任一进程启动即跑 `MIGRATIONS`（advisory lock 串行化）；首次升级选低峰窗口。
2. **每台项目机在启动新版 MCP/runner（或本地 `suite` 命令）之前**：`host adopt-legacy --local --dry-run` 核对，再 `--apply` 认领 legacy NULL-host 项目。**不要**在中心做一次性认领；新版进程启动后再认领会因同路径新行已存在而被跳过。
3. 按需 `host register` 写期望画像（只提示漂移，不拒绝任务）。
4. 启动项目机本地 MCP 与 `suite runner`（runner/定时回归需中心 PG）；`AOS_HOST_ID` 集群内唯一。
5. 面板核对双在线状态与项目归属后，再开放定向下发。

**主机与在线口径**：`IDE 在线`＝MCP 客户端会话（`host_sessions`/`client_seen_at`，`AOS_CLIENT_TTL_MS` 内）；`执行机在线`＝runner 心跳（`runners.last_seen_at`，`AOS_RUNNER_TTL_MS`）；登记画像（`expectedOs`/`expectedHostname`）与实际不符只显示漂移。下发预检只看执行层与 OS/工具/设备能力，主机离线仍可入队等待。

**面板路由**：主机/执行机视图 `GET /panel?section=runners`（`/panel.json` 同源，双在线状态与队列动作）；定向派发 `?section=dispatch&host=<id>&project=<rootPath>`；队列动作 `POST /panel/api/queue/pause|resume`；主机登记 `POST /panel/api/hosts/register`。

**多机相关环境变量**：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AOS_HOST_ID` | 无 | 显式主机 id（优先于文件）；集群内每机唯一 |
| `AOS_HOST_DIR` | `~/.aos` | `host-id` 文件目录；不可写时退化为派生 ID（不可迁移） |
| `AOS_HOST_ENV_REFRESH_MS` | 600000 | runner 主机环境快照刷新周期 |
| `AOS_CLIENT_TTL_MS` | 120000 | IDE 会话在线判定窗口 |
| `AOS_CLIENT_PRESENCE_MS` | 30000 | stdio 接入心跳/刷新节流；`0` 关闭 |
| `AOS_DEVICE_LEASE_MS` | 90000 | 设备租约 TTL（续租周期 TTL/3） |
| `AOS_CANCEL_GRACE_MS` | 90000 | `stopping` 离线终结宽限 |
| `AOS_PANEL_PRIORITY` | 0 | `=1` 时面板开放优先级编辑 |
| `AOS_HOST_STRICT` | 0 | `=1`/`=true` 时严格主机模式：**本版本**的领取与本地手动执行/取消在无主机身份时拒绝。旧 runner 二进制仍按自己的 SQL 连 PG，需停用/升级，不会被此开关拦截（见 DESIGN §13.165/§13.166） |

**已知限制**：文件台账为单主机视图（`host`/`queue`/runner/定时回归需中心 PG）；中心清扫 `allHosts=true` 可能先于离线 runner 终结取消；旧 runner 行 `host_id NULL` 需升级重启后补齐（`AOS_HOST_STRICT` 只约束本版本的 claim/本地命令，旧 runner 需停用/升级，不会被开关拦截）；队列暂停是整机粒度；P4 跨主机逻辑项目分组与 HTTP 客户端记录未实现。完整清单见 DESIGN §13.165。

## 鉴权（可选静态令牌，P3d，§13.113）

两个对外网络面支持**可选静态共享令牌**（默认不设＝现状，对既有内网部署零破坏）：

| 变量 | 作用面 | 说明 |
|------|--------|------|
| `AOS_HTTP_TOKEN` | `serve --http` 全部路由 | 设置后**先鉴权后路由**：除 `GET\|HEAD /` 与 `GET\|HEAD /healthz` 外，未认证一律 401（含禁用路由与未知路径） |
| `AOS_RUNNER_ARTIFACT_TOKEN` | runner 产物服务 `/artifact*` | 设置后 `/artifact/*`（GET/HEAD）强制认证；`GET\|HEAD /healthz` 豁免；令牌不随心跳广播、面板链接保持纯 URL |
| `AOS_HTTP_ALLOW_INSECURE` | `serve --http` 安全默认逃生门 | `=1` 显式放行「非 loopback 且未设令牌」并打印醒目 WARN |

令牌只读**进程 env**（不是项目 `.env`，也无 CLI flag），日志与 `install` 输出只回 masked 预览。三种等价凭据形式：

```bash
curl -H "Authorization: Bearer $AOS_HTTP_TOKEN"  http://host:8765/panel.json   # 1) Bearer（脚本/MCP 客户端）
curl -u "any:$AOS_HTTP_TOKEN"                     http://host:8765/panel.json   # 2) Basic（用户名任意/空，密码＝令牌）
curl "http://host:8770/artifact/...?t=$TOKEN"                                   # 3) ?t= —— 仅产物服务（书签/直链）
```

- **serve 安全默认**：绑定**非 loopback**（`0.0.0.0`/`::`/LAN 地址）且未设令牌且未显式放行 → 启动失败并给指引（`exit 2`）；`AOS_HTTP_ALLOW_INSECURE=1` 可放行（仅限可信网络）。loopback 绑定不受此限。401 带 `WWW-Authenticate: Basic realm="mobile-testing-mcp"`（`HEAD` 抑制 body）。
- **install 注入（幂等）**：`AOS_HTTP_TOKEN` 在 `install --mode http` 的操作者进程 env 中时，生成的客户端条目自动带 `headers.Authorization: Bearer <token>`（token 缺失则不带并提示手配）。**令牌变更后配置视为「已存在但不同」→ 必须 `--force` 重装**才会更新。
- **浏览器流指引**：令牌启用时，首次打开 `/panel*`（GET）会触发 `WWW-Authenticate` Basic 弹窗；认证按 origin 缓存后，同源 `/panel/api/*` 的 `fetch` 会自动携带凭据（各环境/浏览器或有差异）。**建议先打开一次页面再点动作按钮**。
- **`?t=` 取舍**：查询参数方式便于书签/直链，但令牌会进入 URL、浏览器历史与访问日志——仅在可信环境使用，或改用 Bearer/Basic。HTTP 服务**不提供**查询参数通道（仅产物服务）。产物服务**目录浏览建议用 Bearer/Basic**；经 `?t=` 认证打开的目录索引会为链接**续带 `?t=`**（**仅当该值自身校验通过**；Bearer/Basic 路径不带），`?t=` 仍以**单文件直链**/书签场景为主（见 DESIGN §13.115）。

## 任务统计与组合工具

- `aos_tasks`：列出本项目 `mobile_run_task` 记录（case id / trace / 状态 / 模型 / 时间），默认先向 artemis 同步完成态；后台每 30s 自动同步；即时报错也会记为 `failed` 终态，生成用例的 `case_id` 由任务描述精确匹配回填。
- `aos_crashes`：任务终态后自动采集设备 crash buffer，解析为崩溃签名（包名 + 根因异常 + 首个应用帧）并去重计数；`list` 查看、`get` 取完整栈、`scan` 手动扫描。产物在 `.artemis/crashes/`，`AOS_CRASH_CAPTURE=0` 可关闭。
- `compare_design_and_device`：一次调用返回 **Figma 节点渲染图（PNG@2x）+ 当前真机截图**（MCP image content），交给多模态模型比对布局/间距/颜色/文案。
- `design_device_diff`：**确定性**设计 vs 真机差异（不依赖多模态）：默认取 Figma 节点 + 实时截图，做对齐与像素判定，输出结构化差异报告（区域/严重度/证据）与标注图并落盘；`alignment.ignoreRegions` 可屏蔽状态栏/视频位等动态区域；`device.platform:"ios"` 支持模拟器（idb→simctl，无损 PNG；`serial` 传 UDID 或自动取唯一已启动模拟器）与**真机（WDA PNG）**，均限 `mode:"live"`；`device:{mode:"step", traceId, stepNumber?, image?}` 可直接复核失败步骤截图（经 `mobile_inspect_trace`，默认 post）；省略 `stepNumber` 时用 `run_outcome` 失败证据检索步骤（Pro，best-effort），报告记录 `anchor`（explicit/search）与候选；设计源 `.pen` 经 pen CLI 渲染（1×，与节点几何对齐），缺 CLI 自动托管安装。报告 `unit.device.sourceFormat/lossless` 与 `detail.deviceSource` 记录源保真：iOS 为 PNG；Android live 细节会二次抓 `screencap -p` PNG，step JPEG 会标 `lossy-source` 并降细节阈值；**UI 通过只接受 PNG**。文本区域额外输出 `textStyle`（`lighter|similar|heavier`，实验性；依据 1:1 墨水比/投影形状，不识别字体名；iOS 新 trace 的 `steps[].texts` 提供设备侧文本 rect，可优先按内容唯一匹配）；`ui-contract` 的 `texts[]` 提供文本节点级字重（400/500/600/700）与几何分态，`design_device_diff` 能找到契约屏幕时输出 `detail.textStyles` 全量覆盖（`textsTotal = checked + unverified`），缺几何/极小字号/JPEG 如实标 `unverified`。
  **区域核验（放大核验，默认开启）**：按设计叶子节点 ∪ 整屏 diff 命中（无节点源时 tiles 重叠平铺）提议区域 → 在设计渲染×真机**设备原生栅格**上成对裁剪放大 → 1:1 局部判定（细节档 0.05；有损/上采样源自动降为 0.1 并警告）→ 每区域 `device｜design` 并排对图内联前 `returnCrops` 张（hasDiff 优先）并全部落盘 `regions/`；`regions` 可设 `auto|nodes|tiles|none|显式 bbox 数组`（分页＝回传上轮 `regionDetails[].bbox`，序号仅同一响应内有效）、`zoom`（1–4）、`detail` 阈值覆盖；核对纪律：**对比结论必须来自区域级对图（引用区域编号），整屏图仅用于定位**。跨源（设计渲染 vs 真机）误报基线验证中——默认细节档放行以真实项目对基线实验为准（DESIGN §13.118）。

### 使用统计（usage）

每次**客户端通过 MCP 发起**的工具调用（`aos_usage` 自身除外；不含服务内部编排调用，ADR-0006）都会记录一条调用事件：工具/家族/成败/耗时/错误类/信号/参数键集合——参数只记键名、不记录参数值本身（错误摘要为服务端回显片段，≤300 字符，不含凭据）。事件存 PostgreSQL（不可用降级内存，写入时按策略清理），审计日志行附 `usage=<id>` 与事件互链；`aos_usage` 工具、`usage` CLI 与 Web 看板共用同一份聚合。

```bash
node dist/cli.js usage                        # 当前项目文本摘要（最近 7 天）
node dist/cli.js usage --json                 # 机器可读（与文本同源，含项目 hostId）
node dist/cli.js usage --all                  # 跨项目总览（含合计；多机同名项目分别列出）
node dist/cli.js usage --project <名称> --days 30
node dist/cli.js usage --host <id|主机名> --all # 只看该主机的项目（多机同路径时用于消歧）
node dist/cli.js usage --web                  # 只读看板，默认 127.0.0.1:8766（端口占用 exit 2）
```

`--host` 在文本/JSON/`--all` 下是**项目过滤**（id 精确优先、主机名需唯一；重复主机名 exit 2 并列出候选 id，未知主机 exit 2）；`--web` 下的 `--host` 仍是**监听地址**。同路径多主机但未指定 `--host` 时，`usage` 不猜：默认当前项目/`--project` 命中多行会 exit 2 列出候选主机；未归属 legacy 行与主机行同路径时同样 exit 2，并提示 `--host` 或 `host adopt-legacy`。

### 记录导出（export）

```bash
node dist/cli.js export --what results|process|data [--format json|csv] \
  [--project <dir>] [--out <file>] [--since <ISO>] [--limit <n>]
```

三口径：**results**（测试结果：批次/裁决/单号）、**process**（测试过程：审计事件/回归任务/计划/执行机）、**data**（测试用的数据：用例集/任务统计/产物索引）；缺省打印到 stdout，`--out` 写文件；exit 0/2。

- Web 看板：`usage --web` 提供 `GET /usage`（HTML）与 `GET /usage.json`（同源 JSON）；HTTP 模式下跟随服务器绑定自动挂载同一路由（纳入 `AOS_HTTP_TOKEN` 闸门；见「鉴权」段），`AOS_USAGE_WEB=0` 关闭页面。v1 纯只读、无处置标记；独立 `usage --web` CLI 看板为 loopback 只读、暂不带鉴权（另立小票）。
- 环境变量（进程/客户端 env，不读项目 `.env`）：`AOS_USAGE=0` 关闭采集（历史数据仍可查询与展示）、`AOS_USAGE_RETENTION_DAYS`（保留天数，默认 90，0 不清理）、`AOS_USAGE_MAX_EVENTS`（每项目事件上限，默认 50000，超出丢最旧）、`AOS_USAGE_WEB=0`（关闭 `/usage` 与 `/usage.json` 路由）。

### 多项目总览面板（overview-panel）

HTTP 模式挂总览面板：`GET /panel`（服务端渲染 HTML）与 `GET /panel.json`（同源 JSON，`view: overview|project|batch|task|review|stats|compare`）。三层视图：**L1 项目总览**（接入健康灯 + 最新批次摘要）、**L2 项目详情**（集成信息 + **深探信息** + 批次列表与**批次趋势** + **回归引用**（新建回归测试：勾选份 → 创建任务）+ **回归任务**列表 + **执行机（runner）**区块 + **定时回归（schedule）**区块 + **磁盘资产**（崩溃签名/对账/设备基线热点/保留期摘要）+ 独立运行 + 设计资产）、**L3 批次详情**（归纳分类：门禁/失败域/置信度/用例/证据链）；L1/L2 每 15s 轮询刷新（运行中任务页 10s；页面隐藏或表单聚焦时暂停，可手动暂停/继续）；回归视图：**任务页**（`?task=<id>`：状态/领取方（在线/失联）/来源/子运行/对比/跨端差异/活跃态自动刷新/产物链接）、**归因队列**（`?view=review`：失败用例初判+证据+批量裁决，写库后 reload 可见；含「打开证据」链接）、**统计下钻**（`?view=stats`：功能通过率/趋势、最不稳用例、跨端差异、改进出口三清单）。

```bash
node dist/cli.js panel --web [--port 8767] [--workspace <dir>]   # 独立只读看板（HTTP 模式自带 /panel；动作层仅 HTTP 模式）
```

**控制台形态（CSDC 设计体系）**：`/panel` 已按 CSDC 重构（毛玻璃顶栏＋分区导航＋黄底当前项）。`?section=` 直达功能页：

| 版块 | 内容与动作 |
|---|---|
| `dispatch` **下发向导** | 四步（来源→参数→预览回显→确认）；**先选主机、再选该主机上的项目**（换主机丢弃项目并取该主机最近活跃项目，换项目即按新作用域重载预览）；支持用例库选份/关键词；预览显示条数、runner 候选与告警；**两段确认**派发（refs 服务端重解析）；优先级默认 `P0` **只读**，`AOS_PANEL_PRIORITY=1` 时开放 0–100 编辑（防误操作插队；仅约束面板 UI，API 可直接传 `priority`）；领取顺序为 `priority DESC, created_at ASC` |
| `library` **用例库** | 份列表（来源/条数/功能）＋**行内「下发该份」**＋**Excel 上传导入**（multipart，≤20MB）＋隔离（quarantine：**加入/移除表单，owner 签字**） |
| `archive` **档案与产物** | 批次/份/报告/差异/崩溃/轨迹 六族索引（与保留期同源），类型/关键词/时间筛选；**产物行可点**（只读服务 `GET /panel/artifact`，限 `.artemis` 范围白名单类型） |
| `audit` **审计** | 内部编排事件流（suite/import/schedule/panel/verify/issues），域/结果筛选＋**时间预设（24h/7d/30d）＋分页** |
| `ops` **运维与数据** | 存储状态（PostgreSQL/文件台账/会话内存＋写失败信号）、保留指引、**导出三口径**（结果/过程/数据 × JSON/CSV） |

写动作经 `/panel/api/*`（创建任务/释放重跑/批量裁决/一键建单/计划 CRUD/隔离/导入/导出），统一**同源校验**（`Sec-Fetch-Site`/`X-AOS-Console`，跨站 403）与**全量审计**；Excel 导入支持 multipart 上传（`.xlsx`≤20MB，单飞）：面板表单提交到 `/panel/api/import?project=<项目根路径>[&host=<主机 id>]`，HTTP 模式经该项目的运行时解析并登记为最新份。独立 `panel --web` 进程默认只读，`AOS_PANEL_ACTIONS=1` 且仅 loopback 时开放动作层（导入需 HTTP 模式的运行时解析）。

**页面按能力标记渲染**（critique 修复轮）：独立进程默认只读时页级横幅＋写 CTA 禁用并给原因（不再"点了才 404"）；导航携带项目上下文（从项目页跳转不再丢项目；无项目时项目级项禁用而非误指总览）；**派发为两段确认**（摘要→确认创建）且 refs 由服务端按 `source/ref/keyword` 重解析（不再信渲染期快照）；成功后有回执（任务 id＋审计互链）。样式为**单一 CSDC 源**（tokens＋compat 合并注入；无 legacy 覆盖、无 `color-scheme` 双色系）。

**快捷键**：`?` 开关帮助面板、`/` 聚焦筛选框、`g` 后按 `o/t/d/l/f/r/s/p/a/u` 跳转（总览/任务/下发/用例库/档案/运行机/计划/运维/审计/统计；无项目上下文时对应项不生效）。系统 `prefers-reduced-motion: reduce` 时会自动移除整页刷新。计划/隔离/导入均有控制台表单（web.ts 计划区块与用例库页；能力关闭时禁用并给原因）。

- **多项目对比**（`?view=compare` ＋ `/panel.json?view=compare`，§13.112；`panel --web` 独立看板自动可用）：补上「项目」这一层的只读运营面，回答「哪个项目需要关注」——行＝项目，列为**项目**（名链接项目页＋接入健康灯，复用 L1 行）｜**最近批次**（时间·门禁·通过率）｜**趋势**（内联 SVG 迷你图，最近 ≤10 批通过率）｜**质量**（flaky·失败域 top3）｜**待办**（未裁决失败·未建单应用缺陷·任务积压·failed）｜**运行**（runner 在线/设备·定时回归 enabled/最近触发）。**口径**：数据源以**中央台账为主**（磁盘不可达的项目机同样可比，不读批次清单）；窗口＝**份血统运行**最近 **20** 批，「最近批次」列与排序键取台账窗口最新一批（L1 的「最新批次」软读列与灯不变）；`flaky`＝窗口内运行级之和、失败域取窗口合并 top3；**两列待办口径不同**——未裁决失败＝窗内**发生次数**，未建单应用缺陷＝按（份,用例）**最新裁决去重**且未建单（与统计视图/一键建单同源）；任务积压为**最近 200 条近似**、runner 为**最近 100 条近似**，精确待办以**归因队列**（近 10 次口径）为准。**排序**＝固定「关注优先」（无批次 → 门禁 fail → 通过率升 → 名），**先排序后截断前 50** 并标注；**行级降级**——单项目台账读取失败只标注该行（`读取失败：…`），不整页失败。与 **L1 总览**的关系：同源列表与灯、独立视图、只加互链；与**统计下钻**的关系：统计是单项目「功能→用例」维度，对比是跨项目「项目」维度。**严格只读**（无子进程/无网络/无写盘），`?view=compare` 带 `project` 参数时不命中（回退项目页）。

  **功能对齐（跨项目，§13.114）**：对比页**第二区块**「功能对齐（跨项目）」把同源功能并排对照，回答「同一功能在多个项目里的通过率/flaky/待办各如何」。**匹配规则**＝**同设计源身份 ＋ 归一化功能名**，仅**组内 ≥2 个项目**展示；源身份归一化——`figma:<fileKey>`（取 `figma:` 后首个 token，**不 lower**）｜`pen:<相对路径>`（posix＋小写）｜绝对/相对文件路径（**相对该项目根** posix＋小写，跨项目同布局即可对齐；越界/不可相对化则原样小写）；功能名归一化＝NFC·trim·折叠空白·小写（CJK 不变，**不剥词形**）。**误报口径**：对齐是**并列对照、非统计合并**（**不产出跨项目聚合通过率/总分/排名**，每行数据均标注来源项目）；同名不同源不成组、不做自动别名；**已声明边界**——同一 Figma 文件的「工具 url 形式 vs 管道路径形式」**不互相匹配**（v1 纯文本归一化）。**窗口**＝**份血统运行最近 20 批**（与项目级区块同窗）；名称取 **case set 冻结名**（set 缺该 key 时回退运行功能名）；`unmatched`＝**仅出现在 1 个项目中的功能组数**（`featureKey` 为空或无 case-set 映射的运行**不参与**计数）；组表头显示**原始 source**（路径式会显示生成项目的路径）。对齐区块**全部展示、不截断**（区别于项目级区块前 50 行封顶）。

- **动作层**（仅 HTTP 模式；`AOS_PANEL_ACTIONS=0` 整体关闭）：`POST /panel/api/tasks`（引用份创建回归任务，可选 `priority` 0–100，缺省 0、非法 400；body ≤256KB，超限 413；重复提交会创建多个任务，无幂等去重）、`POST /panel/api/tasks/cancel`（取消任务：`{project,host,taskId,note?}`；pending→cancelled，claimed/running→stopping→执行机确认 cancelled；写取消来源/操作人/宿主/备注与审计）、`POST /panel/api/tasks/stop|release|rerun`（停止/释放/重派，均带 host 作用域与审计）、`POST /panel/api/queue/pause|resume`（整机队列闸门：`{host,note?}`，host 级路由、不要求 project；hostname 唯一匹配，歧义 400、未知 404、缺 host 400；阻断 runner 自动领取，不影响已领取任务）、`POST /panel/api/hosts/register`（登记 label/owner/expectedOs/expectedHostname）、`POST /panel/api/verdicts`（失败用例批量裁决：case-defect / execution-deviation / app-defect / uncertain）、`POST /panel/api/issues`（应用缺陷**一键建 Jira 单**：`{project, items:[{runId,caseId}]}`≤20 条，逐条建单＋证据评论/附件＋回写单号；`dryRun` 预览不触网；仅对存在且非 passed、无裁决或裁决为 app-defect、未建单的用例生效，已有单号返回 existing 幂等）。**可选令牌保护**——HTTP 模式下受 `AOS_HTTP_TOKEN` 闸门（先鉴权后路由；`serve` 非 loopback 未设令牌则启动失败的安全默认，见「鉴权」段）；**未设令牌时**任何能访问端口者可写任务、裁决与**建立真实 Jira 单（外部副作用）**，故仅在受控内网部署；独立 CLI 看板保持只读；`AOS_PANEL_WEB=0` 不影响动作层（两开关相互独立）。
- **改进出口（统计下钻，§13.111）**：统计视图按最新裁决呈现三个出口——**案例问题**（case-defect，指引修订期望/重新生成）、**执行偏差环境清单**（execution-deviation，按设备/端分组：次数/涉及功能/最近/备注摘要）、**应用缺陷**（app-defect，勾选 → 一键建单）。**一键建单为外部副作用**：建单走项目 Jira 凭证与 `jira_evidence_post` 同源证据逻辑（失败 best-effort 不回滚）；缺省值可写项目 `.env` 的 `JIRA_ISSUE_PROJECT`（必填缺省）/`JIRA_ISSUE_TYPE`（默认 `Bug`）/`JIRA_ISSUE_LABELS`（逗号分隔），表单输入优先；已建单条目显示单号纯文本（面板无 Jira 站点来源、不出链接）。**并发双开为已接受限制**（同条目并发可能各建一张；顺序重复点击幂等）。
- 数据源：批次清单 `.artemis/design/runs/`（`suite run`/`loop` 自动落盘，权威）+ PG 台账（含 `regression_tasks`/`suite_runs`/`suite_run_cases`，裁决写回 `suite_run_cases.verdict*`）+ 项目软读（无子进程/无网络）；磁盘不可达的项目降级为"仅台账"；缺件/清理/高版本清单一律如实占位，不猜测。
- **深探**（HTTP 模式）：项目页懒建 Runtime 后取纯读子集（active Profile/存储/artemis 子进程/桥/日志/构建状态；**不拉起子进程、不触网**）；URL 加 `?ios=1` 显式执行 **iOS 环境检测**（调用本地 appium CLI，结果缓存 60s）；独立 CLI 进程无深探层。
- 查询参数：`project`（项目名或根路径）、`batch`（清单文件名）、`task`（回归任务 id）、`view`（`review`|`stats`|`compare`；优先级 task > batch > view）、`limit`（批次数，默认 20、上限 100）、`ios`（=1 显式 iOS 检测）。
- 默认 loopback、进程内缓存 5s（动作写成功后缓存失效）；`AOS_PANEL_WEB=0` 关闭只读路由、`AOS_PANEL_CACHE_MS` 调整缓存 TTL（0 关闭缓存）；CLI 端口占用 exit 2。见 DESIGN §13.95–§13.98、§13.103–§13.105、§13.108、§13.109、§13.111、§13.112。

### 项目机 runner（回归自动领取执行 + 产物只读预览）

项目机常驻 runner 自动领取面板/CLI 创建的回归任务并按 P1 同一契约执行回写；同进程提供只读产物服务，中心面板据此给「清单/份/xlsx/证据」链接（大件仍留在项目机磁盘）。

```bash
node dist/cli.js suite runner [--name <n>] [--poll-ms n] [--heartbeat-ms n]
        [--artifact-port n（0 关闭；默认 AOS_RUNNER_ARTIFACT_PORT 或 8770）]
        [--artifact-host h（默认 AOS_RUNNER_ARTIFACT_HOST 或 0.0.0.0）] [--once]
# 需要中心 PG（MOBILE_TESTING_DATABASE_URL，与 suite 其余命令同口径）；--once 单轮冒烟
node dist/cli.js suite task release <taskId> [--force]   # 管理侧救济：claimed/running → 待执行
node dist/cli.js suite task cancel <taskId> [--note <text>]  # 取消：pending → cancelled；执行中 → stopping（执行机确认后 cancelled）
```

- 设备盘点：adb devices（emulator-* 归 emulator）＋模拟器（darwin，仅 Booted 可用）＋真机 `idevice_id -l`（best-effort）；**真机 UDID 请用 `AOS_RUNNER_DEVICES="udid1,udid2"` 显式列入**（设了即覆盖全部来源）。
- 命名与登记：`--name <n>`＝心跳/登记名（缺省 hostname）；runner 执行的任务子运行 `suite_runs.runner` 记录该名（显式透传，不影响手动运行归因）。优雅退出（SIGINT/TERM、`--once` 结束）会把本实例行标记为陈旧，**立即重启可直接接管**（崩溃仍按 TTL 接管）。环境变量：`AOS_RUNNER_POLL_MS`（5000）、`AOS_RUNNER_HEARTBEAT_MS`（30000）、`AOS_RUNNER_TTL_MS`（在线判定，90000）、`AOS_RUNNER_MAX_ATTEMPTS`（失败重试上限，默认 3）、`AOS_RUNNER_STALE_CLAIM_MS`（失联领取自动回收阈值，默认 900000＝15min，`0` 关闭）、`AOS_CANCEL_GRACE_MS`（离线取消宽限，默认 90000）、`AOS_RUNNER_PARTIAL_CLAIM`（`=1` 开启按端部分领取，默认关）、`AOS_RUNNER_ARTIFACT_PORT/HOST`、`AOS_RUNNER_ADVERTISE_URL`（LAN 无 DNS 时用 IP 覆盖基址）。
- 失败重试：任务未达终态（如引用份失效、执行前置失败）自动释放重试；**连续失败达上限置 `failed`**（不再自动重试、不阻塞后续任务；修复引用后请新建任务）。`suite task release` 对 `claimed_by` 为空的数据异常态需配 `--force`。
- 领取条件：**任务目标端 ⊆ 该 runner 的设备端集合**（缺端不领）；**双端任务需单机双端 runner**（两端分属两台机时请拆单端任务或手动执行）；面板对「pending 且无 runner 可覆盖」会给提示。默认严格子集；设 `AOS_RUNNER_PARTIAL_CLAIM=1` 后可**按端部分领取**——仅当**无任一在线 runner 可全覆盖**该任务时按交集端领取（完全覆盖仍优先，双端齐备在场时绝不部分抢占）；缺端**不自动补跑**、不新增状态字段，仅领取日志「部分端执行（缺 X——在线无全覆盖执行机）」＋执行侧既有缺端标注；**端覆盖审计反推口径**＝任务 `runIds` 关联的 `suite_runs.platform` 集合 vs 任务 `platforms`（统计下钻分母按实际已跑端）。
- 产物预览与风险：只读服务默认监听 `0.0.0.0`（LAN 预览所需；启动打印醒目告警）；**可选令牌 `AOS_RUNNER_ARTIFACT_TOKEN`**——设置后 `/artifact*` 强制认证（Bearer/Basic/`?t=`，`GET|HEAD /healthz` 豁免，见「鉴权」段），未设则维持「无鉴权」内网口径；暴露范围＝项目 `.artemis`（**含 `logs/` 与 `crashes/`**）；`--artifact-port 0` 关闭。同一项目**勿双开同名 runner**（会互相释放/领取）。
- 崩溃/失联救济：runner 重启自动释放自己的未完成领取；**在线 runner 每轮自动回收超龄＋失联的领取**（`claimed_at` 超 `AOS_RUNNER_STALE_CLAIM_MS` 且领取机离线／归属悬空 → 回待执行，`attempts` 保留；毒丸任务在超上限的下一次领取处直接置 `failed` 不执行——「无在线 runner 则无人回收」为自洽性质）；机器报废等场景用 `suite task release`（默认要求该执行机离线）。无 runner 时手动路径不变：`suite run --task <id> --device <serial>`（claimed 不阻塞手动执行；若该任务正由 runner 持有设备租约则 exit 2）；手动执行在本机有主机身份时以独立身份 `manual:<taskId>` 获取 `--device` 的设备租约，执行中按 TTL/3 续租，结束/失败在 `finally` 停止续租并释放；被占用 exit 2。见 DESIGN §13.109/§13.116/§13.166。
- **常驻化（项目机）**：前台跑适合调试；长期运行交给系统服务管理器（工作目录＝服务仓库，自动拉起；`MOBILE_TESTING_DATABASE_URL` 须在该机环境可得）。systemd 最小示例（`/etc/systemd/system/aos-runner.service`，改 `User` 后 `systemctl daemon-reload && systemctl enable --now aos-runner`）：

  ```ini
  [Service]
  WorkingDirectory=/opt/AOS-Artemis
  Environment=MOBILE_TESTING_DATABASE_URL=postgres://aos:<pw>@<pg-host>:5432/mobile-testing
  ExecStart=/usr/bin/node /opt/AOS-Artemis/dist/cli.js suite runner --project /srv/projects/<项目> --name mac-mini-1
  Restart=always
  User=aos
  ```

  launchd 最小键（`~/Library/LaunchAgents/com.aos.runner.plist`；`ProgramArguments` 依序 node／服务 dist/cli.js／suite／runner／--name …）：

  ```xml
  <key>Label</key><string>com.aos.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/AOS-Artemis/dist/cli.js</string>
    <string>suite</string>
    <string>runner</string>
    <string>--project</string>
    <string>/srv/projects/<项目></string>
    <string>--name</string>
    <string>mac-mini-1</string>
  </array>
  <key>WorkingDirectory</key><string>/opt/AOS-Artemis</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MOBILE_TESTING_DATABASE_URL</key>
    <string>postgres://aos:&lt;pw&gt;@&lt;pg-host&gt;:5432/mobile-testing</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/aos-runner.log</string>
  <key>StandardErrorPath</key><string>/tmp/aos-runner.err.log</string>
  ```

  注意：**必须显式绑定目标项目**（`--project /srv/projects/<项目>`；缺省会落在服务仓库自身）——启动日志 `[runner] 启动：… project=…` 可核对；中心 PG 以**服务级环境**提供（systemd `Environment=`／launchd `EnvironmentVariables`，**不要**放进项目 `.env`）；单项目**勿双开同名 runner**；产物令牌 `AOS_RUNNER_ARTIFACT_TOKEN` 可选（未设＝内网无鉴权，暴露范围与风险见上文与 DESIGN §13.109/§13.113）。
- **定时回归**：`node dist/cli.js suite schedule add --ref <featureKey>… --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>]`（runner 到点**自动建任务并执行**；引用按功能实时取最新份；**同名拒绝**；`list/show/enable/disable/remove` 管理，`--json` 可选）；`AOS_RUNNER_SCHEDULES=0` 关闭触发。注意：platforms 需与项目内至少一台 runner 的设备端匹配，否则任务会**逐窗口累积 pending**（在面板任务列表关注）。（**默认严格子集**下如此；开启 `AOS_RUNNER_PARTIAL_CLAIM=1` 后，**仅当无任一在线 runner 可全覆盖时**按交集端部分领取执行、缺端不补跑，见 DESIGN §13.116）面板项目页「定时回归」区块与任务页「来源」可见。见 DESIGN §13.110。

### Jira 接入（M8a：读取）

`jira_issue_get` / `jira_issue_search`：从 Jira Cloud 读取 issue 上下文（描述纯文本 + 启发式验收标准 + 原始 ADF）与 JQL 搜索结果，供 agent 直接生成/圈定测试用例；`jira_issue_comment` / `jira_issue_attach`：评论（纯文本→ADF，带 traceId 时按 `AOS-TRACE:` marker 幂等回写）与附件上传（确定性命名 + 内容哈希去重 + 超限跳过）；`jira_evidence_post`：失败证据 composite（失败步骤截图/设计差异标注图/失败清单/失败域/崩溃签名 → 中文结构化评论 + 附件，幂等回写，`dryRun` 预览）。

Jira CLI（与 MCP 工具共用客户端与凭证；`node dist/cli.js jira help`）：

```bash
node dist/cli.js jira issue create --project-key AOS --summary "标题" [--type Task|Bug]
        [--description "纯文本"] [--label a,b]... [--parent AOS-1] [--blocks AOS-2]...
node dist/cli.js jira issue comment AOS-1 --body "纯文本" [--trace <traceId>]
node dist/cli.js jira issue label AOS-1 --add a,b --remove c
node dist/cli.js jira issue transition AOS-1 --to "In Progress"
node dist/cli.js jira issue link --inward AOS-1 --outward AOS-2 [--type Blocks]
# 公共：--project <dir> / --json；exit 0 成功 / 1 请求或配置失败 / 2 用法错误
```

tracker 工作流已迁移至 Jira：`docs/agents/issue-tracker.md`（Task=工单/Bug=缺陷/Epic=地图、五类 triage 标签、Blocks 阻塞、评论承载讨论与答案）；沙箱端到端验收待使用方提供沙箱凭证（记录于 `.scratch/jira-integration/issues/06-tracker-migration.md`）。

配置（项目 `.env`；推荐用 `aos_configure` 的 `jiraSite` / `jiraEmail` / `jiraApiToken` 一次写入，三者须同时提供）：

- `JIRA_BASE_URL`：仅接受 `https://<site>.atlassian.net`（v1 不支持 Server/DC 与自定义域）
- `JIRA_EMAIL` / `JIRA_API_TOKEN`：API token 在 id.atlassian.com 生成（现行一年有效期；过期时 401 会带轮换提示）

```bash
# 项目 .env 示例
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=***
```

- 限流：429 按 `Retry-After` 有界等待（`AOS_JIRA_RETRY_MAX_WAIT_MS` 默认 60s），超时快速失败并按凭证冷却（冷却期不发请求）；请求超时 `AOS_JIRA_TIMEOUT_MS` 默认 30s；无响应缓存。
- 搜索走 `/rest/api/3/search/jql`：JQL 需有界（如 `project = AOS ORDER BY created DESC`），游标分页（`nextPageToken`），不返回 total。
- `aos_status.jira` 显示 masked 就绪状态与缺失项；凭证只进项目 `.env`（或客户端 env），不落 PostgreSQL、不进日志。手动编辑 `.env` 后需重启 MCP 会话；`aos_configure` 写入即时生效。

### iOS 真机（Appium + WDA，M9a）

真机 UDID 由 AOS 接管（观测/动作/设计对比/执行器/套件复位/日志/崩溃）；模拟器保持 idb/simctl 不变。前置：Xcode + `appium`（含 xcuitest 驱动，`doctor` 会检查）；iOS 18+ 首次需建立隧道（常驻，自动复用）：

```bash
sudo appium driver run xcuitest tunnel-creation
```

- 配置（**项目 `.env` 打底、客户端/进程 env 覆盖**，同模型目录规则）：`AOS_APPIUM_URL`（直连既有 server，可选）、`AOS_IOS_APPIUM_PORT`（托管启动端口，默认 4723）、`AOS_IOS_XCODE_ORG_ID`（真机**必填**：证书 OU 团队 ID，可在 Xcode Settings → Accounts 查看；多项目团队不同时各自写入项目 `.env`）、`AOS_IOS_XCODE_SIGNING_ID`（默认 `Apple Development`）、`AOS_IOS_WDA_BUNDLE_ID`（默认 `com.aos.mcp.wda`）、`AOS_IOS_SESSION_IDLE_MS`（观测会话空闲回收，默认 30min，0=进程存活期保活）、`AOS_IOS_OBSERVE_WAIT_MS`（观测等待锁上限，默认 5s）、`AOS_IOS_CACHED_FRAME_MAX_AGE_MS`（缓存帧陈旧判定，默认 10min，0=关闭）、`AOS_IOS_APPIUM_TIMEOUT_MS`（WebDriver 超时，默认 120s）。
- 行为：`mobile_get_device_state`（screenshot/hierarchy）、`mobile_run_task`（iOS 执行器，支持 `app_path` 传本地 `.ipa`）、`design_device_diff` / `compare_design_and_device`（真机截图源，note 标注 `wda`）；同一设备互斥排队（任务 FIFO），观测被占用时有界等待并返回 `device_busy` + 最近缓存帧（截图 busy 且存在缓存帧 → 降级返回缓存帧路径并标注 `capturedAt`/`age`，超过 `AOS_IOS_CACHED_FRAME_MAX_AGE_MS` 追加「已陈旧」；层级 busy → 结构化报错）；层级解析失败降级为仅截图（`hierarchy=parse_failed`，默认自动重试一次）；真机崩溃取证经 `devicectl systemCrashLogs` 采集（`aos_crashes` 来源可辨识），设备日志经 `idevicesyslog` 实时尾采样（窗口近似标注；工具缺失降级 `ios-log-tool-missing`）。
- iOS 执行器开关（项目 `.env` 打底、进程 env 覆盖）：`AOS_IOS_VISION_MODE=auto|sparse|off`（默认 auto：多模态主模型每步带截图、文本主模型每步视觉感知并融合补充元素；`sparse` 旧阈值省钱档、`off` 纯文本；`AOS_IOS_VISION_ALWAYS=1` 映射 auto）、`AOS_IOS_VISION_LLM`/`AOS_IOS_VISION_MODEL`（视觉感知模型；主模型是否多模态的判定＝声明 `AOS_LLM_VISION=1|0` → 探测缓存 → 名字启发式 → 未知时无专用视觉模型则尝试一次并记录结论，见 DESIGN §13.128）、`AOS_IOS_VERIFY=final|off`（默认 final：完成时独立验证，失败必须带证据项并置 failed；`AOS_IOS_VERIFY_LLM` 可指定独立验证条目）、`AOS_IOS_MAX_STEPS`、`AOS_IOS_SETTLE_MS`、`AOS_IOS_HISTORY_STEPS`（默认 8）、`AOS_IOS_OBSERVE_RETRY`（默认 1）、`AOS_IOS_LOG_FEEDBACK=0`（关闭失败日志采集；采集写 `logs/device.log` 且 `mobile_inspect_trace` 可检索）。多模态调用若返回 200 但无 `choices[0].message.content`（瞬时空响应），同图重试一次再降级纯文本，警告附 `status/body` 摘要；兼容 OpenAI content parts 数组。
- 排障：`doctor` 与 `aos_status.ios` 显示 Appium/xcuitest 版本、签名与隧道指引；托管启动前会先探测复用已有实例。

### 设计 → 测试流水线（Figma → 真机）

```
figma_extract_flows(url)     # 交互流程 → flows.json + flow-map.md（截图默认开嵌入；screens:false 关）
figma_gap_analysis(url)      # 资源缺口 → .artemis/design/gaps.json
figma_generate_tests(url)    # 流程 → tests.{json,md} + tests.xlsx（默认 14 列：原 6 列 + 用例编号/模块/Section/测试数据/关联用例/预期结果/设计引用/备注待确认，另出「汇总」sheet；含 taskDesc、前置假设；有 strings.json 时附 i18n key；excelTemplate 套 .xlsx 模版；acceptance.json 可给 data/questions/section；taskDesc 增【测试数据】【待确认】；覆盖贪心+长路径优先——先长主链再补覆盖缺口，maxDepth 默认 30 可调，超限按续段拆分不丢尾且续段自带前导导航；每步断言与起始屏随 taskDesc 以 【AOS-EXPECT】 块输出，iOS 执行器逐步核对并汇总 adherence、起始屏 preflight（`kind=explore` 探索步记为 deferred：不进门禁、命中目标屏记 reached、验证豁免）；tests.md 默认按用例嵌屏幕截图（screens:false 关）；每功能三件套归档 `.artemis/design/case-sets/`（文件名＝`YYYYMMDD_HHmmss_功能`，MCP 生成功能名；`savedTo.caseSets`））
figma_import_assets()        # 缺失资源 → 按栈命名/目录写入（PNG 默认倍率集；import-report.json；dryRun 预览）
figma_export_brief(url)      # 编码事实包 → build-brief.{json,md}（tokens/组件/约定；scaffold 可出骨架）
figma_import_tokens(url)     # 可选：颜色 → .artemis/design/tokens.json + 栈 token 文件（tokens 唯一性/裸色扫描）
figma_import_strings(url)    # 可选：文案 → .artemis/design/strings.json + 资源文件（Android/Flutter/RN/Web/iOS；key 冻结/i18n；复数经 string-context.json）
pen_inspect(path?)           # pen.dev 离线检查：.pen（开放 JSON）结构校验 + 摘要；无账号/网络需求
pen_extract_flows(path?)     # pen 流程合成：标签命名+状态归并+画板排布推断 → flows.json(v3) + flow-map.md（推断边标 INFERRED）；可选视觉识别（vision: auto|true|false）识别交互元素（vision-inferred，未决目的地探索边；主屏+变体都成 target）；候选四态覆盖 + warnings/accounting 不静默；AOS_VISION_MAX_TARGETS 上限（旧名 AOS_VISION_MAX_SCREENS 兼容）、AOS_VISION_CANDIDATE_TOKENS 追加词表；截图默认开（screens:false 关）嵌入 flow-map.md
pen_import_tokens(path?)     # pen 颜色变量 → tokens.json + 栈 token 文件（变量名即 token；modes/别名）
pen_import_strings(path?)    # pen 文案 → strings.json + 资源文件（冻结 key；冲突经 resolutions.json）
pen_export_brief(path?)      # pen 构建简报 → build-brief.{json,md}（scaffold 可出组件骨架）
pen_export(path?)            # headless 渲染 .pen → PNG/JPEG/WEBP/PDF（CLI 缺失自动安装；需已登录；用于与真机截图对比）
pen_import_assets(ids)       # 资源导入：.pen 节点 → 位图按栈命名/倍率集幂等写入（import-report.pen.json；dryRun 预览；CLI 缺失自动安装、需已登录）
pen_apply_tokens(path?)      # 写回：tokens.json（含 modes）→ .pen SetVariables（原位安全更新，失败不动原文件）
pen_apply_strings(path?)     # 写回：strings.json → .pen 文本节点 Update(content)（原位安全更新）
pen_agent(prompt)            # agent 生成/改设计 → .pen（凭证自动复用 active LLM；CLI 缺失自动安装；.env PEN_* 透传）
# 执行：mobile_run_task(task_desc = tests.json 中 flows[i].taskDesc)
# 视觉对比：compare_design_and_device（双图交多模态）或 design_device_diff（确定性差异报告 + 标注图）
```

**触发方式**

1. **CLI 内自然语言（推荐）**：先 `node dist/cli.js install --targets opencode,claude,cursor,vscode`（会带上 `AOS_PROJECT_DIR`/`MOBILE_TESTING_DATABASE_URL`，并透传 `ARTEMIS_ADB_PATH`/`ARTEMIS_TRACES_DIR` 若已设置），重启客户端后直接说：
   *"用这个 Figma 链接跑设计流水线：<url>"* —— agent 会依次调用下述 5 个工具。
2. **一条命令**：`node scripts/design-pipeline.mjs "<figma-url>" [--import] [--scaffold]`（第 ④ 步默认 dryRun，加 `--import` 正式写入；③ 生成默认 `requireFullCoverage:true`——流程覆盖不完整即停，不落盘半套用例）。
3. **手动逐个调用**（任意 MCP 客户端）：
   `figma_extract_flows` → `figma_gap_analysis` → `figma_generate_tests`（建议 `requireFullCoverage:true`，先看响应 `coverage`）→ `figma_import_assets`(dryRun→正式) → `figma_export_brief`(+scaffold)。

**确定性执行与取证（CLI suite）**：生成用例后可用 `node dist/cli.js suite` 跑完整测试闭环（长任务/CI 友好；退出码 0 全通过 / 1 用例失败 / 2 参数或执行错误、基线回归）：

```bash
node dist/cli.js suite run [--tests <path>] [--max N] [--stop-on-failure]
                           [--device <serial>] [--app <pkg>] [--model Flash|Pro]
                           [--no-api-errors] [--fail-on api-error] [--fail-on-uncovered] [--strict] [--retry N] [--no-save]
node dist/cli.js suite check [--tests <path>] [--strict]
node dist/cli.js suite calibrate (--report <json|junit.xml>|--xcresult <bundle>) [--tests <path>]
                           [--limit N] [--no-sync] [--no-save] [--out <dir>] [--fail-on-miss]
node dist/cli.js suite loop [--tests <path>] [--skip-run] [--calibration <json>]
                           [--retry N] [--max N] [--device <serial>] [--app <pkg>]
                           [--allow-uncovered] [--no-save] [--out <dir>]
node dist/cli.js suite flake --cases <id,id,...> [--runs N] [--tests <path>]
                           [--device <serial>] [--app <pkg>] [--fail-on-flaky] [--no-save] [--out <dir>]
node dist/cli.js suite retention [--days N] [--limit N]
node dist/cli.js suite evidence <traceId> [--full-trace] [--out <dir>] [--no-save]
node dist/cli.js suite api-errors <traceId> [--serial <s>] [--no-save] [--json]
node dist/cli.js suite baseline save|compare --case <id> --step <n> --trace <id> \
                           [--image post|pre] [--ignore x,y,w,h]... [--fail-on new|persisting|any]
node dist/cli.js suite report [--limit N] [--case <id>]... [--out <dir>] [--no-sync]
node dist/cli.js suite feedback [--min-failures N]
node dist/cli.js suite reconcile list|confirm|reject [--from <screen> --to <screen>] [--reviewer <name>] [--note <text>] [--json]
node dist/cli.js suite task create --ref <featureKey>... [--platform ios|android]... [--baseline latest|none]
node dist/cli.js suite task list|show <id> [--json]
node dist/cli.js suite task create|list|cancel --host <id|hostname> --project <rootPath> ...   # 中心模式（仅 PG）
node dist/cli.js suite queue status|pause|resume [--host <id|hostname>] [--note <text>] [--json]
node dist/cli.js host list|show <id|hostname> [--json]
node dist/cli.js host register <id|hostname> [--label <名>] [--owner <人>] [--expected-os <os>] [--expected-hostname <名>]
node dist/cli.js host adopt-legacy --local [--dry-run|--apply]
node dist/cli.js host adopt-legacy --host <id|hostname> --path <rootPath> [--dry-run|--apply] [--allow-unknown-host]
node dist/cli.js suite run --task <id> --device <serial> [--device <serial>...]
node dist/cli.js suite report --task <id> [--out <dir>] [--no-save] [--json]
node dist/cli.js suite backfill [--dry-run] [--since <ISO>] [--project <dir>] [--json]
node dist/cli.js suite ui-contract [--out <dir>] [--project <dir>] [--json]
```

- `run`：逐例复位 → 提交 → 轮询终态 → 台账，输出预检摘要、逐例 PASS/FAIL 与失败域（应用缺陷/环境/**API 错误（未处理）**/数据环境/行为或设计/**设计推断**/用例缺陷/未分类；每例附「脚本 断言N/探索M」来源计数）；批次清单自动落盘 `.artemis/design/runs/`（一文件一批次：gate/失败域归并/预检摘要/用例行；`--no-save` 跳过、`AOS_SUITE_RUNS=0` 关闭、`AOS_SUITE_RUNS_MAX` 默认 200，见 DESIGN §13.95）；iOS 运行会把探索步骤命中自动写入对账资产 `.artemis/design/reconciliation.json`（Android 经 `data_engine.db` OCR/归一 taps 同样发现，需 Node ≥ 22.5，缺失自动降级；幂等，下次生成自动升级为硬断言）；同时记录「真机有设计无」的**反向观测**（runtime-only 证据级条目，不参与生成）；失败附 `suite evidence <traceId>` 提示；`--device` 为 iOS 模拟器 UDID 时用例由 AOS iOS 执行器运行（`--app` 经 idb terminate+launch 复位；日志采集标 `ios-log-unsupported` 降级）；`--fail-on-uncovered` 按预检**硬覆盖**判定——未硬覆盖屏幕/跳转、生成截断，或无法校验（缺/坏 `flows.json`）一律 exit 2（inferred 探索缺口仅报告不阻断；`--strict` 追加弱断言门禁），自定义 `--tests` 同样参与校验（流程完整性契约见 DESIGN §6.10）；`--retry N`（≤3）对未通过用例重跑做 flaky 诊断并如实标注（`retry.flaky`）；**首跑结果仍决定门禁**（重跑转绿不计首跑通过）；`.artemis/design/quarantine.json`（须 `owner`+`signedAt`，可选 `expiresAt`）中的隔离用例仍执行并标注，**失败不计门禁**，过期自动恢复；`--no-quarantine` 严格审计跑。**回归任务模式** `--task <id>`（与 `--tests` 互斥）：按引用份×设备展开子运行（`--device` 可重复；同设备内跨份重复 caseId 只跑一次）、逐子运行登记 `suite_runs`/`suite_run_cases`（带任务关联与**同份对比**：修复/回归/仍失败/新增/消失，跨端差异提示）、任务状态机 pending→running→completed/partial/failed；子集运行不做全图覆盖门禁（如实标注；`--fail-on-uncovered` 忽略）。普通 `run`/`loop` 每次执行同样 best-effort 登记（`--no-save` 跳过；store 不可用如实降级、不影响退出码）。**UI 自动比对**：`--ui-diff` 对用例访问屏（需 `ui-contract.json` + 逐屏 `.pen` + trace 步骤匹配）调用 `design_device_diff`，`--ui-diff-max` 默认 3；只有 PNG 源可 pass，JPEG/缺基线/未匹配屏保持 `ui-unverified`。
- **UI 核验与功能分开**：`suite run` 逐例/汇总额外输出 `UI` 状态（`passed|failed|unverified|not-applicable`），批次清单写 `summary.ui` 与 `cases[].ui`，面板最新批次/批次表显示 `UI 未验证 N` 徽标；默认 `unverified`，**功能通过不会冒充 UI 通过**，也不改变现有功能门禁。`ui:passed` 只接受无损 PNG 源（`isUiPass`）；Android trace 的 JPEG 源最多 report-only。
- `evidence`：一次拿到失败项、崩溃签名、锚定失败步骤截图与可选设计差异引用（默认落 `.artemis/design/evidence/<traceId>/`）。
- `check`：静态检查（tests.json × flows.json × 三件套 × 真实数据约束），**不连设备**，供 pre-merge CI；未硬覆盖屏幕/跳转、生成截断、缺/坏 flows.json、**缺 tests.xlsx 或 xlsx 早于 tests.json**（三件套强制）、**用例缺 `【真实数据】` 约束标记**（禁止伪造页面/假数据，数据须经真实请求链路）均 exit 2（探索缺口仅报告；`--strict` 追加弱断言门禁）；"测试引用但设计缺失"的路线漂移仅警告。
- `reconcile`：对账审阅面（`list` 列举差异/来源/命中/决定历史/逆向观测；`confirm` 人工确认 → human-confirmed 硬断言；`reject` 驳回 → 边不进生成；runtime-only 逆向观测仅裁决留痕；幂等、改判追加历史；未裁决不升权；未知边 exit 1、缺参 exit 2）。
- `task`：回归任务台账——`create` 引用 feature key（取该功能**最新份**；未知 key exit 2 并列出可用项；`--platform` 默认 ios+android、`--baseline latest|none`、`--priority 0–100`）、`list`/`show` 查看状态、引用解析结果与运行列表（`--json` 支持）。**中心模式**：`suite task create|list --host <id|hostname>` 只连中心 PG（`MOBILE_TESTING_DATABASE_URL`，缺配置 exit 2），**不构建本机 Runtime、不写本机 `.artemis`**；`create` 必须给 `--project <rootPath>`（远程项目根路径，未登记 exit 2），任务写 `targetHostId=<目标 host>`，`createdHostId` 记派发方本机（中心未绑定主机时为空）；下发前按目标主机 OS/能力预检（`win32 + ios` 等硬拒绝 exit 2；尚无执行机上报/离线只告警排队）；`list` 省略 `--project` 时汇总该主机所有已登记项目的任务（不猜路径）。`show/release` 仍走本机台账。`cancel <id> [--note <text>]` 取消任务：`pending` 直接 `cancelled`；`claimed/running` 先置 `stopping`，执行机确认后 `cancelled`（终态，不释放、不重试；需重跑用 `rerun`/新建任务）；取消来源/操作人/宿主/时间与备注写入任务行及审计（`source=local-cli|panel`）。中心模式 `cancel --host <id|hostname> --project <rootPath>` 只连 PG、不建本机 Runtime。
- `host`：中心主机登记（同样只连 PG）——`list`/`show <id|hostname>`（id 精确优先，hostname 大小写不敏感、重名报错列 id，不猜）、`register <id|hostname>` 写 label/owner/expectedOs/expectedHostname（登记人 `cli`）、`adopt-legacy` 把 legacy（未绑定主机）项目认领到主机：`--local` 仅认领本机存在路径（`AOS_HOST_ID` 或本机身份），`--host <id|hostname> --path <rootPath>` 显式认领（未登记主机 exit 2；确认「先迁移、后接入」时加 `--allow-unknown-host`，歧义 hostname 不提供逃逸）；缺省 dry-run，`--apply` 才写库并记审计（`domain=host/action=adopt-legacy`）；`--json` 只输出 `id/hostId/rootPath/name/lastSeenAt`，不回显 token。见 DESIGN §13.152。
- `queue`：主机队列闸门——`status` 显示当前主机 `paused/by/at` 与待执行任务数（不写库、不自动登记主机）；`pause`/`resume` 写 `hosts.queue_paused` 并记审计（`action.queue.pause|resume`，本地 `channel=cli`；可选 `--note <text>` 写入审计 refs）。暂停只阻断 runner 自动领取，手动 `suite run --task` 与已领取任务不受影响。`--host <id|hostname>` 为中心模式（hostname 唯一匹配、只连 PG、不建本机 Runtime；未知主机 exit 2）。本地首次 pause/resume 时按本机身份补登记主机。见 DESIGN §13.162。

- **Excel 入料最小样例**（`run_regression excelPath` 导入；另存为 `.xlsx`、勿合并单元格、首行表头）：

  | 用例名 | 步骤 | 预期 | 前置 | 模块 |
  |---|---|---|---|---|
  | 登录-错误密码 | 打开首页→点击登录→输入错误密码→提交 | 提示"密码错误"且不进入主页 | 应用已安装且可启动 | 登录 |
  | 登录-正常 | 输入正确密码→提交 | 进入主页 | — | 登录 |
- `calibrate`：确定性套件结果（`--report <json|junit.xml>`——JSON 或 Android instrumentation 的 JUnit XML；或 `--xcresult <bundle>` 经 `xcrun xcresulttool get test-results tests`，Xcode 16+）与 MCP 台账按 case_id 对齐，输出一致/漏报/误报与比率并落盘 `.artemis/design/reports/calibration-<stamp>.json`；测试名需内嵌 case_id（如 `test_order_flow_case-<12hex>()`）；`--fail-on-miss` 命中漏报即 exit 2。
- `loop`：测试闭环一步编排——静态检查 → 执行（`--skip-run` 跳过）→ 生成反馈 → 差分校准合并（`--calibration <calibrate 产物>`）；产出 `loop-<stamp>.{json,md}`（步骤结果 + 确定性"下一步动作" + top 建议）；exit 码 = 检查/执行的门禁结论。MCP 只负责测试闭环，不深入项目实现细节——完善路径即"测试→改进 tests/flows/数据/错误码规则"再跑下一轮。
- `flake`：重复采样量化执行确定性——`--cases` 指定 3–5 条代表用例、`--runs N` 轮（默认 3，≤50）；输出逐例通过率、翻转矩阵、flaky 判定与轮次方差，落盘 `flake-<stamp>.{json,md}`；`--fail-on-flaky` 命中即 exit 2。口径：翻转率决定 L2 投入强度，**不决定"确定性校准器是否需要"**（见 `.scratch/enterprise-ios-testing/analysis.md §11.2`）。
- `retention`：审计产物保留期**只读**报告（reports/evidence/diffs/screens/runs/traces/crashes 七类）——`--days`（默认 90）统计超期文件数与体积并列出最旧项（`--limit` 默认 20）；**不删除任何文件**，自动清理待合规口径确认后另行实现。
- `api-errors`：按 trace 时间窗采集设备日志，匹配项目错误码注册表 `.artemis/design/error-codes.json`（`{codes:{"<code>":{match,handler?,expect?,handledPattern?}}}`），判定 `handled/unhandled/observed` 并落 `.artemis/traces/<traceId>/api-errors.json`；默认只作证据，`--fail-on api-error` 才让未处理错误判 FAIL。
- `baseline`：设备对设备像素回归（last-known-good）；`--fail-on` 触发时退出码 2，可直接做 CI 门禁。
- `report`：从运行台账导出 xlsx 结果页（含「功能」「端」列 + API 错误/处理判定列）+ **追溯矩阵工作表**（design 屏幕/跳转 ↔ case_id ↔ trace ↔ 证据，含未覆盖与缺口标注）+ JUnit XML 到 `.artemis/design/reports/`（不覆盖 `tests.xlsx`）；`--task <id>` 改出**回归任务报告**（逐例来自 `suite_runs`，命名 `<时间戳>_<功能>_回归.xlsx`，多功能 → `多功能N项`）。
- `feedback`：按屏幕/断言/数据/API 错误维度给出可追踪到 case/trace 的改进建议，并追加**出口清单（按最新裁决）**——案例问题/执行偏差（按设备计数）/应用缺陷（含已建单数），JSON 输出带 `exits`（`appDefects` 每条含 `jiraKey`）；与面板统计/生成侧同源（只读，不自动改写生成物）。
- `backfill`：从磁盘产物（`.artemis/design/runs/*.json` 批次清单 + `.artemis/design/case-sets/*.json` 归档）**幂等重建登记**，补上降级期间漏登记/无登记的份与运行（**只读扫描、绝不改写产物**；**须中心 PG**，内存降级 exit 2）。重复运行已登记项全部 skip；默认只回填**不早于项目最早登记时间**的产物（`--since <ISO>` 覆盖，须为可解析 ISO（建议 `YYYY-MM-DDTHH:mm:ss.sssZ`），非法 exit 2；`beforeSince` 计数；空库无下界并告警）；`--dry-run` 只报告不写库（`registered` 恒 0、`wouldRegister`＝将登记数）；失效产物计 `invalid` 并告警。**局限**：既有任务/引用的历史 id 不可复原（回填产生新 id，仅同窗口经批次清单 `caseSetJsonPath`/`testsPath` 可达的悬空引用经路径桥修复）、回归服务之前的历史清单不回填。见 DESIGN §13.117。
- `ui-contract`：从 `flows.json` + 逐屏 `.pen` **投影** UI 契约（不另建第二份提取管线），输出 `.artemis/design/ui-contract.{json,md}`：逐屏 token（圆角/颜色/字体/字号/字重/间距）、文本节点（content/fontWeight/fontSize/bbox/geometryStatus）、几何计数与 `extracted|partial|unverifiable|no-baseline` 四态；没有逐屏 `.pen` 的屏幕标 `no-baseline`，不得猜 UI。默认经 pen CLI `Get` 解析 auto-layout 文本绝对 bbox（每屏约 4–5s，`--no-bounds` 关闭）；`--out <dir>` 改输出目录。
- 公共选项：`--project <dir>`（项目根，默认 cwd/`AOS_PROJECT_DIR`）、`--json`（机器可读输出）。


前置：`FIGMA_ACCESS_TOKEN` 在项目 `.env`（或 `aos_configure` 写入）；CLI 拉起服务时如 `adb` 不在 PATH，可在客户端 env 设置 `ARTEMIS_ADB_PATH`（如 `~/Library/Android/sdk/platform-tools/adb`）。Figma REST 限流（如访客席位的 low 档）会**快速失败并返回 retry-after 提示**，不会长时间挂起；`AOS_FIGMA_RETRY_MAX_WAIT_MS`（默认 60s）与 `AOS_FIGMA_CACHE_TTL_MS`（默认 10min，0 关闭）可调。

pen.dev 写回/导出/agent（`pen_export`/`pen_import_assets`/`pen_apply_tokens`/`pen_apply_strings`/`pen_agent`）前置：**无需手动安装**——pen CLI 缺失时自动安装到 `~/.aos/pen-cli`（Node ≥ 22.19、需网络；`AOS_PEN_NO_INSTALL=1` 关闭，`AOS_PEN_CLI_PATH`/`AOS_PEN_CLI_DIR`/`AOS_PEN_VERSION`、`AOS_PEN_TIMEOUT_MS` 默认 120s、`AOS_PEN_INSTALL_TIMEOUT_MS` 默认 600s 可调）；只需登录一次：`pen login`，或在 pen.dev 组织设置创建 `PEN_CLI_KEY` 写入项目 `.env`（自动透传子进程，不落日志）。`node dist/cli.js doctor` 显示 pen CLI 状态，`doctor --install-deps` 可预装。写回默认原位更新：先在临时文件上执行 `SetVariables`/`Update`，回读校验后才原子替换，失败时原文件保持不变；`dryRun:true` 只返回将执行的命令。`pen_agent` 的 agent 凭证自动复用 AOS active LLM 条目（只进子进程 env、不落日志）：DeepSeek 自动映射 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`（已实测）；Kimi/Moonshot、Z.AI/智谱、阿里云百炼 按官方文档映射各自 Anthropic 端点并使用 `ANTHROPIC_AUTH_TOKEN` + 模型 env（待真实 key 冒烟）；其他 provider 仅注入 `PEN_AGENT_API_KEY`，可用 `anthropicBaseUrl` 或 `AOS_PEN_ANTHROPIC_BASE_URL` 指定兼容端点。CLI 目前只识别 claude/codex/gemini 模型。离线工具（`pen_inspect`/`pen_import_*`/`pen_export_brief`）不需要 pen CLI 与账号；`pen_extract_flows` 的合成本身离线，但视觉识别（`vision` 非 false，需 active LLM 视觉能力）与屏幕截图（`screens` 默认开）需要 pen CLI 登录渲染，不可用时按 `vision-*` / `screenshot-*` 警告显式降级（不影响合成产物）；截图渲染失败逐屏降级不阻断，`screens:false` 或 `AOS_SCREENS=0` 关闭。

**设计源警告可见面（不静默省略）**：设计/视觉警告统一为 `{code, message, details?}`，写在 `flows.json.warnings` 与 `tests.json.designWarnings`，各层按同一口径展示（缺快照显示「不可用」，不折算成 0 条；`tests` 快照早于 `flows.json` 标 `stale-snapshot`）：

- `pen_extract_flows`：响应与 `flows.json` 的 `warnings` 含视觉/截图/合成全部警告；`vision.accounting` 给出守恒明细；flow-map 每屏/变体有覆盖摘要。
- `design_to_test`：提取后响应带 `warnings[]` 与 `designWarnings` 摘要（`bySource` 含 `extract`/`flows`），提取后的失败响应也携带已收集警告；提取前的 setup/no-flows 指引不伪造警告字段。
- `figma_generate_tests`：flows 与生成期警告合并进响应、tests.json 的 `designWarnings`/`designWarningsSummary`，tests.md 顶部出现「设计源警告（不阻断生成）」小节。
- `suite check` / `suite loop`：文本一行 `设计源警告: N 条（codes）· 来源 · 快照`（陈旧追加 `stale-snapshot`）；`check --json` 含同一摘要与完整 `designWarnings`；警告不改变退出码/门禁。
- 批次清单冻结运行期摘要；`suite report` 用当前快照；`run_regression`/`verify_jira_issue` 跨 set 合并去重，并以 `missingSets` 披露缺摘要的 set。
- `/panel` 项目行、项目页「磁盘资产」与批次详情（无摘要显式「未记录」）、`project_archive.design.warnings`、`scripts/design-pipeline.mjs` 的输出均可见同一摘要。

**测试用例 Excel 导出**：`figma_generate_tests` 默认把用例写入 `.artemis/design/tests.xlsx`（每流程一行：用例名/页面链路/前置假设/步骤/任务描述），`excelPath` 可改路径。要套用团队表格格式，传 `excelTemplate` 指向一个 `.xlsx` 模版：

- 元数据占位符（任意单元格内可嵌入文字）：`{{meta.source}}`、`{{meta.generatedAt}}`、`{{counts.cases}}`、`{{counts.screens}}`、`{{counts.edges}}`。
- 行模版：含以下任一占位符的那一行会按用例数复制（样式保留）并逐行填充：`{{index}}`、`{{case.name}}`、`{{case.screens}}`、`{{case.preconditions}}`、`{{case.steps}}`、`{{case.taskDesc}}`；多 sheet 各自可用行模版。
- 未识别的占位符原样保留；模版缺少行级占位符会报错且不写盘；`save:false` 三份都不写。

生成的任务描述会自动带上定位线索（Figma 文本优先、图层名兜底）与页面断言（目标页文本/子元素）：例如
`1) 点击「立即购买」（设计元素：CTA Button），验证进入「Checkout」（页面应出现「应付 ¥99」…）`。

**平台规则自动区分**：服务会从项目文件检测技术栈（`pubspec.yaml`→Flutter、`react-native`/`expo` 依赖→RN、根级 gradle→原生 Android、`*.xcodeproj`→iOS、前端依赖→Web），并按对应档案选择：
- 资源/token 扫描目录（如 RN `src/assets/**`+`src/theme/**`、Flutter `assets/**`+`lib/theme/**`、原生 `res/drawable*`+`values/colors.xml`）
- 测试定位约定（testID / ValueKey / resource-id / data-testid）
- **文件命名**（缺口清单会按栈重命名建议文件名并给出目标目录）：
  - 资源：Android `ic_home.svg`（snake_case + `ic_` 前缀，提示需转 Vector XML/PNG）、Flutter `home_icon.svg`、RN/Web `home-icon.svg`
  - 组件：`HomeButton.tsx`（RN/Web）、`home_button.dart`（Flutter）、`HomeButton.kt`、`HomeButton.swift`
  - 测试：`home-checkout.yaml`（RN/Maestro）、`home_checkout_test.dart`、`HomeCheckoutTest.kt`、`home-checkout.spec.ts`
- 代码结构约定（供后续代码生成）

检测结果可在 `aos_status.stack` 查看，`gaps.json` 会记录 `detectedStacks` 与实际采用的 `rules`；显式传 `assetGlobs/tokenFiles` 可覆盖。

## 客户端安装器

```bash
node dist/cli.js install                         # 当前项目，四种客户端，local 模式
node dist/cli.js install --help                  # 查看选项；未知参数/非法值会报错退出（不再静默按默认全客户端执行）
node dist/cli.js install --mode http --url http://10.0.0.5:8765
node dist/cli.js install --targets claude,cursor,opencode,vscode --force
```

写入：`.mcp.json`（Claude Code）、`.cursor/mcp.json`、`.vscode/mcp.json`、`opencode.json`（服务名 `mobile-testing`，旧 `aos`/`android-testing` 键自动移除；保留注释与其他 server；冲突需 `--force`）；Codex/Claude Desktop/Windsurf 打印手动片段。

## 真机 E2E 验收

```bash
node scripts/e2e-device.mjs "Open Settings and report the battery level"
# 0=completed 1=failed 2=setup_required 3=infra；前置：uv sync + .env + 已授权设备

node scripts/e2e-crash.mjs --package com.example.app
# 触发真实崩溃（am crash）→ 采集 → 签名 → 写入 .artemis/crashes；0=已捕获 1=未发现 2=infra
# 手动触发后用 --collect-only 只做采集；多设备用 --serial 指定
```

### 设备命令（adb-safe）

`scripts/adb-safe.mjs` 是带硬超时与进程组清理的 adb 包装器，可复制到任意项目供脚本/代理使用：

```bash
node scripts/adb-safe.mjs install <apk>                  # 默认 push 安装（--no-streaming）
node scripts/adb-safe.mjs shell "input tap 992 1786" --timeout 15
node scripts/adb-safe.mjs screencap out.png
node scripts/adb-safe.mjs devices --json
```

- 超时到点杀整个进程组并返回 `124`（不留孤儿 adb；`sleep 300 --timeout 3` 实测 3s 返回）；
- `shell` 拦截 `adb shell pm install`（设备侧完成后 host 端永不返回的 FD 假死），提示改用 `install`；
- 设备解析：`--serial` → `ANDROID_SERIAL` → 唯一在线设备；多设备不带 `--serial` 直接报错；
- adb 路径：`AOS_ADB_PATH` → `ARTEMIS_ADB_PATH` → `ANDROID_HOME/SDK_ROOT` → `local.properties sdk.dir` → 常见 SDK 目录 → PATH；
- 退出码：`0` 成功 / `2` 用法 / `3` 设备 / `4` 命令失败 / `124` 超时 / `125` adb 缺失；`shell` 透传远端退出码。

## 状态

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M0 | 脚手架 / 配置加载 / init / doctor | ✅ |
| M1 | artemis 代理 + 透传/env 装配 + 退出钩子 | ✅ |
| M1.5 | PG 存储 + .env 首扫导入 + `aos_configure` + 多条目切换 + 任务统计 | ✅ |
| M2 | Figma 20 工具内嵌（zod）+ 桥安全补丁 + token 引导 | ✅ |
| M3 | 容器化（Dockerfile/compose）+ `mobile-testing-mcp install` + 真机 E2E 脚本 | ✅ |
| M4 | HTTP 传输（`/mcp/<project>`）+ 任务完成态同步（`aos_tasks`）+ 组合工具（设计 vs 真机） | ✅ |
| M5 | 崩溃取证：终态自动采集 crash buffer → 签名去重 → `aos_crashes`（`.artemis/crashes/`） | ✅ |
| M6 | 设计资源唯一性与 i18n 闭环（颜色 tokens / 文本 i18n） | 🚧 M6a/M6b/M6c 完成（五栈写入；复数/倍率/真机验收后续；DESIGN.md §13.9） |

## 快速开始

```bash
npm install && npm run build

# 1) 项目 .env（服务首次启用时扫描导入；也可稍后用 aos_configure 工具写入）
cp .env.example .env    # 填 AOS_LLM_MODEL / AOS_LLM_BASE_URL / AOS_LLM_API_KEY（Figma token 可选）

# 2) 体检
node dist/cli.js doctor

# 3) 在 MCP 客户端挂载（stdio）
#    command: node
#    args:    ["<service>/dist/index.js"]
#    env:     { "AOS_PROJECT_DIR": "/workspace/<project>",
#               "MOBILE_TESTING_DATABASE_URL": "postgres://user:pass@host:5432/mobile-testing" }
```

未配置 `MOBILE_TESTING_DATABASE_URL` 时使用项目文件台账（`.artemis/ledger/`，重启不丢）；只有台账目录不可写才退回会话内存（`aos_status` 会如实标注）。

厂商模型会下线（如 DeepSeek 旧名 `deepseek-v4-flash` 已由 `deepseek-flash` 别名接管）：服务会按 `AOS_MODEL_REFRESH_HOURS`（默认 12h）定时刷新已配置厂商的 `/models` 列表，模型下线时自动修复为厂商稳定别名/同族等价模型（`AOS_LLM_AUTO_REPAIR=0` 关闭），并在 `mobile_run_task` 前拦截无法修复的失效模型，避免任务跑到一半才失败。

公司网络需代理出网时：Node 侧请求（模型目录刷新、Figma REST）需 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（Node ≥ 24；Node 的 fetch 默认不读代理变量）。`mobile-testing-mcp install` 会把当前 shell 的代理变量带入客户端配置。

## 工具

| 工具 | 说明 |
|------|------|
| `llm_list` | 项目全部 LLM 条目（store/config/env 来源）+ active + masked key + `setupRequired` + 每条目 `models`（厂商列表缓存/是否下线/建议模型） |
| `llm_switch` | 切换 active（PG 持久化）；模型下个任务生效；key/base_url 变更重启网关（任务守卫，`force: true` 跳过） |
| `llm_models` | 厂商模型目录：`list` 看缓存，`refresh` 立即拉取 `GET {baseUrl}/models`（后台每 12h 自动刷新）；模型下线时自动修复并附 8 家国产厂商预设（`AOS_LLM_AUTO_REPAIR=0` 可关） |
| `aos_configure` | 写入/更新 LLM（→ PG + 项目 `.env`）并激活；可只给 `vendor`（deepseek/qwen/zhipu/moonshot/siliconflow/stepfun/ark/hunyuan）自动选当前模型；可选同时写入 Jira 三件套（`jiraSite`/`jiraEmail`/`jiraApiToken` → 项目 `.env`）；setup 引导入口 |
| `aos_status` | 项目注册信息、存储状态、active、子进程（pid/stderr 尾部）、Figma 与 Jira（masked）就绪性 |
| `aos_tasks` | 任务/调用统计（case/trace/状态/模型），含完成态同步与错误终态记录 |
| `aos_event_report` | 项目执行事件上报（项目 → MCP）：幂等 `eventId`，202/返回 `serverId/receivedAt/storage/degraded`；`run.*`/`case.*`/`artifact.created`/`log.entry`/`feedback.request`，不执行 payload、不写 usage |
| `aos_events` | 查询当前项目 `project_events`：`runId`/`caseId`/`type`/`status`/`since`/`afterSeq`/`consumed`/`order`/`limit`；返回 `nextSeq`；默认不返回 payload（`includePayload:true` 时 limit ≤50） |
| `aos_event_poll` | 按 `afterSeq` 游标无丢失轮询事件；无新事件时最多等待 `waitMs`（0-30000）；下一轮把返回的 `nextSeq` 作为 `afterSeq`；`consume:true` 标记已消费 |
| `aos_crashes` | 崩溃取证：`list`/`get`/`scan`；任务终态自动采集 logcat crash buffer，按签名（包名+根因异常+应用帧）去重计数，产物 `.artemis/crashes/` |
| `aos_ledger_migrate` | 把当前项目文件台账的 `usage_events`/`regression_tasks` 幂等补进中心 PostgreSQL（保留原 id）；默认 `dryRun` 只统计，需 PG 存储；不处理 suite_runs/case_sets（用 `suite backfill`） |
| `regression_task_cancel` | 取消本机当前项目的回归任务（作用域＝本机＋本项目）：`pending` → `cancelled`；`claimed/running` → `stopping`（等执行机确认）；记录来源 `local-mcp`、操作人（`AOS_ACTOR` 或系统用户名）、本机 hostId 与审计（channel=`mcp`）；定向/认领给其他主机的任务拒绝取消；未知任务返回 `ok:false` |
| `aos_job_status` | 查询 `async:true` 异步任务：`run_regression`/`verify_jira_issue`/`design_to_test` 立即返回 `jobId`，后台执行；返回 running/passed/failed/error、事件摘要与完整结果（`.artemis/jobs/<jobId>.json`） |
| `aos_usage` | 使用统计（调用事件）：`summary` 概览 / `signals` 信号分布 / `events` 流水；`tool`/`status`/`days` 筛选，events `limit` ≤200；只统计客户端发起的调用，`AOS_USAGE=0` 时标注采集已关闭但历史仍可查 |
| `jira_issue_get` | 读取 Jira Cloud issue（key 或 browse URL）→ summary/status/type/labels + 描述纯文本 + 启发式验收标准标注（保留原始 ADF）；缺凭证返回 `howToFix` |
| `jira_issue_search` | JQL 搜索（`/rest/api/3/search/jql` 游标分页、无 total）：key/url/summary/status/type/labels/updated/assignee；limit 默认 20、上限 100 |
| `jira_issue_comment` | 评论回写：纯文本→ADF；`traceId` 提供时按 `AOS-TRACE:` 页脚 marker 幂等（存在则更新，否则新建）并 best-effort 写评论属性；`dryRun` 预览 |
| `jira_issue_attach` | 附件回写：项目根内路径；multipart（`X-Atlassian-Token: no-check`）；确定性命名 `<basename>-<sha8><ext>`，同名同大小去重；上限=站点 meta 与 `AOS_JIRA_ATTACH_MAX_MB`（默认 20）取小，超限 warning 跳过；`dryRun` 预览 |
| `jira_evidence_post` | 失败证据 composite：聚合失败步骤截图 + 设计差异标注图（annotated.png 优先）+ 失败清单 + 失败域（确定性分类）+ 崩溃签名摘要 → 中文评论（traceId 幂等回写）+ 附件（≤6，去重上传）；`platform`/`deviceSerial` 覆盖或推断（推断不出记 unknown）；`dryRun` 不触网 |
| `run_regression` | 回归一条龙：Excel 测试文档（`excelPath`，.xlsx，首行表头「用例名/步骤」＋可选「预期/前置/模块」，合并单元格显式报错；列名可用 `columns` 覆盖）导入用例库（按模块拆集、同内容幂等复用、同名文档更新按最新份取代、`source=imported:<文件>@<sha8>` 可追溯）并执行；无文档时按 `scope`（功能/模块/用例名，归一化匹配）选库内最新份，或 `all`/缺省跑每个功能最新一份全量。前置 LLM＋在线设备先于导入/选择（needs-setup/needs-info 非错误，先问不猜）；执行前回显回归目标（功能×条数＋导入自/生成自）并写服务日志；逐集走共享批次（quarantine/批次清单/`suite_runs` 登记）后聚合（`run.gate`、`artifacts.sets[].manifestPath`） |
| `compare_design_and_device` | 组合工具：Figma 渲染图 + 真机截图 → 双图返回供多模态比对 |
| `design_device_diff` | 设计 vs 真机差异（确定性）：设计源 Figma 节点或 `.pen`（`design:{source:"pen"}`，pen CLI 渲染）+ 截图（`live` 实时，或 `step` + `traceId`（`stepNumber` 可省略→失败证据自动检索）对比失败步骤，默认 post；`device.platform:"ios"` 支持模拟器 idb/simctl 与真机 WDA）→ 对齐（insets/ignoreRegions/降采样）→ 像素差异判定 + 设计节点几何分类（missing/extra/text/asset/position-size/color）→ 差异报告 + 标注图，落盘 `.artemis/design/diffs/<node>-<时间戳>/`；**区域核验（放大核验，默认开启）**：区域提议（节点∪diff／tiles／显式）→ 设备原生栅格成对裁剪放大 → 1:1 局部判定与对图输出（`regions`/`zoom`/`returnCrops`/`detail`；分页＝回传 `regionDetails[].bbox`；`regions:"none"` 关闭）；`dryRun` 只回计划 |
| `screen_map` | 持久屏幕映射 `.artemis/design/screen-map.json`（设计屏幕/组件 ↔ 路由/组件/文件）：`propose` 候选（confidence/unmatched）、`save` 幂等/merge、`list`；差异报告输出 `localized`；**`elements`**：元素级映射（设计运行期文本 ↔ 观察标签 + accessibilityIdentifier 建议；iOS 套件运行自动发现、`save` 人工补且 manual 优先）；条目带 `designNodeId`/归一 `bounds`（同屏重名按几何/tap 消歧，见 DESIGN §13.72），供生成步骤 `a11y:` 注记 |
| `reconciliation` | 对账资产审阅 `.artemis/design/reconciliation.json`（设计边 ↔ 真机观测/升级/审阅）：`list`（来源/命中/traces/审阅记录）、`confirm`（human-confirmed，下一次生成硬断言；幂等，记录 reviewer/时间）、`reject`（边不进生成）；未裁决不升权；iOS 套件运行自动写入观测（DESIGN §13.67/§13.68） |
| `design_to_test` | 一句话 CR 流程：前置自检→读设计→懂交互→出用例→校验→可选执行一条龙（设计来源 `figmaUrl`/`penPath` 二选一，已有 flows.json 可 `reuseExistingFlows:true`）；缺前置返回 needs-setup 结构化指引（非错误；`checks[]` 每项 missing/howTo），信息不足返回 needs-info（先问不猜）；`run` 缺省 false 止于校验、响应含 `nextAction` 指引续跑，显式 `run:true` 执行前写服务日志并回显将跑用例（数量/来源/设备，设备缺省自动盘点、多于一台先问）；可选 `maxFlows`/`maxDepth`（`maxFlows`≤1000、`maxDepth`≤50）透传生成上限/路径深度（默认 10/30；vision 全量后路径多时可调大以避免覆盖闸「路径截断」）；单步失败返回 `failedStep`/`detail`/`suggestions` |
| `verify_jira_issue` | Jira 验证一条龙：读单分档（详细单→用例库映射——LLM 只能从清单中选或答没有，库空/无匹配→「单子即用例」直跑并注明来源；粗单→needs-info 先问功能/触发条件/期望）→ 执行（前置 Jira 凭证＋LLM＋在线设备自查，先于映射；执行前回显将跑用例数量×来源×设备）→ 聚合（**任一强断言失败→FAIL**；全弱/全探索→无法判定并披露构成"弱断言仅记录路径，不代表验证通过"；quarantine 失败不计门禁）→ 回写（失败证据评论/附件幂等＋结论评论同单复用 marker `AOS-VERIFY:<单号>` 并标注自动验证；只写 `jira_issue_key` 关联、不写 verdict；`dryRun` 零写回（不产生任何外部副作用；读单/评论读取不变）＋结论预览）；`scope` 给定时覆盖映射（按关键词选用例库最新份，不调 LLM）；单步失败返回 `failedStep`/`detail`/`suggestions` |
| `project_archive` | 档案只读摘要（无参数）：项目与栈 / 设计血统（flows 来源·落盘时间·屏边数·provenance 构成）/ 用例库（每功能最新份＋导入自/生成自）/ 最近运行（近 10 批清单：gate·通过/失败计数·失败域·`unreadable` 计数）/ 裁决与 Jira 关联摘要（`jiraKeys` 独立扫全部 cases，含 `verify_jira_issue` 的自动关联）/ 前置状态（figma/pen/jira/llm 静态就绪＋masked＋「未复核」）。**只读铁律**：不触网、无子进程、不写盘；PG 不可用（内存 store）/flows.json 坏/清单坏件 → `degraded[]` 如实标注，恒 `ok:true` |
| `figma_extract_flows` | 解析 Figma 原型交互 → 流程图（screens/edges/entryScreens，支持连续动作与 BACK），落盘 `.artemis/design/flows.json` + **`flow-map.md`**（**v2**：screens/edges 携带来源 `explicit`/置信度、文本类别；`Flow/AC*`/`AC:` 验收标注 → `screens[].acceptance`；`no-interactions` 告警见下）；**屏幕截图**：`screens` 默认开——一次批量渲染各屏嵌入流程地图（`.artemis/design/screens/figma-<fileKey>/`，scale=1；单屏 null 有界重试一次后逐屏降级 `screenshot-skipped`/`screenshot-render-unavailable` 不阻断；`AOS_SCREENS=0` 关闭） |
| `figma_gap_analysis` | 缺口分析：设计资源/色板 vs 项目现有资产/ tokens 文件，落盘 `.artemis/design/gaps.json` |
| `figma_generate_tests` | 流程 → 测试用例：flows.json（或现场 URL）→ `tests.json` + `tests.md` + `tests.xlsx`（可用 `excelPath`/`excelTemplate` 定制 Excel 输出与模版；默认 14 列：原 6 列 + 用例编号/模块/Section/测试数据/关联用例/预期结果/设计引用/备注待确认，另出「汇总」sheet；`acceptance.json` 可给 `data`/`questions`/`section`，taskDesc 增【测试数据】【待确认】），内含可直接传给 `mobile_run_task` 的任务描述；响应含 `coverage` 完整度报告（**硬/探索分离**：`complete` 只按硬覆盖判定，inferred 边不虚高门禁，`explore` 仅报告），`requireFullCoverage:true` 时硬覆盖不完整即报错不落盘；**自动消费对账资产**（`.artemis/design/reconciliation.json` 中已被真机观测走通并升级的边，直接生成硬断言，响应 `reconciliation.upgradedEdges`）；长流程超 `maxDepth` 按续段拆分（`continuation/startScreen/prelude`，续段自带前导导航可独立执行）；每步断言与起始屏以 `【AOS-EXPECT】` 块随 taskDesc 输出，iOS 执行器逐步核对并汇总 `adherence` 与 `preflight`；每步 expectations 携带来源/置信度（旧 flows.json 缺字段保守归一 `legacy-unknown`）；断言候选只消费运行期文本与验收口径（设计批注/图层名不进断言——`Flow/AC*`/`AC:` 口径经 `acceptance` 字段进入，详见 DESIGN §13.70）；推断/legacy 边生成**探索步骤**（`kind=explore`：可执行、不断言、不参与 PASS/FAIL）；步骤元素注记可带 `a11y:` 标识建议（来自 screen-map `elements`）；assert 期望优先取验收口径（`hintsSource:"acceptance"`；`.artemis/design/acceptance.json` 人工确认覆盖优先），无口径回退运行期文本（`hintsSource:"runtime-text"`）；**tests.md 截图**：`screens` 默认开——按 flows 来源自动分派 figma/pen 渲染通道，每用例 ≤3 张缩略图（落 `.artemis/design/screens/figma-<fileKey>|pen-<名>/`），映射缺失/渲染失败降级 `screenshot-mapping-missing`/`screenshot-skipped`/`screenshot-render-unavailable` 不阻断；`AOS_SCREENS=0` 关闭；**用例集归档（回归服务 P1a）**：生成时按功能切份（页面 → 屏幕名前缀 → 连通分量 → 单组回退；功能名由 MCP 生成：候选名 → LLM → `功能N`），每份三件套归档 `.artemis/design/case-sets/<UTC YYYYMMDD_HHmmss>_<功能名>.{json,md,xlsx}`（响应 `savedTo.caseSets`；live 三件套契约不变）；用例带 `feature`、响应含 `features[]`；用例集登记入库（身份跨生成按屏幕重叠继承；store 不可用/登记失败如实告警不阻断） |
| `figma_import_assets` | 资源导入：按 gaps.json 从 Figma 导出缺失资源，按技术栈命名/目录幂等写入（dryRun 可预览）；PNG 默认按栈倍率集导出（Android `drawable-xhdpi/-xxhdpi`、Flutter `2.0x/3.0x`、iOS `.imageset`+Contents.json、RN `@2x/@3x`；`densities:false` 回退单文件 @2x）；**唯一性**：内容 sha256 去重（批次内 + 项目资产索引，重复项记 `duplicate_of`） |
| `figma_export_brief` | 构建简报：tokens/路由/组件变体/流程概览/缺口/栈约定 + **a11y 标识建议**（screen-map elements） → `build-brief.{json,md}`；`scaffold` 可选按栈生成组件骨架（幂等） |
| `figma_import_tokens` | 颜色 token 导入：Figma 颜色（含 alpha）→ `.artemis/design/tokens.json`（DTCG，modes 预留）+ 栈 token 文件（Android/Flutter/RN/Web）；裸色扫描 + enforcement；人工命名 `token-names.json` |
| `figma_import_strings` | 文案 i18n 导入：Figma 文本 → 冻结 key（改名不改 key）→ `.artemis/design/strings.json` + 资源文件（Android `strings.xml` / Flutter `arb` / RN·Web JSON / iOS `.strings`+`.stringsdict`）；复用/迁移/source_changed/unused/硬编码扫描；conflict 经 `resolutions.json` 闭环；复数经 `string-context.json` 人工确认（Android `<plurals>`、Flutter/RN/Web ICU、iOS `.stringsdict`） |
| `pen_inspect` | pen.dev 离线检查：解析 `.pen`（开放 JSON，支持注释）→ 结构校验（id 唯一/无斜杠、ref 与 `$变量` 可解析）+ 摘要（屏幕/组件/实例/文案/变量与主题/图片资产与缺失）；无账号/网络需求；`save:true` 落盘 `.artemis/design/pen/summary.json` |
| `pen_extract_flows` | pen 流程合成：检测交互线索（`.pen` v2.20 无原型交互字段；text `href`/交互类键/metadata 线索）——无线索按「Flow 标注 > 屏内首个文本 > 图层名」命名屏幕、按标签前缀归并状态变体、按画板顺序/排布推断跳转（`INFERRED`，需复核）；有线索显式标注 `pen-interactions-present`（未解析，不静默）；**可选视觉识别**（`vision`：`auto` 默认 / `true` / `false`，ADR-0010）——能力判定＝**声明**（`AOS_LLM_VISION=1\|0`）→ **探测缓存**（`.artemis/llm-capabilities.json`；`AOS_VISION_CACHE_DAYS` 默认 7 天、`0` 关闭）→ 名字启发式 → **未知即尝试**（被「不支持图片」拒绝则记录并跳过；`vision:true` 始终强制）；渲染每屏识别交互元素（受控类别/意图 + bbox → nodeId grounding），产出元素清单（`vision-inferred`/low）与未决目的地（`to:null`）探索边，不可用显式降级警告（`vision-unavailable`/`vision-render-unavailable`/`vision-call-failed`/`vision-model-rejected`/…）不阻断；**主屏与状态变体都参与视觉识别**（主屏在前、变体在后，变体带 `stateOf`/`stateName`），变体元素/边只作审计（`screens[].states[].elements`、`counts.visionStateEdges`/`visionStateElements`，不并入生成边）；**候选四态覆盖**（`covered`/`uncovered`/`unverifiable`/`not-evaluated`）按词表核验设计候选交互元素（英文＋中文词表，`AOS_VISION_CANDIDATE_TOKENS=词1,词2` 可追加；`ref`/`reusable` 组件实例自动入候选，嵌套只留最外层），逐屏输出 `elementsCoverage` 与告警（`vision-candidate-uncovered`/`vision-candidate-unverifiable`/`vision-candidate-vocabulary-unmatched`），flow-map 每屏/每变体附覆盖摘要（含未评估原因）；截断不再静默——回复元素 >40 条 `vision-response-truncated`、候选 >200 `vision-candidate-cap`、target 数超上限 `vision-screen-cap`（逐 target 具名、先裁变体），守恒不平出 `vision-accounting-mismatch`（七个公式，见 DESIGN §13.133）；`AOS_VISION=0` 关闭、`AOS_VISION_MAX_TARGETS` 默认 50（旧名 `AOS_VISION_MAX_SCREENS` 兼容；`0`/`all`/`unlimited` 不限；屏幕尺寸缺失时取渲染图 IHDR，无几何无渲染的屏以 `vision-screen-no-geometry` 显式列出） → `flows.json`（**v3**：screens/edges 置来源 + `screens[].elements`/`elementsCoverage` + `states[]` + `vision.accounting`；可直接供 `figma_generate_tests`/`suite check`）+ `flow-map.md`（**屏幕截图**：`screens` 默认开，渲染主屏与变体（变体供 vision/截图会计，只嵌入主屏）落 `.artemis/design/screens/pen-<名>/`，与 vision 共享一次渲染；`AOS_SCREENS=0` 关闭，`screenshot-skipped`/`screenshot-render-unavailable` 降级不阻断，`screenshots.accounting` 校验 `screens+states=rendered+skipped`）；返回碎片度/视觉统计、`vision.accounting` 与 warnings |
| `pen_import_tokens` | pen 颜色变量 → `.artemis/design/tokens.json`（DTCG；变量名即 token，modes 记录主题取值，`$别名` → aliasOf）+ 栈 token 文件（new/updated/unchanged/unused、裸色扫描、enforcement）；完全离线 |
| `pen_import_strings` | pen 文案 → `.artemis/design/strings.json` + 资源文件（Android/Flutter/RN/Web/iOS；冻结 key、冲突经 `resolutions.json`、source_changed/unused/硬编码扫描；复数同 Figma 侧经 `string-context.json`）；完全离线 |
| `pen_export_brief` | pen 构建简报：颜色/字阶/间距/圆角/阴影、屏幕与建议路由、可复用组件、按栈约定、**a11y 标识建议** → `build-brief.{json,md}`；`scaffold` 可选生成组件骨架；完全离线 |
| `pen_export` | headless CLI 渲染导出：`.pen` → PNG/JPEG/WEBP/PDF（默认 `.artemis/design/pen/`；`dryRun` 看命令）；pen CLI 缺失时自动安装，需已登录 |
| `pen_import_assets` | 资源导入（CLI，需登录）：`.pen` 节点 `ids` → 位图（单会话按倍率批量导出）→ 按栈命名/倍率集幂等写入（与 `figma_import_assets` 同一写盘/去重管线：路径幂等 + sha256 去重 + `duplicate_of`；`densities:false` 回退单 @2x）；产物以 CLI `Exported` 路径对账，缺产物记 `export-no-output`；报告 `.artemis/design/import-report.pen.json`（`schemaVersion`/`penCliVersion`/`vector:"unsupported"`，与 Figma 报告独立）；`dryRun` 仍渲染以获得去重结果 |
| `pen_apply_tokens` | CLI 写回：`tokens.json`（含 modes 主题）→ `.pen` `SetVariables`；**原位更新**（临时文件→回读校验→原子替换，失败不动原文件），`out` 可另存 |
| `pen_apply_strings` | CLI 写回：`strings.json` 的 nodeId→sourceText → `.pen` 文本节点；原位更新与校验语义同上；nodeId 缺失记 `notFound` |
| `pen_agent` | agent 生成/修改设计：prompt → `.pen`（默认原位安全更新；`out` 新建/另存；`exportPath` 顺带出图）；凭证复用 active LLM（不落日志）并自动桥接 Anthropic 端点：DeepSeek（已实测）、Kimi/Z.AI/百炼（Bearer+模型 env，待冒烟）；其他 provider 可 `anthropicBaseUrl` 指定 |
| `mobile_*`（5） | 代理 artemis（schema 原样透传）；`mobile_run_task` 在 setup 未完成时返回结构化 `setup_required`；`device_serial` 为 iOS UDID（模拟器或真机）时由 AOS 接管：`mobile_run_task` 走内置观察-动作执行器（active LLM，无唤醒需轮询 `mobile_manage_task`；默认每步视觉输入——多模态主模型直附图、文本主模型视觉感知融合补充元素；完成时终态验证；失败采集设备日志；开关与降级见「iOS 真机」节），`mobile_manage_task`/`mobile_inspect_trace`（view_summary/view_step_details/view_step_screenshots/search）/`mobile_get_device_state` 均按 UDID 或 iOS trace id 路由；其余仍走 ARTEMIS/adb |
| Figma 20 | `get_current_selection` … `export_image`（内嵌 dcb，zod 校验）；插件模式走本地桥（锁定 3055，CORS 白名单），REST 模式需 token（缺失时引导 `aos_configure`） |

`run_regression` / `verify_jira_issue` / `design_to_test` 支持 `async:true`：立即返回 `jobId`，后台执行；用 `aos_job_status` 查询（进度事件 `run.started`/`run.finished`，结果落 `.artemis/jobs/<jobId>.json`）。缺省同步执行，行为不变。

## 产物路径（项目内）

接入项目的运行产物默认都落在项目目录内（`<项目>/.artemis/`），artemis 仓库不再承载新产物：

| 内容 | 路径 |
|------|------|
| 任务轨迹（步骤截图 / notes / stdout / stderr / `data_engine.db`） | `.artemis/traces/`（环境变量 `ARTEMIS_TRACES_DIR` 可覆盖，相对路径按项目根解析） |
| 实时真机截图 | `.artemis/traces/live_screenshots/`（上游在 artemis 仓库根另存一份，AOS 自动镜像；`mobile_get_device_state` 响应不变；iOS 模拟器由 AOS 直写该目录，`.png`） |
| 设计 vs 真机差异 | `.artemis/design/diffs/<node>-<时间戳>/`（report.json / annotated.png / design.png / device.png） |
| 崩溃取证 | `.artemis/crashes/`（Android：crash buffer；iOS trace：宿主机 `~/Library/Logs/DiagnosticReports/*.ips` 按任务窗口采集，`aos_crashes` 的 kind=`ios`） |
| 测试文档（flows / gaps / tests.{json,md,xlsx} / build-brief 等设计产物） | `.artemis/design/` |
| 服务日志 | `.artemis/logs/mobile-testing-mcp.log`、`artemis-child.log` |

**存储回流**：配置 `MOBILE_TESTING_DATABASE_URL` 后，服务启动会自动把当前项目 `.artemis/ledger/usage.jsonl`、`state.json` 与 `.artemis/design/{runs,case-sets}` 中的历史记录幂等补进中心 PG（成功后写 `.artemis/ledger/.pg-sync.json` 签名，未变化跳过；`AOS_LEDGER_AUTO_IMPORT=0` 关闭）。未配置 PG 时继续使用项目文件台账，不丢记录。

**项目显示名**：`aos.config.jsonc` 可写 `"project": { "name": "mobile-testing" }`；缺省仍用目录 basename。台账、面板与 `aos_status.project.name` 使用该名称。

## PostgreSQL 数据模型（v1）

`projects`（root_path 唯一 / figma_token）、`project_llms`（name/base_url/model/api_key/is_active，应用层保证单 active）、`task_stats`（case/trace/model/profile/status/时间）、`llm_model_cache`（厂商模型列表缓存：cache_key/base_url/models/fetched_at/last_error）。详见 DESIGN.md §4.5。

## 仓库布局

```
AOS-ARTEMIS/
├── src/ test/            # mobile-testing-mcp 服务（本仓库）
├── artemis/              # git submodule → github.com/google/artemis（Python 子进程依赖）
├── design-context-bridge/# git submodule → github.com/CristinaFores/design-context-bridge（vendor 参照）
└── aos.config.jsonc      # 项目配置（无密钥）
```

克隆：`git clone --recurse-submodules https://github.com/louislucney/AOS-Artemis.git`
（已 clone 过的补齐：`git submodule update --init --recursive`）

## 运行时副本说明

系统里曾有一份独立的 artemis **运行时安装** `/Users/louis/artemis`（旧 daemon :8000、旧 mcp_server 挂载）。迁移已完成、该目录已移除（2026-10-08）；统一服务现在只使用工作区副本 `./artemis`（自持 venv：`cd artemis && uv sync` 或依赖包机制）。

## 开发

```bash
npm run build       # tsc
npm test            # build + node:test（全量用例；配置/扫描/存储[pg-mem]/代理/工具/设计流水线/协议冒烟）
npm run test:file -- test/figma.test.js   # 单文件（先构建，不会跑旧 dist）
npm run test:name -- "<pattern>"          # 按名称过滤（先构建）
npm run test:coverage                     # Node 内置覆盖率，无第三方依赖
npm run lint        # eslint
node dist/cli.js serve   # 直接以 stdio 跑 MCP server
```

## 许可

- 本仓库：MIT
- 内嵌的 design-context-bridge 代码：MIT，见 `src/vendor/design-context-bridge/LICENSE` 与 `NOTICE`（修改点：store 前缀命名空间化、桥 CORS/EADDRINUSE 策略、token 引导文案）
- artemis：仅以子进程方式调用（Apache-2.0），不内嵌其代码
