import type { ChatTarget } from "../llm/chat.js";
import { entryIssues, type LlmEntry } from "../llm/registry.js";

export interface VisionTarget {
  chat: ChatTarget;
  model: string;
  source: "entry" | "env" | "active";
}

const VISION_NAME_PATTERN = /(vision|multimodal|gpt-4o|gpt-4\.1|gemini|claude-3|claude-4|qwen[\w.-]*-vl|-vl\b|vl-)/i;

export function looksVisionCapable(model: string): boolean {
  return VISION_NAME_PATTERN.test(model);
}

/** Resolve the dedicated vision model for the iOS runner: an explicitly named
 * registry entry (AOS_IOS_VISION_LLM) wins, then an env model override
 * (AOS_IOS_VISION_MODEL with optional BASE_URL/API_KEY), then the active entry
 * itself when its model name suggests multimodal support. */
export function resolveVisionTarget(
  env: NodeJS.ProcessEnv,
  entries: LlmEntry[],
  active: LlmEntry | null
): VisionTarget | null {
  const entryName = env.AOS_IOS_VISION_LLM?.trim();
  if (entryName) {
    const entry = entries.find((item) => item.name === entryName);
    if (entry && entryIssues(entry).length === 0 && entry.apiKey && entry.baseUrl) {
      return {
        chat: { baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model },
        model: entry.model,
        source: "entry"
      };
    }
    return null;
  }

  const model = env.AOS_IOS_VISION_MODEL?.trim();
  if (model) {
    const baseUrl = env.AOS_IOS_VISION_BASE_URL?.trim() || active?.baseUrl || "";
    const apiKey = env.AOS_IOS_VISION_API_KEY?.trim() || active?.apiKey || "";
    if (!baseUrl || !apiKey) return null;
    return { chat: { baseUrl, apiKey, model }, model, source: "env" };
  }

  if (active?.apiKey && active.baseUrl && looksVisionCapable(active.model)) {
    return {
      chat: { baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model },
      model: active.model,
      source: "active"
    };
  }
  return null;
}

export function visionAlwaysEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.AOS_IOS_VISION_ALWAYS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export type IosVisionMode = "auto" | "sparse" | "off";

/** iOS 执行器视觉输入档位（DESIGN §13.45 增补）：
 * auto（默认）= 每步视觉输入（多模态主模型直附图；文本主模型每步视觉感知）；
 * sparse = 文本主模型沿用旧阈值（可见文本 <3 才感知）；
 * off = 纯文本。AOS_IOS_VISION_ALWAYS=1 为旧开关，语义被 auto 覆盖（映射 auto）。 */
export function resolveVisionMode(env: NodeJS.ProcessEnv): IosVisionMode {
  const raw = env.AOS_IOS_VISION_MODE?.trim().toLowerCase();
  if (raw === "sparse" || raw === "off" || raw === "auto") return raw;
  if (visionAlwaysEnabled(env)) return "auto";
  return "auto";
}

export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!(bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG")) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}
