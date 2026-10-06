# 使用统计（usage-stats）— spec

**Status:** ready-for-agent

## Problem Statement

AOS MCP 目前只有两处可观测性：`task_stats`（仅 `mobile_run_task` 的生命周期台账）与一行纯文本审计日志。设计与迭代因此回答不了这些真实使用问题：哪些工具被用到、哪些零调用？成功率与耗时如何？错误里有多少是现有分类没覆盖的新形态？哪些真实场景在走降级/回退（视觉降级、日志降级、无损截图回退、skipped_unmanaged……）？同一工具的调用方实际传了哪些参数键？没有证据，只能靠猜，现有实现未考虑的情况不可见。

## Solution

每次**客户端发起的** MCP 工具调用（`aos_usage` 自身除外）记录一条结构化「调用事件」：按项目写入 PostgreSQL（不可用时降级进程内内存），同时日志行附 `usage=<id>` 实现双向追踪。新增三个消费面：`aos_usage` 工具（`summary` / `signals` / `events`）、`usage` CLI 子命令（文本 / JSON / `--web`）、Web 看板（HTTP 模式挂载 `/usage` 与 `/usage.json`；CLI `usage --web` 按需起只读看板）。看板与工具同一份聚合：概览、工具表（含零调用工具）、信号面板（未分类错误模板聚类、错误类分布、warnings 码、降级标记、参数键频次）、事件流水。

## User Stories

1. 作为服务开发者，我想看到每个工具的调用次数，以便知道哪些能力被真实使用。
2. 作为服务开发者，我想看到零调用工具清单（工具目录 ∩ 已见工具），以便判断某能力是否根本没人用。
3. 作为服务开发者，我想看到每个工具的成功率与 p50/p95 耗时，以便发现慢或易错的工具。
4. 作为服务开发者，我想看到错误按类分布（validation / figma / artemis / timeout / internal / unknown），以便区分使用问题与实现问题。
5. 作为服务开发者，我想看到**未分类错误（unknown）按归一化模板聚类**，以便从重复形态中发现现有代码没考虑的情况。
6. 作为服务开发者，我想看到响应 `warnings[]` 各 code 的分布（如 `param_ignored`），以便知道哪些平台差异在真实使用中触发。
7. 作为服务开发者，我想看到降级/回退标记分布（如视觉降级、日志降级、lossless 回退），以便评估降级路径的实际发生率。
8. 作为服务开发者，我想看到每个工具的参数键频次，以便发现非常规参数组合。
9. 作为服务开发者，我想按 项目 / 工具 / 状态 / 天数 筛选统计与事件流水，以便聚焦排查。
10. 作为服务开发者，我想每条事件带 `id` 且能对应到日志行（`usage=<id>`），以便从统计追到日志细节。
11. 作为服务开发者，我想事件记录失败绝不影响工具调用本身，以便统计永远不成为故障源。
12. 作为服务开发者，我想参数校验失败、未知工具名这类「调用前失败」也被记录，以便发现客户端误用。
13. 作为服务开发者，我想 `aos_usage` 自身的调用不被记录，以便统计不被自引用污染。
14. 作为服务开发者，我想在 `aos_status` 里看到统计开关与存储状态，以便知道当前是否在采集。
15. 作为服务开发者，我想通过 `AOS_USAGE=0` 关闭采集，且历史数据仍可查询，以便在敏感场景停采但保留证据。
16. 作为服务开发者，我想配置保留天数与每项目事件上限，以便控制存储增长。
17. 作为桌面开发者，我想在浏览器里看懂板（概览 / 工具表 / 信号面板 / 事件流水），以便不用写查询就能巡检。
18. 作为桌面开发者，我想在看板上切换项目，以便一本 PG 看全部项目。
19. 作为桌面开发者，我想看板显示存储徽标（PostgreSQL / 内存降级），以便理解数据为何为空或丢失。
20. 作为桌面开发者，我想用查询参数（`project/tool/status/days/refresh`）筛选与自动刷新，以便把看板当常驻面板。
21. 作为 CLI 用户，我想 `usage` 直接输出当前项目文本摘要，`--json` 输出机器可读结果，以便脚本/CI 消费。
22. 作为 CLI 用户，我想 `usage --all` 看跨项目总览、`--project` 指定项目，以便多项目巡检。
23. 作为 CLI 用户，我想 `usage --web [--port] [--host]` 起只读看板（默认 loopback，端口占用 exit 2 并提示），以便 stdio 部署也能看页面。
24. 作为运维者，我想 HTTP 模式下 `/usage` 跟随服务器绑定且可用 `AOS_USAGE_WEB=0` 单独关页面，以便容器/内网部署可控。
25. 作为服务开发者，我想统计全链路离线可测（假 PG / 内存 store / 不触网），以便 CI 稳定。
26. 作为服务开发者，我想所有行为变更同步进 DESIGN/README/AGENTS/CONTEXT，以便文档即事实源。

