# LLM Token Pool and Usage Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral LLM token pool with request-level usage accounting, atomic token/cost budgets, and project-level read-only statistics for the center proxy and Node `chat.ts`.

**Architecture:** Pool tokens, prices, usage events, budget counters, and reservations live in the existing `ProjectStore` abstraction (PostgreSQL first; FileStore/MemoryStore best-effort). A provider adapter normalizes vendor usage into `base_input` / `cache_creation` / `cache_read` / `output`; the proxy and `chat.ts` estimate before the call, atomically reserve, then settle with real usage or a deterministic estimate. No request is ever free because usage was missing.

**Tech Stack:** TypeScript ESM + NodeNext, Node 20+, `pg`/`pg-mem`, FileStore JSON/JSONL, zod native tools, `node:test`, `js-tiktoken` for token estimation.

**Spec:** `docs/superpowers/specs/2026-11-11-llm-token-pool-design.md`

## Global Constraints

- v1 meters **center proxy + Node `chat.ts` only**. Local Android Artemis direct provider calls are out of scope and keep using project-owned keys.
- Keys never appear in MCP responses, logs, panel HTML/JSON, or CLI output; only `maskSecret()` previews and `keyEnv` names.
- No silent model/capability downgrade. `pinned` token failure is an explicit error; `auto` only switches tokens for the same model.
- No request-level token retry. A failed request may try the next token only before forwarding.
- Default budget period `monthly`; default base currency `CNY` (`AOS_LLM_COST_CURRENCY` overrides).
- Unpriced models are never zero-cost: budget uses the penalty rate (`AOS_LLM_UNPRICED_MICROS_PER_MTOK`, default `20000000`).
- Never inject `stream_options.include_usage` unless the selected token has `supports_stream_usage=true`.
- Failed, disconnected, or usage-less requests must settle to a deterministic charge or an explicit release; `usage_unavailable` is not a free pass.
- Atomic reservation is required before claiming a hard budget. PG uses one conditional `UPDATE ... RETURNING`; FileStore/MemoryStore use a single-process mutex + `max_concurrency`.
- Tests must not use real PostgreSQL, devices, or external network. Use `pg-mem`, memory/file stores, and injected `fetch`.
- Every task ends with `npm run build` and its focused test file green. Final task runs `npm run build && npm test && npm run lint`.
- User-facing copy in Chinese; code identifiers in English; no non-obvious comments.

## Review Focus

These are the inputs/failure modes most likely to bite a user, and each has a test in the task that owns the code:

1. **Endpoint rejects `stream_options`** — a stream request must still succeed; the proxy must not inject the parameter unless capability is known true.
2. **Client disconnects mid-stream** — the reservation must settle from partial output or the estimate, never leak `reserved`.
3. **Anthropic/DeepSeek cache shapes** — `input_tokens` excludes cache; `prompt_cache_hit_tokens`/`miss` are separate. Never use `prompt - cache_read` universally.
4. **50 concurrent requests against a small limit** — `used + reserved` must never exceed the limit; only the allowed count proceeds.
5. **Unpriced model with only a money budget** — penalty pricing must reserve/block it; `cost=null` must not bypass the budget.
6. **Mixed CNY/USD prices** — project totals use only `cost_micros_base`; a missing FX rate is reported, never summed as if 1:1.

---

## File Structure

**Create**

- `src/llm/pool/period.ts` — UTC period keys (`daily`/`monthly`/`total`/`none`).
- `src/llm/pool/usage.ts` — normalized usage shape + vendor mapping.
- `src/llm/pool/pricing.ts` — price lookup, cost, FX, penalty rate, base currency.
- `src/llm/pool/estimate.ts` — `js-tiktoken` prompt estimate + conservative fallbacks.
- `src/llm/pool/stream.ts` — SSE tap that extracts the final usage chunk and counts output.
- `src/llm/pool/provider-adapter.ts` — request rewrites (DeepSeek `json_schema` → `json_object`).
- `src/llm/pool/resolve.ts` — project binding → ordered pool candidates.
- `src/llm/pool/budget-service.ts` — estimate + reserve + settle orchestration.
- `src/llm/pool/chat-budget.ts` — `ChatBudget` adapter for `makeChatFn`.
- `src/llm/pool/aggregate.ts` — bucket/group usage events into a report.
- `src/llm/command.ts` — `llm pool|price|usage` CLI.
- `test/llm-pool-store.test.js`
- `test/llm-pool-pricing.test.js`
- `test/llm-pool-estimate.test.js`
- `test/llm-pool-resolve.test.js`
- `test/llm-pool-command.test.js`
- `test/llm-proxy-pool.test.js`
- `test/llm-chat-budget.test.js`
- `test/llm-usage-command.test.js`

**Modify**

- `src/db/types.ts` — records, inputs, `ProjectStore` methods, `ProjectLlmRecord` pool fields.
- `src/db/postgres.ts` — schema, migrations, mapping, pool CRUD, atomic reservations, usage query.
- `src/db/memory.ts` — same methods in memory.
- `src/db/file.ts` — `llm-pool.json` + `llm-usage.jsonl`, mutex, same methods.
- `src/llm/chat.ts` — normalized usage callback + optional `ChatBudget`.
- `src/llm/registry.ts` — carry pool fields on `LlmEntry`.
- `src/runtime.ts` — `makeChatFor`, local usage recording, entries mapping.
- `src/runner/control/llm-resolver.ts` — pool-aware candidate resolution.
- `src/runner/control/llm-proxy.ts` — reserve/settle, stream capability, model guard.
- `src/runner/control/suite-service.ts` — `getLlm` uses the resolved pool model.
- `src/tools/native-tools/llm.ts` — read-only `llm_pool_list`, `llm_usage`.
- `src/tools/llm.ts` — handlers for the two read-only tools.
- `src/cli.ts` — wire `llm` command.
- `src/console/pages.ts` — ops page pool/usage card.
- `src/panel/web.ts` — `GET /panel/api/llm/pool`, `GET /panel/api/llm/usage`.
- `src/ios/run-loop.ts`, `src/figma/test-gen.ts`, `src/pen/flows.ts`, `src/workflow/design-to-test.ts`, `src/workflow/setup.ts`, `src/workflow/verify-jira.ts` — use `runtime.makeChatFor`.
- `DESIGN.md`, `README.md` — design and usage docs.
- `package.json` / lockfile — `js-tiktoken`.

---

## Task 1: Persistence and Atomic Budget Primitives

**Files:**
- Create: `src/llm/pool/period.ts`
- Modify: `src/db/types.ts`
- Modify: `src/db/postgres.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/file.ts`
- Test: `test/llm-pool-store.test.js`

**Interfaces:**
- Consumes: existing `ProjectStore`, `withTransaction`, `writeFileAtomic`, `maskSecret`.
- Produces: all pool records and store methods below; later tasks use these exact names.

