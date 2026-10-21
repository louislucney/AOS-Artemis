# 多机接入：主机身份、环境探测与下发队列（设计）

- 日期：2026-10-21
- 状态：已实现（2026-10-21）
- 范围：mobile-testing（AOS × ARTEMIS）中心/项目机部署形态（形态 B）
- 关联：`DESIGN.md` §13.109（runner）、§13.116（领取加固）、§13.125（存储装配）

## 1. 意图

中心是一台 Mac，提供 MCP 服务、PostgreSQL 与面板。项目在各自的 Mac/PC 上，目录留在本机，每台机器运行本地 MCP（stdio）与 `suite runner`，通过中心 PG 交换任务与结果。

要解决五件事：

1. 中心能**明确下发到“某台机器上的某个项目”**去执行，而不是谁抢到算谁的。
2. 能**清楚标识每个接入项目**：哪台机器、什么系统（Mac/PC/Linux）、什么 IP、工具链是否齐、当前是否在线。
3. 把**“接入在线”与“可执行”拆开**：IDE 开着但 runner 没启动，也要看得见这台机器和项目；runner 在线但没人在场，也要标出来。
4. **下发前规避不匹配**：iOS 任务不能投给 Windows；缺工具、缺设备、架构不符要在下发时就能看出原因。
5. **队列可操作**：运行中可中断/取消，待执行可取消，取消后后续任务继续；取消来源（中心还是项目机本地用户）可追溯。

## 2. 目标 / 非目标

### 目标

- 机器（host）成为一等实体：持久 `machine_id`、OS/架构、系统用户名、IP 历史、工具与资源快照。
- **接入在线（MCP 会话）与执行可用（runner）分开记录**：IDE 在线但未跑任务时也能看到人和项目。
- 项目身份从“全局唯一路径”改为“主机 + 路径”；同一项目可在多台机器各有一份。
- 任务带目标主机与能力要求；领取时做能力门禁并给出可解释的拒绝原因。
- 任务队列支持：优先级、每 runner 串行、暂停/恢复、pending 取消、运行中停止并落终态、失败重试与毒丸防护。
- 取消记录来源与操作者：中心面板/CLI、项目机本地 MCP/CLI、runner 自身；写入审计。
- 面板按“主机”聚合展示接入情况；远端项目磁盘不可达时显式标注，而不是显示为空。
- 支持“期望主机”登记与漂移提示：已登记未上线、上线未登记、OS/主机名/IP 与登记不符。

### 非目标

- 不做跨机器共享项目目录（形态 A）；项目目录始终在项目机上。
- 不做账号/登录体系。身份粒度 = `machine_id` + 本机系统用户名 + 可选 `AOS_ACTOR`。
- 不把 IP 作为身份或路由依据；IP 只做展示、排障与“变更/复用”提示。
- 不做任务中途断点续跑；停止/取消是终态，重跑创建新任务。
- 不承诺远端项目在中心面板上可浏览全部本地文件；只覆盖 PG 台账 + runner artifact HTTP。

## 3. 现状核对（代码事实）

| 事实 | 位置 |
|---|---|
| `projects.root_path` 全局 `UNIQUE`，项目无主机维度 | `src/db/postgres.ts:72-79` |
| `getProjectByPath` 只按 `root_path` 查询并取 `rows[0]`；40+ store 方法都经它解析项目 | `src/db/postgres.ts:378-385` |
| claim 时 `attempts=attempts+1`；毒丸按 attempts 判定 | `src/db/postgres.ts:825-831`；`src/runner/agent.ts:179,274` |
| runner 有独立心跳循环，执行期间持续更新 `last_seen` | `src/runner/agent.ts:116-133` |
| `project_events` 只有 `project_id`；事件入口按项目名/路径解析 | `src/db/postgres.ts:119-137`；`src/events/project-resolver.ts:29-50` |
| 迁移未使用 advisory lock（P2.x backlog） | `src/db/postgres.ts:313-327` |
| 面板解析项目：先按 `rootPath` 精确匹配，再按名字兜底且要求 `fs.existsSync(rootPath)` | `src/panel/web.ts:239-277` |
| 面板链接使用完整 `rootPath` 作为 `project` 参数，远端项目可经 `byPath` 命中 | `src/panel/web.ts:568-588` |
| 远端项目已能显示“磁盘不可达，仅台账可见” | `src/panel/web.ts:746, 1987-1989`；`src/panel/overview.ts:823-887` |
| `runners` 身份唯一索引 `(project_id, name)`，`name` 缺省 `os.hostname()` | `src/db/postgres.ts:287-292`；`src/runner/agent.ts:46,86` |
| runner 心跳只上报 platforms/devices/tools/version/artifactUrl/lastSeen | `src/runner/inventory.ts:7-11`；`src/db/types.ts:296-320` |
| 任务状态：`pending/claimed/running/stopping/stopped/completed/partial/failed` | `src/db/types.ts:265-278` |
| 停止是“请求—确认”：面板置 `stopping`，runner 每 3s 轮询确认并 abort | `src/runner/agent.ts:229-270`；`src/panel/actions.ts:504-521` |
| 失败重试到 `AOS_RUNNER_MAX_ATTEMPTS` 后 `failed`，不堵队列 | `src/runner/agent.ts:271-295` |
| 失联领取回收：超龄 + 领取者不在线 → 回 `pending` | `src/db/postgres.ts:874-893` |
| pending 任务没有取消入口；`suite task` 只有 create/list/show/release | `src/suite-command.ts:1624-1739` |
| 领取只按 `platforms ⊆ 本机设备平台`，不看 OS/工具/主机 | `src/db/postgres.ts:777-834` |
| 无任何 IP 采集；`remoteAddress`/`X-Forwarded-For` 未使用 | 全仓检索无命中 |
| MCP `initialize` 的 `clientInfo`（客户端名/版本）未采集；无接入会话概念 | `src/server.ts`、`src/runtime-host.ts` 无 `clientInfo` |
| `usage_events` 只有 `project_id`，无 `host_id`/`session_id` | `src/db/postgres.ts:105-118` |
| `audit_events` 只有 `root_path/domain/action/result/summary/refs`，无操作者字段 | `src/db/postgres.ts:266-275` |

结论：远端项目的“读”和“下发”已有部分基础（`byPath` + 磁盘不可达降级），但**接入在线、身份、能力门禁、队列控制、取消留痕**都缺。

## 4. 决策总览

