import type { LlmPoolMode, ProjectStore } from "../../db/types.js";
import { resolveCenterLlmCandidates } from "../../llm/pool/resolve.js";
import { RunnerControlError } from "./errors.js";

export { resolveCenterLlmCandidates } from "../../llm/pool/resolve.js";
export type { CenterLlmResolution, PoolCandidate } from "../../llm/pool/resolve.js";

export interface ResolvedCenterLlm {
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  poolTokenId: string | null;
  poolMode: LlmPoolMode;
  poolTokenName: string | null;
  supportsStreamUsage: boolean;
}

/** 中心项目 active LLM：store 条目优先，key/baseUrl 缺失时回退项目 .env；
 * 绑定资源池时按 pinned/auto 展开候选，返回首个候选。 */
export async function resolveCenterLlm(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  rootPath: string
): Promise<ResolvedCenterLlm | null> {
  const resolution = await resolveCenterLlmCandidates(store, env, rootPath);
  const candidate = resolution?.candidates[0];
  if (!resolution || !candidate) return null;
  return {
    name: resolution.entryName,
    provider: candidate.provider,
    model: candidate.model,
    baseUrl: candidate.baseUrl === "" ? null : candidate.baseUrl,
    apiKey: candidate.apiKey === "" ? null : candidate.apiKey,
    poolTokenId: candidate.poolTokenId,
    poolMode: candidate.poolMode,
    poolTokenName: candidate.poolTokenName,
    supportsStreamUsage: candidate.supportsStreamUsage
  };
}

/** LLM 下发/代理的项目 host 校验；跨主机需中心显式 AOS_RUNNER_SHARED_LLM=1。 */
export async function assertLlmProject(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  hostId: string,
  rootPath: string
): Promise<void> {
  const project = await store.getProjectByPath(rootPath);
  if (project === null) {
    throw new RunnerControlError("not-found", `项目未登记：${rootPath}`);
  }
  const shared = (env.AOS_RUNNER_SHARED_LLM ?? "").trim() === "1";
  if (!shared && project.hostId !== null && project.hostId !== hostId) {
    throw new RunnerControlError("forbidden", `项目不属于主机 ${hostId}`);
  }
}
