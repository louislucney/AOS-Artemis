#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import JSZip from "jszip";

const WANTED = new Set([
  "setup.cmd",
  "setup.command",
  "setup-offline.cmd",
  "setup-offline.command",
  "configure.cmd",
  "configure.command",
  "doctor.cmd",
  "doctor.command",
  "runner.cmd",
  "runner.command",
  "README.md",
  "project/.env.example",
  "project/.env"
]);

const REQUIRED_WIN = ["setup.cmd", "configure.cmd", "doctor.cmd", "runner.cmd"];
const REQUIRED_MAC = ["setup.command", "configure.command", "doctor.command", "runner.command"];

function text(files, name) {
  return files.get(name) ?? "";
}

/** 校验 runner bundle 的“边界不变量”：不泄漏中心项目路径/provider key，setup 可自举。 */
export function checkBundleFiles(files, platform) {
  const errors = [];
  const required = platform === "win32" ? REQUIRED_WIN : REQUIRED_MAC;
  for (const name of required) {
    if (!files.has(name)) errors.push(`缺少 ${name}`);
  }
  if (platform === "win32") {
    const runner = text(files, "runner.cmd");
    for (const marker of [
      "ARTEMIS_DESKTOP_NOTIFY=0",
      "NO_PROXY=*",
      "no_proxy=*",
      "HTTP_PROXY=",
      "HTTPS_PROXY=",
      "ALL_PROXY="
    ]) {
      if (!runner.includes(marker)) errors.push(`runner.cmd 缺少 ${marker}`);
    }
  }
  if (files.has("project/.env")) {
    errors.push("bundle 不应包含 project/.env（只允许 .env.example）");
  }
  const env = text(files, "project/.env.example");
  if (env === "") {
    errors.push("缺少 project/.env.example");
  } else {
    if (/^\s*AOS_LLM_API_KEY\s*=/m.test(env)) {
      errors.push("project/.env.example 不应包含启用的 AOS_LLM_API_KEY");
    }
    if (env.includes("AOS_CENTER_PROJECT_ROOT")) {
      errors.push("project/.env.example 不应包含 AOS_CENTER_PROJECT_ROOT");
    }
    if (!env.includes("MOBILE_TESTING_RUNNER_CONTROL_URL=")) {
      errors.push("project/.env.example 缺少 MOBILE_TESTING_RUNNER_CONTROL_URL");
    }
    if (!env.includes("MOBILE_TESTING_RUNNER_JOB_TOKEN=")) {
      errors.push("project/.env.example 缺少 MOBILE_TESTING_RUNNER_JOB_TOKEN");
    }
  }
  const setupName = platform === "win32" ? "setup.cmd" : "setup.command";
  const setup = text(files, setupName);
  if (!setup.includes("AOS_LLM_FROM_CENTER=1")) {
    errors.push(`${setupName} 未设置 AOS_LLM_FROM_CENTER=1`);
  }
  if (!setup.includes("AOS_PEN_SKIP=1")) {
    errors.push(`${setupName} 未设置 AOS_PEN_SKIP=1`);
  }
  if (!setup.includes("doctor --install-deps")) {
    errors.push(`${setupName} 未执行 doctor --install-deps`);
  }
  if (!setup.includes("UV_PYTHON=3.12")) {
    errors.push(`${setupName} 未固定 UV_PYTHON=3.12`);
  }
  const runnerName = platform === "win32" ? "runner.cmd" : "runner.command";
  const runner = text(files, runnerName);
  if (!runner.includes("doctor --install-deps") && !runner.includes("setup-offline.cmd") && !runner.includes("setup-offline.command")) {
    errors.push(`${runnerName} 未包含首次依赖安装（在线 doctor 或离线 setup-offline）`);
  }
  if (!runner.includes("MOBILE_TESTING_RUNNER_JOB_TOKEN")) {
    errors.push(`${runnerName} 未检查 runner token`);
  }
  if (!runner.includes("UV_PYTHON=3.12")) {
    errors.push(`${runnerName} 未固定 UV_PYTHON=3.12`);
  }
  if (!runner.includes(".aos-deps.json")) {
    errors.push(`${runnerName} 未检查 Artemis 依赖 stamp`);
  }
  if (platform === "win32" && !runner.includes("sys.version_info") && !runner.includes("aos-venv-version")) {
    errors.push(`${runnerName} 未校验 venv Python 3.12（旧 3.13 venv 会与离线依赖不兼容）`);
  }
  const setupOffline = text(files, "setup-offline.cmd");
  if (platform === "win32" && setupOffline !== "") {
    if (!setupOffline.includes("sys.version_info")) {
      errors.push("setup-offline.cmd 未校验 venv Python 版本");
    }
    if (!setupOffline.includes("rmdir /s /q")) {
      errors.push("setup-offline.cmd 未在 Python 版本不符时重建 venv");
    }
  }
  const setupOfflineMac = text(files, "setup-offline.command");
  if (platform === "darwin" && setupOfflineMac !== "") {
    if (!setupOfflineMac.includes("sys.version_info")) {
      errors.push("setup-offline.command 未校验 venv Python 版本");
    }
    if (!setupOfflineMac.includes("darwin-arm64-site-packages.zip")) {
      errors.push("setup-offline.command 未引用 darwin-arm64-site-packages.zip");
    }
    if (!setupOfflineMac.includes("unzip")) {
      errors.push("setup-offline.command 未解压离线依赖");
    }
  }
  const configureName = platform === "win32" ? "configure.cmd" : "configure.command";
  const configure = text(files, configureName);
  if (/AOS_CENTER_PROJECT_ROOT|Center project root|CENTER_ROOT/.test(configure)) {
    errors.push(`${configureName} 不应要求中心项目路径`);
  }
  const readme = text(files, "README.md");
  if (readme !== "" && !/中心\s*LLM|中心代理/.test(readme)) {
    errors.push("README.md 未说明 LLM 由中心代理提供");
  }
  const runnerDocs = [readme, env, configure, setup].join("\n");
  if (/MOBILE_TESTING_DATABASE_URL|直连中心\s*PG/i.test(runnerDocs)) {
    errors.push("runner bundle 不应提示直连 PostgreSQL（runner 只走 HTTP 控制面）");
  }
  const allText = [...files.values()].join("\n");
  if (/sk-[A-Za-z0-9]{20,}/.test(allText)) {
    errors.push("bundle 文本中疑似包含真实 API key（sk-…）");
  }
  return { ok: errors.length === 0, errors };
}

