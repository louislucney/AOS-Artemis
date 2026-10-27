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
