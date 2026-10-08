# 00 — 真机最小回路 spike（人工验证，无代码）

**What to build:** 按 spec 的路线，在你 Mac 上人工验证 Appium + WDA 真机链路可用：隧道 → 会话（系统 App `com.apple.Preferences`）→ 截图/层级 → tap/swipe/text → terminate/activate；把版本、命令、耗时、签名与隧道要点、失败模式记录到本文档 Comments。这是 M9a 开工的前置事实，不写产品代码。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] `sudo appium driver run xcuitest tunnel-creation` 建立或确认复用隧道（记录是否必需、输出形态、是否常驻）
- [x] 对 iPhone 12（00008101-000359440C69001E）以 `com.apple.Preferences` 建立 WDA 会话，成功拿到 screenshot 与 page source
- [x] tap / swipe 成功；**键盘链路（H3）**：点输入框 → 等键盘可见 → 输入成功（注意：`mobile: typeText` 未实现，改走 `/keys`）；记录键盘可见轮询方式
- [x] `mobile: terminateApp` + `activateApp` 成功；`useNewWDA=false` 下重复建会话不触发重编译
- [x] **冷启动计时（H1）**：复用会话建立 ~1s（两次实测 1s/0s）；首次全量构建为分钟级（未精确定时）
- [x] 记录：签名参数（bundle id/team/signing id）、session capabilities、失败模式与报错原文（供 01/02 的错误文案）

## Comments

- 2026-10-08 spike 通过（iPhone 12 / iOS 26.6.2 / Xcode 27.0 / Appium 3.8.0 / xcuitest 12.15.0）：
  - **隧道**：`sudo appium driver run xcuitest tunnel-creation` 成功并常驻（registry `http://127.0.0.1:42314/remotexpc/tunnels`；设备隧道 `fd38:61b2:c1eb::1:59815`、82 services）；驱动经它发现设备，无需额外配置。
  - **签名**：`xcodeOrgId` 必须用证书 OU 对应的团队——本机为 **`Z35S33J39R`（Lancoo Group，Xcode 托管 profile）**；此前用 CN 括号里的 `H5BWEU6GTD` 导致 `No signing certificate "iOS Development" found` + `xcodebuild code 65`。加 `-allowProvisioningUpdates`（appium 能力 `allowProvisioningDeviceRegistration: true`）后 **TEST BUILD SUCCEEDED**（WDA bundle `com.aos.mcp.wda`，设备自动注册进团队）。
  - **能力实测**：`useNewWDA=false` 复用已构建 WDA；会话建立 ~1s；screenshot 356KB PNG ✅；source 39.7k chars → 自家解析器 162 nodes ✅；tap（W3C actions）聚焦 ✅；键盘弹出（轮询 `is_keyboard_shown`=true）✅；`mobile: terminateApp`→true ✅；swipe ✅；`mobile: activateApp` ✅。
  - **API 修正**：`mobile: typeText` 未实现（`NotImplementedError`）→ 文本输入改走标准 `POST /session/:id/keys` `{value:[...chars]}`（实测在 Safari 地址栏输入 `apple.com` 成功）；`mobile: {terminateApp, activateApp, installApp}` 均在 execute-method-map。
  - **H1 修正**：复用/保活后会话建立 ~1s（远低于 15–30s 估计）；唯一大头是首次构建+安装（分钟级）。**H3 确认**：真机输入前必须先 tap 聚焦，键盘出现后经 `/keys` 输入；非 ASCII 未实测。
  - appium 进程已停；隧道进程仍在终端常驻（后续冒烟直接复用）。中间产物（截图/source/脚本）在临时目录，未入库。
