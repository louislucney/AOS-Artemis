#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
    platformTools: "platform-tools-latest-windows.zip"
  },
  {
    platform: "darwin",
    arch: "arm64",
    platformKey: "darwin-arm64",
    archive: "tar.gz",
    platformTools: "platform-tools-latest-darwin.zip"
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

if (!fs.existsSync(path.join(root, "dist", "cli.js"))) {
  console.error("缺少 dist/cli.js，请先 npm run build");
  process.exit(2);
}

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const copy = (from, to, filter) =>
  fs.cpSync(from, to, { recursive: true, dereference: true, ...(filter === undefined ? {} : { filter }) });

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("unzip", ["-q", archive, "-d", dest], { stdio: "inherit" });
}

function shouldCopyNodeModules(src) {
  const rel = path.relative(root, src);
  if (rel === "node_modules") return true;
  const parts = rel.split(path.sep);
  if (parts[1] === "fsevents" || parts[1] === ".bin" || parts[1] === "@esbuild") return false;
  return true;
}

function shouldCopyArtemis(src) {
  const rel = path.relative(path.join(root, "artemis"), src);
  if (rel === "") return true;
  const parts = rel.split(path.sep);
  const first = parts[0];
  if (
    first === ".venv" ||
    first === ".git" ||
    first === "traces" ||
    first === "playground" ||
    first === ".pytest_cache" ||
    first === "coverage"
  ) {
    return false;
  }
  if (parts.includes("__pycache__")) return false;
  if (rel.endsWith(".pyc")) return false;
  return true;
}

