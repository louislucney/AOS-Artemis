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
const targets = [
  {
    platform: "win32",
    arch: "x64",
    platformKey: "win32-x64",
    archive: "zip",
    script: "start-adb-host.ps1"
  },
  {
    platform: "darwin",
    arch: "arm64",
    platformKey: "darwin-arm64",
    archive: "zip",
    script: "start-adb-host.sh"
  }
];
const platformArg = process.argv.find((arg) => arg.startsWith("--platform="))?.split("=")[1] ?? "";
const selectedTargets =
  platformArg === ""
    ? targets
    : targets.filter((target) => `${target.platform}-${target.arch}` === platformArg);
if (selectedTargets.length === 0) {
  console.error(`未知平台 ${platformArg}（支持 win32-x64 / darwin-arm64）`);
  process.exit(2);
}
const partial = platformArg !== "";

const toolchainManifestPath = path.join(toolchainDir, "manifest.json");
if (!fs.existsSync(toolchainManifestPath)) {
  console.error(`缺少 ${toolchainManifestPath}：请先 npm run toolchain:fetch`);
  process.exit(2);
}
const toolchainManifest = JSON.parse(fs.readFileSync(toolchainManifestPath, "utf8"));
const adbEntries = Array.isArray(toolchainManifest.entries)
  ? toolchainManifest.entries.filter((entry) => entry && entry.tool === "adb")
  : [];
if (adbEntries.length === 0) {
  console.error("toolchain manifest 中没有 adb（platform-tools）条目");
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (archive.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archive, "-d", dest], { stdio: "inherit" });
    return;
  }
  execFileSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
}

function moveSingleTop(from, to, label) {
  const entries = fs.readdirSync(from).filter((name) => name !== "__MACOSX");
  if (entries.length !== 1) {
    throw new Error(`${label} 解压后顶层不是单个目录：${entries.join(", ")}`);
  }
  fs.renameSync(path.join(from, entries[0]), to);
}

function renderReadme(target) {
  if (target.platform === "darwin") return renderReadmeMac();
  const adb = ".\\platform-tools\\adb.exe";
  const start = ".\\start-adb-host.ps1";
  const firewall = `   \`\`\`powershell
   .\\firewall-add.ps1 -AllowFrom <MCP服务IP>
   \`\`\``;
  return [
    "# mobile-testing adb-host（MCP 原生）",
    "",
    "这个包只做一件事：让 Mac 上的 mobile-testing MCP 服务通过 adb 操作插在这台机器上的 Android 设备。",
    "",
    "**不需要 Node.js、JDK、Maestro，也不需要启动 `runner.cmd`。**",
    "",
    "## 1. 连接设备",
    "",
    "USB 连接 Android 设备，开启 USB 调试，确认：",
    "",
    "```powershell",
    `${adb} devices`,
    "```",
    "",
    "看到设备 serial（如 `10CF6609P900059    device`）即可。",
    "",
    "## 2. 启动 adb server（监听所有网卡）",
    "",
    "```powershell",
    start,
    "```",
    "",
    "这个窗口保持开着。脚本等价于：",
    "",
    "```powershell",
    `${adb} kill-server`,
    `${adb} -a -P 5037 server nodaemon`,
    "```",
    "",
    "确认监听地址：",
    "",
    "```powershell",
    "Get-NetTCPConnection -LocalPort 5037 -State Listen",
    "```",
    "",
    "`LocalAddress` 必须是 `0.0.0.0`。如果启动时报 `10048`，说明 5037 被旧进程占用：先停 runner，查 `OwningProcess`，`Stop-Process -Id <PID> -Force`，再重试。",
    "",
    "## 3. 放行 MCP 服务所在机器",
    "",
    "**仅限可信网络**；adb 没有鉴权。管理员 PowerShell：",
    "",
    firewall,
    "",
    "跨网/不想暴露端口时改用 SSH 隧道：`ssh -L 5037:127.0.0.1:5037 <用户>@<宿主IP>`，MCP 侧用 `tcp:127.0.0.1:5037`。",
    "",
    "## 4. 在 MCP 服务机器验证",
    "",
    "```bash",
    "adb -H <宿主IP> -P 5037 devices -l",
    "```",
    "",
    "看到设备 serial 即成功。",
    "",
    "## 5. 配置项目",
    "",
    "二选一：",
    "",
    "- 项目 `.env`：`ADB_SERVER_SOCKET=tcp:<宿主IP>:5037`",
    "- `aos.config.jsonc`：`\"deviceHosts\": { \"android\": { \"adbHost\": \"<宿主IP>:5037\" } }`",
    "",
    "重启 MCP 服务后，`doctor` / `aos_status.deviceHosts` 应显示 adb 宿主可达。",
    "",
    "## 6. 运行",
    "",
    "`mobile_run_task`（单条）或 `run_regression`（Excel）。不再需要 Maestro。",
    "",
    "完整排障见包内 `docs/android-mcp-native-testing.md`。",
    "",
    "## 本机示例",
    "",
    "| 项 | 示例 |",
    "|---|---|",
    "| MCP 服务（Mac） | `192.168.102.165` |",
    "| 设备宿主（Windows） | `192.168.102.178` |",
    "| Android 设备 | `10CF6609P900059` |",
    "",
    "Mac 验证：",
    "",
    "```bash",
    "adb -H 192.168.102.178 -P 5037 devices -l",
    "```",
    "",
    "项目 `.env`：",
    "",
    "```dotenv",
    "ADB_SERVER_SOCKET=tcp:192.168.102.178:5037",
    "```",
    ""
  ].join("\n");
}

