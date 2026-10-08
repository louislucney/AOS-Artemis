import { loadProject } from "./config/loader.js";
import { createProjectStore } from "./db/index.js";
import { Runtime } from "./runtime.js";

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
