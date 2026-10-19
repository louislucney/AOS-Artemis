import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Model-name heuristic for vision-capable chat models (the render channel is
 * checked separately). DeepSeek 的多模态档走稳定别名 `deepseek-flash`
 * （V4.1 Flash 原生多模态，名字不含 vision 标记），按 flash 词干显式命中。
 * Heuristic 只是判定链的一环（声明 → 缓存 → 启发式 → 未知即尝试），
 * 单看它判不出来不再等于不可用。 */
export function isVisionCapableModel(model: string | null | undefined): boolean {
  if (typeof model !== "string" || model.trim() === "") return false;
  const value = model.trim().toLowerCase();
  if (/(^|[-_/.])(vl|vision|4v|omni|multimodal)([-_.0-9]|$)/.test(value)) return true;
  return /gpt-4o|gpt-4\.1|gpt-5|gemini|claude-3|claude-4|claude-5|claude-sonnet|claude-opus|claude-haiku|pixtral|internvl|llava|glm-4v|glm-4\.1v|step-1v|step-2v|doubao[^/]*vision|hunyuan[^/]*vision|kimi[^/]*vision|deepseek[^/\s]*flash/.test(
    value
  );
}

/** 项目声明（`AOS_LLM_VISION`，active 模型能力）：1/true/yes 有视觉、0/false/no 无视觉、其余交给自动判定。 */
export function parseDeclaredVision(env: NodeJS.ProcessEnv): boolean | null {
  const raw = (env.AOS_LLM_VISION ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return null;
}

/** 探测结论缓存有效期（`AOS_VISION_CACHE_DAYS`，默认 7 天；0 关闭缓存＝每次都探测）。 */
export function visionCacheTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = (env.AOS_VISION_CACHE_DAYS ?? "").trim();
  const days = raw === "" ? 7 : Number(raw);
  if (!Number.isFinite(days) || days < 0) return 7 * DAY_MS;
  return days * DAY_MS;
}

export function visionCapabilityKey(baseUrl: string | null | undefined, model: string | null | undefined): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return `${base}|${(model ?? "").trim().toLowerCase()}`;
}

export interface CachedVisionVerdict {
  vision: boolean;
  checkedAt: string;
}

export interface VisionCapabilityCache {
  get(key: string): CachedVisionVerdict | null;
  set(key: string, vision: boolean, at?: Date): void;
}

interface CacheFileShape {
  version: 1;
  entries: Record<string, CachedVisionVerdict>;
}

function readCacheEntries(filePath: string): Record<string, CachedVisionVerdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== "object") return {};
  const out: Record<string, CachedVisionVerdict> = {};
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const record = value as { vision?: unknown; checkedAt?: unknown } | null;
    if (typeof record?.vision === "boolean" && typeof record?.checkedAt === "string") {
      out[key] = { vision: record.vision, checkedAt: record.checkedAt };
    }
  }
  return out;
}

/** 探测结论缓存（派生数据，损坏即当没有；写失败不影响主流程）。 */
export function openVisionCapabilityCache(filePath: string): VisionCapabilityCache {
  const entries = readCacheEntries(filePath);
  return {
    get: (key) => entries[key] ?? null,
    set: (key, vision, at = new Date()) => {
      const verdict: CachedVisionVerdict = { vision, checkedAt: at.toISOString() };
      const payload: CacheFileShape = { version: 1, entries: { ...entries, [key]: verdict } };
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileAtomic(filePath, JSON.stringify(payload, null, 2));
      } catch {
        return;
      }
      entries[key] = verdict;
    }
  };
}

export type VisionCapabilitySource = "declared" | "cache" | "heuristic" | "unknown";

export interface VisionCapabilityResolution {
  capable: boolean | "unknown";
  source: VisionCapabilitySource;
}

/** 判定链：声明（权威）→ 新鲜缓存 → 名字启发式 → 未知（由调用方决定是否 fail-open 尝试）。 */
export function resolveVisionCapability(input: {
  model: string | null | undefined;
  baseUrl?: string | null;
  declared?: boolean | null;
  cached?: CachedVisionVerdict | null;
  now?: Date;
  ttlMs?: number;
}): VisionCapabilityResolution {
  const declared = input.declared ?? null;
  if (declared !== null) return { capable: declared, source: "declared" };
  const ttlMs = input.ttlMs ?? 7 * DAY_MS;
  if (input.cached && ttlMs > 0) {
    const age = (input.now ?? new Date()).getTime() - Date.parse(input.cached.checkedAt);
    if (Number.isFinite(age) && age >= 0 && age <= ttlMs) {
      return { capable: input.cached.vision, source: "cache" };
    }
  }
  if (isVisionCapableModel(input.model)) return { capable: true, source: "heuristic" };
  return { capable: "unknown", source: "unknown" };
}

const REJECTION_SUBJECT = /(image|vision|multimodal|图片|图像)/i;
const REJECTION_REASON =
  /(n['’`]t\s+support|not\s+support|unsupported|only\s+support|only\s+supported|仅支持|不支持)/i;

/** 只认「模型不接受图片输入」这一类错误（400/415/422 + 明确措辞）；
 * 其余失败（鉴权/网络/服务端/格式）都不是能力结论，不能写死模型。 */
export function classifyModalityRejection(error: unknown): string | null {
  const record = error as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (!record || typeof record !== "object") return null;
  const status = typeof record.status === "number" ? record.status : null;
  if (status !== 400 && status !== 415 && status !== 422) return null;
  const text = [record.message, record.body]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  if (!REJECTION_SUBJECT.test(text) || !REJECTION_REASON.test(text)) return null;
  return text.trim().slice(0, 200);
}
