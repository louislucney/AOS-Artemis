import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { ExecFn } from "../device/adb.js";
import { errorMessage, writeFileAtomic } from "../util.js";

export type WebJobAssetKind = "excel" | "package" | "materials" | "scripts";

export interface WebJobWorkspaceAsset {
  kind: WebJobAssetKind;
  sha256: string;
  filename: string;
  url: string;
  secret?: boolean;
}

export interface PrepareWebJobWorkspaceInput {
  jobId: string;
  projectSlug: string;
  workRoot: string;
  cacheRoot: string;
  assets: WebJobWorkspaceAsset[];
  download: (url: string) => Promise<Buffer>;
  exec: ExecFn;
  env?: NodeJS.ProcessEnv;
}

export interface PreparedWebJobWorkspace {
  jobDir: string;
  files: Map<string, string>;
  flowsDir: string | null;
  warnings: string[];
}

export type WebJobWorkspaceErrorCode =
  | "invalid-job-path"
  | "invalid-asset-sha"
  | "download-failed"
  | "asset-sha-mismatch"
  | "script-extract-failed";

export class WebJobWorkspaceError extends Error {
  readonly code: WebJobWorkspaceErrorCode;

  constructor(code: WebJobWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WebJobWorkspaceError";
    this.code = code;
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/i;
const EXTRACT_TIMEOUT_MS = 5_000;

/** 内容校验：与期望 sha256（大小写不敏感）逐字节一致。 */
export function verifySha256(buffer: Buffer, expected: string): boolean {
  if (!SHA256_RE.test(expected)) return false;
  return createHash("sha256").update(buffer).digest("hex") === expected.toLowerCase();
}

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new WebJobWorkspaceError("invalid-job-path", `${label} 非法：${value}`);
  }
  return trimmed;
}

function safeFilename(raw: string, fallback: string): string {
  if (raw.includes("\\") || raw.includes("\0")) return fallback;
  const base = path.basename(raw.trim());
  if (base === "" || base === "." || base === "..") return fallback;
  return base;
}

function isUnsafeZipEntry(entry: string): boolean {
  if (entry === "") return false;
  if (path.isAbsolute(entry) || entry.startsWith("/") || entry.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(entry)) return true;
  return entry.split(/[\\/]+/).some((segment) => segment === "..");
}

async function linkOrCopy(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch {
    await copyFile(source, destination);
  }
}

async function cacheEntry(
  input: PrepareWebJobWorkspaceInput,
  asset: WebJobWorkspaceAsset,
  expected: string,
  warnings: string[]
): Promise<string> {
  const cachePath = path.join(input.cacheRoot, "assets", expected);
  try {
    const cached = await readFile(cachePath);
    if (verifySha256(cached, expected)) return cachePath;
    warnings.push(`asset-cache-corrupt:${expected}`);
    await rm(cachePath, { force: true });
  } catch {
    /* 未命中 */
  }

  let buffer: Buffer;
  try {
    buffer = await input.download(asset.url);
  } catch (error) {
    throw new WebJobWorkspaceError(
      "download-failed",
      `资产 ${asset.filename} 下载失败：${errorMessage(error)}`
    );
  }
  if (!verifySha256(buffer, expected)) {
    throw new WebJobWorkspaceError(
      "asset-sha-mismatch",
      `资产 ${asset.filename} sha256 不匹配（期望 ${expected}，实际 ${createHash("sha256")
        .update(buffer)
        .digest("hex")}）`
    );
  }
  await mkdir(path.dirname(cachePath), { recursive: true });
  writeFileAtomic(cachePath, buffer);
  return cachePath;
}

