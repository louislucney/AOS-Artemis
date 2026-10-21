# 多机接入：主机身份、三层信号与下发队列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让中心 Mac 能按“主机 + 项目”下发任务，清楚标识每台接入机器的身份/系统/IP/环境，并支持可中断、可取消、可暂停的队列。

**Architecture:** 三层信号：本机 MCP 上报接入会话（谁在哪台机器上开着哪个项目）、runner 上报执行能力（设备/工具/环境/队列）、中心登记期望画像。项目身份从全局 `rootPath` 改为 `(host_id, root_path)`；任务按 `target_host_id` 入队，runner 原子领取；设备用租约互斥，取消是终态。

**Tech Stack:** TypeScript ESM + NodeNext + strict、Node 20+、MCP SDK、PostgreSQL（测试用 `pg-mem`）、Node 内置 `node:test`、`zod` 原生工具。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-host-dispatch-design.md`

## Global Constraints

- 构建先于测试：`npm run build` 后跑 `npm test`；测试导入 `dist/`。
- ESM + NodeNext：相对导入必须带 `.js` 后缀。
- 用户可见文案与文档用中文；代码标识符用英文；代码默认不加注释，仅保留解释非显然契约的 JSDoc。
- stdout 属于 MCP stdio 协议；日志走 `log()`（stderr）。
- 测试不依赖真实 PG / 设备 / 外网：SQL 用 `pg-mem`，命令探测用注入的 `ExecFn`，HTTP 用 `InMemoryTransport`。
- 密钥不落日志、不回显；面板动作保持同源校验与 `AOS_PANEL_ACTIONS` 开关。
- 行为/接口变更同步 `DESIGN.md`；命令/配置变更同步 `README.md`。
- 每个任务结束提交一次；提交信息用 `feat:` / `fix:` / `test:` 前缀。
- 新环境变量默认值：`AOS_CLIENT_TTL_MS=120000`、`AOS_DEVICE_LEASE_MS=90000`、`AOS_CANCEL_GRACE_MS=90000`、`AOS_HOST_ENV_REFRESH_MS=600000`、`AOS_HOST_STRICT=0`、`AOS_PANEL_PRIORITY=0`。

## Review Focus

1. **同路径两台机器**：`/Users/louis/app` 在 A、B 两台机器同时存在时，任何 store 读取都不得串台；未绑主机且命中多行必须显式报歧义，不能取 `rows[0]`。
2. **旧数据/旧 runner**：`host_id=NULL` 的历史项目与未升级 runner 仍能工作，但不会被自动认领到先启动的机器，也不会领到定向任务。
3. **设备忙重试**：设备被占用导致的 `pending → claimed → pending` 循环不得消耗 `attempts`，不得触发毒丸 `failed`。
4. **长执行存活**：执行超过 2×TTL 时，在线判定、任务进度、设备租约必须同时续期；不能出现“面板离线但回收认为在线”或“租约过期双跑”。
5. **离线取消**：`stopping` 在 runner 离线时也必须落 `cancelled`，且任何清扫器/恢复 runner 的竞争都幂等，取消后不得回 `pending` 重跑。

---

## Phase P1 — 可见性

### Task 1: 主机身份（machine_id / OS / 用户名）

**Files:**
- Create: `src/host/identity.ts`
- Test: `test/host-identity.test.js`

**Interfaces:**
- Consumes: `ExecFn`、`ExecResult`（`src/device/adb.ts`）。
- Produces:
  - `type HostKind = "mac" | "pc" | "linux" | "other"`
  - `interface HostIdentity { id: string; hardwareId: string | null; hostname: string; username: string; osPlatform: NodeJS.Platform; osVersion: string; arch: string; kind: HostKind; identitySource: "env" | "file" | "derived" }`
  - `function hostKindOf(platform: NodeJS.Platform): HostKind`
  - `function resolveHostIdentity(options?: { env?: NodeJS.ProcessEnv; hostDir?: string; exec?: ExecFn; platform?: NodeJS.Platform; hostname?: string; username?: string; osVersion?: string }): Promise<HostIdentity>`

- [ ] **Step 1: Write the failing test**

`test/host-identity.test.js`:

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hostKindOf, resolveHostIdentity } from "../dist/host/identity.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "aos-host-"));
}

test("AOS_HOST_ID 优先且不落盘", async () => {
  const dir = await tempDir();
  const id = await resolveHostIdentity({
    env: { AOS_HOST_ID: "host-1", AOS_HOST_DIR: dir },
    platform: "darwin",
    hostname: "mac-a",
    username: "louis",
    osVersion: "14.6.1"
  });
  assert.equal(id.id, "host-1");
  assert.equal(id.identitySource, "env");
  assert.equal(id.kind, "mac");
  await assert.rejects(fs.access(path.join(dir, "host-id")));
});

test("首次生成 host-id 并复用", async () => {
  const dir = await tempDir();
  const first = await resolveHostIdentity({ env: { AOS_HOST_DIR: dir }, platform: "darwin" });
  const second = await resolveHostIdentity({ env: { AOS_HOST_DIR: dir }, platform: "darwin" });
  assert.equal(first.id, second.id);
  assert.equal(first.identitySource, "file");
});

test("目录不可写退化为 derived 且稳定", async () => {
  const first = await resolveHostIdentity({
    env: { AOS_HOST_DIR: "/proc/definitely-not-writable" },
    platform: "linux",
    hostname: "linux-a",
    username: "ci"
  });
  const second = await resolveHostIdentity({
    env: { AOS_HOST_DIR: "/proc/definitely-not-writable" },
    platform: "linux",
    hostname: "linux-a",
    username: "ci"
  });
  assert.equal(first.identitySource, "derived");
  assert.equal(first.id, second.id);
});

test("hostKindOf 映射", () => {
  assert.equal(hostKindOf("darwin"), "mac");
  assert.equal(hostKindOf("win32"), "pc");
  assert.equal(hostKindOf("linux"), "linux");
  assert.equal(hostKindOf("freebsd"), "other");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/host-identity.test.js`
Expected: FAIL — `Cannot find module '../dist/host/identity.js'`.

- [ ] **Step 3: Implement `src/host/identity.ts`**

Rules:
- `AOS_HOST_ID` wins.
- Else `AOS_HOST_DIR`（默认 `~/.aos`）下 `host-id`；不存在则 `crypto.randomUUID()` + 原子写（临时文件→rename，权限 0600）。
- 写失败 → `sha256(hardwareId || hostname || username).slice(0, 32)`，`identitySource="derived"`。
- `hardwareId` 探测：darwin `ioreg -rd1 -c IOPlatformExpertDevice` 取 `IOPlatformUUID`；win32 `reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid`；linux 读 `/etc/machine-id`。失败 → `null`，不阻断。
- `osVersion` 缺省：darwin `sw_vers -productVersion`，其他 `os.release()`；探测失败回退 `os.release()`。
- 所有命令走注入的 `exec`，超时 5s。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/host-identity.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/host/identity.ts test/host-identity.test.js
git commit -m "feat: add persistent host identity"
```

---

### Task 2: 主机环境探测与能力推导

**Files:**
- Create: `src/host/env.ts`
- Test: `test/host-env.test.js`

**Interfaces:**
- Consumes: `ExecFn`（`src/device/adb.ts`）；`AOS_MCP_VERSION`（`src/util.ts`）。
- Produces:
  - `interface ToolProbe { present: boolean; version: string | null; path: string | null; note?: string | null }`
  - `interface HostEnvSnapshot { collectedAt: string; node: string; aos: string; cpu: { model: string; count: number }; memory: { totalBytes: number }; disk: { path: string; freeBytes: number | null; totalBytes: number | null }; tools: { adb: ToolProbe; xcodebuild: ToolProbe; simctl: ToolProbe; idb: ToolProbe; idevicesyslog: ToolProbe; appium: ToolProbe; uv: ToolProbe } }`
  - `function deriveCapabilities(platform: NodeJS.Platform, tools: HostEnvSnapshot["tools"]): string[]`
  - `function detectHostEnvironment(input: { projectRoot: string; env?: NodeJS.ProcessEnv; exec?: ExecFn; platform?: NodeJS.Platform; now?: () => number; statfs?: (p: string) => Promise<{ freeBytes: number; totalBytes: number }>; appiumStatus?: (url: string) => Promise<{ version: string | null } | null> }): Promise<HostEnvSnapshot>`

- [ ] **Step 1: Write the failing test**

`test/host-env.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { deriveCapabilities, detectHostEnvironment } from "../dist/host/env.js";

