# 回归服务 P2 实施计划（runner 心跳 + 自动领取执行 + 产物只读预览）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目机常驻 runner 自动领取中心库中的待执行回归任务、按 P1 同一契约执行回写；面板可见 runner 在线状态与任务实时进度，并经 runner 只读预览项目机产物。

**Architecture:** runner＝项目机常驻进程（`suite runner`）：向中心 PG upsert 心跳（在线＋设备清单）→ 原子领取 pending 任务（置 `claimed`）→ 复用 `suite run --task` 执行（`running`→终态）→ 循环；启动时释放本 runner 的未完成领取。产物服务＝runner 同进程只读 HTTP（限项目 `.artemis`、GET/HEAD、浅目录索引），面板只拼 URL 不取文件（大件仍在项目机）。控制通道全出站（PG），产物通道为项目机入站（LAN，风险标注）。

**Tech Stack:** TypeScript（ESM + NodeNext + strict）、node:http、pg（中心 PG）/ pg-mem（测试）、既有 `suite-command` / `Runtime` / store 抽象。

**Spec:** `docs/superpowers/specs/2026-10-14-regression-service-design.md`（§5.3 记录、§5.4 面板、§5.5 下发与执行、§7 分阶段；§8 待拍板项由本计划拍板，见 Global Constraints）

## Global Constraints

- 测试口径（仓库硬性）：pg-mem、假子进程/假 exec、不触真实 PG/设备/外网；测试跑 `dist/`（改动先 `npm run build`）；单文件 `npm run test:file -- test/xxx.test.js`。
- 相对导入一律带 `.js` 后缀；代码英文、用户文案中文；默认不加注释（仅保留解释非显然契约的 JSDoc）。
- stdout 属于 MCP stdio：runner 日志走 `log()`（stderr）；CLI 子命令输出除外。
- 密钥只存项目 `.env`（或 PG）；日志/响应不落 key。
- 完工标准：`npm run build && npm test && npm run lint` 全绿；行为变更同步 DESIGN.md（新增 §13.109）+ README + AGENTS.md（命令表）。
- **§8 留项拍板（本计划）**：
  - 领取通道＝中心 PG（既有「各项目机直连中心 PG」定论）；原子领取＝单条 `UPDATE ... AND status='pending'` 守卫（不用 `SKIP LOCKED`；竞争者拿 0 行 → 下一轮再领取，不双跑）；**领取条件＝任务 platforms ⊆ runner 在线设备端集合**（缺端不领，避免半意图执行）。代价：双端任务需**单机双端** runner 才能自动领取（本项目拓扑：每项目机 1 iOS＋1 Android，满足）；分机部署（两端分属两台机）时双端任务保持待执行，改用手动 `suite run --task`；按端部分领取列 P3。
  - 心跳＝`runners` 表行 upsert＋TTL 在线判定（`AOS_RUNNER_TTL_MS` 默认 90s）；任务锁＝`claimed_by/claimed_at`＋runner 启动释放（崩溃残留回 pending，可再领取）。**claimed 无自动超时**：管理侧救济＝`suite task release <id>`（默认要求对应 runner 离线，`--force` 跳过；重置 pending 并清领取）；自动超时重置列 P3（契约允许重复执行，重置不伤语义）。
  - runner 形态＝`suite runner` 常驻子命令（`--once` 单轮冒烟）；runner 需要中心 PG（内存 store 拒启并提示）。
  - 产物服务：与 runner 同进程、默认监听 `0.0.0.0`（LAN 预览所需）、只读且限 `<项目>/.artemis` 范围（**含 `logs/` 与 `crashes/`，README/DESIGN 点名标注**）、无鉴权（内网口径）；`--artifact-port 0` 关闭。
  - 「一键下发」语义＝面板创建任务后由在线 runner 自动领取执行，**不新增按钮**；无 runner 时手动 `suite run --task` 路径不变。
  - §8 剩余项沿用现状（不在本计划）：多实例并发迁移（init 幂等 best-effort：`ADD COLUMN IF NOT EXISTS` + logWarn）；`platforms/devices/tools` 为无版本宽容解析 JSON 文本（沿用既有 schema 做法）。

## Review Focus

