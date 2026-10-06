# 06 — CLI `usage`（文本 / JSON / `--web`）

**What to build:** 新增 CLI 子命令 `usage`：默认输出当前项目文本摘要；`--json` 机器可读；`--all` 跨项目总览、`--project <名>` 指定项目、`--days N`（默认 7）；`usage --web [--port 8766] [--host 127.0.0.1]` 起只读看板并打印 URL（端口占用 exit 2）；`AOS_USAGE=0` 时输出/页面标注采集已关闭。`--web` 复用 Web 接缝的同一 handler。

**Blocked by:** 03, 05.

**Status:** done

- [x] `usage` 文本摘要 + `--json` + `--all`/`--project`/`--days` 全部生效
- [x] `usage --web` 起只读看板（默认 127.0.0.1）并打印 URL，端口占用 exit 2
- [x] `AOS_USAGE=0` 输出/页面标注「采集已关闭」，历史数据仍可查
- [x] 注入 io/假 store 测试，无监听泄漏

## Comments

### 2026-10-06 — 完成（ticket 06）

**新增文件**
- `src/usage-command.ts`（`runUsageCommand(argv, deps)`：文本/JSON/`--all`/`--project`/`--days` + `--web` 内嵌 node:http 只读看板；复用 ticket 05 `handleUsageRequest`、ticket 03 `usageSummary`/`usageSignals`；无注释）
- `test/usage-command.test.js`（10 个用例）

**改动文件**
- `src/cli.ts`：`usage` 子命令 dispatch（同 doctor/install/deps/suite，`process.exit(code)`）+ `printUsage` 条目。

**命令面与退出码（0 成功 / 2 参数错误与端口占用）**
- `aos-mcp usage [--json] [--all] [--project <名称|根路径>] [--days <n>]`：默认当前项目（`loadProject` 解析 `AOS_PROJECT_DIR`/向上查找 `aos.config.jsonc`）文本摘要（概览 + 工具表 top10 + 零调用 + 信号：错误类、unknown 模板聚类、warnings 码、降级、参数键）；`--json` 稳定字段 `{ok,generatedAt,days,since,usage{enabled,note},store{kind,degraded,note},projects[{name,rootPath,summary,signals}],totals{summary,signals}}`（summary/signals 即 ticket 03 原样）；`--all` 每个已注册项目 + 合计；`--project` 先根路径后名称匹配（同 ticket 05 handler），未知名 exit 2 并附已注册清单；`--all` 与 `--project` 互斥 exit 2；`--days` 缺省 7、非「≥1 整数」exit 2；`help` 输出用法 exit 0。
- `aos-mcp usage --web [--port 8766] [--host 127.0.0.1]`：CLI 进程内 node:http，GET `/usage`（HTML）/`/usage.json` 复用同一 `handleUsageRequest`（catalog=`inProcessToolCatalog()`、`storageNote`、注入 env/now），其他路径 404；stdout 打印看板 URL；默认仅 loopback、不打开浏览器；SIGINT/SIGTERM 关闭 server（`closeAllConnections`）与 store（stderr 无输出、exit 0）；EADDRINUSE → stderr 中文提示 + exit 2。
- 存储：复用 `createProjectStore(env.AOS_DATABASE_URL)`（PG / 内存降级）；内存时 note = createProjectStore reason +「独立 CLI 进程无法读取其他进程的内存事件（通常为空结果）；配置 AOS_DATABASE_URL 后可跨进程查询。」，文本/JSON/看板三处一致可见。
- `AOS_USAGE=0`：文本打印 `USAGE_DISABLED_NOTE`、JSON `usage.enabled=false` + note、看板徽标与 note；历史数据照常查询（summary 不受影响）。

**注入接缝（测试）**
- `UsageCliDeps`：`store`/`createStore`、`env`、`cwd`、`log`/`errorLog`、`now`、`catalog`、`waitForShutdown(handle)`（默认等 SIGINT/SIGTERM；测试注入后 fetch `/usage`+`/usage.json`，再 `handle.close()` 并断言端口释放/无监听泄漏）。

**验证**
- `npm run test:file -- test/usage-command.test.js`：10/10 通过
- `npm test`：609/609 通过（基线 599 + 新增 10）
- `npm run lint`：clean
- 手动冒烟：临时目录 `env -u AOS_DATABASE_URL node dist/cli.js usage --json` → exit 0、合法 JSON、`store.kind=memory` 且 note 含「独立 CLI 进程无法读取其他进程的内存事件」；`usage` / `usage --all` exit 0；`usage --web --port 8899` → `/usage.json` HTTP 200，SIGINT 后 exit 0；端口占用 → exit 2 中文提示。

**偏差与观察**
- 未改 DESIGN/README/AGENTS（按分工留给 ticket 07）。
- `--project` 同时接受根路径：与 ticket 05 handler 的解析顺序（根路径优先、名称其次）保持一致；ticket 只要求按名称。
- `--web` 默认项目由 handler 取 `listProjects()[0]`（最近 lastSeenAt），终端不重复打印项目名；可用页面项目切换或 URL `?project=` 选择（与 HTTP 挂载行为一致）。
- 零调用目录在独立 CLI 中仅含 native+figma（`inProcessToolCatalog()`，测试注入 catalog）；mobile 工具目录未在 CLI 侧触发（与 ticket 05 HTTP 挂载的已知偏差一致）。
