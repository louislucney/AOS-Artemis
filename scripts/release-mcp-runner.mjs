#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outDir = path.join(root, "dist-runner");
const offlineStaging = path.join(outDir, "offline-staging");
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const utilPath = path.join(root, "src", "util.ts");

function fail(message) {
  console.error(`release-mcp-runner: ${message}`);
  process.exit(1);
}

function readVersion() {
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

function replaceFile(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(from)) return false;
  fs.writeFileSync(file, text.split(from).join(to), "utf8");
  return true;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function findOfflineDeps(platformKey, required = true) {
  const envName =
    platformKey === "win32-x64" ? "AOS_RUNNER_OFFLINE_DEPS" : "AOS_RUNNER_OFFLINE_DEPS_DARWIN";
  const explicit = (process.env[envName] ?? "").trim();
  if (explicit !== "") {
    if (!fs.existsSync(explicit)) fail(`${envName} 不存在：${explicit}`);
    return explicit;
  }
  const filename =
    platformKey === "win32-x64" ? "win32-site-packages.zip" : `${platformKey}-site-packages.zip`;
  if (!fs.existsSync(offlineStaging)) {
    if (!required) return null;
    fail(`缺少离线依赖：先准备 deps/${filename}，或设置 ${envName}`);
  }
  const candidates = fs
    .readdirSync(offlineStaging, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(offlineStaging, entry.name, "deps", filename))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) {
    if (!required) return null;
    fail(`缺少离线依赖：先准备 deps/${filename}，或设置 ${envName}`);
  }
  return candidates[0];
}

const bump = !process.argv.includes("--no-bump");
const oldVersion = readVersion();
if (bump) {
  execFileSync("npm", ["version", "patch", "--no-git-tag-version"], {
    cwd: root,
    stdio: "inherit"
  });
}
const version = readVersion();
if (version === oldVersion) fail("版本号没有变化；去掉 --no-bump 或先手动调整版本");

// Keep the service version and docs paths in sync with package.json.
replaceFile(utilPath, `AOS_MCP_VERSION = "${oldVersion}"`, `AOS_MCP_VERSION = "${version}"`);
const docs = [
  "README.md",
  "AGENTS.md",
  "docs/windows-runner-quickstart.md",
  "docs/android-native-spike.md",
  "docs/空闲机器接入托管平台.md"
];
for (const relative of docs) {
  const file = path.join(root, relative);
  if (fs.existsSync(file)) replaceFile(file, `aos-artemis-runner-${oldVersion}`, `aos-artemis-runner-${version}`);
}
if (fs.existsSync(lockPath)) {
  replaceFile(lockPath, `"version": "${oldVersion}"`, `"version": "${version}"`);
}

execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });

const onlineZip = path.join(outDir, `aos-artemis-runner-${version}-win32-x64.zip`);
if (!fs.existsSync(onlineZip)) fail(`在线包不存在：${onlineZip}`);
const bundleReadme = execFileSync(
  "unzip",
  ["-p", onlineZip, `aos-artemis-runner-${version}-win32-x64/README.md`],
  { encoding: "utf8" }
);
if (!bundleReadme.includes(`v${version}`)) {
  fail(`包内 README.md 未包含版本号 v${version}`);
}

const winDeps = findOfflineDeps("win32-x64");
const winStageName = `aos-artemis-runner-${version}-win32-x64-offline`;
const winStageDir = path.join(offlineStaging, winStageName);
fs.rmSync(winStageDir, { recursive: true, force: true });
fs.mkdirSync(offlineStaging, { recursive: true });
execFileSync("unzip", ["-q", onlineZip, "-d", offlineStaging], { stdio: "inherit" });
const winExtracted = path.join(offlineStaging, `aos-artemis-runner-${version}-win32-x64`);
if (!fs.existsSync(winExtracted)) fail(`解包后目录不存在：${winExtracted}`);
fs.renameSync(winExtracted, winStageDir);
fs.mkdirSync(path.join(winStageDir, "deps"), { recursive: true });
fs.copyFileSync(winDeps, path.join(winStageDir, "deps", "win32-site-packages.zip"));
fs.copyFileSync(
  path.join(root, "scripts", "runner", "setup-offline.cmd"),
  path.join(winStageDir, "setup-offline.cmd")
);
const offlineZip = path.join(outDir, `${winStageName}.zip`);
fs.rmSync(offlineZip, { force: true });
execFileSync("zip", ["-qr", offlineZip, winStageName], { cwd: offlineStaging, stdio: "inherit" });
fs.rmSync(winStageDir, { recursive: true, force: true });

