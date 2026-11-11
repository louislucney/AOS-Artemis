import type {
  LlmBudgetSnapshot,
  LlmPoolTokenRecord,
  LlmPriceRecord,
  LlmReservationRecord,
  LlmUsageOrigin,
  LlmUsageRecord,
  LlmUsageSource,
  LlmUsageStatus,
  NormalizedUsage,
  ProjectStore
} from "../../db/types.js";
import { estimateRequest, type RequestEstimate } from "./estimate.js";
import { computeCost, estimateCostMicros, findPrice, penaltyRate } from "./pricing.js";
import { estimatedUsage } from "./usage.js";

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

export async function reserveForRequest(
  input: ReserveForRequestInput
): Promise<ReserveForRequestResult> {
  const at = input.at ?? new Date().toISOString();
  const estimate = estimateRequest(input.requestBody, input.env);
  const price =
    findPrice(input.prices, input.provider, input.model, at) ??
    penaltyRate(input.prices, input.baseCurrency, input.env);
  const usage = estimatedUsage(estimate.promptTokens, estimate.completionTokens);
  const computed = computeCost(usage, price, input.baseCurrency);
  const estimatedCostMicros =
    computed.costMicrosBase ??
    estimateCostMicros(usage, penaltyRate(input.prices, input.baseCurrency, input.env));
  const reserved = await input.store.reserveLlmBudget({
    poolTokenId: input.token.id,
    projectRoot: input.projectRoot,
    provider: input.provider,
    model: input.model,
    source: input.source,
    estimatedPromptTokens: estimate.promptTokens,
    estimatedOutputTokens: estimate.completionTokens,
    estimatedMicros: estimatedCostMicros,
    at,
    hostId: input.context?.hostId ?? null,
    sessionId: input.context?.sessionId ?? null,
    taskId: input.context?.taskId ?? null,
    traceId: input.context?.traceId ?? null,
    requestId: input.context?.requestId ?? null
  });
  if (!reserved.ok) return reserved;
  return {
    ok: true,
    reservation: reserved.reservation,
    estimate,
    price,
    estimatedCostMicros
  };
}

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
}): Promise<LlmUsageRecord | null> {
  const usage =
    input.usage ??
    estimatedUsage(
      input.reservation.estimatedPromptTokens,
      input.reservation.estimatedOutputTokens
    );
  const unpriced = input.price.id === "penalty" || input.price.version === 0;
  const cost = computeCost(usage, input.price, input.baseCurrency);
  return input.store.settleLlmReservation({
    reservationId: input.reservation.id,
    usage,
    usageSource: input.usage === null ? "estimated" : input.usageSource,
    costMicros: unpriced ? null : cost.costMicros,
    currency: unpriced ? null : cost.currency,
    costMicrosBase: unpriced ? null : cost.costMicrosBase,
    baseCurrency: cost.baseCurrency,
    fxRateToBase: unpriced ? null : cost.fxRateToBase,
    priceBookId: unpriced ? null : cost.priceBookId,
    priceVersion: unpriced ? null : cost.priceVersion,
    status: input.status,
    errorClass: input.errorClass ?? null,
    at: input.at
  });
}
