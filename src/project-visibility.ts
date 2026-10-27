import path from "node:path";

/** 共享的项目可见性过滤：`AOS_PANEL_EXCLUDE_PROJECTS` 同时用于面板/统计列表。
 * 值按逗号分隔；绝对路径精确匹配 rootPath，其余按项目名大小写不敏感匹配。 */
export function projectExcluded(
  entry: { name: string; rootPath: string },
  raw: string | undefined
): boolean {
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return false;
  const root = path.resolve(entry.rootPath);
  return tokens.some((token) => {
    const value = token.replace(/\\/g, "/");
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
      return path.resolve(value) === root;
    }
    return value.toLowerCase() === entry.name.toLowerCase();
  });
}
