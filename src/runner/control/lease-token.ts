import { createHmac, timingSafeEqual } from "node:crypto";

import { runnerJobTokenFrom } from "../../env-tokens.js";
import { runnerHostTokenFor } from "./auth.js";

/** 租约令牌密钥：每主机 token 优先，其次全局 runner token。 */
function leaseSecret(env: NodeJS.ProcessEnv, hostId: string): string {
  return (
    runnerHostTokenFor(env, hostId) ??
    (runnerJobTokenFrom(env) || "aos-local-lease")
  );
}

/** 设备租约令牌 = HMAC(runnerToken, hostId|taskId|serial)，不新增数据库列。 */
export function leaseTokenFor(
  env: NodeJS.ProcessEnv,
  hostId: string,
  taskId: string,
  serial: string
): string {
  const secret = leaseSecret(env, hostId);
  return createHmac("sha256", secret)
    .update(`${hostId}\n${taskId}\n${serial}`)
    .digest("hex");
}

export function leaseTokenMatches(
  env: NodeJS.ProcessEnv,
  hostId: string,
  taskId: string,
  serial: string,
  provided: string
): boolean {
  if (provided.trim() === "") return false;
  try {
    const expected = Buffer.from(leaseTokenFor(env, hostId, taskId, serial), "hex");
    const actual = Buffer.from(provided.trim(), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