function writeProject(staging) {
  const projectDir = path.join(staging, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "aos.config.jsonc"),
    `${JSON.stringify({ project: { name: "mobile-testing-runner" } }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(projectDir, ".env.example"),
    [
      "# 填入真实 key 后另存为 .env（不要提交）",
      "AOS_LLM_NAME=deepseek",
      "AOS_LLM_MODEL=deepseek-flash",
      "AOS_LLM_BASE_URL=https://api.deepseek.com/v1",
      "AOS_LLM_API_KEY=",
      "",
      "# iOS 真机（仅 macOS；模拟器不需要）",
      "# AOS_IOS_XCODE_ORG_ID=",
      "# AOS_IOS_XCODE_SIGNING_ID=Apple Development",
      "# AOS_IOS_WDA_BUNDLE_ID=com.aos.mcp.wda",
      "# AOS_APPIUM_URL=http://127.0.0.1:4723",
      ""
    ].join("\n"),
    "utf8"
  );
}

function writeWindowsLaunchers(staging) {
  const project = "%~dp0project";
  const pathLine = 'set "PATH=%~dp0tools\\platform-tools;%PATH%"';
  fs.writeFileSync(
    path.join(staging, "setup.cmd"),
    [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      'cd /d "%~dp0"',
      `set "AOS_PROJECT_DIR=${project}"`,
      pathLine,
      'if not exist "project\\.env" copy "project\\.env.example" "project\\.env" >nul',
      "echo [1/2] 检查环境并安装 Artemis 依赖（首次较慢，需要网络）...",
      "node dist\\cli.js doctor --install-deps",
      "echo.",
      "echo [2/2] 完成。请编辑 project\\.env 填入 AOS_LLM_API_KEY，然后运行 doctor.cmd。",
      ""
    ].join("\r\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(staging, "doctor.cmd"),
    [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      'cd /d "%~dp0"',
      `set "AOS_PROJECT_DIR=${project}"`,
      pathLine,
      'if not exist "project\\.env" (',
      "  echo [提示] 缺少 project\\.env：先运行 setup.cmd，再填入 AOS_LLM_API_KEY。",
      "  exit /b 2",
      ")",
      "node dist\\cli.js doctor",
      ""
    ].join("\r\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(staging, "smoke.cmd"),
    [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      'cd /d "%~dp0"',
      `set "AOS_PROJECT_DIR=${project}"`,
      pathLine,
      'set "DEVICE=%~1"',
      'if "%DEVICE%"=="" set "DEVICE="',
      'set "TASK=%~2"',
      'if "%TASK%"=="" set "TASK=打开应用，截图并报告当前页面"',
      'if "%DEVICE%"=="" (',
      '  node scripts\\e2e-device.mjs "%TASK%"',
      ") else (",
      '  node scripts\\e2e-device.mjs --device "%DEVICE%" "%TASK%"',
      ")",
      ""
    ].join("\r\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(staging, "runner.cmd"),
    [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      'cd /d "%~dp0"',
      `set "AOS_PROJECT_DIR=${project}"`,
      pathLine,
      'if "%MOBILE_TESTING_HOST_ID%"=="" set "MOBILE_TESTING_HOST_ID=win-runner-01"',
      'node dist\\cli.js suite runner --project "%AOS_PROJECT_DIR%" --name "%MOBILE_TESTING_HOST_ID%"',
      ""
    ].join("\r\n"),
    "utf8"
  );
}

function writeMacLaunchers(staging) {
  const setup = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
[ -f "$ROOT/project/.env" ] || cp "$ROOT/project/.env.example" "$ROOT/project/.env"
node dist/cli.js doctor --install-deps
echo
echo "完成。请编辑 project/.env 填入 AOS_LLM_API_KEY，然后运行 doctor.command。"
`;
  const doctor = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
if [ ! -f "$ROOT/project/.env" ]; then
  echo "[提示] 缺少 project/.env：先运行 setup.command，再填入 AOS_LLM_API_KEY。"
  exit 2
fi
node dist/cli.js doctor
`;
  const smoke = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
DEVICE="\${1:-}"
TASK="\${2:-打开应用，截图并报告当前页面}"
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted 2>/dev/null | sed -n 's/.*(\\([0-9A-F-]\\{36\\}\\)) (Booted).*/\\1/p' | head -1)"
fi
if [ -z "$DEVICE" ]; then
  echo "未找到已启动的 iOS 模拟器；先 xcrun simctl boot <UDID>，或传入真机 UDID。"
  exit 2
fi
node scripts/e2e-device.mjs --device "$DEVICE" "$TASK"
`;
  const runner = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
: "\${MOBILE_TESTING_HOST_ID:=mac-runner-01}"
export MOBILE_TESTING_HOST_ID
node dist/cli.js suite runner --project "$AOS_PROJECT_DIR" --name "$MOBILE_TESTING_HOST_ID"
`;
  for (const [name, body] of [
    ["setup.command", setup],
    ["doctor.command", doctor],
    ["smoke.command", smoke],
    ["runner.command", runner]
  ]) {
    fs.writeFileSync(path.join(staging, name), body, { encoding: "utf8", mode: 0o755 });
  }
}

function writeBundleReadme(staging, target) {
  const platform = target.platform === "win32" ? "Windows" : "macOS";
  const androidLine =
    target.platform === "win32"
      ? "Android 真机：手机 USB 插本机，`tools\\platform-tools\\adb.exe devices` 能看到设备。"
      : "Android 真机（可选）：手机 USB 插本机，`tools/platform-tools/adb devices` 能看到设备。";
  const iosLine =
    target.platform === "darwin"
      ? [
          "iOS 模拟器：`xcrun simctl boot <UDID>` 后把 UDID 传给 `smoke.command`。",
          "iOS 真机：连接本机，配置 `AOS_IOS_XCODE_ORG_ID`、Appium/xcuitest，并保持 `sudo appium driver run xcuitest tunnel-creation` 运行。"
        ].join("\n")
      : "iOS 不支持 Windows：iPhone 必须连接 Mac，使用 macOS MCP runner。";
  fs.writeFileSync(
    path.join(staging, "README.md"),
    [
      `# mobile-testing MCP runner（${platform}）`,
      "",
      "这个包在**执行机本机**运行 MCP 执行代码：中心只下发任务，runner 领取后用本机设备执行并回传结果。",
      "不需要 Maestro、JDK，也不需要中心反向连本机 adb。",
      "",
      "## 前置",
      "",
      "- Node.js 20+（推荐 22/24）",
      "- `uv`（Python 3.12 由 uv 管理）",
      "- Android：本机 adb 可见设备",
      "- iOS（仅 macOS）：Xcode、Appium + xcuitest、签名团队、iOS 18+ Remote XPC 隧道",
      "",
      "## 启动",
      "",
      target.platform === "win32"
        ? "1. `setup.cmd`（首次安装 Artemis 依赖）\n2. 编辑 `project\\.env` 填入 `AOS_LLM_API_KEY`\n3. `doctor.cmd` 确认全绿\n4. `smoke.cmd [设备序列号] [任务描述]`\n5. `runner.cmd` 常驻领取中心任务"
        : "1. `./setup.command`（首次安装 Artemis 依赖）\n2. 编辑 `project/.env` 填入 `AOS_LLM_API_KEY`\n3. `./doctor.command` 确认全绿\n4. `./smoke.command [设备UDID] [任务描述]`\n5. `./runner.command` 常驻领取中心任务",
      "",
      "## 设备",
      "",
      androidLine,
      "",
      iosLine,
      "",
      "## 中心",
      "",
      "在中心创建回归任务（`suite task create` 或面板），目标平台选 android/ios，执行机指向本 runner 的主机名。",
      "",
      "runner 连接中心二选一：",
      "",
      "- HTTP 控制面：`MOBILE_TESTING_RUNNER_CONTROL_URL=http://<中心>:8765` + `MOBILE_TESTING_RUNNER_JOB_TOKEN=<token>`",
      "- 直连中心 PG：`MOBILE_TESTING_DATABASE_URL=postgres://...`",
      "",
      "未配置时 runner 只使用本机文件台账，不会领取中心任务。主机名用 `MOBILE_TESTING_HOST_ID` 指定（默认 win-runner-01 / mac-runner-01）。",
      ""
    ].join("\n"),
    "utf8"
  );
}