1. **并发领取**：两个 runner 同时领取同一 pending 任务 → 恰好一个成功（UPDATE 状态守卫），另一个拿 `null` 下轮再试；不得双跑。
2. **产物路径穿越**：`..`、URL 编码、绝对路径、`.artemis` 外文件、符号链接 → 全部拒绝（400/404），不得读到项目外文件。
3. **runner 崩溃重启**：claimed/running 残留 → 启动释放为 pending 可再领取；已登记的部分运行不丢、不双写。
4. **心跳/在线边界**：TTL 恰好到期、时钟偏差（以中心 now 对比 lastSeen，过期即离线）；离线 runner 的任务在面板如实标注「失联」。
5. **手动与自动并存**：任务被领取后仍可手动 `suite run --task`（契约允许重复执行）；两条路径互不阻塞，状态以最后一次完成回写为准。

---

### Task 1: store——`runners` 表与心跳（upsert/list）

**Files:**
- Create: `src/runner/status.ts`
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-runners.test.js`（新）

**Interfaces:**
- Produces：
  ```ts
  // db/types.ts
  export interface RunnerDevice { serial: string; name: string; platform: "ios" | "android"; kind: "device" | "emulator" | "simulator"; state: string; }
  export interface RunnerTools { adb: boolean; idb: boolean; simctl: boolean; ideviceId: boolean; appium: boolean; }
  export interface RunnerRecord {
    id: string; projectId: string | null; name: string; hostname: string;
    platforms: string[]; devices: RunnerDevice[]; tools: RunnerTools;
    artifactBaseUrl: string | null; version: string | null;
    lastSeenAt: string; createdAt: string;
  }
  export interface UpsertRunnerInput { rootPath: string; name: string; hostname: string; platforms: string[]; devices: RunnerDevice[]; tools: RunnerTools; artifactBaseUrl?: string | null; version?: string | null; }
  // ProjectStore 接口新增：
  upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord>;
  listRunners(rootPath: string, limit?: number): Promise<RunnerRecord[]>;
  // src/runner/status.ts
  export const RUNNER_TTL_DEFAULT_MS = 90_000;
  export function runnerTtlFrom(env: NodeJS.ProcessEnv): number;            // AOS_RUNNER_TTL_MS（非法/≤0 → 默认）
  export function isRunnerOnline(lastSeenAt: string, nowMs: number, ttlMs: number): boolean;  // 0 ≤ now-lastSeen ≤ ttl
  ```

- [ ] **Step 1: 写失败测试**（`test/db-runners.test.js`；pg-mem + memory 双跑，MemoryStore 与 `makePgStore` 同测试文件既有两个既有模式）
  - `upsertRunner: 首次落库 + 二次更新同项目同名同一条（id 稳定、devices 覆盖、createdAt 不变、lastSeenAt 变新）`。
  - `devices.name 与 tools 五布尔往返一致；JSON 缺字段 → 宽容解析（tools 全 false、name 空串）`。
  - `upsertRunner: 未注册项目 → 抛错（文案含「未注册」）`。
  - `listRunners: 按 lastSeenAt 新→旧 + limit；空 → []`。
  - `isRunnerOnline: 恰等于 TTL 在线、超 1ms 离线、lastSeen 解析失败离线`；`runnerTtlFrom: 非法值回默认、合法值生效`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/db-runners.test.js`。
- [ ] **Step 3: 实现**
  - DDL（postgres SCHEMA 数组内，字段：id/project_id/name/hostname/platforms/devices/tools/artifact_base_url/version/last_seen_at/created_at，platforms/devices/tools 为 JSON 文本；`project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`）。
  - upsert＝`getProjectByPath` 校验 → SELECT `(project_id, name)` → 命中 UPDATE（last_seen_at/hostname/platforms/devices/artifact_base_url/version）否则 INSERT（id＝`randomUUID()`）；**不用 ON CONFLICT**（pg-mem 兼容；每项目机单 runner，无并发写冲突假设）。
  - memory 同语义（`cloneRunner` 深拷贝 devices）。
  - `status.ts` 纯函数（ISO 解析，非法 → 离线）。
