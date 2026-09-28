import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { platformArch, venvPythonPath, writeDepsStamp } from "./artemis/bootstrap.js";
import { errorMessage } from "./util.js";

export interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

type Runner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<CapturedRun>;

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CapturedRun> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf-8")).slice(-200_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-200_000);
    });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export interface DepsBuildOptions {
  serviceRoot?: string;
  repoDir?: string;
  outDir?: string;
  workDir?: string;
  skipSync?: boolean;
  uvBin?: string;
  log?: (line: string) => void;
  exec?: Runner;
}

export interface DepsBuildResult {
  archive: string;
  sha256: string;
  sizeBytes: number;
}

/** Cross-platform dependency bundle builder (Windows/macOS/Linux).
 * The uv cache is platform-specific, so build one bundle per target platform:
 * run this command on each platform (or in the matching CI runner / container). */
export async function buildDepsBundle(options: DepsBuildOptions = {}): Promise<DepsBuildResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const run = options.exec ?? spawnCapture;
  const serviceRoot = path.resolve(
    options.serviceRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
  );
  const repoDir = path.resolve(
    options.repoDir ?? process.env.AOS_ARTEMIS_REPO ?? path.join(serviceRoot, "artemis")
  );
  const outDir = path.resolve(options.outDir ?? path.join(serviceRoot, "dist-deps"));
  const workDir = path.resolve(options.workDir ?? path.join(outDir, ".work"));
  const uvBin = options.uvBin ?? process.env.AOS_UV_BIN ?? "uv";
  const cacheDir = path.join(workDir, "uv-cache");
  const buildVenv = path.join(workDir, "venv");

  if (!fs.existsSync(path.join(repoDir, "uv.lock"))) {
    throw new Error(`未找到 ${path.join(repoDir, "uv.lock")}（artemis 仓库路径: ${repoDir}）`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  if (!options.skipSync) {
    log(`[1/5] uv sync --frozen --no-install-project（缓存: ${cacheDir}）`);
    // Fresh build venv forces a real install so the dedicated cache is filled.
    fs.rmSync(buildVenv, { recursive: true, force: true });
    const first = await run(uvBin, ["sync", "--frozen", "--no-install-project"], {
      cwd: repoDir,
      env: { ...process.env, UV_CACHE_DIR: cacheDir, UV_PROJECT_ENVIRONMENT: buildVenv }
    });
    if (first.code !== 0) {
      throw new Error(`uv sync 失败（退出码 ${first.code}）: ${(first.stderr || first.stdout).slice(-600)}`);
    }
    // Warm-cache pass for the repo's own .venv (fast; installs only if missing).
    const second = await run(uvBin, ["sync", "--frozen", "--no-install-project"], {
      cwd: repoDir,
      env: { ...process.env, UV_CACHE_DIR: cacheDir }
    });
    if (second.code !== 0) {
      throw new Error(`uv sync（仓库 venv）失败（退出码 ${second.code}）: ${(second.stderr || second.stdout).slice(-600)}`);
    }
  } else {
    log("[1/5] --skip-sync：复用现有缓存");
  }
  if (!fs.existsSync(cacheDir)) {
    throw new Error(`缓存目录不存在: ${cacheDir}（--skip-sync 需要已有缓存）`);
  }

  log("[2/5] 采集元数据 + 写入版本标记");
  const pyOut = await run(venvPythonPath(repoDir), ["-V"], { cwd: repoDir, env: process.env });
  const pythonVersion = /Python\s+(\S+)/.exec(pyOut.stdout + pyOut.stderr)?.[1] ?? null;
  const uvOut = await run(uvBin, ["--version"], { cwd: repoDir, env: process.env });
  const uvVersion = /uv\s+(\S+)/.exec(uvOut.stdout + uvOut.stderr)?.[1] ?? null;
  const lockSha256 = sha256File(path.join(repoDir, "uv.lock"));

  const git = await run("git", ["-C", repoDir, "rev-parse", "--short", "HEAD"], {
    cwd: repoDir,
    env: process.env
  });
  const commit = git.code === 0 ? git.stdout.trim() : "unknown";

  const manifest = {
    schema: 1,
    platform: { os: process.platform, arch: platformArch() },
    pythonVersion,
    uv: uvVersion,
    artemisCommit: commit,
    lockSha256,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  if (fs.existsSync(venvPythonPath(repoDir))) {
    writeDepsStamp(repoDir, {
      schema: 1,
      lockSha256,
      pythonVersion,
      source: { type: "local-build" },
      installedAt: new Date().toISOString()
    });
  }

  log("[3/5] 打包（tar.gz；Windows 10 1803+ 内置 tar 即可解压）");
  const fileOs = process.platform === "win32" ? "windows" : process.platform;
  const archive = path.join(outDir, `artemis-deps-${fileOs}-${platformArch()}.tar.gz`);
  const tar = await run("tar", ["-czf", archive, "-C", workDir, "uv-cache", "manifest.json"], {
    cwd: outDir,
    env: process.env
  });
  if (tar.code !== 0) {
    throw new Error(`tar 打包失败（退出码 ${tar.code}）: ${tar.stderr.slice(-600)}`);
  }

  const digest = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, digest + "\n");
  const sizeBytes = fs.statSync(archive).size;

  log(`[4/5] 校验和: ${digest}`);
  log(`[5/5] 完成: ${archive}（${(sizeBytes / 1048576).toFixed(0)}MB）`);
  log(`缓存工作目录保留在 ${workDir}（复用可加 --skip-sync）`);
  log("");
  log("发布与使用：");
  log("  1) 将依赖包上传到内部文件服务（或共享盘）；");
  log("  2) 目标项目配置 AOS_ARTEMIS_DEPS_URL=<下载地址>（可选 AOS_ARTEMIS_DEPS_SHA256=<上面 sha256>）；");
  log("  3) 首次运行（serve / doctor --install-deps）自动下载并离线安装。");

  return { archive, sha256: digest, sizeBytes };
}

export async function runDepsCommand(argv: string[]): Promise<number> {
  const [sub = "build", ...rest] = argv;
  if (sub !== "build") {
    console.error('用法: aos-mcp deps build [--out DIR] [--repo DIR] [--work DIR] [--skip-sync] [--uv PATH]');
    return 1;
  }
  const options: DepsBuildOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--out":
        if (rest[index + 1]) options.outDir = rest[++index];
        break;
      case "--repo":
        if (rest[index + 1]) options.repoDir = rest[++index];
        break;
      case "--work":
        if (rest[index + 1]) options.workDir = rest[++index];
        break;
      case "--uv":
        if (rest[index + 1]) options.uvBin = rest[++index];
        break;
      case "--skip-sync":
        options.skipSync = true;
        break;
      default:
        break;
    }
  }

  try {
    await buildDepsBundle(options);
    return 0;
  } catch (error) {
    console.error(`依赖包构建失败: ${errorMessage(error)}`);
    return 1;
  }
}