```ts
export type LlmPoolStatus = "active" | "disabled" | "invalid" | "pending_token";
export type LlmPoolMode = "pinned" | "auto";
export type LlmBudgetPeriod = "daily" | "monthly" | "total" | "none";
export type LlmUsageSource = "provider" | "estimated" | "partial";
export type LlmUsageOrigin = "center_proxy" | "local_chat" | "web_job" | "imported";
export type LlmUsageStatus = "ok" | "http_error" | "usage_unavailable" | "settled_estimated";

export interface LlmPoolTokenRecord {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  keyEnv: string | null;
  modelAllowlist: string[];
  status: LlmPoolStatus;
  priority: number;
  budgetPeriod: LlmBudgetPeriod;
  budgetLimitMicros: number | null;
  budgetLimitTokens: number | null;
  currency: string;
  maxConcurrency: number;
  supportsStreamUsage: boolean;
  lastValidatedAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmPriceRecord {
  id: string;
  version: number;
  provider: string;
  model: string;
  currency: string;
  fxRateToBase: number;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  cacheReadMicrosPerMtok: number | null;
  cacheWriteMicrosPerMtok: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdBy: string | null;
  note: string | null;
  createdAt: string;
}

export interface LlmUsageRecord {
  id: string;
  at: string;
  projectId: string | null;
  projectRoot: string | null;
  hostId: string | null;
  sessionId: string | null;
  taskId: string | null;
  traceId: string | null;
  poolTokenId: string | null;
  provider: string;
  model: string;
  baseInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageSource: LlmUsageSource;
  estimatedTokens: number | null;
  reservedMicros: number | null;
  reservationId: string | null;
  settledAt: string | null;
  costMicros: number | null;
  currency: string | null;
  costMicrosBase: number | null;
  baseCurrency: string;
  fxRateToBase: number | null;
  priceBookId: string | null;
  priceVersion: number | null;
  source: LlmUsageOrigin;
  requestId: string | null;
  status: LlmUsageStatus;
  errorClass: string | null;
}

export interface LlmReservationRecord {
  id: string;
  poolTokenId: string;
  periodKey: string;
  projectId: string | null;
  projectRoot: string;
  provider: string;
  model: string;
  source: LlmUsageOrigin;
  estimatedPromptTokens: number;
  estimatedOutputTokens: number;
  estimatedTokens: number;
  reservedMicros: number;
  status: "active" | "settled" | "released";
  createdAt: string;
  expiresAt: string;
  settledAt: string | null;
  hostId: string | null;
  sessionId: string | null;
  taskId: string | null;
  traceId: string | null;
  requestId: string | null;
}

export interface LlmBudgetSnapshot {
  poolTokenId: string;
  period: LlmBudgetPeriod;
  periodKey: string;
  usedTokens: number;
  usedMicros: number;
  reservedTokens: number;
  reservedMicros: number;
  limitTokens: number | null;
  limitMicros: number | null;
  activeReservations: number;
  maxConcurrency: number;
  remainingTokens: number | null;
  remainingMicros: number | null;
}

export type ReserveLlmBudgetResult =
  | { ok: true; reservation: LlmReservationRecord }
  | {
      ok: false;
      reason: "token-not-found" | "token-inactive" | "budget-exhausted" | "concurrency-limit";
      snapshot: LlmBudgetSnapshot | null;
    };

export interface NormalizedUsage {
  baseInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UpsertLlmPoolTokenInput {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** Undefined keeps the stored key; null clears it. */
  apiKey?: string | null;
  keyEnv?: string | null;
  modelAllowlist?: string[];
  status?: LlmPoolStatus;
  priority?: number;
  budgetPeriod?: LlmBudgetPeriod;
  budgetLimitMicros?: number | null;
  budgetLimitTokens?: number | null;
  currency?: string;
  maxConcurrency?: number;
  supportsStreamUsage?: boolean;
  lastValidatedAt?: string | null;
  lastError?: string | null;
  createdBy?: string | null;
  at?: string;
}

export interface UpsertLlmPriceInput {
  id?: string;
  provider: string;
  model: string;
  currency: string;
  fxRateToBase?: number;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  cacheReadMicrosPerMtok?: number | null;
  cacheWriteMicrosPerMtok?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  createdBy?: string | null;
  note?: string | null;
}

export interface ReserveLlmBudgetInput {
  poolTokenId: string;
  projectRoot: string;
  provider: string;
  model: string;
  source: LlmUsageOrigin;
  estimatedPromptTokens: number;
  estimatedOutputTokens: number;
  estimatedMicros: number;
  at?: string;
  ttlMs?: number;
  hostId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  traceId?: string | null;
  requestId?: string | null;
}

export interface SettleLlmReservationInput {
  reservationId: string;
  usage: NormalizedUsage;
  usageSource: LlmUsageSource;
  costMicros: number | null;
  currency: string | null;
  costMicrosBase: number | null;
  baseCurrency: string;
  fxRateToBase: number | null;
  priceBookId: string | null;
  priceVersion: number | null;
  status: LlmUsageStatus;
  errorClass?: string | null;
  at?: string;
}

export interface RecordLlmUsageInput {
  projectRoot: string | null;
  projectId?: string | null;
  hostId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  traceId?: string | null;
  poolTokenId: string | null;
  provider: string;
  model: string;
  usage: NormalizedUsage;
  usageSource: LlmUsageSource;
  estimatedTokens?: number | null;
  reservedMicros?: number | null;
  reservationId?: string | null;
  settledAt?: string | null;
  costMicros: number | null;
  currency: string | null;
  costMicrosBase: number | null;
  baseCurrency: string;
  fxRateToBase: number | null;
  priceBookId: string | null;
  priceVersion: number | null;
  source: LlmUsageOrigin;
  requestId?: string | null;
  status: LlmUsageStatus;
  errorClass?: string | null;
  at?: string;
}

export interface LlmUsageQuery {
  projectRoot?: string;
  poolTokenId?: string;
  provider?: string;
  model?: string;
  since?: string;
  until?: string;
  /** Default 5000, max 50000. */
  limit?: number;
  bucket?: "hour" | "day" | "month";
  groupBy?: "project" | "model" | "token" | "none";
}
```

Add `src/llm/pool/period.ts`:

```ts
export function budgetPeriodKey(period: LlmBudgetPeriod, at?: string): string;
// daily -> YYYY-MM-DD (UTC), monthly -> YYYY-MM, total -> "total", none -> "all"
```

Add to `ProjectStore`:

```ts
setLlmPoolBinding(input: {
  rootPath: string;
  name: string;
  poolTokenId: string | null;
  poolMode?: LlmPoolMode;
  poolModel?: string | null;
}): Promise<boolean>;

listLlmPoolTokens(): Promise<LlmPoolTokenRecord[]>;
getLlmPoolToken(id: string): Promise<LlmPoolTokenRecord | null>;
upsertLlmPoolToken(input: UpsertLlmPoolTokenInput): Promise<LlmPoolTokenRecord>;
listLlmPrices(query?: { provider?: string; model?: string; at?: string }): Promise<LlmPriceRecord[]>;
upsertLlmPrice(input: UpsertLlmPriceInput): Promise<LlmPriceRecord>;
reserveLlmBudget(input: ReserveLlmBudgetInput): Promise<ReserveLlmBudgetResult>;
settleLlmReservation(input: SettleLlmReservationInput): Promise<LlmUsageRecord | null>;
releaseLlmReservation(input: { reservationId: string; at?: string }): Promise<boolean>;
reconcileLlmReservations(input?: { at?: string; limit?: number }): Promise<{ settled: number; released: number }>;
getLlmBudgetSnapshot(tokenId: string, at?: string): Promise<LlmBudgetSnapshot | null>;
recordLlmUsage(input: RecordLlmUsageInput): Promise<LlmUsageRecord>;
listLlmUsageEvents(query?: LlmUsageQuery): Promise<LlmUsageRecord[]>;
```

`ProjectLlmRecord` gains `poolTokenId: string | null`, `poolMode: LlmPoolMode`, `poolModel: string | null`.
`UpsertLlmInput` gains the same optional fields.

- [ ] **Step 1: Add the records and store method declarations**

Add the types above to `src/db/types.ts`; update `ProjectLlmRecord`, `UpsertLlmInput`, and `ProjectStore`. Do not implement methods in this step.

- [ ] **Step 2: Add PostgreSQL schema and migrations**

Add tables in the `SCHEMA` array:

- `llm_pool_tokens` — all fields above; `name TEXT NOT NULL UNIQUE`; `model_allowlist TEXT NOT NULL DEFAULT '[]'`; `supports_stream_usage BOOLEAN NOT NULL DEFAULT FALSE`.
- `llm_price_book` — all fields above; `UNIQUE(provider, model, currency, effective_from)`.
- `llm_usage_events` — all fields above; indexes on `(project_id, at)`, `(pool_token_id, at)`, `(model, at)`, `(reservation_id)`.
- `llm_budget_counters` — `pool_token_id TEXT NOT NULL`, `period_key TEXT NOT NULL`, `used_tokens BIGINT NOT NULL DEFAULT 0`, `used_micros BIGINT NOT NULL DEFAULT 0`, `reserved_tokens BIGINT NOT NULL DEFAULT 0`, `reserved_micros BIGINT NOT NULL DEFAULT 0`, `active_reservations INTEGER NOT NULL DEFAULT 0`, `updated_at TEXT NOT NULL`, `PRIMARY KEY(pool_token_id, period_key)`.
- `llm_reservations` — reservation fields above plus `estimated_prompt_tokens`, `estimated_output_tokens`.

Add `MIGRATIONS` entries:
`ALTER TABLE project_llms ADD COLUMN IF NOT EXISTS pool_token_id TEXT`, `pool_mode TEXT NOT NULL DEFAULT 'pinned'`, `pool_model TEXT`.
Update `mapLlm` and `upsertLlm` to read/write these columns. `mapLlm` defaults `poolMode` to `"pinned"` when null. In `upsertLlm`, `poolTokenId`/`poolMode`/`poolModel` use `undefined` = keep existing, `null` = clear; this prevents an unrelated config save from erasing a binding. Implement `setLlmPoolBinding` as a targeted `UPDATE` that only touches the three pool columns and returns `true` when a row matched.

- [ ] **Step 3: Implement PostgreSQL pool/token/price/usage CRUD**