## Implementation Decisions

- **领域术语**（已写入 `CONTEXT.md`）：调用事件、使用统计、信号；明确与 `task_stats`（任务统计）、设计资源 `usageCount` 不同义。
- **采集面（ADR-0006）**：只采客户端发起的调用（stdio 与 HTTP 两个传输都经过同一 CallTool 包装层），不含服务内部编排调用。
- **采集点**：CallTool 包装层调用纯函数构造事件；无论工具成败、参数校验失败或未知工具名都记录；`aos_usage` 自身排除；记录/落库失败只写 warn 日志，绝不影响调用结果。
- **事件模型**：`id / project_id / at(ISO) / tool / family(native|figma|pen|mobile|unknown) / ok / duration_ms / error_class / error_summary(≤300 字符) / signals(JSON) / arg_keys(JSON 字符串数组) / trace_id?`。参数只记**键名集合**，不记任何值（隐私边界）；错误摘要截断且不含 key/凭据。
- **error_class 判据**：`validation`（zod/参数校验文案）、`figma`（Figma 限流/渲染类错误）、`artemis`（mobile 代理层错误）、`timeout`、`internal`（处理器未捕获异常）、`unknown`（兜底，是「发现未考虑情况」的主入口）。
- **signals 提取（best-effort，绝不因解析失败而失败）**：错误类本身；响应文本中可解析 JSON 的 `warnings[].code`（附 `field`）；已知降级/回退标记码（如视觉降级、日志不可用、无损截图回退、skipped_unmanaged 等，按码表匹配）；参数键集合。未知 code 原样记录——分布本身就是发现来源。
- **存储**：扩展既有 `ProjectStore`（Postgres + Memory 双实现）：记录事件、按筛选查询事件、列出已注册项目（供看板切换）、清理过期/超量事件。PG 新表 append-only；JSON 以 TEXT 存以保持 pg-mem 兼容；清理在写入时顺带执行。
- **保留与上限**：`AOS_USAGE=0` 关采集；`AOS_USAGE_RETENTION_DAYS=90`（0=不清理）；`AOS_USAGE_MAX_EVENTS=50000`（每项目上限，超出丢最旧，内存模式硬约束）。
- **聚合（纯模块，零 IO）**：`summary`（总事件数、成功率、p50/p95（有界样本）、按工具/族/天分布、零调用工具=工具目录∩已见）；`signals`（错误类分布、unknown 错误按**归一化模板**聚类——数字/路径/ID/引号内容替换为占位符、warnings 码分布、降级标记、每工具参数键频次）；`events`（筛选流水，limit ≤ 200）。
- **工具 `aos_usage`**：原生 zod 工具，action `summary|signals|events`（默认 summary），筛选 `tool/status(ok|error)/days/limit`；输出中文结构化文本，行为对齐 `aos_tasks` 风格。
- **CLI `usage`**：默认当前项目文本摘要；`--json`、`--project <名>`、`--all`、`--days N`（默认 7）；`usage --web [--port 8766] [--host 127.0.0.1]` 起只读看板并打印 URL，端口占用 exit 2；`AOS_USAGE=0` 时输出/页面显式标注「采集已关闭」但仍展示历史数据。
- **Web 看板**：零依赖服务端渲染 HTML（内联 CSS + 极少原生 JS），区块=概览（含存储徽标）/工具表（含零调用行）/信号面板/事件流水（分页+筛选）；查询参数 `project/tool/status/days/refresh`；同数据出 `/usage.json`；HTTP 模式挂载 `/usage`、`/usage.json`，跟随 HTTP 绑定，`AOS_USAGE_WEB=0` 关闭路由；CLI `--web` 复用同一 handler，默认 loopback。v1 纯只读，无鉴权（与 DESIGN §12 内网无鉴权一致）、无处置标记。
- **日志追踪**：既有审计日志行格式扩展 `usage=<id>`（人类可读不变）；事件 `id` 与日志行双向可查。
- **aos_status**：新增 `usage: { enabled, storage, note? }` 小节。
- **约束**：不新增 npm 依赖；不向 stdout 写任何东西（CLI 子命令输出除外）；统计写入 O(1)、查询有界。

