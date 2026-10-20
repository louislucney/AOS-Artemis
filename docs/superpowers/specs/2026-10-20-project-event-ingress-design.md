# 项目事件入口（P0）设计：项目 → MCP 的双向基础

日期：2026-10-20  
状态：P0 已实施（2026-10-20）；P1 已实施（拉取式反馈：seq 游标 / 长轮询 / consumed_at / fsync / 历史台账迁移，2026-10-20）；P2 已实施（异步 job、面板轮询刷新、task_stats/suite_runs 事件回写，2026-10-20）  
上位问题：MCP 与项目连接非双向、记录与项目脱节、反馈慢。P0 只解决“项目 → MCP”的可靠入口与记录；反馈通道与异步任务分列 P1/P2。

## 1. 意图

当前 MCP 是“请求—应答工具服务器”：

- 项目只能调用工具，不能主动上报执行事件；
- 项目绕过 MCP 的本地脚本动作完全不可见；
- 记录是事后旁路（工具调用完成才写 usage/audit），任务完成态还有 30s 轮询滞后；
- 没有 MCP → 项目的推送通道。

P0 先建立**项目到 MCP 的可靠事件入口**：项目/执行器把 `run/case/step/artifact/log` 事件上报给 MCP，MCP 先落库、立即 ack，再提供查询。它不追求“实时反馈”，但为 P1 的反馈队列和 P2 的异步任务提供统一事件与身份基础。

## 2. 目标 / 非目标 / 反目标

### 目标

- G1：项目可通过 HTTP（`/events/<project>`）或 MCP 工具（`aos_event_report`）上报事件；两种入口共用同一校验与存储。
- G2：事件先写穿到 store 再返回；返回包含 `serverId/receivedAt/storage/degraded/duplicate`，ack 不等待任何设备/LLM/网络操作。
- G3：新增 `project_events` 持久层（PG + 文件台账 + 内存），支持按项目、run、case、type、时间查询。
- G4：幂等：同一项目内 `eventId` 唯一；重复上报不覆盖，返回 `duplicate:true`；payload 不一致显式标记。
- G5：项目身份来自路由/runtime，不接受任意路径或数据库 URL；沿用现有 HTTP 令牌闸门。
- G6：事件记录可审计，但不计入 `usage_events`（usage 只统计客户端工具调用）。

### 非目标

- N1：P0 不做 MCP → 项目的反馈/指令推送（P1）。
- N2：P0 不做长操作异步 job/progress（P2）。
- N3：P0 不自动把事件映射为 `task_stats`/`suite_runs`（P2）。
- N4：P0 不做 SSE/WebSocket；只用短请求 + 查询。
- N5：P0 不迁移历史文件台账的 usage / regression task；迁移工具改为服务内事件消费者（P1）。

### 反目标

- A1：事件入口接受任意路径/任意 DB URL（重复外部脚本的错误）。
- A2：ack 前执行设备、LLM、网络或重计算。
- A3：重复 eventId 覆盖已有 payload。
- A4：把 payload 当可信指令执行；P0 只存储与查询。
- A5：把事件写入 `usage_events` 造成统计污染。

## 3. 约束

- 保持现有 `/mcp/<project>`、`/panel`、`/usage`、`/artifact` 路由与鉴权不变；新增路由同受 `AOS_HTTP_TOKEN` 闸门。
- 项目名沿用 `PROJECT_NAME_RE`（`^[A-Za-z0-9._-]+$`），并显式拒绝 `.`/`..`（与现有 `/mcp/<project>` 路由一致）。
- 事件体上限 64 KiB；`payload` JSON ≤ 32 KiB；字符串字段 ≤ 256 字符。
- 事件存储必须支持 PG（跨进程/面板）与文件台账（stdio/单机）；内存仅最后兜底并显式标注。
- 写入失败必须返回错误（不能“收下但没记”）；幂等冲突按重复处理。
- 不依赖外网；测试不依赖真实设备/真实 PG。

## 4. 事件协议

### 4.1 信封

```json
{
  "eventId": "run-20261020T070000Z-case-001-step-3",
  "type": "case.result",
  "source": "executor",
  "at": "2026-10-20T07:00:03.123Z",
  "runId": "run-20261020T070000Z",
  "caseId": "TC_762568",
  "step": 3,
  "status": "failed",
  "payload": {
    "failureDomain": "app-defect",
    "message": "支付按钮无响应",
    "artifact": "screenshots/step-3.png"
  }
}
```

