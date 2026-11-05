## iOS 真机（仅 macOS 宿主；Appium/WDA）

> **边界**：本执行机包里的 `runner.sh` / `runner.cmd` 只执行 **Web job**（Android 设备 / iOS 模拟器）。**iOS 真机不由 web-runner 执行**；真机任务需要 AOS 服务 + Appium/WDA，并且只能在连接设备的 **macOS 宿主**上运行。Windows / Linux 执行机不接 iOS。
>
> 以下环境变量写在 **AOS 服务侧项目的 `.env`**，不是本 runner 的启动环境。iOS 真机执行器是 **LLM 驱动**（`taskDesc` → 模型决策动作），不是逐条执行 Maestro YAML；需要 active LLM。

### 1. 前置检查

```bash
xcodebuild -version                 # Xcode 已安装
appium driver list --installed      # 期望 xcuitest 已安装
xcrun devicectl list devices        # 设备可见
```

设备侧：USB 连接、解锁、信任本机；iPhone 13 / iOS 26.6 这类 **iOS 18+** 设备还需要第 3 步的隧道。

### 2. 开发者模式与设备状态

```bash
xcrun devicectl list devices
xcrun devicectl list devices --verbose | grep -A3 developerModeStatus
```

期望：

- State = `available`
- `developerModeStatus: enabled`
- `ddiServicesAvailable: true`

如果 `developerModeStatus: disabled`：

1. 设备：设置 → 隐私与安全性 → 开发者模式 → 打开
2. 重启设备
3. 解锁后确认“打开开发者模式”
4. 重新插拔 USB / 信任本机

如果仍 `unavailable`：换 USB 口/线，确认设备已解锁，删除并重新配对（Xcode → Window → Devices and Simulators）。

### 3. 签名团队与 WDA

`AOS_IOS_XCODE_ORG_ID` 是证书的 **OU 团队 ID**，不是证书名。可在 Xcode → Settings → Accounts 查看，或：

```bash
security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
# subject=... OU=<TEAMID> ...
```

项目 `.env`：

```bash
AOS_IOS_XCODE_ORG_ID=<TEAMID>
AOS_IOS_XCODE_SIGNING_ID=Apple Development
AOS_IOS_WDA_BUNDLE_ID=com.aos.mcp.wda
```

注意：

- 该团队必须能把目标设备注册进 provisioning；否则 WDA 编译/签名会失败。
- 首次会话会编译并安装 WDA，可能耗时几分钟。
- 设备上如出现开发者证书信任提示：设置 → 通用 → VPN 与设备管理 → 信任。
- 多项目团队不同时，各自写自己的项目 `.env`。
- 免费个人团队通常 7 天签名有效期，过期后重新建会话/重签。

### 4. iOS 18+ Remote XPC 隧道（硬前置）

```bash
sudo appium driver run xcuitest tunnel-creation
```

- 独立常驻进程，**不要退出**；AOS 不代为 sudo 启动。
- 主机重启、设备重连、新增设备、隧道进程退出后都要重跑。
- 隧道 registry 由 Appium 自动发现/复用；多个 Appium server/会话可共用。
- 没有隧道时，WDA 会话通常表现为连不上/超时；`doctor` / `mobile_diagnose` 会给出同一指引。

### 5. Appium 服务

两种方式二选一：

- **AOS 托管（推荐）**：不设 `AOS_APPIUM_URL`；AOS 在 `AOS_IOS_APPIUM_PORT`（默认 4723）懒启动 Appium，并轮询 `/status`。启动前会先探测复用已有实例。
- **直连**：

  ```bash
  appium --port 4723
  ```

  ```bash
  AOS_APPIUM_URL=http://127.0.0.1:4723
  ```

远程设备宿主（ADR-0011）：`aos.config.jsonc` 的 `deviceHosts.ios.appiumUrl`（或进程 env `AOS_APPIUM_URL`）指向宿主；**设备、Xcode/WDA、隧道都在该宿主上**。`app_path` 支持 `http(s)://`，由 Appium 宿主下载安装；跨机不要传服务端本地路径冒充 IPA。

### 6. 配置生效

