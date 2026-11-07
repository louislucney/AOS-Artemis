import type { ProviderId } from "../config/types.js";
import { parseRunnerConfig } from "../runner/config.js";
import type { LlmEntry } from "./registry.js";

export interface CenterLlmEntry {
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

export interface CenterLlmResult {
  entry: LlmEntry | null;
  error: string | null;
}

export interface FetchCenterLlmOptions {
  env: NodeJS.ProcessEnv;
  /** 已解析的主机身份；env 未提供 host id 时作为回退。 */
  hostId?: string | null;
  fetchImpl?: typeof fetch;
}

const PROVIDERS = new Set<ProviderId>([
  "google",
  "openai",
  "custom",
  "anthropic",
  "openrouter",
  "xai"
]);

function providerOf(value: string): ProviderId {
  return PROVIDERS.has(value as ProviderId) ? (value as ProviderId) : "custom";
}

/** Runner 从中心控制面取 LLM 代理访问方式（仅 AOS_LLM_FROM_CENTER=1 时启用）。
 * 返回中心代理 URL；runner 用 runner token 调用，真实 provider key 不出中心。 */
export async function fetchCenterLlm(
  options: FetchCenterLlmOptions
): Promise<CenterLlmResult> {
  const env = options.env;
  if ((env.AOS_LLM_FROM_CENTER ?? "").trim() !== "1") {
    return { entry: null, error: null };
  }
  const parsed = parseRunnerConfig(
    env,
    options.hostId?.trim() ? { fallbackHostId: options.hostId.trim() } : {}
  );
  if (!parsed.ok) {
    return { entry: null, error: parsed.errors.join("；") };
  }
  const baseUrl = parsed.config.centerUrl.href.replace(/\/+$/, "");
  const token = parsed.config.token;
  const hostId = parsed.config.hostId;
  const url = `${baseUrl}/panel/api/runners/suite/llm`;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "x-aos-host-id": hostId
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    return {
      entry: null,
      error: `中心 LLM 请求失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!response.ok) {
    return { entry: null, error: `中心 LLM 请求失败：HTTP ${response.status}` };
  }
  let payload: {
    ok?: unknown;
    value?: { found?: unknown; entry?: unknown };
    error?: unknown;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { entry: null, error: "中心 LLM 返回非 JSON" };
  }
  if (payload.ok !== true) {
    const detail = typeof payload.error === "string" ? payload.error : "未知错误";
    return { entry: null, error: `中心 LLM 返回失败：${detail}` };
  }
  const value = payload.value;
  if (value?.found !== true) {
    return { entry: null, error: "中心未配置 active LLM 条目" };
  }
  const raw = value.entry;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { entry: null, error: "中心 LLM 条目格式无效" };
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (name === "" || model === "") {
    return { entry: null, error: "中心 LLM 条目缺少 name/model" };
  }
  const baseUrlValue = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const isProxy = baseUrlValue.includes("/panel/api/runners/suite/llm/proxy/");
  return {
    entry: {
      name: `center:${name}`,
      provider: providerOf(typeof record.provider === "string" ? record.provider : "custom"),
      model,
      baseUrl: baseUrlValue === "" ? null : baseUrlValue,
      apiKey: apiKey !== "" ? apiKey : isProxy ? token : null,
      keyEnvName: null,
      fallback: null,
      nodeOverrides: null,
      source: "store",
      isActive: true
    },
    error: null
  };
}
