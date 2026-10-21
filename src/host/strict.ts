/** 严格主机模式（`AOS_HOST_STRICT`）：仅字面 `1`/`true` 开启；缺省关闭以兼容升级窗口内的旧 runner。 */
export function hostStrictFrom(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AOS_HOST_STRICT ?? "").trim();
  return raw === "1" || raw === "true";
}