- **D1 主机身份持久化**：`machine_id` 首次生成并落盘；硬件 UUID 作为辅助校验；hostname 只做显示。IP 永不作为身份。
- **D2 项目身份 = (host_id, root_path)**：同一项目可在多台机器各一份；面板 URL 携带 `host`。
- **D3 能力门禁**：领取前校验平台、OS、工具、设备；iOS 仅 darwin。
- **D4 下发 = 入队，且必须落到一台机器**：项目本身已按主机拆分，`target_host_id` 由项目派生并做二次守卫；v1 不提供“任一机器代跑”。跨主机同一项目必须显式选机（逻辑项目分组与“任选/全跑”见 §16）。
- **D5 每进程串行 + 设备独占**：每个 runner 进程同时 1 个任务；同机多进程按设备租约互斥，设备不重叠即可并行。
- **D6 取消是终态**：`cancelled`；`stopped` 仅作历史兼容读作取消。停止请求 → runner 确认 → 取消。
- **D7 取消留痕**：`cancel_source` + `cancelled_by` + `cancelled_host_id` + `cancelled_at` + `cancel_note`，并写审计。
- **D8 环境快照**：OS/版本/架构、CPU/内存、磁盘余量、工具版本；启动全量、之后按 `AOS_HOST_ENV_REFRESH_MS` 刷新，心跳带摘要。
- **D9 IP 双通道**：自报网卡地址 + PG 观测地址（`inet_client_addr()`）；保留历史与变更提示。
- **D10 向后兼容**：旧 runner/项目按 `legacy` 标记，不参与定向；面板旧 URL 继续可用，歧义时报错让用户选主机。
- **D11 三层信号**：接入层（本地 MCP 会话心跳）回答“谁在哪台机器上开着哪个项目”；执行层（runner 心跳）回答“这台机器能不能跑、能跑什么”；期望层（登记的主机画像）回答“是不是该来、有没有漂移”。下发只用执行层 + 期望层。

## 5. 身份模型

### 5.1 machine_id

解析顺序：

1. `AOS_HOST_ID`（显式覆盖，测试/容器用）。
2. `AOS_HOST_DIR`（默认 `~/.aos`）下的 `host-id` 文件；不存在则生成 `crypto.randomUUID()` 并原子写入（权限 0600）。
3. 目录不可写时，退化为 `sha256(hardware_id || hostname || username)` 的前 32 位，并在记录中标记 `identity_source=derived`。

硬件 UUID（`hardware_id`，仅诊断与重复检测，不单独作身份）：

- macOS：`ioreg -rd1 -c IOPlatformExpertDevice` 的 `IOPlatformUUID`。
- Windows：注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`。
- Linux：`/etc/machine-id`。

`hosts` 记录同时保存 `hostname`、`username`（`os.userInfo().username`）、`os_platform`、`os_version`、`arch`。`machine_id` 迁移/重装系统会变，属于可接受的运维事件；面板用 `hardware_id` 提示“疑似同一台机器换了 ID”。

### 5.2 用户身份

- 取消/操作记录：`cancelled_by = AOS_ACTOR || os.userInfo().username`。
- 面板集中操作：`actor = "panel"`（可选 `X-AOS-Actor` 头，仅显示用）。
- 不做鉴权意义上的用户体系；README/DESIGN 明确“身份自报，不是安全边界”。

## 6. 数据模型

### 6.1 新表 `hosts`

```sql
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,                 -- machine_id
  hardware_id TEXT,
  hostname TEXT NOT NULL,
  username TEXT,
  os_platform TEXT NOT NULL,           -- darwin | win32 | linux | other
  os_version TEXT,
  arch TEXT,
  identity_source TEXT NOT NULL DEFAULT 'file',  -- file | env | derived
  kind TEXT NOT NULL DEFAULT 'other',  -- mac | pc | linux | other（展示用）
  capabilities TEXT NOT NULL DEFAULT '[]',       -- ["ios-simulator","android",...]
  env TEXT NOT NULL DEFAULT '{}',      -- 工具版本/资源/磁盘，见 §11
  env_at TEXT,
  ip_primary TEXT,
  -- 期望层（登记画像；为空 = 未登记）
  label TEXT,                          -- 人可读名，如 "Alice 的 MacBook"
  owner TEXT,
  expected_os TEXT,                    -- darwin | win32 | linux
  expected_hostname TEXT,
  registered_at TEXT,
  registered_by TEXT,
  -- 三层在线信号
  client_seen_at TEXT,                 -- 最近一次本地 MCP 会话心跳
  runner_seen_at TEXT,                 -- 最近一次 runner 心跳（isRunnerOnline 用它）
  last_seen_at TEXT NOT NULL,          -- max(client_seen_at, runner_seen_at)，排序用
  -- 队列
  queue_paused BOOLEAN NOT NULL DEFAULT FALSE,
  queue_paused_at TEXT,
  queue_paused_by TEXT,
  first_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 6.2 新表 `host_addresses`

```sql
CREATE TABLE IF NOT EXISTS host_addresses (
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                -- self | observed-pg | observed-http
  iface TEXT NOT NULL DEFAULT '',      -- 自报网卡名；观测来源为空
  family TEXT NOT NULL DEFAULT 'ipv4', -- ipv4 | ipv6
  address TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (host_id, source, iface, address)
);
```

保留策略：每主机每来源最多保留 20 条，按 `last_seen_at` 清理；`AOS_HOST_ADDR_HISTORY=0` 关闭历史（只留当前）。清理与 `ip-shared` 判定由心跳写入方（30s，幂等 upsert）和中心清扫器（5min）各做一次，谁先到谁生效。