字段：

| 字段 | 必填 | 规则 |
|------|------|------|
| `eventId` | 是 | 1–128 字符，`[A-Za-z0-9._:-]`；项目内幂等键 |
| `type` | 是 | 下列 allowlist 之一 |
| `source` | 否 | allowlist：`project`（默认）/ `executor` / `agent` / `ci` |
| `at` | 否 | ISO 8601；缺省 = 服务接收时间；非法 400；仅事件自述，排序/时间窗用 `receivedAt`/`seq` |
| `runId` | 否 | ≤128 字符；AOS 套件运行**必须复用 manifest runId**（`run-<stamp>-<suffix>`） |
| `caseId` | 否 | ≤128 字符；机器 id 或 `displayId` 均可，服务不解析 |
| `step` | 否 | 非负整数 |
| `status` | 否 | allowlist：`started` / `passed` / `failed` / `skipped` / `error` / `info` |
| `payload` | 否 | 任意 JSON 对象；≤32 KiB；服务不执行 |

`type` allowlist（P0）与每类型最小必填字段：

| type | 最小必填 | 说明 |
|------|----------|------|
| `run.started` | `runId` | 一次执行开始 |
| `run.step` | `runId`, `step` | 执行步 |
| `run.finished` | `runId`, `status` | 终态；status 只能是 `passed/failed/skipped/error` |
| `case.started` | `caseId` | 单例开始 |
| `case.result` | `caseId`, `status` | 终态；status 只能是 `passed/failed/skipped/error` |
| `artifact.created` | `runId` 或 `caseId`，且 `payload` 为对象 | 产物索引 |
| `log.entry` | `payload` 为对象 | 日志片段 |
| `feedback.request` | `payload` 为对象 | P1 反馈请求占位 |

未知 `type`/`source`/`status` → 400；缺少该类型的最小必填字段 → 400，错误信息列出字段名。

### 4.2 服务端补充字段

- `serverId`：服务生成的 UUID（主键）。
- `seq`：服务端单调递增序号（PG `BIGSERIAL`；文件台账写入时持久化；内存计数器），用于同毫秒排序与 P1 游标。
- `projectId`：由 runtime/路由解析，不接受请求体覆盖。
- `receivedAt`：服务接收时间，**固定 UTC 毫秒 + Z**（`YYYY-MM-DDTHH:mm:ss.sssZ`）。
- `payloadSha256`：payload 规范化 JSON 的 sha256，用于重复冲突判断。

### 4.3 规范化 JSON（payloadSha256）

统一使用 **stable stringify**，PG/文件/内存三实现必须一致：

1. 对象键按 Unicode code point 升序递归排序；
2. 数组保持原有顺序；
3. 数字按 JavaScript `JSON.stringify` 规则（不保留 `-0`，不做精度归一；>2^53 的整数由生产方自行用字符串表示）；
4. 字符串按 UTF-8 编码；
5. `undefined` 的键忽略；顶层 payload 缺省/`undefined` 规范化为 `null`；
6. 哈希输入是上述字符串的 UTF-8 字节。

测试向量（三实现共用）：

- `{}` → `sha256("{}")`
- `{b:2,a:1}` 与 `{a:1,b:2}` → 同一哈希
- 缺省 payload 与 `null` → 同一哈希
- `{a:[2,1]}` 与 `{a:[1,2]}` → 不同哈希
- 嵌套对象/Unicode（`{"名":"值","a":{"b":1,"c":2}}`）跨 store 一致
- 大整数：`{"id":9007199254740993}` 经 `JSON.parse` 会丢精度；文档要求 id 用字符串（测试只锁定“解析后行为一致”，不承诺原值）

### 4.4 幂等与冲突

- 唯一约束：`(projectId, eventId)`。
- 重复上报且 payload 哈希一致：`202 {accepted:false, duplicate:true, serverId, receivedAt, storage, degraded}`；**serverId/receivedAt 取既有记录**。
- 重复上报但 payload 哈希不同：`202 {accepted:false, duplicate:true, payloadMismatch:true, serverId, receivedAt, storage, degraded}`；不覆盖原记录，仍取既有记录的身份。
- 同一 eventId 并发上报：数据库唯一约束决定；失败方按重复返回。

## 5. 存储

### 5.1 PG 表

