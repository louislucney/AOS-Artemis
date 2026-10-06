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

export interface ChatOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
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
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
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
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ChatError("LLM 响应缺少 choices[0].message.content", { body: text.slice(0, 500) });
    }
    return content;
  };
}
