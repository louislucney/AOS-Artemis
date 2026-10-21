import fs from "node:fs";
import path from "node:path";

import { loadProject } from "../config/loader.js";
import type { ProjectStore } from "../db/types.js";

const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  rootPath: string;
  projectId: string | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && name !== "." && name !== "..";
}

export function resolveProjectRoot(workspaceRoot: string, name: string): string | null {
  if (!isValidProjectName(name)) return null;
  const root = path.resolve(workspaceRoot, name);
  try {
    if (!fs.statSync(root).isDirectory()) return null;
    return fs.realpathSync.native(root);
  } catch {
    return null;
  }
}

export async function resolveEventProject(input: {
  workspaceRoot: string;
  hostId: string | null;
  name: string;
  store: ProjectStore;
  write: boolean;
}): Promise<{ rootPath: string; hostId: string | null; projectId: string | null } | null> {
  if (!isValidProjectName(input.name)) {
    throw new Error(`项目名不合法：${input.name}`);
  }

  const explicitHost = input.hostId ?? null;
  const localHostId = input.store.localHostId;

  // 显式非本机 host：按名解析远端项目（远端路径无需在本机磁盘存在）。
  if (explicitHost !== null && explicitHost !== localHostId) {
    const scoped = input.store.scopeHost(explicitHost);
    const projects = await scoped.listProjects();
    const matches = projects.filter(
      (project) => project.hostId === explicitHost && project.name === input.name
    );
    // 无行或同名歧义均无法落地；write 亦无法推断远端 rootPath。
    if (matches.length !== 1) return null;
    const project = matches[0]!;
    return { rootPath: project.rootPath, hostId: explicitHost, projectId: project.id };
  }

  // 本机（显式 host 为空或等于 localHostId）：沿用工作区 + 文件系统解析。
  const rootPath = resolveProjectRoot(input.workspaceRoot, input.name);
  if (rootPath === null) return null;

  const hostId = explicitHost ?? localHostId;
  const scoped = hostId !== null ? input.store.scopeHost(hostId) : input.store;

  // 无显式 host 且无 host 可作用域时，同路径跨主机视为歧义（不取其一）。
  if (hostId === null) {
    const projects = await scoped.listProjects();
    if (projects.filter((project) => project.rootPath === rootPath).length > 1) return null;
  }

  const key = `${hostId ?? "legacy"}\u0000${rootPath}\u0000${input.write ? "write" : "read"}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { rootPath: cached.rootPath, hostId, projectId: cached.projectId };
  }

  try {
    loadProject({
      env: { ...process.env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" },
      cwd: rootPath
    });
  } catch (error) {
    throw new ProjectConfigError(
      `project-config-invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let projectId: string | null = null;
  if (input.write) {
    const project = await scoped.upsertProject({
      rootPath,
      name: input.name,
      hostId,
      updateName: false
    });
    projectId = project.id;
  } else {
    const project = await scoped.getProjectByPath(rootPath);
    projectId = project?.id ?? null;
  }
  const entry: CacheEntry = { rootPath, projectId, at: Date.now() };
  cache.set(key, entry);
  return { rootPath, hostId, projectId };
}
