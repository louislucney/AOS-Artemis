import { runnerJobTokenFrom } from "../env-tokens.js";
import { resolveHostIdentity } from "../host/identity.js";
import type { ProviderId } from "../config/types.js";
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
  rootPath: string;
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

/** Runner 从中心控制面取 active LLM（仅 AOS_LLM_FROM_CENTER=1 时启用）。
 * key 只在 runner 内存与 Artemis 子进程 env 中使用，不写入本机 .env/台账。 */
export async function fetchCenterLlm(
  options: FetchCenterLlmOptions
): Promise<CenterLlmResult> {
  const env = options.env;
  if ((env.AOS_LLM_FROM_CENTER ?? "").trim() !== "1") {
    return { entry: null, error: null };
  }
  const baseUrl = (
    env.MOBILE_TESTING_RUNNER_CONTROL_URL ??
    env.AOS_RUNNER_CONTROL_URL ??
    ""
  ).trim();
  if (baseUrl === "") {
    return { entry: null, error: "未配置 MOBILE_TESTING_RUNNER_CONTROL_URL" };
  }
  const token = runnerJobTokenFrom(env);
  if (token.length < 16) {
    return {
      entry: null,
      error: "MOBILE_TESTING_RUNNER_JOB_TOKEN 至少需要 16 个字符"
    };
  }
  const hostId =
    options.hostId?.trim() ||
    env.MOBILE_TESTING_HOST_ID?.trim() ||
    env.AOS_HOST_ID?.trim() ||
    (await resolveHostIdentity({ env })).id;
  const centerRoot = (env.AOS_CENTER_PROJECT_ROOT ?? "").trim() || options.rootPath;
  const url = `${baseUrl.replace(/\/+$/, "")}/panel/api/runners/suite/llm?rootPath=${encodeURIComponent(centerRoot)}`;
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