## Testing Decisions

- 好测试只验证外部行为：事件字段与隐私边界、日志关联格式、工具响应、CLI 输出/退出码、HTTP 路由与页面关键区块、聚合结果；不测私有实现细节。
- 六个接缝与先例：
  1. **采集**：纯函数构造 + `test/server-smoke.test.js` 风格（桩 runtime/假 store 走真实 CallTool）。场景：成功/错误/未知工具/校验失败/排除 `aos_usage`/落库失败不影响调用/日志含 `usage=<id>`。
  2. **存储**：`test/db.test.js` 风格（pg-mem + Memory 双跑）。场景：写入与筛选查询、时间范围、清理（过期/超量）、列项目。
  3. **聚合**：fixture 事件纯单测。场景：成功率、p50/p95 边界（空/1 条/偶数）、归一化聚类把不同 ID/数字归并、未知 code 保留、零调用工具、参数键频次。
  4. **工具**：`test/llm-tools.test.js` / `crash-tools.test.js` 风格 handler 直调。场景：三动作、筛选、limit 上限、`AOS_USAGE=0` 标注。
  5. **Web**：MemoryStore 直测 `handleUsageRequest`（状态码/JSON 契约/HTML 含区块与徽标/筛选参数/`AOS_USAGE_WEB=0`），加一次 `test/http-server.test.js` 风格真 listener 集成（GET `/usage`、`/usage.json`）。
  6. **CLI**：`test/suite-command.test.js` 风格注入 io/假 store。场景：文本/json/`--all`/`--project`/`--days`、`--web` 端口冲突 exit 2、禁用标注。
- 全程不依赖真实 PG / 设备 / 外网；页面为服务端字符串，无前端构建。

## Out of Scope

- 服务内部编排调用的记录（见 ADR-0006，未来若要内部可观测另开通道）。
- 会话级调用序列挖掘（需要会话标识，v1 不做）。
- 看板的标记/忽略/已处理闭环；看板鉴权与多用户。
- 外部遥测上报、HAR/抓包、响应体断言。
- `mobile_run_task` 生命周期统计的改造（`task_stats` 保持原样）。
- 前端框架/构建链。

## Further Notes

- 命名冲突：`task_stats` 是任务统计；设计资源有 `usageCount`；本功能统一用「调用事件 / 使用统计 / 信号」。
- 内存降级语义：独立 CLI `usage --web` 在 PG 缺失时看不到运行中进程的内存事件，界面需以存储徽标与提示说明；HTTP 挂载在两种存储下都能看（同进程）。
- 验收遵循仓库完工标准：`npm run build && npm test && npm run lint` 全绿；行为/用法变更同步 DESIGN.md / README.md / AGENTS.md。
