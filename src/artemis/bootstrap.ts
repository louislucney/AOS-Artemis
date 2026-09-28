import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { AosConfig } from "../config/types.js";
import { errorMessage, log as defaultLog } from "../util.js";

export interface DepsSource {
  url: string;
  sha256?: string | null;
}

export interface EnsureDepsResult {
  status: "ready" | "installed" | "skipped" | "failed";
  message: string;
  cacheDir?: string;
}

export interface DepsStamp {
  schema: number;
  lockSha256: string | null;
  pythonVersion?: string | null;
  source: {
    type: "bundle" | "adopted" | "online" | "local-build";
    url?: string;
    sha256?: string | null;
  };
  installedAt: string;
}

export type DepsStatusKind = "missing" | "ready" | "stale" | "unmanaged";
export interface DepsStatus {
  status: DepsStatusKind;
  lockSha256: string | null;
  stamp: DepsStamp | null;
}

type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; onLine?: (line: string) => void }
) => Promise<{ code: number; stderrTail: string }>;

export interface EnsureDepsOptions {
  repoDir: string;
  source?: DepsSource | null;
  cacheRoot?: string;
  uvBin?: string;
  force?: boolean;
  /** Allow falling back to an online `uv sync` when the bundle is missing/stale.
   * Defaults to true; set AOS_DEPS_NO_ONLINE=1 (or false here) to forbid it. */
  allowOnline?: boolean;
  log?: (line: string) => void;
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
}

interface BundleManifest {
  schema: number;
  platform: { os: string; arch: string };
  pythonVersion?: string;
  uv?: string;
  artemisCommit?: string;
  lockSha256?: string;
  createdAt?: string;
}

const STAMP_FILENAME = ".aos-deps.json";

export function venvPythonPath(repoDir: string): string {
  return process.platform === "win32"
    ? path.join(repoDir, ".venv", "Scripts", "python.exe")
    : path.join(repoDir, ".venv", "bin", "python");
}

export function hasVenv(repoDir: string): boolean {
  return fs.existsSync(venvPythonPath(repoDir));
}

/** env AOS_ARTEMIS_DEPS_URL/SHA256 win over the optional config fields. */
export function resolveDepsSource(
  config: AosConfig,
  env: NodeJS.ProcessEnv = process.env
): DepsSource | null {
  const url = env.AOS_ARTEMIS_DEPS_URL?.trim() || config.artemis.depsUrl?.trim();
  if (!url) return null;
  const sha256 =
    env.AOS_ARTEMIS_DEPS_SHA256?.trim() || config.artemis.depsSha256?.trim() || null;
  return { url, sha256 };
}

export function platformArch(): string {
  return process.arch === "x64" ? "x86_64" : process.arch;
}

function sha256File(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function lockSha(repoDir: string): string | null {
  return sha256File(path.join(repoDir, "uv.lock"));
}

export function readDepsStamp(repoDir: string): DepsStamp | null {
  const stampPath = path.join(repoDir, ".venv", STAMP_FILENAME);
  if (!fs.existsSync(stampPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, "utf-8")) as DepsStamp;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDepsStamp(repoDir: string, stamp: DepsStamp): void {
  const venvDir = path.join(repoDir, ".venv");
  if (!fs.existsSync(venvDir)) return;
  fs.writeFileSync(path.join(venvDir, STAMP_FILENAME), JSON.stringify(stamp, null, 2) + "\n");
}

/** Cheap staleness check: compare the venv's stamp against the current uv.lock.
 * `unmanaged` = venv exists without a stamp (serve/doctor --install-deps adopts it). */
export function depsStatus(repoDir: string): DepsStatus {
  const lock = lockSha(repoDir);
  if (!hasVenv(repoDir)) return { status: "missing", lockSha256: lock, stamp: null };
  const stamp = readDepsStamp(repoDir);
  if (!stamp) return { status: "unmanaged", lockSha256: lock, stamp: null };
  if (lock && stamp.lockSha256 && stamp.lockSha256 !== lock) {
    return { status: "stale", lockSha256: lock, stamp };
  }
  return { status: "ready", lockSha256: lock, stamp };
}

function defaultExec(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; onLine?: (line: string) => void }
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderrTail = "";
    const forward = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed !== "" && opts.onLine) opts.onLine(trimmed);
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => resolve({ code: 127, stderrTail: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderrTail }));
  });
}