- 项目 `.env` 打底，进程 env 覆盖（同模型目录规则）。
- 修改 `.env` 后重启 MCP/HTTP 服务，让 Runtime 重新读取。
- 执行器可选开关：`AOS_IOS_VISION_MODE=auto|sparse|off`、`AOS_IOS_VERIFY=final|off`、`AOS_IOS_MAX_STEPS`、`AOS_IOS_SETTLE_MS`、`AOS_IOS_HISTORY_STEPS`、`AOS_IOS_OBSERVE_RETRY`、`AOS_IOS_LOG_FEEDBACK=0`。
- `mobile_run_task` 需要 active LLM：`llm_list` / `aos_status` 确认；没有 LLM 时只做观测（截图/层级）可以，执行任务会报“需要可用的 active LLM”。

### 7. 最小验收（按顺序）

1. **服务体检**

   ```bash
   node dist/cli.js doctor
   ```

   `doctor` 应显示 Appium + xcuitest 版本、签名团队、隧道指引；`aos_status.ios` 同源。

2. **设备观测**

   ```text
   mobile_get_device_state(device_serial="<UDID>")
   ```

   期望返回截图与层级。设备忙时可能返回 `device_busy` + 最近缓存帧（带 `capturedAt/age`，超过 `AOS_IOS_CACHED_FRAME_MAX_AGE_MS` 标注陈旧）。

3. **安装/启动 App**

   ```text
   mobile_run_task(
     device_serial="<UDID>",
     task_desc="启动应用并截图，确认首页可见",
     app_path="/absolute/path/to/app.ipa"
   )
   ```

   - 本地 `.ipa` 或 `http(s)://` URL 均可；真机必须是 **device build**（含 `iOS, arm64`，不是 simulator slice）。
   - 已预装应用：不要传 `app_path`，用 `locked_app_package` 指向 bundle id。
   - 安装失败优先检查：签名/描述文件、设备 UDID 是否在该 profile、企业证书是否已信任、IPA 是否 simulator-only。

4. **轮询/停止/取证**

   - `mobile_manage_task(task_id, action="status"|"stop"|"inject")`
   - `mobile_inspect_trace(trace_id)` 查看步骤、截图、`logs/device.log`
   - 崩溃：`aos_crashes list/get/scan`（真机来源 `devicectl-systemCrashLogs`）

### 8. 与 Maestro web job 的边界

| 目标 | iOS 模拟器 | iOS 真机 |
|---|---|---|
| Maestro web job | ✅ 支持（`.ipa` 需 simulator build） | ❌ 未接线（Plan 2） |
| `mobile_run_task` | ✅（idb/simctl 或 Appium） | ✅（Appium/WDA + LLM） |
| 确定性 Excel/Maestro 脚本 | ✅ 模拟器 web job | ❌ 未接线 |
| 安装识别/跳过 | ✅ `simctl get_app_container` | ✅ `devicectl device info apps` |
| 设备日志 | simctl log | `idevicesyslog`（可缺省降级） |

不要把 Android 的脚本集直接复用到 iOS：Android 包名可能是 `...uat`，iOS 可能是 `...beta`，`appId` 必须对应。

### 9. 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `developerModeStatus: disabled` | 开发者模式未开 | 设备设置开启并重启 |
| `ddiServicesAvailable: false` | 开发者模式/信任/配对异常 | 解锁、信任、重插；Xcode Devices 重新配对 |
| WDA 编译/签名失败 | Team ID 错、设备未注册、证书过期 | 换正确 Team、Xcode 登录账号、重新签名 |
| WDA 会话连不上/超时 | iOS 18+ 隧道未运行 | 保持 `sudo appium driver run xcuitest tunnel-creation` |
| `mobile_run_task` 报无 active LLM | 执行器需要 LLM | `llm_list`/`aos_status` 配置并激活 |
| IPA 安装失败 | simulator build / 签名 / 未信任 / UDID 不在 profile | 用 device build，信任证书，检查描述文件 |
| 设备日志 `ios-log-tool-missing` | 未装 `idevicesyslog` | `brew install libimobiledevice`（非阻塞，崩溃仍走 devicectl） |
| `device_busy` | 同 UDID 会话互斥 | 等当前任务/会话结束；观测可用缓存帧 |

### 10. 当前边界

- iOS 真机不经过 Maestro web job；不要用网页测试表单下发 iOS 真机任务。
- 真机 `mobile_run_task` 是 LLM 执行器；与 Android 的 Maestro 回归不是同一套确定性和产物。
- 如果后续需要“iOS 真机 + Excel/Maestro 确定性回归”，需要单独的执行器接线（当前未实现）。

> 更完整的服务侧说明见源码仓库 `README.md` 的「iOS 真机（Appium + WDA；M9a–M9c）」与 `docs/接入指南.md`。
