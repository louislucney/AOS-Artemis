import path from "node:path";

import { resolveProject } from "../config/loader.js";
import { createProjectStore } from "../db/index.js";
import type {
  LlmBudgetPeriod,
  LlmPoolStatus,
  LlmPoolTokenRecord,
  LlmPriceRecord,
  ProjectStore,
  UpsertLlmPoolTokenInput,
  UpsertLlmPriceInput
} from "../db/types.js";
import { errorMessage, maskSecret } from "../util.js";
import { aggregateLlmUsage, type LlmUsageBucket } from "./pool/aggregate.js";
import { baseCurrencyFrom } from "./pool/pricing.js";

export interface LlmCommandDeps {
  store?: ProjectStore;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  fetch?: typeof fetch;
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  has: (key: string) => boolean;
}

class UsageError extends Error {}

interface CommandContext {
  store: () => Promise<ProjectStore>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: (line: string) => void;
  errorLog: (line: string) => void;
  fetchImpl: typeof fetch;
}

const BUDGET_PERIODS: readonly LlmBudgetPeriod[] = ["daily", "monthly", "total", "none"];

export function printLlmUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp llm — LLM 资源池、价格与用量

Usage:
  mobile-testing-mcp llm pool list [--json]
  mobile-testing-mcp llm pool add --name <n> --provider <p> --base-url <u> --model <m[,m2]>
      [--api-key <k>|--key-env <VAR>] [--priority N] [--budget-period daily|monthly|total|none]
      [--budget-micros N] [--budget-tokens N] [--currency CNY] [--max-concurrency N]
      [--supports-stream-usage] [--dry-run] [--probe-stream] [--json]
  mobile-testing-mcp llm pool update --id <id> [same fields] [--disable|--enable] [--json]
  mobile-testing-mcp llm pool disable --id <id>
  mobile-testing-mcp llm pool bind --project <dir> --entry <name> --token <id|name>
      --model <model> [--mode pinned|auto] [--json]
  mobile-testing-mcp llm price list [--json]
  mobile-testing-mcp llm price set --provider <p> --model <m> --currency <c>
      --input-mtok <n> --output-mtok <n> [--cache-read-mtok <n>] [--cache-write-mtok <n>]
      [--fx <n>] [--effective-from <iso>] [--note <text>] [--json]
  mobile-testing-mcp llm usage [--project <dir>|--all] [--model <m>] [--token <id>]
      [--since <iso>] [--until <iso>] [--bucket hour|day|month]
      [--group-by project|model|token|none] [--json]

key 只显示 masked 预览；价格 *-mtok 为每百万 token 的货币单位。

exit codes: 0 成功；1 操作被拒绝（缺条目/价格重叠/校验失败）；2 用法错误`);
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    },
    has: (key) => flags.has(key)
  };
}

function required(flags: ParsedFlags, key: string): string {
  const value = flags.get(key);
  if (value === null || value.trim() === "") throw new UsageError(`缺少 --${key}`);
  return value.trim();
}

function optionalNumber(flags: ParsedFlags, key: string): number | undefined {
  const value = flags.get(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${key} 需要 ≥0 的数字`);
  return parsed;
}

function requiredNumber(flags: ParsedFlags, key: string): number {
  const value = optionalNumber(flags, key);
  if (value === undefined) throw new UsageError(`缺少 --${key}`);
  return value;
}

