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

`doctor.cmd` 会探测中心 `GET /healthz`：网络不通时显示「中心不可达」并给出底层原因（runner 模式 exit 2），不会等到领取任务才发现。

面板「设备 → 去下发」若提示「未知项目」，先确认该 runner 在线；跨机 runner 会复用中心项目登记，不需要在 Windows 上重复登记项目。

runner 默认单用例等待 10 分钟（`AOS_SUITE_CASE_TIMEOUT_MS=600000`）；LLM agent 用例仍超时时可提高该值，并在重跑前重启 `runner.cmd` 清掉可能残留的 Artemis 进程。

runner 在 Windows 本机用 USB adb 执行；中心只下发任务并接收结果，不需要中心访问 5037。跨机回归时中心下发 tests.json/flows，runner 自动落本地 `case-sets`，不需要复制项目。iOS 不支持 Windows，iPhone 必须连接 Mac（用 macOS MCP runner）。

### 产物服务（中心打开批次/证据）

runner 默认在 `0.0.0.0:8770` 启动只读产物服务；中心要能访问 `http://<执行机地址>:8770` 才能打开批次清单、trace 与截图。

```powershell
# 管理员 PowerShell：只放行中心 IP
New-NetFirewallRule -DisplayName "mobile-testing runner artifacts" -Direction Inbound -Protocol TCP -LocalPort 8770 -RemoteAddress <中心IP> -Action Allow
```

- 地址优先用**中心能解析的主机名/DNS 名**（如 `http://runner-name:8770`）；不要长期写死 IP。
- 多网卡/NAT 自动地址不可达时，才用 `AOS_RUNNER_ADVERTISE_URL` 覆盖；新包支持写入 `project\.env`，旧包用 `runner.cmd` 或 Windows 环境变量（进程 env 优先）。
- 端口被占用：设 `AOS_RUNNER_ARTIFACT_PORT=8771` 并同步 `AOS_RUNNER_ADVERTISE_URL` 与防火墙；设 `0` 关闭。
- 详细步骤与令牌见面板「设备 → 执行机接入说明 → 产物服务」。

### 安装策略（已安装同包）

任务带安装包时，runner 会先查设备是否已安装同名包，并比较**已安装 APK 的 sha256 与下发 APK 的 sha256**；两者一致才默认**跳过安装并直接启动**，避免部分设备（vivo 等）在重复安装时只给“重新打开”而中止安装。不一致或未安装时由 runner 用 **streamed `adb install -r -t`** 安装（默认），安装后再复验 SHA；`AOS_ANDROID_INSTALL_MODE=artemis` **已停用**（Artemis 安装冲突时会卸载应用并清空数据，设置后仅告警并回退 adb）。需要强制更新时在 `project\.env` 设：

```dotenv
AOS_APP_INSTALL_POLICY=always
```

### 任务开始前清理

每个任务开始前默认重启 Artemis 子进程（`AOS_RUNNER_RESTART_CHILD_PER_TASK=1`），清掉上一个任务可能残留的设备锁/队列；设为 `0` 关闭。执行中每 30 秒上报心跳，超过 5 分钟无事件时中心显示「执行停滞」。

### 首次安装依赖失败（PyPI 超时 / Python 3.12）

启动脚本已固定 `UV_PYTHON=3.12`、`UV_SYSTEM_CERTS=1`。如果 `uv` 仍选 3.13，先 `uv python find 3.12`。如果访问 `pypi.org` 超时，或报 `invalid peer certificate: UnknownIssuer`（公司 TLS 拦截/Zscaler）：

```powershell
cd C:\RUNNER\aos-artemis-runner-0.3.16-win32-x64
Remove-Item -Recurse -Force .\artemis\.venv
$env:UV_PYTHON="3.12"
$env:UV_SYSTEM_CERTS="1"
$env:UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
$env:UV_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
.\runner.cmd
```

也可用阿里云 `https://mirrors.aliyun.com/pypi/simple/` 或公司内部镜像。成功标志是 `artemis\.venv\.aos-deps.json` 存在；`runner.cmd` 用它判断依赖就绪，安装失败不会启动。

### `artemis 模块导入失败（venv 未就绪？）` 但依赖已就绪

`依赖已就绪` 只代表 lock 匹配，不代表 venv 能导入。常见原因是旧 `.venv` 不是 Python 3.12（离线依赖按 3.12 打包）或上次安装半途中断：

```powershell
cd C:\RUNNER\aos-artemis-runner-0.3.16-win32-x64-offline
Remove-Item -Recurse -Force .\artemis\.venv
.\setup-offline.cmd
```

新包的 `runner.cmd` / `setup-offline.cmd` 会自动检测非 3.12 venv 并重建。

### 任务一直 running / `DeviceBusyError: The Artemis queue reservation was cancelled`

旧 Artemis Python 进程可能仍占用设备锁，后续任务会一直排队直到超时。先列出：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'mcp_server|aos-artemis-runner' } |
  Select-Object ProcessId, CommandLine
```

确认是要清理的 runner 子进程后终止，再重启 `runner.cmd`：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'mcp_server|aos-artemis-runner' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

新 runner 超时会主动 `mobile_manage_task stop`，但无法清理旧版本遗留的孤儿进程。

### `suite 数据面请求失败：fetch failed`

runner 连不上中心 HTTP，不是设备/LLM 问题。先检查 `project\.env`：

```powershell
type .\project\.env
```

- `MOBILE_TESTING_RUNNER_CONTROL_URL` 不能是 `http://127.0.0.1:8765`（那是 runner 本机）
- 填中心局域网地址，例如 `http://192.168.1.10:8765`
- 在 Windows 上验证：`curl.exe http://<中心IP>:8765/healthz`，返回 `{"ok":true,...}` 才算通
- 不通时检查同一局域网/VPN、中心以 `--host 0.0.0.0` 启动、中心防火墙放行 8765

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