function fakeExec(table) {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = table[key];
    if (hit === undefined) return { code: 1, stdout: "", stderr: "not found", error: "ENOENT" };
    return typeof hit === "function" ? hit() : { code: 0, stdout: hit, stderr: "", error: undefined };
  };
}

const DARWIN = {
  "adb version": "Android Debug Bridge version 1.0.41\n",
  "xcodebuild -version": "Xcode 16.4\nBuild version 16F6\n",
  "xcrun simctl help": "Usage: simctl",
  "idb --version": "idb 1.1.8",
  "which idevicesyslog": "/usr/local/bin/idevicesyslog",
  "uv --version": "uv 0.8.1"
};

test("darwin 完整工具链 → iOS 模拟器/真机 + Android", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "/w/app",
    platform: "darwin",
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" },
    exec: fakeExec(DARWIN),
    statfs: async () => ({ freeBytes: 100, totalBytes: 200 }),
    appiumStatus: async () => ({ version: "2.11.0" })
  });
  assert.equal(env.tools.adb.present, true);
  assert.equal(env.tools.xcodebuild.version, "16.4");
  const caps = deriveCapabilities("darwin", env.tools);
  assert.deepEqual(caps.sort(), ["android", "ios-real", "ios-simulator"]);
});

test("win32 只有 adb → 只有 Android，不产生 iOS", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "C:/w/app",
    platform: "win32",
    exec: fakeExec({ "adb version": "Android Debug Bridge version 1.0.41\n" }),
    statfs: async () => ({ freeBytes: 1, totalBytes: 2 })
  });
  assert.deepEqual(deriveCapabilities("win32", env.tools), ["android"]);
  assert.equal(env.tools.simctl.present, false);
});

test("命令失败/超时不抛错，探测为 present=false", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "/w/app",
    platform: "darwin",
    exec: async () => ({ code: null, stdout: "", stderr: "", error: "timeout" }),
    statfs: async () => ({ freeBytes: 1, totalBytes: 2 })
  });
  assert.equal(env.tools.adb.present, false);
  assert.equal(env.tools.xcodebuild.present, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/host-env.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/host/env.ts`**

Probe commands（统一 5s 超时）：
- `adb version` → 正则 `Android Debug Bridge version ([\\w.]+)`
- `xcodebuild -version` → 第一行 `Xcode ([\\w.]+)`
- `xcrun simctl help` → present 即可
- `idb --version` → `idb ([\\w.]+)`
- `which idevicesyslog` → path
- `uv --version` → `uv ([\\w.]+)`
- Appium：`AOS_APPIUM_URL` 非空时 present；`appiumStatus` 可注入，失败时 `version:null` 且不抛。
- 磁盘：注入 `statfs`；缺省用 `fs.statfs`（Node ≥ 18.15），失败返回 `null`。
- `deriveCapabilities`：
  - `darwin && tools.simctl.present` → `ios-simulator`
  - `darwin && (tools.appium.present || (tools.ideviceId ?? false) && tools.idb.present)` → `ios-real`
  - `tools.adb.present` → `android`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/host-env.test.js`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/host/env.ts test/host-env.test.js
git commit -m "feat: detect host environment and capabilities"
```

---

### Task 3: hosts / host_addresses / host_sessions 存储

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/file.ts`
- Test: `test/db-hosts.test.js`

**Interfaces:**
- Produces（`ProjectStore` 新方法）:
  - `upsertHost(input: UpsertHostInput): Promise<HostRecord>`
  - `getHost(id: string): Promise<HostRecord | null>`
  - `listHosts(): Promise<HostRecord[]>`
  - `updateHostRegistration(input: { id: string; label?: string | null; owner?: string | null; expectedOs?: string | null; expectedHostname?: string | null; registeredBy: string }): Promise<HostRecord | null>`
  - `upsertHostAddresses(input: { hostId: string; addresses: HostAddressInput[]; at?: string; maxPerSource?: number }): Promise<void>`
  - `listHostAddresses(hostId: string): Promise<HostAddressRecord[]>`
  - `touchHostSession(input: { id: string; hostId: string; projectId: string | null; rootPath: string; username: string | null; client: string | null; clientVersion: string | null; pid: number | null; at?: string }): Promise<HostSessionRecord>`
  - `endHostSession(id: string, at?: string): Promise<boolean>`
  - `listHostSessions(hostId: string, options?: { limit?: number; onlineWithinMs?: number; now?: number }): Promise<HostSessionRecord[]>`
  - `setHostQueuePaused(input: { hostId: string; paused: boolean; by: string; at?: string }): Promise<HostRecord | null>`
- Types:
  - `HostRecord` 字段与设计 §6.1 一致（camelCase）。
  - `HostAddressInput { source: "self" | "observed-pg" | "observed-http"; iface: string; family: "ipv4" | "ipv6"; address: string }`
  - `HostSessionRecord { id; hostId; projectId; rootPath; username; client; clientVersion; pid; startedAt; lastSeenAt; endedAt }`

- [ ] **Step 1: Write the failing test**

`test/db-hosts.test.js`（复用一个 `makeStores()`，同时跑 MemoryStore + pg-mem PostgresStore）：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makeStores() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  return [new MemoryStore(), pg];
}

test("upsertHost: client/runner 两个在线信号独立，lastSeenAt 取最大", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({
      id: "h1", hardwareId: "hw1", hostname: "mac-a", username: "louis",
      osPlatform: "darwin", osVersion: "14.6.1", arch: "arm64",
      identitySource: "file", kind: "mac", capabilities: ["android"],
      env: {}, envAt: null, ipPrimary: "10.0.0.5"
    });
    await store.upsertHost({ id: "h1", hostname: "mac-a", clientSeenAt: "2026-10-21T10:00:00.000Z" });
    const host = await store.upsertHost({ id: "h1", hostname: "mac-a", runnerSeenAt: "2026-10-21T10:01:00.000Z" });
    assert.equal(host.clientSeenAt, "2026-10-21T10:00:00.000Z");
    assert.equal(host.runnerSeenAt, "2026-10-21T10:01:00.000Z");
    assert.equal(host.lastSeenAt, "2026-10-21T10:01:00.000Z");
  }
});

test("host_addresses: 同键 upsert 更新 lastSeenAt，不同来源保留", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    await store.upsertHostAddresses({ hostId: "h1", addresses: [
      { source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" },
      { source: "observed-pg", iface: "", family: "ipv4", address: "10.0.0.9" }
    ], at: "2026-10-21T10:00:00.000Z" });
    await store.upsertHostAddresses({ hostId: "h1", addresses: [
      { source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" }
    ], at: "2026-10-21T10:05:00.000Z" });
    const rows = await store.listHostAddresses("h1");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.source === "self").lastSeenAt, "2026-10-21T10:05:00.000Z");
  }
});