function optionalInteger(flags: ParsedFlags, key: string): number | undefined {
  const value = optionalNumber(flags, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new UsageError(`--${key} 需要整数`);
  return value;
}

function budgetPeriod(flags: ParsedFlags, fallback?: LlmBudgetPeriod): LlmBudgetPeriod | undefined {
  const value = flags.get("budget-period");
  if (value === null) return fallback;
  if (!BUDGET_PERIODS.includes(value as LlmBudgetPeriod)) {
    throw new UsageError(`--budget-period 需要 ${BUDGET_PERIODS.join("|")}`);
  }
  return value as LlmBudgetPeriod;
}

function tokenKey(
  token: Pick<LlmPoolTokenRecord, "apiKey" | "keyEnv">,
  env: NodeJS.ProcessEnv
): string | null {
  const direct = (token.apiKey ?? "").trim();
  if (direct !== "") return token.apiKey;
  const name = (token.keyEnv ?? "").trim();
  if (name === "") return null;
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function budgetView(token: LlmPoolTokenRecord): {
  period: LlmBudgetPeriod;
  limitMicros: number | null;
  limitTokens: number | null;
  currency: string;
  maxConcurrency: number;
} {
  return {
    period: token.budgetPeriod,
    limitMicros: token.budgetLimitMicros,
    limitTokens: token.budgetLimitTokens,
    currency: token.currency,
    maxConcurrency: token.maxConcurrency
  };
}

function tokenView(token: LlmPoolTokenRecord, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const key = tokenKey(token, env);
  return {
    id: token.id,
    name: token.name,
    provider: token.provider,
    baseUrl: token.baseUrl,
    models: [...token.modelAllowlist],
    status: token.status,
    priority: token.priority,
    budget: budgetView(token),
    supportsStreamUsage: token.supportsStreamUsage,
    lastValidatedAt: token.lastValidatedAt,
    lastError: token.lastError,
    key: {
      present: key !== null,
      preview: key === null ? null : maskSecret(key),
      envVar: token.keyEnv
    }
  };
}

function tokenLine(token: LlmPoolTokenRecord, env: NodeJS.ProcessEnv): string {
  const key = tokenKey(token, env);
  const budget = budgetView(token);
  const limits =
    budget.period === "none"
      ? "无限制"
      : `${budget.period} · 金额 ${budget.limitMicros ?? "∞"}µ · token ${budget.limitTokens ?? "∞"}`;
  return `${token.name} [${token.status}] ${token.provider} · models=${token.modelAllowlist.join(",") || "*"} · priority=${token.priority} · ${limits} · max=${budget.maxConcurrency} · key=${key === null ? "—" : maskSecret(key)}`;
}

function priceLine(price: LlmPriceRecord): string {
  return `#${price.version} ${price.provider}/${price.model} ${price.currency} · input ${price.inputMicrosPerMtok}µ · output ${price.outputMicrosPerMtok}µ · cache-read ${price.cacheReadMicrosPerMtok ?? "—"} · cache-write ${price.cacheWriteMicrosPerMtok ?? "—"} · fx ${price.fxRateToBase} · from ${price.effectiveFrom}${price.effectiveTo === null ? "" : ` to ${price.effectiveTo}`}`;
}

function printTokens(tokens: LlmPoolTokenRecord[], ctx: CommandContext, json: boolean): void {
  if (json) {
    ctx.log(JSON.stringify({ ok: true, tokens: tokens.map((token) => tokenView(token, ctx.env)) }, null, 2));
    return;
  }
  if (tokens.length === 0) {
    ctx.log("（无 LLM 池 token）");
    return;
  }
  for (const token of tokens) ctx.log(tokenLine(token, ctx.env));
}

function printToken(token: LlmPoolTokenRecord, ctx: CommandContext, json: boolean): void {
  if (json) {
    ctx.log(JSON.stringify({ ok: true, token: tokenView(token, ctx.env) }, null, 2));
    return;
  }
  ctx.log(tokenLine(token, ctx.env));
}

async function resolveStore(ctx: CommandContext): Promise<ProjectStore> {
  return ctx.store();
}

async function modelsValidation(
  baseUrl: string,
  key: string | null,
  fetchImpl: typeof fetch
): Promise<{ status: LlmPoolStatus | null; lastValidatedAt: string | null; lastError: string | null; ok: boolean }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      return {
        status: "active",
        lastValidatedAt: new Date().toISOString(),
        lastError: null,
        ok: true
      };
    }
    if (response.status === 404 || response.status === 405) {
      return {
        status: null,
        lastValidatedAt: null,
        lastError: "models-endpoint-unsupported",
        ok: true
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: "invalid",
        lastValidatedAt: null,
        lastError: `models-unauthorized-${response.status}`,
        ok: false
      };
    }
    return {
      status: null,
      lastValidatedAt: null,
      lastError: `models-http-${response.status}`,
      ok: true
    };
  } catch (error) {
    return {
      status: "invalid",
      lastValidatedAt: null,
      lastError: `models-unreachable: ${errorMessage(error)}`.slice(0, 300),
      ok: false
    };
  }
}

