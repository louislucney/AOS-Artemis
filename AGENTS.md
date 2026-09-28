# AGENTS.md — AOS-ARTEMIS

AOS × ARTEMIS 合并 MCP 服务：Figma 设计上下文（内嵌 design-context-bridge）+ ARTEMIS 真机自动化（Python 子进程）+ 项目级 LLM 关联与切换（PostgreSQL）。里程碑 M0–M4 已完成。

## 完工标准

每次改动以达到以下三项为准：

1. `npm run build && npm test && npm run lint` **全绿**（79+ 测试）；
2. 行为/接口变更同步更新 `DESIGN.md`（架构与决策的唯一事实源），用法变更同步 `README.md`；
3. 测试不依赖真实 PG / 设备 / 外网（SQL 用 `pg-mem`，artemis 用假子进程，Figma REST 不打网）。

## 仓库结构与边界

- `src/` — 本服务源码（TypeScript，ESM + NodeNext + strict；相对导入一律带 `.js` 后缀）。
- `src/vendor/design-context-bridge/` — 内嵌的 MIT 上游代码。可打补丁，但每处补丁必须带 `PATCH (aos-mcp)` 注释并同步更新同目录 `NOTICE`；lint 已忽略该目录。
- `artemis/`、`design-context-bridge/` — **git submodule**（上游 `google/artemis`、`CristinaFores/design-context-bridge`）。克隆需 `git clone --recurse-submodules` 或事后 `git submodule update --init --recursive`。`artemis` 仅作为 Python 子进程依赖（`python -m mcp_server`），避免不必要的改动；其 venv 由 `doctor --install-deps`/依赖包机制处理（或 `cd artemis && uv sync`）。
- `.artemis/`（生成的 override 与 state）、`dist/`（构建产物）。

## 常用命令

| 目的 | 命令 |
|------|------|
| 构建 | `npm run build` |
| 全量测试 | `npm test`（先构建，再 `node --test test/*.test.js`） |
| 单文件测试 | `npm run build && node --test test/figma.test.js` |
| Lint | `npm run lint` |
| 体检 | `node dist/cli.js doctor` |
| 挂载客户端 | `node dist/cli.js install [--mode local\|docker\|http] [--force]` |
| stdio 服务 | `node dist/cli.js serve` |
| HTTP 服务 | `node dist/cli.js serve --http --port 8765 --workspace <dir>`（端点 `POST /mcp/<project>`，健康检查 `GET /healthz`） |
| 本地 PG | `docker compose --profile local-db up -d postgres` → `AOS_DATABASE_URL=postgres://aos:aos_local_dev@127.0.0.1:5433/aos` |
| 构建依赖包 | `node dist/cli.js deps build`（跨平台）；macOS/Linux 亦可用 `./scripts/artemis-deps.sh build`（可 `--skip-sync` 复用缓存） |
| 安装/更新依赖 | `node dist/cli.js doctor --install-deps`（serve 首次运行自动执行） |
| 镜像 | `docker build -t aos-mcp:local .` |
| 真机验收（手动） | `node scripts/e2e-device.mjs "…"`（需 artemis venv + 已授权设备） |

## 硬性约定

- **stdout 属于 MCP stdio 协议**：日志走 `log()`（stderr）；CLI 子命令（init/doctor/install）的输出除外。
- **mobile_* 工具 schema 原样透传**：`ListTools`/`CallTool` 不做 zod 镜像、不改字段（`conversation_id` 等影响唤醒路由）；新增原生工具一律用 zod。
- 密钥只存项目 `.env`（或按产品要求在 PostgreSQL）；工具响应只回 masked 预览（`maskSecret`）；日志不落 key。
- 用户可见文案与文档用中文；代码标识符用英文。代码不加注释，除非补丁标记（`PATCH (aos-mcp)`）。
- 测试跑的是 `dist/`：改动后先 `npm run build` 再 `node --test`。

## 关键机制速查

- **项目身份**：`AOS_PROJECT_DIR` → 向上查找 `aos.config.jsonc` → 回退 cwd（`src/config/loader.ts`）。
- **LLM 首扫导入**：`AOS_LLM_*` 优先，兼容 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`（`src/projects/scan.ts`）；缺项 → `setup_required`，由 `aos_configure` 补全（写 PG + 项目 `.env`）。
- **切换语义**：模型变更对下一个任务生效；provider/key/base_url 变更重启网关子进程（只杀直接子进程，detached 任务不动）；运行中任务由 `mobile_diagnose.tasks` 守卫，`force: true` 跳过（`src/runtime.ts`）。
- **条目优先级**：store(PG) > config（可选高级层 `aos.config.jsonc`）> env（`src/llm/registry.ts`）。
- **自动重指**：非 Google provider 自动覆盖 artemis 钉死的 `object_detector`/`hopper` 节点（附精度警告）。
- **Figma 桥**：端口锁定 3055；CORS 白名单（`null` 插件 iframe + loopback）；被占用时 `skipped_occupied` 而非文件共享（`src/vendor/design-context-bridge/figma-bridge/ws-server.ts`）。
- **双入口**：stdio 与 HTTP 共用 `createServerForRuntime()`（`src/server.ts`）；HTTP 每项目独立 Runtime（`src/http-server.ts`）。
- **任务统计**：`mobile_run_task` 成功后记录 `task_stats`；完成态由后台 30s 循环 + `aos_tasks` 轮询 `mobile_manage_task(status)` 回写。
- **日志**：`<project>/.artemis/logs/aos-mcp.log`（工具调用审计 name/ok/ms + 启停 + 崩溃堆栈）与 `artemis-child.log`（子进程 stderr 落盘）；`AOS_LOG_LEVEL/DIR`、`AOS_LOG_DISABLE_FILE=1`、`AOS_LOG_MAX_MB`（轮转）。
- **依赖更新检测**：`artemis/.venv/.aos-deps.json` 的 lock 哈希 stamp 对比 `uv.lock`；过期时 serve / `doctor --install-deps` 自动更新（依赖包 `AOS_ARTEMIS_DEPS_URL` 优先，旧包回退在线 `uv sync`；`AOS_DEPS_NO_ONLINE=1` 禁在线）。仅代码更新无需操作（venv 只装依赖，代码从仓库读取）。
- **技术栈检测**：`src/projects/stack.ts`（Flutter / React Native / 原生 Android / iOS / Web）；gap 扫描规则、定位/代码/文件命名约定按栈选择，`aos_status.stack` 可见。

## 延伸阅读（按需）

- `DESIGN.md` — 架构、评审记录、里程碑、PG 数据模型、安全与风险；改运行时/工具/存储/传输前必读。
- `README.md` — 使用方式、本地 PG、容器部署、客户端安装；回答"怎么跑/怎么装"时读。
- `src/vendor/design-context-bridge/NOTICE` — 内嵌上游代码的修改清单；动 vendor 前读。
- `.env.example`、`aos.config.jsonc` — 配置契约示例（密钥只写变量名）。