Implement:
- `listLlmPoolTokens` (order `priority ASC, name ASC`)
- `getLlmPoolToken`
- `upsertLlmPoolToken` (insert or update by id/name; `model_allowlist` JSON; update `updated_at`)
- `listLlmPrices` (filter by provider/model/effective interval; order `effective_from DESC`)
- `upsertLlmPrice` (reject overlap for the same provider/model/currency with `Error("llm-price-overlap")`)
- `recordLlmUsage` (insert, return mapped; after insert prune rows older than `AOS_LLM_USAGE_RETENTION_DAYS`, default 365, `0` disables)
- `listLlmUsageEvents` (filters `projectRoot`, `poolTokenId`, `provider`, `model`, `since`, `until`; order `at DESC`; default limit 5000, max 50000)

Add mapping helpers `mapLlmPoolToken`, `mapLlmPrice`, `mapLlmUsage`, `mapLlmReservation`.

- [ ] **Step 4: Implement PostgreSQL atomic reservation/settlement**

`reserveLlmBudget` in one `withTransaction`:
1. Load the token; return `token-not-found` / `token-inactive` if missing or not `active`.
2. Compute `periodKey` from `budgetPeriod` and `at`.
3. Ensure a counter row exists (`INSERT ... ON CONFLICT DO NOTHING`).
4. One conditional `UPDATE`:

```sql
UPDATE llm_budget_counters
SET reserved_tokens = reserved_tokens + $3,
    reserved_micros = reserved_micros + $4,
    active_reservations = active_reservations + 1,
    updated_at = $5
WHERE pool_token_id = $1 AND period_key = $2
  AND ($6::bigint IS NULL OR used_micros + reserved_micros + $4 <= $6)
  AND ($7::bigint IS NULL OR used_tokens + reserved_tokens + $3 <= $7)
  AND active_reservations < $8
RETURNING *
```

5. If no row returned, return `budget-exhausted` or `concurrency-limit` with the current snapshot.
6. Insert `llm_reservations` with `expiresAt = at + AOS_LLM_RESERVATION_TTL_MS` (default 600000).
7. Return the reservation.

`settleLlmReservation` in one transaction:
- `SELECT ... FOR UPDATE` the reservation; if not `active`, return `null`.
- Update the counter: `reserved_tokens = GREATEST(0, reserved_tokens - $est)`, `reserved_micros = GREATEST(0, reserved_micros - $estMicros)`, `used_tokens = used_tokens + $actualTokens`, `used_micros = used_micros + $actualMicros`, `active_reservations = GREATEST(0, active_reservations - 1)`.
- Mark reservation `settled`, insert `llm_usage_events`, return the usage record.

`releaseLlmReservation` does the same counter subtraction without `used_*`, marks `released`, returns `true`; idempotent `false` if already settled/released.

`reconcileLlmReservations` selects up to `limit` (default 100) active rows with `expires_at <= at`, and settles each with `estimatedPromptTokens`/`estimatedOutputTokens` and `usageSource="estimated"`, `status="settled_estimated"`, `errorClass="reservation-ttl"`.

`getLlmBudgetSnapshot` reads the counter + token limits and computes `remainingTokens`/`remainingMicros` clamped at 0.

- [ ] **Step 5: Implement MemoryStore and FileStore**

MemoryStore: add arrays/maps for tokens, prices, usage, counters, reservations; implement the same methods; `scopeHost` views share the new state. FileStore: use a private `poolLock` promise chain (copy the `claimLock` pattern in `src/db/file.ts`) around read-modify-write; store tokens/prices/counters/reservations in `AOS_LLM_POOL_FILE` (default `${homeDir}/llm-pool.json`, mode 0600 via `writeFileAtomic`); append usage to `AOS_LLM_USAGE_FILE` (default `${homeDir}/llm-usage.jsonl`), and rewrite the JSONL without expired rows when retention is enabled. Add `scopeHost` copies of the new state/lock.

- [ ] **Step 6: Write the store tests**

`test/llm-pool-store.test.js` must cover, for PG (`pg-mem`), Memory, and File:

```js
test("pool token, price, and usage roundtrip", async () => { /* add token, add price, record usage, list */ });
test("project llm pool binding fields roundtrip", async () => { /* poolTokenId/poolMode/poolModel */ });
test("atomic reservation never overshoots", async () => {
  // limit 100 micros, 50 concurrent reservations of 10
  // assert allowed === 10, snapshot.usedMicros + snapshot.reservedMicros === 100
});
test("settle converts reserved to used and is idempotent", async () => { /* settle twice -> one usage */ });
test("release frees reserved without usage", async () => {});
test("ttl reconcile settles at estimate", async () => { /* expires_at in past */ });
test("concurrency limit blocks the 9th active reservation", async () => {});
test("daily/monthly period counters roll over", async () => {});
test("usage retention prunes rows older than AOS_LLM_USAGE_RETENTION_DAYS", async () => { /* 0 disables */ });
```

For the 50-concurrency test, use `Promise.all` and assert `allowed === 10`; this must pass with pg-mem. If pg-mem serializes, the assertion still holds.

- [ ] **Step 7: Build and run the focused test**

Run: `npm run build && node --test test/llm-pool-store.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/types.ts src/db/postgres.ts src/db/memory.ts src/db/file.ts test/llm-pool-store.test.js
git commit -m "feat: add LLM pool storage and atomic budget reservations"
```

---

## Task 2: Usage Normalization, Pricing, and FX

**Files:**
- Create: `src/llm/pool/usage.ts`
- Create: `src/llm/pool/pricing.ts`
- Test: `test/llm-pool-pricing.test.js`

**Interfaces:**
- Consumes: `LlmPriceRecord`, `LlmUsageRecord` from Task 1.
- Produces: `NormalizedUsage`, `normalizeUsage`, `estimatedUsage`, `computeCost`, `findPrice`, `penaltyRate`, `baseCurrencyFrom`; later tasks use these.

```ts
import type { NormalizedUsage } from "../../db/types.js";
export type { NormalizedUsage };

export function normalizeUsage(raw: unknown): NormalizedUsage | null;
export function estimatedUsage(promptTokens: number, outputTokens: number): NormalizedUsage;

export function baseCurrencyFrom(env: NodeJS.ProcessEnv): string;
export function findPrice(
  prices: readonly LlmPriceRecord[],
  provider: string,
  model: string,
  at: string
): LlmPriceRecord | null;
export function penaltyRate(
  prices: readonly LlmPriceRecord[],
  baseCurrency: string,
  env: NodeJS.ProcessEnv
): LlmPriceRecord;
export function computeCost(
  usage: NormalizedUsage,
  price: LlmPriceRecord,
  baseCurrency: string
): {
  costMicros: number;
  costMicrosBase: number | null;
  currency: string;
  baseCurrency: string;
  fxRateToBase: number;
  priceBookId: string;
  priceVersion: number;
};
export function estimateCostMicros(usage: NormalizedUsage, price: LlmPriceRecord): number;
```

- [ ] **Step 1: Write the failing normalization tests**

```js
test("OpenAI prompt_tokens includes cached tokens", () => {
  const u = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 600 } });
  assert.deepEqual(u, { baseInputTokens: 400, cacheCreationTokens: 0,
    cacheReadTokens: 600, outputTokens: 100, totalTokens: 1100 });
});
test("DeepSeek hit/miss are separate fields", () => {
  const u = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100,
    prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 });
  assert.equal(u.baseInputTokens, 400);
  assert.equal(u.cacheReadTokens, 600);
});
test("Anthropic input_tokens excludes cache", () => {
  const u = normalizeUsage({ input_tokens: 1000, cache_creation_input_tokens: 200,
    cache_read_input_tokens: 3000, output_tokens: 500 });
  assert.deepEqual(u, { baseInputTokens: 1000, cacheCreationTokens: 200,
    cacheReadTokens: 3000, outputTokens: 500, totalTokens: 4700 });
});
test("missing usage returns null", () => assert.equal(normalizeUsage({}), null));
```

- [ ] **Step 2: Implement `normalizeUsage`**

Rules:
- Anthropic shape (`input_tokens` present): use `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` directly.
- DeepSeek shape (`prompt_cache_hit_tokens`/`miss` present): base = miss; cacheRead = hit.
- OpenAI shape: base = `max(0, prompt_tokens - cached_tokens)`; cacheRead = `prompt_tokens_details.cached_tokens ?? 0`.
- Generic: `prompt_tokens`/`completion_tokens`, with `cache_read_input_tokens` as read and `cache_creation_input_tokens` as creation; base = `max(0, prompt - cacheRead - cacheCreation)` only for the generic fallback.
- Return `null` if neither `prompt_tokens` nor `input_tokens` is a finite number.
- Clamp all values to `>= 0` integers; `total = base + creation + read + output`.

