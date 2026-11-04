import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import type { IosUiNode } from "../device/ios.js";
import { redactText, resolvePlaceholders, type SecretEntry } from "../web/llm/secrets.js";

export interface IosRedactionConfig {
  secrets: SecretEntry[];
  /** true：无法定位 bbox 的敏感节点直接丢弃截图；false：保留中心侧证据但不发给模型。 */
  strict: boolean;
}

export interface IosRedactionResult {
  nodes: IosUiNode[];
  changed: boolean;
  sensitive: boolean;
  missingBounds: boolean;
}

export interface IosScreenshotMaskResult {
  /** null＝无法安全遮罩（存在敏感节点但缺 bbox / PNG 解码失败）。 */
  bytes: Buffer | null;
  sensitive: boolean;
  missingBounds: boolean;
}

/** 读取中心 worker 写入的项目级 secret map；失败返回空，不阻断（strict 由调用方处理）。 */
export function loadIosSecrets(rootPath: string): SecretEntry[] {
  const file = path.join(rootPath, ".artemis", "web", "llm-secrets.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string" && value.trim() !== "")
      .map(([alias, value]) => ({ alias, value: String(value), kind: "other" }));
  } catch {
    return [];
  }
}

export function iosRedactionConfig(rootPath: string): IosRedactionConfig | null {
  const secrets = loadIosSecrets(rootPath);
  if (secrets.length === 0) return null;
  const strict = !/^(0|false|no)$/i.test((process.env.AOS_IOS_REDACTION_STRICT ?? "").trim());
  return { secrets, strict };
}

function nodeText(node: IosUiNode): string {
  return [node.label, node.value, node.id].filter((part) => part.trim() !== "").join(" ");
}

function hasBounds(node: IosUiNode): boolean {
  return (
    Number.isFinite(node.rect.x) &&
    Number.isFinite(node.rect.y) &&
    Number.isFinite(node.rect.width) &&
    Number.isFinite(node.rect.height) &&
    node.rect.width > 0 &&
    node.rect.height > 0
  );
}

function isSensitiveNode(node: IosUiNode, secrets: SecretEntry[]): boolean {
  const text = nodeText(node);
  if (text.trim() === "") return false;
  const redacted = redactText(text, secrets);
  return redacted.hits > 0 || redacted.unbound.length > 0;
}

export function redactIosNodes(
  nodes: IosUiNode[],
  secrets: SecretEntry[]
): IosRedactionResult {
  let changed = false;
  let sensitive = false;
  let missingBounds = false;
  const out = nodes.map((node) => {
    if (!isSensitiveNode(node, secrets)) return { ...node };
    sensitive = true;
    if (!hasBounds(node)) missingBounds = true;
    changed = true;
    return {
      ...node,
      label: redactText(node.label, secrets).text,
      value: redactText(node.value, secrets).text,
      id: redactText(node.id, secrets).text
    };
  });
  return { nodes: out, changed, sensitive, missingBounds };
}

/** 截图 PNG 按敏感节点 bbox 遮罩；返回 null 表示无法安全遮罩（调用方不得把原图发给模型）。 */
export function maskIosScreenshot(
  pngBytes: Buffer,
  nodes: IosUiNode[],
  secrets: SecretEntry[]
): IosScreenshotMaskResult {
  let sensitive = false;
  let missingBounds = false;
  for (const node of nodes) {
    if (!isSensitiveNode(node, secrets)) continue;
    sensitive = true;
    if (!hasBounds(node)) missingBounds = true;
  }
  if (!sensitive) return { bytes: pngBytes, sensitive: false, missingBounds: false };
  if (missingBounds) return { bytes: null, sensitive: true, missingBounds: true };
  let image: PNG;
  try {
    image = PNG.sync.read(pngBytes);
  } catch {
    return { bytes: null, sensitive: true, missingBounds: false };
  }
  for (const node of nodes) {
    if (!isSensitiveNode(node, secrets)) continue;
    const x1 = Math.max(0, Math.floor(node.rect.x));
    const y1 = Math.max(0, Math.floor(node.rect.y));
    const x2 = Math.min(image.width, Math.ceil(node.rect.x + node.rect.width));
    const y2 = Math.min(image.height, Math.ceil(node.rect.y + node.rect.height));
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {
        const index = (image.width * y + x) << 2;
        image.data[index] = 0;
        image.data[index + 1] = 0;
        image.data[index + 2] = 0;
        image.data[index + 3] = 255;
      }
    }
  }
  return { bytes: PNG.sync.write(image), sensitive: true, missingBounds: false };
}

export interface RedactedShot {
  /** 中心侧证据；strict 且无法遮罩时为 null（文件已删除）。 */
  shot: { rel: string; bytes: Buffer } | null;
  /** 允许发给模型的图片；无法安全遮罩时为 null。 */
  promptBytes: Buffer | null;
  warning: string | null;
}

export function redactIosShot(input: {
  runDir: string;
  shot: { rel: string; bytes: Buffer } | null;
  nodes: IosUiNode[];
  config: IosRedactionConfig | null;
}): RedactedShot {
  if (input.shot === null) return { shot: null, promptBytes: null, warning: null };
  if (input.config === null || input.config.secrets.length === 0) {
    return { shot: input.shot, promptBytes: input.shot.bytes, warning: null };
  }
  const masked = maskIosScreenshot(input.shot.bytes, input.nodes, input.config.secrets);
  if (masked.bytes !== null) {
    if (masked.sensitive) {
      writeFileSync(path.join(input.runDir, input.shot.rel), masked.bytes);
    }
    return {
      shot: masked.sensitive ? { rel: input.shot.rel, bytes: masked.bytes } : input.shot,
      promptBytes: masked.bytes,
      warning: null
    };
  }
  if (input.config.strict) {
    rmSync(path.join(input.runDir, input.shot.rel), { force: true });
    return { shot: null, promptBytes: null, warning: "ios-redaction-unavailable" };
  }
  return {
    shot: input.shot,
    promptBytes: null,
    warning: "ios-redaction-evidence-retained"
  };
}

/** 深拷贝并脱敏所有字符串（run/status 落盘与内存证据共用）。 */
export function redactIosValue<T>(value: T, secrets: SecretEntry[]): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactText(value, secrets).text as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactIosValue(item, secrets)) as T;
  }
  if (value !== null && typeof value === "object") {
    if (Buffer.isBuffer(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactIosValue(item, secrets);
    }
    return out as T;
  }
  return value;
}

export function resolveIosInput(text: string, secrets: SecretEntry[]): string {
  return resolvePlaceholders(text, secrets);
}