function renderReadmeMac() {
  return [
    "# mobile-testing adb-host（macOS / MCP 原生）",
    "",
    "这个包提供 Android platform-tools（adb），用于 **远程 macOS 设备宿主**：手机插在这台 Mac 上，MCP 服务在另一台机器。",
    "",
    "**如果手机直接插在 MCP 服务所在的 Mac 上，不需要本包**：系统 adb 即可，MCP 本机直接可见设备。",
    "",
    "**不需要 Node.js、JDK、Maestro 或 runner。**",
    "",
    "## 1. 连接设备",
    "",
    "```bash",
    "./platform-tools/adb devices",
    "```",
    "",
    "看到设备 serial（如 `10CF6609P900059    device`）即可。",
    "",
    "## 2. 启动 adb server（监听所有网卡）",
    "",
    "```bash",
    "chmod +x ./start-adb-host.sh   # 首次",
    "./start-adb-host.sh",
    "```",
    "",
    "窗口保持开着。脚本等价于：",
    "",
    "```bash",
    "./platform-tools/adb kill-server",
    "./platform-tools/adb -a -P 5037 server nodaemon",
    "```",
    "",
    "确认监听：",
    "",
    "```bash",
    "lsof -nP -iTCP:5037 -sTCP:LISTEN",
    "```",
    "",
    "应显示 `*:5037` 或 `0.0.0.0:5037`；如果只有 `127.0.0.1:5037`，说明没带 `-a`。",
    "",
    "## 3. 网络与安全",
    "",
    "优先 SSH 隧道（MCP 侧 `ssh -L 5037:127.0.0.1:5037 <用户>@<这台Mac>`）；LAN 暴露时用 macOS 防火墙限制来源 IP。adb 没有鉴权。",
    "",
    "## 4. MCP 项目配置",
    "",
    "二选一：",
    "",
    "- 项目 `.env`：`ADB_SERVER_SOCKET=tcp:<这台Mac的IP>:5037`",
    "- `aos.config.jsonc`：`\"deviceHosts\": { \"android\": { \"adbHost\": \"<这台Mac的IP>:5037\" } }`",
    "",
    "重启 MCP 服务后，`doctor` / `aos_status.deviceHosts` 应显示 adb 宿主可达。",
    "",
    "## 5. 运行",
    "",
    "`mobile_run_task`（单条）或 `run_regression`（Excel；`appPath` 可安装 APK）。不需要 Maestro。",
    "",
    "完整排障见包内 `docs/android-mcp-native-testing.md`。",
    ""
  ].join("\n");
}