async function readZipFiles(zipPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  const top = entries.length === 0 ? "" : entries[0][0].split("/")[0];
  const files = new Map();
  for (const [name, entry] of entries) {
    if (top === "" || !name.startsWith(`${top}/`)) continue;
    const relative = name.slice(top.length + 1);
    if (!WANTED.has(relative)) continue;
    files.set(relative, await entry.async("string"));
  }
  return files;
}

function readTarGzFiles(tarPath) {
  const names = execFileSync("tar", ["-tzf", tarPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  })
    .split(/\r?\n/)
    .filter((name) => name !== "");
  const top = names.length === 0 ? "" : names[0].split("/")[0];
  const files = new Map();
  for (const name of names) {
    if (top === "" || name.endsWith("/") || !name.startsWith(`${top}/`)) continue;
    const relative = name.slice(top.length + 1);
    if (!WANTED.has(relative)) continue;
    files.set(
      relative,
      execFileSync("tar", ["-xOzf", tarPath, name], { encoding: "utf8" })
    );
  }
  return files;
}

export async function checkRunnerBundle(zipPath, platform) {
  const files = zipPath.endsWith(".tar.gz")
    ? readTarGzFiles(zipPath)
    : await readZipFiles(zipPath);
  return checkBundleFiles(files, platform);
}

async function main() {
  const manifestPath = path.resolve("dist-runner/mcp-runner-manifest.json");
  const explicit = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const targets = [];
  if (explicit !== null) {
    targets.push({ zipPath: explicit, platform: explicit.endsWith(".zip") ? "win32" : "darwin" });
  } else {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      console.error(`缺少 ${manifestPath}；先运行 npm run bundle:mcp-runner`);
      process.exit(2);
    }
    if (!Array.isArray(manifest)) {
      console.error(`${manifestPath} 格式无效`);
      process.exit(2);
    }
    for (const entry of manifest) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.filename !== "string" ||
        typeof entry.platform !== "string"
      ) {
        continue;
      }
      targets.push({
        zipPath: path.join("dist-runner", entry.filename),
        platform: entry.platform
      });
    }
  }
  if (targets.length === 0) {
    console.error("没有可检查的 runner bundle");
    process.exit(2);
  }
  let failed = false;
  for (const target of targets) {
    const result = await checkRunnerBundle(target.zipPath, target.platform);
    if (result.ok) {
      console.log(`ok ${target.zipPath}`);
    } else {
      failed = true;
      console.error(`FAIL ${target.zipPath}`);
      for (const error of result.errors) console.error(`  - ${error}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