- [ ] **Step 4: 跑测试确认通过** + `npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): runners table with heartbeat upsert (store + TTL helpers)"`

### Task 2: store——任务领取/释放与状态机扩展（claimed）

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`
- Test: `test/db-runners.test.js`（追加）、`test/db-suite-runs.test.js`（旧表迁移用例模式参照既有 runner 列迁移测试）

**Interfaces:**
- Produces：
  ```ts
  // RegressionTaskRecord：status 联合加 "claimed"；新增 claimedBy: string | null; claimedAt: string | null;
  claimRegressionTask(input: { rootPath: string; runnerId: string; platforms: string[] }): Promise<RegressionTaskRecord | null>;
  releaseRegressionTasks(input: { rootPath: string; runnerId: string }): Promise<number>;
  releaseRegressionTask(input: { rootPath: string; runnerId: string; taskId: string }): Promise<boolean>;  // 单任务（执行异常救济）
  // updateRegressionTask patch 扩展：{ status?; runIds?; claimedBy?: string | null; claimedAt?: string | null }
  ```

- [ ] **Step 1: 写失败测试**
  - `claimRegressionTask: 最旧 pending 且任务 platforms ⊆ runner platforms → claimed + claimedBy/claimedAt；缺端/无 pending → null`。
  - `claimRegressionTask: 已 claimed 的任务不被二次领取（先后两个 runner → 第二个拿到 null 或下一个可领任务）`。
  - `releaseRegressionTasks: 仅释放自己的 claimed/running（他人任务不动），返回条数`。
  - `releaseRegressionTask（单任务）：本人 claimed → true 回 pending 清领取；已终态/他人持有 → false 且不动`。
  - `updateRegressionTask: 键缺省不动 / null 显式置空；status-only 更新不清空 claimedBy/claimedAt；createRegressionTask 新行默认 null`。
  - `存量库迁移：旧 regression_tasks 缺 claimed_by/claimed_at → init 补列后领取可用`（旧表模拟见 `test/db-suite-runs.test.js` 的 `noAstCoverageCheck` 用法）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**
  - DDL：`regression_tasks` 加 `claimed_by TEXT, claimed_at TEXT`；MIGRATIONS 追加两条 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。
  - claim（postgres）：`SELECT id, platforms FROM regression_tasks WHERE project_id=$1 AND status='pending' ORDER BY created_at ASC LIMIT 50` → JS 解析 platforms JSON 取首个「任务端 ⊆ runner 端」→ `UPDATE regression_tasks SET status='claimed', claimed_by=$2, claimed_at=$3 WHERE id=$4 AND status='pending' RETURNING *`（0 行 → null，下一轮再试；候选窗 50 降低「头部不匹配饿死」概率）；mapRegressionTask 读两新列。
  - claim（memory）：同逻辑数组实现。
  - release（全部自有）：`UPDATE ... SET status='pending', claimed_by=NULL, claimed_at=NULL WHERE project_id=$1 AND claimed_by=$2 AND status IN ('claimed','running')`；release（单任务，带守卫）：同 SET 但 `AND id=$3`（0 行 → false）；memory 同语义。
  - `createRegressionTask` INSERT 带两列（null）；`updateRegressionTask` 动态 SET：`status`/`runIds` 缺省不动，`claimedBy`/`claimedAt` **仅当 patch 含该键时写入**（`!== undefined`；`null`＝显式置空，缺省不动——**不得**用 `?? null` 写死，否则 status-only 更新会清空领取归因）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): atomic task claim/release with claimed state"`

### Task 3: 设备盘点 `src/runner/inventory.ts`

**Files:**
- Create: `src/runner/inventory.ts`
- Test: `test/runner-inventory.test.js`（新；假 exec，不打真设备）

**Interfaces:**
- Consumes：`resolveAdbPath`、`defaultExec`（`src/device/adb.js`）、`listAdbDevices`（`src/device/logcat.js`）、`listIosSimulators`、`resolveIdbPath`、`classifyIosSerial`（`src/device/ios.js`）。
- Produces：
  ```ts
  export interface RunnerInventory {
    platforms: Array<"ios" | "android">;   // 有设备端的去重、固定序（android → ios）
    devices: RunnerDevice[];
    tools: RunnerTools;                    // 复用 Task 1 类型；appium＝`AOS_APPIUM_URL` 已配置
  }
  export async function collectRunnerInventory(options?: {
    env?: NodeJS.ProcessEnv; exec?: ExecFn; platform?: NodeJS.Platform; timeoutMs?: number;
  }): Promise<RunnerInventory>;
  ```