async function obtainArchive(
  source: DepsSource,
  cacheRoot: string,
  log: (line: string) => void,
  fetchImpl: typeof fetch
): Promise<string> {
  const url = source.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    const local = url.startsWith("file://") ? fileURLToPath(url) : url;
    const resolved = path.resolve(local);
    if (!fs.existsSync(resolved)) throw new Error(`本地依赖包不存在: ${resolved}`);
    return resolved;
  }

  const baseName = decodeURIComponent(
    new URL(url).pathname.split("/").pop() || "artemis-deps.tar.gz"
  );
  // Cache by sha prefix when available so a republished bundle is never reused
  // under a stale name; without sha we always re-download (freshness first).
  const shaTag = source.sha256 ? source.sha256.slice(0, 12) : null;
  const target = path.join(cacheRoot, "downloads", shaTag ? `${baseName}.${shaTag}` : baseName);
  if (shaTag && fs.existsSync(target)) {
    log(`使用已下载的依赖包: ${target}`);
    return target;
  }

  log(`下载依赖包: ${url}`);
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastLoggedMb = -1;
  const stream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>
  );
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const mb = Math.floor(received / (8 * 1024 * 1024));
    if (mb > lastLoggedMb) {
      lastLoggedMb = mb;
      log(`  … ${(received / 1048576).toFixed(0)}MB${total ? ` / ${(total / 1048576).toFixed(0)}MB` : ""}`);
    }
  });
  const partPath = `${target}.part`;
  await pipeline(stream, fs.createWriteStream(partPath));
  fs.renameSync(partPath, target);
  return target;
}

function locateBundleRoot(extractDir: string): string {
  if (fs.existsSync(path.join(extractDir, "manifest.json"))) return extractDir;
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = path.join(extractDir, entry.name);
      if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
    }
  }
  throw new Error("依赖包缺少 manifest.json");
}

/** First-run/update bootstrap for artemis dependencies.
 *
 * - venv missing                → install (from bundle when configured, else guidance)
 * - venv unmanaged (no stamp)   → offline probe; on success adopt it, else update
 * - stamp.lockSha256 ≠ uv.lock  → update (bundle first, online `uv sync` fallback)
 * - up to date                  → no-op
 *
 * Code-only artemis updates need no action: the venv holds dependencies only
 * and the code is always read from the repo checkout. */
