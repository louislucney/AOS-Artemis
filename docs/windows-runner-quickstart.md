# Windows 执行机快速接入（MCP runner / adb-host）

> **Maestro web-runner 已于 2026-11-06 移除。** Windows 现在有两种接入：**MCP runner（宿主本机执行，推荐）** 或 **adb-host（只暴露 adb，中心直连）**。Android 真机走 MCP 原生 `mobile_run_task` / `run_regression`。
>
> 场景总览见 [device-access-and-execution.md](./device-access-and-execution.md)。MCP runner 双端包见面板「设备 → 接入执行机」或 `npm run bundle:mcp-runner`；本文余下部分仍是 adb-host 的接入步骤。

## 0. MCP runner（推荐）

前置：Node 20+、`uv`、Python 3.12。下载 Windows MCP runner，解压后：

```powershell
.\configure.cmd
# Center URL: http://<中心IP>:8765
# Runner token: 中心的 MOBILE_TESTING_RUNNER_JOB_TOKEN
# Host ID: win-runner-01

.\runner.cmd
# 首次会自动 doctor --install-deps（uv sync）；装好后常驻领取
```

`doctor.cmd` / `smoke.cmd` 可选：

```powershell
.\doctor.cmd
.\smoke.cmd 10CF6609P900059 "打开 UAT Mobil Guam，点击 Register now"
```

runner 在 Windows 本机用 USB adb 执行；中心只下发任务并接收结果，不需要中心访问 5037。跨机回归时中心下发 tests.json/flows，runner 自动落本地 `case-sets`，不需要复制项目。iOS 不支持 Windows，iPhone 必须连接 Mac（用 macOS MCP runner）。

### 首次安装依赖失败（PyPI 超时 / Python 3.12）

启动脚本已固定 `UV_PYTHON=3.12`、`UV_SYSTEM_CERTS=1`。如果 `uv` 仍选 3.13，先 `uv python find 3.12`。如果访问 `pypi.org` 超时，或报 `invalid peer certificate: UnknownIssuer`（公司 TLS 拦截/Zscaler）：

```powershell
cd C:\RUNNER\aos-artemis-runner-0.2.0-win32-x64
Remove-Item -Recurse -Force .\artemis\.venv
$env:UV_PYTHON="3.12"
$env:UV_SYSTEM_CERTS="1"
$env:UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
$env:UV_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
.\runner.cmd
```

也可用阿里云 `https://mirrors.aliyun.com/pypi/simple/` 或公司内部镜像。成功标志是 `artemis\.venv\.aos-deps.json` 存在；`runner.cmd` 用它判断依赖就绪，安装失败不会启动。

### 完全离线（内置依赖包）

如果公司网络完全访问不了 PyPI，使用 `aos-artemis-runner-<version>-win32-x64-offline.zip`（约 300MB）。包内 `deps\win32-site-packages.zip` 已包含 Windows x64 / CPython 3.12 的 Artemis 依赖；`configure.cmd` 后直接 `runner.cmd`，首次自动创建 venv 并解压，不需要网络。解压后约 850MB。

完整排障见 [android-mcp-native-testing.md](./android-mcp-native-testing.md)。

## 1. 前置

- Android 真机，USB 调试已授权
- Windows 上下载 **adb-host 小包**（面板「设备 → 接入执行机」→「Windows adb-host」，约 8MB）
- MCP 服务所在机器的 IP（用于防火墙限定来源）

## 2. 解压并启动 adb

```powershell
Expand-Archive mobile-testing-adb-host-0.2.0-win32-x64.zip -DestinationPath .
cd mobile-testing-adb-host-0.2.0-win32-x64
.\start-adb-host.ps1
```

这个窗口保持开着。脚本等价于：

```powershell
.\platform-tools\adb.exe kill-server
.\platform-tools\adb.exe -a -P 5037 server nodaemon
```

确认监听地址：

```powershell
Get-NetTCPConnection -LocalPort 5037 -State Listen
```

`LocalAddress` 必须是 `0.0.0.0`。如果启动时报 `10048`，先停掉旧的 runner/adb 进程：

```powershell
Get-NetTCPConnection -LocalPort 5037 -State Listen | Select-Object LocalAddress,OwningProcess
Stop-Process -Id <PID> -Force
```

## 3. 防火墙（仅可信网络）

管理员 PowerShell，只放行 MCP 服务 IP：

```powershell
.\firewall-add.ps1 -AllowFrom <MCP服务IP>
```

跨网/不想暴露端口时改用 SSH 隧道：`ssh -L 5037:127.0.0.1:5037 <用户>@<宿主IP>`，MCP 侧用 `tcp:127.0.0.1:5037`。

## 4. Mac/MCP 服务验证

```bash
adb -H <宿主IP> -P 5037 devices -l
```

看到设备 serial 即成功。

## 5. 项目配置

二选一：

```dotenv
ADB_SERVER_SOCKET=tcp:<宿主IP>:5037
```

```jsonc
{
  "deviceHosts": {
    "android": { "adbHost": "<宿主IP>:5037" }
  }
}
```

重启 MCP 服务后，`doctor` / `aos_status.deviceHosts` 应显示 adb 宿主可达。

## 6. 运行

- 单条：`mobile_run_task`
- Excel：`run_regression`（可选 `appPath` 安装 APK）
- 已有 tests.json：`suite run`

不再需要 `runner.cmd`、JDK 或 Maestro。
