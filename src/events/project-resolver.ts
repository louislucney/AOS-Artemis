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
  name: string;
  store: ProjectStore;
  write: boolean;
}): Promise<{ rootPath: string; projectId: string | null } | null> {
  if (!isValidProjectName(input.name)) {
    throw new Error(`项目名不合法：${input.name}`);
  }
  const rootPath = resolveProjectRoot(input.workspaceRoot, input.name);
  if (rootPath === null) return null;

  const key = `${rootPath}\u0000${input.write ? "write" : "read"}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { rootPath: cached.rootPath, projectId: cached.projectId };
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
    const project = await input.store.upsertProject({
      rootPath,
      name: input.name,
      updateName: false
    });
    projectId = project.id;
  } else {
    const project = await input.store.getProjectByPath(rootPath);
    projectId = project?.id ?? null;
  }
  const entry = { rootPath, projectId, at: Date.now() };
  cache.set(key, entry);
  return { rootPath: entry.rootPath, projectId: entry.projectId };
}