- [ ] **Step 3: Write the failing pricing tests**

Use the spike fixture:

```js
test("Anthropic cache cost matches manual billing", () => {
  const usage = { baseInputTokens: 1000, cacheCreationTokens: 200,
    cacheReadTokens: 3000, outputTokens: 500, totalTokens: 4700 };
  const price = priceRecord({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  const cost = computeCost(usage, price, "USD");
  assert.equal(cost.costMicros, 12150); // 0.01215 USD
});
test("USD price converts to CNY base", () => {
  // price fxRateToBase=7.2, costMicros=12150 -> costMicrosBase=87480
});
test("unpriced model uses penalty rate", () => {
  const rate = penaltyRate([], "CNY", { AOS_LLM_UNPRICED_MICROS_PER_MTOK: "20000000" });
  assert.equal(rate.inputMicrosPerMtok, 20000000);
  assert.equal(rate.model, "*");
});
test("missing FX is not silently 1:1", () => {
  assert.equal(computeCost(usage, priceRecord({ currency: "USD", fxRateToBase: 0 }), "CNY").costMicrosBase, null);
});
```

`priceRecord` is a local test helper that fills the `LlmPriceRecord` shape; micros are `currency * 1_000_000` per Mtok.

- [ ] **Step 4: Implement pricing**

- `baseCurrencyFrom`: `AOS_LLM_COST_CURRENCY` uppercased, `/^[A-Z]{3}$/`, default `CNY`.
- `findPrice`: effective interval `effectiveFrom <= at < effectiveTo ?? +∞`; match order exact/exact, exact/`*`, `*`/exact, `*`/`*`; newest `effectiveFrom` wins.
- `penaltyRate`: highest `inputMicrosPerMtok` among prices in `baseCurrency`; if none, `AOS_LLM_UNPRICED_MICROS_PER_MTOK` or `20000000`; `model="*"`, `provider="*"`, `currency=baseCurrency`, `fxRateToBase=1`, `effectiveFrom="1970-01-01T00:00:00.000Z"`.
- `computeCost`: integer micros, `Math.round(tokens * microsPerMtok / 1_000_000)`; `cacheRead`/`cacheWrite` missing → 0; `costMicrosBase = round(costMicros * fxRateToBase)`; if `currency !== baseCurrency` and `fxRateToBase <= 0`, return `costMicrosBase: null` but still return `costMicros`.
- `estimateCostMicros` uses only the input/output/cache rates and excludes no fields.

- [ ] **Step 5: Add the unpriced-budget integration test**

```js
test("unpriced model with only a money budget is blocked", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p", name: "p" });
  const token = await store.upsertLlmPoolToken({ name: "t", provider: "custom", baseUrl: "https://x",
    modelAllowlist: ["m"], budgetPeriod: "monthly", budgetLimitMicros: 100 });
  const rate = penaltyRate([], "CNY", { AOS_LLM_UNPRICED_MICROS_PER_MTOK: "20000000" });
  const usage = estimatedUsage(100, 100);
  const estimatedMicros = estimateCostMicros(usage, rate);
  const result = await store.reserveLlmBudget({ poolTokenId: token.id, projectRoot: "/w/p",
    provider: "custom", model: "m", source: "center_proxy",
    estimatedPromptTokens: 100, estimatedOutputTokens: 100, estimatedMicros });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "budget-exhausted");
});
```

This proves `cost=null` cannot bypass a money-only budget.

- [ ] **Step 6: Build and run**

Run: `npm run build && node --test test/llm-pool-pricing.test.js`
Expected: PASS, including `12150`, the missing-FX null, and the blocked unpriced reservation.

- [ ] **Step 7: Commit**

```bash
git add src/llm/pool/usage.ts src/llm/pool/pricing.ts test/llm-pool-pricing.test.js
git commit -m "feat: normalize provider usage and price LLM requests"
```

---

## Task 3: Request Estimation, Stream Tap, and Provider Adapter

**Files:**
- Create: `src/llm/pool/estimate.ts`
- Create: `src/llm/pool/stream.ts`
- Create: `src/llm/pool/provider-adapter.ts`
- Modify: `src/runner/control/llm-proxy.ts` (move `rewriteDeepSeekStructuredOutput` import; keep the export for existing tests)
- Modify: `package.json` / lockfile
- Test: `test/llm-pool-estimate.test.js`

**Interfaces:**
- Consumes: `NormalizedUsage`, `normalizeUsage`.
- Produces: `estimateRequest`, `estimateTextTokens`, `createStreamTap`, `rewriteProviderRequest`.

```ts
export interface RequestEstimate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export function estimateTextTokens(text: string): number;
export function estimateRequest(body: unknown, env?: NodeJS.ProcessEnv): RequestEstimate;

export interface StreamTap {
  push(chunk: Buffer): void;
  end(): void;
  usage(): NormalizedUsage | null;
  outputChars(): number;
  estimatedOutputTokens(): number;
}
export function createStreamTap(): StreamTap;

export function rewriteProviderRequest(
  payload: unknown,
  target: { provider: string; model: string; baseUrl: string | null }
): { body: unknown; rewritten: boolean };
```

- [ ] **Step 1: Add `js-tiktoken`**

Run: `npm install js-tiktoken@1.0.21`
Expected: `package.json` dependencies updated, lockfile updated.

- [ ] **Step 2: Write failing estimation tests**

```js
test("estimateRequest counts text and reserves the completion ceiling", () => {
  const e = estimateRequest({ messages: [{ role: "user", content: "hello world" }], max_tokens: 100 });
  assert.ok(e.promptTokens >= 2 && e.promptTokens <= 10);
  assert.equal(e.completionTokens, 100);
  assert.equal(e.totalTokens, e.promptTokens + 100);
});
test("image parts reserve a fixed allowance", () => {
  const e = estimateRequest({ messages: [{ role: "user", content: [
    { type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:..." } }
  ] }] });
  assert.ok(e.promptTokens >= 1600);
});
test("CJK text is not underestimated", () => {
  assert.ok(estimateTextTokens("登录页输入用户名和密码") >= 8);
});
```

- [ ] **Step 3: Implement the estimator**

- Lazy `js-tiktoken` encoder: `getEncoding("cl100k_base")`.
- Count text parts; for each text, `Math.max(encoded.length, cjkCharCount)` then `Math.ceil(x * 1.15)`.
- Image parts add `AOS_LLM_IMAGE_TOKEN_ESTIMATE` (default 1600).
- Each message adds 4; the request adds 2.
- Completion: `max_tokens`/`max_completion_tokens` when positive; else `AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS` (default 4096).
- Invalid/missing body returns `{ promptTokens: 0, completionTokens: default, totalTokens: default }`.

- [ ] **Step 4: Write failing stream tap tests**

```js
test("SSE tap keeps the final usage chunk", () => {
  const tap = createStreamTap();
  tap.push(Buffer.from('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
  tap.push(Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'));
  tap.push(Buffer.from("data: [DONE]\n\n"));
  tap.end();
  assert.deepEqual(tap.usage(), { baseInputTokens: 10, cacheCreationTokens: 0,
    cacheReadTokens: 0, outputTokens: 2, totalTokens: 12 });
  assert.equal(tap.outputChars(), 1);
});
test("tap handles split chunks and no usage", () => {
  const tap = createStreamTap();
  tap.push(Buffer.from('data: {"choices":[{"delta":{"con'));
  tap.push(Buffer.from('tent":"abc"}}]}\n\n'));
  tap.end();
  assert.equal(tap.usage(), null);
  assert.equal(tap.outputChars(), 3);
});
```

- [ ] **Step 5: Implement the stream tap**

- Keep a `TextDecoder` and a bounded buffer (last 1 MiB).
- On each `data:` line, parse JSON; if `usage`, `normalizeUsage` it; if `choices[0].delta.content` is a string, add its length.
- `estimatedOutputTokens = Math.ceil(outputChars / 3)` (conservative).
- `end()` flushes any remaining line.

- [ ] **Step 6: Move the DeepSeek rewrite**

Move `rewriteDeepSeekStructuredOutput` from `src/runner/control/llm-proxy.ts` to `src/llm/pool/provider-adapter.ts` as `rewriteProviderRequest`; keep a re-export named `rewriteDeepSeekStructuredOutput` in `llm-proxy.ts` so existing tests keep working. Add a test that a non-DeepSeek target is untouched.

- [ ] **Step 7: Build and run**

