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
const bundleCenterUrl =
  (process.env.AOS_MCP_RUNNER_CENTER_URL ?? "").trim() || "http://<中心IP>:8765";
const bundleHostId = (process.env.AOS_MCP_RUNNER_HOST_ID ?? "").trim();
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

function writeProject(staging, target) {
  const hostId =
    bundleHostId || (target.platform === "win32" ? "win-runner-01" : "mac-runner-01");
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
      "# 中心控制面（编辑 URL、填 runner token；token 向中心管理员获取）",
      `MOBILE_TESTING_RUNNER_CONTROL_URL=${bundleCenterUrl}`,
      "MOBILE_TESTING_RUNNER_JOB_TOKEN=",
      `MOBILE_TESTING_HOST_ID=${hostId}`,
      "",
      "# runner 不需要本机 LLM key：从中心 LLM 代理获取（AOS_LLM_FROM_CENTER=1，真实 key 不出中心）",
      "# 仅当中心不可用、需要本机兜底时才填下面四项",
      "# AOS_LLM_NAME=deepseek",
      "# AOS_LLM_MODEL=deepseek-flash",
      "# AOS_LLM_BASE_URL=https://api.deepseek.com/v1",
      "# AOS_LLM_API_KEY=",
      "",
      "# runner 不需要 pen CLI（启动脚本已设置）",
      "# AOS_PEN_SKIP=1",
      "# AOS_PEN_NO_INSTALL=1",
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
      'set "AOS_PEN_SKIP=1"',
      'set "AOS_PEN_NO_INSTALL=1"',
      'set "AOS_LLM_FROM_CENTER=1"',
      'set "UV_PYTHON=3.12"',
      'set "UV_SYSTEM_CERTS=1"',
      'if not exist "project\\.env" copy "project\\.env.example" "project\\.env" >nul',
      'findstr /r /c:"^MOBILE_TESTING_RUNNER_JOB_TOKEN=..*" "project\\.env" >nul',
      'if errorlevel 1 echo [提示] project\\.env 的 MOBILE_TESTING_RUNNER_JOB_TOKEN 为空；请填入中心 runner token。',
      "echo [1/2] 检查环境并安装 Artemis 依赖（首次较慢，需要网络）...",
      "node dist\\cli.js doctor --install-deps",
      'if not exist "artemis\\.venv\\.aos-deps.json" (',
      "  echo [setup] Artemis 依赖未就绪；检查上面的错误（网络/Python 3.12）。",
      "  exit /b 1",
      ")",
      "echo.",
      "echo [2/2] 完成。LLM 由中心提供，无需填写 key；运行 doctor.cmd 体检。",
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
      'set "AOS_PEN_SKIP=1"',
      'set "AOS_PEN_NO_INSTALL=1"',
      'set "AOS_LLM_FROM_CENTER=1"',
      'set "UV_PYTHON=3.12"',
      'set "UV_SYSTEM_CERTS=1"',
      'if not exist "project\\.env" (',
      "  echo [提示] 缺少 project\\.env：先运行 setup.cmd，再填入中心 runner token。",
      "  exit /b 2",
      ")",
      'findstr /r /c:"^MOBILE_TESTING_RUNNER_JOB_TOKEN=..*" "project\\.env" >nul',
      'if errorlevel 1 echo [提示] project\\.env 的 MOBILE_TESTING_RUNNER_JOB_TOKEN 为空；请填入中心 runner token。',
      "node dist\\cli.js doctor",
      ""
    ].join("\r\n"),
    "utf8"
  );
  const defaultUrl = bundleCenterUrl.includes("<") ? "http://127.0.0.1:8765" : bundleCenterUrl;
  const defaultHost = bundleHostId || "win-runner-01";
  fs.writeFileSync(
    path.join(staging, "configure.cmd"),
    [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      'cd /d "%~dp0"',
      `set "DEFAULT_URL=${defaultUrl}"`,
      `set "DEFAULT_HOST=${defaultHost}"`,
      "set /p CENTER_URL=Center URL [%DEFAULT_URL%]: ",
      'if "%CENTER_URL%"=="" set "CENTER_URL=%DEFAULT_URL%"',
      "set /p CENTER_TOKEN=Runner token: ",
      "set /p HOST_ID=Host ID [%DEFAULT_HOST%]: ",
      'if "%HOST_ID%"=="" set "HOST_ID=%DEFAULT_HOST%"',
      '> "project\\.env" echo MOBILE_TESTING_RUNNER_CONTROL_URL=%CENTER_URL%',
      '>> "project\\.env" echo MOBILE_TESTING_RUNNER_JOB_TOKEN=%CENTER_TOKEN%',
      '>> "project\\.env" echo MOBILE_TESTING_HOST_ID=%HOST_ID%',
      "echo 已写入 project\\.env",
      'if "%CENTER_TOKEN%"=="" echo [提示] runner token 为空；请重新运行 configure.cmd。',
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
      'set "AOS_PEN_SKIP=1"',
      'set "AOS_PEN_NO_INSTALL=1"',
      'set "AOS_LLM_FROM_CENTER=1"',
      'set "UV_PYTHON=3.12"',
      'set "UV_SYSTEM_CERTS=1"',
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
      'set "AOS_PEN_SKIP=1"',
      'set "AOS_PEN_NO_INSTALL=1"',
      'set "AOS_LLM_FROM_CENTER=1"',
      'set "UV_PYTHON=3.12"',
      'set "UV_SYSTEM_CERTS=1"',
      'if "%MOBILE_TESTING_HOST_ID%"=="" set "MOBILE_TESTING_HOST_ID=win-runner-01"',
      'if not exist "project\\.env" (',
      "  echo [runner] 缺少 project\\.env；先运行 configure.cmd。",
      "  exit /b 2",
      ")",
      'findstr /r /c:"^MOBILE_TESTING_RUNNER_JOB_TOKEN=..*" "project\\.env" >nul',
      "if errorlevel 1 (",
      "  echo [runner] project\\.env 的 MOBILE_TESTING_RUNNER_JOB_TOKEN 为空；先运行 configure.cmd。",
      "  exit /b 2",
      ")",
      'set "NEED_DEPS=0"',
      'if not exist "artemis\\.venv\\Scripts\\python.exe" set "NEED_DEPS=1"',
      'if not exist "artemis\\.venv\\.aos-deps.json" set "NEED_DEPS=1"',
      'if "%NEED_DEPS%"=="1" (',
      "  echo [runner] 首次启动：安装 Artemis 依赖（可能需要几分钟）...",
      "  node dist\\cli.js doctor --install-deps",
      '  if not exist "artemis\\.venv\\.aos-deps.json" (',
      "    echo [runner] Artemis 依赖未安装成功；先运行 setup.cmd 查看详情。",
      "    exit /b 2",
      "  )",
      ")",
      'node dist\\cli.js suite runner --project "%AOS_PROJECT_DIR%" --name "%MOBILE_TESTING_HOST_ID%"',
      ""
    ].join("\r\n"),
    "utf8"
  );
}

