# 设备接入与执行路径（Android / iOS）

> **唯一入口**：回答“手机该插哪、Mac 能不能直接用、要不要 adb-host / 5037 / Appium / Maestro”时，先看本文。
>
> 更新：2026-11-06。Maestro web-runner 已移除；历史 Web 任务/结果/设备记录只读保留。

## 0. 一句话决策树

```text
设备是什么？
├─ Android
│  ├─ 插在 MCP 服务所在的 Mac 上？
│  │    └─ 是 → 本机 adb；不需要 ADB_SERVER_SOCKET、adb-host、5037、SSH 隧道
│  └─ 插在另一台机器上？
│       └─ 是 → 那台机器暴露 adb（SSH 隧道或限定来源 IP）+ Mac 配 ADB_SERVER_SOCKET
└─ iOS
   ├─ 模拟器？ → 只能跑在 MCP 服务所在的 Mac（simctl/idb），不需要 adb
   └─ 真机？   → Mac 宿主 + Appium/WDA + 签名 + iOS 18+ Remote XPC 隧道
```

## 1. 三个独立概念（不要混）

| 概念 | 回答的问题 | 例子 |
|---|---|---|
| **设备宿主** | 手机物理插在哪台机器上 | Mac USB、Windows 主机、Mac mini |
| **执行路径** | 谁在驱动 UI | MCP 原生（Artemis）、LLM web worker |
| **平台** | 被测设备是什么系统 | Android、iOS 模拟器、iOS 真机 |

Maestro 是**已移除的旧执行路径**，不是设备接入方式；不要再把它和 Android/iOS 接入混在一起。

## 2. 场景矩阵

| 场景 | 设备位置 | MCP 服务怎么看到设备 | 需要的配置 | 执行入口 | 不需要 |
|---|---|---|---|---|---|
| **A. Android 本机** | USB 插在 Mac | 本机 adb 直接可见 | 无（adb 可用即可） | `mobile_run_task` / `run_regression` | `ADB_SERVER_SOCKET`、adb-host、5037、SSH、Maestro |
| **B. Android 远程** | USB 插在 Windows/另一台 Mac | 远程 adb server | 宿主暴露 adb；Mac 配 `ADB_SERVER_SOCKET` 或 `deviceHosts.android.adbHost` | 同 A | 不需要把手机拿到 Mac |
| **C. iOS 模拟器** | Mac 本机 | simctl/idb | Xcode；模拟器已启动 | `mobile_run_task`（传模拟器 UDID） | adb、adb-host、Appium、Maestro |
| **D. iOS 真机** | 连接 Mac 宿主 | Appium/WDA | Xcode、Appium + xcuitest、`AOS_IOS_XCODE_ORG_ID`、`AOS_APPIUM_URL`、iOS 18+ 隧道 | `mobile_run_task` / `run_regression` | adb、adb-host、Maestro |

## 3. 场景 A：Android 直接插 Mac（推荐，最短路径）

### 3.1 连接与验证

1. 手机开启 USB 调试，USB 连接 Mac，手机上确认“允许 USB 调试”。
2. 确认 adb 能看到设备：

```bash
~/Library/Android/sdk/platform-tools/adb devices -l
```

看到 `设备序列号  device` 即可。`adb` 不在 PATH 时可设 `AOS_ADB_PATH=/Users/louis/Library/Android/sdk/platform-tools/adb`，或把目录加入 PATH。

3. MCP 侧确认：

```bash
node dist/cli.js doctor
```

`aos_status` / `mobile_diagnose` 应能看到设备；`mobile_diagnose(probe_device=true)` 可做一次截图 + UI 层级探活。

### 3.2 执行

单条：

```jsonc
{
  "task_desc": "打开 UAT Mobil Guam，点击 Register now，报告看到的页面",
  "device_serial": "10CF6609P900059",
  "locked_app_package": "com.exxonmobil.mobil.gusp.uat"
}
```

Excel：

```jsonc
{
  "excelPath": "<项目>/.artemis/web/assets/excel/xxx.xlsx",
  "device": "10CF6609P900059",
  "appPath": "<项目>/.artemis/web/assets/package/xxx.apk"  // 可选：先安装 APK
}
```

不需要 `ADB_SERVER_SOCKET`，不需要 adb-host 小包，不需要 runner，不需要 Maestro。

