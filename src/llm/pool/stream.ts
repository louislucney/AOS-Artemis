import type { NormalizedUsage } from "../../db/types.js";
import { normalizeUsage } from "./usage.js";

const MAX_BUFFER_BYTES = 1024 * 1024;

export interface StreamTap {
  push(chunk: Buffer): void;
  end(): void;
  usage(): NormalizedUsage | null;
  outputChars(): number;
  estimatedOutputTokens(): number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function createStreamTap(): StreamTap {
  const decoder = new TextDecoder();
  let buffer = "";
  let captured: NormalizedUsage | null = null;
  let chars = 0;

  const consume = (event: Record<string, unknown>): void => {
    if (event.usage !== undefined) {
      const normalized = normalizeUsage(event.usage);
      if (normalized !== null) captured = normalized;
    }
    const message = asRecord(event.message);
    if (message?.usage !== undefined) {
      const normalized = normalizeUsage(message.usage);
      if (normalized !== null) captured = normalized;
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const first = asRecord(choices[0]);
    const delta = asRecord(first?.delta);
    const content = delta?.content ?? first?.text;
    if (typeof content === "string") chars += content.length;
    if (event.type === "content_block_delta") {
      const anthropicDelta = asRecord(event.delta);
      if (typeof anthropicDelta?.text === "string") chars += anthropicDelta.text.length;
    }
  };

  const line = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    try {
      const parsed = asRecord(JSON.parse(data) as unknown);
      if (parsed !== null) consume(parsed);
    } catch {
      /* keep streaming on malformed events */
    }
  };

  return {
    push(chunk: Buffer): void {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_BUFFER_BYTES) buffer = buffer.slice(-MAX_BUFFER_BYTES);
    },
    end(): void {
      buffer += decoder.decode();
      if (buffer !== "") line(buffer);
      buffer = "";
    },
    usage: () => captured,
    outputChars: () => chars,
    estimatedOutputTokens: () => Math.ceil(chars / 3)
  };
}
