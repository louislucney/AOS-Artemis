# Windows 执行机快速接入

本文只覆盖 **Windows + Android** 的 `web-runner`。iOS 模拟器需要 macOS + Xcode；Windows 不接 iOS。

## 1. 前置

- Node.js >= 20
- Android platform-tools（`adb`）
- Maestro CLI
- Android 真机或模拟器已能被 `adb devices` 看到

## 2. 命名

`AOS_HOST_ID` 是**你自己命名的主机身份**，集群内必须唯一；`--name` 只是面板显示名。

```powershell
$env:AOS_HOST_ID="win-mini-01"
```

不要复制其他机器的 host id。

## 3. 下载安装包

在面板登录后打开：

```text
设备 → 接入执行机 → Windows x64
```

或：

```powershell
$token = "<面板 MOBILE_TESTING_HTTP_TOKEN>"
curl.exe -L `
  -H "Authorization: Bearer $token" `
  -o mobile-testing-runner-0.1.0-win32-x64.zip `
  "http://<center-ip>:8765/panel/runner-bundle?platform=win32&arch=x64"
```

包内含 `dist/`、`node_modules/`、`runner.cmd`、`RUNNER.md`，不需要再 npm install。

解压：

```powershell
Expand-Archive mobile-testing-runner-0.1.0-win32-x64.zip -DestinationPath .
cd mobile-testing-runner-0.1.0-win32-x64
```

## 3.1 下载依赖工具

面板打开：

```text
设备 → 接入执行机 → 下载 Mac/Windows 依赖工具
```

或在 Windows 下载：

```powershell
$base = "http://<center-ip>:8765"
$token = "<面板 MOBILE_TESTING_HTTP_TOKEN>"

# 示例：Node.js、adb、JDK、Maestro 的 Windows 包
curl.exe -L -H "Authorization: Bearer $token" -o node.zip "$base/panel/runner-toolchain?file=node-v22.22.2-win-x64.zip"
curl.exe -L -H "Authorization: Bearer $token" -o platform-tools.zip "$base/panel/runner-toolchain?file=platform-tools-latest-windows.zip"
curl.exe -L -H "Authorization: Bearer $token" -o jdk.zip "$base/panel/runner-toolchain?file=OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip"
curl.exe -L -H "Authorization: Bearer $token" -o maestro.zip "$base/panel/runner-toolchain?file=maestro-2.12.1.zip"
```

解压后把 Node、platform-tools、JDK 的 `bin` 和 `maestro/bin` 加入 PATH。中心页面会列出实际文件名和 SHA-256。

## 4. 配置 runner token

`MOBILE_TESTING_RUNNER_JOB_TOKEN` 是执行机专用令牌，不是面板 token，也不是数据库连接串。

从 Mac 中心读取：

```bash
cd <mac-repo>
grep '^MOBILE_TESTING_RUNNER_JOB_TOKEN=' .local/center.env | cut -d= -f2-
```

在 Windows 设置：

```powershell
$env:AOS_HOST_ID="win-mini-01"
$env:AOS_RUNNER_CONTROL_URL="http://<center-ip>:8765"
$env:MOBILE_TESTING_RUNNER_JOB_TOKEN="<实际令牌，不带尖括号>"
```

## 5. 启动

```powershell
.\runner.cmd --name win-mini-01
```

启动后中心设备页应出现该主机和设备；若没有，先检查：

```powershell
Test-NetConnection <center-ip> -Port 8765
curl.exe http://<center-ip>:8765/healthz
adb devices
```

## 6. 常见错误

| 现象 | 原因 |
|---|---|
| 401 | runner token 错误、缺失，或用了面板 token |
| 403 host mismatch | 中心配置了每主机 token，`AOS_HOST_ID` 与 token 所属主机不一致 |
| 设备列表为空 | adb 没看到设备，或 Maestro 不在 PATH |
| 面板 401 | 浏览器登录需要面板 token，用户名任意、密码为 `MOBILE_TESTING_HTTP_TOKEN` |

## 7. 更新

中心重新构建后：

```bash
npm run bundle:runner
```

Windows 重新下载对应平台包并替换；`hostId` 保持不变即可继续领取任务。