## 4. 场景 B：Android 插在远程机器

只有手机**不在** MCP 服务这台 Mac 上时才需要。

### 4.1 宿主暴露 adb

**推荐 SSH 隧道**（不向 LAN 暴露端口）：

```bash
# 在 Mac 上；Windows 需安装 OpenSSH Server
ssh -L 5037:127.0.0.1:5037 <用户>@<宿主IP>
```

Mac 侧配置 `ADB_SERVER_SOCKET=tcp:127.0.0.1:5037`。

**实验 LAN**（仅可信网络）：宿主执行 `adb -a -P 5037 server nodaemon`，防火墙只放行 MCP 服务 IP；Windows/macOS 都可用 adb-host 小包（面板「设备 → 接入设备」下载，Windows 约 8MB / macOS 约 16MB）。确认监听 `0.0.0.0:5037`，不是 `127.0.0.1:5037`。

### 4.2 项目配置（二选一）

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

### 4.3 验证

```bash
~/Library/Android/sdk/platform-tools/adb -H <宿主IP> -P 5037 devices -l
```

详细排障（10048 端口占用、`LocalAddress=127.0.0.1`、`No route to host`）见 [android-mcp-native-testing.md](./android-mcp-native-testing.md)。

## 5. 场景 C：iOS 模拟器

- **只能在 MCP 服务所在的 macOS 上运行**（idb/simctl 是本机能力）。
- 前置：Xcode；模拟器已启动：

```bash
xcrun simctl list devices booted
```

- 不需要 adb、adb-host、Appium 或 Maestro。
- 执行：把模拟器 UDID 传给 `mobile_run_task` / `mobile_get_device_state` / `suite run --device <UDID>`。
- `doctor` / `aos_status.ios` 会显示 Xcode、Appium、xcuitest 状态；模拟器场景只依赖 Xcode/simctl。

## 6. 场景 D：iOS 真机

- 需要一台**连接 iPhone 的 Mac 宿主**，Xcode、Appium + xcuitest 都在该宿主上。
- 项目 `.env`：
  - `AOS_IOS_XCODE_ORG_ID`（签名团队 ID，**必填**）
  - `AOS_IOS_XCODE_SIGNING_ID`（默认 `Apple Development`）
  - `AOS_IOS_WDA_BUNDLE_ID`（默认 `com.aos.mcp.wda`）
  - `AOS_APPIUM_URL`（可选；缺省托管启动）
- iOS 18+：保持 Remote XPC 隧道运行：

```bash
sudo appium driver run xcuitest tunnel-creation
```

主机重启、设备重连、新增设备后需重跑；AOS 只给指引，不代为 sudo 启动。

- 执行：`mobile_run_task`（单条）/ `run_regression`（Excel）；`app_path` 传 `.ipa` 的 `http(s)://` URL（由 Appium 宿主安装），不要传 Mac 本地路径。
- 真机不经过 adb、adb-host 或 Maestro；签名/隧道细节见 README「iOS 真机」与 [接入指南 §3.7](./接入指南.md)。

## 6.5 MCP runner（宿主本机执行）

- **中心只下发任务**，runner 在宿主本机领取并用本机设备执行，结果/证据回传；不需要中心反向连宿主 adb，也不需要 5037/SSH 隧道。
- **Windows x64**：跑 Android（本机 USB adb）。
- **macOS arm64**：跑 iOS 模拟器/真机与 Android；iOS 真机必须连接 Mac，Windows 不能执行 iOS。
- **LLM**：runner 从中心取 active LLM（`AOS_LLM_FROM_CENTER=1`，包内脚本已设置）；中心返回 **LLM 代理 URL**，runner 用 runner token 调用，真实 provider key 不出中心，runner 本机不需填 key。跨主机需中心 `AOS_RUNNER_SHARED_LLM=1` 与 `AOS_RUNNER_DEFAULT_PROJECT=<中心项目根路径>`；项目路径只存在中心，runner 不需要填写。
- **前置**：Node 20+、`uv`、Python 3.12；中心 runner URL/token（HTTP 控制面）；iOS 另需 Xcode、Appium + xcuitest、`AOS_IOS_XCODE_ORG_ID` 签名团队与 iOS 18+ Remote XPC 隧道。
- **包内脚本**：`setup` 安装 Artemis 依赖；`doctor` 体检（含中心 LLM）；`smoke` 单条 `mobile_run_task` 验证；`runner` 常驻领取中心任务。
- **跨机任务包**：中心用 `AOS_RUNNER_DEFAULT_PROJECT` 作为控制面项目；runner 领取任务时中心下发 tests.json/flows 内容，runner 落到本地 `.artemis/design/case-sets` 后执行，不需要复制中心项目，也不需要填写项目路径。
- **首次依赖安装**：`runner` 首次自动 `uv sync`；脚本固定 `UV_PYTHON=3.12`。若 PyPI 超时，删 `artemis/.venv`，设 `UV_DEFAULT_INDEX`/`UV_INDEX_URL` 到可达镜像后重试；成功标志是 `.venv/.aos-deps.json`。
- **下载**：面板「设备 → 接入执行机」；构建：`npm run bundle:mcp-runner`。