async function extractScripts(input: {
  zipPath: string;
  flowsDir: string;
  exec: ExecFn;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const options = input.env === undefined
    ? { timeoutMs: EXTRACT_TIMEOUT_MS }
    : { timeoutMs: EXTRACT_TIMEOUT_MS, env: input.env };
  const listing = await input.exec("unzip", ["-Z1", input.zipPath], options);
  if (listing.code !== 0) {
    throw new WebJobWorkspaceError(
      "script-extract-failed",
      `脚本包条目扫描失败：${listing.stderr || listing.stdout || listing.error || "unzip -Z1"}`
    );
  }
  const entries = listing.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const unsafe = entries.find((entry) => isUnsafeZipEntry(entry));
  if (unsafe !== undefined) {
    throw new WebJobWorkspaceError(
      "script-extract-failed",
      `脚本包包含越界条目（拒绝解压）：${unsafe}`
    );
  }
  // Plan 2 脚本包把用例放在顶层 `flows/` 目录；解压到 flowsDir 的父目录，
  // 否则会得到 `flows/flows/<caseId>.yaml`，执行器只认顶层文件 → 0 用例。
  const fileEntries = entries.filter((entry) => !entry.endsWith("/"));
  const hasFlowsFolder =
    fileEntries.length > 0 && fileEntries.every((entry) => entry.startsWith("flows/"));
  const destination =
    hasFlowsFolder && path.basename(input.flowsDir) === "flows"
      ? path.dirname(input.flowsDir)
      : input.flowsDir;
  await mkdir(input.flowsDir, { recursive: true });
  const extracted = await input.exec(
    "unzip",
    ["-o", input.zipPath, "-d", destination],
    options
  );
  if (extracted.code !== 0) {
    throw new WebJobWorkspaceError(
      "script-extract-failed",
      `脚本包解压失败：${extracted.stderr || extracted.stdout || extracted.error || "unzip"}`
    );
  }
}

/**
 * job 工作目录：`<workRoot>/<projectSlug>/<jobId>`。
 * 非密资产走 `<cacheRoot>/assets/<sha256>`（命中校验后硬链接/复制）；
 * `secret:true` 只写 `jobDir/secrets/`（0600），永不进入 CAS。
 */
export async function prepareWebJobWorkspace(
  input: PrepareWebJobWorkspaceInput
): Promise<PreparedWebJobWorkspace> {
  const projectSlug = safeSegment(input.projectSlug, "projectSlug");
  const jobId = safeSegment(input.jobId, "jobId");
  const workRoot = path.resolve(input.workRoot);
  const jobDir = path.resolve(workRoot, projectSlug, jobId);
  if (jobDir !== path.join(workRoot, projectSlug, jobId)) {
    throw new WebJobWorkspaceError("invalid-job-path", `job 目录越界：${jobDir}`);
  }
  const warnings: string[] = [];
  const files = new Map<string, string>();
  let flowsDir: string | null = null;

  try {
    for (const asset of input.assets) {
      const expected = String(asset.sha256 ?? "").toLowerCase();
      if (!SHA256_RE.test(expected)) {
        throw new WebJobWorkspaceError(
          "invalid-asset-sha",
          `资产 ${asset.filename} 的 sha256 非法：${String(asset.sha256)}`
        );
      }
      const filename = safeFilename(asset.filename, `${asset.kind}-${expected}`);

      if (asset.kind === "materials" && asset.secret === true) {
        const secretsDir = path.join(jobDir, "secrets");
        const destination = path.join(secretsDir, filename);
        let buffer: Buffer;
        try {
          buffer = await input.download(asset.url);
        } catch (error) {
          throw new WebJobWorkspaceError(
            "download-failed",
            `资产 ${asset.filename} 下载失败：${errorMessage(error)}`
          );
        }
        if (!verifySha256(buffer, expected)) {
          throw new WebJobWorkspaceError(
            "asset-sha-mismatch",
            `资产 ${asset.filename} sha256 不匹配（期望 ${expected}）`
          );
        }
        await mkdir(secretsDir, { recursive: true, mode: 0o700 });
        await chmod(secretsDir, 0o700);
        writeFileAtomic(destination, buffer);
        await chmod(destination, 0o600);
        files.set(asset.kind, destination);
        continue;
      }

      const cachePath = await cacheEntry(input, asset, expected, warnings);
      if (asset.kind === "excel") {
        const destination = path.join(jobDir, "attachments", filename);
        await linkOrCopy(cachePath, destination);
        files.set("excel", destination);
        continue;
      }
      if (asset.kind === "scripts") {
        const destination = path.join(jobDir, "assets", "scripts", filename);
        await linkOrCopy(cachePath, destination);
        files.set("scripts", destination);
        const target = path.join(jobDir, "flows");
        await extractScripts({
          zipPath: destination,
          flowsDir: target,
          exec: input.exec,
          ...(input.env === undefined ? {} : { env: input.env })
        });
        flowsDir = target;
        continue;
      }
      const destination = path.join(jobDir, "assets", asset.kind, filename);
      await linkOrCopy(cachePath, destination);
      files.set(asset.kind, destination);
    }
  } catch (error) {
    // 失败即失败：secret 与半成品 job 目录不得留在磁盘（缓存保留供重试）。
    await removeWebJobSecrets(jobDir);
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { jobDir, files, flowsDir, warnings };
}

export interface CleanupWebJobWorkspaceInput {
  workRoot: string;
  /** 已回传产物、可删除的 job id；未列出的目录一律保留。 */
  completedJobIds?: Iterable<string>;
}

export interface CleanupWebJobWorkspaceResult {
  removed: string[];
}

/** 只删除显式标记为已回传的 job 目录；缓存目录不在 workRoot 下，绝不触碰。 */
export async function cleanupWebJobWorkspace(
  input: CleanupWebJobWorkspaceInput
): Promise<CleanupWebJobWorkspaceResult> {
  const completed = new Set(input.completedJobIds ?? []);
  const workRoot = path.resolve(input.workRoot);
  const removed: string[] = [];
  let projects: string[];
  try {
    projects = await readdir(workRoot);
  } catch {
    return { removed };
  }
  for (const project of projects) {
    const projectDir = path.join(workRoot, project);
    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!completed.has(entry)) continue;
      const jobDir = path.join(projectDir, entry);
      try {
        const info = await lstat(jobDir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        await rm(jobDir, { recursive: true, force: true });
        removed.push(jobDir);
      } catch {
        /* 已消失：忽略 */
      }
    }
  }
  return { removed };
}

/** 失败/结束路径显式抹掉 secret 材料（job 目录整体保留供排查时使用）。 */
export async function removeWebJobSecrets(jobDir: string): Promise<boolean> {
  try {
    await rm(path.join(jobDir, "secrets"), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface InstallWebPackageInput {
  platform: string;
  deviceSerial: string;
  packagePath: string;
  exec: ExecFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** iOS 设备形态；缺省按 `.ipa` → 真机、其余 → 模拟器。 */
  deviceKind?: "device" | "simulator";
  /** 提供时强制安装包位于该 job 目录内（防跨 job/任意路径安装）。 */
  jobDir?: string;
}

export type InstallWebPackageResult =
  | { ok: true; packageName: string | null; version: string | null }
  | {
      ok: false;
      reason:
        | "unsupported-platform"
        | "exec-failed"
        | "install-failed"
        | "invalid-device-serial"
        | "invalid-package-path";
    };

export async function installWebPackage(
  input: InstallWebPackageInput
): Promise<InstallWebPackageResult> {
  if (!/^[A-Za-z0-9._:-]+$/.test(input.deviceSerial)) {
    return { ok: false, reason: "invalid-device-serial" };
  }
  if (input.jobDir !== undefined) {
    const jobDir = path.resolve(input.jobDir);
    const packagePath = path.resolve(input.packagePath);
    if (packagePath !== jobDir && !packagePath.startsWith(jobDir + path.sep)) {
      return { ok: false, reason: "invalid-package-path" };
    }
  }
  const options = {
    timeoutMs: input.timeoutMs ?? 120_000,
    ...(input.env === undefined ? {} : { env: input.env })
  };
  let command: string;
  let args: string[];
  if (input.platform === "android") {
    command = "adb";
    args = ["-s", input.deviceSerial, "install", "-r", input.packagePath];
  } else if (input.platform === "ios") {
    const kind =
      input.deviceKind ?? (path.extname(input.packagePath).toLowerCase() === ".ipa" ? "device" : "simulator");
    if (kind === "device") {
      command = "xcrun";
      args = [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        input.deviceSerial,
        input.packagePath
      ];
    } else {
      command = "xcrun";
      args = ["simctl", "install", input.deviceSerial, input.packagePath];
    }
  } else {
    return { ok: false, reason: "unsupported-platform" };
  }

  const result = await input.exec(command, args, options);
  if (result.code === null || result.code === undefined) {
    return { ok: false, reason: "exec-failed" };
  }
  if (result.code !== 0) return { ok: false, reason: "install-failed" };
  const combined = `${result.stdout}\n${result.stderr}`;
  const packageMatch = /package:\s*([A-Za-z0-9_.]+)/.exec(combined);
  const versionMatch = /versionName[=:\s]+([^\s,]+)/.exec(combined);
  return {
    ok: true,
    packageName: packageMatch?.[1] ?? null,
    version: versionMatch?.[1] ?? null
  };
}