Run: `npm run build && node --test test/llm-pool-estimate.test.js test/figma.test.js`
Expected: PASS; the existing DeepSeek rewrite tests still pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/llm/pool/estimate.ts src/llm/pool/stream.ts src/llm/pool/provider-adapter.ts src/runner/control/llm-proxy.ts test/llm-pool-estimate.test.js
git commit -m "feat: estimate prompt tokens and tap stream usage"
```

---

## Task 4: Pool Resolution, Binding, and `llm_list`

**Files:**
- Create: `src/llm/pool/resolve.ts`
- Modify: `src/llm/registry.ts`
- Modify: `src/runtime.ts` (`entries`, `activeEntry`, `activateEntry` mappings)
- Modify: `src/runner/control/llm-resolver.ts`
- Modify: `src/runner/control/suite-service.ts` (`getLlm`)
- Modify: `src/tools/llm.ts` (`llmList`)
- Test: `test/llm-pool-resolve.test.js`

**Interfaces:**
- Consumes: `ProjectStore.listLlms`, `listLlmPoolTokens`, `getLlmPoolToken`, `entryFromStore`, `scanProjectEnv`.
- Produces: `resolveCenterLlmCandidates`, `resolveCenterLlm` with pool fields; `LlmEntry` pool fields.

```ts
export interface PoolCandidate {
  entryName: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  poolTokenId: string | null;
  poolTokenName: string | null;
  poolMode: LlmPoolMode;
  supportsStreamUsage: boolean;
  maxConcurrency: number;
}
export interface CenterLlmResolution {
  entryName: string;
  provider: string;
  model: string;
  mode: "project" | "pinned" | "auto";
  candidates: PoolCandidate[];
  error: "no-token" | "token-disabled" | "model-not-allowed" | null;
}
export async function resolveCenterLlmCandidates(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  rootPath: string
): Promise<CenterLlmResolution | null>;
export function resolvePoolTokenKey(
  token: LlmPoolTokenRecord,
  env: NodeJS.ProcessEnv
): string | null;

// src/runner/control/llm-resolver.ts (existing type, extended)
export interface ResolvedCenterLlm {
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  poolTokenId: string | null;
  poolMode: LlmPoolMode;
  poolTokenName: string | null;
  supportsStreamUsage: boolean;
}
```

- [ ] **Step 1: Write failing resolution tests**

Use a `MemoryStore` with a project and `upsertLlm`:

```js
test("pinned binding resolves exactly one token", async () => { /* token A -> candidates.length===1 */ });
test("auto binding orders same-model tokens by priority", async () => { /* A priority 10, B priority 20 */ });
test("auto skips disabled and model-not-allowed tokens", async () => {});
test("pinned token missing returns token-disabled", async () => {});
test("project-owned entry keeps its own key and no poolTokenId", async () => {});
test("pending_token is not selectable", async () => {});
```

- [ ] **Step 2: Extend `LlmEntry` and `entryFromStore`**

Add `poolTokenId`, `poolMode`, `poolModel` to `LlmEntry`; map from `ProjectLlmRecord`. `entriesFromConfig`/`entryFromEnvScan` set `null`/`"pinned"`/`null`.

- [ ] **Step 3: Implement candidate resolution**

- Get store entries; pick active with the existing preference order (`isActive && apiKey`, `isActive`, `apiKey`, first).
- If the entry has `poolTokenId`:
  - model = `poolModel ?? entry.model`.
  - load the bound token; if missing or `status !== "active"` → `error` and empty candidates.
  - resolve key: `apiKey` or `keyEnv` lookup in `env`; missing key → `token-disabled`.
  - allowlist empty or includes model; otherwise `model-not-allowed`.
  - `pinned`: one candidate. `auto`: all active tokens with the model allowed, sorted `priority ASC, lastValidatedAt DESC`; include the bound token only if eligible.
  - `baseUrl` from token; `provider` from token.
- If no pool binding: use the existing store entry + `.env` fallback; one candidate with `poolTokenId=null`.
- If no store entries: keep the existing `.env` fallback with `mode="project"`.
- Return `null` only when there is no entry and no env LLM.

- [ ] **Step 4: Update the old resolver and `getLlm`**

`resolveCenterLlm` returns the first candidate or `null`, plus `poolTokenId`, `poolMode`, `poolTokenName`, `supportsStreamUsage`. `suite-service.getLlm` uses `active.model` (already resolved from `poolModel`); the proxy URL is unchanged.

- [ ] **Step 5: Update `llm_list`**

Add:

```ts
pool: entry.poolTokenId
  ? { tokenId: entry.poolTokenId, mode: entry.poolMode, model: entry.poolModel }
  : null
```

If the entry is pool-backed, `key.present` is true and `key.preview` is the **masked pool token key**; `key.envVar` is the pool `keyEnv`. Never return the raw key. Add `poolStatus` from the token if loaded.

- [ ] **Step 6: Build and run**

Run: `npm run build && node --test test/llm-pool-resolve.test.js test/figma.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/llm/pool/resolve.ts src/llm/registry.ts src/runtime.ts src/runner/control/llm-resolver.ts src/runner/control/suite-service.ts src/tools/llm.ts test/llm-pool-resolve.test.js
git commit -m "feat: resolve project LLM bindings to pool tokens"
```

---

## Task 5: Pool Management CLI and Read-Only Tools

**Files:**
- Create: `src/llm/command.ts`
- Modify: `src/cli.ts`
- Modify: `src/tools/native-tools/llm.ts`
- Modify: `src/tools/llm.ts`
- Test: `test/llm-pool-command.test.js`

**Interfaces:**
- Consumes: `ProjectStore` pool methods, `maskSecret`, `createProjectStore`, `resolveProject`.
- Produces: `runLlmCommand(rest, deps?)`, `llm_pool_list`, `llm_usage` handlers.

```ts
export function printLlmUsage(log: (line: string) => void): void;
export async function runLlmCommand(
  rest: string[],
  deps?: {
    store?: ProjectStore;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    log?: (line: string) => void;
    errorLog?: (line: string) => void;
    fetch?: typeof fetch;
  }
): Promise<number>;

