#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outDir = path.join(root, "dist-runner");
const toolchainDir = path.resolve(
  (process.env.AOS_RUNNER_TOOLCHAIN_DIR ?? "").trim() || path.join(root, "dist-toolchain")
);
const appOnly = process.env.AOS_RUNNER_BUNDLE_APP_ONLY === "1" || process.argv.includes("--app-only");
const allTargets = [
  { platform: "win32", arch: "x64", archive: "zip", tools: true },
  { platform: "darwin", arch: "arm64", archive: "tar.gz", tools: true },
  { platform: "linux", arch: "x64", archive: "tar.gz", tools: false }
];
const platformArg = process.argv.find((arg) => arg.startsWith("--platform="))?.split("=")[1] ?? "";
const targets =
  platformArg === "" ? allTargets : allTargets.filter((target) => `${target.platform}-${target.arch}` === platformArg);
if (targets.length === 0) {
  console.error(`未知平台 ${platformArg}（支持 win32-x64 / darwin-arm64 / linux-x64）`);
  process.exit(2);
}
const partial = platformArg !== "";

if (!fs.existsSync(path.join(root, "dist", "cli.js"))) {
  console.error("缺少 dist/cli.js，请先 npm run build");
  process.exit(2);
}

let toolchainEntries = [];
if (!appOnly) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(toolchainDir, "manifest.json"), "utf8"));
    toolchainEntries = Array.isArray(manifest.entries) ? manifest.entries : [];
  } catch {
    console.error(
      `缺少 ${path.join(toolchainDir, "manifest.json")}：请先 npm run toolchain:fetch（或设置 AOS_RUNNER_TOOLCHAIN_DIR）`
    );
    process.exit(2);
  }
}

if (!partial) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, dereference: true, filter });
const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (archive.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archive, "-d", dest], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  }
}

function moveSingleTop(from, to, label) {
  const entries = fs.readdirSync(from).filter((name) => name !== "__MACOSX");
  if (entries.length !== 1) {
    throw new Error(`${label} 解压后顶层不是单个目录：${entries.join(", ")}`);
  }
  fs.renameSync(path.join(from, entries[0]), to);
}

