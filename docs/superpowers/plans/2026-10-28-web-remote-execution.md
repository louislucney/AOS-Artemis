# Web Remote Execution Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把网页测试任务从控制台下发到远端执行机的具体设备，执行机按设备并行领取、下载资产、安装 APK/IPA、运行 Maestro 脚本并回传逐用例结果，中心聚合后写回 Excel。

**Architecture:** 现有项目级 `runners`/`regression_tasks` 不要求执行机预存项目目录，因此新增 host-level `web_runners` 注册表，并给 `regression_tasks` 增加 `job_spec`/`device_serial`/`device_lease_id` 与全局 `claimWebJob`。下发时按硬要求过滤、型号/系统版本打分选 host + device，并预占 `device_leases`；执行机为每台设备起一个 worker，领取绑定到该 host/serial 的任务，按 sha256 CAS 下载资产、安装、执行、上传结果。现有 Plan 1 的 Excel 写回引擎负责中心侧写回。

**Tech Stack:** TypeScript ESM/NodeNext、node:test、exceljs（已有）、现有 Memory/File/PostgreSQL store、pg-mem 测试、现有 `device_leases`/runner 心跳/取消语义。

**Spec:** `docs/superpowers/specs/2026-10-28-web-project-test-platform-design.md`

## Global Constraints

- TS ESM strict，相对导入一律 `.js`；不新增第三方依赖。
- 测试必须 hermetic：Memory/File store + 临时目录；PG 用 `pg-mem`；不连接真实设备、真实 PG、外网。
- 不改 `artemis` submodule；不把 `artemis` 加入提交。
- 所有 store 变更同时实现 Memory/File/PostgreSQL；PG 迁移走现有 `MIGRATIONS`。
- 服务端日志走 `log()`（stderr）；CLI 输出除外。
- 所有写动作走现有 `X-AOS-Console`、角色、审计；runner 上传走独立 token。
- 每个任务结束提交；最终 `npm run build && npm test && npm run lint` 全绿，lint 允许既有 warning。
- **本计划只做 Maestro 执行链路**；`executionMode=llm` 保留类型与占位，生产接线留给 Plan 2（需要 Excel→taskDesc/脚本生成）。Plan 3 的 E2E 使用手工/上传的 Maestro 脚本 bundle。
- 任务状态不静默成功：无设备、租约冲突、下载校验失败、安装失败、脚本失败、结果上传失败都必须有明确状态和原因。

## Review Focus

- **同一设备并发**：同一 `host_id + serial` 的任何时刻只能有一个任务持有有效租约；预占、领取、续租、释放、过期回收五条路径都必须原子。
- **下发后环境变化**：选机时在线、领取时离线；设备被别的任务占用；租约过期。自动选机必须回池重选，手动选机必须等待并告警，不能静默改派。
- **资产完整性**：下载文件必须按 sha256 校验；CAS 缓存命中也要校验；校验失败不能安装，不能把损坏文件留下。
- **结果耐久性**：中心确认结果已持久化之前，执行机不能把任务标记成功；上传失败要保留本地结果并重试。
- **能力缺失降级**：心跳没有 model/osVersion 时，软偏好不可用，只能按硬要求匹配；不能把未知当匹配。

---

### Task 1: 设备 inventory 增加型号/系统版本

**Files:**
- Modify: `src/db/types.ts` (`RunnerDevice`, `RunnerTools`)
- Modify: `src/device/ios.ts` (`IosSimulator` / `parseSimulators`)
- Modify: `src/runner/inventory.ts`
- Test: `test/runner-inventory.test.js`

**Interfaces:**
- Consumes: existing `collectRunnerInventory({ exec, platform, env })`.
- Produces: `RunnerDevice` 增加 `model: string | null`、`osVersion: string | null`；`RunnerTools` 增加 `maestro: boolean`、`devicectl: boolean`；Android 从 `getprop ro.product.model` / `ro.build.version.release`，iOS 模拟器从 `simctl list -j` 的 runtime/name，iOS 真机从 `ideviceinfo -k ProductType` / `ProductVersion`；`maestro --version` / `xcrun devicectl --version` 探测工具。探测失败一律 `null`/`false`，不抛错。

- [ ] **Step 1: Write the failing tests**

