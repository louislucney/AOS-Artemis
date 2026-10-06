# 05 — Web 看板（HTTP 挂载）

**What to build:** HTTP 模式挂载只读看板：`GET /usage` 返回服务端渲染 HTML（概览含存储徽标 / 工具表含零调用行 / 信号面板 / 事件流水），`GET /usage.json` 返回同源 JSON；支持 `project/tool/status/days/refresh` 查询参数与项目切换；`AOS_USAGE_WEB=0` 关闭路由；内存降级时徽标与提示正确。零依赖、无前端构建。

**Blocked by:** 01, 03.

**Status:** done

- [x] `GET /usage` HTML 含四个区块与存储徽标；`GET /usage.json` 与页面同源
- [x] project/tool/status/days/refresh 参数生效；项目切换与零调用工具行可见
- [x] `AOS_USAGE_WEB=0` 时路由关闭；内存降级徽标与空数据提示正确
- [x] MemoryStore 单测 + 真 listener 集成测试，全程无外网

## Comments

### 2026-10-06 — 完成（ticket 05）

**新增文件**
- `src/usage/web.ts`（handler + HTML 渲染，零依赖、无注释）
- `test/usage-web.test.js`（9 个用例，MemoryStore 直测 `handleUsageRequest`，`now` 固定保证确定性）

**改动文件**
- `src/http-server.ts`：GET `/usage` / `/usage.json` 路由（在 `/mcp` 匹配前），deps 注入服务级 `store`、`inProcessToolCatalog()`、`reason`（降级说明）、`process.env`；POST `/mcp` 与其他路由不受影响。
- `src/usage/capture.ts`：导出 `USAGE_DISABLED_NOTE`（原为 `src/tools/usage.ts` 私有常量，双份会漂移）。
- `src/tools/usage.ts`：改用共享常量（行为不变）。
- `test/http-server.test.js`：新增 2 个真 listener 集成用例（`/usage` + `/usage.json` 200/内容、`/healthz` 与未知路由仍正常；`AOS_USAGE_WEB=0` 时两路由 404 且 `/healthz` 200，env 在 finally 恢复）。

**Handler 契约（ticket 06 `usage --web` 直接复用）**
```ts
export interface UsageWebDeps {
  store: ProjectStore;
  catalog?: readonly string[];          // 零调用行目录；内部剔除 aos_usage
  storageNote?: string | null;          // 内存降级说明；memory 且缺省时用内置文案
  env?: NodeJS.ProcessEnv;              // AOS_USAGE / AOS_USAGE_WEB，缺省 process.env
  now?: number;                         // 供确定性测试/CLI 注入，缺省 Date.now()
}
export async function handleUsageRequest(
  url: URL,
  deps: UsageWebDeps
): Promise<{ status: number; contentType: string; body: string }>;
```
- 只认路径 `/usage`（`text/html; charset=utf-8`）与 `/usage.json`（`application/json; charset=utf-8`）；其他路径 404 JSON。
- `AOS_USAGE_WEB=0` → 两路径均 404 `{"error":"not found"}`（在 handler 内判定，deps.env 缺省读 `process.env`）。
- 未知 project → 404 `{"error":"未知项目 \"...\""}`；`project` 先按 rootPath 精确匹配、再按 name，缺省取 `store.listProjects()[0]`（最近 lastSeenAt）；无项目/无事件返回 200 空态。
- 参数：`tool` 精确、`status` 仅 ok|error、`days` ≥1（派生 `since`）、`refresh` 1..86400（HTML `<meta http-equiv="refresh">`）、`limit` 1..200（缺省 100，事件页大小）、`offset` ≥0；非法值静默忽略/回缺省。
- HTML 全部插值经 `escapeHtml`；页面为纯字符串（内联 CSS，无 JS），项目切换与筛选为原生 GET 表单；事件流条目带短 id（hover 全量 id），窗口与聚合事件上限一致（最新 200 条）。

**`/usage.json` 形态（稳定字段名）**
- 顶层：`ok`、`generatedAt`、`usage{enabled,storage,note}`、`store{kind,degraded,note}`、`filters{project,projectRoot,tool,status,days,since,limit,offset,refresh}`、`project{name,rootPath,lastSeenAt}|null`、`projects[]`（显式映射，不含 figmaToken）、`tools[{tool,count,ok,error,successRate,p50,p95,lastCallAt,zeroCall}]`、`summary`（ticket 03 `usageSummary` 原样）、`signals`（ticket 03 `usageSignals` 原样）、`events{total,count,limit,offset,items[]}`（items 同 ticket 04 事件视图，不含 projectId）。
- 事件 item：`{id,at,tool,family,ok,durationMs,errorClass,errorSummary,signals[],argKeys[],traceId}`。

**验证**
- `npm run test:file -- test/usage-web.test.js`：9/9 通过
- `npm test`：599/599 通过（基线 588 + web 9 + http-server 2）
- `npm run lint`：clean

**偏差与观察**
- 零调用行随筛选变化：`summary.zeroCallTools` 由 ticket 03 的「目录 ∩ 当前筛选后已见工具」决定，故 `tool=llm_list` 时其他目录工具显示零调用行（与聚合契约一致；测试已按此断言）。
- HTTP 挂载的目录仅含进程内工具（native+figma）与无代理 `mobile_*`；未在 `/usage` 请求里调用各 Runtime 的 `proxy.listTools()`（避免每请求触发子进程交互；mobile 工具被调用后照常出现在工具表）。零调用功能已由目录中的 native/figma 工具满足。
- 事件翻页窗口为最新 200 条（ticket 03 `USAGE_EVENT_LIST_MAX` 锁定），超出时页面提示「仅最近 200 条可翻页」；`events.total` 仍为过滤后全量。
- `USAGE_DISABLED_NOTE` 从 `tools/usage.ts` 提为 `capture.ts` 导出以避免两份文案；ticket 04 行为不变（其测试不受影响）。
