# 02 — 采集闭环与日志追踪

**What to build:** 在客户端调用的统一入口记录调用事件：成功、工具报错、参数校验失败、未知工具名都产生事件；`aos_usage` 自身调用不记；记录或落库异常只写 warn 日志、绝不影响调用结果。审计日志行附 `usage=<id>` 与事件互链；`aos_status` 增加统计开关与存储状态。完成后一次真实调用即可在存储与日志两端查到同一条事件。

**Blocked by:** 01.

**Status:** ready-for-agent

- [x] 客户端经 stdio 与 HTTP 的每次工具调用（成功/失败/参数校验失败/未知工具）产生一条事件
- [x] `aos_usage` 自身调用不产生事件
- [x] 日志行含 `usage=<id>` 且与事件 id 一致，可从日志定位事件
- [x] 注入会抛错的假 store 验证：记录失败不影响调用结果
- [x] `AOS_USAGE=0` 时不采集；`aos_status.usage` 显示 enabled/storage

## Comments

- 2026-10-06 实施：新增纯模块 `src/usage/capture.ts`（`usageEnabledFrom` / `usagePolicyFrom` / `usageFamilyOf` / `usageEventInputFrom`：族映射、错误类、摘要、signals、argKeys、traceId；零 IO）。`Runtime` 增 `usageEnabled()` 与 `recordUsage()`（检查开关、按 `AOS_USAGE_RETENTION_DAYS`/`AOS_USAGE_MAX_EVENTS` 策略写 store、try/catch 只 warn、绝不抛）。`server.ts` CallTool 包装层：先记录事件再把 ` usage=<id>` 插入既有 `tool= ok= ms=` 审计行（字段保序：usage 在 ms 后、error 前）；`aos_usage` 按名排除；runtime 为空或 `AOS_USAGE=0` 不记且无 usage 字段；handleCall 外包一层 catch，处理器抛出兜底为 `工具 "..." 执行失败` 并记 `internal`。`aos_status` 增 `usage: { enabled, storage }`（storage 复用 `runtime.storeKind()`）。
- 文件：新增 `src/usage/capture.ts`、`test/usage-capture.test.js`（9 例）、`test/usage-server.test.js`（9 例）；改 `src/runtime.ts`、`src/server.ts`、`src/tools/llm.ts`、`test/server-smoke.test.js`（stdio 端断言 `usage=<id>`）、`test/http-server.test.js`（HTTP 端断言 `usage=<id>`）。
- 验证：`npm run build` / `npm run lint` 干净；`npm test` 567/567 绿（基线 549 + 新 18）。
- 判断与偏差：
  - 无前缀的 vendored Figma 桥工具（`get_current_selection` 等 20 个）按「known native/offline tool names」归 `native` 族；`mobile_*`/`figma_*`/`pen_*` 前缀优先，其余 `unknown`。
  - 降级标记码表：`vision_degraded`、`ios-log-unsupported`、`ios-unsupported`、`param_ignored`、`skipped_unmanaged`、`skipped_occupied`，以及文本映射 `无损 PNG 不可用`/`已回退 live JPEG`→`lossless_fallback`、`simctl 兜底`→`simctl_fallback`；warnings 解析支持顶层与至多两层嵌套（节点预算 200，避免大节点树开销），未知 code 原样保留。
  - `errorSummary`：JSON 载荷优先取字符串 `error`/`message`，否则取首行并折叠空白；300 截断仍由 store 负责。
  - 错误类按族消歧：`mobile` 族的 `执行失败`→`artemis`，其他族 `执行失败`→`internal`；timeout 标记先于 figma/artemis；Figma 文案含 `figma/限流/429/retry-after` 也归 `figma`。
  - `AOS_USAGE*` 读进程 env（`Runtime.baseEnv`，与 `AOS_CRASH_*` 同口径），不读项目 `.env`。
- 文档（DESIGN/README/AGENTS）按分工留给 ticket 07。
- 2026-10-06 追加（编排者终审修复）：`test/usage-server.test.js` 「policy env caps」在同毫秒事件下按随机 UUID 决出保留者（约 1/3 概率 flake）。根治：`Runtime.recordUsage` 采用进程内单调时间戳（`max(now, last+1ms)`），「最新」即插入顺序；新增回归测试「consecutive calls get strictly increasing timestamps」锁定（该文件 10 例，8 连跑稳定）。