const darwinOnlineTar = path.join(
  outDir,
  `aos-artemis-runner-${version}-darwin-arm64.tar.gz`
);
let darwinOfflineTar = null;
const darwinDeps = findOfflineDeps("darwin-arm64", false);
if (darwinDeps === null) {
  console.warn(
    "release-mcp-runner: 未提供 darwin-arm64 离线依赖（deps/darwin-arm64-site-packages.zip），跳过 macOS 离线包"
  );
} else if (!fs.existsSync(darwinOnlineTar)) {
  fail(`macOS 在线包不存在：${darwinOnlineTar}`);
} else {
  const darwinStageName = `aos-artemis-runner-${version}-darwin-arm64-offline`;
  const darwinStageDir = path.join(offlineStaging, darwinStageName);
  fs.rmSync(darwinStageDir, { recursive: true, force: true });
  fs.mkdirSync(offlineStaging, { recursive: true });
  execFileSync("tar", ["-xzf", darwinOnlineTar, "-C", offlineStaging], {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" }
  });
  const darwinExtracted = path.join(
    offlineStaging,
    `aos-artemis-runner-${version}-darwin-arm64`
  );
  if (!fs.existsSync(darwinExtracted)) fail(`macOS 解包后目录不存在：${darwinExtracted}`);
  fs.renameSync(darwinExtracted, darwinStageDir);
  fs.mkdirSync(path.join(darwinStageDir, "deps"), { recursive: true });
  fs.copyFileSync(
    darwinDeps,
    path.join(darwinStageDir, "deps", "darwin-arm64-site-packages.zip")
  );
  const darwinSetup = path.join(darwinStageDir, "setup-offline.command");
  fs.copyFileSync(path.join(root, "scripts", "runner", "setup-offline.command"), darwinSetup);
  fs.chmodSync(darwinSetup, 0o755);
  darwinOfflineTar = path.join(outDir, `${darwinStageName}.tar.gz`);
  fs.rmSync(darwinOfflineTar, { force: true });
  execFileSync("tar", ["-czf", darwinOfflineTar, "-C", offlineStaging, darwinStageName], {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" }
  });
  fs.rmSync(darwinStageDir, { recursive: true, force: true });
}

const manifestPath = path.join(outDir, "mcp-runner-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const next = manifest.filter(
  (entry) =>
    !(
      entry.platform === "win32" &&
      entry.arch === "x64" &&
      (entry.variant ?? "online") === "offline"
    ) &&
    !(
      entry.platform === "darwin" &&
      entry.arch === "arm64" &&
      (entry.variant ?? "online") === "offline"
    )
);
next.push({
  platform: "win32",
  arch: "x64",
  variant: "offline",
  filename: path.basename(offlineZip),
  size: fs.statSync(offlineZip).size,
  sha256: sha256(offlineZip),
  includesTools: true,
  url: "/panel/runner-bundle?role=mcp-runner&platform=win32&arch=x64&variant=offline"
});
if (darwinOfflineTar !== null) {
  next.push({
    platform: "darwin",
    arch: "arm64",
    variant: "offline",
    filename: path.basename(darwinOfflineTar),
    size: fs.statSync(darwinOfflineTar).size,
    sha256: sha256(darwinOfflineTar),
    includesTools: true,
    url: "/panel/runner-bundle?role=mcp-runner&platform=darwin&arch=arm64&variant=offline"
  });
}
fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);

execFileSync("npm", ["run", "check:runner-bundle"], { cwd: root, stdio: "inherit" });

const summary = [
  ["win32-x64 online", onlineZip],
  ["win32-x64 offline", offlineZip],
  ["darwin-arm64 online", darwinOnlineTar],
  ["darwin-arm64 offline", darwinOfflineTar]
]
  .filter(([, file]) => typeof file === "string" && fs.existsSync(file))
  .map(([label, file]) => `- ${label}: ${path.basename(file)}  sha256=${sha256(file)}`)
  .join("\n");
console.log(`\nrunner bundle released at v${version}\n${summary}\n`);
console.log("下一步：git add package.json package-lock.json src/util.ts docs README.md AGENTS.md scripts && git commit");
