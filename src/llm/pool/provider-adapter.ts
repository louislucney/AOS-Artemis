export interface ProviderTarget {
  provider: string;
  model: string;
  baseUrl: string | null;
}

/** DeepSeek 目前不接受 response_format.type=json_schema（400 "This response_format
 * type is unavailable now"），但支持 json_object。把 schema 降级为 json_object，
 * 并把原 schema 明确追加到提示词，保留结构化输出的语义。 */
export function rewriteProviderRequest(
  payload: unknown,
  target: ProviderTarget
): { body: unknown; rewritten: boolean } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { body: payload, rewritten: false };
  }
  const record = payload as Record<string, unknown>;
  const format = record.response_format;
  if (
    typeof format !== "object" ||
    format === null ||
    Array.isArray(format) ||
    (format as { type?: unknown }).type !== "json_schema"
  ) {
    return { body: payload, rewritten: false };
  }
  const hint = `${target.provider} ${target.model} ${target.baseUrl ?? ""}`.toLowerCase();
  if (!hint.includes("deepseek")) return { body: payload, rewritten: false };
  const rawSchema = (format as { json_schema?: unknown }).json_schema;
  const schema =
    typeof rawSchema === "object" && rawSchema !== null && "schema" in rawSchema
      ? (rawSchema as { schema?: unknown }).schema
      : rawSchema;
  const instruction =
    schema === undefined
      ? "Return only a JSON object. Do not wrap it in Markdown."
      : `Return only a JSON object that conforms to this JSON schema: ${JSON.stringify(
          schema
        )}. Do not wrap it in Markdown.`;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const last = messages[messages.length - 1];
  if (
    typeof last === "object" &&
    last !== null &&
    (last as { role?: unknown }).role === "user" &&
    typeof (last as { content?: unknown }).content === "string"
  ) {
    (last as { content: string }).content = `${(last as { content: string }).content}\n\n${instruction}`;
  } else {
    messages.push({ role: "user", content: instruction });
  }
  record.messages = messages;
  record.response_format = { type: "json_object" };
  return { body: record, rewritten: true };
}
