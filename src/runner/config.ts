export type RunnerToken = string & { readonly __brand: "RunnerToken" };
export type HostId = string & { readonly __brand: "HostId" };

/** Runner 侧配置：只包含中心地址、runner token、主机身份。
 * 中心项目路径、provider key 不属于 runner 配置。 */
export interface RunnerConfig {
  centerUrl: URL;
  token: RunnerToken;
  hostId: HostId;
}

export type ParseRunnerConfigResult =
  | { ok: true; config: RunnerConfig }
  | { ok: false; errors: string[] };

export interface ParseRunnerConfigOptions {
  /** 已解析的主机身份（runtime 里 resolveHostIdentity 的结果）；仅当 env 未提供 host id 时使用。 */
  fallbackHostId?: string;
}

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}

function brandToken(value: string): RunnerToken {
  return value as RunnerToken;
}

function brandHost(value: string): HostId {
  return value as HostId;
}

/** 解析 runner 控制面配置。缺项一次性返回全部错误，便于 configure/doctor 直接展示。 */
export function parseRunnerConfig(
  env: NodeJS.ProcessEnv,
  options: ParseRunnerConfigOptions = {}
): ParseRunnerConfigResult {
  const errors: string[] = [];

  const rawUrl = firstEnv(env, [
    "MOBILE_TESTING_RUNNER_CONTROL_URL",
    "AOS_RUNNER_CONTROL_URL"
  ]);
  let centerUrl: URL | null = null;
  if (rawUrl === "") {
    errors.push(
      "未配置 MOBILE_TESTING_RUNNER_CONTROL_URL（旧名 AOS_RUNNER_CONTROL_URL 兼容）"
    );
  } else {
    try {
      centerUrl = new URL(rawUrl);
    } catch {
      errors.push(
        `MOBILE_TESTING_RUNNER_CONTROL_URL 不是有效 URL（需 http(s)）：${rawUrl}`
      );
    }
    if (centerUrl !== null && centerUrl.protocol !== "http:" && centerUrl.protocol !== "https:") {
      errors.push("MOBILE_TESTING_RUNNER_CONTROL_URL 必须是 http(s) URL");
      centerUrl = null;
    }
  }

  const token = firstEnv(env, [
    "MOBILE_TESTING_RUNNER_JOB_TOKEN",
    "AOS_RUNNER_JOB_TOKEN"
  ]);
  if (token === "") {
    errors.push("未配置 MOBILE_TESTING_RUNNER_JOB_TOKEN（旧名 AOS_RUNNER_JOB_TOKEN 兼容）");
  } else if (token.length < 16) {
    errors.push("MOBILE_TESTING_RUNNER_JOB_TOKEN 至少 16 个字符");
  }

  const hostId =
    firstEnv(env, ["MOBILE_TESTING_HOST_ID", "AOS_HOST_ID"]) ||
    (options.fallbackHostId ?? "").trim();
  if (hostId === "") {
    errors.push("未配置 MOBILE_TESTING_HOST_ID（或 AOS_HOST_ID）");
  }

  if (centerUrl === null || token === "" || hostId === "" || errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      centerUrl,
      token: brandToken(token),
      hostId: brandHost(hostId)
    }
  };
}
