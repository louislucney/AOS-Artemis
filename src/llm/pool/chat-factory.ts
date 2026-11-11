import type {
  LlmPoolMode,
  LlmPoolTokenRecord,
  LlmPriceRecord,
  NormalizedUsage,
  ProjectStore
} from "../../db/types.js";
import { errorMessage, logWarn } from "../../util.js";
import { makeChatFn, type ChatFn, type ChatOptions } from "../chat.js";
import { createChatBudget, LlmBudgetError } from "./chat-budget.js";
import { baseCurrencyFrom, computeCost, findPrice, penaltyRate } from "./pricing.js";
import { resolvePoolTokenKey } from "./resolve.js";

/** Minimal active-entry shape shared by Runtime and the design runtime. */
export interface ChatEntryLike {
  name?: string;
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  poolTokenId?: string | null;
  poolMode?: LlmPoolMode;
  poolModel?: string | null;
}

export interface MakeChatForRuntimeInput {
  store: ProjectStore;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  entry: ChatEntryLike;
  options?: ChatOptions;
  context?: { traceId?: string | null; taskId?: string | null };
}

export interface RecordLocalLlmUsageInput {
  store: ProjectStore;
  projectRoot: string;
  provider: string;
  model: string;
  usage: NormalizedUsage;
  estimated: boolean;
  prices: readonly LlmPriceRecord[];
  baseCurrency: string;
  env?: NodeJS.ProcessEnv;
  at?: string;
}

function modelAllowed(token: LlmPoolTokenRecord, model: string): boolean {
  return token.modelAllowlist.length === 0 || token.modelAllowlist.includes(model);
}

async function loadPrices(store: ProjectStore): Promise<LlmPriceRecord[]> {
  try {
    return await store.listLlmPrices();
  } catch (error) {
    logWarn(`LLM 价格表读取失败（按惩罚价）：${errorMessage(error)}`);
    return [];
  }
}

export async function recordLocalLlmUsage(input: RecordLocalLlmUsageInput): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const price =
    findPrice(input.prices, input.provider, input.model, at) ??
    penaltyRate(input.prices, input.baseCurrency, input.env ?? process.env);
  const unpriced = price.id === "penalty" || price.version === 0;
  const cost = computeCost(input.usage, price, input.baseCurrency);
  try {
    await input.store.recordLlmUsage({
      projectRoot: input.projectRoot,
      poolTokenId: null,
      provider: input.provider,
      model: input.model,
      usage: input.usage,
      usageSource: input.estimated ? "estimated" : "provider",
      costMicros: unpriced ? null : cost.costMicros,
      currency: unpriced ? null : cost.currency,
      costMicrosBase: unpriced ? null : cost.costMicrosBase,
      baseCurrency: input.baseCurrency,
      fxRateToBase: unpriced ? null : cost.fxRateToBase,
      priceBookId: unpriced ? null : cost.priceBookId,
      priceVersion: unpriced ? null : cost.priceVersion,
      source: "local_chat",
      status: input.estimated ? "settled_estimated" : "ok",
      at
    });
  } catch (error) {
    logWarn(`本地 LLM 用量记录失败：${errorMessage(error)}`);
  }
}

async function pickPoolToken(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  entry: ChatEntryLike,
  model: string
): Promise<{ token: LlmPoolTokenRecord; key: string }> {
  const mode = entry.poolMode ?? "pinned";
  if (mode === "auto") {
    const tokens = (await store.listLlmPoolTokens())
      .filter((token) => token.status === "active" && modelAllowed(token, model))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          (b.lastValidatedAt ?? "").localeCompare(a.lastValidatedAt ?? "") ||
          a.name.localeCompare(b.name)
      );
    for (const token of tokens) {
      const key = resolvePoolTokenKey(token, env);
      if (key !== null) return { token, key };
    }
    throw new LlmBudgetError("llm-token-unavailable", 503, "没有可用的池 token");
  }

  if (entry.poolTokenId === undefined || entry.poolTokenId === null) {
    throw new LlmBudgetError("llm-token-unavailable", 503, "项目未绑定池 token");
  }
  const token = await store.getLlmPoolToken(entry.poolTokenId);
  if (token === null) {
    throw new LlmBudgetError("llm-token-unavailable", 503, "绑定的池 token 不存在");
  }
  const key = resolvePoolTokenKey(token, env);
  if (token.status !== "active" || key === null) {
    throw new LlmBudgetError("llm-token-unavailable", 503, "绑定的池 token 不可用");
  }
  if (!modelAllowed(token, model)) {
    throw new LlmBudgetError("llm-token-unavailable", 503, "模型不在池 token 的 allowlist");
  }
  return { token, key };
}

export interface ResolvedChatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
  token: LlmPoolTokenRecord | null;
}

export async function resolveChatEntryTarget(input: {
  store: ProjectStore;
  env: NodeJS.ProcessEnv;
  entry: ChatEntryLike;
}): Promise<ResolvedChatTarget> {
  const { store, env, entry } = input;
  if (entry.poolTokenId !== undefined && entry.poolTokenId !== null) {
    const model = entry.poolModel ?? entry.model ?? "";
    const { token, key } = await pickPoolToken(store, env, entry, model);
    return {
      baseUrl: token.baseUrl,
      apiKey: key,
      model,
      provider: token.provider,
      token
    };
  }
  return {
    baseUrl: entry.baseUrl ?? "",
    apiKey: entry.apiKey ?? "",
    model: entry.model ?? "",
    provider: entry.provider ?? "custom",
    token: null
  };
}

export async function makeChatForRuntime(input: MakeChatForRuntimeInput): Promise<ChatFn> {
  const { store, projectRoot, env, entry, options = {} } = input;
  const target = await resolveChatEntryTarget({ store, env, entry });
  if (target.token !== null) {
    const prices = await loadPrices(store);
    const budget = createChatBudget({
      store,
      token: target.token,
      projectRoot,
      provider: target.provider,
      model: target.model,
      prices,
      baseCurrency: baseCurrencyFrom(env),
      env,
      context: input.context
    });
    return makeChatFn(
      {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        provider: target.provider
      },
      { ...options, budget }
    );
  }

  const normalizedCallback =
    options.onNormalizedUsage ??
    (async (usage: NormalizedUsage, estimated: boolean): Promise<void> => {
      const prices = await loadPrices(store);
      await recordLocalLlmUsage({
        store,
        projectRoot,
        provider: target.provider,
        model: target.model,
        usage,
        estimated,
        prices,
        baseCurrency: baseCurrencyFrom(env),
        env
      });
    });
  return makeChatFn(
    {
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      provider: target.provider
    },
    { ...options, onNormalizedUsage: normalizedCallback }
  );
}