export async function llmPoolList(runtime: Runtime): Promise<CallToolResult>;
export async function llmUsage(runtime: Runtime, args: LlmUsageArgs): Promise<CallToolResult>;
export interface LlmUsageArgs {
  since?: string;
  until?: string;
  bucket?: "hour" | "day" | "month";
  groupBy?: "project" | "model" | "token" | "none";
}
```

- [ ] **Step 1: Write failing CLI tests**

Use `MemoryStore` and a temp project:

```js
test("llm pool add/list masks the key and persists", async () => {
  const code = await runLlmCommand(["pool", "add", "--name", "p1", "--provider", "custom",
    "--base-url", "https://api.example.com", "--model", "m1", "--api-key", "sk-secret-123456"],
    { store, env: {} });
  assert.equal(code, 0);
  const out = logs.join("\n");
  assert.ok(out.includes("****"));
  assert.ok(!out.includes("sk-secret-123456"));
});
test("llm pool add without a token is pending_token", async () => {});
test("llm pool bind links a project_llm entry", async () => {});
test("llm pool disable stops selection", async () => {});
test("llm price set rejects overlapping effective ranges", async () => {});
```

- [ ] **Step 2: Implement the CLI parser**

Support:
- `pool list [--json]`
- `pool add --name <n> --provider <p> --base-url <u> --model <m[,m2]> [--api-key <k>|--key-env <VAR>] [--priority N] [--budget-period daily|monthly|total|none] [--budget-micros N] [--budget-tokens N] [--currency CNY] [--max-concurrency N] [--supports-stream-usage] [--dry-run] [--probe-stream]`
- `pool update --id <id> [same fields] [--disable|--enable]`
- `pool disable --id <id>`
- `pool bind --project <dir> --entry <name> --token <id|name> --model <model> --mode pinned|auto`
- `price list [--json]`
- `price set --provider <p> --model <m> --currency <c> --input-mtok <n> --output-mtok <n> [--cache-read-mtok <n>] [--cache-write-mtok <n>] [--fx <n>] [--effective-from <iso>] [--note <text>]`
  — `*-mtok` values are currency units per million tokens; convert to integer micros with `Math.round(n * 1_000_000)`. For `currency !== AOS_LLM_COST_CURRENCY`, `--fx` is required and must be > 0.

Rules:
- `pool add` without a key/env → `status="pending_token"`; with a key → `active`.
- `--dry-run` validates with `GET {baseUrl}/models` (10s timeout, `Authorization: Bearer`); 2xx sets `lastValidatedAt` and keeps `active`; 401/403 or network error sets `invalid` + sanitized `lastError`; 404/405 means "endpoint unsupported" and keeps the current status with `lastError="models-endpoint-unsupported"` (do not mark invalid). `--probe-stream` sends a 1-token stream request with `stream_options`; 200 with a usage chunk → `supportsStreamUsage=true`; 400/parameter error → `false`.
- `pool bind` resolves the project's `project_llms` entry by name and calls `store.setLlmPoolBinding({ rootPath, name, poolTokenId, poolMode, poolModel })`; the existing own key is untouched (so switching back works). If the entry does not exist, exit 1.
- Output JSON for `--json`; text otherwise. Mask keys with `maskSecret`.
- Exit codes: `0` success; `1` operation rejected (missing entry/token, overlap, validation failed); `2` usage error.

- [ ] **Step 3: Wire `src/cli.ts`**

Add `case "llm": { const code = await runLlmCommand(rest); process.exit(code); }` and the `llm` help line. `printUsage` must mention `llm pool|price|usage`.

- [ ] **Step 4: Add read-only MCP tools**

`llm_pool_list`: current project's bound tokens only (no global list). For each: name, provider, models, status, priority, budget period/limits, masked key, snapshot. Return `{ ok: true, tokens }`. Do not expose raw keys or other projects.

`llm_usage`: calls `store.listLlmUsageEvents({ projectRoot: runtime.project.rootDir, ...args })` + `aggregateLlmUsage` (Task 8); for Task 5, return raw totals only if Task 8 is not yet available. To keep task ordering, implement `llm_usage` in Task 8; in Task 5 only add `llm_pool_list`.

- [ ] **Step 5: Write tool tests**

Use the MCP in-memory client pattern from `test/usage-e2e.test.js`; call `llm_pool_list`, assert masked key and no raw key in `JSON.stringify(result)`.

- [ ] **Step 6: Build and run**

Run: `npm run build && node --test test/llm-pool-command.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/llm/command.ts src/cli.ts src/tools/native-tools/llm.ts src/tools/llm.ts test/llm-pool-command.test.js
git commit -m "feat: add LLM pool management CLI and read-only pool tool"
```

---

## Task 6: Center Proxy Metering, Budget, and Streaming

**Files:**
- Create: `src/llm/pool/budget-service.ts`
- Modify: `src/runner/control/llm-proxy.ts`
- Modify: `src/runner/control/llm-resolver.ts` (candidate export)
- Test: `test/llm-proxy-pool.test.js`

**Interfaces:**
- Consumes: Tasks 1-4 (`reserveLlmBudget`, `settleLlmReservation`, `releaseLlmReservation`, `normalizeUsage`, `findPrice`, `estimateRequest`, `createStreamTap`, `resolveCenterLlmCandidates`).
- Produces: `reserveForRequest`, `settleReservation`.

```ts
export interface ReserveForRequestInput {
  store: ProjectStore;
  token: LlmPoolTokenRecord;
  projectRoot: string;
  provider: string;
  model: string;
  source: LlmUsageOrigin;
  requestBody: unknown;
  env: NodeJS.ProcessEnv;
  prices: readonly LlmPriceRecord[];
  baseCurrency: string;
  at?: string;
  context?: {
    hostId?: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    traceId?: string | null;
    requestId?: string | null;
  };
}
export type ReserveForRequestResult =
  | {
      ok: true;
      reservation: LlmReservationRecord;
      estimate: RequestEstimate;
      price: LlmPriceRecord;
      estimatedCostMicros: number;
    }
  | {
      ok: false;
      reason: "token-not-found" | "token-inactive" | "budget-exhausted" | "concurrency-limit";
      snapshot: LlmBudgetSnapshot | null;
    };

export async function reserveForRequest(input: ReserveForRequestInput): Promise<ReserveForRequestResult>;

export async function settleReservation(input: {
  store: ProjectStore;
  reservation: LlmReservationRecord;
  usage: NormalizedUsage | null;
  usageSource: LlmUsageSource;
  price: LlmPriceRecord;
  baseCurrency: string;
  status: LlmUsageStatus;
  errorClass?: string | null;
  at?: string;
}): Promise<LlmUsageRecord | null>;
```

- [ ] **Step 1: Write failing proxy tests**

Use a real `http.createServer` mock upstream and call `handleLlmProxyRequest` with a fake `IncomingMessage`/`ServerResponse` (see how `test/llm-proxy` helpers build requests; if none exist, add a small helper).

```js
test("JSON response settles provider usage", async () => {
  // token budget 1 CNY, price 10 CNY/Mtok, upstream usage 1000/100
  // assert one llm_usage_event with totalTokens 1100 and costMicrosBase > 0
  // assert snapshot.usedMicros > 0 and reserved=0
});
test("stream endpoint without capability does not receive stream_options", async () => {
  // upstream asserts body.stream_options === undefined; returns SSE
  // assert response 200 and usage settled as estimated/partial
});
test("stream endpoint with capability receives include_usage and usage is parsed", async () => {
  // upstream asserts body.stream_options.include_usage === true
  // sends a final usage chunk; assert exact tokens
});
test("upstream 400 releases the reservation without usage", async () => {});
test("client disconnect settles partial/estimated and no reserved remains", async () => {});
test("budget exhausted returns 402 llm-budget-exhausted", async () => {});
test("request model mismatch returns 400 llm-model-mismatch", async () => {});
test("auto mode falls back to the next token before forwarding", async () => {});
```

- [ ] **Step 2: Implement `reserveForRequest`**

1. `estimate = estimateRequest(requestBody, env)`.
2. `price = findPrice(prices, provider, model, at) ?? penaltyRate(prices, baseCurrency, env)`.
3. `estimatedCostMicros = estimateCostMicros(usageFromEstimate, price)`.
4. Call `store.reserveLlmBudget({ poolTokenId, projectRoot, provider, model, source,
   estimatedPromptTokens, estimatedOutputTokens, estimatedMicros: estimatedCostMicros,
   at, context... })`.
5. Return the reservation/estimate/price; on failure return the reason/snapshot.

- [ ] **Step 3: Implement `settleReservation`**

- If `usage === null`, use `estimatedUsage(reservation.estimatedPromptTokens, reservation.estimatedOutputTokens)`.
- `cost = computeCost(usage, price, baseCurrency)`.
- Call `store.settleLlmReservation({ reservationId, usage, usageSource, ...cost, status, errorClass })`.
- Return the usage event.

- [ ] **Step 4: Rewrite `handleLlmProxyRequest`**

Order:
0. Opportunistic TTL reconciliation: keep a module-level `lastReconcileAt`; if >60s, `void store.reconcileLlmReservations({ limit: 20 })` best-effort (never block the request).
1. Auth + project decode + `assertLlmProject` (unchanged).
2. `resolveCenterLlmCandidates(store, env, rootPath)`; if `null` → 503 `llm-not-configured`; if `error` or `candidates.length === 0` → 503 `llm-pool-token-unavailable` with `error`.
3. Read body (unchanged). Parse JSON only if content-type JSON; keep `parsedBody`.
4. If `parsedBody.model` is a string and differs from `resolution.model` → 400 `llm-model-mismatch` (only for pool bindings; project-owned keeps current behavior).
5. For each candidate:
   - If `candidate.poolTokenId !== null`: `reserveForRequest`; on `budget-exhausted`/`concurrency-limit` try next; on success break. If none → 402 `llm-budget-exhausted` with the last snapshot.
   - If `candidate.poolTokenId === null`: no reservation.
6. Apply `rewriteProviderRequest(parsedBody, candidate)`; for stream and `candidate.supportsStreamUsage`, set `stream_options = { ...(existing), include_usage: true }`. Never inject when `false` or `unknown`.
7. Forward with `fetch` (unchanged headers; use candidate key/baseUrl).
8. On upstream error:
   - HTTP 4xx/5xx response: release the reservation (provider responded; no usage assumed) and record `lastError` on the token via `upsertLlmPoolToken` (best-effort; never log key).
   - Fetch timeout or connection reset after the request was sent: **settle at the estimate** (`usageSource="estimated"`, `status="settled_estimated"`, `errorClass="timeout"|"network"`); do not release, because the provider may have processed it.
   - Return the existing status/body.
9. On success:
   - Non-stream JSON: `const text = await upstream.text()`, parse `usage`, settle with `normalizeUsage(usage)`; if no usage, settle with estimate and `usageSource="estimated"`, `status="settled_estimated"`. Send `text`.
   - Stream: pipe `Readable.fromWeb(upstream.body)` through a `StreamTap` while writing to `res`. On `end`: settle with `tap.usage()` or `estimatedUsage(prompt, tap.estimatedOutputTokens())`; on `res.close` before end: settle with `partial` using `tap.estimatedOutputTokens()`; `settleOnce` guard.
   - Project-owned candidate: record usage via `store.recordLlmUsage` with `poolTokenId=null`, price lookup, `source="center_proxy"`; no budget.
10. Do not change the response shape; keep `x-request-id` forwarding.

- [ ] **Step 5: Token health updates**

On 401/403: `status="invalid"`, `lastError` sanitized. On 429/5xx: keep `active`, set `lastError`; v1 no automatic cooldown (selection can still pick it). Never delete tokens.

- [ ] **Step 6: Build and run**

Run: `npm run build && node --test test/llm-proxy-pool.test.js`
Expected: PASS, including no `stream_options` for capability false.

- [ ] **Step 7: Commit**

```bash
git add src/llm/pool/budget-service.ts src/runner/control/llm-proxy.ts src/runner/control/llm-resolver.ts test/llm-proxy-pool.test.js
git commit -m "feat: meter and budget center LLM proxy requests"
```

---

## Task 7: Node `chat.ts` Metering and Budget Hook

**Files:**
- Create: `src/llm/pool/chat-budget.ts`
- Create: `src/llm/pool/chat-factory.ts`
- Modify: `src/llm/chat.ts`
- Modify: `src/runtime.ts`
- Modify: `src/ios/run-loop.ts`
- Modify: `src/figma/test-gen.ts`
- Modify: `src/pen/flows.ts`
- Modify: `src/workflow/design-to-test.ts`
- Modify: `src/workflow/setup.ts`
- Modify: `src/workflow/verify-jira.ts`
- Test: `test/llm-chat-budget.test.js`

**Interfaces:**
- Consumes: `makeChatFn`, `normalizeUsage`, `estimateMessagesTokens`, Task 1 budget methods, Task 4 resolution.
- Produces: `ChatBudget`, `createChatBudget`, `Runtime.makeChatFor`, `Runtime.recordLocalLlmUsage`.

```ts
export interface ChatBudgetReservation {
  settle(usage: NormalizedUsage | null, status?: LlmUsageStatus): Promise<void>;
  release(): Promise<void>;
}
export interface ChatBudget {
  reserve(messages: ChatMessage[], maxOutputTokens?: number): Promise<ChatBudgetReservation>;
}
export class LlmBudgetError extends Error {
  code: "llm-budget-exhausted" | "llm-token-unavailable";
  status: 402 | 503;
}
export function createChatBudget(input: {
  store: ProjectStore;
  token: LlmPoolTokenRecord;
  projectRoot: string;
  provider: string;
  model: string;
  prices: readonly LlmPriceRecord[];
  baseCurrency: string;
  env: NodeJS.ProcessEnv;
  context?: { traceId?: string | null; taskId?: string | null };
}): ChatBudget;