export async function ensureArtemisDeps(options: EnsureDepsOptions): Promise<EnsureDepsResult> {
  const log = options.log ?? defaultLog;
  const exec = options.exec ?? defaultExec;
  const repoDir = path.resolve(options.repoDir);
  const allowOnline = options.allowOnline ?? process.env.AOS_DEPS_NO_ONLINE !== "1";
  const source = options.source;
  const uvBin = options.uvBin ?? process.env.AOS_UV_BIN ?? "uv";

  const state = depsStatus(repoDir);
  if (!options.force && state.status === "ready") {
    return {
      status: "ready",
      message: `artemis venv 已是最新（lock ${state.lockSha256?.slice(0, 8) ?? "?"}）`
    };
  }

  const cacheRoot = path.resolve(
    options.cacheRoot ??
      process.env.AOS_DEPS_CACHE_DIR ??
      path.join(path.dirname(repoDir), ".artemis-deps")
  );

  const uvCheck = await exec(uvBin, ["--version"], { cwd: repoDir, env: process.env });
  if (uvCheck.code !== 0) {
    return {
      status: "failed",
      message:
        `未找到 uv（${uvBin}）。\n` +
        "Run: brew install uv    （或 curl -LsSf https://astral.sh/uv/install.sh | sh）"
    };
  }

  // Adopt an unmanaged venv when it already matches the lock.
  if (state.status === "unmanaged" && !options.force) {
    const probe = await exec(
      uvBin,
      ["sync", "--frozen", "--no-install-project", "--offline"],
      { cwd: repoDir, env: process.env }
    );
    if (probe.code === 0) {
      writeDepsStamp(repoDir, {
        schema: 1,
        lockSha256: state.lockSha256,
        source: { type: "adopted" },
        installedAt: new Date().toISOString()
      });
      return { status: "ready", message: "artemis venv 已就绪（已纳入托管）" };
    }
    log("现有 venv 与 uv.lock 不一致，准备更新依赖…");
  } else if (state.status === "stale" || (options.force && hasVenv(repoDir))) {
    log(
      `检测到依赖需要更新：uv.lock ${state.stamp?.lockSha256?.slice(0, 8) ?? "?"} → ` +
        `${state.lockSha256?.slice(0, 8) ?? "?"}`
    );
  }

  const stampFor = (
    type: DepsStamp["source"]["type"],
    extra: Partial<DepsStamp["source"]> = {}
  ): DepsStamp => ({
    schema: 1,
    lockSha256: state.lockSha256,
    source: { type, ...extra },
    installedAt: new Date().toISOString()
  });

  const onlineSync = async (reason: string): Promise<EnsureDepsResult> => {
    log(`在线安装依赖（uv sync --frozen --no-install-project）…（${reason}）`);
    const sync = await exec(uvBin, ["sync", "--frozen", "--no-install-project"], {
      cwd: repoDir,
      env: process.env,
      onLine: log
    });
    if (sync.code !== 0) {
      return { status: "failed", message: `在线安装失败（uv 退出码 ${sync.code}）: ${sync.stderrTail}` };
    }
    if (!hasVenv(repoDir)) {
      return { status: "failed", message: "安装结束但未生成 .venv，请检查 uv 输出" };
    }
    writeDepsStamp(repoDir, stampFor("online"));
    return { status: "installed", message: "依赖已通过在线 uv sync 安装/更新" };
  };

  // No bundle configured: install only makes sense through plain `uv sync`.
  if (!source?.url) {
    if (state.status === "missing") {
      return {
        status: "skipped",
        message:
          "未配置 artemis 依赖包地址（AOS_ARTEMIS_DEPS_URL 或 aos.config.jsonc 的 artemis.depsUrl）。\n" +
          "Run: cd <artemis> && uv sync    （或用 scripts/artemis-deps.sh 构建依赖包后配置地址）"
      };
    }
    if (allowOnline) {
      return await onlineSync("未配置依赖包，使用标准 uv 工作流");
    }
    return {
      status: "skipped",
      message:
        "依赖已过期且未配置依赖包、已禁用在线回退（AOS_DEPS_NO_ONLINE=1）。\n" +
        "Run: cd <artemis> && uv sync    （或重新构建并配置依赖包）"
    };
  }

  // Bundle path.
  let archivePath: string;
  try {
    archivePath = await obtainArchive(source, cacheRoot, log, options.fetchImpl ?? fetch);
  } catch (error) {
    return { status: "failed", message: `获取依赖包失败: ${errorMessage(error)}` };
  }

  if (source.sha256) {
    const actual = sha256File(archivePath);
    if (actual?.toLowerCase() !== source.sha256.toLowerCase()) {
      return {
        status: "failed",
        message: `依赖包校验失败: sha256 不匹配（期望 ${source.sha256}，实际 ${actual ?? "?"}）`
      };
    }
    log("sha256 校验通过");
  } else {
    log("提示：未配置 sha256，跳过完整性校验（建议提供 AOS_ARTEMIS_DEPS_SHA256）");
  }

  const extractDir = path.join(cacheRoot, `extract-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });
  log("解压依赖包…");
  const tar = await exec("tar", ["-xf", archivePath, "-C", extractDir], {
    cwd: cacheRoot,
    env: process.env
  });
  if (tar.code !== 0) {
    return { status: "failed", message: `解压失败（tar 退出码 ${tar.code}）: ${tar.stderrTail}` };
  }

  let bundleRoot: string;
  let manifest: BundleManifest;
  try {
    bundleRoot = locateBundleRoot(extractDir);
    manifest = JSON.parse(
      fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf-8")
    ) as BundleManifest;
  } catch (error) {
    return { status: "failed", message: `依赖包格式错误: ${errorMessage(error)}` };
  }

  if (manifest.platform?.os !== process.platform || manifest.platform?.arch !== platformArch()) {
    return {
      status: "failed",
      message:
        `依赖包平台不匹配: 包为 ${manifest.platform?.os}/${manifest.platform?.arch}，` +
        `当前为 ${process.platform}/${platformArch()}（请构建对应平台的依赖包）`
    };
  }

  // Bundle older than the repo's lockfile → fall back to online sync.
  if (manifest.lockSha256 && state.lockSha256 && manifest.lockSha256 !== state.lockSha256) {
    const detail =
      `依赖包与当前 uv.lock 不一致（包 ${manifest.lockSha256.slice(0, 8)} → 当前 ${state.lockSha256.slice(0, 8)}）`;
    if (allowOnline) {
      log(`${detail}；回退在线 uv sync（建议重新构建并发布依赖包）`);
      const result = await onlineSync("依赖包过期");
      if (result.status === "installed") {
        result.message = `${result.message}。注意：依赖包已过期，请运行 scripts/artemis-deps.sh build 重新构建`;
      }
      return result;
    }
    return {
      status: "failed",
      message:
        `${detail}，且已禁用在线回退（AOS_DEPS_NO_ONLINE=1）。\n` +
        "Run: ./scripts/artemis-deps.sh build 重新构建并发布依赖包"
    };
  }

  if (manifest.pythonVersion) log(`依赖包: python ${manifest.pythonVersion}, uv ${manifest.uv ?? "?"}`);

  const pythonCheck = await exec(uvBin, ["python", "find", ">=3.12"], {
    cwd: repoDir,
    env: process.env
  });
  if (pythonCheck.code !== 0) {
    log("未找到 Python 3.12，尝试 uv python install 3.12 …");
    const pythonInstall = await exec(uvBin, ["python", "install", "3.12"], {
      cwd: repoDir,
      env: process.env,
      onLine: log
    });
    if (pythonInstall.code !== 0) {
      return { status: "failed", message: `无法获取 Python 3.12: ${pythonInstall.stderrTail}` };
    }
  }

  const cacheDir = path.join(bundleRoot, "uv-cache");
  log("离线安装依赖（uv sync --frozen --no-install-project --offline）…");
  const sync = await exec(uvBin, ["sync", "--frozen", "--no-install-project", "--offline"], {
    cwd: repoDir,
    env: { ...process.env, UV_CACHE_DIR: cacheDir },
    onLine: log
  });
  if (sync.code !== 0) {
    if (allowOnline) {
      log("离线安装失败；回退在线 uv sync（建议检查/重建依赖包）");
      return await onlineSync("离线安装失败");
    }
    return { status: "failed", message: `离线安装失败（uv 退出码 ${sync.code}）: ${sync.stderrTail}` };
  }

  if (!hasVenv(repoDir)) {
    return { status: "failed", message: "离线安装结束但未生成 .venv，请检查 uv 输出" };
  }

  writeDepsStamp(
    repoDir,
    stampFor("bundle", { url: source.url, sha256: source.sha256 ?? null })
  );
  return {
    status: "installed",
    message: `已从依赖包完成安装/更新（缓存保留在 ${cacheDir}）`,
    cacheDir
  };
}
