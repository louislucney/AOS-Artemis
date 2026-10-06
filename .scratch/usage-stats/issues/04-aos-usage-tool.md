# 04 — `aos_usage` 工具

**What to build:** 新增原生 zod 工具 `aos_usage`：action `summary|signals|events`（默认 summary），筛选 `tool/status(ok|error)/days/limit`；输出中文结构化文本，风格与 `aos_tasks` 对齐。这是统计的第一个正式消费面。

**Blocked by:** 02, 03.

**Status:** done

- [x] `aos_usage` 注册为原生工具，三动作 + 筛选参数齐备
- [x] 响应为中文结构化文本（JSON 可解析段落/字段，风格对齐 aos_tasks）
- [x] `AOS_USAGE=0` 时显式标注采集已关闭（历史数据仍可查）
- [x] handler 直调测试覆盖三动作/筛选/limit 上限

## Comments

### 2026-10-06 — 完成（ticket 04）

**新增文件**
- `src/tools/usage.ts`（`aosUsage` handler；无注释）
- `test/usage-tool.test.js`（9 个用例）

**改动文件**
- `src/server.ts`：`NATIVE_TOOLS` 注册 `aos_usage`（zod schema 内联，风格同既有原生工具）；新增导出 `inProcessToolCatalog()`（NATIVE_TOOLS 名 ∪ `figmaTools()` 名，排序去重）。
- `src/runtime.ts`：新增 accessor `Runtime.listUsageEvents(query)`（经 `safeStore` 调 `store.listUsageEvents`，失败返回 `[]` 不抛；handler 不触私有字段）。

**响应形态（tickets 05/06 与文档的契约，JSON 文本）**
- 顶层：`ok: true`、`action: "summary"|"signals"|"events"`、`usage: { enabled, storage: "postgres"|"memory", note? }`（`AOS_USAGE=0` 时 `note` 为「使用统计采集已关闭（AOS_USAGE=0）；以下为已记录的历史数据。」）、`filters: { tool, status, days, since, limit }`（未传为 `null`；`since` 为 days 推导的 ISO 时间；`limit` 仅 events 动作非空，为实际生效值）、`store: { kind, degraded }`。
- `summary`：`summary: { total, ok, error, successRate, p50, p95, byTool[{tool,count,ok,error,successRate,p50,p95}], byFamily[{family,count}], byDay[{day,count}], zeroCallTools[] }`（即 ticket 03 `usageSummary` 原样）。
- `signals`：`signals: { errorClasses[{errorClass,count}], unclassified[{template,count,tools[]}], signalCodes[{code,field,count}], degradations[{code,count}], argKeys[{tool,keys[{key,count}]}] }`（即 ticket 03 `usageSignals` 原样）。
- `events`：`count`、`events[{ id, at, tool, family, ok, durationMs, errorClass, errorSummary, signals[{code,field?}], argKeys[], traceId }]`（不含 projectId；最新在前）。

**语义与边界**
- `action` 缺省 summary；`days` 缺省=全部保留期（不设 since）；`limit` 缺省 100，zod 限 1..200，handler 再 `min(…, USAGE_EVENT_LIST_MAX=200)`，`usageEvents` 第三重兜底 200。
- summary/signals 的事件样本上界取 `USAGE_MAX_EVENTS_DEFAULT`（50000，即每项目存储上限），保证「总数」在存储契约内准确；events 列表只取请求量。
- 零调用目录 = `inProcessToolCatalog()`（动态 import server，杜绝名单漂移）+ 代理 `mobile_*` 目录（仅 `proxy.isRunning()` 时尝试，失败静默降级不破坏响应）；`aos_usage` 自身从目录剔除（不被采集，零调用无意义）。与真实注册表的相等性有测试守护。
- `AOS_USAGE=0` 仅影响采集（ticket 02），工具照常查询历史；`usage.note` 显式标注。

**验证**
- `npm run test:file -- test/usage-tool.test.js`：9/9 通过
- `npm test`：588/588 通过（基线 579 + 新增 9）
- `npm run lint`：clean

**偏差与观察**
- 无功能偏差。实现细节偏差：为拿「零调用工具目录」，`src/tools/usage.ts` 通过动态 `import("../server.js")` 读取 `inProcessToolCatalog()`（静态 import 会与 server→tools 注册形成环）；测试同样导入该导出做清单校验。
- ticket 03 提到的 `USAGE_DEGRADATION_CODES` 与 `capture.ts` 私有文本码表双份同步风险未在本 ticket 处理（超出 04 范围）。
- 未改文档（DESIGN/README/AGENTS/CONTEXT）——按分工留给 ticket 07。
