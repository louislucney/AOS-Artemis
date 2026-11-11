import type { LlmPriceRecord, NormalizedUsage } from "../../db/types.js";

const DEFAULT_BASE_CURRENCY = "CNY";
const DEFAULT_PENALTY_MICROS_PER_MTOK = 20_000_000;
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface ComputedCost {
  costMicros: number;
  costMicrosBase: number | null;
  currency: string;
  baseCurrency: string;
  fxRateToBase: number;
  priceBookId: string;
  priceVersion: number;
}

export function baseCurrencyFrom(env: NodeJS.ProcessEnv): string {
  const raw = (env.AOS_LLM_COST_CURRENCY ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : DEFAULT_BASE_CURRENCY;
}

function providerRank(price: LlmPriceRecord, provider: string): number {
  return price.provider === provider ? 2 : price.provider === "*" ? 0 : -1;
}

function modelRank(price: LlmPriceRecord, model: string): number {
  return price.model === model ? 1 : price.model === "*" ? 0 : -1;
}

export function findPrice(
  prices: readonly LlmPriceRecord[],
  provider: string,
  model: string,
  at: string
): LlmPriceRecord | null {
  let best: LlmPriceRecord | null = null;
  let bestRank = -1;
  for (const price of prices) {
    const rank = providerRank(price, provider) * 2 + modelRank(price, model);
    if (rank < 0) continue;
    if (price.effectiveFrom > at) continue;
    if (price.effectiveTo !== null && price.effectiveTo <= at) continue;
    if (
      best === null ||
      rank > bestRank ||
      (rank === bestRank && price.effectiveFrom > best.effectiveFrom)
    ) {
      best = price;
      bestRank = rank;
    }
  }
  return best;
}

function penaltyMicrosFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = (env.AOS_LLM_UNPRICED_MICROS_PER_MTOK ?? "").trim();
  if (raw === "") return DEFAULT_PENALTY_MICROS_PER_MTOK;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_PENALTY_MICROS_PER_MTOK;
}

export function penaltyRate(
  prices: readonly LlmPriceRecord[],
  baseCurrency: string,
  env: NodeJS.ProcessEnv
): LlmPriceRecord {
  let highest = 0;
  for (const price of prices) {
    if (price.currency !== baseCurrency) continue;
    if (price.inputMicrosPerMtok > highest) highest = price.inputMicrosPerMtok;
  }
  const rate = highest > 0 ? highest : penaltyMicrosFromEnv(env);
  return {
    id: "penalty",
    version: 0,
    provider: "*",
    model: "*",
    currency: baseCurrency,
    fxRateToBase: 1,
    inputMicrosPerMtok: rate,
    outputMicrosPerMtok: rate,
    cacheReadMicrosPerMtok: rate,
    cacheWriteMicrosPerMtok: rate,
    effectiveFrom: EPOCH,
    effectiveTo: null,
    createdBy: null,
    note: "unpriced-penalty",
    createdAt: EPOCH
  };
}

function rate(value: number | null, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function costMicrosOf(usage: NormalizedUsage, price: LlmPriceRecord): number {
  const micros =
    usage.baseInputTokens * rate(price.inputMicrosPerMtok) +
    usage.cacheCreationTokens * rate(price.cacheWriteMicrosPerMtok) +
    usage.cacheReadTokens * rate(price.cacheReadMicrosPerMtok) +
    usage.outputTokens * rate(price.outputMicrosPerMtok);
  return Math.round(micros / 1_000_000);
}

export function computeCost(
  usage: NormalizedUsage,
  price: LlmPriceRecord,
  baseCurrency: string
): ComputedCost {
  const costMicros = costMicrosOf(usage, price);
  let costMicrosBase: number | null;
  if (price.currency === baseCurrency) {
    costMicrosBase = costMicros;
  } else if (Number.isFinite(price.fxRateToBase) && price.fxRateToBase > 0) {
    costMicrosBase = Math.round(costMicros * price.fxRateToBase);
  } else {
    costMicrosBase = null;
  }
  return {
    costMicros,
    costMicrosBase,
    currency: price.currency,
    baseCurrency,
    fxRateToBase: price.fxRateToBase,
    priceBookId: price.id,
    priceVersion: price.version
  };
}

export function estimateCostMicros(usage: NormalizedUsage, price: LlmPriceRecord): number {
  return costMicrosOf(usage, price);
}