在 `test/runner-inventory.test.js` 增加：
- Android `exec` fake 对 `getprop ro.product.model` 返回 `Pixel 7`、`getprop ro.build.version.release` 返回 `14`；断言 device.model/osVersion。
- iOS 模拟器 JSON 含 `com.apple.CoreSimulator.SimRuntime.iOS-17-2` 与 name `iPhone 15`；断言 model `iPhone 15`、osVersion `17.2`。
- `ideviceinfo` 缺失/失败时 `model=null, osVersion=null`，设备仍保留。
- `maestro --version`/`xcrun devicectl --version` 可用时 tools.maestro/devicectl 为 true；失败为 false，不影响其他工具。
- `AOS_RUNNER_DEVICES` 覆盖路径的 model/osVersion 为 `null`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/runner-inventory.test.js`
Expected: FAIL，`model`/`osVersion` undefined 或断言失败。

- [ ] **Step 3: Implement inventory probes**

在 `RunnerDevice` 增加两个可空字段。`src/runner/inventory.ts` 增加 `probeAndroidDeviceMeta` 与 `probeIosDeviceMeta`；所有命令 5s 超时，失败返回 null。`parseSimulators` 从 runtime key 解析 `osVersion`（`iOS-17-2` → `17.2`），保留 `IosSimulator.runtime` 可选字段。真实 iOS 用 `ideviceinfo -u <serial> -k ProductType`/`ProductVersion`；工具不存在时静默降级。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/runner-inventory.test.js`
Expected: PASS（含既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/device/ios.ts src/runner/inventory.ts test/runner-inventory.test.js
git commit -m "feat: report device model and os version from runner inventory"
```

---

### Task 2: 下发要求与选机打分

**Files:**
- Create: `src/web/dispatch.ts`
- Test: `test/web-dispatch.test.js`

**Interfaces:**
- Consumes: `RunnerDevice`, `RunnerTools`, `DeviceLeaseRecord` from `src/db/types.js`; `isRunnerOnline` from `src/runner/status.js`.
- Produces:
  - `WebDeviceKind = "device" | "simulator" | "any"`
  - `WebDispatchRequirements { platform: "android" | "ios"; deviceKind: WebDeviceKind; deviceModel?: string[]; osVersion?: { min?: string; max?: string }; tools?: Array<"adb" | "idb" | "simctl" | "ideviceId" | "appium" | "maestro" | "devicectl"> }`
  - `WebAssignmentRequest { assignment: "auto" | "manual"; targetHostId?: string | null; deviceSerial?: string | null; requirements: WebDispatchRequirements }`
  - `WebRunnerCandidate { id: string; hostId: string; hostname: string; platforms: string[]; devices: RunnerDevice[]; tools: RunnerTools; lastSeenAt: string }`
  - `selectWebAssignment(input: { runners: WebRunnerCandidate[]; leases: DeviceLeaseRecord[]; request: WebAssignmentRequest; nowMs: number; runnerTtlMs: number; rng?: () => number }): { ok: true; hostId: string; deviceSerial: string; score: number; reasons: string[] } | { ok: false; code: "no-runner" | "no-device" | "host-offline" | "device-busy" | "requirements-unmet"; message: string }`

- [ ] **Step 1: Write the failing tests**

`test/web-dispatch.test.js` 覆盖：
- 硬过滤：Android 任务不会选 iOS runner；`deviceKind=simulator` 不会选真机；缺 `maestro` 工具不选。
- 软偏好：同平台两台设备，`deviceModel=["iPhone 15"]` 时 iPhone 15 分数高于 iPhone 14；OS 版本更接近 `min` 的分数更高；缺失 model/osVersion 仍可被选但分数低。
- 指定 host：只在该 host 的设备里选；host 离线返回 `host-offline`。
- 指定 device：serial 不属于 host 返回 `requirements-unmet`；被有效 lease 占用返回 `device-busy`。
- 自动无候选返回 `no-device`；多个同分用注入 rng 固定结果。
- 过期 lease（`expiresAt <= now`）不阻塞。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-dispatch.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: Implement matching/scoring**

实现硬过滤函数 `deviceMeetsHardRequirements` 与打分函数 `scoreDevice`：
- hard：online、platform、deviceKind（`any` 除外）、tools 全部存在、lease 未过期且 taskId 不是本任务。
- soft：model 精确 +20、同系列（前缀） +10；OS 精确/满足 min/max +5，越接近 min +3；缺失不加分。
- 指定 host/device 先过滤；auto 在全池按 score 降序，同分用 `rng()` 选择。
- 返回 `reasons` 用于面板解释；失败返回 code + message。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-dispatch.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web/dispatch.ts test/web-dispatch.test.js
git commit -m "feat: score and select web execution host and device"
```

---

