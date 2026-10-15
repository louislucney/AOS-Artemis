import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** 仅 `127.0.0.1` / `::1` / `localhost`（大小写不敏感、不做裁剪）视为 loopback；
 * 其余（含空白包裹、`127.0.0.10`、`::ffff:127.0.0.1`、解析到 loopback 的主机名）一律按非 loopback fail-closed。 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** 密钥比较须常时安全：长度不等直接判否（`timingSafeEqual` 要求等长），
 * 等长才进入逐字节比较，避免按内容提前返回造成的时序侧信道。 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
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
 * `options.allowQueryToken` 时另接受 URL `?t=<token>`。比较经 `timingSafeStringEqual`（先长度归一，长度不等直接 false）。 */
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
