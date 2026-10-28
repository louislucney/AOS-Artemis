import { createHash } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { ProjectRecord, ProjectStore, WebProjectRecord } from "../db/types.js";
import { writeFileAtomic } from "../util.js";

/** 显示名：trim + NFKC；归一键：小写 NFKC。校验 1–64 字符、无 `/`、`\`、`..`、控制字符。 */
export function normalizeProjectName(raw: string): { name: string; normalized: string } {
  const name = raw.trim().normalize("NFKC");
  if (name.length < 1 || name.length > 64) {
    throw new Error(`项目名称长度须为 1–64 个字符（当前 ${name.length}）`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("项目名称不能包含路径分隔符 / 或 \\");
  }
  if (name.includes("..")) {
    throw new Error("项目名称不能包含 ..");
  }
  if (/[\p{Cc}]/u.test(name)) {
    throw new Error("项目名称不能包含控制字符");
  }
  return { name, normalized: name.toLowerCase() };
}

/** 文件系统安全的目录名：保留 Unicode 字母数字，空白/其他连续转为 `-`，去首尾 `-`；
 * 结果为空则回退 `project-<sha256(name).slice(0,8)>`。 */
export function projectSlug(name: string): string {
  const slug = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 0) return slug;
  return `project-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

/** Web 平台词汇 → `project.stack` 的 native 栈词汇（config 校验只认后者）。 */
const PLATFORM_STACK: Record<string, string> = {
  android: "android-native",
  ios: "ios-native"
};

/** 把平台映射为栈词汇并去重；未知平台显式报错（在创建目录前失败，避免半成品）。 */
function mapPlatformsToStack(platforms: string[]): string[] {
  const stack: string[] = [];
  for (const platform of platforms) {
    const mapped = PLATFORM_STACK[platform];
    if (mapped === undefined) {
      throw new Error(`不支持的平台：${platform}（仅支持 android、ios）`);
    }
    if (!stack.includes(mapped)) stack.push(mapped);
  }
  return stack;
}

export interface CreateWebProjectInput {
  store: ProjectStore;
  workspaceRoot: string;
  name: string;
  platforms: string[];
  appPackage: string;
  customerName?: string | null;
  owner?: string | null;
}

export interface CreateWebProjectResult {
  project: ProjectRecord;
  web: WebProjectRecord;
  rootPath: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 创建托管 Web 项目：归一名称 → 查重 → 建目录 → 写 `aos.config.jsonc` → 注册 store。
 * 目录创建后的任一步失败，best-effort 移除目录；web 行已建但 project 未建时归档该行。 */
export async function createWebProject(
  input: CreateWebProjectInput
): Promise<CreateWebProjectResult> {
  const { name, normalized } = normalizeProjectName(input.name);
  const stack = mapPlatformsToStack(input.platforms);

  const duplicate = (await input.store.listWebProjects()).find(
    (entry) => entry.normalizedName === normalized
  );
  if (duplicate) {
    throw new Error(`同名 Web 项目已存在：${name}（${duplicate.rootPath}）`);
  }

  await mkdir(input.workspaceRoot, { recursive: true });

  const rootPath = path.join(input.workspaceRoot, projectSlug(name));
  if (await pathExists(rootPath)) {
    throw new Error(`项目目录已存在：${rootPath}`);
  }

  let web: WebProjectRecord | null = null;
  try {
    await mkdir(rootPath);
    const webRoot = path.join(rootPath, ".artemis", "web");
    await mkdir(path.join(webRoot, "assets"), { recursive: true });
    await mkdir(path.join(webRoot, "workbook"));
    await mkdir(path.join(webRoot, "scripts"));
    await mkdir(path.join(webRoot, "results"));

    const config = {
      project: { name, stack },
      llm: { profiles: {} },
      artemis: {}
    };
    writeFileAtomic(
      path.join(rootPath, "aos.config.jsonc"),
      `${JSON.stringify(config, null, 2)}\n`
    );

    web = await input.store.createWebProject({
      rootPath,
      name,
      normalizedName: normalized,
      platforms: [...input.platforms],
      appPackage: input.appPackage ?? null,
      customerName: input.customerName ?? null,
      owner: input.owner ?? null
    });
    const project = await input.store.upsertProject({ rootPath, name });
    return { project, web, rootPath };
  } catch (error) {
    if (web !== null) {
      try {
        await input.store.archiveWebProject(rootPath, new Date().toISOString());
      } catch {
        /* best-effort */
      }
    }
    try {
      await rm(rootPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw error;
  }
}