- [ ] **Step 1: 写失败测试**
  - `adb devices → android 设备（emulator-* kind "emulator"，其余 "device"；offline 行不计；adb 缺失 tools.adb=false 不炸）`。
  - `simctl（darwin）→ 仅 isAvailable 且 state "Booted" 的模拟器（kind "simulator"，name 取自模拟器名）`。
  - `idevice_id -l → 真机 UDID（kind "device"，name 空串；命令缺失/超时 → tools.ideviceId=false 静默跳过）`。
  - `AOS_RUNNER_DEVICES="A,B" → 覆盖全部来源（平台按 classifyIosSerial 判定；未识别项忽略；name 空串）`。
  - `非 darwin → 无 iOS 设备且不调 ios 工具`。
  - `tools：idb 经 resolveIdbPath 探测；appium＝AOS_APPIUM_URL 非空`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/runner-inventory.test.js`。
- [ ] **Step 3: 实现**
  - android：`resolveAdbPath(env, platform)` → `listAdbDevices(exec, adb.path)`。
  - ios（仅 darwin）：`listIosSimulators({env, exec, platform})` 过滤 Booted；`idevice_id -l`（exec `idevice_id`，短超时，输出逐行 UDID）。
  - 覆盖优先：`AOS_RUNNER_DEVICES` 非空 → 仅用逗号分隔值。
  - devices 排序：platform 固定序 → serial 字典序；`platforms` 由 devices 推导。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): device inventory (adb/simctl/idevice_id + env override)"`

### Task 4: 产物只读服务 `src/runner/artifact-server.ts`

**Files:**
- Create: `src/runner/artifact-server.ts`
- Test: `test/runner-artifact.test.js`（新；本机 loopback 服务——不触外网，符合仓库测试口径——+ 临时项目目录）

**Interfaces:**
- Produces：
  ```ts
  export interface RunnerArtifactServer { port: number; close(): Promise<void>; }
  export async function startRunnerArtifactServer(options: {
    projectDir: string; host?: string; port?: number; env?: NodeJS.ProcessEnv;
  }): Promise<RunnerArtifactServer>;   // port=0 → 随机端口（测试）
  ```
- 路由：`GET|HEAD /healthz` → `{"ok":true,"project":"<basename>"}`；`GET|HEAD /artifact/<rel>` → 文件流或浅索引。根＝`<projectDir>/.artemis`（realpath 校验）。

- [ ] **Step 1: 写失败测试**
  - `healthz 200 + project 名`。
  - `文件：内容一致、Content-Type（png→image/png、json/md→text/plain; charset=utf-8）+ X-Content-Type-Options: nosniff；HEAD 同状态无 body`。
  - `目录：浅索引 HTML（文件名转义 `<img onerror>`、不递归、父目录链接、>500 条截断提示；响应带 X-Content-Type-Options: nosniff）`。
  - `穿越拒绝（400/404）：/artifact/../x、/artifact/%2e%2e/x、绝对路径、.artemis 外文件`。
  - `符号链接指向 .artemis 外 → 拒绝`（测试建 symlink）。
  - `POST → 405`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/runner-artifact.test.js`。
- [ ] **Step 3: 实现**
  - `createServer`；rel 逐段 decode 后 `path.resolve(root, rel)`；`root` 与解析目标均尝试 `fs.realpath`（存在时）比对前缀（等于 root 或以 `root + path.sep` 开头），含 `\0` → 400。
  - 文件：`createReadStream` + MIME 表（png/jpg/jpeg/webp/gif→image/*；json/md/txt/log→text/plain; charset=utf-8；xlsx→application/vnd.openxmlformats…；其余 octet-stream）+ `Content-Length`。
  - 目录：单层 `readdir`（父链接；`..` 不越 root）+ `escapeHtml`（`src/util.js`）渲染浅索引。
  - 监听失败（EADDRINUSE）由调用方处理（本模块不吞）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): read-only artifact server (path-guarded, .artemis scope)"`