function renderMacStart() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
    "ADB=\"$ROOT/platform-tools/adb\"",
    "[ -x \"$ADB\" ] || { echo \"缺少 platform-tools/adb\"; exit 2; }",
    "\"$ADB\" kill-server || true",
    "exec \"$ADB\" -a -P 5037 server nodaemon",
    ""
  ].join("\n");
}

function renderWindowsStart() {
  return [
    "$ErrorActionPreference = \"Stop\"",
    "$root = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$adb = Join-Path $root \"platform-tools\\adb.exe\"",
    "if (!(Test-Path $adb)) { Write-Error \"缺少 platform-tools\\adb.exe\"; exit 2 }",
    "& $adb kill-server",
    "& $adb -a -P 5037 server nodaemon",
    ""
  ].join("\r\n");
}

const manifest = [];

for (const target of selectedTargets) {
  const stem = `mobile-testing-adb-host-${pkg.version}-${target.platformKey}`;
  const staging = path.join(outDir, stem);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const entry = adbEntries.find((candidate) => candidate.platform === target.platformKey);
  if (entry === undefined) {
    throw new Error(`toolchain manifest 缺少 ${target.platformKey} 的 adb 条目`);
  }
  const source = path.join(toolchainDir, "files", entry.filename);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少工具包 ${source}；请先 npm run toolchain:fetch`);
  }
  const temp = path.join(outDir, `.extract-adb-${target.platformKey}`);
  fs.rmSync(temp, { recursive: true, force: true });
  extract(source, temp);
  moveSingleTop(temp, path.join(staging, "platform-tools"), entry.filename);
  fs.rmSync(temp, { recursive: true, force: true });

  const doc = path.join(root, "docs", "android-mcp-native-testing.md");
  if (fs.existsSync(doc)) {
    fs.mkdirSync(path.join(staging, "docs"), { recursive: true });
    fs.copyFileSync(doc, path.join(staging, "docs", "android-mcp-native-testing.md"));
  }

  fs.writeFileSync(path.join(staging, "README.md"), renderReadme(target), "utf8");
  if (target.platform === "win32") {
    fs.writeFileSync(path.join(staging, "start-adb-host.ps1"), renderWindowsStart(), "utf8");
    fs.writeFileSync(
      path.join(staging, "firewall-add.ps1"),
      [
        "param([Parameter(Mandatory=$true)][string]$AllowFrom)",
        "New-NetFirewallRule -DisplayName \"adb-mac-aos\" -Direction Inbound -Protocol TCP -LocalPort 5037 -RemoteAddress $AllowFrom -Profile Any -Action Allow",
        ""
      ].join("\r\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(staging, "firewall-remove.ps1"),
      ["Remove-NetFirewallRule -DisplayName \"adb-mac-aos\" -ErrorAction SilentlyContinue", ""].join("\r\n"),
      "utf8"
    );
  } else {
    fs.writeFileSync(path.join(staging, "start-adb-host.sh"), renderMacStart(), {
      encoding: "utf8",
      mode: 0o755
    });
  }

  const filename = `${stem}.${target.archive}`;
  const archive = path.join(outDir, filename);
  fs.rmSync(archive, { force: true });
  execFileSync("zip", ["-qr", archive, stem], { cwd: outDir, stdio: "inherit" });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.writeFileSync(`${archive}.sha256`, `${hashFile(archive)}  ${filename}\n`, "utf8");
  manifest.push({
    platform: target.platform,
    arch: target.arch,
    filename,
    size: fs.statSync(archive).size,
    sha256: hashFile(archive),
    includesTools: true,
    url: `/panel/runner-bundle?role=adb-host&platform=${target.platform}&arch=${target.arch}`
  });
  console.log(`${filename}  ${hashFile(archive)}`);
}

let finalManifest = manifest;
if (partial) {
  try {
    const existing = JSON.parse(
      fs.readFileSync(path.join(outDir, "adb-host-manifest.json"), "utf8")
    );
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
fs.writeFileSync(
  path.join(outDir, "adb-host-manifest.json"),
  `${JSON.stringify(finalManifest, null, 2)}\n`,
  "utf8"
);
console.log(`manifest: ${path.join(outDir, "adb-host-manifest.json")}`);
