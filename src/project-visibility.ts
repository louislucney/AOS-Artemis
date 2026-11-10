import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 服务仓库根目录；默认从面板/统计列表隐藏，避免“自己监控自己”。 */
export function serviceRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** 共享的项目可见性过滤：服务仓库默认隐藏；`AOS_PANEL_EXCLUDE_PROJECTS`
 * 同时用于面板/统计列表。值按逗号分隔；绝对路径精确匹配 rootPath，其余按项目名大小写不敏感匹配。 */
export function projectExcluded(
  entry: { name: string; rootPath: string },
  raw: string | undefined
): boolean {
  const root = path.resolve(entry.rootPath);
  if (root === serviceRepoRoot()) return true;
  // 测试套件/临时执行目录产生的项目不进入面板/统计；历史 Web runner 测试 host 也不展示。
  if (entry.name.startsWith("mobile-testing-mcp-test-")) return true;
  if (entry.name === "suite-control-host") return true;
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return false;
  return tokens.some((token) => {
    const value = token.replace(/\\/g, "/");
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
      return path.resolve(value) === root;
    }
    return value.toLowerCase() === entry.name.toLowerCase();
  });
}

export type ProjectDiscoveryMode = "marker" | "registered" | "auto";

/** 工作区自动发现策略：默认 marker（只收真实项目标记），registered 关闭目录扫描，auto 保持旧行为。 */
export function projectDiscoveryMode(raw: string | undefined): ProjectDiscoveryMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "registered") return "registered";
  if (value === "auto") return "auto";
  return "marker";
}

/** 真实项目标记：显式配置、设计产物，或台账中确实登记了该项目根。
 * 仅存在 `.artemis/ledger/state.json`（甚至 `projects: []`）不算——一次误跑
 * 产生的空台账目录不应在面板里变成“未归属主机”的重复项目。 */
export function hasProjectMarker(rootPath: string): boolean {
  const root = path.resolve(rootPath);
  for (const rel of [
    "aos.config.jsonc",
    ".artemis/design/tests.json",
    ".artemis/design/flows.json"
  ]) {
    try {
      if (fs.existsSync(path.join(root, rel))) return true;
    } catch {
      return false;
    }
  }
  const ledger = path.join(root, ".artemis", "ledger", "state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(ledger, "utf8")) as {
      state?: { projects?: unknown };
    };
    const projects = Array.isArray(parsed.state?.projects) ? parsed.state.projects : [];
    return projects.some((project) => {
      if (project === null || typeof project !== "object" || Array.isArray(project)) return false;
      const recorded = (project as { rootPath?: unknown }).rootPath;
      return typeof recorded === "string" && recorded !== "" && path.resolve(recorded) === root;
    });
  } catch {
    return false;
  }
}

/** 显式项目白名单：逗号分隔的项目名（大小写不敏感）或绝对路径。 */
export function projectAllowed(
  entry: { name: string; rootPath: string },
  raw: string | undefined
): boolean {
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return true;
  const root = path.resolve(entry.rootPath);
  return tokens.some((token) => {
    const value = token.replace(/\\/g, "/");
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
      return path.resolve(value) === root;
    }
    return value.toLowerCase() === entry.name.toLowerCase();
  });
}
