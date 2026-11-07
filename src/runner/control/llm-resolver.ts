import type { ProjectStore } from "../../db/types.js";
import { loadProject } from "../../config/loader.js";
import { scanProjectEnv } from "../../projects/scan.js";
import { RunnerControlError } from "./errors.js";

export interface ResolvedCenterLlm {
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

/** 中心项目 active LLM：store 条目优先，key/baseUrl 缺失时回退项目 .env。 */
export async function resolveCenterLlm(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  rootPath: string
): Promise<ResolvedCenterLlm | null> {
  let scanLlm: ReturnType<typeof scanProjectEnv>["llm"] = null;
  try {
    const loaded = loadProject({
      env: { ...env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" }
    });
    scanLlm = scanProjectEnv(loaded.resolver).llm;
  } catch {
    scanLlm = null;
  }
  const entries = await store.listLlms(rootPath);
  const active =
    entries.find((entry) => entry.isActive && entry.apiKey) ??
    entries.find((entry) => entry.isActive) ??
    entries.find((entry) => entry.apiKey) ??
    entries[0] ??
    null;
  if (active !== null) {
    return {
      name: active.name,
      provider: active.provider,
      model: active.model,
      baseUrl: active.baseUrl ?? scanLlm?.baseUrl ?? null,
      apiKey: active.apiKey ?? scanLlm?.apiKey ?? null
    };
  }
  if (scanLlm?.complete === true && scanLlm.model) {
    return {
      name: scanLlm.name,
      provider: "custom",
      model: scanLlm.model,
      baseUrl: scanLlm.baseUrl,
      apiKey: scanLlm.apiKey
    };
  }
  return null;
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