### Task 5: Runner agent `src/runner/agent.ts`

**Files:**
- Create: `src/runner/agent.ts`
- Test: `test/runner-agent.test.js`（新；MemoryStore 运行时 + 假 executeSuite/inventory）

**Interfaces:**
- Consumes：Task 1–3（store 方法、`collectRunnerInventory`）、`defaultBuildRuntime`（`src/cli-runtime.js`）。
- Produces：
  ```ts
  export interface RunnerAgentOptions {
    projectDir?: string | null;
    name?: string;                       // 默认 os.hostname()
    pollMs?: number;                     // AOS_RUNNER_POLL_MS，默认 5000
    heartbeatMs?: number;                // AOS_RUNNER_HEARTBEAT_MS，默认 30000
    once?: boolean;
    shouldStop?: () => boolean;          // daemon 终止口（默认 () => false；CLI 接 SIGINT/SIGTERM，测试注入）
    artifactBaseUrl?: string | null;
    env?: NodeJS.ProcessEnv;
    buildRuntime?: (projectDir: string | null) => Promise<CliRuntimeBundle>;  // 默认 defaultBuildRuntime
    executeSuite: (argv: string[]) => Promise<number>;   // 必填（CLI 传 runSuiteCommand 闭包；测试传假）
    collectInventory?: () => Promise<RunnerInventory>;   // 默认 collectRunnerInventory(env)
    io?: { log: (line: string) => void; errorLog: (line: string) => void };
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;               // 默认 setTimeout
  }
  export async function runRunnerAgent(options: RunnerAgentOptions): Promise<number>;  // 0 正常结束
  ```
- 语义：启动 → 首轮心跳 upsert（`me`＝返回的 `runners.id`；后续领取/释放均用 id 而非 name）→ `releaseRegressionTasks(me)`（有释放则日志条数）→ **启动并行心跳循环**（独立 async 任务：`while (!stopped) { await sleep(heartbeatMs); await heartbeat(); }`；单次心跳含 inventory 采集（失败沿用上次清单）＋upsert，异常 try/catch 日志后继续，**绝不终止主循环**）→ 主循环：`claimRegressionTask(me, inventory.platforms)` → 命中：日志「领取 <id>（端 …）」→ `executeSuite(["run","--task",id, ...(projectDir?["--project",projectDir]:[]), ...设备 flatMap ["--device", serial]])`（设备＝inventory 中 platform ∈ 任务 platforms，platform 序→serial 序；**执行期间心跳循环持续**——长跑不失联）→ 日志退出码 → 立即下一轮；未命中：`sleep(pollMs)`。**执行器抛错**：`releaseRegressionTask(me, task.id)` 回 pending（已终态则守卫拒绝、不覆盖）＋errorLog＋`sleep(pollMs)`（防热循环）→ 继续。`once` 模式＝单轮（首轮 upsert/release/一次 claim+执行）即返回，不起并行循环；daemon 模式由 `shouldStop()` 终止（返回前置 stopped 并等待心跳循环退出）。

- [ ] **Step 1: 写失败测试**
  - `once：心跳写入 runners（name/hostname/platforms/devices/tools/artifactBaseUrl）`。
  - `once：领取最旧可跑 pending → executeSuite 收到正确 argv（--task/--project/逐 --device）→ 假执行器置终态`。
  - `once：无 pending → 不调用 executeSuite，返回 0`。
  - `once：端不完备的任务不领取（任务 ios+android，runner 仅 android → null）`。
  - `启动释放：预置 claimed/running（claimed_by=me）→ 先释放再领取执行；他人 claimed_by 的不动`。
  - `执行器抛错 → 释放本次领取（回 pending、可被再领取）＋errorLog 有事由＋不中断（shouldStop 终止后返回 0）`。
  - `执行期间心跳持续（daemon 模式）：假 executeSuite 执行中等待心跳 upsert 计数 ≥2 后返回 → 断言期间 lastSeenAt 更新（长跑不失联）`。
  - `心跳异常不终止：upsert 抛错一次 → 日志后循环继续（下一轮恢复）`。