### Task 3: host-level web runner 注册表

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/file.ts`
- Modify: `src/db/postgres.ts`
- Test: `test/web-runner-store.test.js`

**Interfaces:**
- Consumes: `RunnerDevice`, `RunnerTools`, `isRunnerOnline`.
- Produces:
  - `WebRunnerRecord { id; hostId; name; hostname; platforms; devices: RunnerDevice[]; tools: RunnerTools; artifactBaseUrl: string | null; version: string | null; instanceId: string; lastSeenAt: string; createdAt: string }`
  - `upsertWebRunner(input: Omit<WebRunnerRecord, "id" | "createdAt" | "lastSeenAt"> & { lastSeenAt?: string; activeWithinMs?: number }): Promise<WebRunnerRecord>`
  - `listWebRunners(): Promise<WebRunnerRecord[]>`
  - `getWebRunner(hostId: string): Promise<WebRunnerRecord | null>`
  - `markWebRunnerStopped(input: { hostId: string; instanceId: string; at?: string }): Promise<boolean>`
  - 同一 host 只保留一行；新实例在旧实例仍活跃时抛 `WebRunnerAlreadyActiveError`（复用 `RunnerAlreadyActiveError` 语义）。

- [ ] **Step 1: Write the failing tests**

`test/web-runner-store.test.js` 用 Memory、File（临时目录）、pg-mem 三套：
- upsert 新 host → list 1 行。
- 同 host 心跳更新 devices/tools/lastSeenAt，不新增行。
- 新 instance 在 TTL 内 upsert → `WebRunnerAlreadyActiveError`；TTL 过期后可接管。
- `markWebRunnerStopped` 把 lastSeenAt 置纪元，`isRunnerOnline` 为 false。
- File store 重启后仍能读到。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-runner-store.test.js`
Expected: FAIL，方法/表不存在。

- [ ] **Step 3: Implement store**

PG 新增 `web_runners` 表（`host_id` 唯一、`instance_id`、devices/tools JSON、last_seen_at）与迁移。Memory 增加 `webRunners` 数组；File 放进 host 级 state 并持久化。`upsertWebRunner` 以 host 为键；`activeWithinMs` 默认复用 `RUNNER_ACTIVE_DEFAULT_MS`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-runner-store.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/db/file.ts src/db/postgres.ts test/web-runner-store.test.js
git commit -m "feat: add host-level web runner registry"
```

---

### Task 3b: Web 资产类型（package / materials / scripts）

**Files:**
- Modify: `src/db/types.ts` (`WebAssetKind`)
- Modify: `src/web/assets.ts`
- Modify: `src/panel/actions.ts`（上传 kind 白名单）
- Test: `test/web-asset-kinds.test.js`

**Interfaces:**
- Consumes: `storeWebAsset`/`listWebAssets`（Plan 1）。
- Produces:
  - `WebAssetKind = "excel" | "materials" | "package" | "scripts"`。
  - `webAssetMaxBytes(kind): number`：excel 20MB、materials 50MB、package 500MB、scripts 20MB；`WEB_ASSET_MAX_BYTES` 保留为 excel 旧常量。
  - `storeWebAsset` 支持 `package`（`.apk`/`.ipa`）、`materials`（`.zip`/`.json`/`.csv`/`.txt`）、`scripts`（`.zip`）；扩展名大小写不敏感；文件名仍只取 basename。
  - package 上传不要求中心解析 AndroidManifest/Info.plist；`metadata` 先留空，包名/版本由项目 `appPackage` + runner 安装后回报（见 Task 8）。

- [ ] **Step 1: Write the failing tests**

`test/web-asset-kinds.test.js`：
- package `.apk`/`.ipa` 可上传；excel `.apk` 被拒；scripts `.yaml` 被拒（必须 zip）；materials 允许的类型通过。
- 超过 kind 上限拒绝；上限边界值通过。
- 同 sha 重复上传产生新 version 行但复用 CAS 文件。
- 未知 kind/路径穿越文件名被拒。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-asset-kinds.test.js`
Expected: FAIL，package/materials/scripts 仍被 `unsupported-kind` 拒绝。

- [ ] **Step 3: Implement kind whitelist + per-kind size**

扩展 `EXTENSIONS_BY_KIND` 与 `WEB_ASSET_MAX_BYTES` 逻辑；面板上传 action 接受 `kind` 并映射 typed 400。不要放宽路径校验。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-asset-kinds.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/web/assets.ts src/panel/actions.ts test/web-asset-kinds.test.js
git commit -m "feat: accept package materials and script bundle assets"
```

---

### Task 4: web job 队列与下发预占

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/file.ts`
- Modify: `src/db/postgres.ts`
- Create: `src/web/job-spec.ts`
- Create: `src/web/jobs.ts`
- Test: `test/web-job-queue.test.js`

