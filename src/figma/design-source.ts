import fs from "node:fs";
import path from "node:path";

import type { DesignRuntimeLike } from "./design-runtime.js";

/** 同机双端共享设计源（R3）：优先进程 env，其次项目 .env，最后 aos.config.jsonc。
 * 明确只用于同机工作区；跨主机不共享磁盘，仍用 suite parity/Git 同步。 */
export function sharedDesignDir(
  runtime: Pick<DesignRuntimeLike, "configDirAbs" | "project">,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const configured =
    env.AOS_SHARED_DESIGN_DIR?.trim() ||
    runtime.project.dotenvValues?.AOS_SHARED_DESIGN_DIR?.trim() ||
    runtime.project.config?.design?.sharedDir?.trim() ||
    "";
  if (configured === "") return null;
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(runtime.project.rootDir, configured);
}

/** 读取 flows 的有效路径：共享 flows 存在时用共享，否则回退项目本地。 */
export function designFlowsPath(
  runtime: Pick<DesignRuntimeLike, "configDirAbs" | "project">,
  env: NodeJS.ProcessEnv = process.env
): string {
  const shared = sharedDesignDir(runtime, env);
  if (shared !== null) {
    const candidate = path.join(shared, "flows.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(runtime.configDirAbs, "design", "flows.json");
}