- [ ] **Step 2: 跑测试确认失败**：`npm run test:file -- test/runner-agent.test.js`。
- [ ] **Step 3: 实现**（按「语义」；日志前缀 `[runner]`；心跳循环与主循环共享注入的 `sleep`/`now`，便于测试驱动）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(runner): agent loop (heartbeat + claim + execute + release-on-start)"`

### Task 6: CLI `suite runner`

**Files:**
- Modify: `src/suite-command.ts`（子命令路由/白名单、usage、SuiteCliDeps 增 `runner`/`runnerName` 注入缝、`suite task release`）
- Test: `test/suite-runner-cli.test.js`（新；**勿覆盖既有 `test/suite-runner.test.js`**——那是 figma 执行引擎的测试）、`test/suite-task.test.js`（追加手动路径锁 + release + runner 名传导）

**Interfaces:**
- Consumes：Task 4/5（`startRunnerArtifactServer`、`runRunnerAgent`）。
- Produces：
  ```ts
  // SuiteCliDeps 增（测试注入）：
  runner?: { executeSuite?: (argv: string[]) => Promise<number>; collectInventory?: () => Promise<RunnerInventory>; sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean; };
  runnerName?: string;   // 登记透传：suite run 的 suite_runs.runner＝该名（缺省 hostname；run-registry 注入缝已存在）
  ```
- 用法：
  ```
  aos-mcp suite runner [--name <n>] [--poll-ms n] [--heartbeat-ms n]
                       [--artifact-port n（0 关闭；默认 AOS_RUNNER_ARTIFACT_PORT 或 8770）]
                       [--artifact-host h（默认 AOS_RUNNER_ARTIFACT_HOST 或 0.0.0.0）]
                       [--once] [--project <dir>]
  aos-mcp suite task release <taskId> [--force]   # 管理侧救济：claimed/running → pending 并清领取
  ```
  - `store.kind !== "postgres"` → `io.errorLog("runner 需要中心 PG（当前为内存存储）；请配置 MOBILE_TESTING_DATABASE_URL")` + return 2。
  - artifact 服务：port≠0 时启动；`EADDRINUSE` → errorLog 警告并继续（不阻断执行），**此时心跳 `artifactBaseUrl=null`（不广播死链）**；正常启动时 baseUrl＝`AOS_RUNNER_ADVERTISE_URL` 或 `http://${os.hostname()}:${port}`；结束 close。
  - `executeSuite` 闭包＝`(argv) => runSuiteCommand(argv, { buildRuntime: deps.buildRuntime, log, errorLog, env, runnerName })`（runnerName 透传至登记：suiteRunTask/persistRunRegistration → registerSuiteRun({ runner })）。
  - 信号：CLI 装 SIGINT/SIGTERM → `shouldStop()` 置位；agent 返回后 close 服务（graceful）。
  - `suite task release <taskId>`：任务 claimed/running 且 claimedBy 对应 runner 离线 → 重置 pending 清领取；runner 在线且未 `--force` → errorLog + exit 2；未知任务 → exit 2。（复用 Task 2 的 `releaseRegressionTask`？否——管理侧不受 runnerId 限制，用 `updateRegressionTask` 的 status+claimedBy/At 显式置空路径。）
- [ ] **Step 1: 写失败测试**
  - `usage 列出 runner 与 task release；--poll-ms abc → exit 2`。
  - `内存 store → exit 2 且提示中心 PG`（buildRuntime 注入 memory runtime）。
  - `--once 冒烟（pg-mem store + 假 executeSuite/inventory）：exit 0；runners 有行；pending 被领取并执行`。
  - `--artifact-port 0 → 不监听`；`端口被占 → 警告、继续执行、runners.artifactBaseUrl 为 null`（先占位监听同端口）。
  - `runner 名传导：deps.runnerName='r1' → suite run --task 子运行 suite_runs.runner='r1'（缺省 hostname）`。
  - `task release：离线 runner 持有的 claimed → 回 pending 清领取；runner 在线未 --force → exit 2 不动；--force → 强制重置；未知任务 → exit 2`。
  - `claimed 任务手动可执行：预置 claimed 任务 → suite run --task 正常跑完并置终态（不因 claimed 阻塞；契约锁，放 test/suite-task.test.js）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（数值 flag >0 校验否则 exit 2；`--once`/`shouldStop` 透传；`runnerName` 穿线至 `registerSuiteRun` 调用点）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(suite): runner subcommand (daemon wiring, PG guard, artifact server)"`