async function streamProbe(
  baseUrl: string,
  key: string | null,
  model: string,
  fetchImpl: typeof fetch
): Promise<{ supportsStreamUsage: boolean; lastError: string | null }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === null ? {} : { authorization: `Bearer ${key}` })
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return {
        supportsStreamUsage: false,
        lastError: response.status === 400 ? "stream-options-rejected" : `stream-probe-http-${response.status}`
      };
    }
    const text = await response.text();
    return { supportsStreamUsage: /"usage"\s*:/.test(text), lastError: null };
  } catch (error) {
    return {
      supportsStreamUsage: false,
      lastError: `stream-probe-failed: ${errorMessage(error)}`.slice(0, 300)
    };
  }
}

async function addPoolToken(flags: ParsedFlags, ctx: CommandContext): Promise<number> {
  const name = required(flags, "name");
  const provider = required(flags, "provider");
  const baseUrl = required(flags, "base-url");
  const models = required(flags, "model")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  if (models.length === 0) throw new UsageError("--model 至少需要一个模型名");
  const apiKey = flags.get("api-key");
  const keyEnv = flags.get("key-env");
  const hasKey = (apiKey ?? "").trim() !== "" || (keyEnv ?? "").trim() !== "";
  const baseCurrency = baseCurrencyFrom(ctx.env);
  const input: UpsertLlmPoolTokenInput = {
    name,
    provider,
    baseUrl,
    apiKey: apiKey === null ? null : apiKey,
    keyEnv: keyEnv === null ? null : keyEnv,
    modelAllowlist: models,
    status: hasKey ? "active" : "pending_token",
    priority: optionalInteger(flags, "priority") ?? 0,
    budgetPeriod: budgetPeriod(flags, "monthly"),
    budgetLimitMicros: optionalInteger(flags, "budget-micros") ?? null,
    budgetLimitTokens: optionalInteger(flags, "budget-tokens") ?? null,
    currency: (flags.get("currency") ?? baseCurrency).toUpperCase(),
    maxConcurrency: optionalInteger(flags, "max-concurrency") ?? 10,
    supportsStreamUsage: flags.bool("supports-stream-usage")
  };

  let status: LlmPoolStatus = input.status ?? "pending_token";
  let lastValidatedAt: string | null = null;
  let lastError: string | null = null;
  const effectiveKey = tokenKey(
    { apiKey: input.apiKey ?? null, keyEnv: input.keyEnv ?? null },
    ctx.env
  );
  if (flags.bool("dry-run") && effectiveKey !== null) {
    const validation = await modelsValidation(baseUrl, effectiveKey, ctx.fetchImpl);
    if (validation.status !== null) status = validation.status;
    lastValidatedAt = validation.lastValidatedAt;
    lastError = validation.lastError;
    if (!validation.ok) {
      const preview: LlmPoolTokenRecord = {
        id: "",
        name,
        provider,
        baseUrl,
        apiKey: input.apiKey ?? null,
        keyEnv: input.keyEnv ?? null,
        modelAllowlist: models,
        status,
        priority: input.priority ?? 0,
        budgetPeriod: input.budgetPeriod ?? "monthly",
        budgetLimitMicros: input.budgetLimitMicros ?? null,
        budgetLimitTokens: input.budgetLimitTokens ?? null,
        currency: input.currency ?? baseCurrency,
        maxConcurrency: input.maxConcurrency ?? 10,
        supportsStreamUsage: input.supportsStreamUsage ?? false,
        lastValidatedAt,
        lastError,
        createdBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      printToken(preview, ctx, flags.bool("json"));
      ctx.errorLog(`LLM 池 token 校验失败：${lastError}`);
      return 1;
    }
  }

  if (flags.bool("probe-stream") && effectiveKey !== null) {
    const probe = await streamProbe(baseUrl, effectiveKey, models[0]!, ctx.fetchImpl);
    input.supportsStreamUsage = probe.supportsStreamUsage;
    if (probe.lastError !== null) lastError = probe.lastError;
  }
  if (lastValidatedAt !== null) input.lastValidatedAt = lastValidatedAt;
  if (lastError !== null) input.lastError = lastError;
  input.status = status;

  if (flags.bool("dry-run")) {
    const preview: LlmPoolTokenRecord = {
      id: "",
      name,
      provider,
      baseUrl,
      apiKey: input.apiKey ?? null,
      keyEnv: input.keyEnv ?? null,
      modelAllowlist: models,
      status,
      priority: input.priority ?? 0,
      budgetPeriod: input.budgetPeriod ?? "monthly",
      budgetLimitMicros: input.budgetLimitMicros ?? null,
      budgetLimitTokens: input.budgetLimitTokens ?? null,
      currency: input.currency ?? baseCurrency,
      maxConcurrency: input.maxConcurrency ?? 10,
      supportsStreamUsage: input.supportsStreamUsage ?? false,
      lastValidatedAt,
      lastError,
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    printToken(preview, ctx, flags.bool("json"));
    return 0;
  }

  const store = await resolveStore(ctx);
  const saved = await store.upsertLlmPoolToken(input);
  printToken(saved, ctx, flags.bool("json"));
  if (saved.status === "invalid") {
    ctx.errorLog(`token 已保存但状态为 invalid：${saved.lastError ?? "unknown"}`);
    return 1;
  }
  return 0;
}

async function updatePoolToken(flags: ParsedFlags, ctx: CommandContext): Promise<number> {
  const id = required(flags, "id");
  const store = await resolveStore(ctx);
  const existing = await store.getLlmPoolToken(id);
  if (existing === null) {
    ctx.errorLog(`未知 token：${id}`);
    return 1;
  }
  if (flags.bool("disable") && flags.bool("enable")) {
    throw new UsageError("--disable 与 --enable 不能同时使用");
  }
  const status: LlmPoolStatus | undefined = flags.bool("disable")
    ? "disabled"
    : flags.bool("enable")
      ? "active"
      : undefined;
  const models = flags.get("model")
    ?.split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  const input: UpsertLlmPoolTokenInput = {
    id,
    name: flags.get("name")?.trim() || existing.name,
    provider: flags.get("provider")?.trim() || existing.provider,
    baseUrl: flags.get("base-url")?.trim() || existing.baseUrl,
    apiKey: flags.has("api-key") ? flags.get("api-key") : undefined,
    keyEnv: flags.has("key-env") ? flags.get("key-env") : undefined,
    modelAllowlist: models === undefined || models.length === 0 ? undefined : models,
    status,
    priority: optionalInteger(flags, "priority"),
    budgetPeriod: budgetPeriod(flags),
    budgetLimitMicros: optionalInteger(flags, "budget-micros"),
    budgetLimitTokens: optionalInteger(flags, "budget-tokens"),
    currency: flags.get("currency")?.toUpperCase(),
    maxConcurrency: optionalInteger(flags, "max-concurrency"),
    supportsStreamUsage: flags.has("supports-stream-usage")
      ? flags.bool("supports-stream-usage")
      : undefined
  };
  const saved = await store.upsertLlmPoolToken(input);
  printToken(saved, ctx, flags.bool("json"));
  return 0;
}

async function disablePoolToken(flags: ParsedFlags, ctx: CommandContext): Promise<number> {
  const id = required(flags, "id");
  const store = await resolveStore(ctx);
  const existing = await store.getLlmPoolToken(id);
  if (existing === null) {
    ctx.errorLog(`未知 token：${id}`);
    return 1;
  }
  const saved = await store.upsertLlmPoolToken({
    id,
    name: existing.name,
    provider: existing.provider,
    baseUrl: existing.baseUrl,
    status: "disabled"
  });
  printToken(saved, ctx, flags.bool("json"));
  return 0;
}

async function bindPoolToken(flags: ParsedFlags, ctx: CommandContext): Promise<number> {
  const root = flags.get("project")
    ? path.resolve(ctx.cwd, flags.get("project")!)
    : resolveProject({ env: ctx.env, cwd: ctx.cwd }).rootDir;
  const entryName = required(flags, "entry");
  const tokenRef = required(flags, "token");
  const model = required(flags, "model");
  const mode = flags.get("mode") ?? "pinned";
  if (mode !== "pinned" && mode !== "auto") throw new UsageError("--mode 需要 pinned|auto");
  const store = await resolveStore(ctx);
  const entries = await store.listLlms(root);
  if (!entries.some((entry) => entry.name === entryName)) {
    ctx.errorLog(`项目 ${root} 没有 LLM 条目 "${entryName}"`);
    return 1;
  }
  const token =
    (await store.getLlmPoolToken(tokenRef)) ??
    (await store.listLlmPoolTokens()).find((candidate) => candidate.name === tokenRef) ??
    null;
  if (token === null) {
    ctx.errorLog(`未知 token："${tokenRef}"`);
    return 1;
  }
  const ok = await store.setLlmPoolBinding({
    rootPath: root,
    name: entryName,
    poolTokenId: token.id,
    poolMode: mode,
    poolModel: model
  });
  if (!ok) {
    ctx.errorLog(`绑定失败：条目 "${entryName}" 未写入`);
    return 1;
  }
  if (flags.bool("json")) {
    ctx.log(
      JSON.stringify(
        {
          ok: true,
          binding: {
            project: root,
            entry: entryName,
            tokenId: token.id,
            tokenName: token.name,
            mode,
            model
          }
        },
        null,
        2
      )
    );
  } else {
    ctx.log(`已绑定 ${entryName} → ${token.name}（${mode} · ${model}）`);
  }
  return 0;
}

async function poolCommand(
  action: string | undefined,
  flags: ParsedFlags,
  ctx: CommandContext
): Promise<number> {
  switch (action) {
    case "list": {
      const store = await resolveStore(ctx);
      printTokens(await store.listLlmPoolTokens(), ctx, flags.bool("json"));
      return 0;
    }
    case "add":
      return addPoolToken(flags, ctx);
    case "update":
      return updatePoolToken(flags, ctx);
    case "disable":
      return disablePoolToken(flags, ctx);
    case "bind":
      return bindPoolToken(flags, ctx);
    default:
      throw new UsageError(`未知 pool 子命令 "${action ?? ""}"`);
  }
}

async function priceCommand(
  action: string | undefined,
  flags: ParsedFlags,
  ctx: CommandContext
): Promise<number> {
  const store = await resolveStore(ctx);
  if (action === "list") {
    const prices = await store.listLlmPrices();
    if (flags.bool("json")) {
      ctx.log(JSON.stringify({ ok: true, prices }, null, 2));
    } else if (prices.length === 0) {
      ctx.log("（无价格）");
    } else {
      for (const price of prices) ctx.log(priceLine(price));
    }
    return 0;
  }
  if (action !== "set") throw new UsageError(`未知 price 子命令 "${action ?? ""}"`);

  const provider = required(flags, "provider");
  const model = required(flags, "model");
  const currency = required(flags, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new UsageError("--currency 需要三位币种代码");
  const baseCurrency = baseCurrencyFrom(ctx.env);
  const fxFlag = optionalNumber(flags, "fx");
  if (currency !== baseCurrency && (fxFlag === undefined || fxFlag <= 0)) {
    throw new UsageError(`非本位币（${currency} ≠ ${baseCurrency}）价格必须提供 --fx（>0）`);
  }
  const effectiveFrom = flags.get("effective-from") ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(effectiveFrom))) {
    throw new UsageError("--effective-from 需要 ISO 时间");
  }
  const input: UpsertLlmPriceInput = {
    provider,
    model,
    currency,
    fxRateToBase: fxFlag ?? 1,
    inputMicrosPerMtok: Math.round(requiredNumber(flags, "input-mtok") * 1_000_000),
    outputMicrosPerMtok: Math.round(requiredNumber(flags, "output-mtok") * 1_000_000),
    cacheReadMicrosPerMtok:
      optionalNumber(flags, "cache-read-mtok") === undefined
        ? null
        : Math.round(optionalNumber(flags, "cache-read-mtok")! * 1_000_000),
    cacheWriteMicrosPerMtok:
      optionalNumber(flags, "cache-write-mtok") === undefined
        ? null
        : Math.round(optionalNumber(flags, "cache-write-mtok")! * 1_000_000),
    effectiveFrom,
    effectiveTo: null,
    note: flags.get("note")
  };
  try {
    const saved = await store.upsertLlmPrice(input);
    if (flags.bool("json")) {
      ctx.log(JSON.stringify({ ok: true, price: saved }, null, 2));
    } else {
      ctx.log(priceLine(saved));
    }
    return 0;
  } catch (error) {
    if (errorMessage(error) === "llm-price-overlap") {
      ctx.errorLog("价格区间与现有价格重叠");
      return 1;
    }
    throw error;
  }
}

function usageLine(row: LlmUsageBucket): string {
  const flags = [
    `请求 ${row.requests}`,
    `tokens ${row.totalTokens}`,
    `金额 ${row.costMicrosBase}µ`,
    ...(row.unpricedRequests > 0 ? [`未定价 ${row.unpricedRequests}`] : []),
    ...(row.fxMissingRequests > 0 ? [`缺汇率 ${row.fxMissingRequests}`] : [])
  ];
  return `${row.key} · ${flags.join(" · ")}`;
}

async function usageCommand(flags: ParsedFlags, ctx: CommandContext): Promise<number> {
  const all = flags.bool("all");
  const projectFlag = flags.get("project");
  if (all && projectFlag !== null) {
    throw new UsageError("--all 与 --project 不能同时使用");
  }
  const bucket = flags.get("bucket");
  if (bucket !== null && !["hour", "day", "month"].includes(bucket)) {
    throw new UsageError("--bucket 需要 hour|day|month");
  }
  const groupBy = flags.get("group-by") ?? "none";
  if (!["project", "model", "token", "none"].includes(groupBy)) {
    throw new UsageError("--group-by 需要 project|model|token|none");
  }
  const since = flags.get("since");
  const until = flags.get("until");
  for (const [name, value] of [
    ["since", since],
    ["until", until]
  ] as const) {
    if (value !== null && Number.isNaN(Date.parse(value))) {
      throw new UsageError(`--${name} 需要 ISO 时间`);
    }
  }
  const projectRoot = all
    ? undefined
    : projectFlag !== null
      ? path.resolve(ctx.cwd, projectFlag)
      : resolveProject({ env: ctx.env, cwd: ctx.cwd }).rootDir;
  const store = await resolveStore(ctx);
  const query = {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(flags.get("model") === null ? {} : { model: flags.get("model")! }),
    ...(flags.get("token") === null ? {} : { poolTokenId: flags.get("token")! }),
    ...(since === null ? {} : { since }),
    ...(until === null ? {} : { until }),
    ...(bucket === null ? {} : { bucket: bucket as "hour" | "day" | "month" }),
    groupBy: groupBy as "project" | "model" | "token" | "none",
    limit: all ? 50000 : 5000
  };
  const events = await store.listLlmUsageEvents(query);
  const report = aggregateLlmUsage(events, query);
  if (flags.bool("json")) {
    ctx.log(JSON.stringify({ ok: true, report }, null, 2));
    return 0;
  }
  if (report.rows.length === 0) ctx.log("（无用量数据）");
  for (const row of report.rows) ctx.log(usageLine(row));
  ctx.log(usageLine({ ...report.totals, key: "合计" }));
  return 0;
}

export async function runLlmCommand(
  rest: string[],
  deps: LlmCommandDeps = {}
): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  if (rest.length === 0) {
    printLlmUsage(log);
    return 2;
  }
  const flags = parseFlags(rest);
  if (flags.bool("help")) {
    printLlmUsage(log);
    return 0;
  }
  let store: ProjectStore | null = deps.store ?? null;
  const ctx: CommandContext = {
    store: async () => {
      if (store !== null) return store;
      const created = await createProjectStore(env.MOBILE_TESTING_DATABASE_URL ?? null);
      store = created.store;
      return store;
    },
    env,
    cwd,
    log,
    errorLog,
    fetchImpl: deps.fetch ?? fetch
  };
  const [area, action] = flags.positional;
  try {
    if (area === "pool") return await poolCommand(action, flags, ctx);
    if (area === "price") return await priceCommand(action, flags, ctx);
    if (area === "usage") {
      return await usageCommand(flags, ctx);
    }
    throw new UsageError(`未知子命令 "${area ?? ""}"`);
  } catch (error) {
    if (error instanceof UsageError) {
      errorLog(error.message);
      printLlmUsage(errorLog);
      return 2;
    }
    errorLog(`LLM 池命令失败：${errorMessage(error)}`);
    return 1;
  }
}
