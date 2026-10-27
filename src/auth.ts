import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PanelRole } from "./panel/roles.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const PANEL_ROLES: PanelRole[] = ["viewer", "dispatcher", "maintainer", "admin"];

export interface AuthUser {
  name: string;
  token: string;
  role: PanelRole;
}

export interface AuthIdentity {
  name: string;
  role: PanelRole;
  source: "static" | "user" | "anonymous";
}

/** 文件存储用户：只保留令牌 SHA-256，不落明文。 */
export interface StoredAuthUser {
  name: string;
  role: PanelRole;
  tokenSha256: string;
  disabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `AOS_HTTP_USERS` JSON：`[{name, token, role}]`；只接受强令牌（≥16 字符），
 * 名字/令牌重复或字段非法一律整批拒绝（fail closed）。 */
export function parseAuthUsers(raw: string | undefined): {
  users: AuthUser[];
  errors: string[];
} {
  const users: AuthUser[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw.trim() === "") return { users, errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      users,
      errors: [`AOS_HTTP_USERS 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`]
    };
  }
  if (!Array.isArray(parsed)) return { users, errors: ["AOS_HTTP_USERS 必须是数组"] };
  const names = new Set<string>();
  const tokens = new Set<string>();
  parsed.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`AOS_HTTP_USERS[${index}] 不是对象`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const token = typeof record.token === "string" ? record.token.trim() : "";
    const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
    if (name === "") errors.push(`AOS_HTTP_USERS[${index}] 缺 name`);
    if (token.length < 16) errors.push(`AOS_HTTP_USERS[${index}] token 至少 16 字符`);
    if (!PANEL_ROLES.includes(role as PanelRole)) {
      errors.push(`AOS_HTTP_USERS[${index}] role 必须是 viewer/dispatcher/maintainer/admin`);
    }
    if (name !== "" && names.has(name)) errors.push(`AOS_HTTP_USERS 名字重复：${name}`);
    if (token !== "" && tokens.has(token)) errors.push(`AOS_HTTP_USERS 令牌重复（用户 ${name}）`);
    names.add(name);
    tokens.add(token);
    if (name !== "" && token.length >= 16 && PANEL_ROLES.includes(role as PanelRole)) {
      users.push({ name, token, role: role as PanelRole });
    }
  });
  return { users, errors };
}

function authorizationSecret(authorization: string | undefined): string | null {
  const header = (authorization ?? "").trim();
  const match = /^([A-Za-z]+)[ \t]+(.+)$/.exec(header);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const value = match[2].trim();
  if (scheme === "bearer") return value;
  if (scheme === "basic") return decodeBasicPassword(value);
  return null;
}

function matchAuthorizationHash(authorization: string | undefined, tokenSha256: string): boolean {
  const secret = authorizationSecret(authorization);
  return secret !== null && timingSafeStringEqual(hashAuthToken(secret), tokenSha256);
}

/** 请求身份解析：静态 token → fallbackRole；用户 token → 其 role；未启用认证 → anonymous。
 * 启用认证（含闩锁）但无匹配 → null（调用方 401）。 */
export function resolveRequestIdentity(input: {
  authorization: string | undefined;
  staticToken: string;
  users: AuthUser[];
  hashedUsers?: StoredAuthUser[];
  fallbackRole: PanelRole;
  staticActor?: string | null;
  /** 已启用认证的进程级闩锁：运行期清空用户后仍要求认证，直到重启。 */
  authRequired?: boolean;
}): AuthIdentity | null {
  const hashedUsers = input.hashedUsers ?? [];
  const hashed = hashedUsers.filter((user) => user.disabled !== true);
  const enabled =
    input.authRequired === true ||
    input.staticToken !== "" ||
    input.users.length > 0 ||
    hashedUsers.length > 0;
  if (!enabled) {
    return {
      name: input.staticActor?.trim() || "anonymous",
      role: input.fallbackRole,
      source: "anonymous"
    };
  }
  if (input.staticToken !== "" && matchAuthorization(input.authorization, input.staticToken)) {
    return {
      name: input.staticActor?.trim() || "static",
      role: input.fallbackRole,
      source: "static"
    };
  }
  for (const user of input.users) {
    if (matchAuthorization(input.authorization, user.token)) {
      return { name: user.name, role: user.role, source: "user" };
    }
  }
  for (const user of hashed) {
    if (matchAuthorizationHash(input.authorization, user.tokenSha256)) {
      return { name: user.name, role: user.role, source: "user" };
    }
  }
  return null;
}

/** 仅 `127.0.0.1` / `::1` / `localhost`（大小写不敏感、不做裁剪）视为 loopback；
 * 其余（含空白包裹、`127.0.0.10`、`::ffff:127.0.0.1`、解析到 loopback 的主机名）一律按非 loopback fail-closed。 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** 密钥比较须常时安全：两侧先经 sha256 摘要为固定长度，
 * 再 `timingSafeEqual` 逐字节比较，消除长度分支与按内容提前返回造成的时序侧信道。 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function decodeBasicPassword(value: string): string | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator < 0 ? null : decoded.slice(separator + 1);
}

function matchAuthorization(authorization: string | undefined, token: string): boolean {
  const header = (authorization ?? "").trim();
  const match = /^([A-Za-z]+)[ \t]+(.+)$/.exec(header);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  const value = match[2].trim();
  if (scheme === "bearer") return timingSafeStringEqual(value, token);
  if (scheme === "basic") {
    const password = decodeBasicPassword(value);
    return password !== null && timingSafeStringEqual(password, token);
  }
  return false;
}

/** 带凭据判定：`Authorization: Bearer <t>` / `Authorization: Basic <base64(user:pass)>`（密码＝token，用户名任意/空）；
 * `options.allowQueryToken` 时另接受 URL `?t=<token>`。比较经 `timingSafeStringEqual`（sha256 摘要固定长度比较，消除长度侧信道）。 */
export function authorizeRequest(input: {
  authorization: string | undefined;
  queryToken?: string | null;
  token: string;
  allowQueryToken?: boolean;
}): boolean {
  const { authorization, queryToken, token, allowQueryToken = false } = input;
  if (token.length === 0) return false;
  if (matchAuthorization(authorization, token)) return true;
  if (allowQueryToken && typeof queryToken === "string" && timingSafeStringEqual(queryToken, token)) return true;
  return false;
}

/** 401 响应三件套（含 `WWW-Authenticate: Basic realm="<realm>"` 触发浏览器弹窗）。 */
export function unauthorizedResponse(realm: string): {
  status: 401;
  headers: Record<string, string>;
  body: string;
} {
  return {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Basic realm="${realm}"`
    },
    body: JSON.stringify({ error: "unauthorized" })
  };
}