### Task 7: 面板——runner 区块与任务实时进度

**Files:**
- Modify: `src/panel/overview.ts`、`src/panel/web.ts`
- Test: `test/panel-overview.test.js`、`test/panel-web.test.js`

**Interfaces:**
- Produces：
  ```ts
  export interface PanelRunnerView {
    name: string; hostname: string; online: boolean; lastSeenAt: string;
    platforms: string[]; devices: RunnerDevice[]; artifactBaseUrl: string | null;
  }
  // PanelProjectDetail 增 runners: PanelRunnerView[]（online＝isRunnerOnline(lastSeenAt, now, runnerTtlFrom(env))；含 tools）
  // PanelTaskDetail 增 runner: PanelRunnerView | null（按 task.claimedBy＝runners.id 匹配；无匹配 → null，页面显示原值+「未知执行机」）
  // claimedBy/claimedAt 取 detail.task（Task 2 已有；不另加顶层字段）
  ```
  任务状态标签（web.ts）：pending 待执行 / claimed 已领取 / running 执行中 / completed 已完成 / partial 部分失败 / failed 失败。
- 渲染：
  - 项目页 section「执行机（runner）」：名称/主机/在线/设备（`platform:name(serial)` chips）/工具状态（adb/idb/appium 布尔徽标）/最后心跳/产物基址；**存在 runner 时项目页挂 `<meta http-equiv="refresh" content="30">`**（在线灯不陈旧；无 runner 时不挂）。
  - 任务页：状态标签 + claimedBy（该 runner 在线/失联）+「共 N 个子运行」；pending/claimed/running 时 `<meta http-equiv="refresh" content="10">`；执行指引行改为「在线 runner 会自动领取执行；也可手动 `node dist/cli.js suite run --task <id> --device <serial>`」；**pending 且在线 runner 均无端覆盖（无单台 runner 满足「任务端 ⊆ 设备端」）时补提示行**：说明双端任务需单机双端 runner / 可手动执行。
- [ ] **Step 1: 写失败测试**
  - `panel-overview: runners 聚合（注入 now 控在线；无 runner → []）`。
  - `panel-overview: buildPanelTaskDetail claimedBy/claimedAt + runner 匹配（无匹配 → null）`。
  - `panel-web: 项目页 runner 区块（在线灯/设备 chips/工具徽标）；有 runner 挂 meta refresh 30、无 runner 不挂`。
  - `panel-web: 任务页 claimed 展示 + 活跃态有 meta refresh、completed 无`。
  - `panel-web: pending 任务且无单台在线 runner 端覆盖 → 提示行；有覆盖（或离线）→ 无提示`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（复用 `listRunners`/`isRunnerOnline`/`runnerTtlFrom`；`PanelDeps.now` 既有）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): runner status block + live task progress"`

### Task 8: 面板——产物链接（经 runner 只读预览）

**Files:**
- Modify: `src/panel/overview.ts`、`src/panel/web.ts`
- Modify: `src/suite-command.ts`（`persistRunManifest` 返回保存路径；`persistRunRegistration`/`registerRunBestEffort` 透传 `manifestPath` → `suite_runs.manifest_path` 落库——此前该列无写入方、恒 null）
- Test: `test/panel-overview.test.js`、`test/panel-web.test.js`、`test/suite-task.test.js`、`test/suite-command.test.js`、`test/runner-artifact.test.js`（追加缝测试）

