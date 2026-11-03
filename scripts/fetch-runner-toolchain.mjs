#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = process.cwd();
const outDir = path.resolve(process.env.AOS_RUNNER_TOOLCHAIN_DIR?.trim() || path.join(root, "dist-toolchain"));
const filesDir = path.join(outDir, "files");
const force = process.argv.includes("--force");
const only = process.argv.find((arg) => arg.startsWith("--platform="))?.split("=")[1] ?? "";

const NODE_VERSION = "22.22.2";
const MAESTRO_VERSION = "2.12.1";
const JDK_VERSION = "21.0.13+9";

const artifacts = [
  {
    platform: "darwin-arm64",
    tool: "node",
    name: `Node.js ${NODE_VERSION}`,
    filename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000"
  },
  {
    platform: "win32-x64",
    tool: "node",
    name: `Node.js ${NODE_VERSION}`,
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
    sha256: "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c"
  },
  {
    platform: "darwin-arm64",
    tool: "adb",
    name: "Android platform-tools",
    filename: "platform-tools-latest-darwin.zip",
    url: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
    sha256: null
  },
  {
    platform: "win32-x64",
    tool: "adb",
    name: "Android platform-tools",
    filename: "platform-tools-latest-windows.zip",
    url: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
    sha256: null
  },
  {
    platform: "darwin-arm64",
    tool: "jdk",
    name: `Temurin JDK ${JDK_VERSION}`,
    filename: `OpenJDK21U-jdk_aarch64_mac_hotspot_${JDK_VERSION.replace("+", "_")}.tar.gz`,
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz",
    sha256: "bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a"
  },
  {
    platform: "win32-x64",
    tool: "jdk",
    name: `Temurin JDK ${JDK_VERSION}`,
    filename: `OpenJDK21U-jdk_x64_windows_hotspot_${JDK_VERSION.replace("+", "_")}.zip`,
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip",
    sha256: "a4dbaa05fca4bd89d84584e58c459bd732efebb1722af80ab13c6516832004f9"
  },
  {
    platform: "darwin-arm64",
    tool: "maestro",
    name: `Maestro CLI ${MAESTRO_VERSION}`,
    filename: `maestro-${MAESTRO_VERSION}.zip`,
    url: `https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip`,
    sha256: "54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7",
    shared: true
  },
  {
    platform: "win32-x64",
    tool: "maestro",
    name: `Maestro CLI ${MAESTRO_VERSION}`,
    filename: `maestro-${MAESTRO_VERSION}.zip`,
    url: `https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip`,
    sha256: "54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7",
    shared: true
  }
];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function ensureArtifact(artifact) {
  const file = path.join(filesDir, artifact.filename);
  if (!force && fs.existsSync(file)) {
    const actual = sha256File(file);
    if (artifact.sha256 === null || actual === artifact.sha256) {
      return actual;
    }
    fs.rmSync(file, { force: true });
  }
  const tmp = `${file}.part`;
  fs.mkdirSync(filesDir, { recursive: true });
  console.log(`download ${artifact.filename}`);
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`下载失败 ${artifact.url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
  const actual = sha256File(tmp);
  if (artifact.sha256 !== null && actual !== artifact.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`sha256 不匹配 ${artifact.filename}: ${actual} != ${artifact.sha256}`);
  }
  fs.renameSync(tmp, file);
  console.log(`ok ${artifact.filename} ${actual}`);
  return actual;
}

fs.mkdirSync(filesDir, { recursive: true });
const selected = only === "" ? artifacts : artifacts.filter((artifact) => artifact.platform === only);
if (selected.length === 0) {
  console.error(`未知平台 ${only}（支持 darwin-arm64 / win32-x64）`);
  process.exit(2);
}
const entries = [];
for (const artifact of selected) {
  const sha256 = await ensureArtifact(artifact);
  entries.push({
    platform: artifact.platform,
    tool: artifact.tool,
    name: artifact.name,
    filename: artifact.filename,
    size: fs.statSync(path.join(filesDir, artifact.filename)).size,
    sha256,
    sourceUrl: artifact.url,
    downloadUrl: `/panel/runner-toolchain?file=${encodeURIComponent(artifact.filename)}`
  });
}
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
  "utf8"
);
console.log(`manifest: ${path.join(outDir, "manifest.json")}`);
