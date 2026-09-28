# AOS MCP

容器化 **AOS × ARTEMIS 合并 MCP 服务**：Figma 设计上下文（[design-context-bridge](https://github.com/CristinaFores/design-context-bridge)，MIT）+ ARTEMIS 真机自动化（[google/artemis](https://github.com/google/artemis)，Apache-2.0）+ **项目级 LLM 关联与切换（PostgreSQL）**。

> 设计文档（架构/评审/数据模型）：[DESIGN.md](./DESIGN.md)

## 核心模型（v0.3）

- **项目自带凭证**：每个项目在自己的 `.env` 声明 LLM（OpenAI 兼容三元组）与可选 Figma token；key 的支付方即项目方。
- **首次启用首扫导入**：服务扫描项目 `.env` → 导入 PostgreSQL（多条目 + active 指针）；缺失则返回 `setup_required`，用 `aos_configure` 工具补全。
- **全 OpenAI 兼容**：artemis 侧统一 `custom` provider（`OPENAI_BASE_URL` + `OPENAI_API_KEY` + model，参考 DeepSeek）。
- **Figma 可选**：token 存在则读（PG/.env），不存在忽略；REST 工具缺 token 时提示。

## 容器部署（推荐给多项目团队）

```bash
# 1) 构建并常驻（挂载公司工作区；PG 连接串经环境注入）
AOS_WORKSPACE=/srv/projects AOS_DATABASE_URL=postgres://... docker compose up -d --build

# 2) 为每个项目生成客户端配置（docker 模式）
node dist/cli.js install --project /srv/projects/<project> --mode docker

# 3) 客户端（opencode/Claude Code/Cursor/VS Code）重载后即用：
#    docker exec -i -w /workspace/<project> aos-mcp node /app/dist/index.js
```

镜像内含 Node 22 + Python 3.12（artemis venv）+ adb/ffmpeg；Figma 桥发布在宿主机 `127.0.0.1:3055`；
Android 设备走 USB 透传（Linux 主机，见 compose 注释）或网络 ADB（`ADB_HOST/ADB_PORT`，默认连宿主 adb server）。

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

> **Windows 说明**：用 `node dist/cli.js deps build` 在 Windows 机器上构建 Windows 包（uv 安装：`winget install --id astral-sh.uv`；解压用系统内置 `tar`，Win10 1803+ 自带；包为 `.tar.gz` 格式）。Docker Desktop（WSL2）里跑容器时用 Linux 包。服务本体与 artemis 均支持 Windows；仅"孤儿进程清理检查"目前为 POSIX-only（不影响任务执行）。

**更新语义**（回答"artemis 更新了怎么办"）：

- **仅代码更新**（`uv.lock` 未变）：venv 只存依赖、代码始终从仓库读取 → 直接生效，无需操作。
- **依赖也更新**（`uv.lock` 变化）：venv 内的版本标记（`artemis/.venv/.aos-deps.json`，记录 lock 哈希）会让服务检测到"依赖已过期"并自动更新：
  1. 若你已**重建并发布**新依赖包 → 命中后**离线更新**；
  2. 若依赖包还是旧的 → 自动回退在线 `uv sync`，并提示"请重建依赖包"；
  3. 离线环境可设 `AOS_DEPS_NO_ONLINE=1` 禁止在线回退（强制刷新依赖包，否则明确失败）。
- 包按平台构建：Mac 用 `darwin-arm64`，容器/CI 用对应 Linux 包（`scripts/artemis-deps.sh build` 在目标平台或容器内运行）。

## 日志与故障定位

**日志位置**

| 来源 | 位置 |
|------|------|
| 服务日志（启停/依赖/桥/每次工具调用审计） | `<项目>/.artemis/logs/aos-mcp.log`（`aos_status.logs.file` 直接返回路径；容器内同路径、随工作区挂载可见；`AOS_LOG_DIR` 可改） |
| artemis 网关子进程 stderr | `<项目>/.artemis/logs/artemis-child.log`（进程退出也不丢） |
| HTTP/常驻模式 | 同上 + `docker logs aos-mcp`（stderr 同步输出） |
| artemis 任务明细（最细粒度） | `artemis/traces/<trace_id>/stdout.log` / `stderr.log` |
| 客户端侧（stdio） | 服务 stderr 同时被 opencode / Claude Code 捕获进各自 MCP 日志 |

每条工具调用都有审计行，例如：`2026-09-28T15:20:11.123Z INFO  [aos-mcp] tool=mobile_run_task ok=true ms=87`（失败时附错误摘要，级别 WARN）。

**按症状定位**

| 症状 | 排查路径 |
|------|----------|
| 工具列表少了 5 个 `mobile_*` / 提示"artemis 子进程未就绪" | `aos-mcp.log` 的 `依赖状态` 行 → `doctor` → `mobile_diagnose` |
| 任务失败 | `aos_tasks` 取 `trace_id` → `artemis/traces/<trace_id>/stderr.log` 尾部 + `mobile_inspect_trace(view_step_details)`；`mobile_diagnose` 会直接给出 `logs.last_failed_task.recent_errors` |
| LLM 401/超时/余额 | `llm_list` 看 active 与 key 来源；`artemis-child.log` 与任务 stderr 中的 provider 报错 |
| Figma 桥不通 | `aos-mcp.log` 的 `[bridge]` 行 + `aos_status.figma.bridge` / `GET /healthz` |
| MCP 连不上 / 服务秒退 | `aos-mcp.log` 末尾（`uncaughtException` 堆栈会落盘；初始化失败也落盘） |

**日志配置**：`AOS_LOG_LEVEL=debug|info|warn|error`（默认 info）、`AOS_LOG_DIR`（改目录）、`AOS_LOG_DISABLE_FILE=1`（关闭文件输出）、`AOS_LOG_MAX_MB`（轮转阈值，默认 5MB，保留 `.1` 备份）。

## 本地开发数据库（PostgreSQL）

专用本地实例（Docker，loopback 5433；**不影响**本机 5432 上其他应用的库）：

```bash
docker compose --profile local-db up -d postgres
# 连接串：postgres://aos:aos_local_dev@127.0.0.1:5433/aos

export AOS_DATABASE_URL='postgres://aos:aos_local_dev@127.0.0.1:5433/aos'
node dist/cli.js doctor     # 应显示 "✓ PostgreSQL 连接正常"

# 挂载 MCP 客户端时把该变量带进客户端配置：
AOS_DATABASE_URL='postgres://aos:aos_local_dev@127.0.0.1:5433/aos' node dist/cli.js install --mode local
```

数据落在卷 `aos-postgres-data`；重置：`docker exec aos-postgres psql -U aos -d aos -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`。
切换到公司 PG 时只需替换 `AOS_DATABASE_URL`（表结构首次连接自动创建）。

## HTTP 模式（远程/多项目）

```bash
# 服务端（容器或主机；workspace 下每个子目录是一个项目）
node dist/cli.js serve --http --port 8765 --workspace /srv/projects
# 端点: POST http://<host>:8765/mcp/<project>    健康检查: GET /healthz

# 客户端配置（或 aos-mcp install --mode http --url http://host:8765）
```

无状态 streamable-HTTP：每个项目独立 Runtime（LLM 关联 / artemis 子进程 / 任务统计）；项目名限 `[A-Za-z0-9._-]`。stdio 与 HTTP 两种入口共用同一套工具。

## 任务统计与组合工具

- `aos_tasks`：列出本项目 `mobile_run_task` 记录（trace/状态/模型/时间），默认先向 artemis 同步完成态；后台每 30s 自动同步。
- `compare_design_and_device`：一次调用返回 **Figma 节点渲染图（PNG@2x）+ 当前真机截图**（MCP image content），交给多模态模型比对布局/间距/颜色/文案。

### 设计 → 测试流水线（Figma → 真机）

```
figma_extract_flows(url)     # 交互流程 → .artemis/design/flows.json
figma_gap_analysis(url)      # 资源缺口 → .artemis/design/gaps.json
figma_generate_tests(url)    # 流程 → .artemis/design/tests.{json,md}（含 taskDesc）
figma_import_assets()        # 缺失资源 → 按栈命名/目录写入（import-report.json；dryRun 预览）
figma_export_brief(url)      # 编码事实包 → build-brief.{json,md}（tokens/组件/约定；scaffold 可出骨架）
# 执行：mobile_run_task(task_desc = tests.json 中 flows[i].taskDesc)
# 视觉断言：compare_design_and_device（失败步骤截图 vs Figma 渲染图）
```

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
node dist/cli.js install --mode docker --container aos-mcp
node dist/cli.js install --mode http --url http://10.0.0.5:8765
node dist/cli.js install --targets claude,cursor,opencode,vscode --force
```

写入：`.mcp.json`（Claude Code）、`.cursor/mcp.json`、`.vscode/mcp.json`、`opencode.json`（保留注释与其他 server；冲突需 `--force`）；Codex/Claude Desktop/Windsurf 打印手动片段。

## 真机 E2E 验收

```bash
node scripts/e2e-device.mjs "Open Settings and report the battery level"
# 0=completed 1=failed 2=setup_required 3=infra；前置：uv sync + .env + 已授权设备
```

## 状态

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M0 | 脚手架 / 配置加载 / init / doctor | ✅ |
| M1 | artemis 代理 + 透传/env 装配 + 退出钩子 | ✅ |
| M1.5 | PG 存储 + .env 首扫导入 + `aos_configure` + 多条目切换 + 任务统计 | ✅ |
| M2 | Figma 20 工具内嵌（zod）+ 桥安全补丁 + token 引导 | ✅ |
| M3 | 容器化（Dockerfile/compose）+ `aos-mcp install` + 真机 E2E 脚本 | ✅ |
| M4 | HTTP 传输（`/mcp/<project>`）+ 任务完成态同步（`aos_tasks`）+ 组合工具（设计 vs 真机） | ✅ |

## 快速开始

```bash
npm install && npm run build

# 1) 项目 .env（服务首次启用时扫描导入；也可稍后用 aos_configure 工具写入）
cp .env.example .env    # 填 AOS_LLM_MODEL / AOS_LLM_BASE_URL / AOS_LLM_API_KEY（Figma token 可选）

# 2) 体检
node dist/cli.js doctor

# 3) 在 MCP 客户端挂载（stdio；容器内同理）
#    command: node
#    args:    ["<service>/dist/index.js"]
#    env:     { "AOS_PROJECT_DIR": "/workspace/<project>",
#               "AOS_DATABASE_URL": "postgres://user:pass@host:5432/aos" }
```

未配置 `AOS_DATABASE_URL` 时降级为会话内存存储（`aos_status` 会警告）。

## 工具

| 工具 | 说明 |
|------|------|
| `llm_list` | 项目全部 LLM 条目（store/config/env 来源）+ active + masked key + `setupRequired` |
| `llm_switch` | 切换 active（PG 持久化）；模型下个任务生效；key/base_url 变更重启网关（任务守卫，`force: true` 跳过） |
| `aos_configure` | 写入/更新 LLM 三元组（→ PG + 项目 `.env`）并激活；setup 引导入口 |
| `aos_status` | 项目注册信息、存储状态、active、子进程（pid/stderr 尾部）、Figma 就绪性 |
| `aos_tasks` | 任务/调用统计（trace/状态/模型），含完成态同步 |
| `compare_design_and_device` | 组合工具：Figma 渲染图 + 真机截图 → 双图返回供多模态比对 |
| `figma_extract_flows` | 解析 Figma 原型交互 → 流程图（screens/edges/entryScreens，支持连续动作与 BACK），落盘 `.artemis/design/flows.json` |
| `figma_gap_analysis` | 缺口分析：设计资源/色板 vs 项目现有资产/ tokens 文件，落盘 `.artemis/design/gaps.json` |
| `figma_generate_tests` | 流程 → 测试用例：flows.json（或现场 URL）→ `tests.json` + `tests.md`，内含可直接传给 `mobile_run_task` 的任务描述 |
| `figma_import_assets` | 资源导入：按 gaps.json 从 Figma 导出缺失资源，按技术栈命名/目录幂等写入（dryRun 可预览），落盘 `import-report.json` |
| `figma_export_brief` | 构建简报：tokens/路由/组件变体/流程概览/缺口/栈约定 → `build-brief.{json,md}`；`scaffold` 可选按栈生成组件骨架（幂等） |
| `mobile_*`（5） | 代理 artemis（schema 原样透传）；`mobile_run_task` 在 setup 未完成时返回结构化 `setup_required` |
| Figma 20 | `get_current_selection` … `export_image`（内嵌 dcb，zod 校验）；插件模式走本地桥（锁定 3055，CORS 白名单），REST 模式需 token（缺失时引导 `aos_configure`） |

## PostgreSQL 数据模型（v1）

`projects`（root_path 唯一 / figma_token）、`project_llms`（name/base_url/model/api_key/is_active，应用层保证单 active）、`task_stats`（trace/model/status/时间）。详见 DESIGN.md §4.5。

## 仓库布局

```
AOS-ARTEMIS/
├── src/ test/            # aos-mcp 服务（本仓库）
├── artemis/              # git submodule → github.com/google/artemis（Python 子进程依赖）
├── design-context-bridge/# git submodule → github.com/CristinaFores/design-context-bridge（vendor 参照）
└── aos.config.jsonc      # 项目配置（无密钥）
```

克隆：`git clone --recurse-submodules https://github.com/louislucney/AOS-Artemis.git`
（已 clone 过的补齐：`git submodule update --init --recursive`）

## 运行时副本说明（重要）

系统里另有一份 artemis **运行时安装** `/Users/louis/artemis`（含 `.venv`、daemon（:8000）、IDE 已挂载的 mcp_server、本地配置与 `.env`）。统一服务当前使用工作区副本 `./artemis`，两份互不影响。

- 迁移完成前：`cd artemis && uv sync` 让工作区副本自持 venv。
- 迁移时（准备好后）：停止旧 daemon 与旧 mcp_server → 更新 IDE 的 MCP 配置指向 `aos-mcp`（注入 `AOS_PROJECT_DIR` / `AOS_DATABASE_URL`）→ 旧目录归档。

## 开发

```bash
npm run build       # tsc
npm test            # build + node:test（56 个测试：配置/扫描/存储[pg-mem]/代理/工具/协议冒烟）
npm run lint        # eslint
node dist/cli.js serve   # 直接以 stdio 跑 MCP server
```

## 许可

- 本仓库：MIT
- 内嵌的 design-context-bridge 代码：MIT，见 `src/vendor/design-context-bridge/LICENSE` 与 `NOTICE`（修改点：store 前缀命名空间化、桥 CORS/EADDRINUSE 策略、token 引导文案）
- artemis：仅以子进程方式调用（Apache-2.0），不内嵌其代码
