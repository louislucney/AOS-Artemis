import { getEncoding, type Tiktoken } from "js-tiktoken";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1600;
const MESSAGE_OVERHEAD = 4;
const REQUEST_OVERHEAD = 2;
const CJK_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export interface RequestEstimate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

let encoder: Tiktoken | null = null;

function tiktoken(): Tiktoken {
  if (encoder === null) encoder = getEncoding("cl100k_base");
  return encoder;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : null;
}

function envPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function cjkCount(text: string): number {
  return text.match(CJK_PATTERN)?.length ?? 0;
}

export function estimateTextTokens(text: string): number {
  if (text === "") return 0;
  let encoded = 0;
  try {
    encoded = tiktoken().encode(text).length;
  } catch {
    encoded = Math.ceil(text.length / 4);
  }
  return Math.ceil(Math.max(encoded, cjkCount(text)) * 1.15);
}

function contentTokens(content: unknown, imageTokens: number): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) {
    return content === null || content === undefined
      ? 0
      : estimateTextTokens(JSON.stringify(content));
  }
  let total = 0;
  for (const part of content) {
    if (typeof part === "string") {
      total += estimateTextTokens(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      total += estimateTextTokens(record.text);
      continue;
    }
    if (
      record.type === "image_url" ||
      record.type === "image" ||
      record.type === "input_image"
    ) {
      total += imageTokens;
      continue;
    }
    total += estimateTextTokens(JSON.stringify(part));
  }
  return total;
}

function messageTokens(message: unknown, imageTokens: number): number {
  if (typeof message !== "object" || message === null) return MESSAGE_OVERHEAD;
  const record = message as Record<string, unknown>;
  let total = contentTokens(record.content, imageTokens) + MESSAGE_OVERHEAD;
  for (const key of ["tool_calls", "function_call", "name", "tool_call_id"]) {
    const value = record[key];
    if (value !== undefined) total += estimateTextTokens(JSON.stringify(value));
  }
  return total;
}

export function estimateMessagesTokens(
  messages: unknown,
  env: NodeJS.ProcessEnv = process.env
): number {
  const imageTokens = envPositiveInt(env.AOS_LLM_IMAGE_TOKEN_ESTIMATE, DEFAULT_IMAGE_TOKEN_ESTIMATE);
  const list = Array.isArray(messages) ? messages : [];
  let total = REQUEST_OVERHEAD;
  for (const message of list) total += messageTokens(message, imageTokens);
  return total;
}

function promptTokens(body: Record<string, unknown>, env: NodeJS.ProcessEnv): number {
  if (Array.isArray(body.messages)) return estimateMessagesTokens(body.messages, env);
  if (typeof body.prompt === "string") {
    return estimateTextTokens(body.prompt) + REQUEST_OVERHEAD;
  }
  if (Array.isArray(body.prompt)) {
    return estimateMessagesTokens(body.prompt, env);
  }
  return 0;
}

export function estimateRequest(
  body: unknown,
  env: NodeJS.ProcessEnv = process.env
): RequestEstimate {
  const completionTokens =
    positiveInt((body as { max_tokens?: unknown } | null)?.max_tokens) ??
    positiveInt((body as { max_completion_tokens?: unknown } | null)?.max_completion_tokens) ??
    envPositiveInt(env.AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
  }
  const prompt = promptTokens(body as Record<string, unknown>, env);
  return {
    promptTokens: prompt,
    completionTokens,
    totalTokens: prompt + completionTokens
  };
}
