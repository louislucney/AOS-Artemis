# Windows adb-host 快速接入（Android 真机）

> **Maestro web-runner 已于 2026-11-06 移除。** Windows 不再需要 Node/JDK/Maestro runner；Android 真机走 MCP 原生 `mobile_run_task` / `run_regression`，Windows 只作为**设备宿主**提供 adb。

完整排障见 [android-mcp-native-testing.md](./android-mcp-native-testing.md)。

## 1. 前置

- Android 真机，USB 调试已授权
- Windows 上下载 **adb-host 小包**（面板「设备 → 接入执行机」→「Windows adb-host」，约 8MB）
- MCP 服务所在机器的 IP（用于防火墙限定来源）

## 2. 解压并启动 adb

```powershell
Expand-Archive mobile-testing-adb-host-0.1.0-win32-x64.zip -DestinationPath .
cd mobile-testing-adb-host-0.1.0-win32-x64
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