```sql
CREATE TABLE IF NOT EXISTS project_events (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT,
  case_id TEXT,
  step INTEGER,
  status TEXT,
  at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE (project_id, event_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_events_project_received_idx
  ON project_events (project_id, received_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS project_events_project_run_idx
  ON project_events (project_id, run_id, at);
CREATE INDEX IF NOT EXISTS project_events_project_consumed_idx
  ON project_events (project_id, consumed_at);
```

- `payload` 存 JSON 文本；查询时 `JSON.parse` 返回。
- `at` 是事件时间；`received_at` 是服务接收时间，固定毫秒 ISO；查询默认按 `received_at DESC, seq DESC`。
- `consumed_at` P0 不写，预留给 P1 反馈消费者。
- 迁移走 `PostgresStore` 的 MIGRATIONS 列表（`CREATE TABLE/INDEX IF NOT EXISTS`），可重复执行；多实例并发迁移沿用既有 advisory lock/backlog 口径。

### 5.2 文件台账

- 位置：与现有 `FileStore` 同一 ledger home（默认 `<project>/.artemis/ledger/events.jsonl`；`AOS_LEDGER_DIR` 显式覆盖时使用该目录）。
- **写路径判重**：FileStore 启动时全量扫描 `events.jsonl`，建内存索引 `eventId → {payloadSha256, record}`；之后增量维护。重复上报直接命中索引，返回既有 `serverId/receivedAt`，不追加、不覆盖。
- **seq 持久化**：每条 JSONL 记录写入时带 `seq`；同时维护 `events.meta.json`（`{nextSeq}`，原子写）。启动时 `nextSeq = max(文件最大 seq, meta.nextSeq)`；裁剪后 seq 不回收、不因行号变化而漂移。写入顺序：先原子推进 meta，再 append；两步之间崩溃只产生 seq 空洞，不产生重复。
- 追加写：`appendFile`；**P0 不做 fsync**。202 的语义是“已写入操作系统缓冲并纳入服务记录”，不是“掉电后必然存在”；P1 增加 `fsync` 开关。
- 读取：逐行解析，坏行跳过并告警；`seq` 取记录字段，缺失的旧行按行号兜底并告警。
- 查询：内存过滤；`limit` 默认 50、最大 200。
- 保留：`AOS_EVENTS_RETENTION_DAYS`（默认 30）与 `AOS_EVENTS_MAX`（默认 50000，按项目计数）；按 `received_at` 计龄。
- 裁剪不在 ack 路径：写入成功后 `setImmediate` 触发，最多每 5 分钟一次；超过上限或过期时重写临时文件 + rename，保留 `events.meta.json` 的 `nextSeq`；失败只告警（`store.lastError`）。
- 不写入 `state.json`（避免快照膨胀）；`aos_status.store` 只标 `file`。

### 5.3 内存

- 仅当文件台账目录不可写时兜底；事件只在本进程可见，`aos_events` 与 ack 返回 `storage:"memory"` 与 `degraded` 原因。
- 内存态使用同样的 eventId 索引与 seq 计数器；重启即丢，seq 归零（文档明确）。
- HTTP 多进程/面板场景应使用 PG；设计上不承诺跨进程。

### 5.4 Store 接口

```ts
export interface ProjectEventInput {
  eventId: string;
  type: string;
  source?: string;
  at?: string;
  runId?: string | null;
  caseId?: string | null;
  step?: number | null;
  status?: string | null;
  payload?: unknown;
}
export interface ProjectEventRecord {
  seq: number;
  id: string;
  projectId: string;
  eventId: string;
  type: string;
  source: string;
  runId: string | null;
  caseId: string | null;
  step: number | null;
  status: string | null;
  at: string;
  receivedAt: string;
  payload: unknown;
  payloadSha256: string;
  payloadBytes: number;
  consumedAt: string | null;
}
export interface RecordProjectEventResult {
  record: ProjectEventRecord;
  duplicate: boolean;
  payloadMismatch: boolean;
}
export interface ProjectEventQuery {
  runId?: string;
  caseId?: string;
  type?: string;
  status?: string;
  /** received_at > since（严格大于；since 解析后规范化为 UTC 毫秒 ISO） */
  since?: string;
  /** desc（默认，新→旧）/ asc（旧→新） */
  order?: "asc" | "desc";
  /** 默认 50，最大 200 */
  limit?: number;
  /** 默认 false；true 时返回 payload，limit 上限降为 50 */
  includePayload?: boolean;
}
```

`ProjectStore` 增：

