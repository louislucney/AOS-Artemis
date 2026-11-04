export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatContent = string | ChatContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ChatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

export interface ChatOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
  /** 可选 token 计量回调；不改变 `ChatFn` 签名，现有调用方零修改。 */
  onUsage?: (usage: ChatUsage) => void;
}

export type ChatFn = (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;

export interface ChatErrorDetails {
  status?: number;
  body?: string;
}

export class ChatError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, details: ChatErrorDetails = {}) {
    super(message);
    this.name = "ChatError";
    this.status = details.status;
    this.body = details.body;
  }
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
    finish_reason?: unknown;
  }>;
  error?: { message?: unknown };
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
  };
}

/** OpenAI-compatible providers differ on content shape: string, or an array
 * of `{type:"text", text}` parts. Accept both; ignore non-text parts. */
function contentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() === "" ? null : content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
    return text.trim() === "" ? null : text;
  }
  return null;
}

/** True for `200 OK` responses whose body has no usable assistant text. This is
 * often transient (provider empty completion), so the iOS loop retries the same
 * image once before degrading to text. */
export function isMissingContentError(error: unknown): boolean {
  return error instanceof ChatError && error.message.startsWith("LLM 响应缺少 choices[0].message.content");
}

/** Diagnose a chat failure without dumping the whole body (which may echo the
 * prompt): message + HTTP status + a short single-line body preview. */
export function describeChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ChatError)) return message;
  const details: string[] = [];
  if (typeof error.status === "number") details.push(`status=${error.status}`);
  if (typeof error.body === "string" && error.body.trim() !== "") {
    details.push(`body=${error.body.replace(/\s+/g, " ").trim().slice(0, 200)}`);
  }
  return details.length > 0 ? `${message}（${details.join("；")}）` : message;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageOf(payload: ChatCompletionPayload): ChatUsage | null {
  const usage = payload.usage;
  if (usage === undefined || usage === null) return null;
  const promptTokens = usageNumber(usage.prompt_tokens);
  const completionTokens = usageNumber(usage.completion_tokens);
  const cacheReadTokens =
    usageNumber(usage.cache_read_input_tokens) ||
    usageNumber(usage.prompt_cache_hit_tokens) ||
    usageNumber(usage.prompt_tokens_details?.cached_tokens);
  const cacheCreateTokens = usageNumber(usage.cache_creation_input_tokens);
  return { promptTokens, completionTokens, cacheCreateTokens, cacheReadTokens };
}

/** Minimal OpenAI-compatible chat client (JSON output expected from the model). */
export function makeChatFn(target: ChatTarget, options: ChatOptions = {}): ChatFn {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const temperature = options.temperature ?? 0;
  const base = target.baseUrl.replace(/\/+$/, "");

  return async (messages, signal) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await fetchFn(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${target.apiKey}`
        },
        body: JSON.stringify({ model: target.model, messages, temperature }),
        signal: controller.signal
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ChatError(`LLM 请求失败: ${message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ChatError(`LLM 响应 HTTP ${response.status}`, {
        status: response.status,
        body: text.slice(0, 500)
      });
    }
    let payload: ChatCompletionPayload;
    try {
      payload = JSON.parse(text) as ChatCompletionPayload;
    } catch {
      throw new ChatError("LLM 响应不是合法 JSON", { body: text.slice(0, 500) });
    }
    if (payload.error?.message) {
      throw new ChatError(`LLM 返回错误: ${String(payload.error.message)}`, { body: text.slice(0, 500) });
    }
    const usage = usageOf(payload);
    if (usage !== null) options.onUsage?.(usage);
    const choice = payload.choices?.[0];
    const content = contentText(choice?.message?.content);
    if (content === null) {
      const finish =
        typeof choice?.finish_reason === "string" ? `（finish_reason=${choice.finish_reason}）` : "";
      const reasoningOnly =
        typeof choice?.message?.reasoning_content === "string" &&
        choice.message.reasoning_content.trim() !== ""
          ? "（仅返回 reasoning_content，无最终 content）"
          : "";
      throw new ChatError(`LLM 响应缺少 choices[0].message.content${finish}${reasoningOnly}`, {
        body: text.slice(0, 500)
      });
    }
    return content;
  };
}