**Interfaces:**
- Produces：
  ```ts
  // PanelTaskRunView 增 artifacts: { manifestUrl: string | null }
  // PanelTaskDetail.refs[] 增 jsonUrl: string | null; xlsxUrl: string | null
  // PanelReviewItem 增 evidenceUrl: string | null
  ```
  规则（overview.ts 纯函数）：路径在 `<rootPath>/.artemis` 前缀内且 `runner.artifactBaseUrl` 非空 → `baseUrl + "/artifact/" + rel`（**rel 相对 `.artemis` 计算**：`path.relative(path.join(rootPath, ".artemis"), abs)`，逐段 `encodeURIComponent`；`..`/绝对/越界 → null）；否则 null（面板照旧渲染本地路径文本）。服务根与服务端（Task 4）一致，URL 中不含重复 `.artemis`。
  - task 页：manifestUrl/refs 的 jsonUrl/xlsxUrl 渲染为链接（`target="_blank" rel="noreferrer"`）。
  - 归因队列：evidenceUrl 非空 → 「打开证据」链接（trace 目录浅索引）；否则现状两态文本。
- [ ] **Step 1: 写失败测试**
  - `overview: manifestPath 在 .artemis 内 + runner 基址 → manifestUrl 分段编码正确且不含重复 `.artemis`；无基址/越界 → null`。
  - `web: 任务页链接渲染（新窗口）；无 runner → 纯路径`。
  - `web: 归因队列「打开证据」在有/无 runner 下的两态`。
  - `manifest_path 落库：`suite run --task` 与普通 `suite run` 登记后 runs[*].manifestPath 非空且文件存在；`--no-save`/`AOS_SUITE_RUNS=0` 时 null（suite-task 与 suite-command 各 1 条）`。
  - `端到端缝（必加）：URL 构建纯函数 → 对真实 loopback 产物服务 GET → 200 且内容一致（临时项目、端口 0；放 test/runner-artifact.test.js——覆盖「面板拼出的 URL 打到真实服务」的跨任务缝）`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（URL 构建纯函数导出供测试；全字段 escapeHtml；manifestPath 透传按 Files 说明接线，`persistRunManifest` 失败/跳过 → null 不阻断登记）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(panel): artifact links via runner read-only preview"`

### Task 9: 文档 + 全量回归

**Files:**
- Modify: `DESIGN.md`（新增 §13.109）、`README.md`、`AGENTS.md`
- [ ] **Step 1: 全量回归**：`npm run build && npm test && npm run lint` → 全绿（记录新增测试数与总数）。
- [ ] **Step 2: 文档**
  - DESIGN §13.109：P2 实施记录（runners 表；claim 状态守卫与 release-on-start；状态机加 `claimed`；`suite runner` 参数与 `AOS_RUNNER_*` 一览；产物服务范围/默认 0.0.0.0/无鉴权风险标注；「一键下发」＝创建即自动领取；§8 拍板项与剩余项沿用说明）；口径 bullet（领取条件子集语义、TTL、产物路径规则、claimed 救济＝`suite task release`（无自动超时，自动超时列 P3）、多实例并发迁移沿用 best-effort）。
  - README：「项目机 runner」小节（启动命令、环境变量（含 `AOS_RUNNER_ADVERTISE_URL`——LAN 无 DNS 时用 IP）、设备盘点与 `AOS_RUNNER_DEVICES` 真机覆盖、**同名 runner 勿双开**（会互相领取/释放）、产物预览与风险（**点名 `.artemis/logs`、`.artemis/crashes` 暴露**；双端任务需单机双端 runner，分机部署走手动）、`suite task release` 救济、无 runner 时手动路径仍在）；面板章节补 runner 区块与产物链接说明。
  - AGENTS.md：命令表「测试闭环（CLI）」行加 `suite runner` 与 `suite task release`；关键机制速查补 runner 心跳/领取一行。
- [ ] **Step 3: 提交**：`git commit -m "docs: regression service P2 (runner dispatch + artifact preview)"`

---

## 范围外（另立计划）

- 说明：设计 §7 的 P2 清单项「统计下钻」**已由 P1c 交付**（`?view=stats`，DESIGN §13.108）；本计划 P2 交付「心跳＋自动领取＋实时进度＋产物只读预览」。claimed 自动超时重置、按端部分领取、真机 iOS 自动发现增强（Appium/devicectl 探测）、runner 自更新、单机多项目 runner 均列 P3。
- **P3**：改进出口自动化（生成反馈联路、环境清单、Jira 自动建单）、定时回归、跨项目对比；动作层/产物服务鉴权升级。