// src/llm/pool/chat-factory.ts
export async function makeChatForRuntime(input: {
  store: ProjectStore;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  entry: LlmEntry;
  options?: ChatOptions;
}): Promise<ChatFn>;
```

- [ ] **Step 1: Write failing chat tests**

```js
test("chat with a pool token reserves before fetch and settles usage", async () => {
  // fake fetch returns usage 100/20; assert reservation settled and usage event exists
});
test("chat without usage settles an estimate instead of free", async () => {
  // fake fetch returns 200 with no usage; assert totalTokens > 0 and status settled_estimated
});
test("chat 400 releases the reservation", async () => {});
test("chat without a pool token records local usage with poolTokenId=null", async () => {});
```

- [ ] **Step 2: Extend `ChatUsage` and `ChatOptions`**

Add `normalized?: NormalizedUsage` to `ChatUsage` (keep existing fields for iOS/Web compatibility).
Add:
```ts
onNormalizedUsage?: (usage: NormalizedUsage | null) => void | Promise<void>;
budget?: ChatBudget;
```
`makeChatFn`:
- If `options.budget`, `const reservation = await options.budget.reserve(messages, target.maxOutputTokens)` before `fetch`; `LlmBudgetError` propagates unchanged.
- On HTTP/JSON error: `await reservation?.release()` (best-effort) then throw.
- On fetch timeout/abort after the request was sent: `await reservation?.settle(null, "settled_estimated")` (charges the estimate), then throw.
- On success: `const normalized = normalizeUsage(payload.usage)`; call `onUsage` (existing shape) and `await onNormalizedUsage?.(normalized)`; if reservation, `await reservation.settle(normalized, normalized ? "ok" : "settled_estimated")`.
- If `payload.usage` missing, estimate output from `contentText` via `estimateTextTokens` and settle that; never release a successful request.
- Add `maxOutputTokens?: number` and `provider?: string` to `ChatTarget` (optional; used for reservation/accounting).

- [ ] **Step 3: Implement `createChatBudget`**

- `reserve`: `estimateMessagesTokens(messages)` + `maxOutputTokens ?? AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS`; `reserveForRequest`-like direct store call (avoid importing the proxy service to prevent a cycle; use `estimateCostMicros` + `findPrice`/`penaltyRate`).
- `settle`: use `computeCost`, `store.settleLlmReservation`; if `usage === null`, use `estimatedUsage`.
- `release`: `store.releaseLlmReservation`.

- [ ] **Step 4: Add the chat factory and runtime helpers**

`src/llm/pool/chat-factory.ts`:

```ts
export async function makeChatForRuntime(input: {
  store: ProjectStore;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  entry: LlmEntry;
  options?: ChatOptions;
}): Promise<ChatFn>;
```

- If `entry.poolTokenId`: load token + prices; `resolvePoolTokenKey(token, env)`; create `ChatBudget`; target `{ baseUrl: token.baseUrl, apiKey, model: entry.poolModel ?? entry.model, provider: token.provider, maxOutputTokens }`; return `makeChatFn(target, { ...options, budget })`.
- Else: target from entry; return `makeChatFn(target, { ...options, onNormalizedUsage: (u) => recordLocalUsage(...) })` unless the caller supplied `onNormalizedUsage`. `recordLocalUsage` returns `Promise<void>` and calls `store.recordLlmUsage` with `poolTokenId=null`, `source="local_chat"`, price lookup, best-effort `logWarn`; `makeChatFn` awaits the callback.
- Never log the key.

`Runtime.makeChatFor(entry, options)` delegates to `makeChatForRuntime({ store: this.store, projectRoot: this.project.rootDir, env: { ...this.project.dotenvValues, ...this._baseEnv }, entry, options })`. Add a best-effort `void this.store.reconcileLlmReservations({ limit: 20 })` in `Runtime.initialize` (not awaited) so local chat also recovers expired reservations.

For `DesignRuntimeLike` call sites, use `makeChatForRuntime({ store: runtime.store, projectRoot: runtime.project.rootDir, env: { ...runtime.project.dotenvValues, ...process.env }, entry, options })`.

- [ ] **Step 5: Wire the call sites**

Replace direct `makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model })` with `await makeChatForRuntime(...)` in:
- `src/ios/run-loop.ts` (keep `{ onUsage: collectUsage("execute") }`)
- `src/figma/test-gen.ts` (`resolveNamingChat` has `runtime.store`/`project.rootDir`)
- `src/pen/flows.ts` (same)
- `src/workflow/design-to-test.ts`
- `src/workflow/setup.ts`
- `src/workflow/verify-jira.ts`

If a call site is synchronous, make the enclosing function async. `src/ios/verifier.ts` keeps its existing signature; it receives a chat from the caller or builds one without a budget (documented fallback).

- [ ] **Step 6: Build and run**

Run: `npm run build && node --test test/llm-chat-budget.test.js test/ios-structured-runner.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/llm/pool/chat-budget.ts src/llm/pool/chat-factory.ts src/llm/chat.ts src/runtime.ts src/ios/run-loop.ts src/figma/test-gen.ts src/pen/flows.ts src/workflow/design-to-test.ts src/workflow/setup.ts src/workflow/verify-jira.ts test/llm-chat-budget.test.js
git commit -m "feat: meter and budget Node chat completions"
```

---

## Task 8: Usage Aggregation, `llm usage`, and Panel Read-Only Stats

**Files:**
- Create: `src/llm/pool/aggregate.ts`
- Create: `test/llm-usage-command.test.js`
- Modify: `src/llm/command.ts`
- Modify: `src/tools/native-tools/llm.ts`
- Modify: `src/tools/llm.ts`
- Modify: `src/console/pages.ts`
- Modify: `src/panel/web.ts`
- Test: `test/panel-llm.test.js`

**Interfaces:**
- Consumes: `listLlmUsageEvents`, `LlmUsageQuery`, `baseCurrencyFrom`.
- Produces: `aggregateLlmUsage`, `llm_usage` tool, CLI `llm usage`, panel JSON.

```ts
export interface LlmUsageBucket {
  key: string;
  bucket: string | null;
  requests: number;
  baseInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicrosBase: number;
  unpricedRequests: number;
  fxMissingRequests: number;
}
export interface LlmUsageReport {
  baseCurrency: string;
  since: string | null;
  until: string | null;
  bucket: "hour" | "day" | "month" | null;
  groupBy: "project" | "model" | "token" | "none";
  totals: LlmUsageBucket;
  rows: LlmUsageBucket[];
}
export function aggregateLlmUsage(
  events: readonly LlmUsageRecord[],
  query: LlmUsageQuery
): LlmUsageReport;
```

- [ ] **Step 1: Write failing aggregation tests**

```js
test("aggregates by model and day in UTC", () => { /* two models, two days */ });
test("mixed currency uses cost_micros_base only", () => {
  // CNY 100 + USD 100 with fx 7.2 -> 820 base, not 200
});
test("unpriced and fx-missing counts are explicit", () => {});
test("month bucket uses YYYY-MM", () => {});
```

- [ ] **Step 2: Implement `aggregateLlmUsage`**

- Bucket key from `at` (UTC): `slice(0,13)` hour, `slice(0,10)` day, `slice(0,7)` month.
- Group key: `projectRoot`, `model`, `poolTokenId`, or `"all"`.
- Sum normalized tokens and `costMicrosBase` (null → 0 + `fxMissingRequests`/`unpricedRequests` counts).
- `totals` is the ungrouped sum; `rows` sorted by key.
- Never add `costMicros` across currencies.

- [ ] **Step 3: Add `llm_usage` tool and CLI**

Tool:
```ts
llm_usage({ since?, until?, bucket?, groupBy? }) // current project only
```
Return `{ ok: true, report }`. In stdio, `projectRoot` is forced to `runtime.project.rootDir`; reject `--all`-style scope. No raw keys.

CLI:
`llm usage [--project <dir>|--all] [--model <m>] [--token <id>] [--since ISO] [--until ISO] [--bucket hour|day|month] [--group-by project|model|token|none] [--json]`
- Without `--project`, use cwd.
- `--all` lists all registered projects and aggregates; missing `store.kind="postgres"`? FileStore still supports if events are global.
- Text output: one line per row + totals; JSON `--json`.
- Exit `0` no data; `2` usage error.

- [ ] **Step 4: Add panel read-only routes**

In `src/panel/web.ts`:
- `GET /panel/api/llm/pool?project=<root>` → `{ ok, tokens: [{ id, name, provider, models, status, priority, budget, maskedKey, snapshot }] }`. Only tokens bound to the project's `project_llms` entries. Never raw key.
- `GET /panel/api/llm/usage?project=<root>&days=7&bucket=day&groupBy=model` → `{ ok, report }`.

In `src/console/pages.ts`:
- Extend `OpsPageData` with `llmPool?: { tokens: ... }` and `llmUsage?: LlmUsageReport`.
- Render a read-only card "LLM 资源池与用量" under the project config card: token table (name/provider/model/status/budget bar/masked key) and a 7-day usage table (model, requests, tokens, cost, unpriced). If no pool binding, show "当前使用项目自有 key，不纳入池预算".
- No forms; management remains CLI (`llm pool ...`). Add a muted note.

- [ ] **Step 5: Write tests**

`test/llm-usage-command.test.js`: aggregate fixtures; CLI JSON; current-project scoping.
`test/panel-llm.test.js`: call `handlePanelRequest` (or the exported panel handler) with a memory store; assert `maskedKey` is `****...`, raw key absent, and totals match.

- [ ] **Step 6: Build and run**

Run: `npm run build && node --test test/llm-usage-command.test.js test/panel-llm.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/llm/pool/aggregate.ts src/llm/command.ts src/tools/native-tools/llm.ts src/tools/llm.ts src/console/pages.ts src/panel/web.ts test/llm-usage-command.test.js test/panel-llm.test.js
git commit -m "feat: add LLM usage reports and panel stats"
```

---

## Task 9: Docs and Full Verification

**Files:**
- Modify: `DESIGN.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-11-llm-token-pool-design.md` (mark v1 cuts, if any)
- Test: full suite

**Interfaces:**
- Consumes: everything above.
- Produces: documented behavior and a green build.

- [ ] **Step 1: Update `DESIGN.md`**

Add a section near the LLM/provider notes (use the next `§13.x` number in the current file):
- v1 metering scope: center proxy + Node `chat.ts`; local Android direct calls excluded.
- Tables: pool tokens, price book, usage events, counters, reservations.
- Normalized usage fields and no generic `prompt - cache_read`.
- Reservation/settlement/TTL and the no-free-request rule.
- `supports_stream_usage` gate and estimation fallback.
- Budget period/currency/penalty defaults and env vars:
  `AOS_LLM_COST_CURRENCY`, `AOS_LLM_UNPRICED_MICROS_PER_MTOK`, `AOS_LLM_RESERVATION_TTL_MS`, `AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS`, `AOS_LLM_IMAGE_TOKEN_ESTIMATE`, `AOS_LLM_POOL_FILE`, `AOS_LLM_USAGE_FILE`.
- CLI/panel/tool surface.
- v1 gap: pool management actions record `createdBy`/`updatedAt` on the token row, but full service-level audit history (`llm.pool.create/update/disable`) is deferred; state this explicitly so it is not mistaken for implemented.

- [ ] **Step 2: Update `README.md`**

Add:
- CLI examples: `llm pool add`, `llm pool bind`, `llm price set`, `llm usage`.
- Panel ops card note (read-only stats; management via CLI).
- Key handling (masked only).
- FileStore vs PG budget behavior (strict only with PG; FileStore single-process).

- [ ] **Step 3: Run build and focused tests**

Run: `npm run build`
Then: `node --test test/llm-pool-store.test.js test/llm-pool-pricing.test.js test/llm-pool-estimate.test.js test/llm-pool-resolve.test.js test/llm-pool-command.test.js test/llm-proxy-pool.test.js test/llm-chat-budget.test.js test/llm-usage-command.test.js test/panel-llm.test.js`
Expected: all PASS.

- [ ] **Step 4: Run the full suite and lint**

Run: `npm test`
Expected: all pass (currently 3200+ tests).

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Manual PostgreSQL smoke (local only, not in CI)**

```bash
export MOBILE_TESTING_DATABASE_URL=postgres://aos:aos_local_dev@127.0.0.1:5432/mobile-testing
node dist/cli.js llm pool add --name smoke --provider custom --base-url https://api.deepseek.com \
  --model deepseek-chat --api-key "$DEEPSEEK_API_KEY" --budget-period monthly --budget-micros 1000000