**Interfaces:**
- Consumes: `selectWebAssignment` (Task 2), `acquireDeviceLeases`/`releaseDeviceLeases`, `createRegressionTask`, `claimWebJob`; Plan 1 `WebAssetRecord`/`WebProjectRecord`.
- Produces:
  - `WebJobSpec { kind: "web-test"; assignment: "auto" | "manual"; targetHostId: string | null; deviceSerial: string | null; requirements: WebDispatchRequirements; deviceLeaseId: string | null; excelAssetId: string; packageAssetId: string; materialsAssetId: string | null; scriptSetId: string | null; executionMode: "maestro" | "llm"; caseFilter: { modules: string[]; caseIds: string[] }; retry: number; allowStaleScript: boolean; allowPartialUnresolved: boolean; assetSnapshot: WebAssetSnapshot[]; reassignCount?: number }`
  - `WebAssetSnapshot { kind: "excel" | "package" | "materials" | "scripts"; id: string; sha256: string; filename: string }`
  - `deviceLeaseId` 使用现有租约主键 `"<hostId>:<serial>"`（`device_leases` 无独立 id 列）；runner 以 `deviceSerial` + `targetHostId` 校验，不依赖独立租约 id。
  - `RegressionTaskRecord` 增加 `jobSpec: Record<string, unknown> | null`、`deviceSerial: string | null`、`deviceLeaseId: string | null`；`CreateRegressionTaskInput` 同名可选字段。
  - `claimWebJob(input: { runnerId: string; hostId: string; deviceSerial: string; instanceId: string }): Promise<{ task: RegressionTaskRecord; rootPath: string } | null>` 全局原子领取：只命中 `status='pending'`、`job_spec IS NOT NULL`、`target_host_id=$hostId`、`device_serial=$serial` 的最旧任务；`FOR UPDATE SKIP LOCKED`（Memory/File 用单线程互斥）。
  - `listPendingWebJobs(): Promise<Array<{ task: RegressionTaskRecord; rootPath: string }>>`：全局只读 pending + job_spec 列表，供回池/面板使用。
  - `createWebJob(input: { rootPath; assignment; targetHostId?; deviceSerial?; requirements; excelAssetId; packageAssetId; materialsAssetId?; scriptSetId?; executionMode; caseFilter; retry?; priority?; createdBy? }): Promise<{ task: RegressionTaskRecord; assignment: { hostId; deviceSerial; score } }>`
  - `releaseWebJob(input: { rootPath; taskId; reason: "cancelled" | "expired" | "reassign" }): Promise<boolean>`
  - `assignPendingWebJobs(input: { nowMs; runnerTtlMs: number }): Promise<number>`：给 `device_serial IS NULL` 的 pending web job 选设备并预占；auto 任务在全池重选，manual 任务只选目标 host 的设备；无候选保持 pending 并记录原因。
  - `reassignExpiredWebJobs(input: { nowMs; leaseTtlMs: number }): Promise<number>`：清理预占过期/目标 runner 离线的 pending 任务；auto 任务释放 lease、清空 `targetHostId` + `deviceSerial`，回到全局池重新选机；manual 任务保留 `targetHostId`、清空 `deviceSerial`，只在该 host 上线后重选；记录 `reassignCount`/最近原因，超过上限升级告警但仍不静默改派。

- [ ] **Step 1: Write the failing tests**

`test/web-job-queue.test.js`（Memory + pg-mem）：
- 自动下发：两台在线 runner，iPhone 15 与 Pixel 7；iOS 任务只选 iPhone；写 `jobSpec.targetHostId/deviceSerial`，并生成有效 device lease。
- 指定 host + device：校验归属；被 lease 占用返回 `DeviceLeaseBusyError`/typed 409。
- 指定 host 不指定 device：在同一 host 上选分数最高的空闲设备。
- `claimWebJob` 只允许对应 host/serial；两台 worker 同时 claim → 一台成功一台 null；重复 claim 幂等返回 null。
- 自动任务预占 TTL 过期 + runner 离线 → `reassignExpiredWebJobs` 释放并重选；手动任务保持 pending 且返回告警原因。
- 手动指定 host 离线时允许创建 pending（无 device/lease）；host 上线后 `assignPendingWebJobs` 选设备并预占，随后可 claim。
- 无候选时 pending 原因可见；候选出现后 `assignPendingWebJobs` 完成绑定。
- 取消任务释放 lease。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-job-queue.test.js`
Expected: FAIL，字段/方法不存在。

- [ ] **Step 3: Implement schema + service**

PG 给 `regression_tasks` 增加 `job_spec TEXT`、`device_serial TEXT`、`device_lease_id TEXT`；Memory/File 记录字段。`createWebJob`：先 `selectWebAssignment`；manual host 离线时允许创建 pending（`targetHostId` 已写、`deviceSerial` 为空），在线时创建 task 后 `acquireDeviceLeases({ hostId, taskId, projectId, serials:[serial], ttlMs: reservationTtl })`；lease 冲突则回滚 task/lease 并返回 typed 409。`assignPendingWebJobs` 扫描 `device_serial IS NULL` 的 pending web job，按 auto/manual 规则选设备并预占。`claimWebJob` 原子更新 `status=claimed/claimed_by/claimed_at`；返回 `rootPath`（PG join projects；Memory/File 查 registry）。`reassignExpiredWebJobs` 用 `listPendingWebJobs` 全局扫描 pending 且 `job_spec` 非空。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-job-queue.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/db/file.ts src/db/postgres.ts src/web/jobs.ts test/web-job-queue.test.js
git commit -m "feat: dispatch web jobs with device reservation and central claim"
```