- `recordProjectEvent(rootPath, input): Promise<RecordProjectEventResult>`
- `listProjectEvents(rootPath, query?): Promise<ProjectEventRecord[]>`
- `countProjectEvents(rootPath): Promise<number>`（仅无过滤计数；状态/保留用）

三个实现（PG / File / Memory）都实现；三者失败语义一致：写失败抛错，读失败抛错。

### 5.5 保留与查询口径

- PG 裁剪同样异步、每项目最多每 5 分钟一次；按 `received_at` 删过期 + 按 `seq` 删超出 `AOS_EVENTS_MAX` 的最旧行；失败只告警，不影响 ack。
- 列表响应 `returned` 是**本页条数**，不是过滤后总数；不伪造 `total`。
- `since` 先 `Date.parse`，非法 400；规范化为 `new Date(ms).toISOString()` 后再比较（PG 的 `received_at` 与规范化值均为毫秒 ISO，TEXT 字典序等价时间序）。
- 同毫秒仍用严格 `>`，因此 P0 的 `since` 存在同毫秒丢失窗口，**仅用于展示刷新**；P1 的无丢失轮询用 `seq` 游标。
- 同毫秒顺序由 `seq` 决定，不依赖随机 UUID。

## 6. 入口

### 6.1 轻量项目解析（关键）

事件入口**不创建完整 `Runtime`**：

- `RuntimeHost.createRuntime` 会 `initialize()`（写项目/PG、导入 .env、写 artemis.jsonc）、刷新模型目录、探测 Figma token、sweep 子进程；artemis/LLM 不可用时可能返回 null，不能作为可靠入口。
- 新增 `resolveEventProject(name)`：
  1. 校验 `PROJECT_NAME_RE`，显式拒绝 `.`/`..`；目录 `${workspaceRoot}/<name>` 必须存在；
  2. 使用共享 `resolveProjectRoot(workspaceRoot,name)` = `path.resolve`（存在时再 `realpath` 归一），与 `RuntimeHost.createRuntime` 共用，避免尾斜杠/symlink 产生第二个项目身份；
  3. `loadProject` 读取配置（只读）；配置损坏返回 400 `project-config-invalid`，目录缺失 404；
  4. POST：`store.upsertProject({rootPath,name})` 保证 FK；GET：`getProjectByPath`，目录存在但未登记 → 空列表（不写）；目录缺失 → 404；
  5. 结果缓存 60s（项目名 → rootPath/projectId），配置错误不缓存。
- 事件入口不使用 artemis、LLM、Figma 桥或子进程；冷启动只多一次配置读取 + project upsert（首次事件可能略慢，后续缓存）。

### 6.2 HTTP（项目/执行器）

`POST /events/<project>`

- 鉴权：与现有 HTTP 服务同一 `AOS_HTTP_TOKEN` 闸门（非豁免路径）。
- 项目解析：`resolveEventProject`；未知项目 404。
- Body：JSON，≤64 KiB；非法 JSON 400；超限 413。
- 校验 → store 写入 → 202：
  ```json
  {
    "accepted": true,
    "duplicate": false,
    "serverId": "uuid",
    "eventId": "...",
    "receivedAt": "2026-10-20T07:00:03.456Z",
    "storage": "postgres|file|memory",
    "degraded": null
  }
  ```
- 重复：`accepted:false, duplicate:true`，`serverId/receivedAt` 为既有记录；冲突追加 `payloadMismatch:true`。
- 存储失败：500 `{error:"event store unavailable"}`；**不返回 accepted**。
- ack 预算：本地 p95 < 100 ms（不含首次冷启动）；处理器内不做设备/LLM/网络调用；审计写入用 `setImmediate`，不阻塞 ack。

`GET /events/<project>?since=&runId=&caseId=&type=&status=&limit=&order=&includePayload=`

- 鉴权同上；目录缺失 404。
- `limit` 1–200，默认 50；`includePayload=true` 时上限 50；`order=desc`（默认）/`asc`。
- 返回：
  ```json
  {
    "events": [ ... ],
    "returned": 1,
    "includePayload": false,
    "storage": "postgres|file|memory",
    "degraded": null
  }
  ```
- `includePayload=false` 时事件对象省略 `payload`，保留 `payloadBytes`。
- 不做长轮询/SSE（P1）。

### 6.3 MCP 工具（stdio / 无 HTTP 的项目）

- `aos_event_report`：参数 = 事件信封；返回与 HTTP 202 相同结构。
- `aos_events`：参数 = 查询过滤器；返回与 HTTP GET 相同结构。
- 工具归属 `src/tools/native-tools/events.ts`；项目身份来自 `runtime.project.rootDir`，无路径/URL 参数。
- 两个入口共用 `src/events/ingress.ts` 的校验/写入服务，避免两套语义。