### 6.3 `projects` 增加 `host_id`，并明确解析规则

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS host_id TEXT;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_root_path_key;
CREATE UNIQUE INDEX IF NOT EXISTS projects_host_path_idx ON projects(host_id, root_path);
```

- **历史行保持 `host_id=NULL`，不自动回填**：中心 PG 里本来就包含各项目机注册的行，“回填本机”会把别人的项目认领成自己的。NULL 行在唯一索引下合法共存（NULLs distinct）。
- 归属由各项目机执行 `host adopt-legacy --local`（按本机文件系统存在性）或人工 `--host` 指派，见 §13。
- 逻辑项目分组（同一 App 跨机器）不在本期：先用 `project.name` 在面板对齐；需要时再加 `project_key`。

### 6.4 `runners` 增加 `host_id` 与 `instance_id`

```sql
ALTER TABLE runners ADD COLUMN IF NOT EXISTS host_id TEXT;
ALTER TABLE runners ADD COLUMN IF NOT EXISTS instance_id TEXT;
-- 旧行 host_id 保持 NULL：面板标注“身份未升级”，不参与定向与能力门禁
-- 保留旧唯一索引 (project_id, name)：旧 runner 的 upsert 依赖它做 23505 回退
CREATE UNIQUE INDEX IF NOT EXISTS runners_project_host_idx ON runners(project_id, host_id);
```

- 旧索引 `runners_project_name_idx` **不删除**：旧 runner 仍按 `(project_id, name)` 插入/回退；新索引 `(project_id, host_id)` 只约束升级后的 runner。两个索引并存不冲突（`host_id` 为 NULL 时新索引允许多行，旧索引负责去重）。
- `name` 保留为显示名（默认 hostname）。
- **双启检测（时序明确）**：`INSERT` → 命中 `23505` → **先 `SELECT` 该行**：
  - `instance_id` 不同且 `last_seen_at` 在 TTL 内 → 第二个进程报错退出（`runner already active on this host`）；
  - 行已陈旧（超过 TTL）→ 用 CAS `UPDATE ... WHERE instance_id=<旧值>` 接管 `instance_id`，失败则退出。
  - 禁止照抄“23505 后盲 UPDATE”，否则第二个进程会覆写第一个实例的心跳与领取身份。
- 升级窗口：旧 runner（`host_id=NULL`，按 `(project_id,name)` 复用行）与升级后 runner 同机同项目可能共享同一行。发布说明明确“同一项目不要混跑新旧 runner”；检测到旧行（`host_id IS NULL` 且 `name=hostname`）时新 runner 提示并要求 `AOS_HOST_STRICT=1` 或停旧启新。
- `claimed_by` 仍指向 runner 行 id；新增 `regression_tasks.claimed_instance_id` 记录领取时的实例，便于审计与排障。
- 旧 runner（无 `instance_id`/`host_id`）继续可用，但只能领非定向任务；`AOS_HOST_STRICT=1` 的拒绝点在两处：claim SQL 前（runner 侧）与本地命令入口（`suite run --task` / `suite task cancel`），不依赖面板。

### 6.5 `regression_tasks` 扩展

```sql
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS target_host_id TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancel_source TEXT;     -- panel|local-cli|local-mcp|runner|admin
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancelled_host_id TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancelled_at TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancel_note TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS last_progress_at TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS created_host_id TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS claimed_host_id TEXT;
ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS claimed_instance_id TEXT;
```

- `target_host_id` 由创建时的项目 `host_id` 派生并写入；领取时要求 `target_host_id` 等于本机。它不改变“任务只属于一个 host 项目行”的事实，只作为显式意图与未来逻辑项目分组的挂点。
- 旧任务 `target_host_id` 为 NULL：按项目行归属领取（与现状一致）。
- `claimed_by` 仍是 runner 行 id；`claimed_host_id` / `claimed_instance_id` 让面板直接按主机展示并区分实例。**权威是 `claimed_by` 指向的 runner 行**，两个投影只做审计与查询便利，冲突时以 runner 行为准。
- `created_host_id`：区分“中心派发”和“项目机本地派发”。

### 6.6 新表 `device_leases`

```sql
CREATE TABLE IF NOT EXISTS device_leases (
  host_id TEXT NOT NULL,
  serial TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT,
  acquired_at TEXT NOT NULL,
  renew_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (host_id, serial)
);
```

用途：同一台机器上多个 runner 进程（多项目）时，设备级互斥；任务结束/取消/异常时释放；过期租约在心跳与领取时清理。

### 6.7 新表 `host_sessions`（接入层）

```sql
CREATE TABLE IF NOT EXISTS host_sessions (
  id TEXT PRIMARY KEY,                 -- 每个本地 MCP 进程一个 session uuid
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  root_path TEXT NOT NULL,
  username TEXT,
  client TEXT,                         -- MCP initialize clientInfo.name（cursor/claude-code/...）
  client_version TEXT,
  pid INTEGER,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS host_sessions_host_seen_idx ON host_sessions(host_id, last_seen_at);
```

- 在线判定：`ended_at IS NULL AND last_seen_at > now - AOS_CLIENT_TTL_MS`（默认 120s）。
- 一个进程对应一行；优雅退出写 `ended_at`，异常退出靠 TTL 过期。
- 保留：`AOS_CLIENT_SESSION_RETENTION_DAYS`（默认 7）清理已结束会话；当前会话不删。
- 只记录“哪个项目被哪个客户端在使用”，不记录工具参数与内容（与 usage 事件的隐私口径一致）。

### 6.8 `usage_events` 增加主机/会话维度

```sql
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS host_id TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS session_id TEXT;
```

用途：面板从“接入会话”直接跳到该会话的工具调用；中心可按机器统计使用量。旧行保持 NULL。

### 6.9 项目解析规则（store API 面）

**规范键**：`ProjectRef = { hostId, rootPath }`。任何跨机操作必须显式带 `hostId`；本地上下文用 `localHostId`。

规则：

1. 本地调用（本机 MCP/runner/CLI）：解析 `(localHostId, rootPath)`；**未命中就报错，不回退到其他主机**。
2. 中心/跨机调用：`hostId` 必填；`rootPath` 仅作显示与项目内相对定位。
3. `getProjectByPath(rootPath)` 改为 `getProjectByPath(rootPath, hostId?)`：
   - 传 `hostId`：精确匹配；
   - 不传：只匹配 `localHostId`；
   - 匹配到多行（历史 NULL 行 + 本地行）→ 抛 `AmbiguousProjectError` 并列出候选，**禁止 `rows[0]` 随机取**。
4. `upsertProject` 以 `(hostId, rootPath)` 为键；**不隐式接管 `host_id=NULL` 的历史行**（接管只走 `host adopt-legacy`）。
5. 能拿到 `projectId` 的内部路径优先用 `projectId`，避免二次解析；`rootPath` 只保留在用户界面与审计。

**必须盘点的调用面**（全部改为带 `hostId` 或 `projectId`）：

| 面 | 代表方法/入口 |
|---|---|
| 任务 | `claimRegressionTask`、`getRegressionTask`、`updateRegressionTask`、`release*`、`listRegressionTasks` |
| 用例/运行 | `listCaseSets`、`recordCaseSet`、`listSuiteRuns`、`recordSuiteRun`、`listRegisteredManifestPaths` |
| 执行机 | `upsertRunner`、`listRunners`、`releaseStaleClaims` |
| 项目 | `getProjectByPath`、`upsertProject`、`listProjects` |
| 事件 | `recordProjectEvent`、`applyProjectEventToLedger`、`resolveEventProject` |
| 使用/审计/裁决 | usage 写入与查询、`recordAudit`、`updateCaseVerdict`、导出 |
| 工具/面板 | `project_archive`、panel `resolveProjectKey`、suite CLI 全部子命令 |

实现顺序：先改 `ProjectStore` 接口（`hostId` 参数或 `ProjectRef`），让 TypeScript 编译错误列出所有调用点，再逐处决定“本地默认”还是“显式 host”，不允许静默补默认值。

### 6.10 事件入口的主机维度（交叉影响）

`project_events` 目前只有 `project_id`，`/events/<project>` 按项目名路由；多机同名项目会歧义。本设计同步修订：

```sql
ALTER TABLE project_events ADD COLUMN IF NOT EXISTS host_id TEXT;
```

- 事件上报必须带 `host_id`：HTTP 路由改为 `/events/<host>/<project>`，或 body/header 显式 `host`；本地 stdio 直接写本机 `localHostId`。
- `resolveEventProject(workspaceRoot, name)` 改为 `resolveEventProject(hostId, name|rootPath)`；中心不再用“名字 + 本地磁盘存在性”猜项目。
- 事件按“上报方主机”归属；跨机同名项目各自独立。
- 旧事件数据 `host_id=NULL`，面板归到“未归属”，不参与新路由。

## 7. 接入与心跳

### 7.0 三层信号

| 层 | 上报者 | 频率 | 回答 |
|---|---|---|---|
| 接入层 | 本机 MCP 进程 | 启动 + 工具调用（节流 30s） | 谁在哪台电脑上开着哪个项目、用的什么客户端 |
| 执行层 | `suite runner` | 心跳 30s | 这台机器能不能跑、能跑什么、队列多深 |
| 期望层 | 中心登记（`host register` / 面板） | 人工 | 这台机器是不是该来、画像有没有漂移 |

- 面板在线状态分开显示：`IDE 在线` / `执行机在线`；两者都离线才显示“离线”。
- 下发只依赖执行层 + 期望层；接入层只做展示与“本机用户取消”的身份来源。
- 目标主机 IDE 离线但执行机在线：允许下发，提示“当前无 IDE 会话，可能没人在场”。
- 目标主机执行机离线：允许入队，提示“等待执行机上线”。

### 7.1 心跳载荷

`upsertRunner` 扩展为 `upsertHostHeartbeat`（或并列调用）：

```ts
{
  machineId, hardwareId, hostname, username,
  os: { platform: "darwin", version: "14.6.1", arch: "arm64" },
  env: {
    node: "22.19.0",
    aos: "1.x.y",
    cpu: { model: "...", count: 10 },
    memory: { totalBytes: 34359738368 },
    disk: { path: "<projectRoot>", freeBytes: ..., totalBytes: ... },
    tools: {
      adb: { present: true, version: "35.0.2", path: "/..." },
      xcodebuild: { present: true, version: "16.4" },
      simctl: { present: true },
      idb: { present: true, version: "1.1.8" },
      idevicesyslog: { present: true },
      appium: { present: true, url: "http://...", version: "2.x" },
      uv: { present: true, version: "0.8.x" }
    }
  },
  capabilities: ["ios-simulator", "ios-real", "android"],
  platforms, devices, tools, artifactBaseUrl, version
}
```

- 心跳周期保持 `AOS_RUNNER_HEARTBEAT_MS`（默认 30s）。
- 全量环境探测：启动 + 每 `AOS_HOST_ENV_REFRESH_MS`（默认 10min）；心跳只带缓存快照与 `last_seen_at`。
- 工具探测全部走 `exec` 注入，测试用假执行器，不依赖真实安装。

### 7.2 能力推导

| capability | 条件 |
|---|---|
| `ios-simulator` | `darwin` 且 `simctl` 可用（有 Booted 模拟器时才有对应 devices） |
| `ios-real` | `darwin` 且（Appium 可达 或 `idevice_id` + `idb`） |
| `android` | `adb` 可用 |
| `android-emulator` | `adb` 可用且存在 `emulator-*` |

`platforms` 仍由设备盘点得出，但**领取判定以“实时设备清单 + 工具可用 + OS”为准**，`capabilities` 只用于面板展示与下发前预检：
- 任务某端必须在本机**当前设备清单**里有至少一台设备（沿用现有语义）。
- 该端所需工具必须可用（iOS：`simctl` 或 Appium/idb；Android：`adb`）。
- iOS 任务要求 `darwin`。
- `ios-simulator` / `ios-real` 是展示与预检粒度，v1 不作为独立任务要求。
- 设备清单每次心跳刷新；环境快照按 10 分钟刷新，因此新插上的设备最迟一个心跳即可领取，不受环境快照缓存影响。

### 7.3 IP 采集

- **自报**：`os.networkInterfaces()` 过滤 internal / link-local；记录 iface、family、address。
- **观测（PG）**：心跳写库时同时执行 `SELECT inet_client_addr()`，把结果以 `observed-pg` 记录；返回 NULL（unix socket）或与自报明显不一致（代理/池化）时只记录、不覆盖主地址。
- **观测（HTTP，可选）**：若中心 HTTP 入口同时服务 MCP 客户端，记录 `req.socket.remoteAddress` 与可信代理下的 `X-Forwarded-For`，落 `project_clients`（见 §12.4）。本期低优先级。
- **主地址**：`observed-pg` 优先，其次第一个非链路本地 IPv4，最后 IPv6；面板展示全部并标注来源。
- **变更提示**：主地址变化时记录事件 `host.ip-changed`；同一 `observed-pg` 地址在 10 分钟内出现在两个 host → 警告 `ip-shared`（NAT/复用），不自动合并。

### 7.4 接入层心跳（本地 MCP）

本地 MCP 进程在 `initialize` 时拿到 MCP 客户端的 `clientInfo.name/version`，并在满足以下时机写 `host_sessions`：

- 进程启动（MCP `initialize` 完成后一次）；
- **进程内 30s 定时器**（同一 fire-and-forget 通道；`unref`，退出时清理），保证“IDE 开着但没调用工具”仍在线；
- 每次工具调用（节流：同一会话最多每 30s 一次）；
- 优雅退出（SIGINT/SIGTERM）写 `ended_at`。

写入内容：`session_id`（进程内 UUID）、`host_id`、`project_id`/`root_path`、`username`、`client`、`client_version`、`pid`、`started_at`、`last_seen_at`。

同时以“轻量 host 上报”更新 `hosts`：`hostname`、`os_platform`、`os_version`、`arch`、`client_seen_at`、`ip_primary` 与 `host_addresses`。这样**即使 runner 从未启动**，面板也能看到这台机器、这个项目和它的 IP。

约束：

- 写失败不阻塞工具调用（fire-and-forget，仅记日志）；无中心 PG 时跳过，不报错。
- 接入层不写 `capabilities`/`env`/`devices`，这些只由 runner 上报，避免把“IDE 在线”误当成“可执行”。
- 与 usage 事件共用 `host_id`/`session_id`，面板可以从“接入会话”跳到“这个会话调用了什么工具”。

## 8. 下发与队列

### 8.1 下发

- 中心面板/CLI 创建任务时**必须选定一台主机上的项目**；`target_host_id` 由项目 `host_id` 派生并写入。
- 入队前做**静态预检**：目标主机的在线状态、OS、工具、当前设备清单是否覆盖任务 `platforms`；不满足直接拒绝（400）并给出原因列表。主机离线时允许入队并提示“等待主机上线”；此时设备清单未知，只校验历史 capability。
- 任务只属于一个 `project_id`（主机 + 路径），引用份/用例集不跨主机复用。同一 App 在两台机器上是两个项目行，需要分别下发；逻辑项目分组与“任选/全跑”见 §16。

### 8.2 领取

```sql
UPDATE regression_tasks
   SET status='claimed', claimed_by=$runner, claimed_host_id=$host,
       claimed_instance_id=$instance, claimed_at=now
 WHERE project_id=$project
   AND status='pending'
   AND (target_host_id IS NULL OR target_host_id=$host)
   AND id=$candidate
```

- **`attempts` 只在真正开始执行时 +1**（`beginExecution`：`claimed → running` 的 CAS，同时写 `started_at`）。领取、设备忙释放、失联回收都不增加计数。
- 毒丸判定使用 `attempts >= AOS_RUNNER_MAX_ATTEMPTS`（默认 3，语义＝最多执行次数）。领取后先查一次，达上限直接 `failed`，不进入执行。
- 候选排序：`priority DESC, created_at ASC`。
- 能力门禁：任务每个 `platform` 在本机实时设备清单里至少有一台设备；所需工具可用；iOS 要求 `darwin`。
- 队列暂停：`hosts.queue_paused=true` 时 runner 不领取，但仍心跳；面板显示“队列已暂停（由 X 于 T 暂停）”。
- `AOS_RUNNER_PARTIAL_CLAIM=1` 的“部分端”语义保留，但仍受目标主机与 OS/工具门禁约束；缺端不补跑。

### 8.3 并发与设备

- **并发单位是 runner 进程**：每个进程同一时刻只执行 1 个任务（`AOS_RUNNER_MAX_CONCURRENCY` 仅保留为未来扩展，v1 固定 1）。
- 一台机器可跑多个 runner 进程（多项目）；**设备是真正的互斥资源**。执行前按任务实际使用的设备**一次性、全有或全无**地获取 `device_leases`（单事务插入；任一冲突则回滚全部）：
  - 获取失败 → 本次领取释放回 `pending`，附 `device-busy` 说明，按 `pollMs` 重试，**不计入 attempts**。
  - 租约 TTL = `AOS_DEVICE_LEASE_MS`（默认 90s = 2× 续租周期）；执行中每 30s 续租；终态/取消/异常时释放。
  - 过期租约（`expires_at < now`）在心跳与领取时清理。
- `beginExecution` 在租约全部拿到之后才把状态置 `running` 并 `attempts+1`；拿不到租约的任务永远停在 `pending/claimed`，不会被毒丸计数。
- 因此同机两个项目可以并行，只要设备不重叠；要“整机串行”，用单进程 + 单设备或后续加 `AOS_HOST_SERIAL=1`（本期不做）。
- 双启保护见 §6.4：同一主机同一项目只允许一个活跃 runner 实例。
- 设备不一致：任务要求的端在本机没有对应设备时，不领取（与现有 platforms 行为一致）。

### 8.4 进度、存活与统一 tick

**一个 30s tick 同时更新四个信号**，不允许各写各的：

1. `runners.last_seen_at`（现有 `heartbeat` 循环，`src/runner/agent.ts:116-133` 已实现，执行期间持续运行）；
2. `hosts.runner_seen_at`（同一 tick 的投影，供面板用）；
3. `regression_tasks.last_progress_at`（当前任务）；
4. `device_leases.renew_at/expires_at`（当前任务持有的设备）。

- **在线判定与失联回收同源**：两者都读 `runners.last_seen_at`；`hosts.runner_seen_at` 只是投影，不单独参与判定，避免“面板在线、回收离线”的分叉。
- “执行期心跳持续”是**显式前置**：现有独立心跳循环已落地；本设计只要求把 2/3/4 三个信号并进同一 tick，并新增测试：
  - 长执行（> 2×TTL）期间 `isRunnerOnline` 始终为真；
  - 租约不过期；
  - `attempts` 不增长；
  - 停止轮询（3s）仍能中止。
- 面板用 `last_progress_at` 区分“运行中 / 疑似卡住（> 3 个心跳周期）”。
- v1 不自动杀超时任务；新增 `AOS_TASK_MAX_RUNTIME_MS`（0 = 关闭）作为可选的强制上限，超时按“取消（source=runner）”处理。
- 真正的用例级进度（step/case 回调）列为后续增强。

### 8.5 队列控制

- **暂停粒度是“整台主机”**（`hosts.queue_paused`），因为争用资源是设备；面板按钮写明“暂停这台机器的队列（影响该机所有项目）”。
- `suite queue status|pause|resume [--host <id|hostname>]`；不带 `--host` = 本机。中心 CLI 必须带 `--host`，避免误暂停中心自己。
- 暂停只影响领取，不影响已运行任务；恢复后按原排序继续。
- 暂停/恢复写审计（actor + host）。
- **检查点两处**：领取 SQL 里读取 `hosts.queue_paused` 做硬条件；runner 侧在发起 claim 前也短路（避免暂停瞬间仍领）。恢复后无需额外动作，下一轮 poll 自然继续。
- 任务无自动过期（v1）；目标主机长期离线时由人取消，面板显示“等待主机上线 N 分钟”。

## 9. 取消 / 停止

### 9.1 状态机

```
pending ──cancel──► cancelled
pending ──claim──► claimed ──run──► running ──stop/cancel──► stopping ──ack──► cancelled
claimed/running ──失败未达上限──► pending
claimed/running ──失败达上限──► failed
running ──完成──► completed | partial
```

- `cancelled` 为终态；`stopped` 仅作为历史状态在**store 读取层**映射为 `cancelled`（`cancel_source=panel`，`cancel_note="legacy stopped"`），不是只在面板映射——统计、导出、`suite task show` 同口径。
- 旧 `stopping` 行由清扫器按 §9.3 转终态，不回到 `pending`。
- 停止/取消不增加 `attempts`，不触发毒丸计数；只有 `beginExecution` 增加执行次数。

### 9.2 取消入口与权限

| 入口 | 作用域 | 行为 |
|---|---|---|
| 中心面板 `POST /panel/api/tasks/cancel` | 任意项目/主机 | pending 直接 cancelled；claimed/running 置 stopping 并写取消元数据 |
| 中心 CLI `suite task cancel <id> [--host <id> --project <path>]`（带中心 PG） | 任意已归属项目；不带 `--host` 时按本地项目 | 同上 |
| 项目机 CLI `suite task cancel <id>` | 仅本机 host + 本项目 | 同上；写 `cancel_source=local-cli` |
| 项目机 MCP | 仅本机 host + 本项目 | `regression_task_cancel`；写 `cancel_source=local-mcp` |
| runner 自身 | 仅当前任务 | Ctrl-C/设备丢失/超时 → `cancel_source=runner` |
| 手动执行 `suite run --task` | 仅本机 host 且任务由本机领取 | 不满足直接 exit 2（见下） |

- 本地取消先校验 `task.project_id` 对应项目的 `host_id` 是否等于本机；不等于直接拒绝（403/exit 2）。
- **手动执行同款守卫**：`suite run --task` 必须是“本机 host 的项目 + 任务 `target_host_id`/`claimed_host_id` 等于本机”，否则拒绝。否则机器 B 可以用 A 的项目路径在自己的目录上跑 A 的任务，结果回写到 A 的项目行。
- 已终态任务取消：幂等返回当前状态，不覆盖原取消元数据。

### 9.3 在跑任务的取消流程

1. 入口写 `status=stopping` + 取消元数据（先写先赢，CAS）。
2. runner 每 3s 轮询到 `stopping`：
   - 记录 `cancel_source`（保留入口写入的值）；
   - `shouldAbort` 置真，执行器在用例之间中止；
   - 释放设备租约；
   - 状态改 `cancelled`，保留已完成用例的 run 记录与证据。
3. 若 runner 已离线：不能依赖 runner 轮询。由**清扫器**处理（中心 panel/serve 后台循环与任意存活 runner 的主循环都调用同一个幂等函数；CAS 写终态，谁先到谁生效）：
   - `stopping` 且 `cancel_requested_at` 超过宽限（`AOS_CANCEL_GRACE_MS`，默认 90s）+ 领取主机不在线 → 直接 `cancelled`，`cancel_note` 追加 `runner-offline`；
   - 旧版本遗留的 `stopping` 行（无 `cancel_source`）同样在宽限后转 `cancelled`（`cancel_source=panel`，`cancel_note=legacy-stopping`），**不再回 pending 重跑**；
   - runner 恢复后看到已 `cancelled` 的任务不会再执行（`suite run --task` 增加 `cancelled` 拒绝分支）。
   - 清扫器幂等：重复执行只影响第一条 CAS 成功的记录；中心进程全不在时，任何 runner 仍能清。
4. 取消后 runner 主循环继续下一条任务；若队列被暂停则停在暂停态。

### 9.4 审计

`audit_events` 增加 `actor`、`actor_host_id`、`channel` 三列（或复用 `refs` JSON，但独立列更利于查询）：

```sql
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor TEXT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_host_id TEXT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS channel TEXT;
```

取消事件示例：

```
domain=task action=task.cancel result=ok
summary=任务 <id> 由 louis 在 MacBook-Pro（local-cli）取消：设备需要让给手工调试
refs={taskId, source, hostId}
```

## 10. 面板

### 10.1 主机视图

新增 `GET /panel?view=hosts`（或总览页顶部“接入主机”区块）：

- 主机名、`label`/`owner`（已登记时）、`kind`（Mac / PC / Linux）、OS 版本、架构、用户名。
- **双在线状态**：`IDE 在线`（`client_seen_at` 在 `AOS_CLIENT_TTL_MS` 内，显示当前会话数、客户端名、项目）与 `执行机在线`（`isRunnerOnline`，TTL 默认 90s）；两者都离线才显示“离线”。
- **登记与漂移**：未登记 / 已登记；OS、主机名与 `expected_os`/`expected_hostname` 不符时标黄；IP 变化显示“上次 X.X.X.X，变更于 T”；`ip-shared` 警告。
- IP：主地址 + 全部地址 + 来源（自报/观测）；`ip-shared` 警告。
- 能力徽章：iOS 模拟器 / iOS 真机 / Android。
- 工具版本与缺失项（红/黄/绿）。
- 磁盘余量（项目目录所在卷）、CPU/内存。
- 队列：待执行数、运行中任务、暂停开关。
- 项目列表（按主机分组），远端项目标“磁盘不可达（仅台账）”；每个项目显示“最近接入会话”。

### 10.2 项目与下发

- 项目键：`?host=<host_id>&project=<rootPath>`；无 `host` 时先按本地匹配，跨主机同名/同路径歧义 → 409 并列出候选主机。
- 下发表单：先选主机、再选该主机上的项目（不允许“任一机器”），实时显示能力检查结果与队列位置；不满足时禁用提交并给原因。
- 优先级：默认 0，面板可查看；是否允许面板编辑由 `AOS_PANEL_PRIORITY=1` 显式开启（默认只读，避免误操作插队）。
- 任务卡片：目标主机、当前主机、状态时间线、取消来源与操作者。
- 取消按钮：确认框可填备注；中心取消显示为 `panel`。

### 10.3 兼容

- 旧链接 `?project=<rootPath>` 继续可用（本地优先；唯一匹配则直达）。
- 无主机维度的旧数据（`host_id=NULL`）在主机视图里单列“未归属（需 `host adopt-legacy`）”。

## 11. 环境检测清单

采集项（`src/host/env.ts`，纯注入、可测试）：

| 类别 | 字段 |
|---|---|
| 系统 | `os_platform`、`os_release`、`os_version`、`arch`、`hostname`、`username`、`kind` |
| 运行时 | Node 版本、AOS 版本、Python/uv（artemis 依赖） |
| 设备工具 | `adb`（版本/路径）、`xcodebuild`（版本）、`xcrun simctl`（可用）、`idb`（版本）、`idevicesyslog`（可用）、Appium（URL + `/status` 版本） |
| 资源 | CPU 型号/核数、总内存、项目目录所在卷的可用/总空间 |
| 能力 | 由以上推导（§7.2） |

降级：

- 命令超时（默认 5s）或缺失 → `present:false`，不阻断心跳。
- Appium 探测失败 → 记 `appium.present:false` + `error` 摘要；不缓存错误超过一个刷新周期。
- 全部探测结果带 `collected_at`；面板显示“环境快照 N 分钟前”。

`doctor` 增加本机 host/env 段落；`aos_status` 增加 `host`（本机身份）与 `queue`（暂停/待执行/运行中）。

## 12. 接口与命令

### 12.1 CLI

```
suite task create ... [--host <machine_id|hostname> --project <rootPath>] [--priority <n>]
suite task list [--host <id>] [--json]
suite task cancel <id> [--note <text>] [--json]
suite queue status|pause|resume [--host <id>] [--json]
host list|show <id|hostname> [--json]        # 顶层命令，需要中心 PG
host register <id|hostname> [--label <名>] [--owner <人>] [--expected-os darwin|win32|linux] [--expected-hostname <名>]
host adopt-legacy --local [--dry-run|--apply]   # 本机：只认领 root_path 在本机存在的 NULL 行
host adopt-legacy --host <id> --path <rootPath> [--dry-run|--apply]  # 中心：逐项指派
doctor                                        # 增加本机 identity/env
```

- **中心模式**：带 `--host` 的 `suite task create` / `suite task cancel` / `suite queue` 走“仅 PG”路径，不构造 `Runtime`、不 `loadProject`、不写本地 `.artemis`；项目按 `(host_id, rootPath)` 定位。实现上新增一个 `openCenterStore()`（`PostgresStore.create` 即可），命令层不再无条件 `defaultBuildRuntime`。
- 不带 `--host` 的命令保持现状：本地项目 + 本地 Runtime，取消/入队都归属本机。
- `--host` 与 `--project` 必须成对；只给 `--host` 时列出该主机的项目让用户选，不猜。
- 退出码沿用：0 成功、2 用法/权限/状态不合法。

### 12.2 面板 API

```
POST /panel/api/tasks              # 增 targetHostId（由项目派生）
POST /panel/api/tasks/cancel       # { project, host, taskId, note? }
POST /panel/api/queue/pause        # { host, note? }（整机）
POST /panel/api/queue/resume       # { host }
GET  /panel/api/hosts              # 主机列表（只读）
POST /panel/api/hosts/register     # { host, label?, owner?, expectedOs?, expectedHostname? }
```

全部沿用同源校验与 `AOS_PANEL_ACTIONS` 开关；写操作进审计。

### 12.3 MCP 工具

新增 `regression_task_cancel`（单工具）：参数 `taskId`、可选 `note`。作用域限本机 + 本项目；写 `cancel_source=local-mcp`、`cancelled_by=AOS_ACTOR||系统用户名`，并写审计。列表/派发仍走 CLI/面板（MCP 侧不新增大列表工具，避免与面板重复）。

`aos_status` 增加 `host`（本机身份、接入会话、执行机状态）与 `queue`（暂停/待执行/运行中）。

### 12.4 HTTP 客户端记录（低优先级）

若中心同时开 HTTP MCP 入口，新增 `project_clients`：`project_id、ip、user_agent、first_seen_at、last_seen_at、count`。仅展示，不参与派发。形态 B 下默认不启用。

## 13. 兼容与迁移

1. 启动时确保本机 `hosts` 记录存在（`upsertHost`），拿到 `localHostId`；该步骤在每个进程都会执行，但**不自动认领历史数据**。
2. `projects` 增列 `host_id`（允许 NULL）→ 删旧唯一约束 → 建 `(host_id, root_path)` 唯一索引。历史行保持 `host_id=NULL`，面板显示“未归属主机”，不参与定向领取。
3. 归属命令按“本机证据”执行，不做中心统一认领：
   - 在**每台项目机**上运行 `host adopt-legacy --local [--dry-run]`：只认领 `host_id IS NULL` 且 `root_path` 在本机文件系统存在的项目（以及其 runner/任务），写入审计并打印清单；默认 dry-run 需要显式 `--apply`。
   - 中心可对明确清单执行 `host adopt-legacy --host <id> --path <rootPath>...` 逐项指派；**不提供“把所有 NULL 行归到中心”的默认行为**。
   - 两台机器同路径时，先执行的一方拿到历史行；另一方启动时会因其 `host_id` 已非空而创建自己的新行（历史归属以先到者为准，面板显示归属审计）。
4. `runners` 增列 `host_id`/`instance_id`；**保留**旧唯一索引 `(project_id, name)`，新增 `(project_id, host_id)`。旧 runner 继续按旧索引 upsert，不会因 `host_id=NULL` 每次心跳插新行。
5. `regression_tasks` 增列；旧行 `target_host_id=NULL`，按项目行归属领取（与现状一致），不要求主机匹配。
6. 旧 runner 未升级：可领其所属项目的非定向任务；面板标“身份未升级”；`AOS_HOST_STRICT=1` 时完全拒绝。
7. 旧面板 URL：无 `host` 参数时本地优先；跨主机同名/同路径歧义 → 409 并列出候选主机。
8. `stopped` 历史状态读作 `cancelled`；写入只产生 `cancelled`。
9. 所有迁移走 `MIGRATIONS` 的 `ADD COLUMN IF NOT EXISTS` / `DROP ... IF EXISTS`，建唯一索引前先去重（沿用 `runners` 的既有模式）；`adopt-legacy` 是显式命令，不放进 `init()`。
10. **迁移并发与锁**：每台项目机启动都会跑 `MIGRATIONS`。本次包含 `DROP CONSTRAINT`（ACCESS EXCLUSIVE），必须先用 `pg_advisory_lock` 串行化整个迁移过程，拿不到锁等待而不是并发执行；发布说明标注“首次升级选择低峰窗口”，失败可重试（DDL 幂等）。
11. **文件台账/会话内存模式**：`hosts`、`host_addresses`、`host_sessions`、`device_leases`、队列暂停是**中心 PG 专属**。无 PG 时面板显示“单机模式（无中心台账）”，`aos_status.host` 只显示本机 identity/env（接入会话不落库），`host`/`queue` 命令 exit 2 并给出配置指引；`FileStore`/`MemoryStore` 实现返回空集合，不报错。

## 14. 测试策略

不依赖真实 PG/设备/外网：

- **pg-mem**：迁移幂等；`projects` 唯一约束变更；`runners` 身份替换；定向领取；能力门禁；队列暂停；`pending` 取消 CAS；`stopping` 离线回收为 `cancelled`；设备租约冲突/过期/全有或全无；IP 历史 upsert/清理；`host_sessions` 在线判定与 TTL 过期。
- **项目解析**：同 `root_path` 两行时 `getProjectByPath` 不返回任意行（本地未命中报错/歧义报错）；`upsertProject` 不接管 NULL 行；`adopt-legacy --local` 只认领本机存在路径。
- **attempts**：领取不增加；`beginExecution` +1；设备忙释放不增加；毒丸只在执行次数达上限时触发。
- **存活 tick**：长执行（>2×TTL）期间在线判定不变、租约不过期、`last_progress_at` 前进、`attempts` 不增长。
- **双启**：同机同项目第二个实例 23505→读行→退出；陈旧行 CAS 接管。
- **假执行器**：环境探测注入 `platform`/`exec`，覆盖 darwin/win32/linux、工具缺失、命令超时。
- **主机身份**：临时目录写 `host-id`；只读目录退化 `derived`；`AOS_HOST_ID` 覆盖。
- **接入会话**：MCP `initialize` 写会话、30s 空闲 ping、工具调用节流更新、优雅退出写 `ended_at`；无 PG 时静默跳过。
- **CLI**：`suite task cancel/queue/host` 的 exit code 与 JSON 输出；本地取消越权拒绝；`suite run --task` 跨主机拒绝。
- **面板**：双在线状态（IDE/执行机）、能力原因文案、歧义 409、取消来源展示。
- **审计**：取消事件带 actor/channel；面板动作、本地 CLI、本地 MCP 三种来源可区分。
- **事件路由**：`/events/<host>/<project>` 同路径不串台；旧 `host_id=NULL` 事件不参与新路由。

## 15. 分阶段落地

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| P1 可见性 | hosts/host_addresses/host_sessions、身份与环境探测、runner 心跳扩展、本地 MCP 接入心跳、面板主机视图（双在线状态）、doctor/aos_status | IDE 开着但没跑任务也能看到机器/项目/IP；IP 变更不产生新机器 |
| P2 定向下发 | projects.host_id、store 解析带 hostId、runners.host_id、target_host_id、能力门禁、面板/CLI 选机、期望主机登记与漂移提示 | 中心可下发到指定机器；同路径两台机器不串台；iOS 不会投给 Windows；OS/IP 与登记不符时可见 |
| P3 队列控制 | cancelled 状态与取消留痕、队列暂停/恢复、设备租约、统一 30s tick、本地 CLI + MCP 取消 | 待执行可取消、运行中可停、取消后队列继续、来源可追溯 |
| P4 可选 | HTTP 客户端记录、跨主机逻辑项目分组 | 视实际需要 |

每阶段完成即满足仓库完工标准：`npm run build && npm test && npm run lint` 全绿；同步 `DESIGN.md`（新增章节）与 `README.md`（命令/配置）；测试不触网。

## 16. 已定的取舍与待拍板

### 已定（我的取舍，可直接改）

1. **下发必须显式选机**（已确认）：由用户在下发时决定“哪台机器上的哪个项目”，不做“任意满足能力的机器自动挑”。
2. **跨主机用例集按主机独立**：同一 App 在两台机器上各有一份项目行与用例集；以被选中的那台机器上的 `tests.json` 为准，不做跨主机同源校验。需要完全一致时由使用者自行同步 `.artemis/design`；逻辑项目分组本期不做。
3. **并发单位是 runner 进程**：每进程串行；同机多项目靠设备租约互斥；整机串行开关本期不做。
4. **取消终态**：`cancelled`；`stopped` 只读兼容。不改历史数据。
5. **离线取消自动终态**：清扫器（中心或任意存活 runner，幂等 CAS）在宽限后把 `stopping` 转 `cancelled`，不等人回来，也不回 pending 重跑。
6. **无自动过期**：离线主机的待执行任务保留到人工取消；避免“悄悄丢了”。
7. **身份粒度**：`machine_id` + 系统用户名 + `AOS_ACTOR`；不做账号。
8. **IP 双通道**：PG 观测优先；自报保留全部网卡；`ip-shared` 只告警不合并。
9. **本地取消入口**：本期 CLI + MCP 工具 `regression_task_cancel`；面板为中心侧入口。
10. **三层信号**：接入层（MCP 会话）、执行层（runner）、期望层（登记画像）分开建模；下发只用后两层。
11. **队列暂停按整台主机**：面板文案明确影响该机所有项目。
12. **旧 runner**：保留旧唯一索引，允许领其项目的非定向任务并标“身份未升级”；`AOS_HOST_STRICT=1` 可收紧。
13. **历史归属**：不自动认领，用显式 `host adopt-legacy`。
14. **评审修订已并入**：项目解析规则与调用面盘点（§6.9）、历史归属改为按本机路径证据（§13.3）、attempts 单一计数点与设备忙分离（§8.2/§8.3）、执行期统一 tick（§8.4）、手动执行主机守卫（§9.2）、清扫器多点幂等（§9.3）、双启时序（§6.4）、空闲 IDE 心跳（§7.4）、租约原子性与 TTL（§8.3）、迁移 advisory lock（§13.10）、事件入口主机维度（§6.10）。

### 待你拍板

无。若对以上收口无异议，下一步进入实现计划（`writing-plans`），仍不写代码。

## 17. 实现偏差与已知限制（2026-10-21）

P1（可见性）、P2（定向下发）、P3（队列控制）均已落地；P4（HTTP 客户端记录、跨主机逻辑项目分组）不在本期。实现口径以 `DESIGN.md` §13.152–§13.165 为准，本节只记与设计稿的**实际偏差**。

**验证结果**：`npm run build && npm test && npm run lint` 全绿——**1977 tests / 1977 pass / 0 fail**，lint **0 error**（2 条既有 warning：`src/console/pages.ts`、`src/panel/web.ts` 未使用变量）；测试不依赖真实 PG / 设备 / 外网（SQL 用 pg-mem、artemis 用假子进程、Figma 不触网）。

**偏差**

1. **`AOS_HOST_STRICT` 未接线**：设计稿 §13.6/§16.12 的严格模式（拒绝无 `host_id` 的旧 runner）未实现，变量名为保留位、当前无效果。原因：定向任务已由 `target_host_id` 过滤，旧 runner 行不会领到定向任务；严格拒绝会破坏「升级窗口内旧 runner 继续跑非定向任务」的兼容承诺。后续如需强制，可在 `claimRegressionTask` 与本地命令入口补两道守卫。
2. **本地 MCP 接入心跳已创建 `hosts` 行**：`startClientSession` 会 upsert 本机 `hosts`（含 `client_seen_at`/IP），并按 `AOS_CLIENT_PRESENCE_MS` 起 `unref` 空闲心跳；仅开本地 MCP（无 runner）也能在面板看到「IDE 在线」的主机与项目。接入心跳不写 `capabilities`/`env`，因此下发预检对这类主机只告警「尚无执行机上报，任务会排队等待」。
3. **手动 `suite run --task` 不占设备租约**：设计稿 §9.2 只要求主机归属守卫，实际也只做了 `targetHostId`/`claimedHostId` 校验与状态 CAS，未接入 `device_leases`。与同机 runner 并发时可能争用同一设备；需要互斥时先 `suite queue pause`。
4. **面板 HTTP multipart 导入为既有缺陷**（与多机无关）：`http-server` 对 `/panel/api/import` 只设置 `rawBody`，而 `handlePanelActionRequest` 入口要求 JSON 对象 body，故 HTTP 下导入在到达 `runImport` 前即 400；现有测试以同时注入 `body` + `rawBody` 覆盖，掩盖了该路径。本期未修，待单独工单。
5. **文件台账是单主机视图**：`FileStore.adoptProjectHost` 恒 false，项目行恒 `host_id=NULL`；`hosts`/`host_addresses`/`host_sessions`/`device_leases`/队列暂停虽在 File 实现里可读写，但语义上是单机状态文件，不能跨机共享。`host`/`queue` 命令、runner、定时回归、中心清扫均要求中心 PG（无 PG exit 2）。
6. **清扫器作用域**：设计稿 §9.3 写「中心或任意存活 runner」；实现进一步收敛为 HTTP 服务/`panel --web` 用 `allHosts=true` 跨主机清扫，runner 只扫本机。CAS `stopping → cancelled` 保证多个清扫器只成功一次，中心可能先于离线 runner 终结（符合预期）。
7. **旧 runner 行**：`runners.host_id` 为 NULL 的行保留旧唯一索引兼容，可领本项目非定向任务；主机视图按 `runner.host_id` 分组，NULL 行被跳过，不归入任何主机。需升级并在该机重启 runner 后由心跳补齐身份。

**已知限制（设计即如此）**

- 队列暂停为**整机**粒度，无项目级/单任务暂停；同一项目不要混跑新旧 runner。
- 取消是终态：`cancelled`/历史 `stopped` 不复活，重跑需 `rerun` 或新建任务；手动执行不受队列暂停影响。
- P4 的 `project_clients`（HTTP 客户端记录）与跨主机逻辑项目分组（`project_key`）未实现；同一 App 跨主机按两个独立项目处理。
- `suite backfill`、中心任务列表等仍以 `rootPath` 为键；项目历史 id 不可复原，迁移认领须在启动新版进程前完成（见 DESIGN §13.165）。


