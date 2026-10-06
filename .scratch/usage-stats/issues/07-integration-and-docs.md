# 07 — 整合验收与文档收口

**What to build:** 收口整个功能：DESIGN.md 增实施记录小节，README/AGENTS 同步工具、命令与环境变量；做一次三面一致性验收（同一次运行后 `aos_usage` / `usage` CLI / Web 看板 / 日志 `usage=` 对得上）；确认全量 build+test+lint 全绿且测试不依赖真 PG/设备/外网。

**Blocked by:** 04, 06.

**Status:** done

- [x] DESIGN.md 实施记录（§13.x）；README 工具表/命令与 AGENTS 环境变量同步
- [x] 三面一致性验收记录：工具、CLI、Web、日志对同一条事件可互相印证
- [x] `npm run build && npm test && npm run lint` 全绿；测试离线
- [x] spec 的 Out of Scope 项未被顺手带实现（核对）

## Comments

### 2026-10-06 — 完成（ticket 07）

**文档落点**
- `DESIGN.md`：§6.1 工具表新增 `aos_usage` 行；§11 里程碑新增 `U1` 行（使用统计，票据 01–07，见 §13.54）；文末新增 `### 13.54 实施记录（使用统计：客户端调用事件采集与三消费面，票据 01–07）`（采集面/事件模型与隐私/存储/聚合/工具/CLI/Web/日志追踪/离线验收 + Out of Scope 核对）。
- `README.md`：工具表新增 `aos_usage`；「任务统计与组合工具」增 `### 使用统计（usage）`（三面简介 + `usage` CLI 命令块 + Web/`AOS_USAGE_WEB` + 4 个环境变量）；日志示例补 `usage=<id>` 与事件互链说明。
- `AGENTS.md`：常用命令表新增「使用统计（CLI）」「使用统计看板」两行；关键机制速查新增「使用统计」条目（采集面/存储/清理/日志/三消费面/`aos_status.usage`），「日志」条目补 `usage=<id>` 互链。
- `CONTEXT.md`：仅核对既有术语（调用事件/使用统计/信号 + task_stats/usageCount 辨析），未改动。

**e2e 验收（新增 `test/usage-e2e.test.js`，1 例，离线）**
- 同一 `MemoryStore` + `loadTestRuntime`/`createServerForRuntime`（InMemoryTransport）跑一次真实客户端调用 `llm_list`，从审计日志抓 `usage=<id>`，再直写一条显式 `at` 的已知事件保证确定性。
- 断言同一事件 id 四处互相印证：① `aos_usage`（events 含两 id、summary.total/byTool）；② `runUsageCommand` 注入同一 store/cwd/catalog（JSON total/byTool + 文本 `llm_list 1 次`/`事件: 2`）；③ `handleUsageRequest` 的 `/usage.json`（items 含两 id）与 `/usage` HTML（title 含全量 id）；④ 日志 `tool=llm_list ok=true ms=… usage=<id>` 且 id 等于 store 中该事件 id。
- 无真实 PG/设备/外网；`configureLogging` 指向临时目录（`test/logging.test.js` 模式）。

**验证（精确数字）**
- `npm run test:file -- test/usage-e2e.test.js`：1/1 通过。
- `npm test`：610/610 通过（基线 609 + 新增 1），全绿。
- `npm run build` / `npm run lint`：干净。

**Out of Scope 核对（逐项读代码确认）**
- ADR-0006：采集只在 `src/server.ts` 的 CallTool 包装层；内部编排（`suite-runner.ts` / `diff/device-source.ts`）走 `runtime.proxy.callTool` 不经过，无内部事件。
- 无会话序列挖掘：事件/聚合/查询无 session/conversation 字段与序列聚合。
- 无看板鉴权/处置：`src/usage/web.ts` 只读（GET `/usage`、`/usage.json`），无 POST/auth/ack/ignore/标记逻辑。
- 无外部遥测：`src/usage/*`、`usage-command.ts`、`tools/usage.ts` 无 fetch/http 客户端调用。
- 无 HAR：无抓包/响应体断言相关代码。
- `task_stats` 未改：`src/db/postgres.ts` 仅新增 `usage_events` 表与读写/清理方法，task_stats 定义与逻辑未动。
- 无前端框架/构建：web.ts 为纯字符串 HTML + 内联 CSS，无框架导入；`package.json`/lock 未新增依赖。

**偏差与观察**
- 无功能偏差。§11 里程碑行 `U1` 为补记（ticket 只说「如适用」；为与 D1/D2 工作流行一致）。
- README 无独立命令表，`usage` 命令以代码块呈现（沿用 suite CLI 的 README 风格）。
- ticket 03 记录的 `test/usage-server.test.js`「policy env caps events per project」偶发 flake（同毫秒 `at` tie-break）未处理（超出本 ticket 范围）；本次全量 610/610 全绿。

## Comments（终审修订，2026-10-06）

- 最终双轴 code-review 发现并修复：
  1. **ADR 编号冲突**：新 ADR 与既有 `0005-ios-contract-level-parity.md` 撞号，已更名 `docs/adr/0006-usage-events-client-surface-only.md`；DESIGN/README/AGENTS/spec 引用同步为 ADR-0006。
  2. **聚合取数上限无视配置**：`aos_usage`/Web/CLI 原固定 50000，`AOS_USAGE_MAX_EVENTS` 调大时 `summary.total` 会少算；新增 `usageEventSampleLimit(env)`（跟随配置，0=不清理时回默认 50000 有界采样），三消费面统一接入（`Runtime.usageSampleLimit()` / web deps.env / CLI env）并有单测；DESIGN §13.54 已注明。
  3. **文档校正**：DESIGN §13.54 计数更正（`usage-server` 9→10、`usage-capture` 9→10）；「不记任何参数值」表述校正为「参数只记键名、不记录参数值本身；错误摘要为回显片段 ≤300」；`aos_usage` 返回表述改为「JSON 文本（中文标注）」；AGENTS `--project` 补「根路径」别名。
  4. **flake 根治**：`Runtime.recordUsage` 单调时间戳 + 回归用例（详见 ticket 02 追加记录），ticket 07 上条「未处理」观察作废。
- 修订后验证：`npm test` 611/611 绿、`npm run lint` 干净。