## 7. 安全

- **无任意路径/URL**：项目由路由或 runtime 决定；事件工具不接受 `projectDir`/`databaseUrl`。
- **鉴权**：沿用现有静态令牌；非 loopback 无令牌启动仍 fail-fast。事件路由不是豁免路径。
- **轻量解析**：事件入口不启动 artemis/LLM/子进程，缩小攻击面与故障面。
- **输入限制**：body 64 KiB、payload 32 KiB、字段长度、type/source/status allowlist、per-type 必填校验、JSON 解析失败 400。
- **不执行 payload**：P0 只存储/查询；不把 `artifact`/`log` 当路径打开，不执行命令。
- **不记敏感内容**：审计只记 `eventId/type/runId/caseId/status`，不记 payload；日志不打印 payload。
- **幂等防重放**：`(projectId,eventId)` 唯一；重复不覆盖。
- **文件路径**：由 `FileStore` 的 ledger home 决定，路由不接受路径；文件创建为 0600（尽力），不跟随用户提供的路径。
- **纵深**：store 参数化 SQL；payload 仅作文本存储。

## 8. 记录、权威与拓扑

### 8.1 权威口径

- P0–P2 期间：**`suite_runs` 仍是回归结果的权威记录**；`project_events` 是执行过程旁路/证据流，不反向覆盖 `suite_runs`。
- AOS 套件运行上报事件时，`runId` 必须复用 manifest `runId`（`run-<stamp>-<suffix>`）；ad-hoc 运行由客户端生成 `run-<...>`，同一 run 内稳定。
- P2 才讨论事件驱动更新 `task_stats`/`suite_runs`；届时以 manifest runId 为桥。

### 8.2 部署拓扑

- **中心 HTTP + PG（推荐）**：执行器/项目机都 POST 到中心；项目机 stdio 配同一 `MOBILE_TESTING_DATABASE_URL`，两个入口看到同一事件流。
- **文件台账**：单实例兜底；服务进程必须能看到项目目录。中心多项目 HTTP 必须使用 PG，否则各实例文件互不可见。
- **内存**：仅目录不可写时兜底；ack 显式 `storage:"memory"` + `degraded`，跨进程不可见。

### 8.3 可观测

- 每次成功写入追加一条审计：`kind="project-event"`, `message="<type>"`, detail `{eventId, runId, caseId, status}`；审计 `setImmediate`，失败不阻断 ack，但记录 `audit.lastError`。
- 事件不计入 `usage_events`（ADR-0006：usage 只统计客户端工具调用）。
- `aos_events` 支持 `since/runId/caseId/type/status/limit/order/includePayload`；返回 `storage/degraded`，不伪造。
- 面板/`aos_status` 的计数展示放 P1（避免 P0 扩大改动面）。

## 9. 兼容与迁移

- 纯新增：现有工具/路由不变；旧客户端无感。
- PG 迁移幂等；文件台账新增 `events.jsonl` + `events.meta.json`，不改 `state.json`。
- 外部脚本 `scripts/migrate-ledger-to-pg.mjs` **在 P0 删除**（脚本、测试、README/DESIGN 入口）：它绕过服务边界（任意路径/DB URL、无审计）。
- 历史 usage/regression task 迁移在 P1 以 MCP 工具/事件消费者提供；P0 文档明确“暂不可用”，`suite backfill` 仍只覆盖 runs/case-sets。
- 旧测试与三件套不受影响。

## 10. 分期

### P0（本设计）

- 信封/校验/幂等/规范化哈希/per-type 必填。
- `project_events` 三实现 + PG 迁移 + 异步保留 + 文件写路径索引/seq meta。
- 轻量项目解析（不建 Runtime、`..` 拒绝、rootPath 归一）。
- `POST/GET /events/<project>`（202 带 storage/degraded）。
- `aos_event_report` / `aos_events`。
- 审计异步、测试与文档；删除外部迁移脚本。

### P1

