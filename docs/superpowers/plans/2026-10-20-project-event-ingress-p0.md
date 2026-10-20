# 项目事件入口 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable project → MCP event ingress (`POST/GET /events/<project>` + `aos_event_report`/`aos_events`) backed by an idempotent `project_events` store (PG/file/memory), with immediate ack and durable query.

**Architecture:** Validation and canonical payload hashing live in `src/events/`; the store layer owns persistence and idempotency; HTTP and native tools share one ingress service. Event ingress uses a lightweight project resolver (`loadProject` + store upsert) and never creates a full `Runtime`. P0 has no feedback channel, SSE, async jobs, or event→suite mapping.

**Tech Stack:** TypeScript ESM/NodeNext, zod, Node `http`, `pg`/`pg-mem`, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-20-project-event-ingress-design.md`

## Global Constraints

- `receivedAt` is always UTC milliseconds + `Z` (`new Date().toISOString()`).
- `eventId` is client-generated and idempotent per project; duplicate requests never overwrite payloads.
- Event ingress must not create a full `Runtime`, touch artemis/LLM/Figma, or perform network/device work before ack.
- `type`/`source`/`status` are strict allowlists; per-type minimum fields are enforced.
- List responses omit `payload` by default; `includePayload:true` caps `limit` at 50.
- `since` is parsed and normalized to UTC milliseconds before comparison.
- Events are not written to `usage_events`; audit rows never include payload.
- Project name is `^[A-Za-z0-9._-]+$` and must not be `.` or `..`.
- `AOS_EVENTS_RETENTION_DAYS` defaults to 30; `AOS_EVENTS_MAX` defaults to 50000 (per project).
- File ledger writes are not fsynced in P0; ack means “appended to OS buffer and recorded”.
- Keep existing `/mcp`, `/panel`, `/usage`, `/artifact` routes and auth behavior unchanged.

## Review Focus

- **File-ledger duplicate after restart**: a second process start must still return `duplicate:true` for an existing `eventId`; the index must be rebuilt from `events.jsonl` + `events.meta.json`.
- **`seq` after retention compaction**: pruning must not renumber remaining rows or reuse `seq`; the next event must be greater than every previously issued `seq`.
- **Seconds-precision `since`**: `…T07:00:03Z` must not drop events stored as `…T07:00:03.456Z`; normalize before comparing.
- **Ack honesty**: every 202 (HTTP) and every tool ack must carry `storage` and `degraded`, and duplicate acks must return the original `serverId/receivedAt`.
- **Project path safety**: `..`, missing dirs, trailing slashes, and symlinked project roots must not create a second project identity or write outside the workspace.

---

## File Structure

Create:

- `src/events/payload.ts` — stable stringify, payload hash/bytes, `since` normalization.
- `src/events/protocol.ts` — event allowlists, per-type validation, normalized event type.
- `src/events/retention.ts` — retention env parsing, cutoff, reusable prune decision.
- `src/events/project-resolver.ts` — lightweight project root/name resolution.
- `src/events/ingress.ts` — validate → store → ack; async audit; query wrapper.
- `src/tools/native-tools/events.ts` — `aos_event_report`, `aos_events`.
- Tests: `test/events-protocol.test.js`, `test/events-store-memory.test.js`, `test/events-store-file.test.js`, `test/events-store-pg.test.js`, `test/events-project-resolver.test.js`, `test/events-ingress.test.js`, `test/events-http.test.js`, `test/events-tools.test.js`.

Modify:

- `src/db/types.ts` — event record/input/query types and `ProjectStore` methods.
- `src/db/memory.ts` — in-memory event map/seq/query/prune.
- `src/db/file.ts` — `events.jsonl`, `events.meta.json`, startup index, append, query, prune.
- `src/db/postgres.ts` — `project_events` migration + methods.
- `src/http-server.ts` — `/events/<project>` routes; shared root resolution in `getRuntime`.
- `src/server.ts` — register event tools.
- `README.md`, `DESIGN.md`, spec status.

Delete:

- `scripts/migrate-ledger-to-pg.mjs`
- `test/migrate-ledger-to-pg.test.js`

---

### Task 1: Event protocol and canonical payload

**Files:**
- Create: `src/events/payload.ts`
- Create: `src/events/protocol.ts`
- Test: `test/events-protocol.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stableStringify(value: unknown): string`
  - `payloadHash(payload: unknown): string`
  - `payloadBytes(payload: unknown): number`
  - `normalizeSince(value: string): string | null`
  - `EVENT_TYPES`, `EVENT_SOURCES`, `EVENT_STATUSES`, `TERMINAL_EVENT_STATUSES` readonly arrays
  - `validateEventInput(input: unknown, now?: Date): { ok: true; value: ValidatedEventInput } | { ok: false; error: string; field?: string }`
  - `interface ValidatedEventInput { eventId; type; source; at; runId; caseId; step; status; payload }` (nullable fields; payload `unknown`)

- [ ] **Step 1: Write the failing tests**

`test/events-protocol.test.js`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSince,
  payloadHash,
  stableStringify,
  validateEventInput
} from "../dist/events/protocol.js";

test("stableStringify: 键排序、数组保序、缺省归一", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(stableStringify({ a: [2, 1] }), '{"a":[2,1]}');
  assert.equal(stableStringify(undefined), "null");
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
});

test("payloadHash: 键顺序不同同哈希，数组顺序不同不同哈希", () => {
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }));
  assert.notEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [2, 1] }));
  assert.equal(payloadHash(undefined), payloadHash(null));
});

test("normalizeSince: 秒级输入规范化为毫秒 ISO", () => {
  assert.equal(normalizeSince("2026-10-20T07:00:03Z"), "2026-10-20T07:00:03.000Z");
  assert.equal(normalizeSince("bad"), null);
});

test("validateEventInput: per-type 必填与 allowlist", () => {
  const ok = validateEventInput({
    eventId: "e1",
    type: "case.result",
    caseId: "TC_1",
    status: "failed",
    at: "2026-10-20T07:00:03Z",
    payload: { message: "x" }
  }, new Date("2026-10-20T07:00:04Z"));
  assert.equal(ok.ok, true);
  assert.equal(ok.value.at, "2026-10-20T07:00:03.000Z");
  assert.equal(ok.value.source, "project");

  assert.equal(validateEventInput({ eventId: "e", type: "case.result" }).ok, false);
  assert.equal(validateEventInput({ eventId: "e", type: "nope" }).ok, false);
  assert.equal(validateEventInput({ eventId: "e", type: "run.step", runId: "r" }).ok, false);
  assert.equal(validateEventInput({ eventId: "e", type: "run.finished", runId: "r", status: "started" }).ok, false);
  assert.equal(validateEventInput({ eventId: "e", type: "log.entry" }).ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-protocol.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `stableStringify`/hash/bytes/since and validation**

`stableStringify` recursively sorts object keys, preserves arrays, ignores `undefined` object values, and returns `"null"` for top-level `undefined`. `payloadHash` is `sha256(utf8(stableStringify(payload)))`. `payloadBytes` is `Buffer.byteLength(stableStringify(payload))`.

`validateEventInput` enforces: `eventId` 1–128 `[A-Za-z0-9._:-]`; `type` allowlist; `source` default `project` and allowlist; `status` allowlist if present; `at` parseable and normalized to `toISOString()` (default `now`); `runId`/`caseId` ≤128; `step` non-negative integer; `payload` object (not array) when required, `payloadBytes(payload) ≤ 32 * 1024`. Per-type rules from the spec: `run.*` need `runId`; `run.step` needs `step`; `run.finished`/`case.result` need terminal status; `case.*` need `caseId`; `artifact.created` needs `runId` or `caseId` plus payload; `log.entry`/`feedback.request` need payload.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-protocol.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/payload.ts src/events/protocol.ts test/events-protocol.test.js
git commit -m "feat(events): add event protocol and canonical payload hashing"
```

