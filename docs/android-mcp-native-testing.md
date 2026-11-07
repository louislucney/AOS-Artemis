# Android 真机：MCP 原生执行接入与排障

本文说明如何用 **MCP 原生执行器**（`mobile_run_task` / `run_regression` / `suite run`）在 Android 真机上跑用例，以及 Maestro 路线移除后的迁移说明、远程 adb 接入方式和常见故障处理。

> **先看**：[device-access-and-execution.md](./device-access-and-execution.md)。Android 直接插 Mac 时不需要本文的远程 adb 配置；本文重点覆盖远程 adb 与深度排障。

适用场景：

- 设备插在另一台机器（如 Windows `win-mini-01`），MCP 服务跑在 Mac/中心；
- 被测 App 有保护壳、OEM 后台限制或 Maestro driver 兼容性问题；
- 用例是自然语言/Excel 步骤，可以接受 LLM 规划带来的非确定性；
- 不想在设备宿主上安装 JDK / Maestro / 两个 driver APK。

不接受 LLM 非确定性、需要逐字脚本复现的稳定回归，当前没有 Maestro 路线；可评估 Appium/Espresso 或 ADB+OCR 兜底（见文末对比）。

---

## 0. 快速获取 adb-host 小包（Windows / macOS）

**手机直接插在 MCP 服务所在的 Mac 上时不需要本包**：系统 adb 即可，MCP 本机直接可见设备。

只有手机插在另一台 Mac/Windows 宿主上时才需要：

- 面板「设备 → 接入设备」→「Windows adb-host（约 8MB）」或「macOS adb-host（约 16MB）」；
- 或本地构建：`npm run bundle:adb-host`，产物在 `dist-runner/mobile-testing-adb-host-<version>-win32-x64.zip` 与 `...-darwin-arm64.zip`；
- 包内只有 `platform-tools/`、启动脚本和本手册，不包含 Node/JDK/Maestro。

**如果要在宿主本机执行（推荐）**：下载 MCP runner 双端包（Windows Android / macOS iOS+Android），在宿主运行 `setup` → `doctor` → `smoke` → `runner`；中心只下发任务并接收结果，不需要把 adb 暴露给中心。面板「设备 → 接入执行机」或 `npm run bundle:mcp-runner`。

启动：

- Windows：`.\start-adb-host.ps1`（防火墙脚本 `firewall-add.ps1`）。
- macOS：`./start-adb-host.sh`（`lsof -nP -iTCP:5037 -sTCP:LISTEN` 确认监听）。

两者都等价于 `adb -a -P 5037 server nodaemon`。

---

## 1. 两条执行路径

### 1.1 MCP 原生（本文）

```text
MCP 服务（Mac）
  → Artemis Python 子进程
    → adb（本机或远程 adb server）
      → Android 设备
        → ArtemisAccessibilityHelper.apk（常驻 accessibility service，一次安装）
        → uiautomator2 / OCR(data_engine) 兜底
        → active LLM 规划动作
```

特点：

- 设备端只安装一个 **ArtemisAccessibilityHelper.apk**（版本化，helper 掉线会 reattach/重新绑定 accessibility）；
- 不需要 JDK、Maestro CLI，也不会每次重装 Maestro driver；
- 需要 active LLM（`mobile_run_task` / `run_regression` 都依赖它）；
- 结果以 trace、步骤截图、`data_engine.db`、OCR 文本为主，不是 Maestro JUnit。

### 1.2 Maestro web-runner（已移除，历史）

```text
Windows/macOS runner（host 级）
  → Maestro CLI（JVM）
    → Maestro driver APK（dev.mobile.maestro + dev.mobile.maestro.test）
      → Android 设备
```

特点：

- 执行预生成的 Maestro YAML，结果稳定、可复现、无 LLM token 消耗；
- 依赖 JDK + Maestro，设备上要装两个 driver APK；
- vivo 等机型上 driver 重装/安装确认容易导致 `DeviceServerDiedException`（见 §6）。

---

## 2. 配置 LLM（DeepSeek V4 Flash）

在**项目根目录** `.env`（权限 `0600`）：

```dotenv
AOS_LLM_NAME=deepseek
AOS_LLM_MODEL=deepseek-flash
AOS_LLM_BASE_URL=https://api.deepseek.com/v1
AOS_LLM_API_KEY=sk-...
```

说明：

- `deepseek-flash` 是 DeepSeek V4 Flash 的稳定别名（旧名 `deepseek-v4-flash` 由服务自动修复）；
- 兼容旧配置：只写 `DEEPSEEK_API_KEY` 也可以，但 `AOS_LLM_*` 优先；
- 不要把 key 写进 `aos.config.jsonc`、命令行参数、脚本或日志；
- 写入后重启 MCP 服务（或重新注册项目），再执行：

```bash
AOS_PROJECT_DIR=<项目根> node dist/cli.js doctor
```

应看到：

```text
✓ LLM 三元组就绪（model=deepseek-flash via AOS_LLM_MODEL）
  base_url: https://api.deepseek.com/v1 (AOS_LLM_BASE_URL)
  api_key: **** via AOS_LLM_API_KEY
```