## 7. 当前状态：Maestro 已移除，MCP runner 双端可用

- `web-runner`、Maestro 脚本生成、旧 runner 打包、`web scripts generate` 已删除。
- 新建 Maestro web 任务返回 `409 maestro-disabled`；面板网页测试表单隐藏；历史 Web 任务/结果/设备记录只读。
- 面板「设备 → 接入执行机」提供 **MCP runner 双端包**：Windows x64（Android）与 macOS arm64（iOS/Android）。runner 在宿主本机执行 `mobile_run_task` / `suite run`，中心只下发任务并接收结果；不再要求中心反向连 adb。
- 下载：`/panel/runner-bundle?role=mcp-runner&platform=win32&arch=x64` 或 `...&platform=darwin&arch=arm64`；构建：`npm run bundle:mcp-runner`。
- adb-host 仍保留为兼容入口（只含 platform-tools，适合“只暴露 adb、中心直连”的远程拓扑）；构建：`npm run bundle:adb-host`。
- `npm run toolchain:fetch` 只下载 Android platform-tools。

## 8. 验证清单

- [ ] `node dist/cli.js doctor`：LLM 就绪、adb/设备/宿主状态符合预期
- [ ] Android 本机：`adb devices -l` 能看到 serial
- [ ] Android 远程：`aos_status.deviceHosts` 显示 adb 宿主可达
- [ ] iOS 模拟器：`xcrun simctl list devices booted` 有设备，UDID 可传给 `mobile_run_task`
- [ ] iOS 真机：Appium `/status` ready、设备可见、Remote XPC 隧道在运行
- [ ] 跑一条 `mobile_run_task` 成功，再跑 Excel 回归

## 9. 排障速查

| 现象 | 场景 | 处理 |
|---|---|---|
| `adb devices` 为空 | A/B | USB 授权、换线/口、`adb kill-server` 后重试 |
| 远程 `No route to host` | B | 防火墙/来源 IP、SSH 隧道、`LocalAddress=0.0.0.0` |
| `10048` 端口占用 | B | 停旧 runner/进程，`Stop-Process` 后重开 adb |
| `LocalAddress=127.0.0.1` | B | 没带 `-a`；杀掉旧 server 重开 |
| iOS 模拟器看不到 | C | 只能在 MCP 所在 Mac；Xcode 已装、模拟器已 boot |
| Appium `/status` 不通 | D | 宿主 Appium 未启动/端口不对；`AOS_APPIUM_URL` 或 SSH 隧道 |
| iOS 18+ 真机连不上 | D | Remote XPC 隧道未运行；重跑 `tunnel-creation` |
| 签名失败 | D | `AOS_IOS_XCODE_ORG_ID` 错误/证书过期/设备未注册 |

## 10. 文档索引（避免重复与矛盾）

- 本文：设备接入与执行路径的**唯一入口**。
- [android-mcp-native-testing.md](./android-mcp-native-testing.md)：Android 远程 adb 的深度排障、DeepSeek 配置。
- [windows-runner-quickstart.md](./windows-runner-quickstart.md)：Windows 作为 Android 设备宿主（adb-host）。
- [接入指南.md](./接入指南.md) §3.7：项目/宿主的完整配置项与 ADR-0011 细节。
- README「iOS 真机」：签名、WDA、隧道与 iOS 执行器边界。