fs.mkdirSync(outDir, { recursive: true });
const manifest = [];
for (const target of selectedTargets) {
  const stem = `mobile-testing-mcp-runner-${pkg.version}-${target.platformKey}`;
  const staging = path.join(outDir, stem);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  copy(path.join(root, "dist"), path.join(staging, "dist"));
  for (const file of ["package.json", "package-lock.json", "README.md", ".env.example"]) {
    copy(path.join(root, file), path.join(staging, file));
  }
  fs.mkdirSync(path.join(staging, "scripts"), { recursive: true });
  for (const file of ["e2e-device.mjs", "mobile-testing-call.mjs"]) {
    copy(path.join(root, "scripts", file), path.join(staging, "scripts", file));
  }
  fs.mkdirSync(path.join(staging, "docs"), { recursive: true });
  for (const file of [
    "android-mcp-native-testing.md",
    "device-access-and-execution.md",
    "runner-ios-real-device.md"
  ]) {
    const source = path.join(root, "docs", file);
    if (fs.existsSync(source)) copy(source, path.join(staging, "docs", file));
  }
  copy(path.join(root, "node_modules"), path.join(staging, "node_modules"), shouldCopyNodeModules);
  copy(path.join(root, "artemis"), path.join(staging, "artemis"), shouldCopyArtemis);

  const toolsDir = path.join(staging, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const platformTools = path.join(toolchainDir, "files", target.platformTools);
  if (!fs.existsSync(platformTools)) {
    console.error(`缺少 ${platformTools}；请先 npm run toolchain:fetch`);
    process.exit(2);
  }
  extract(platformTools, toolsDir);

  writeProject(staging);
  if (target.platform === "win32") writeWindowsLaunchers(staging);
  else writeMacLaunchers(staging);
  writeBundleReadme(staging, target);

  const filename = `${stem}.${target.archive}`;
  const archive = path.join(outDir, filename);
  fs.rmSync(archive, { force: true });
  if (target.archive === "zip") {
    execFileSync("zip", ["-qr", archive, stem], { cwd: outDir, stdio: "inherit" });
  } else {
    execFileSync("tar", ["-czf", archive, stem], { cwd: outDir, stdio: "inherit" });
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
    includesTools: true,
    url: `/panel/runner-bundle?role=mcp-runner&platform=${target.platform}&arch=${target.arch}`
  });
  console.log(`${filename}  ${sha256}`);
}

let finalManifest = manifest;
if (partial) {
  try {
    const existing = JSON.parse(
      fs.readFileSync(path.join(outDir, "mcp-runner-manifest.json"), "utf8")
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
  path.join(outDir, "mcp-runner-manifest.json"),
  `${JSON.stringify(finalManifest, null, 2)}\n`,
  "utf8"
);
console.log(`manifest: ${path.join(outDir, "mcp-runner-manifest.json")}`);
