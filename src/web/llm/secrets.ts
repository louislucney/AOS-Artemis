import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore } from "../../db/types.js";
import { writeFileAtomic } from "../../util.js";

export type SecretKind = "account" | "password" | "token" | "otp" | "other";

export type SecretTargetKind =
  | "resource-id"
  | "view-tag"
  | "content-desc"
  | "semantics-label"
  | "text"
  | "point";

export interface SecretFieldTarget {
  kind: SecretTargetKind;
  value: string;
}

export interface SecretEntry {
  alias: string;
  value: string;
  kind: SecretKind;
  /** 可选：确定性填写目标（native type + secretRef 未显式给 target 时使用）。 */
  target?: SecretFieldTarget;
  fallbackTargets?: SecretFieldTarget[];
  /** 可选：填写前要求当前屏幕/页面出现该文本（设计/IA 校对）。 */
  screen?: string;
  /** 可选：字段的人类标签（仅展示/审计，不参与定位）。 */
  label?: string;
}

export interface RedactResult {
  text: string;
  hits: number;
  unbound: string[];
}

const ACCOUNT_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\+?\d[\d\s-]{6,}\d/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
];

function kindOf(alias: string): SecretKind {
  const lower = alias.toLowerCase();
  if (/pass|pwd|密码/.test(lower)) return "password";
  if (/otp|验证码|code/.test(lower)) return "otp";
  if (/token|key|secret/.test(lower)) return "token";
  if (/account|user|email|phone|账号|邮箱|手机/.test(lower)) return "account";
  return "other";
}

export function parseSecretContent(content: string, fallbackAlias: string): SecretEntry[] {
  return parseSecretFile(content, fallbackAlias);
}

const SECRET_TARGET_KINDS = new Set<SecretTargetKind>([
  "resource-id",
  "view-tag",
  "content-desc",
  "semantics-label",
  "text",
  "point"
]);

function secretTargetOf(value: unknown): SecretFieldTarget | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { kind?: unknown; value?: unknown };
  if (typeof record.kind !== "string" || !SECRET_TARGET_KINDS.has(record.kind as SecretTargetKind)) {
    return undefined;
  }
  if (typeof record.value !== "string" || record.value.trim() === "") return undefined;
  return { kind: record.kind as SecretTargetKind, value: record.value.trim() };
}

function secretKindOf(value: unknown, alias: string): SecretKind {
  if (
    value === "account" ||
    value === "password" ||
    value === "token" ||
    value === "otp" ||
    value === "other"
  ) {
    return value;
  }
  return kindOf(alias);
}

function parseSecretEntry(alias: string, raw: unknown): SecretEntry | null {
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    return { alias, value: raw, kind: kindOf(alias) };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as {
    value?: unknown;
    kind?: unknown;
    target?: unknown;
    fallbackTargets?: unknown;
    screen?: unknown;
    label?: unknown;
  };
  if (typeof record.value !== "string" || record.value.trim() === "") return null;
  const entry: SecretEntry = {
    alias,
    value: record.value,
    kind: secretKindOf(record.kind, alias)
  };
  const target = secretTargetOf(record.target);
  if (target !== undefined) entry.target = target;
  if (Array.isArray(record.fallbackTargets)) {
    const fallbackTargets = record.fallbackTargets
      .map(secretTargetOf)
      .filter((value): value is SecretFieldTarget => value !== undefined);
    if (fallbackTargets.length > 0) entry.fallbackTargets = fallbackTargets;
  }
  if (typeof record.screen === "string" && record.screen.trim() !== "") {
    entry.screen = record.screen.trim();
  }
  if (typeof record.label === "string" && record.label.trim() !== "") {
    entry.label = record.label.trim();
  }
  return entry;
}

function parseSecretFile(content: string, fallbackAlias: string): SecretEntry[] {
  const trimmed = content.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries: SecretEntry[] = [];
      for (const [alias, raw] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = parseSecretEntry(alias, raw);
        if (entry !== null) entries.push(entry);
      }
      if (entries.length > 0) return entries;
    }
  } catch {
    /* fall through to key=value */
  }
  const out: SecretEntry[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const alias = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (alias !== "" && value !== "") out.push({ alias, value, kind: kindOf(alias) });
  }
  return out.length > 0
    ? out
    : [{ alias: fallbackAlias, value: trimmed, kind: kindOf(fallbackAlias) }];
}

/** materials secret + AOS_WEB_SECRET_* 组成项目级 secret inventory。 */
export async function loadWebSecrets(input: {
  store: ProjectStore;
  rootPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SecretEntry[]> {
  const out: SecretEntry[] = [];
  const assets = await input.store
    .listWebAssets(input.rootPath, "materials")
    .catch(() => []);
  for (const asset of assets) {
    if (asset.metadata?.secret !== true) continue;
    try {
      const content = await readFile(asset.storagePath, "utf8");
      const alias = path.basename(asset.filename, path.extname(asset.filename));
      out.push(...parseSecretFile(content, alias));
    } catch {
      /* 读不到 secret 文件：不阻断其它 secret，调用方按 unbound 处理 */
    }
  }
  for (const [key, value] of Object.entries(input.env ?? process.env)) {
    if (!key.startsWith("AOS_WEB_SECRET_") || typeof value !== "string" || value.trim() === "") {
      continue;
    }
    const alias = key.slice("AOS_WEB_SECRET_".length).toLowerCase();
    out.push({ alias, value, kind: kindOf(alias) });
  }
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = `${entry.alias}\u0000${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 写入 ARTEMIS hook 读取的 0600 secret map；只写 alias→value，不写日志。 */
export async function writeWebSecretFile(input: {
  rootPath: string;
  secrets: SecretEntry[];
}): Promise<string> {
  const dir = path.join(input.rootPath, ".artemis", "web");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "llm-secrets.json");
  const payload: Record<string, string> = {};
  for (const entry of input.secrets) payload[entry.alias] = entry.value;
  await writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
  await chmod(file, 0o600);
  await chmod(dir, 0o700);
  return file;
}

/** 精确值 + account-like 模式脱敏；unbound 非空时必须拒绝发给 LLM。 */
export function redactText(text: string, secrets: SecretEntry[]): RedactResult {
  let output = text;
  let hits = 0;
  const ordered = [...secrets].sort((left, right) => right.value.length - left.value.length);
  for (const secret of ordered) {
    if (secret.value.length < 3) continue;
    const escaped = secret.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "g");
    const matches = output.match(pattern);
    if (matches === null) continue;
    hits += matches.length;
    output = output.replace(pattern, `<secret:${secret.alias}>`);
  }
  const unbound: string[] = [];
  for (const pattern of ACCOUNT_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const value = (match[0] ?? "").trim();
      if (value !== "" && !unbound.includes(value)) unbound.push(value);
    }
  }
  for (const pattern of ACCOUNT_PATTERNS) {
    output = output.replace(pattern, (match) => {
      hits += 1;
      return `<redacted:${match.includes("@") ? "email" : match.startsWith("eyJ") ? "token" : "account"}>`;
    });
  }
  return { text: output, hits, unbound };
}

/** 只允许执行动作时使用；输入字符串中的 `<secret:alias>` 替换为真值。 */
export function resolvePlaceholders(text: string, secrets: SecretEntry[]): string {
  let output = text;
  for (const secret of secrets) {
    output = output.replaceAll(`<secret:${secret.alias}>`, secret.value);
  }
  return output;
}