test("host_sessions: 在线窗口 + endedAt", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    await store.touchHostSession({
      id: "s1", hostId: "h1", projectId: null, rootPath: "/w/app",
      username: "louis", client: "cursor", clientVersion: "1.0", pid: 42,
      at: "2026-10-21T10:00:00.000Z"
    });
    const online = await store.listHostSessions("h1", {
      onlineWithinMs: 120_000,
      now: Date.parse("2026-10-21T10:01:00.000Z")
    });
    assert.equal(online.length, 1);
    await store.endHostSession("s1", "2026-10-21T10:02:00.000Z");
    assert.equal((await store.listHostSessions("h1", { onlineWithinMs: 120_000, now: Date.parse("2026-10-21T10:03:00.000Z") })).length, 0);
  }
});

test("setHostQueuePaused 写入/恢复", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    const paused = await store.setHostQueuePaused({ hostId: "h1", paused: true, by: "panel" });
    assert.equal(paused.queuePaused, true);
    assert.equal(paused.queuePausedBy, "panel");
    const resumed = await store.setHostQueuePaused({ hostId: "h1", paused: false, by: "panel" });
    assert.equal(resumed.queuePaused, false);
  }
});
```

Add `now` optional param to `listHostSessions` options (interface above should include `now?: number`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/db-hosts.test.js`
Expected: FAIL — `store.upsertHost is not a function`.

- [ ] **Step 3: Implement**

- `PostgresStore`：在 `SCHEMA` 加 `hosts` / `host_addresses` / `host_sessions`（SQL 见设计 §6.1/§6.2/§6.7）；`MIGRATIONS` 加 `ALTER TABLE project_events ADD COLUMN IF NOT EXISTS host_id TEXT`（本任务先建表，不接线）。
- `upsertHostAddresses`：按 `(host_id, source, iface, address)` upsert `first_seen_at/last_seen_at`；随后每来源按 `last_seen_at DESC` 只保留 `maxPerSource`（默认 20）条。
- **迁移锁**：`init()` 用 `pg_advisory_lock(AOS_MIGRATION_LOCK_ID)` 包住 `SCHEMA + MIGRATIONS`，`finally` 解锁；pg-mem 不支持时捕获 undefined-function 并继续（测试不依赖锁）。
- `MemoryStore`：新增 `hosts` / `hostAddresses` / `hostSessions` 私有数组；`MemoryStoreState` 同步。
- `FileStore`：委托 bucket 的内存实现，持久化到 `.artemis/ledger/state.json`（与 runners 同模式）。
- `listHostSessions`：过滤 `ended_at IS NULL` 且 `last_seen_at > now - onlineWithinMs`；`now` 缺省 `Date.now()`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/db-hosts.test.js`
Expected: PASS（4 tests × 2 stores）。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts test/db-hosts.test.js
git commit -m "feat: add host registry, addresses, and sessions store"
```

---

### Task 4: runner 心跳带主机环境与 IP

**Files:**
- Create: `src/runner/host-snapshot.ts`
- Modify: `src/db/types.ts`（`UpsertRunnerInput`、`RunnerRecord`）
- Modify: `src/db/postgres.ts`（`upsertRunner`）
- Modify: `src/db/memory.ts`、`src/db/file.ts`
- Modify: `src/runner/agent.ts`
- Test: `test/runner-host-heartbeat.test.js`

**Interfaces:**
- Consumes: `resolveHostIdentity`、`detectHostEnvironment`、`upsertHost`、`upsertHostAddresses`。
- Produces:
  - `interface HostSnapshot { identity: HostIdentity; env: HostEnvSnapshot; capabilities: string[]; ipPrimary: string | null; addresses: HostAddressInput[] }`
  - `function collectHostSnapshot(input: { projectRoot: string; env?: NodeJS.ProcessEnv; exec?: ExecFn; platform?: NodeJS.Platform }): Promise<HostSnapshot>`
  - `UpsertRunnerInput` 增 `hostId: string; instanceId: string; host: HostSnapshot`
  - `RunnerRecord` 增 `hostId: string | null; instanceId: string | null`
  - `RunnerAgentOptions` 增 `collectHostSnapshot?: (input: { projectRoot: string; env: NodeJS.ProcessEnv }) => Promise<HostSnapshot>`（测试注入；缺省用真实探测）
  - `PostgresStore.upsertHost` 在写地址时额外执行 `SELECT inet_client_addr() AS addr`，非空则以 `source:"observed-pg"` upsert；`MemoryStore`/`FileStore` 跳过。

- [ ] **Step 1: Write the failing test**

`test/runner-host-heartbeat.test.js`：用 `MemoryStore` + `runRunnerAgent({ once: true, collectInventory, buildRuntime })`，`collectHostSnapshot` 通过 `options.collectHostSnapshot` 注入（在 `RunnerAgentOptions` 增可选注入，测试用固定快照）。

```js
test("runner 心跳写入 hosts.runnerSeenAt、hostId/instanceId、地址", async () => {
  const { runtime, store } = await fixture();
  await runRunnerAgent({
    projectDir: runtime.project.rootDir,
    name: "runner-1",
    once: true,
    env: {},
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    executeSuite: async () => 0,
    collectInventory: async () => inventory(),
    collectHostSnapshot: async () => snapshot(),
    io: { log: () => {}, errorLog: () => {} }
  });
  const host = await store.getHost("h1");
  assert.equal(host.runnerSeenAt !== null, true);
  const runners = await store.listRunners(runtime.project.rootDir);
  assert.equal(runners[0].hostId, "h1");
  assert.equal(typeof runners[0].instanceId, "string");
  assert.equal((await store.listHostAddresses("h1")).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/runner-host-heartbeat.test.js`
Expected: FAIL — `collectHostSnapshot` / `hostId` 未定义。

- [ ] **Step 3: Implement**

- `src/runner/host-snapshot.ts`：
  - identity = `resolveHostIdentity({env, platform})`
  - env = `detectHostEnvironment({projectRoot, env, platform})`
  - addresses = `os.networkInterfaces()` 过滤 internal / link-local，`source:"self"`
  - `ipPrimary` = 第一个非链路本地 IPv4，否则 IPv6
- `runner/agent.ts`：
  - 启动时 `snapshot = await options.collectHostSnapshot?.(...) ?? collectHostSnapshot(...)`；`identity = snapshot.identity`；`instanceId = randomUUID()`。
  - `heartbeat()` 调 `store.upsertHost({...identity, capabilities, env, ipPrimary})` → `store.upsertHostAddresses(...)` → `store.upsertRunner({... hostId, instanceId, host})`
  - 环境快照缓存 `envRefreshMs`（`AOS_HOST_ENV_REFRESH_MS` 默认 600000）；心跳只复用缓存，到期重采。
- `upsertRunner`：先 `upsertHost`（若 `input.host` 存在），再写 runner；`hosts.runner_seen_at` 更新。
- `PostgresStore.upsertHostAddresses`：若当前连接能取到 `inet_client_addr()`（在 `upsertHost` 内同一连接执行），追加 `observed-pg` 地址；`inet_client_addr()` 为 NULL（unix socket）或报错时跳过，不影响自报地址。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/runner-host-heartbeat.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runner/host-snapshot.ts src/runner/agent.ts src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts test/runner-host-heartbeat.test.js
git commit -m "feat: report host snapshot on runner heartbeat"
```

---

### Task 5: 本地 MCP 接入会话心跳 + usage 主机维度

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/server.ts`
- Modify: `src/db/types.ts`（`RecordUsageEventInput` 增 `hostId?`、`sessionId?`）
- Modify: `src/db/postgres.ts`、`memory.ts`、`file.ts`（usage 列）
- Test: `test/presence-heartbeat.test.js`

**Interfaces:**
- Produces（`Runtime`）:
  - `readonly hostIdentity: HostIdentity | null`
  - `readonly clientSessionId: string`
  - `startClientSession(client: { name: string; version?: string } | null): Promise<void>`
  - `noteClientPresence(): Promise<void>`（30s 节流）
  - `endClientSession(): Promise<void>`
