#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const iosGuidePath = path.join(root, "docs", "runner-ios-real-device.md");
const iosGuide = fs.existsSync(iosGuidePath)
  ? fs.readFileSync(iosGuidePath, "utf8").trim()
  : "";
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
  const nativeDoc = path.join(root, "docs", "android-mcp-native-testing.md");
  if (fs.existsSync(nativeDoc)) {
    fs.mkdirSync(path.join(staging, "docs"), { recursive: true });
    fs.copyFileSync(nativeDoc, path.join(staging, "docs", "android-mcp-native-testing.md"));
  }
  copy(path.join(root, "dist"), path.join(staging, "dist"));
  for (const file of ["package.json", "package-lock.json", "LICENSE"]) {
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
    ? '@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\ncd /d "%~dp0"\r\nif not exist "%~dp0node_modules\\jsonc-parser\\package.json" (\r\n  echo [错误] 安装包不完整：缺少 node_modules。请重新完整解压 zip，不要只复制 dist。\r\n  exit /b 2\r\n)\r\nset "PATH=%~dp0tools\\node;%~dp0tools\\platform-tools;%~dp0tools\\jdk\\bin;%~dp0tools\\maestro\\bin;%PATH%"\r\nif not defined MOBILE_TESTING_RUNNER_CONTROL_URL if defined AOS_RUNNER_CONTROL_URL set "MOBILE_TESTING_RUNNER_CONTROL_URL=%AOS_RUNNER_CONTROL_URL%"\r\nif not defined MOBILE_TESTING_PANEL_BASE_URL if defined MOBILE_TESTING_RUNNER_CONTROL_URL set "MOBILE_TESTING_PANEL_BASE_URL=%MOBILE_TESTING_RUNNER_CONTROL_URL%"\r\n"%~dp0tools\\node\\node.exe" dist\\cli.js web-runner %*\r\n'
    : '@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\ncd /d "%~dp0"\r\nif not exist "%~dp0node_modules\\jsonc-parser\\package.json" (\r\n  echo [错误] 安装包不完整：缺少 node_modules。请重新完整解压 zip，不要只复制 dist。\r\n  exit /b 2\r\n)\r\nif not defined MOBILE_TESTING_RUNNER_CONTROL_URL if defined AOS_RUNNER_CONTROL_URL set "MOBILE_TESTING_RUNNER_CONTROL_URL=%AOS_RUNNER_CONTROL_URL%"\r\nif not defined MOBILE_TESTING_PANEL_BASE_URL if defined MOBILE_TESTING_RUNNER_CONTROL_URL set "MOBILE_TESTING_PANEL_BASE_URL=%MOBILE_TESTING_RUNNER_CONTROL_URL%"\r\nnode dist\\cli.js web-runner %*\r\n';
  if (windowsRunner.includes("node_modulesjsonc-parser")) {
    throw new Error("runner.cmd 路径转义错误：node_modules 检查缺少反斜杠");
  }
  fs.writeFileSync(path.join(staging, "runner.cmd"), windowsRunner, "utf8");

  const unixRunner = withTools
    ? `#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$ROOT/tools/node/bin:$ROOT/tools/platform-tools:$ROOT/tools/jdk/bin:$ROOT/tools/jdk/Contents/Home/bin:$ROOT/tools/maestro/bin:$PATH"
if [ -z "\${MOBILE_TESTING_RUNNER_CONTROL_URL:-}" ] && [ -n "\${AOS_RUNNER_CONTROL_URL:-}" ]; then export MOBILE_TESTING_RUNNER_CONTROL_URL="$AOS_RUNNER_CONTROL_URL"; fi
if [ -z "\${AOS_PANEL_BASE_URL:-}" ] && [ -n "\${MOBILE_TESTING_RUNNER_CONTROL_URL:-}" ]; then export AOS_PANEL_BASE_URL="$MOBILE_TESTING_RUNNER_CONTROL_URL"; fi
if [ ! -f "$ROOT/node_modules/jsonc-parser/package.json" ]; then
  echo "[错误] 安装包不完整：缺少 node_modules。请重新完整解压。" >&2
  exit 2
fi
if [ -d "$ROOT/tools/jdk/Contents/Home" ]; then export JAVA_HOME="$ROOT/tools/jdk/Contents/Home"; fi
exec "$ROOT/tools/node/bin/node" dist/cli.js web-runner "$@"
`
    : `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -f "node_modules/jsonc-parser/package.json" ]; then
  echo "[错误] 安装包不完整：缺少 node_modules。请重新完整解压。" >&2
  exit 2
fi
if [ -z "\${MOBILE_TESTING_RUNNER_CONTROL_URL:-}" ] && [ -n "\${AOS_RUNNER_CONTROL_URL:-}" ]; then export MOBILE_TESTING_RUNNER_CONTROL_URL="$AOS_RUNNER_CONTROL_URL"; fi
if [ -z "\${AOS_PANEL_BASE_URL:-}" ] && [ -n "\${MOBILE_TESTING_RUNNER_CONTROL_URL:-}" ]; then export AOS_PANEL_BASE_URL="$MOBILE_TESTING_RUNNER_CONTROL_URL"; fi
exec node dist/cli.js web-runner "$@"
`;
  fs.writeFileSync(path.join(staging, "runner.sh"), unixRunner, {
    encoding: "utf8",
    mode: 0o755
  });

  const installedNote = withTools
    ? "本包内置 Node.js、adb、JDK、Maestro。**MCP 原生执行只需要 adb**；JDK/Maestro 仅供下面的 legacy Maestro web-runner 使用。"
    : "本包是 app-only，需要系统已安装 Node.js、adb、JDK、Maestro。**MCP 原生执行只需要 adb**。";
  const mcpGuide = [
    "## 一、Android 真机（MCP 原生，推荐）",
    "",
    "**只需要 adb。** 不需要启动 `runner.cmd`，不需要 JDK/Maestro。",
    "",
    "1. 设备 USB 插在 Windows/macOS 宿主，确认已授权 USB 调试：",
    "   ```powershell",
    "   .\\tools\\platform-tools\\adb.exe devices",
    "   ```",
    "   能看到设备 serial（如 `10CF6609P900059    device`）。",
    "",
    "2. 停掉旧 adb server，再启动监听所有网卡的 server（Windows 示例）：",
    "   ```powershell",
    "   .\\tools\\platform-tools\\adb.exe kill-server",
    "   .\\tools\\platform-tools\\adb.exe -a -P 5037 server nodaemon",
    "   ```",
    "   这个窗口保持开着。`-a` 不能省；否则只监听 `127.0.0.1`。",
    "",
    "3. 确认监听地址：",
    "   ```powershell",
    "   Get-NetTCPConnection -LocalPort 5037 -State Listen",
    "   ```",
    "   `LocalAddress` 必须是 `0.0.0.0`。如果启动时报 `10048`，说明 5037 被旧进程占用：先停 runner，查 `OwningProcess`，`Stop-Process -Id <PID> -Force`，再重试。",
    "",
    "4. 防火墙只放行 MCP 服务所在机器（管理员 PowerShell）：",
    "   ```powershell",
    "   New-NetFirewallRule -DisplayName \"adb-mac-aos\" `",
    "     -Direction Inbound -Protocol TCP -LocalPort 5037 `",
    "     -RemoteAddress <MCP服务IP> -Profile Any -Action Allow",
    "   ```",
    "   跨网/不想暴露端口时改用 SSH 隧道：`ssh -L 5037:127.0.0.1:5037 <用户>@<宿主IP>`，MCP 侧用 `tcp:127.0.0.1:5037`。",
    "",
    "5. 在 MCP 服务机器验证：",
    "   ```bash",
    "   adb -H <宿主IP> -P 5037 devices -l",
    "   ```",
    "   看到设备 serial 即成功。",
    "",
    "6. MCP 项目配置（二选一）：",
    "   - 项目 `.env`：`ADB_SERVER_SOCKET=tcp:<宿主IP>:5037`",
    "   - `aos.config.jsonc`：`\"deviceHosts\": { \"android\": { \"adbHost\": \"<宿主IP>:5037\" } }`",
    "   重启 MCP 服务后，`doctor` / `aos_status.deviceHosts` 应显示 adb 宿主可达。",
    "",
    "7. 运行：`mobile_run_task`（单条）或 `run_regression`（Excel）。不再需要 Maestro。",
    "",
    "> 只做 MCP 原生时，不必下载这个 600MB 兼容包：面板「设备 → 接入执行机」的 **Windows adb-host 小包**（约 8MB，只含 platform-tools）就够用；也可从依赖工具页只取 platform-tools。完整排障见包内 `docs/android-mcp-native-testing.md`。",
    "",
    "> 下面的 Maestro web-runner 仅保留给已有脚本任务兼容；Android 新接入不再推荐。"
  ].join("\n");
  const platformGuide =
    target.platform === "win32"
      ? `## Legacy: Maestro web-runner（Windows）

1. 解压本包。
2. 设置环境变量：
   - \`MOBILE_TESTING_HOST_ID=win-mini-01\`
   - \`MOBILE_TESTING_RUNNER_CONTROL_URL=http://<中心IP>:8765\`
   - \`MOBILE_TESTING_PANEL_BASE_URL=http://<中心IP>:8765\`
   - \`MOBILE_TESTING_RUNNER_JOB_TOKEN=<runner-token>\`
3. 启动：\`.\\runner.cmd --name win-mini-01\`
4. 打开中心「设备」页，确认机器出现。`
      : target.platform === "darwin"
        ? `## Legacy: Maestro web-runner（macOS）

1. 解压本包。
2. 设置环境变量：
   - \`MOBILE_TESTING_HOST_ID=mac-mini-01\`
   - \`MOBILE_TESTING_RUNNER_CONTROL_URL=http://<中心IP>:8765\`
   - \`MOBILE_TESTING_PANEL_BASE_URL=http://<中心IP>:8765\`
   - \`MOBILE_TESTING_RUNNER_JOB_TOKEN=<runner-token>\`
3. 启动：\`./runner.sh --name mac-mini-01\`
4. 打开中心「设备」页，确认机器出现。`
        : `## Legacy: Maestro web-runner（Linux）

1. 解压本包。
2. 设置环境变量：
   - \`MOBILE_TESTING_HOST_ID=linux-runner-01\`
   - \`MOBILE_TESTING_RUNNER_CONTROL_URL=http://<中心IP>:8765\`
   - \`MOBILE_TESTING_PANEL_BASE_URL=http://<中心IP>:8765\`
   - \`MOBILE_TESTING_RUNNER_JOB_TOKEN=<runner-token>\`
3. 启动：\`./runner.sh --name linux-runner-01\`
4. 打开中心「设备」页，确认机器出现。`;
  fs.writeFileSync(
    path.join(staging, "README.md"),
    `# mobile-testing Android 设备宿主接入

本包有两种用途：

- **MCP 原生（推荐）**：Mac 上的 MCP 服务通过 adb 直接操作设备；只使用 adb，不启动 runner，不需要 JDK/Maestro。
- **Legacy Maestro web-runner**：只在已有网页测试任务需要兼容时使用。

${installedNote}

${mcpGuide}

${platformGuide}

${iosGuide}

> 解压完整包，不要只复制 \`dist\`；缺少 \`node_modules\` 时 runner 会提示安装包不完整。
> 注意：\`MOBILE_TESTING_RUNNER_JOB_TOKEN\` 是执行机令牌，不是面板登录 token。
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