---

### Task 2: Store contract, retention helpers, MemoryStore

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/memory.ts`
- Create: `src/events/retention.ts`
- Test: `test/events-store-memory.test.js`

**Interfaces:**
- Consumes: `payloadHash`, `payloadBytes`, `normalizeSince` from Task 1.
- Produces:
  - `ProjectEventInput`, `ProjectEventRecord`, `ProjectEventQuery`, `RecordProjectEventResult` in `src/db/types.ts`
  - Optional `ProjectStore` methods (made required in Task 4): `recordProjectEvent`, `listProjectEvents`, `countProjectEvents`, `pruneProjectEvents`
  - `eventRetentionPolicy(env?): { days: number; max: number }`
  - `eventCutoffIso(days: number, now?: number): string`

- [ ] **Step 1: Write failing tests**

`test/events-store-memory.test.js`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../dist/db/memory.js";

test("MemoryStore events: 幂等、mismatch、seq 与查询", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const input = { eventId: "e1", type: "case.result", caseId: "TC_1", status: "failed", payload: { b: 2, a: 1 } };
  const first = await store.recordProjectEvent("/w/p1", input);
  assert.equal(first.duplicate, false);
  assert.equal(first.record.seq, 1);
  assert.equal(first.record.source, "project");

  const dup = await store.recordProjectEvent("/w/p1", { ...input, payload: { a: 1, b: 2 } });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.payloadMismatch, false);
  assert.equal(dup.record.id, first.record.id);

  const mismatch = await store.recordProjectEvent("/w/p1", { ...input, payload: { a: 2 } });
  assert.equal(mismatch.duplicate, true);
  assert.equal(mismatch.payloadMismatch, true);
  assert.equal(mismatch.record.id, first.record.id);

  const second = await store.recordProjectEvent("/w/p1", { eventId: "e2", type: "log.entry", payload: { message: "x" } });
  assert.equal(second.record.seq, 2);

  const all = await store.listProjectEvents("/w/p1", { order: "asc", includePayload: true });
  assert.deepEqual(all.map((event) => event.eventId), ["e1", "e2"]);
  assert.equal(all[0].payload.a, 1);
  const noPayload = await store.listProjectEvents("/w/p1", { runId: "missing" });
  assert.deepEqual(noPayload, []);
  assert.equal(await store.countProjectEvents("/w/p1"), 2);
});
```
Add a prune test with a fixed `range` by setting `AOS_EVENTS_MAX=1` and calling `store.pruneProjectEvents("/w/p1")`, asserting the oldest row is removed and `seq` does not reset.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-store-memory.test.js`
Expected: FAIL (`recordProjectEvent` missing).

- [ ] **Step 3: Implement types, retention helpers, MemoryStore**

Add the event types to `src/db/types.ts` exactly as in the spec (§5.4). Add optional methods to `ProjectStore` so existing stores compile until Tasks 3–4:
```ts
recordProjectEvent?(rootPath: string, input: ProjectEventInput): Promise<RecordProjectEventResult>;
listProjectEvents?(rootPath: string, query?: ProjectEventQuery): Promise<ProjectEventRecord[]>;
countProjectEvents?(rootPath: string): Promise<number>;
pruneProjectEvents?(rootPath: string): Promise<number>;
```
MemoryStore keeps `events: Map<rootPath, Map<eventId, ProjectEventRecord>>` and `eventSeq: Map<rootPath, number>`. `recordProjectEvent` resolves the project row (throw if missing), checks the eventId index, compares `payloadHash`, allocates `seq`, sets `receivedAt = new Date().toISOString()`, stores, and returns. `listProjectEvents` filters `runId/caseId/type/status/since` (using `normalizeSince`), sorts by `receivedAt` then `seq` in the requested order, applies `limit` (default 50, max 200; `includePayload` caps at 50), and omits payload when `includePayload !== true`. `pruneProjectEvents` removes rows older than `eventCutoffIso(policy.days)` and rows beyond `policy.max` (oldest `seq` first), returning the count; never reset `eventSeq`.

`src/events/retention.ts` parses `AOS_EVENTS_RETENTION_DAYS` (positive int, default 30) and `AOS_EVENTS_MAX` (positive int, default 50000); `eventCutoffIso` returns `new Date(now - days*86400000).toISOString()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-store-memory.test.js test/events-protocol.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/memory.ts src/events/retention.ts test/events-store-memory.test.js
git commit -m "feat(events): add event store contract, retention helpers and memory store"
```

---

### Task 3: FileStore event ledger

**Files:**
- Modify: `src/db/file.ts`
- Test: `test/events-store-file.test.js`

**Interfaces:**
- Consumes: Task 1 payload helpers, Task 2 types/retention.
- Produces: `FileStore.recordProjectEvent/listProjectEvents/countProjectEvents/pruneProjectEvents`.

- [ ] **Step 1: Write failing tests**

`test/events-store-file.test.js`:
```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../dist/db/file.js";
import { makeTempDir } from "./helpers.js";

