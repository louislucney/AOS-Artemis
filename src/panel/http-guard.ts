type HeaderValue = string | string[] | undefined;

function headerValue(headers: Record<string, HeaderValue> | undefined, name: string): string {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return String(raw[0] ?? "");
  return typeof raw === "string" ? raw : "";
}

/** 写端点同源校验（CSRF 纵深防御）：自定义头 `x-aos-console: 1` 放行；
 * 有 `Origin` 时要求与 `Host` 一致（拦截老浏览器跨站表单）；
 * 无 `Origin` 时按 `Sec-Fetch-Site`（cross-site 拒绝；same-origin/none/缺省放行——纯 CLI 客户端无该头）。 */
export function sameOriginAllowed(headers: Record<string, HeaderValue> | undefined): boolean {
  if (!headers) return true;
  if (headerValue(headers, "x-aos-console") === "1") return true;
  const site = headerValue(headers, "sec-fetch-site");
  if (site === "cross-site") return false;
  const origin = headerValue(headers, "origin");
  if (origin !== "") {
    const host = headerValue(headers, "host");
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  if (site === "") return true;
  return site === "same-origin" || site === "none";
}

/** 独立进程动作层的 Host 白名单：仅 loopback（127.0.0.1/localhost/[::1]）。 */
export function loopbackHostAllowed(hostHeader: HeaderValue): boolean {
  const host = Array.isArray(hostHeader) ? String(hostHeader[0] ?? "") : String(hostHeader ?? "");
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