- `RuntimeOptions` 增 `hostIdentity?: HostIdentity`。
- `server.ts`：`server.oninitialized = () => { void runtime?.startClientSession(server.getClientVersion() ?? null); }`；`CallToolRequestSchema` 处理里 `void runtime?.noteClientPresence()`。
- usage：`RecordUsageEventInput` 增 `hostId: string | null; sessionId: string | null`；`usage_events` 加 `host_id`、`session_id`。

- [ ] **Step 1: Write the failing test**

```js
test("Runtime.startClientSession/note/end 写 host_sessions 并节流", async () => {
  const { runtime, store } = await fixture(); // MemoryStore + injected hostIdentity
  let now = Date.parse("2026-10-21T10:00:00.000Z");
  await runtime.startClientSession({ name: "cursor", version: "1.0" });
  let rows = await store.listHostSessions("h1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client, "cursor");
  await runtime.noteClientPresence();
  assert.equal((await store.listHostSessions("h1"))[0].lastSeenAt, "2026-10-21T10:00:00.000Z");
  await runtime.noteClientPresence();
  await runtime.endClientSession();
  assert.equal((await store.listHostSessions("h1"))[0].endedAt !== null, true);
});

test("usage 事件带 hostId/sessionId", async () => {
  // InMemoryTransport：initialize clientInfo + call aos_status
  // 断言 store.listUsageEvents(...)[0].hostId === "h1" && sessionId === runtime.clientSessionId
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/presence-heartbeat.test.js`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

- `Runtime.initialize`：若 `options.hostIdentity` 缺省 → `resolveHostIdentity()`；`this.hostIdentity = ...`；`projectRecord = upsertProject({rootPath, name, hostId: identity.id})`；`clientSessionId = randomUUID()`。
- `startClientSession`：`touchHostSession({id: clientSessionId, hostId, projectId: projectRecord?.id ?? null, rootPath, username, client, clientVersion, pid: process.pid})`；失败只 `log(..., "warn")`。
- `noteClientPresence`：距上次 ≥30s 才写；同样 fire-and-forget。
- `endClientSession`：`endHostSession(id)`。
- `server.ts` 接线；HTTP 模式不启用（`createServerForRuntime` 拿不到 per-client，保持只在 stdio 的 `runServer` 里注册 `oninitialized`；`createServerForRuntime` 保留参数 `presence?: boolean` 默认 false，测试传 true）。
- usage 写入带 `hostId/sessionId`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/presence-heartbeat.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts src/server.ts src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts test/presence-heartbeat.test.js
git commit -m "feat: report MCP presence and tag usage with host/session"
```

---

### Task 6: 面板主机视图 + aos_status/doctor

**Files:**
- Modify: `src/panel/overview.ts`
- Modify: `src/panel/web.ts`
- Modify: `src/tools/llm.ts`（`aosStatus`）
- Modify: `src/commands.ts`（`runDoctor`）
- Test: `test/panel-hosts.test.js`、`test/status-host.test.js`

**Interfaces:**
- `PanelOverview` 增 `machines: PanelMachineRow[]`：
  ```ts
  interface PanelMachineRow {
    id: string; label: string | null; hostname: string; kind: string;
    osPlatform: string; osVersion: string | null; arch: string | null;
    clientOnline: boolean; clientSessions: number;
    runnerOnline: boolean; lastSeenAt: string;
    ipPrimary: string | null; addresses: string[];
    capabilities: string[]; tools: Record<string, { present: boolean; version: string | null }>;
    queuePaused: boolean; pendingTasks: number;
    registered: boolean; drift: string[];
  }
  ```
- `aosStatus` 返回 `host: { identity, clientOnline, runnerOnline, clientSessions, queue: { paused, pending, running } }`。
- `doctor` 打印 `host identity: <id> · <kind> · <os> · <arch>` 与工具版本摘要。

- [ ] **Step 1: Write the failing test**

```js
import { handlePanelRequest } from "../dist/panel/web.js";
import { buildPanelOverview } from "../dist/panel/overview.js";

test("面板总览渲染主机名/Mac/双在线/IP/漂移", async () => {
  // seed hosts + sessions + runner rows；deps = { store, workspaceRoot }
  const overview = await buildPanelOverview(deps);
  const res = await handlePanelRequest(new URL("http://127.0.0.1/panel"), deps);
  const html = String(res.body);
  assert.match(html, /MacBook-A/);
  assert.match(html, /Mac/);
  assert.match(html, /IDE 在线/);
  assert.match(html, /执行机离线/);
  assert.match(html, /10\.0\.0\.5/);
  assert.match(html, /OS 与登记不符/);
});