async function makeFileStore(root) {
  process.env.AOS_LEDGER_DIR = root;
  const store = await FileStore.create();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  return store;
}

test("FileStore events: 重启后判重、seq 持久化、裁剪不复用 seq", async () => {
  const root = makeTempDir("aos-events-file-");
  const ledger = path.join(root, "ledger");
  const store = await makeFileStore(ledger);
  const first = await store.recordProjectEvent("/w/p1", {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "passed", payload: { a: 1 }
  });
  assert.equal(first.record.seq, 1);
  await store.close();

  const reopened = await makeFileStore(ledger);
  const dup = await reopened.recordProjectEvent("/w/p1", {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "passed", payload: { a: 1 }
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.record.id, first.record.id);

  process.env.AOS_EVENTS_MAX = "1";
  const second = await reopened.recordProjectEvent("/w/p1", { eventId: "e2", type: "log.entry", payload: { message: "x" } });
  assert.equal(second.record.seq, 2);
  await reopened.pruneProjectEvents("/w/p1");
  const third = await reopened.recordProjectEvent("/w/p1", { eventId: "e3", type: "log.entry", payload: { message: "y" } });
  assert.equal(third.record.seq, 3, "裁剪后 seq 不回收");
  const lines = fs.readFileSync(path.join(ledger, "events.jsonl"), "utf-8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.seq), [2, 3]);
});
```
Add tests for filters (`since` seconds precision, `runId`, `order`, `includePayload`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-store-file.test.js`
Expected: FAIL (`recordProjectEvent` missing).

- [ ] **Step 3: Implement FileStore event ledger**

Extend the per-project bucket with `eventsPath`, `eventsMetaPath`, `events: Map<string, ProjectEventRecord>`, `eventsLoaded`, `nextSeq`. On first event access, scan `events.jsonl` (skip bad lines with a log warning), index by `eventId`, track max `seq`, read `events.meta.json` `{nextSeq}`, and set `nextSeq = max(maxSeq, meta.nextSeq)`. `recordProjectEvent` checks the index before writing, compares hashes, allocates `seq`, writes `events.meta.json` atomically first, then appends the JSONL line, updates the index, and schedules `pruneProjectEvents` via `setImmediate` (throttle 5 min per root). Throw on append failure. `pruneProjectEvents` filters expired/overflow rows, rewrites the file atomically, updates the index, keeps `nextSeq`, and returns deleted count. Do not touch `state.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-store-file.test.js test/events-store-memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/file.ts test/events-store-file.test.js
git commit -m "feat(events): persist project events in the file ledger with stable seq"
```

---

### Task 4: PostgresStore event table

**Files:**
- Modify: `src/db/postgres.ts`
- Modify: `src/db/types.ts` (make methods required)
- Test: `test/events-store-pg.test.js`

**Interfaces:**
- Consumes: Task 2 types/retention, Task 1 payload helpers.
- Produces: PG implementations of all four event methods; `ProjectStore` methods become required.

- [ ] **Step 1: Write failing tests**

`test/events-store-pg.test.js`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

test("PostgresStore events: 幂等、mismatch、查询与裁剪", async () => {
  const store = await makePgStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const first = await store.recordProjectEvent("/w/p1", {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "failed", payload: { a: 1, b: 2 }
  });
  assert.equal(first.record.seq, 1);
  const dup = await store.recordProjectEvent("/w/p1", {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "failed", payload: { b: 2, a: 1 }
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.payloadMismatch, false);
  assert.equal(dup.record.id, first.record.id);
  const mismatch = await store.recordProjectEvent("/w/p1", {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "failed", payload: { a: 2 }
  });
  assert.equal(mismatch.payloadMismatch, true);

  const all = await store.listProjectEvents("/w/p1", { order: "asc", includePayload: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].payload.a, 1);
});
```
Add a prune test setting `AOS_EVENTS_MAX=1` and calling `pruneProjectEvents`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-store-pg.test.js`
Expected: FAIL (`recordProjectEvent` missing).

- [ ] **Step 3: Implement PG table and methods**

Add to the MIGRATIONS array a `CREATE TABLE IF NOT EXISTS project_events` with `seq BIGSERIAL`, `payload_bytes INTEGER NOT NULL`, the unique `(project_id,event_id)`, FK, and indexes from the spec. Implement `recordProjectEvent` with `INSERT ... ON CONFLICT (project_id,event_id) DO NOTHING RETURNING *`; on no row, select the existing row and compare `payload_sha256`. Implement `listProjectEvents` with parameterized filters, `order`, `limit`, and optional payload projection; `countProjectEvents`; `pruneProjectEvents` (expired + overflow, return count). Schedule prune asynchronously after writes (throttle 5 min per root). Change the four interface methods from optional to required in `src/db/types.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-store-pg.test.js test/events-store-file.test.js test/events-store-memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/postgres.ts src/db/types.ts test/events-store-pg.test.js
git commit -m "feat(events): persist project events in PostgreSQL"
```

---

### Task 5: Lightweight project resolver

**Files:**
- Create: `src/events/project-resolver.ts`
- Modify: `src/http-server.ts` (`getRuntime` root construction)
- Test: `test/events-project-resolver.test.js`

**Interfaces:**
- Consumes: `loadProject`, `ProjectStore`.
- Produces:
  - `isValidProjectName(name: string): boolean`
  - `resolveProjectRoot(workspaceRoot: string, name: string): string | null`
  - `resolveEventProject(input: { workspaceRoot; name; store; write: boolean }): Promise<{ rootPath: string; projectId: string | null } | null>`

- [ ] **Step 1: Write failing tests**

`test/events-project-resolver.test.js`:
```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../dist/db/memory.js";
import { resolveEventProject, resolveProjectRoot } from "../dist/events/project-resolver.js";
import { makeTempDir } from "./helpers.js";

test("resolveProjectRoot: 拒绝 . 与 ..，缺失目录返回 null", () => {
  const workspace = makeTempDir("aos-events-ws-");
  assert.equal(resolveProjectRoot(workspace, ".."), null);
  assert.equal(resolveProjectRoot(workspace, "."), null);
  assert.equal(resolveProjectRoot(workspace, "missing"), null);
  const dir = path.join(workspace, "demo");
  fs.mkdirSync(dir);
  assert.equal(resolveProjectRoot(workspace, "demo"), fs.realpathSync(dir));
});

test("resolveEventProject: POST upsert 与 GET 不写", async () => {
  const workspace = makeTempDir("aos-events-ws-");
  const dir = path.join(workspace, "demo");
  fs.mkdirSync(dir);
  const store = new MemoryStore();
  const get = await resolveEventProject({ workspaceRoot: workspace, name: "demo", store, write: false });
  assert.equal(get.projectId, null);
  assert.equal(await store.getProjectByPath(dir), null);
  const post = await resolveEventProject({ workspaceRoot: workspace, name: "demo", store, write: true });
  assert.ok(post.projectId);
  assert.equal((await store.getProjectByPath(dir)).id, post.projectId);
  await assert.rejects(
    () => resolveEventProject({ workspaceRoot: workspace, name: "..", store, write: true }),
    /项目名/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-project-resolver.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement resolver and reuse root construction**

`resolveProjectRoot` validates the name, rejects `.`/`..`, resolves `path.resolve(workspaceRoot, name)`, requires an existing directory, and returns `fs.realpathSync.native(root)`. `resolveEventProject` uses `loadProject({ env: { ...process.env, AOS_PROJECT_DIR: root, AOS_CONFIG: "" }, cwd: root })`; on config errors throw an error whose message starts `project-config-invalid`. For `write:true`, call `store.upsertProject({ rootPath: root, name })`; for `write:false`, call `store.getProjectByPath(root)` and return `projectId: null` if absent. Cache results for 60s keyed by `(workspaceRoot,name,write)`, but never cache errors. Change `getRuntime` in `src/http-server.ts` to use `resolveProjectRoot(workspaceRoot, project)` instead of `path.join` (return null when null).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-project-resolver.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/project-resolver.ts src/http-server.ts test/events-project-resolver.test.js
git commit -m "feat(events): resolve event projects without creating a runtime"
```

---

### Task 6: Ingress service and async audit

**Files:**
- Create: `src/events/ingress.ts`
- Test: `test/events-ingress.test.js`

**Interfaces:**
- Consumes: Task 1 validation, Task 2–4 stores, Task 2 retention.
- Produces:
  - `interface EventIngressContext { store: ProjectStore; rootPath: string; storage: "postgres" | "file" | "memory"; degraded: string | null }`
  - `reportProjectEvent(ctx, input: unknown): Promise<{ accepted; duplicate; payloadMismatch?; serverId; eventId; receivedAt; storage; degraded }>`
  - `listProjectEvents(ctx, query: ProjectEventQuery): Promise<{ events; returned; includePayload; storage; degraded }>`
  - `class EventValidationError extends Error { field?: string }`

- [ ] **Step 1: Write failing tests**

`test/events-ingress.test.js`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../dist/db/memory.js";
import { EventValidationError, reportProjectEvent, listProjectEvents } from "../dist/events/ingress.js";

test("ingress: ack 带 storage/degraded，重复取既有身份，审计脱敏", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const ctx = { store, rootPath: "/w/p1", storage: "memory", degraded: "memory fallback" };
  const ack = await reportProjectEvent(ctx, {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "passed", payload: { secret: "x" }
  });
  assert.equal(ack.accepted, true);
  assert.equal(ack.storage, "memory");
  assert.equal(ack.degraded, "memory fallback");

  const dup = await reportProjectEvent(ctx, {
    eventId: "e1", type: "case.result", caseId: "TC_1", status: "passed", payload: { secret: "x" }
  });
  assert.equal(dup.accepted, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.serverId, ack.serverId);
  assert.equal(dup.receivedAt, ack.receivedAt);

  const listed = await listProjectEvents(ctx, { includePayload: false });
  assert.equal(listed.returned, 1);
  assert.equal(listed.events[0].payload, undefined);
  await assert.rejects(() => reportProjectEvent(ctx, { eventId: "e2", type: "nope" }), EventValidationError);
});
```
Add a test that audit rows are written asynchronously with `domain:"project-event"`, `action:type`, `refs.eventId`, and no payload string.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-ingress.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement ingress**

`reportProjectEvent` validates input, calls `store.recordProjectEvent(ctx.rootPath, value)`, builds the ack, and schedules `store.recordAudit` with `setImmediate`:
```ts
domain: "project-event",
action: result.record.type,
result: "ok",
summary: `${result.record.type} ${result.record.eventId}`.slice(0, 300),
refs: { eventId, runId, caseId, status }
```
No payload in the summary/refs. Duplicate acks return the stored `id`/`receivedAt`. `listProjectEvents` calls `store.listProjectEvents`, normalizes `since` (invalid → `EventValidationError`), clamps limit, and returns `payload` omitted unless requested. If the store lacks the methods (should not after Task 4), throw `"event store unavailable"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-ingress.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/ingress.ts test/events-ingress.test.js
git commit -m "feat(events): add ingress service with immediate ack and async audit"
```

---

### Task 7: HTTP event routes

**Files:**
- Modify: `src/http-server.ts`
- Test: `test/events-http.test.js`

**Interfaces:**
- Consumes: Task 5 resolver, Task 6 ingress.
- Produces: `POST /events/<project>` (202) and `GET /events/<project>`.

- [ ] **Step 1: Write failing tests**

`test/events-http.test.js`:
```js
// Use createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot, store: new MemoryStore() })
// and fetch(`http://127.0.0.1:${handle.port}/events/demo`, ...).
test("events HTTP: POST/GET、幂等、400/404/413", async () => {
  // 1. POST valid event -> 202, body.storage === "memory", body.degraded is string
  // 2. POST same event -> 202, duplicate true, same serverId
  // 3. GET ?includePayload=false -> payload omitted, returned 1
  // 4. POST invalid type -> 400; POST /events/.. -> 400; GET /events/missing -> 404
  // 5. POST body > 64 KiB -> 413
});
```
Add an auth test with `AOS_HTTP_TOKEN` set: missing Authorization → 401 for `/events/demo`, while `/healthz` stays exempt.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-http.test.js`
Expected: FAIL (404/route missing).

- [ ] **Step 3: Implement routes**

Add `MAX_EVENT_BODY_BYTES = 64 * 1024`. Before the `/mcp` match, handle `POST /events/<project>` and `GET /events/<project>`:
- validate/decode project name; `resolveEventProject` with `write` true for POST, false for GET;
- POST `readBody(req, MAX_EVENT_BODY_BYTES)`, call `reportProjectEvent` with `storage: store.kind`, `degraded: runtimeHost.storeNote`; return 202; map `EventValidationError` to 400, missing project to 404, body-too-large to 413, store errors to 500;
- GET parse `since/runId/caseId/type/status/limit/order/includePayload`, call `listProjectEvents`, return 200;
- no Runtime creation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-http.test.js test/http-server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http-server.ts test/events-http.test.js
git commit -m "feat(events): add HTTP project event ingress and query routes"
```

---

### Task 8: MCP tools

**Files:**
- Create: `src/tools/native-tools/events.ts`
- Modify: `src/server.ts`
- Test: `test/events-tools.test.js`

**Interfaces:**
- Consumes: Task 6 ingress.
- Produces: native tools `aos_event_report`, `aos_events`; `EVENTS_NATIVE_TOOLS` array.

- [ ] **Step 1: Write failing tests**

`test/events-tools.test.js`: use `loadTestRuntime` + `createServerForRuntime` + `InMemoryTransport` (pattern from `test/usage-tool.test.js`). Assert:
- `tools/list` includes `aos_event_report` and `aos_events`;
- report returns `{accepted:true, storage:"memory"|"file"|"postgres", degraded:...}`;
- duplicate returns `accepted:false, duplicate:true`;
- query returns the event and omits payload by default;
- invalid type returns a tool error.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/events-tools.test.js`
Expected: FAIL (tools missing).

- [ ] **Step 3: Implement tools and register**

`events.ts` defines `EVENTS_NATIVE_TOOLS` with zod schemas. `aos_event_report` uses `validateEventInput` fields (eventId regex, type/source/status enums, optional runId/caseId/step/at, payload `z.unknown()`); handler calls `reportProjectEvent({ store: runtime.store, rootPath: runtime.project.rootDir, storage: runtime.store.kind, degraded: runtime.storeNote }, args)`. `aos_events` accepts filters and returns the list. Import `EVENTS_NATIVE_TOOLS` in `src/server.ts` and add it to `NATIVE_TOOLS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/events-tools.test.js test/server-smoke.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/native-tools/events.ts src/server.ts test/events-tools.test.js
git commit -m "feat(events): expose event report and query as MCP tools"
```

---

### Task 9: Retire external script, docs, full verification

**Files:**
- Delete: `scripts/migrate-ledger-to-pg.mjs`
- Delete: `test/migrate-ledger-to-pg.test.js`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `docs/superpowers/specs/2026-10-20-project-event-ingress-design.md` (status)
- Modify: `docs/superpowers/specs/2026-10-20-test-case-authoring-design.md` if it references the script (it does not)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: P0 shipped, docs consistent.

- [ ] **Step 1: Delete the external migration path**

```bash
rm scripts/migrate-ledger-to-pg.mjs test/migrate-ledger-to-pg.test.js
```
Remove the README “文件台账补 PG（一次性）” bullet and the DESIGN §13.136 reference to the script; keep a note that historical usage/regression-task migration is unavailable until P1 and `suite backfill` still covers runs/case-sets.

- [ ] **Step 2: Update docs**

- DESIGN §13.137: change “设计稿（评审修订版，未实施）” to “实施记录（P0）”; list files, event routes/tools, storage behavior, tests, and final test count.
- README: add `POST/GET /events/<project>` examples and the two MCP tools under the HTTP/tool sections; state that `AOS_HTTP_TOKEN` guards the route.
- Spec status: “P0 已实施（2026-10-20）；P1/P2 未实施”.

- [ ] **Step 3: Run full verification**

```bash
npm run build
npm test
npm run lint
```
Expected: build passes; all tests pass (including new event tests, excluding the deleted migration tests); lint 0 errors (only the two pre-existing warnings).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(events): ship project event ingress P0"
```

---

## Self-Review

**Spec coverage:** Every P0 spec section maps to a task: protocol (§4 → Task 1), stores/retention (§5 → Tasks 2–4), lightweight resolver (§6.1 → Task 5), ingress/ack/audit (§6.2–6.3, §8 → Tasks 6–8), HTTP (§6.2 → Task 7), tools (§6.3 → Task 8), security (§7 → Tasks 1/5/7), migration retire (§9 → Task 9), tests (§11 → each task).

**Type consistency:** `ProjectEventInput`/`ProjectEventRecord`/`ProjectEventQuery` are defined once in `src/db/types.ts`; `ValidatedEventInput` in `src/events/protocol.ts` is structurally identical. `recordProjectEvent`/`listProjectEvents`/`countProjectEvents`/`pruneProjectEvents` names are used consistently in stores, ingress, HTTP, and tools.

**Review Focus:** Each of the five items has a named test: file restart duplicate (Task 3), seq after prune (Task 3), seconds `since` (Tasks 1/3/4), ack storage/degraded (Tasks 6–8), path safety (Task 5/7).

**Proportion:** The plan names signatures and test assertions; implementation bodies are left to the executor. If any task grows beyond one focused change, split it before starting.