---

### Task 5: web runner agent 与按设备 worker

**Files:**
- Create: `src/runner/web-agent.ts`
- Modify: `src/cli.ts`
- Test: `test/web-runner-agent.test.js`

**Interfaces:**
- Consumes: `collectRunnerInventory`, `upsertWebRunner`, `markWebRunnerStopped`, `claimWebJob`, `beginExecution`, `updateRegressionTask`, `releaseRegressionTask`, `renewDeviceLeases`, `releaseDeviceLeases`; Task 6/7 executor.
- Produces:
  - `runWebRunner(options: { centralStore: ProjectStore; name: string; artifactBaseUrl?: string | null; heartbeatMs?: number; once?: boolean; exec?: ExecFn; env?: NodeJS.ProcessEnv }, io: { log; errorLog }, deps?: { collectInventory?; executeJob?; sleep?; now? }): Promise<number>`
  - CLI: `node dist/cli.js web-runner --name <name> [--artifact-base-url <url>] [--once]`；只连中心 PG（`MOBILE_TESTING_DATABASE_URL` 或现有中心环境变量），不要求项目目录。
  - 每个设备一个 worker；同一 `serial` 同时只有一个 active job。心跳每 30s 更新 `web_runners`，并 best-effort 调用 `assignPendingWebJobs` / `reassignExpiredWebJobs`（多 runner 幂等）；优雅退出 `markWebRunnerStopped` 并释放本实例领取。

- [ ] **Step 1: Write the failing tests**

`test/web-runner-agent.test.js` 用 fake store/inventory/execute：
- 两台设备 → 两个 worker 各 claim 一条绑定到自己的任务，并并行执行（用 deferred 控制交错）。
- 同一 serial 的第二条任务不会被同 worker 同时领取。
- 心跳更新 runner 行，并触发 pending 任务选设备/过期回池；`--once` 执行一轮后退出。
- 执行前本地二次校验：设备已被占用/掉线 → 释放 claim/lease 并返回 `device-busy`/`device-unavailable`，中心回池或等待；不执行。
- 执行异常 → `releaseRegressionTask(to:"pending")` 并释放 lease；不把任务留 running。
- 优雅停止 → runner 行 lastSeen 置纪元。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-runner-agent.test.js`
Expected: FAIL，模块/CLI 不存在。

- [ ] **Step 3: Implement agent**

`runWebRunner`：
1. `collectRunnerInventory`；`upsertWebRunner`。
2. 每个 device 启动一个 async worker：循环 `claimWebJob({hostId, deviceSerial})`；命中后重新读取本地设备状态，设备不可用则释放 claim/lease 并记录 `device-busy`/`device-unavailable`；可用则 `beginExecution`，调用 `executeJob`，成功/失败都 `updateRegressionTask` 并 `releaseDeviceLeases`；空转 sleep。
3. 心跳循环续 `upsertWebRunner` + `renewDeviceLeases`。
4. `once` 模式等待当前 worker 一轮后返回。
CLI 解析与 `suite runner` 一致，输出到 stderr。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-runner-agent.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runner/web-agent.ts src/cli.ts test/web-runner-agent.test.js
git commit -m "feat: run web jobs with per-device workers"
```

---

### Task 6: job 工作目录、sha256 CAS 下载与安装

**Files:**
- Create: `src/runner/web-job-workspace.ts`
- Modify: `src/http-server.ts` / `src/panel/actions.ts`（资产下载与 job spec 端点）
- Test: `test/web-job-workspace.test.js`

**Interfaces:**
- Consumes: `WebAssetRecord`/`jobSpec.assetSnapshot`、`ExecFn`、现有 `writeFileAtomic`/`sha256` 工具。
- Produces:
  - `prepareWebJobWorkspace(input: { jobId; projectSlug; workRoot; cacheRoot; assets: Array<{ kind: "excel" | "package" | "materials" | "scripts"; sha256; filename; url }>; download: (url: string) => Promise<Buffer>; exec: ExecFn }): Promise<{ jobDir: string; files: Map<string, string>; flowsDir: string | null; warnings: string[] }>`
  - `verifySha256(buffer, expected): boolean`
  - `installWebPackage(input: { platform; deviceSerial; packagePath; exec; env; timeoutMs? }): Promise<{ ok: true; packageName: string | null; version: string | null } | { ok: false; reason: string }>`
  - HTTP：`GET /panel/api/jobs/:id/spec` 返回 jobSpec + 资产下载 URL；`GET /panel/api/jobs/:id/assets/:assetId` 流式下载，要求 runner token；路径必须落在项目 `.artemis/web/assets` 内。
