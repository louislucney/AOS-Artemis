import { loadProject } from "./config/loader.js";
import { runnerJobTokenFrom } from "./env-tokens.js";
import { createProjectStore, FileStore, MemoryStore } from "./db/index.js";
import { resolveHostIdentity } from "./host/identity.js";
import { Runtime } from "./runtime.js";
import { SuiteStoreClient } from "./runner/control/suite-client.js";
import { createRunnerFetch } from "./runner/control/tls-fetch.js";
import { runnerHttpTimeoutMs } from "./runner/control/tls-fetch.js";
import { createHybridSuiteStore } from "./runner/control/suite-store.js";

export interface CliRuntimeBundle {
  runtime: Runtime;
  dispose: () => Promise<void>;
}

/** CLI 子命令共用的 Runtime 构建（--project 优先，缺省按 cwd/env 定位）。 */
export async function defaultBuildRuntime(projectDir: string | null): Promise<CliRuntimeBundle> {
  const env = projectDir
    ? { ...process.env, AOS_PROJECT_DIR: projectDir, AOS_CONFIG: "" }
    : process.env;
  const project = loadProject({ env });
  const { store, reason } = await createProjectStore();
  const runtime = new Runtime(project, { store, storeNote: reason });
  await runtime.initialize();
  return {
    runtime,
    dispose: async () => {
      try {
        runtime.proxy.disposeSync();
      } catch {
        /* already gone */
      }
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    }
  };
}


/** suite runner 的控制面运行时：本地 FileStore + 中心 HTTP suite 数据面（不要求中心 PG）。 */
export async function buildRemoteSuiteRuntime(
  projectDir: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<CliRuntimeBundle> {
  const controlUrl = (env.AOS_RUNNER_CONTROL_URL ?? "").trim();
  if (controlUrl === "") throw new Error("AOS_RUNNER_CONTROL_URL 未配置");
  const token = runnerJobTokenFrom(env);
  if (token.length < 16) {
    throw new Error("MOBILE_TESTING_RUNNER_JOB_TOKEN 至少需要 16 个字符");
  }
  const resolvedEnv = projectDir
    ? { ...env, AOS_PROJECT_DIR: projectDir, AOS_CONFIG: "" }
    : env;
  const project = loadProject({ env: resolvedEnv });
  const identity = await resolveHostIdentity({ env: resolvedEnv });
  const panelBaseUrl =
    (env.AOS_PANEL_BASE_URL ?? "").trim() || controlUrl;
  let local;
  try {
    local = await FileStore.create({ env: resolvedEnv });
  } catch {
    local = new MemoryStore();
  }
  const runnerFetch = createRunnerFetch(env);
  const client = new SuiteStoreClient({
    baseUrl: panelBaseUrl,
    token,
    hostId: identity.id,
    timeoutMs: runnerHttpTimeoutMs(env),
    instanceId: (env.AOS_RUNNER_INSTANCE_ID ?? "").trim(),
    ...(runnerFetch === undefined ? {} : { fetchImpl: runnerFetch })
  });
  await client.upsertHost({
    id: identity.id,
    hostname: identity.hostname,
    username: identity.username,
    osPlatform: identity.osPlatform,
    osVersion: identity.osVersion,
    arch: identity.arch,
    kind: identity.kind,
    runnerSeenAt: new Date().toISOString()
  });
  const store = createHybridSuiteStore(local, client);
  const runtime = new Runtime(project, {
    store,
    baseEnv: { ...resolvedEnv, AOS_LEDGER_AUTO_IMPORT: "0" },
    storeNote: `suite runner 控制面：${panelBaseUrl}（本地台账 + 中心 HTTP 数据面）`
  });
  await runtime.initialize();
  return {
    runtime,
    dispose: async () => {
      try {
        runtime.proxy.disposeSync();
      } catch {
        /* already gone */
      }
      try {
        await local.close();
      } catch {
        /* ignore */
      }
    }
  };
}
