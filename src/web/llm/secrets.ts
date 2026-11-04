import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore } from "../../db/types.js";
import { writeFileAtomic } from "../../util.js";

export type SecretKind = "account" | "password" | "token" | "otp" | "other";

export interface SecretEntry {
  alias: string;
  value: string;
  kind: SecretKind;
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

function parseSecretFile(content: string, fallbackAlias: string): SecretEntry[] {
  const trimmed = content.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string" && value.trim() !== "")
        .map(([alias, value]) => ({
          alias,
          value: String(value),
          kind: kindOf(alias)
        }));
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
