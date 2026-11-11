import type {
  LlmPoolTokenRecord,
  LlmPriceRecord,
  LlmUsageStatus,
  NormalizedUsage,
  ProjectStore
} from "../../db/types.js";
import { errorMessage, logWarn } from "../../util.js";
import type { ChatBudget, ChatBudgetReservation, ChatMessage } from "../chat.js";
import { reserveForRequest, settleReservation } from "./budget-service.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export class LlmBudgetError extends Error {
  readonly code: "llm-budget-exhausted" | "llm-token-unavailable";
  readonly status: 402 | 503;

  constructor(
    code: "llm-budget-exhausted" | "llm-token-unavailable",
    status: 402 | 503,
    message: string
  ) {
    super(message);
    this.name = "LlmBudgetError";
    this.code = code;
    this.status = status;
  }
}

function defaultMaxOutputTokens(env: NodeJS.ProcessEnv): number {
  const raw = (env.AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS ?? "").trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_MAX_OUTPUT_TOKENS;
}

export interface CreateChatBudgetInput {
  store: ProjectStore;
  token: LlmPoolTokenRecord;
  projectRoot: string;
  provider: string;
  model: string;
  prices: readonly LlmPriceRecord[];
  baseCurrency: string;
  env: NodeJS.ProcessEnv;
  context?: { traceId?: string | null; taskId?: string | null };
}

export function createChatBudget(input: CreateChatBudgetInput): ChatBudget {
  return {
    async reserve(messages: ChatMessage[], maxOutputTokens?: number): Promise<ChatBudgetReservation> {
      const result = await reserveForRequest({
        store: input.store,
        token: input.token,
        projectRoot: input.projectRoot,
        provider: input.provider,
        model: input.model,
        source: "local_chat",
        requestBody: {
          messages,
          max_tokens: maxOutputTokens ?? defaultMaxOutputTokens(input.env)
        },
        env: input.env,
        prices: input.prices,
        baseCurrency: input.baseCurrency,
        context: {
          traceId: input.context?.traceId ?? null,
          taskId: input.context?.taskId ?? null
        }
      });
      if (!result.ok) {
        if (result.reason === "budget-exhausted" || result.reason === "concurrency-limit") {
          throw new LlmBudgetError(
            "llm-budget-exhausted",
            402,
            `LLM 预算或并发已满（${result.reason}）`
          );
        }
        throw new LlmBudgetError(
          "llm-token-unavailable",
          503,
          `LLM token 不可用（${result.reason}）`
        );
      }
      const reservation = result.reservation;
      return {
        async settle(usage: NormalizedUsage | null, status: LlmUsageStatus = "ok"): Promise<void> {
          try {
            await settleReservation({
              store: input.store,
              reservation,
              usage,
              usageSource:
                usage === null || status === "settled_estimated" ? "estimated" : "provider",
              price: result.price,
              baseCurrency: input.baseCurrency,
              status,
              at: new Date().toISOString()
            });
          } catch (error) {
            logWarn(`LLM 聊天用量结算失败：${errorMessage(error)}`);
          }
        },
        async release(): Promise<void> {
          try {
            await input.store.releaseLlmReservation({ reservationId: reservation.id });
          } catch (error) {
            logWarn(`LLM 聊天预留释放失败：${errorMessage(error)}`);
          }
        }
      };
    }
  };
}