function writeMacLaunchers(staging) {
  const defaultUrl = bundleCenterUrl.includes("<") ? "http://127.0.0.1:8765" : bundleCenterUrl;
  const defaultHost = bundleHostId || "mac-runner-01";
  const configure = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
DEFAULT_URL="${defaultUrl}"
DEFAULT_HOST="${defaultHost}"
printf "Center URL [%s]: " "$DEFAULT_URL"
read CENTER_URL
CENTER_URL="\${CENTER_URL:-$DEFAULT_URL}"
printf "Runner token: "
read CENTER_TOKEN
printf "Host ID [%s]: " "$DEFAULT_HOST"
read HOST_ID
HOST_ID="\${HOST_ID:-$DEFAULT_HOST}"
{
  echo "MOBILE_TESTING_RUNNER_CONTROL_URL=$CENTER_URL"
  echo "MOBILE_TESTING_RUNNER_JOB_TOKEN=$CENTER_TOKEN"
  echo "MOBILE_TESTING_HOST_ID=$HOST_ID"
} > project/.env
echo "已写入 project/.env"
if [ -z "$CENTER_TOKEN" ]; then
  echo "[提示] runner token 为空；请重新运行 configure.command。"
fi
`;
  const setup = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
export AOS_PEN_SKIP=1
export AOS_PEN_NO_INSTALL=1
export AOS_LLM_FROM_CENTER=1
export UV_PYTHON=3.12
export UV_SYSTEM_CERTS=1
[ -f "$ROOT/project/.env" ] || cp "$ROOT/project/.env.example" "$ROOT/project/.env"
if ! grep -Eq '^MOBILE_TESTING_RUNNER_JOB_TOKEN=.+' "$ROOT/project/.env"; then
  echo "[提示] project/.env 的 MOBILE_TESTING_RUNNER_JOB_TOKEN 为空；请填入中心 runner token。"
fi
node dist/cli.js doctor --install-deps
if [ ! -f "$ROOT/artemis/.venv/.aos-deps.json" ]; then
  echo "[setup] Artemis 依赖未就绪；检查上面的错误（网络/Python 3.12）。"
  exit 1
fi
echo
echo "完成。LLM 由中心提供，无需填写 key；运行 doctor.command 体检。"
`;
  const doctor = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
export AOS_PEN_SKIP=1
export AOS_PEN_NO_INSTALL=1
export AOS_LLM_FROM_CENTER=1
export UV_PYTHON=3.12
export UV_SYSTEM_CERTS=1
if [ ! -f "$ROOT/project/.env" ]; then
  echo "[提示] 缺少 project/.env：先运行 setup.command，再填入中心 runner token。"
  exit 2
fi
if ! grep -Eq '^MOBILE_TESTING_RUNNER_JOB_TOKEN=.+' "$ROOT/project/.env"; then
  echo "[提示] project/.env 的 MOBILE_TESTING_RUNNER_JOB_TOKEN 为空；请填入中心 runner token。"
fi
node dist/cli.js doctor
`;
  const smoke = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
export AOS_PEN_SKIP=1
export AOS_PEN_NO_INSTALL=1
export AOS_LLM_FROM_CENTER=1
export UV_PYTHON=3.12
export UV_SYSTEM_CERTS=1
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
export AOS_PEN_SKIP=1
export AOS_PEN_NO_INSTALL=1
export AOS_LLM_FROM_CENTER=1
export UV_PYTHON=3.12
export UV_SYSTEM_CERTS=1
: "\${MOBILE_TESTING_HOST_ID:=mac-runner-01}"
export MOBILE_TESTING_HOST_ID
if [ ! -f "$ROOT/project/.env" ]; then
  echo "[runner] 缺少 project/.env；先运行 configure.command。"
  exit 2
fi
if ! grep -Eq '^MOBILE_TESTING_RUNNER_JOB_TOKEN=.+' "$ROOT/project/.env"; then
  echo "[runner] project/.env 的 MOBILE_TESTING_RUNNER_JOB_TOKEN 为空；先运行 configure.command。"
  exit 2
fi
if [ ! -x "$ROOT/artemis/.venv/bin/python" ] || [ ! -f "$ROOT/artemis/.venv/.aos-deps.json" ]; then
  echo "[runner] 首次启动：安装 Artemis 依赖（可能需要几分钟）..."
  node dist/cli.js doctor --install-deps || true
  if [ ! -f "$ROOT/artemis/.venv/.aos-deps.json" ]; then
    echo "[runner] Artemis 依赖未安装成功；先运行 setup.command 查看详情。"
    exit 2
  fi
fi
node dist/cli.js suite runner --project "$AOS_PROJECT_DIR" --name "$MOBILE_TESTING_HOST_ID"
`;
  for (const [name, body] of [
    ["configure.command", configure],
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
  const troubleshooting =
    target.platform === "win32"
      ? [
          "## 首次安装依赖失败（Windows）",
          "",
          "`runner.cmd` 首次会自动执行 `doctor --install-deps`（`uv sync`）。启动脚本已固定 `UV_PYTHON=3.12`；如果 `uv` 仍选 3.13，先 `uv python find 3.12` 确认能定位 Python 3.12。",
          "",
          "如果访问 `pypi.org` 超时：删除半装的 venv，换可达镜像后重试。若报 `invalid peer certificate: UnknownIssuer`（公司 TLS 拦截/Zscaler），设置 `UV_SYSTEM_CERTS=1` 使用 Windows 系统证书（启动脚本已默认设置）：",
          "",
          "```powershell",
          "Remove-Item -Recurse -Force .\\artemis\\.venv",
          '$env:UV_PYTHON="3.12"',
          '$env:UV_SYSTEM_CERTS="1"',
          '$env:UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"',
          '$env:UV_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"',
          ".\\runner.cmd",
          "```",
          "",
          "也可用阿里云 `https://mirrors.aliyun.com/pypi/simple/` 或公司内部镜像。成功标志：`artemis\\.venv\\.aos-deps.json` 存在；`runner.cmd` 用它判断依赖就绪，安装失败不会启动。",
          ""
        ].join("\n")
      : [
          "## 首次安装依赖失败（macOS）",
          "",
          "`runner.command` 首次会自动执行 `doctor --install-deps`。启动脚本已固定 `UV_PYTHON=3.12`。",
          "",
          "如果访问 `pypi.org` 超时或报 `invalid peer certificate: UnknownIssuer`（公司 TLS 拦截），删除半装的 venv，设置系统证书/镜像后重试：",
          "",
          "```sh",
          "rm -rf artemis/.venv",
          "export UV_PYTHON=3.12",
          "export UV_SYSTEM_CERTS=1",
          "export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple",
          "export UV_INDEX_URL=$UV_DEFAULT_INDEX",
          "./runner.command",
          "```",
          "",
          "成功标志：`artemis/.venv/.aos-deps.json` 存在；`runner.command` 用它判断依赖就绪，安装失败不会启动。",
          ""
        ].join("\n");
  fs.writeFileSync(
    path.join(staging, "README.md"),
    [
      `# mobile-testing MCP runner（${platform}）`,
      "",
      "这个包在**执行机本机**运行 MCP 执行代码：中心只下发任务，runner 领取后用本机设备执行并回传结果。",
      "不需要 Maestro、JDK，也不需要中心反向连本机 adb。",
      "",
      "包里保留了 MCP 服务的 pen 设计集成代码（`dist/pen/`），但 runner 不需要 pen CLI；启动脚本设置 `AOS_PEN_SKIP=1` 与 `AOS_PEN_NO_INSTALL=1`，doctor 不会检查或安装 pen。",
      "",
      "## 前置",
      "",
      "- Node.js 20+（推荐 22/24）",
      "- `uv`（Python 3.12 由 uv 管理）",
      "- 中心已配置 active LLM；runner 通过中心 LLM 代理使用（真实 key 不出中心），不要求本机填 key",
      "- Android：本机 adb 可见设备",
      "- iOS（仅 macOS）：Xcode、Appium + xcuitest、签名团队、iOS 18+ Remote XPC 隧道",
      "",
      "## 启动",
      "",
      target.platform === "win32"
        ? "1. `configure.cmd` 填中心 URL/token（或直接编辑 `project\\.env`）\n2. `runner.cmd` 常驻领取；首次会自动安装 Artemis 依赖（也可先 `setup.cmd`）\n3. `doctor.cmd` / `smoke.cmd` 可选：体检与单条验证（**不需要填 LLM key**）"
        : "1. `./configure.command` 填中心 URL/token（或直接编辑 `project/.env`）\n2. `./runner.command` 常驻领取；首次会自动安装 Artemis 依赖（也可先 `setup.command`）\n3. `./doctor.command` / `./smoke.command` 可选：体检与单条验证（**不需要填 LLM key**）",
      "",
      troubleshooting,
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
      "runner 连接中心使用 HTTP 控制面（写进 `project/.env` 即可，进程 env 优先）：",
      "",
      "- `MOBILE_TESTING_RUNNER_CONTROL_URL=http://<中心>:8765` + `MOBILE_TESTING_RUNNER_JOB_TOKEN=<token>`",
      "",
      "跨主机 runner 还需要：",
      "",
      "- 中心打开 `AOS_RUNNER_SHARED_LLM=1`（允许 runner 取中心 LLM 代理；单机队/受控内网，多租户不要开）",
      "- 中心设置 `AOS_RUNNER_DEFAULT_PROJECT=<中心项目根路径>`（项目路径只存在中心，runner 不需要知道）",
      "- 回归任务：中心随任务下发 tests.json/flows，runner 自动落本地 case-sets；不需要手动复制项目",
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

  writeProject(staging, target);
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