function installTool(target, tool, filename, destination) {
  const source = path.join(toolchainDir, "files", filename);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少工具包 ${source}；请先 npm run toolchain:fetch`);
  }
  const temp = path.join(outDir, `.extract-${target.platform}-${tool}`);
  fs.rmSync(temp, { recursive: true, force: true });
  extract(source, temp);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  moveSingleTop(temp, destination, filename);
  fs.rmSync(temp, { recursive: true, force: true });
  return filename;
}

const manifest = [];

for (const target of targets) {
  const platformKey = `${target.platform}-${target.arch}`;
  const stem = `mobile-testing-runner-${pkg.version}-${platformKey}`;
  const staging = path.join(outDir, stem);
  const toolsDir = path.join(staging, "tools");
  fs.mkdirSync(staging, { recursive: true });
  copy(path.join(root, "dist"), path.join(staging, "dist"));
  for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
    if (fs.existsSync(path.join(root, file))) {
      copy(path.join(root, file), path.join(staging, file));
    }
  }
  copy(path.join(root, "node_modules"), path.join(staging, "node_modules"), (src) => {
    if (target.platform === "darwin") return true;
    return !src.split(path.sep).includes("fsevents");
  });

  const withTools = target.tools && !appOnly;
  const installed = [];
  if (withTools) {
    const wanted = toolchainEntries.filter((entry) => entry.platform === platformKey);
    const byTool = new Map(wanted.map((entry) => [entry.tool, entry]));
    for (const tool of ["node", "adb", "jdk", "maestro"]) {
      const entry = byTool.get(tool);
      if (entry === undefined) {
        throw new Error(`工具链缺少 ${platformKey} 的 ${tool}；请重新运行 npm run toolchain:fetch`);
      }
      const destinationName = tool === "adb" ? "platform-tools" : tool;
      const destination = path.join(toolsDir, destinationName);
      installed.push({
        tool,
        path: destinationName,
        name: entry.name,
        filename: installTool(target, tool, entry.filename, destination)
      });
    }
  }

  const windowsRunner = withTools
    ? '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nset "PATH=%~dp0tools\\node;%~dp0tools\\platform-tools;%~dp0tools\\jdk\\bin;%~dp0tools\\maestro\\bin;%PATH%"\r\n"%~dp0tools\\node\\node.exe" dist\\cli.js web-runner %*\r\n'
    : '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nnode dist\\cli.js web-runner %*\r\n';
  fs.writeFileSync(path.join(staging, "runner.cmd"), windowsRunner, "utf8");

  const unixRunner = withTools
    ? `#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$ROOT/tools/node/bin:$ROOT/tools/platform-tools:$ROOT/tools/jdk/bin:$ROOT/tools/jdk/Contents/Home/bin:$ROOT/tools/maestro/bin:$PATH"
if [ -d "$ROOT/tools/jdk/Contents/Home" ]; then export JAVA_HOME="$ROOT/tools/jdk/Contents/Home"; fi
exec "$ROOT/tools/node/bin/node" dist/cli.js web-runner "$@"
`
    : `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
exec node dist/cli.js web-runner "$@"
`;
  fs.writeFileSync(path.join(staging, "runner.sh"), unixRunner, {
    encoding: "utf8",
    mode: 0o755
  });

  const toolchainSection = withTools
    ? `## 内置工具

本包已包含并自动加入 PATH：

${installed.map((entry) => `- ${entry.name}（\`tools/${entry.path}\`）`).join("\n")}

无需单独安装 Node.js、adb、JDK 或 Maestro；macOS iOS 模拟器仍需 Xcode。
`
    : `## 工具

本包是 app-only，系统需自行提供 Node.js、adb、JDK、Maestro。
`;
  fs.writeFileSync(
    path.join(staging, "RUNNER.md"),
    `# mobile-testing web-runner bundle (${platformKey})

${toolchainSection}

## Windows

\`\`\`powershell
$env:AOS_HOST_ID="win-mini-01"
$env:AOS_RUNNER_CONTROL_URL="http://<center>:8765"
$env:MOBILE_TESTING_RUNNER_JOB_TOKEN="<runner-token>"
.\\runner.cmd --name win-mini-01
\`\`\`

## macOS / Linux

\`\`\`bash
export AOS_HOST_ID=mac-mini-01
export AOS_RUNNER_CONTROL_URL=http://<center>:8765
export MOBILE_TESTING_RUNNER_JOB_TOKEN=<runner-token>
./runner.sh --name mac-mini-01
\`\`\`
`,
    "utf8"
  );

  const filename = `${stem}.${target.archive}`;
  const archive = path.join(outDir, filename);
  fs.rmSync(archive, { force: true });
  if (target.archive === "zip") {
    execFileSync("zip", ["-qr", archive, stem], { cwd: outDir, stdio: "inherit" });
  } else {
    execFileSync("tar", ["-czf", archive, "-C", outDir, stem], { stdio: "inherit" });
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const sha256 = hashFile(archive);
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${filename}\n`, "utf8");
  manifest.push({
    platform: target.platform,
    arch: target.arch,
    filename,
    size: fs.statSync(archive).size,
    sha256,
    includesTools: withTools,
    tools: installed.map((entry) => ({ tool: entry.tool, name: entry.name })),
    url: `/panel/runner-bundle?platform=${target.platform}&arch=${target.arch}`
  });
  console.log(`${filename}  ${sha256}${withTools ? "  [tools included]" : ""}`);
}

let finalManifest = manifest;
if (partial) {
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    if (Array.isArray(existing)) {
      const replaced = new Set(manifest.map((entry) => `${entry.platform}-${entry.arch}`));
      finalManifest = [
        ...existing.filter((entry) => !replaced.has(`${entry.platform}-${entry.arch}`)),
        ...manifest
      ];
    }
  } catch {
    /* partial build without prior manifest */
  }
}
fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");
console.log(`manifest: ${path.join(outDir, "manifest.json")}`);