- 本地 CAS：`<cacheRoot>/assets/<sha256>`；命中先校验 sha256，命中后硬链接/复制到 job 目录；未命中下载并原子写入。校验失败删除临时文件并返回 typed error，不安装。
- `scripts` 资产是 zip；校验后解压到 `<jobDir>/flows/`（`unzip -o`，5s 超时；失败返回 `script-extract-failed`）。解压条目必须限制在 `flows/` 内，拒绝 `..`/绝对路径。Plan 2 后续把生成的 script set 打包成同一 zip 格式。
- Excel 资产若下载，使用 CAS **原件**（不含 8 列写回）；仅落 `jobDir/attachments/` 供排查，runner 不解析、不作为 case set。工作副本只存在中心。

- [ ] **Step 1: Write the failing tests**

`test/web-job-workspace.test.js`：
- 首次下载写入 CAS 与 job 目录；第二次同 sha 命中缓存，download 只调用一次。
- sha 不匹配 → 抛 `asset-sha-mismatch`，缓存不落地，job 目录无文件。
- APK 安装：fake exec 断言 `adb -s <serial> install -r <path>`；失败返回 reason。
- iOS 模拟器：`xcrun simctl install <udid> <path>`。
- 下载路径穿越/未知 asset → 404；非 runner token → 401。
- job 目录按 jobId 隔离，清理只删已回传目录（可用 fake marker 测试）。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-job-workspace.test.js`
Expected: FAIL，模块/端点不存在。

- [ ] **Step 3: Implement workspace + endpoints**

实现 CAS 下载、sha 校验、hardlink/copy、安装命令；HTTP 端点复用现有鉴权中间件，runner token 用新 `AOS_RUNNER_JOB_TOKEN`（未设置时拒绝，不回退管理员 token）。路径用 `path.resolve` + 前缀校验，拒绝逃逸。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-job-workspace.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runner/web-job-workspace.ts src/http-server.ts src/panel/actions.ts test/web-job-workspace.test.js
git commit -m "feat: download and verify web job assets with cas cache"
```

---

### Task 7: Maestro 执行与逐用例结果

**Files:**
- Create: `src/runner/web-executors.ts`
- Test: `test/web-executors.test.js`

**Interfaces:**
- Consumes: jobSpec (`executionMode`, `scriptSetId`), workspace files, device serial, `ExecFn`.
- Produces:
  - `executeWebJob(input: { jobSpec: WebJobSpec; jobDir: string; flowsDir: string; device: { serial; platform; kind }; exec: ExecFn; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<WebJobExecutionResult>`
  - `WebJobExecutionResult { status: "passed" | "failed" | "partial" | "error"; cases: Array<{ caseId; name; status: "PASS" | "FAIL" | "SKIP" | "ERROR"; durationMs; failureStep?: string; failureReason?: string; screenshotPaths?: string[]; logPath?: string }>; startedAt; finishedAt; detail: string | null }`
  - Maestro：`maestro test --udid <serial> --format JUNIT --output <jobDir>/junit.xml --debug-output <jobDir>/maestro <flowsDir>/`；按 caseId 映射 JUnit testcase 到 PASS/FAIL/SKIP。
  - `executionMode=llm` 先返回 `{status:"error", detail:"llm-execution-not-wired"}`；接口保留，Plan 2 接线。

- [ ] **Step 1: Write the failing tests**

`test/web-executors.test.js`：
- 合法 JUnit XML：3 个 case（1 pass/1 failure/1 skipped）→ 结果映射正确，任务状态 failed（有 failure），SKIP 单独计数。
- Maestro 命令参数包含 `--udid`、`--format JUNIT`、`--output`、`--debug-output`；超时/退出码非 0 → 任务 error，保留 detail。
- 无 `flowFiles`/scriptSetId → `error`，不调用 exec。
- `executionMode=llm` → `llm-execution-not-wired`，不伪造 PASS。
- 每个 case 的截图/日志路径限制在 jobDir 内。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-executors.test.js`
Expected: FAIL，模块不存在。

- [ ] **Step 3: Implement executor + JUnit parser**

实现命令构造、JUnit XML 解析（不新增 XML 依赖：用有界正则/轻量 parser，拒绝 DTD/实体）、caseId 映射（`<testcase name="...">` 或 `classname`），超时杀进程组（复用 `adb-safe`/现有 exec 超时模式）。执行产物只写 jobDir。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-executors.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runner/web-executors.ts test/web-executors.test.js
git commit -m "feat: execute maestro web jobs and map per-case results"
```

---

### Task 8: 结果上传、聚合与 Excel 写回

