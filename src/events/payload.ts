import { createHash } from "node:crypto";

/** Stable JSON for payload hashing: recursive key sorting, arrays preserved,
 * `undefined` object values ignored, top-level undefined → "null". */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(Buffer.from(stableStringify(payload), "utf-8")).digest("hex");
}

export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(stableStringify(payload), "utf-8");
}

/** Parse a client `since` value and normalize to UTC milliseconds + Z. */
export function normalizeSince(value: string): string | null {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}
