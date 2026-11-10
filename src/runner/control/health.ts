export interface CenterHealthResult {
  ok: boolean;
  url: string;
  service?: string;
  version?: string;
  error?: string;
}

/** 中心健康检查：runner/doctor 用来区分“网络不通”和“鉴权/业务失败”。 */
export async function checkCenterHealth(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CenterHealthResult> {
  const url = `${input.baseUrl.trim().replace(/\/+$/, "")}/healthz`;
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000)
    });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? `（${error.cause.message}）`
        : "";
    return {
      ok: false,
      url,
      error: `${error instanceof Error ? error.message : String(error)}${cause}`
    };
  }
  if (!response.ok) {
    return { ok: false, url, error: `HTTP ${response.status}` };
  }
  let payload: { ok?: unknown; service?: unknown; version?: unknown };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, url, error: "healthz 返回非 JSON" };
  }
  if (payload.ok !== true) {
    return { ok: false, url, error: "healthz 返回 ok!=true" };
  }
  return {
    ok: true,
    url,
    ...(typeof payload.service === "string" ? { service: payload.service } : {}),
    ...(typeof payload.version === "string" ? { version: payload.version } : {})
  };
}