**Files:**
- Create: `src/web/results.ts`
- Modify: `src/panel/actions.ts` / `src/http-server.ts`
- Modify: `src/web/writeback.ts`（仅在需要适配 job 结果时）
- Test: `test/web-result-ingest.test.js`

**Interfaces:**
- Consumes: `WebJobExecutionResult` (Task 7), Plan 1 `parseExcel`/`findExcelMapping`/`ensureWorkbookCopy`/`writebackWorkbook`/`recordExcelWriteback`/`lastExcelWritebackByCellKey`, `WebAssetRecord`.
- Produces:
  - `POST /panel/api/jobs/:id/results`：JSON body `{ execution: WebJobExecutionResult; device: { serial; model; osVersion }; package: { name; version; filename }; startedAt; finishedAt; evidence?: string[] }`；runner token 鉴权；幂等（同 jobId + 内容 sha 重复上传返回 200 不重复写）。
  - `ingestWebJobResult(input): Promise<{ taskStatus; gate; writtenCells; warnings }>`：持久化 `.artemis/web/results/<jobId>/result.json`；聚合 PASS/FAIL/SKIP/ERROR；调用写回引擎更新 Excel 工作副本；`writeback-failed` 不改变任务成功状态但记录原因。
  - 结果详情包含 device model/osVersion、package name/version/filename、started/finished、trace/evidence 路径。
- 写回映射规则：用任务 `excelAssetId` 找 mapping；`caseIdHeader` 从 mapping 解析；`lastSystemValue` 用 `lastExcelWritebackByCellKey`；写 8 列（§5.2 顺序）；写回失败返回 `writeback-failed`。
- **人工清空**：默认仍冻结（当前空 + journal 有值 → 不写）；新增显式 `allowClearedRefresh?: boolean`（任务/写回调用参数）。只有 `true` 时，空且 journal 有值的系统格才允许重新写入；默认 false 保持冻结语义。不要因为空值自动解冻。
- 任务终态：全部 PASS→`passed`；任一 FAIL/ERROR→`failed`；SKIP 不计通过但计数；空结果→`error`，不假成功。

- [ ] **Step 1: Write the failing tests**

`test/web-result-ingest.test.js`：
- 3 case（PASS/FAIL/SKIP）→ 聚合 `failed`，`writtenCells` 含 8 列中的结果/时间/设备/包/trace；Excel 工作副本可读，原件 sha 不变。
- 重复上传同结果 → 幂等，不重复写 journal。
- runner token 缺失/错误 → 401；未知 job → 404；结果 body 非法 → 400。
- writeback 失败（例如工作副本损坏）→ 结果仍保存，任务返回 `writeback-failed`，不报成功。
- 人工清空系统格：默认冻结、不写；显式 `allowClearedRefresh:true` 时允许重写并刷新 journal。
- 无 mapping/无 excelAssetId → 明确错误，不伪造写回。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-result-ingest.test.js`
Expected: FAIL，模块/端点不存在。

- [ ] **Step 3: Implement ingestion + writeback**

实现结果持久化、聚合、幂等键、写回适配。复用 Plan 1 的锁/工作副本/parts 校验；不新增第二套 Excel 写回。任务状态用现有 `updateRegressionTask`/result manifest；`writeback-failed` 写审计和 task detail。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-result-ingest.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web/results.ts src/panel/actions.ts src/http-server.ts src/web/writeback.ts test/web-result-ingest.test.js
git commit -m "feat: ingest web job results and write excel summaries"
```

---

### Task 9: 控制台下发 UI + 任务详情

**Files:**
- Modify: `src/panel/actions.ts`
- Modify: `src/panel/web.ts`
- Modify: `src/console/pages.ts`
- Test: `test/web-dispatch-ui.test.js`

**Interfaces:**
- Consumes: Task 4 `createWebJob`/`listWebJobs`, Task 3 `listWebRunners`, Task 2 `selectWebAssignment` preview.
- Produces:
  - `POST /panel/api/jobs` action：body `{ project, assignment: "auto"|"manual", targetHostId?, deviceSerial?, requirements, excelAssetId, packageAssetId, materialsAssetId?, scriptSetId?, executionMode, caseFilter, retry, priority }`；返回 job + 选中的 host/device/score。
  - `GET /panel/api/jobs/preview`：只读预览可选 host/device 与分数，不创建 lease。
  - 项目页/任务页「下发测试」表单：项目、Excel/包/资料/脚本版本、执行方式、用例范围、执行机（自动/指定）、设备（可选）、型号/系统版本偏好；提交后显示「等待执行机/已绑定 host + serial」。
  - 任务详情显示状态、device model/osVersion、package、开始/结束、逐用例结果、证据链接、写回状态。
  - 手动指定时 `capabilities.actions` 角色门禁；viewer 只读。

- [ ] **Step 1: Write the failing tests**