也可以用 `aos_configure(vendor="deepseek", apiKey="…")` 写入项目 `.env` 并激活。

---

## 3. 远程 adb（设备在 Windows，MCP 在 Mac）

MCP 原生执行器只认 **adb**。设备插在 Windows 上时，Mac 必须能访问 Windows 的 adb server。

### 3.1 推荐：SSH 隧道（零暴露）

在 Windows 上把本机 adb 反向转发到 Mac（Mac 需开启远程登录），或从 Mac 正向转发到 Windows（Windows 需 OpenSSH Server）：

```bash
# Mac 侧：把 Windows 的 127.0.0.1:5037 映射到 Mac 的 127.0.0.1:5037
ssh -L 5037:127.0.0.1:5037 <windows-user>@<windows-ip>
```

项目配置：

```dotenv
ADB_SERVER_SOCKET=tcp:127.0.0.1:5037
```

### 3.2 实验 LAN：仅限可信网络（不推荐长期使用）

adb server **没有鉴权**，暴露到 LAN 等于把设备控制权交给同网段。仅限实验网络，并限制来源 IP。

Windows 管理员 PowerShell，只放行 Mac 的 IP：

```powershell
New-NetFirewallRule -DisplayName "adb-mac-aos" `
  -Direction Inbound -Protocol TCP -LocalPort 5037 `
  -RemoteAddress <mac-ip> -Action Allow
```

停止 runner（Ctrl+C），杀掉占用 5037 的旧 server，再启动带 `-a` 的 server：

```powershell
Get-NetTCPConnection -LocalPort 5037 -State Listen |
  Select-Object LocalAddress,LocalPort,OwningProcess
Stop-Process -Id <上面的PID> -Force

cd C:\RUNNER\mobile-testing-runner-0.1.0-win32-x64
.\tools\platform-tools\adb.exe kill-server
.\tools\platform-tools\adb.exe -a -P 5037 server nodaemon
```

`server nodaemon` 窗口保持开着。确认监听地址是 `0.0.0.0`：

```powershell
Get-NetTCPConnection -LocalPort 5037 -State Listen
```

另开窗口启动 runner（它会复用这个 adb server）：

```powershell
.\runner.cmd --name win-01
```

Mac 侧验证：

```bash
~/Library/Android/sdk/platform-tools/adb \
  -H <windows-ip> -P 5037 devices -l
```

看到设备序列号（如 `10CF6609P900059 device`）即成功。实验结束删除规则：

```powershell
Remove-NetFirewallRule -DisplayName "adb-mac-aos"
```

### 3.3 项目配置

二选一（优先级：进程 env > 项目 `.env` > `aos.config.jsonc`）：

```dotenv
ADB_SERVER_SOCKET=tcp:<windows-ip>:5037
```

或：

```jsonc
{
  "deviceHosts": {
    "android": { "adbHost": "<windows-ip>:5037" }
  }
}
```

重启 MCP 服务后检查：

```bash
node dist/cli.js doctor
```

`aos_status.deviceHosts` 会显示解析来源与 adb 探活结果；`mobile_diagnose` 会检查设备授权、锁屏、RSA 与空闲状态（`attempt_fix=true` 可做安全自愈）。

---

## 4. 运行用例

### 4.1 单条自然语言任务

```jsonc
{
  "task_desc": "打开 UAT Mobil Guam（com.exxonmobil.mobil.gusp.uat），等待登录页，点击 Register now，截图并报告页面上的主要控件",
  "device_serial": "10CF6609P900059",
  "locked_app_package": "com.exxonmobil.mobil.gusp.uat"
}
```

调用 `mobile_run_task`；用 `mobile_manage_task` 轮询，`mobile_inspect_trace` 查看步骤/截图/OCR。

也可以直接用仓库脚本冒烟（会 `mobile_diagnose` → 提交 → 轮询）：

```bash
AOS_PROJECT_DIR=<项目根> node scripts/e2e-device.mjs \
  --device 10CF6609P900059 \
  --package com.exxonmobil.mobil.gusp.uat \
  --app <项目>/.artemis/web/assets/package/xxx.apk \
  "打开 UAT Mobil Guam，点 Register now，报告看到的页面"
```

### 4.2 Excel 回归

`run_regression` 支持 `excelPath` + `device`：

```jsonc
{
  "excelPath": "<项目>/.artemis/design/case-sets/xxx.xlsx",
  "device": "10CF6609P900059",
  "appPath": "<项目>/.artemis/web/assets/package/xxx.apk"  // 可选：本地路径或 http(s) URL
}
```

它会导入 Excel 到用例库，再按用例逐条走 `mobile_run_task`；`appPath` 会透传 `mobile_run_task.app_path`，由 Artemis 安装 APK/IPA（已安装时可省略）。也可以先导入，再用：

```bash
node dist/cli.js suite run --tests <tests.json> --device 10CF6609P900059 --project <项目根>
```

产物：

- trace：`.artemis/traces/<traceId>/`（含 `data_engine.db`、步骤截图、notes）；
- 批次清单：`.artemis/design/runs/`；
- 报告：`suite report` / `run_regression` 响应。