test("aos_status.host 形状", async () => {
  const result = await aosStatus(runtime);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.host.identity.id, "h1");
  assert.equal(typeof payload.host.clientOnline, "boolean");
  assert.equal(typeof payload.host.queue.pending, "number");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/panel-hosts.test.js`
Expected: FAIL — `machines` / `host` undefined.

- [ ] **Step 3: Implement**

- `buildPanelOverview`：`listHosts()`；对每台主机计算 `clientOnline`（`clientSeenAt` 在 `AOS_CLIENT_TTL_MS` 内）、`runnerOnline`（用该主机的 `listRunners` 行 + `isRunnerOnline(runner.lastSeenAt)`，**不**用 `hosts.runnerSeenAt` 判定，后者只做展示投影）、`drift`（`expectedOs`/`expectedHostname` 与实际不符）、`pendingTasks`（`listRegressionTasks` 过滤 pending）。
- `web.ts`：总览页新增“接入主机”区块（表格），列：主机、系统、IDE/执行机、IP、能力、队列、最后活跃、漂移。远端项目行继续标“磁盘不可达”。
- **IP 变更与复用**：主地址与该主机历史主地址不同 → 显示“上次 X，变更于 T”；对 `observed-pg` 地址按最近 10 分钟分组，同一地址出现在 >1 台 host → `ip-shared` 警告（只提示，不合并）。
- `aosStatus`：加 `host` 字段；`doctor` 加本机 identity/env 段落（只读本机，不依赖 PG）。
- 文件台账模式：`listHosts()` 返回空 → 面板显示“单机模式（无中心台账）”。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/panel-hosts.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/panel/overview.ts src/panel/web.ts src/tools/llm.ts src/commands.ts test/panel-hosts.test.js test/status-host.test.js
git commit -m "feat: show host registry and dual online status in panel"
```

**Phase P1 gate:** `npm run build && npm test && npm run lint` 全绿；`aos_status.host` 在无 PG 时也能显示本机 identity/env。

---

## Phase P2 — 项目主机维度与定向下发

### Task 7: 项目身份 (host_id, root_path) 与 store 作用域

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/file.ts`
- Test: `test/db-project-hosts.test.js`

**Interfaces:**
- `ProjectRecord` 增 `hostId: string | null`。
- `ProjectStore` 增：
  - `readonly localHostId: string | null`
  - `bindHost(hostId: string): void`
  - `scopeHost(hostId: string): ProjectStore`
- `upsertProject(input: { rootPath; name; hostId?: string | null; updateName?: boolean })`。
- `getProjectByPath(rootPath)`：
  - 绑定 host → 只查 `(host_id, root_path)`；
  - 未绑定 → 查询 `root_path`，命中 >1 抛 `AmbiguousProjectError(rootPath, candidates)`。
- `PostgresStore` 构造函数 `(pool, hostId: string | null = null)`；`scopeHost` 复用同一 pool 返回新实例。

- [ ] **Step 1: Write the failing test**

```js
test("同一 rootPath 两台主机是两行；作用域解析不串台", async () => {
  for (const store of await makeStores()) {
    const a = store.scopeHost("h-a");
    const b = store.scopeHost("h-b");
    await a.upsertProject({ rootPath: "/Users/louis/app", name: "app" });
    await b.upsertProject({ rootPath: "/Users/louis/app", name: "app" });
    assert.notEqual((await a.getProjectByPath("/Users/louis/app")).id,
                    (await b.getProjectByPath("/Users/louis/app")).id);
  }
});

test("未绑定 host 且多行 → AmbiguousProjectError，不取 rows[0]", async () => {
  for (const store of await makeStores()) {
    await store.scopeHost("h-a").upsertProject({ rootPath: "/x/app", name: "app" });
    await store.scopeHost("h-b").upsertProject({ rootPath: "/x/app", name: "app" });
    await assert.rejects(store.getProjectByPath("/x/app"), (e) => e.name === "AmbiguousProjectError");
  }
});

test("绑定 host 后 upsertProject 使用该 host；旧 NULL 行不被隐式接管", async () => {
  const store = (await makeStores())[1];
  const legacy = await store.upsertProject({ rootPath: "/x/app", name: "app" }); // host_id NULL
  const scoped = store.scopeHost("h-a");
  const local = await scoped.upsertProject({ rootPath: "/x/app", name: "app" });
  assert.equal(legacy.hostId, null);
  assert.equal(local.hostId, "h-a");
  assert.notEqual(local.id, legacy.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/db-project-hosts.test.js`
Expected: FAIL — `scopeHost` / `hostId` missing.

- [ ] **Step 3: Implement**

- Postgres：`projects` 加 `host_id`；`DROP CONSTRAINT IF EXISTS projects_root_path_key`；`CREATE UNIQUE INDEX projects_host_path_idx ON projects(host_id, root_path)`。
- `getProjectByPath`：绑定 host 时 `WHERE host_id=$1 AND root_path=$2`；未绑定时 `SELECT * WHERE root_path=$1`，`rows.length > 1` 抛错。
- `upsertProject`：绑定 host 时 `SELECT ... host_id=$1 AND root_path=$2` → INSERT/UPDATE；未绑定保持 `host_id=NULL` 旧行为。
- `MemoryStore` / `FileStore`：`hostId` 字段 + `bindHost`/`scopeHost`；`scopeHost` 返回**共享底层状态的新视图**（`MemoryStore` 用内部 `state` 对象 + `hostId`；`FileStore` 沿用同一 bucket），不能直接返回 `this` 后修改 `hostId`，否则同一实例的 A/B 视图会串。key 改为 `${hostId ?? "legacy"}\0${rootPath}`。
- 调用面迁移：先 `grep -rn "getProjectByPath" src` 与 `grep -rn "upsertProject" src` 列出所有点；本地 Runtime/runner/CLI 依赖 `bindHost` 自动落到本机；中心/面板/事件必须显式 `scopeHost(hostId)`。`getProjectByPath` 不再有“未绑定且多行随便取”的分支。
- 迁移：历史行保持 NULL；不自动回填。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/db-project-hosts.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts test/db-project-hosts.test.js
git commit -m "feat: scope projects by host and root path"
```

---

### Task 8: Runtime / 面板 / 事件接线到主机作用域

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/runtime-host.ts`
- Modify: `src/panel/web.ts`
- Modify: `src/panel/actions.ts`
- Modify: `src/panel/overview.ts`
- Modify: `src/events/project-resolver.ts`
- Modify: `src/events/ingress.ts`
- Modify: `src/http-server.ts`
- Test: `test/panel-project-hosts.test.js`、`test/events-hosts.test.js`

**Interfaces:**
- `RuntimeOptions` 增 `hostIdentity?: HostIdentity`；`Runtime.initialize` 调 `store.bindHost(identity.id)` 后 `upsertProject({rootPath, name, hostId: identity.id})`。
- `PanelWebDeps` 增 `storeForHost?: (hostId: string) => ProjectStore`。
- `resolveProjectKey(deps, key, hostId?)` 返回 `{ rootPath; name; hostId: string | null }`。
- `handlePanelActionRequest`：用 `deps.storeForHost?.(resolved.hostId) ?? deps.store`。
- `resolveEventProject(input: { workspaceRoot; hostId; name; store; write })`：按 `(hostId, rootPath)` 解析；HTTP 路由 `/events/<host>/<project>`；旧 `/events/<project>` 仅本机。

- [ ] **Step 1: Write the failing test**

```js
test("面板按 host+path 打开远端项目，不受同路径本机项目影响", async () => {
  // 两个 host 同 rootPath，各有一条 suite run（run-a / run-b）
  const res = await handlePanelRequest(
    new URL("http://127.0.0.1/panel?host=h-b&project=%2FUsers%2Flouis%2Fapp"),
    deps
  );
  const html = String(res.body);
  assert.match(html, /run-b/);
  assert.doesNotMatch(html, /run-a/);
});

test("事件路由 /events/<host>/<project> 归属正确", async () => {
  // 发事件到 h-b；断言 project_events 行的 project_id 是 h-b 的项目
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/panel-project-hosts.test.js`
Expected: FAIL — 同路径串台 / 路由 404。

- [ ] **Step 3: Implement**

- `Runtime` 绑定 host；`projectSummary` 带 `hostId`。
- `RuntimeHost` 暴露 `hostIdentity`。
- `resolveProjectKey`：先按 `(hostId, rootPath)`；无 host 时本地优先；跨主机歧义 409。
- 面板 `buildView` / 动作层用 `storeForHost`；`PanelDeps` 同步增 `storeForHost`。`http-server.ts` / `panel-command.ts` 装配时注入 `storeForHost: (hostId) => store.scopeHost(hostId)`；无 PG 的单机模式返回原 store。
- 事件：`project_events.host_id` 已由 Task 3 建列；`recordProjectEvent(rootPath)` 用绑定 host 的 store；路由加 host 段。
- `http-server.ts`：`/events/<host>/<project>`；旧路由在 workspace 内解析本机项目。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/panel-project-hosts.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts src/runtime-host.ts src/panel/web.ts src/panel/actions.ts src/panel/overview.ts src/events/project-resolver.ts src/events/ingress.ts src/http-server.ts test/panel-project-hosts.test.js test/events-hosts.test.js
git commit -m "feat: wire host-scoped project resolution through runtime, panel, and events"
```

---

### Task 9: runner 身份（host_id / instance_id）与双启保护

**Files:**
- Modify: `src/db/types.ts`、`src/db/postgres.ts`、`src/db/memory.ts`、`src/db/file.ts`
- Modify: `src/runner/agent.ts`
- Test: `test/runner-identity.test.js`

**Interfaces:**
- `UpsertRunnerInput` 已含 `hostId`/`instanceId`（Task 4）。
- `PostgresStore.upsertRunner`：`INSERT` → 23505 → `SELECT` 该行：
  - `instance_id` 不同且 `last_seen_at` 在 TTL 内 → 抛 `RunnerAlreadyActiveError`;
  - 陈旧 → `UPDATE ... WHERE instance_id=<旧值>` CAS 接管，失败则抛同一错误。
- `RunnerAgentOptions` 增 `instanceId?: string`；缺省 `randomUUID()`。
- `runRunnerAgent` 捕获 `RunnerAlreadyActiveError` → `errorLog` + `return 2`。

- [ ] **Step 1: Write the failing test**

```js
test("同机同项目第二个 runner 启动 → exit 2，不覆写第一实例", async () => {
  // 第一个 agent 用 fake store 保持 lastSeen 新鲜
  const second = await runRunnerAgent({ ...options, instanceId: "i-2" });
  assert.equal(second, 2);
  assert.equal((await store.listRunners(root)).length, 1);
});

test("陈旧行（lastSeen 超 TTL）可被新实例 CAS 接管", async () => {
  // 预置 instance_id=i-old, last_seen_at=1h 前
  const code = await runRunnerAgent({ ...options, instanceId: "i-new", once: true });
  assert.equal(code, 0);
  assert.equal((await store.listRunners(root))[0].instanceId, "i-new");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/runner-identity.test.js`
Expected: FAIL — 第二个 runner 覆写或未退出。

- [ ] **Step 3: Implement**

- 新错误类 `RunnerAlreadyActiveError`（`src/db/types.ts` 或 `src/runner/errors.ts`）。
- PG `upsertRunner`：
  1. 先尝试 `INSERT`（`host_id`、`instance_id`）；
  2. 23505 → `SELECT` by `(project_id, host_id)`（若唯一索引冲突来自 `(project_id,name)`，也回退按 name 查）；
  3. 判活跃/陈旧；活跃抛错；陈旧 `UPDATE ... WHERE instance_id = $old`。
- `MemoryStore` / `FileStore` 同语义。
- 旧索引 `(project_id, name)` 保留；新索引 `(project_id, host_id)`。
- 旧 runner 行（`host_id IS NULL`）不参与定向领取；`AOS_HOST_STRICT=1` 时 `claimRegressionTask` 直接拒绝无 `host_id` 的 runner（在 runner 侧与 SQL 前各一道）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/runner-identity.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts src/runner/agent.ts src/runner/errors.ts test/runner-identity.test.js
git commit -m "feat: add runner instance identity and double-start guard"
```

---

### Task 10: 任务定向、能力门禁与 beginExecution

**Files:**
- Modify: `src/db/types.ts`、`postgres.ts`、`memory.ts`、`file.ts`
- Modify: `src/runner/agent.ts`
- Test: `test/task-targeting.test.js`

**Interfaces:**
- `RegressionTaskRecord` 增：
  `targetHostId: string | null; createdHostId: string | null; claimedHostId: string | null; claimedInstanceId: string | null; priority: number; lastProgressAt: string | null; cancelSource/cancelledBy/cancelledHostId/cancelledAt/cancelNote/cancelRequestedAt: string | null`
- `CreateRegressionTaskInput` 增 `targetHostId?: string | null; priority?: number; createdHostId?: string | null`。
- `claimRegressionTask` input 增 `hostId: string; instanceId: string; capabilities: string[]`。
- 门禁：任务 `platforms` 必须 ⊆ 本机实时设备平台（现有 `platforms` 参数）；`capabilities` 只用于 OS/工具判定（`ios-*` 必须存在；Android 需要 `android`）。
- 新方法 `beginExecution(input: { rootPath; taskId; runnerId; instanceId; at?: string }): Promise<RegressionTaskRecord | null>`：`claimed → running`，`attempts=attempts+1`，写 `started_at`。
- 新方法 `releaseRegressionTask` 保持不变（设备忙释放回 pending）。

- [ ] **Step 1: Write the failing test**

```js
test("定向任务只被目标主机领取；非目标主机领不到", async () => {
  const task = await store.createRegressionTask({ rootPath: "/w/a", refs, platforms: ["android"], baseline: "latest", targetHostId: "h-b" });
  assert.equal(await store.claimRegressionTask({ rootPath: "/w/a", runnerId: "r-a", hostId: "h-a", instanceId: "i-a", platforms: ["android"], capabilities: ["android"] }), null);
  assert.equal((await store.claimRegressionTask({ rootPath: "/w/a", runnerId: "r-b", hostId: "h-b", instanceId: "i-b", platforms: ["android"], capabilities: ["android"] })).id, task.id);
});

test("iOS 任务不会被 win32 能力主机领取", async () => {
  // capabilities = ["android"] → null；darwin + ios-simulator → claimed
});

test("claim 不增加 attempts；beginExecution 才 +1", async () => {
  const claimed = await store.claimRegressionTask(...);
  assert.equal(claimed.attempts, 0);
  const running = await store.beginExecution({ rootPath: "/w/a", taskId: claimed.id, runnerId: "r-b", instanceId: "i-b" });
  assert.equal(running.status, "running");
  assert.equal(running.attempts, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/task-targeting.test.js`
Expected: FAIL — 字段/方法缺失。

- [ ] **Step 3: Implement**

- DDL：`regression_tasks` 加列（设计 §6.5），`attempts` 默认 0。
- `claimRegressionTask` SQL：`target_host_id IS NULL OR target_host_id=$host`；代码侧：现有 `platforms`（实时设备平台）继续做设备门禁；`capabilities` 再做 OS/工具门禁（`ios-*` 必须存在；`android` 必须存在）。
- `beginExecution`：`UPDATE ... SET status='running', attempts=attempts+1, started_at=$now WHERE id=$id AND status='claimed' AND claimed_instance_id=$instance`。
- `agent.ts`：领取后先检查 `attempts >= maxAttempts` → failed；否则 `beginExecution`；失败则 release。
- 毒丸：`attempts` 只由 `beginExecution` 增加。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/task-targeting.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts src/runner/agent.ts test/task-targeting.test.js
git commit -m "feat: target regression tasks by host with capability gate"
```

---

### Task 11: 中心 CLI（仅 PG）与 host 命令

**Files:**
- Create: `src/center/store.ts`
- Create: `src/host-command.ts`
- Modify: `src/cli.ts`
- Modify: `src/suite-command.ts`
- Test: `test/host-command.test.js`、`test/suite-task-host.test.js`

**Interfaces:**
- `openCenterStore(env?: NodeJS.ProcessEnv): Promise<PostgresStore>`：`MOBILE_TESTING_DATABASE_URL` 必填；缺失抛 `Error("host/queue 命令需要 MOBILE_TESTING_DATABASE_URL")`。
- `runHostCommand(argv: string[], io: { log; errorLog }, deps?: { env?: NodeJS.ProcessEnv; store?: PostgresStore }): Promise<number>`：`list|show|register|adopt-legacy`。
- `suite task create|list|cancel|queue` 识别 `--host`/`--project`；带 `--host` 时不构造 Runtime。
- `host adopt-legacy --local [--dry-run|--apply]`；`--host <id> --path <rootPath>`。

- [ ] **Step 1: Write the failing test**

```js
test("host list 无 PG → exit 2 且提示 MOBILE_TESTING_DATABASE_URL", async () => {
  const code = await runHostCommand(["list"], io, { env: {} });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /MOBILE_TESTING_DATABASE_URL/);
});

test("suite task create --host h-b --project /w/app 不读本地磁盘", async () => {
  // pg-mem 注入 openCenterStore；断言 task.targetHostId === "h-b"
});

test("adopt-legacy --local 只认领本机存在的路径", async () => {
  // 两个 NULL 行：/w/exists（本机存在）与 /w/missing；--local --apply 只改前者
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/host-command.test.js`
Expected: FAIL — command not found.

- [ ] **Step 3: Implement**

- `src/cli.ts`：`host` 子命令路由；`suite queue` 路由。
- `suite-command.ts`：参数解析 `--host`/`--project`；带 host 时 `openCenterStore` + `scopeHost`，不 `defaultBuildRuntime`。
- `host-command.ts`：`list/show/register/adopt-legacy`；`adopt-legacy --local` 用 `fs.existsSync(rootPath)` 过滤 NULL 行；`--apply` 才写。
- `adopt-legacy` 写审计（`recordAudit`）。
- 无 PG：exit 2，文案给 `MOBILE_TESTING_DATABASE_URL` 指引。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/host-command.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/center/store.ts src/host-command.ts src/cli.ts src/suite-command.ts test/host-command.test.js test/suite-task-host.test.js
git commit -m "feat: add center-only host and queue CLI commands"
```

---

### Task 12: 面板定向下发与期望主机登记

**Files:**
- Modify: `src/console/dispatch.ts`
- Modify: `src/panel/actions.ts`
- Modify: `src/panel/web.ts`
- Modify: `src/panel/overview.ts`
- Test: `test/panel-dispatch-hosts.test.js`

**Interfaces:**
- `DispatchPreview` 增 `hosts: Array<{ id; label; hostname; kind; online; capabilities: string[]; queueDepth: number }>`；`runnerCandidates` 保留兼容。
- `computeDispatchPreview(deps, rootPath, params)` 解析 `host` 参数；缺省本地 host；远端必须显式。
- `createTask`：`targetHostId = resolved.hostId`；能力不满足 → 400 + `reasons`。
- Panel API：`POST /panel/api/hosts/register`。
- `renderDispatchPage` 增加主机选择（先选主机，再选项目）。

- [ ] **Step 1: Write the failing test**

```js
test("下发预览只列目标主机；能力不足给原因", async () => {
  const preview = await computeDispatchPreview(deps, "/w/app", new URLSearchParams({ host: "h-win", platforms: "ios" }));
  assert.equal(preview.hosts[0].id, "h-win");
  assert.match(preview.warnings.join(" "), /iOS 需要 macOS/);
});

test("createTask 写 targetHostId；跨主机同名项目不串", async () => {
  // POST /panel/api/tasks { project, host, refs, platforms }
  // 断言 task.targetHostId === host 且 project_id 属于该 host
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/panel-dispatch-hosts.test.js`
Expected: FAIL — host 选择缺失。

- [ ] **Step 3: Implement**

- `computeDispatchPreview`：`listHosts()` + `listProjects()`；按 host 过滤；能力预检函数 `precheckTask({host, platforms})` 返回 `{ok, reasons}`。
- `renderDispatchPage`：主机下拉 + 项目下拉；能力原因显示在提交按钮上方。
- `createTask`：`storeForHost` + `targetHostId`；未知/离线主机按设计提示。
- 优先级：预览与任务卡片显示 `priority`；面板编辑仅在 `AOS_PANEL_PRIORITY=1` 时开放（默认只读）。
- `POST /panel/api/hosts/register`：调用 `updateHostRegistration`，写审计。
- 面板项目列表显示 `label/hostname`，避免同名项目混淆。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/panel-dispatch-hosts.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/console/dispatch.ts src/panel/actions.ts src/panel/web.ts src/panel/overview.ts test/panel-dispatch-hosts.test.js
git commit -m "feat: dispatch tasks to an explicit host from the panel"
```

**Phase P2 gate:** `npm run build && npm test && npm run lint` 全绿；同路径两台机器分别下发，互不领取；iOS 不会投给 win32。

---

## Phase P3 — 队列控制

### Task 13: cancelled 终态、取消来源与审计

**Files:**
- Modify: `src/db/types.ts`、`postgres.ts`、`memory.ts`、`file.ts`
- Modify: `src/panel/actions.ts`
- Modify: `src/suite-command.ts`
- Modify: `src/runner/agent.ts`
- Test: `test/task-cancel.test.js`

**Interfaces:**
- `RegressionTaskRecord.status` 增 `"cancelled"`（保留 `"stopped"` 只读）。
- `type CancelSource = "panel" | "local-cli" | "local-mcp" | "runner" | "admin"`。
- `cancelRegressionTask(input: { rootPath; taskId; source: CancelSource; actor: string; actorHostId: string | null; note?: string | null; at?: string }): Promise<RegressionTaskRecord | null>`：
  - pending → `cancelled` 直接；
  - claimed/running → `stopping` + 元数据（CAS，先写先赢）。
- `audit_events` 加 `actor`、`actor_host_id`、`channel`；`AuditEventInput` 同步加可选字段。
- `mapRegressionTask`：`stopped` → `cancelled`（`cancelSource="panel"`, `cancelNote="legacy stopped"`）。

- [ ] **Step 1: Write the failing test**

```js
test("pending 取消 → cancelled；重复取消幂等", async () => {
  const task = await store.createRegressionTask(...);
  const c1 = await store.cancelRegressionTask({ rootPath, taskId: task.id, source: "local-cli", actor: "louis", actorHostId: "h-a" });
  assert.equal(c1.status, "cancelled");
  assert.equal(c1.cancelledBy, "louis");
  const c2 = await store.cancelRegressionTask({ ... });
  assert.equal(c2.cancelledAt, c1.cancelledAt);
});

test("运行中取消 → stopping；runner 确认后 cancelled", async () => {
  // claim + beginExecution；cancel → stopping；agent 轮询 → cancelled
});

test("stopped 旧行读作 cancelled", async () => {
  // 直接写 status='stopped'，listRegressionTasks → status='cancelled'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/task-cancel.test.js`
Expected: FAIL — `cancelRegressionTask` missing.

- [ ] **Step 3: Implement**

- DDL + mappers + Memory/File。
- `agent.ts`：停止轮询确认时写 `cancelled`（不再写 `stopped`）；`suite run --task` 对 `cancelled` 返回 2。
- 面板 `POST /panel/api/tasks/cancel`；CLI `suite task cancel`。
- 审计写 `actor/channel`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/task-cancel.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts src/panel/actions.ts src/suite-command.ts src/runner/agent.ts test/task-cancel.test.js
git commit -m "feat: add cancelled terminal state with actor and source"
```

---

### Task 14: 本地 MCP 取消工具与手动执行守卫

**Files:**
- Modify: `src/tools/native-tools/workflow.ts`（或新建 `src/tools/native-tools/tasks.ts` 并注册）
- Modify: `src/server.ts`（注册）
- Modify: `src/suite-command.ts`
- Test: `test/task-cancel-tool.test.js`

**Interfaces:**
- 工具 `regression_task_cancel`：`{ taskId: string; note?: string }`；返回 `{ ok, task }`；作用域本机 + 本项目。
- `suite run --task` 守卫：`task.targetHostId`/`claimedHostId` 必须等于本机 host，否则 exit 2。

- [ ] **Step 1: Write the failing test**

```js
test("regression_task_cancel 写 local-mcp 来源与用户名", async () => {
  // InMemoryTransport 调用工具；断言 store 任务 cancelSource === "local-mcp"
});

test("suite run --task 跨主机拒绝", async () => {
  const code = await runSuiteCommand(["run", "--task", taskId, "--device", "emulator-5554"], {
    // 注入本机 host 的 runtime/store
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /不属于本机/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/task-cancel-tool.test.js`
Expected: FAIL — tool not found / guard missing.

- [ ] **Step 3: Implement**

- 原生工具定义放 `src/tools/native-tools/tasks.ts`，`TASK_NATIVE_TOOLS` 注册进 `src/server.ts` 的 `NATIVE_TOOLS`。
- handler 调 `store.cancelRegressionTask({source:"local-mcp", actor: AOS_ACTOR || os.userInfo().username, actorHostId: hostId})`。
- `suiteRunTask`：在读取任务后校验 `targetHostId`/`claimedHostId`；本机 identity 由 `resolveHostIdentity` 获取。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/task-cancel-tool.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools/native-tools/tasks.ts src/server.ts src/suite-command.ts test/task-cancel-tool.test.js
git commit -m "feat: cancel tasks from local MCP with host guard"
```

---

### Task 15: 队列暂停、设备租约与统一 tick

**Files:**
- Modify: `src/db/types.ts`、`postgres.ts`、`memory.ts`、`file.ts`
- Modify: `src/runner/agent.ts`
- Modify: `src/panel/actions.ts`
- Modify: `src/suite-command.ts`
- Test: `test/queue-lease.test.js`

**Interfaces:**
- `interface DeviceLeaseRecord { hostId: string; serial: string; taskId: string; projectId: string | null; acquiredAt: string; renewAt: string; expiresAt: string }`
- `acquireDeviceLeases(input: { hostId; taskId; projectId; serials: string[]; ttlMs?: number; at?: string }): Promise<{ ok: true; leases: DeviceLeaseRecord[] } | { ok: false; busy: string[] }>`
- `renewDeviceLeases(input: { hostId; taskId; serials: string[]; ttlMs?: number; at?: string }): Promise<number>`
- `releaseDeviceLeases(input: { hostId; taskId: string }): Promise<number>`
- `hosts.queue_paused` 已在 Task 3；`claimRegressionTask` 读取并短路。
- `agent.ts` 30s tick：`upsertRunner`（heartbeat）、`upsertHost runnerSeenAt`、`updateRegressionTask lastProgressAt`、`renewDeviceLeases`。

- [ ] **Step 1: Write the failing test**

```js
test("设备租约全有或全无", async () => {
  const first = await store.acquireDeviceLeases({ hostId: "h", taskId: "t1", serials: ["a", "b"] });
  assert.equal(first.ok, true);
  const second = await store.acquireDeviceLeases({ hostId: "h", taskId: "t2", serials: ["b", "c"] });
  assert.equal(second.ok, false);
  assert.deepEqual(second.busy, ["b"]);
  assert.equal((await store.acquireDeviceLeases({ hostId: "h", taskId: "t2", serials: ["c"] })).ok, true);
});

test("队列暂停时 claim 返回 null；恢复后可领", async () => {
  await store.setHostQueuePaused({ hostId: "h", paused: true, by: "panel" });
  assert.equal(await store.claimRegressionTask({ ... hostId: "h" }), null);
});

test("设备忙释放不增加 attempts", async () => {
  // claim → acquire busy → releaseRegressionTask → attempts 仍为 0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/queue-lease.test.js`
Expected: FAIL — lease methods missing.

- [ ] **Step 3: Implement**

- `device_leases` 表 + 三种 store 实现；`acquire` 单事务插入，冲突回滚；`ttlMs` 缺省 `AOS_DEVICE_LEASE_MS`（90000），续租周期 30s。
- `claimRegressionTask` 读取 `hosts.queue_paused`（join 或先查）。
- `agent.ts` 顺序固定：`claim` → `acquireDeviceLeases`（失败：`releaseRegressionTask(to:"pending")`，attempts 不变）→ `beginExecution`（attempts+1）→ `suite run`；`beginExecution` 失败则释放租约并 release（防半持有）。
- tick 统一更新四信号：`runners.last_seen_at`、`hosts.runner_seen_at`、`last_progress_at`、租约续期。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/queue-lease.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts src/runner/agent.ts src/panel/actions.ts src/suite-command.ts test/queue-lease.test.js
git commit -m "feat: pause queues and serialize devices with leases"
```

---

### Task 16: 离线取消清扫器与事件主机维度

**Files:**
- Create: `src/tasks/sweeper.ts`
- Modify: `src/runner/agent.ts`（主循环调用）
- Modify: `src/panel-command.ts` / `src/http-server.ts`（中心后台循环）
- Modify: `src/db/postgres.ts`（`project_events.host_id` 已在 Task 3；补查询）
- Modify: `src/events/project-resolver.ts`、`src/http-server.ts`
- Test: `test/task-sweeper.test.js`、`test/events-host-routing.test.js`

**Interfaces:**
- `sweepStaleTasks(input: { store; rootPath?; now?: number; graceMs?: number; runnerTtlMs?: number }): Promise<{ cancelled: number; released: number }>`
- 幂等：`UPDATE ... WHERE status='stopping' AND cancel_requested_at <= $cutoff`。
- 事件路由 `/events/<host>/<project>`（已在 Task 8 接线；本任务补 `project_events.host_id` 查询与旧数据降级）。

- [ ] **Step 1: Write the failing test**

```js
test("runner 离线时 stopping 超宽限 → cancelled；恢复 runner 不重跑", async () => {
  // 预置 stopping + cancel_requested_at=2min 前 + runner lastSeen=5min 前
  const result = await sweepStaleTasks({ store, now, graceMs: 90_000 });
  assert.equal(result.cancelled, 1);
  assert.equal((await store.getRegressionTask(root, id)).status, "cancelled");
});

test("两个清扫器并发只生效一次", async () => {
  const [a, b] = await Promise.all([sweepStaleTasks(...), sweepStaleTasks(...)]);
  assert.equal(a.cancelled + b.cancelled, 1);
});

test("旧 stopping（无 cancel_source）也转 cancelled", async () => {...});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:file -- test/task-sweeper.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

- `sweepStaleTasks`：查 `stopping` + `cancel_requested_at <= cutoff`；若 `claimed_host` 不在线（`last_seen_at <= now - runnerTtlMs`）→ CAS `cancelled`；旧 `stopping` 无 source 同样处理。
- `agent.ts` 主循环每轮调用；`panel-command.ts`/`http-server.ts` 30s 循环调用。
- 事件：`project_events.host_id` 查询过滤；旧 NULL 行不参与新路由。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:file -- test/task-sweeper.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tasks/sweeper.ts src/runner/agent.ts src/panel-command.ts src/http-server.ts src/db/postgres.ts src/events/project-resolver.ts test/task-sweeper.test.js test/events-host-routing.test.js
git commit -m "feat: sweep offline cancellations and scope events by host"
```

---

### Task 17: 文档、迁移说明与全量验证

**Files:**
- Modify: `DESIGN.md`（新增章节：多机身份/三层信号/队列）
- Modify: `README.md`（`host`/`suite queue`/`suite task cancel` 命令、环境变量）
- Modify: `docs/superpowers/specs/2026-10-21-multi-host-dispatch-design.md`（状态改为“已实现”，补实际偏差）
- Test: 全量 `npm test`

- [ ] **Step 1: Update docs**

- `DESIGN.md` 增加：
  - host identity / host_sessions / 三层信号；
  - `(host_id, root_path)` 项目身份与 `scopeHost`；
  - `cancelled` 状态机、清扫器、设备租约、统一 tick；
  - 迁移与 `host adopt-legacy`（每台机器 `--local`，禁止中心统一认领）；
  - 新环境变量：`AOS_HOST_ID`、`AOS_HOST_DIR`、`AOS_HOST_ENV_REFRESH_MS`、`AOS_CLIENT_TTL_MS`、`AOS_DEVICE_LEASE_MS`、`AOS_CANCEL_GRACE_MS`、`AOS_HOST_STRICT`、`AOS_PANEL_PRIORITY`。
- `README.md` 增加命令示例与部署顺序：升级 PG → 各项目机 `host adopt-legacy --local --dry-run` → `--apply` → 启动 runner。

- [ ] **Step 2: Run full verification**

Run: `npm run build && npm test && npm run lint`
Expected: 全绿；新增测试计入总数；无真实 PG/设备/外网依赖。

- [ ] **Step 3: Manual smoke（可选，不纳入 CI）**

- 本机起 PG + 两个临时项目目录（模拟两台主机，用 `AOS_HOST_ID` 区分），验证：
  - 面板主机视图双状态；
  - `suite task create --host` 定向；
  - 本地 `suite task cancel` 留痕；
  - 设备忙重试不涨 attempts。

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md README.md docs/superpowers/specs/2026-10-21-multi-host-dispatch-design.md
git commit -m "docs: document multi-host identity, dispatch, and queue control"
```

**Phase P3 gate:** `npm run build && npm test && npm run lint` 全绿；设计文档与实际实现一致；`DESIGN.md`/`README.md` 已同步。

---

## Execution Notes

- 任务顺序不可跳：Task 7/8 会改所有 rootPath 键控调用点，必须在 Task 9/10 之前完成。
- 每个任务先写失败测试，再实现；不要先改生产代码再补测试。
- 如果某个任务的文件范围超出预期，停下来把它拆成两个任务，而不是扩大单次提交。
- 所有新类型先在 `src/db/types.ts` 定义，再改 Postgres/Memory/File 三个实现，最后接线调用方。
- **P4 不在本计划**：HTTP 客户端 `project_clients` 记录、跨主机逻辑项目分组（`project_key`）。本期同一 App 跨主机按两个独立项目处理。