`test/web-dispatch-ui.test.js`：
- `section=jobs` 页面 200，包含下发表单、自动/指定 host、设备下拉、软偏好字段。
- POST auto：stub store/runners，返回 200，面板出现 job 与「已绑定 host/device」。
- POST manual 指定设备：返回 200；指定不属于 host 的设备 → 409/400 明确错误。
- 角色：viewer 不渲染写控件；dispatcher 可下发；maintainer/admin 可下发。
- 预览不创建 lease；页面不泄露 runner token/secret。
- 无候选时显示「等待满足要求的执行机」，不是成功。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:file -- test/web-dispatch-ui.test.js`
Expected: FAIL，页面/动作不存在。

- [ ] **Step 3: Implement UI/action**

复用现有 `render*Page`/`handlePanelActionRequest`/`panelRequiredRoleForPath`；表单用 multipart/JSON 与现有 CSRF 头一致；成功 `deps.cache?.clear()`；所有用户字符串 `escapeHtml`。设备列表由 `listWebRunners` + `listDeviceLeases` 生成，显示在线/占用/型号/OS。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:file -- test/web-dispatch-ui.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/panel/actions.ts src/panel/web.ts src/console/pages.ts test/web-dispatch-ui.test.js
git commit -m "feat: add web job dispatch ui with host and device selection"
```

---

### Task 10: E2E fake runner + DESIGN + full verification

**Files:**
- Create: `test/web-remote-e2e.test.js`
- Modify: `DESIGN.md`
- Modify: `README.md` / `AGENTS.md`（若命令/配置新增）
- Test: `test/web-remote-e2e.test.js`

**Interfaces:**
- Consumes: all previous tasks; `MemoryStore`/temp workspace; Plan 1 `storeWebAsset`/`saveExcelMapping`/`createWebProject`.
- Produces: one deterministic E2E:
  1. 创建 web 项目；
  2. 上传 Excel + package（fake APK bytes）+ 脚本 bundle；
  3. 注册两台 fake web runner（Android/iOS 或 Android 两设备）；
  4. auto 下发 → 断言选中 host+device、lease 有效；
  5. fake runner `claimWebJob` → 下载（fake download）→ 校验 sha → install（fake exec）→ execute（fake executor）→ 上传结果；
  6. 中心 ingest → task passed/failed、Excel 8 列写入、原件 sha 不变；
  7. 同设备第二条任务被拒绝/等待；
  8. 预占超时自动回池；手动指定超时等待且告警。
- DESIGN 增加 §13.x：host-level web runner、`web_runners`/`job_spec`/`device_serial`/`device_lease_id`、下发选机/预占/回池、按设备并行、runner token、CAS、结果上传/写回、Plan 2 边界。
- README/AGENTS 增加 `web-runner` 命令、`AOS_RUNNER_JOB_TOKEN`、预留 TTL/心跳 env。

- [ ] **Step 1: Write the failing E2E**

写 `test/web-remote-e2e.test.js`，先跑；断言目标行为，预期在实现前失败。

- [ ] **Step 2: Run E2E to verify it fails**

Run: `npm run test:file -- test/web-remote-e2e.test.js`
Expected: FAIL，缺少实现。

- [ ] **Step 3: Fix integration gaps**

只修 E2E 暴露的真实接线问题；不扩展 Plan 2/4。

- [ ] **Step 4: Update docs**

`DESIGN.md` 新 §13.x；`README.md`/`AGENTS.md` 补命令、env、权限、默认 TTL；明确 `executionMode=llm` 仍待 Plan 2。

- [ ] **Step 5: Full verification**

Run: `npm run build && npm test && npm run lint`
Expected: 全绿；lint 仅允许既有 warning。

- [ ] **Step 6: Commit**

```bash
git add test/web-remote-e2e.test.js DESIGN.md README.md AGENTS.md
git commit -m "test: cover remote web job dispatch and execution"
```

---

## Self-Review

- **Spec coverage:** 覆盖 §1.2.25–29、§3.4、§4.7、§4.8、§7.1、§9、§12.1 的选机/预占/并行/回池/资产/执行/写回；Plan 2 的脚本生成、Plan 4 的计费明确不在本计划。
- **Type consistency:** `RunnerDevice.model/osVersion`、`WebRunnerRecord`、`WebDispatchRequirements`、`RegressionTaskRecord.jobSpec/deviceSerial/deviceLeaseId`、`claimWebJob`、`executeWebJob` 在任务间一致。
- **Review Focus tests:** 同设备并发、下发后离线、sha 校验、结果上传失败、能力缺失降级均有对应任务测试。
- **已知边界:** `executionMode=llm` 只保留接口并显式报 `llm-execution-not-wired`；Plan 3 的 E2E 使用手工/上传 Maestro bundle。此边界必须在 DESIGN 和响应中可见，不能伪造 PASS。
