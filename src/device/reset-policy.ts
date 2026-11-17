export type ResetPolicy = "fresh" | "app-internal-reset" | "reuse" | "none";

export function parseResetPolicy(value: unknown): ResetPolicy | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "fresh" || raw === "app-internal-reset" || raw === "reuse" || raw === "none"
    ? raw
    : null;
}

/** 项目级复位策略；缺省/非法返回 null，保持旧的“有 URL 用内建复位、否则 reuse”行为。 */
export function resolveResetPolicy(env: NodeJS.ProcessEnv): ResetPolicy | null {
  return parseResetPolicy(env.AOS_RESET_POLICY);
}