node dist/cli.js llm pool list --json
node dist/cli.js llm usage --json
```

Expected: token masked; `llm usage` returns a report without errors.

- [ ] **Step 6: Commit**

```bash
git add DESIGN.md README.md docs/superpowers/specs/2026-11-11-llm-token-pool-design.md
git commit -m "docs: document LLM token pool accounting and budgets"
```

---

## Self-Review Checklist

- [ ] Spec §4.1–§4.5: pool tokens, binding fields, usage events, price book, compatibility — Tasks 1, 4.
- [ ] Spec §5.1: center proxy estimation/reservation/settlement/stream — Task 6.
- [ ] Spec §5.2: local `chat.ts` usage + budget — Task 7.
- [ ] Spec §5.3: time buckets/grouping/retention — Task 8 for buckets/grouping; Task 1 for `AOS_LLM_USAGE_RETENTION_DAYS` pruning.
- [ ] Spec §6: masked keys, roles, audit — masked keys in Tasks 4, 5, 8; full service-level audit is a documented v1 gap.
- [ ] Spec §7: `pending_token` and custom provider/model — Tasks 4, 5.
- [ ] Spec §8: pinned/auto, no silent model downgrade — Tasks 4, 6.
- [ ] Spec §9: MCP read-only tools, CLI, panel — Tasks 5, 8.
- [ ] Spec §10: atomic reservations, concurrency, unpriced penalty, currency — Tasks 1, 2, 6.
- [ ] Spec §11: migrations/FileStore — Task 1.
- [ ] Spec §12: 401/429, budget exhausted, no usage, disconnect, TTL — Tasks 1, 6.
- [ ] Spec §13: unit/integration tests, no real PG/network — every task.
- [ ] Spec §15: provider-neutral, DeepSeek only an adapter — Tasks 2, 3.
- [ ] Spec §17/§18: spike passed; no-go conditions reflected in tests — Tasks 3, 6.