- **已实施** `consumed_at` 消费者：拉取式反馈——项目/执行器用 `aos_event_poll`/`/poll` 取未消费事件并 `consume:true` 确认；服务端不生成反向指令队列（2026-10-20 定）。
- **已实施** `GET /events/<project>/poll` 长轮询（SSE 未做）；`aos_event_poll`。
- **已实施（契约）** 反馈生成由项目侧按失败域/重试/补数据/停止自行决策；服务端只保证游标、过滤与消费幂等。
- **已实施** 历史文件台账迁移工具 `aos_ledger_migrate`（仅当前项目 + 中心 PG，默认 dryRun，保留原 id 幂等）；文件事件 fsync 开关已实施。

### P2

- **已实施（第 1 批）** 长操作异步化：`run_regression`/`verify_jira_issue`/`design_to_test` 的 `async:true` → `jobId`；进度复用 `run.started`/`run.finished`；`aos_job_status`；结果落 `.artemis/jobs/`。
- **已实施（第 3 批）** 事件驱动 `task_stats`：终态事件 `payload.traceId` → `markTaskFinished`（异步、best-effort；30s 轮询保底）。
- **已实施（第 4 批）** 事件驱动 `suite_runs`：新增 `run_id` 列；`run.finished` 的 `runId` 命中 → `completed/failed` 回写。
- **已实施（第 2 批）** 面板轮询刷新：总览/项目页 15s、运行中任务页 10s（页面隐藏/表单聚焦暂停，可手动暂停）；未引入 SSE/WebSocket。

## 11. 验收测试

1. 校验：缺 `eventId`/非法 `type`/`source`/`status`/`at`/`step<0`/超长字段/缺 per-type 必填 → 400；payload 超限 → 413。
2. 幂等：同 eventId 同 payload → duplicate=true；不同 payload → payloadMismatch=true 且不覆盖；键顺序不同视为同 payload；重复响应取既有 serverId/receivedAt。
3. 持久：PG 与 file 各写入/读取；重启后 file 可读；**文件态判重索引**（重启后重复上报仍返回 duplicate）与 **seq 在裁剪后不回退/不复用**；memory 显式 degraded。
4. HTTP：202/400/401/404/413；GET 过滤器、limit/order、includePayload 省略 payload；**秒级 `since` 不丢同秒事件**；轻量解析在 artemis/LLM 不可用时仍可写入；目录缺失 404、目录存在未登记空列表。
5. 工具：`aos_event_report`/`aos_events` 与 HTTP 同语义；项目身份不可伪造。
6. 安全：事件路由受令牌闸门；payload 不进日志/审计；无路径/URL 参数；`.`/`..` 拒绝。
7. ack：处理器无设备/LLM/网络调用；审计异步；202 携带 storage/degraded。
8. 保留：PG/file 超限/过期异步裁剪，失败只告警，不阻断 ack；裁剪后新 seq 继续递增。
9. 拓扑：项目机 stdio 与中心 HTTP 共用 PG 时看到同一事件流（集成测试）。
10. 回归：`npm run build && npm test && npm run lint` 全绿。

## 12. 我的决定（可被覆盖）

- 路由用 `/events/<project>`，不复用 `/mcp/<project>/events`：传输语义清晰，避免与 MCP streamable HTTP 混淆。
- 事件入口走**轻量项目解析**，不创建 Runtime：可靠入口不能依赖 artemis/LLM/子进程健康。
- 文件态判重靠**启动全量索引 + 增量维护**；`seq` 写入时持久化，不从行号派生。
- `receivedAt` 固定 UTC 毫秒；`since` 解析后规范化再比较；同毫秒丢失窗口声明为 P0 限制。
- 202/工具响应携带 `storage/degraded`；重复响应取既有记录身份。
- P0 不做 SSE/长轮询：先把可靠写入与查询做稳，反馈通道 P1 单独设计。
- `eventId` 由项目生成，服务不生成幂等键：跨重试稳定；服务只生成 `serverId/seq`。
- `type`/`source`/`status` 先 allowlist，并加 per-type 最小必填：可查询、可告警；自定义类型走 P1 版本化扩展。
- 事件不写 usage：避免统计口径污染；审计行足够追踪。
- 文件台账不做 fsync：P0 以 ack 延迟优先，明确记录语义；P1 提供强持久开关。
- 列表默认不返回 payload：控制响应体积；需要时显式 `includePayload:true`。
- 外部脚本退役：迁移必须走服务边界（P1 事件消费者）。

## 13. 不在本设计内

- MCP → 项目反馈/指令（P1）。
- 异步 job/进度（P2）。
- 事件 → `suite_runs`/`task_stats` 自动映射（P2）。
- 历史 usage/regression task 迁移（P1，MCP 工具）。
- 面板实时事件流（P2）。
