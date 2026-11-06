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

const artifacts = [
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