首次执行会自动安装 `ArtemisAccessibilityHelper.apk`；如果 OEM 拦截安装确认，用 `mobile_diagnose(attempt_fix=true)` 或手动确认后重试。

---

## 5. 示例：ESSO-GU + win-mini

以下为常见拓扑的示例值，按实际环境替换：

| 项 | 示例 |
|---|---|
| Mac（MCP 服务） | `192.168.102.165` |
| Windows（设备宿主） | `192.168.102.178` |
| Android 设备 | `10CF6609P900059`（vivo V2453A / Android 16） |
| 项目 | `/Users/louis/Documents/AOS/ESSO-GU` |

步骤：

1. 项目 `.env` 写 DeepSeek 三元组（§2）；
2. Windows 按 §3.2（或 SSH 隧道）暴露 adb；
3. Mac 验证 `adb -H 192.168.102.178 -P 5037 devices -l`；
4. 项目配置 `ADB_SERVER_SOCKET=tcp:192.168.102.178:5037`；
5. 重启 MCP 服务，`doctor` 确认 LLM 与设备宿主；
6. `mobile_run_task` 跑 TC_01，跑通后再 `run_regression`。

---

## 6. Maestro 路径已移除（历史教训）

> 2026-11-06 已删除 Maestro web-runner、脚本生成与 runner 打包；以下仅记录迁移原因，不再提供操作步骤。



迁移前遇到的现场问题：

- **vivo / OEM 安装确认**：Maestro 2.12.1 的 driver 由两个 APK 组成（`dev.mobile.maestro`、`dev.mobile.maestro.test`），默认每次 `maestro test` 都重装；vivo 的安装确认弹窗会让 driver 处于半装/被杀状态，表现为 `DeviceServerDiedException`（`deviceInfo` / `viewHierarchy` 120 秒超时）。
- **预检与复用**：runner 在两个包都存在时加 `--no-reinstall-driver`；缺包时默认拦截，`AOS_MAESTRO_INSTALL_DRIVER=1` 才允许 Maestro 自动安装；怀疑版本不匹配用 `AOS_MAESTRO_REINSTALL_DRIVER=1`；`AOS_PREFLIGHT=0` 只用于应急。
- **清数据冷启动**：生成器在前置条件为空时默认 `clearState: true`；受保护 App 冷启动可能长时间停在启动页/网络初始化，`viewHierarchy` 会一直等。用例已有准备数据时，给 Excel 填前置条件，或用 `--precondition-mode assume-prepared`，让脚本保留登录态。
- **文本选择器**：按真实 UI 文案写，留文案容易找不到。例如 ESSO-GU 登录页按钮实际是 `Register now`，不是 `Register`；优先用 `resource-id`（如 `.../id/btn_register`）。
- **不要在任务运行中手动安装/卸载 driver 或 App**：会打断正在运行的 driver/应用，直接造成连接中断。

结论：**受保护 App + vivo/安装确认严格的机型，优先用 MCP 原生路径**；Maestro 路线已移除。

---

## 7. 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `adb ... devices` 报 `No route to host` | Windows 防火墙/网络阻断 5037 | 加限定来源的防火墙规则，或改用 SSH 隧道 |
| `cannot bind to 0.0.0.0:5037 ... 10048` | 5037 已被旧 adb server 占用 | 停 runner → 查 PID → `Stop-Process` → 再 `adb -a ... server nodaemon` |
| `Get-NetTCPConnection` 的 `LocalAddress` 是 `127.0.0.1` | server 没带 `-a` | 杀掉旧 server，用 `-a` 重启；再启动 runner |
| `mobile_run_task` 返回 `needs-setup` / `setup_required` | 项目没有 active LLM | 配 §2 的三元组，重启服务，`doctor` 确认 |
| `doctor` 看不到设备/宿主 | `ADB_SERVER_SOCKET` 未加载 | 检查项目 `.env`/`deviceHosts`，重启 MCP 服务 |
| `ArtemisAccessibilityHelper` 安装失败 | OEM 安装确认/权限 | `mobile_diagnose(attempt_fix=true)`，手动确认安装后重试 |
| 历史 Maestro `DeviceServerDiedException` | driver 重装/半装/OEM 冻结 | Maestro 路线已移除；用 MCP 原生 |
| Maestro 报 `Element not found` | 文案与 UI 不一致 | 用真实文案或 `resource-id`；先 `maestro hierarchy` 核对 |

---

## 8. 接入验收清单

- [ ] 项目 `.env`（`0600`）有 `AOS_LLM_*`，`doctor` 显示 LLM 就绪；
- [ ] Mac 能通过 `adb -H <host> -P 5037 devices -l` 看到设备；
- [ ] 项目 `ADB_SERVER_SOCKET` / `deviceHosts.android.adbHost` 已配置并重启服务；
- [ ] `aos_status.deviceHosts` 显示 adb 宿主可达；
- [ ] `mobile_run_task` 能打开 App、点一个按钮并留下 trace；
- [ ] `run_regression` 能用 Excel 跑一条用例并写回结果；
- [ ] 实验 LAN 结束后已删除临时防火墙规则。
