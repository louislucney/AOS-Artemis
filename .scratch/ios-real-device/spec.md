# iOS 真机支持（ios-real-device）— spec

**Status:** ready-for-agent

## Problem Statement

AOS 的 iOS 后端目前只服务模拟器：截图/层级走 idb（1.6.5 对真机拒绝 `ui` 命令），日志走 `simctl spawn`，崩溃读宿主机 `DiagnosticReports`——全是模拟器路径。真机 UDID 虽被 `classifyIosSerial` 归类并路由进 AOS iOS 后端（best-effort，当时无真机未验证），但实际调用会散落 idb 报错（实测：`Target is not a simulator` / `screenshotr service is invalid`）。Jira 接入的两端验收（Android + iOS）与真机设计对比因此无法闭环。

## Solution

为真机 iOS 引入 **Appium + WebDriverAgent（WDA）** 后端：AOS 作为 WebDriver 客户端（仅新增 `fast-xml-parser` 一个运行时依赖），会话管理内置（任务级复用 + 空闲回收 + 失联自愈），Appium server 支持直连（`AOS_APPIUM_URL`）或懒启动托管；模拟器保持现有 idb/simctl 后端不动（双后端）。首期（M9a）交付设备 façade（截图/层级/动作/复位）、真机路由与设计对比集成；M9b 交付 `mobile_run_task` 执行器与套件真机；M9c 交付真机日志/崩溃（工具链届时定）。iOS 18+ 隧道按官方要求引导式一次性 sudo 建立。

## User Stories

1. 作为测试工程师，我想 `mobile_get_device_state`（screenshot/hierarchy）在真机上可用，以便观察真机界面。
2. 作为测试工程师，我想真机的 tap/swipe/文本输入与复位（terminate+launch）工作正常，以便脚本化操作。
3. 作为测试工程师，我想 `mobile_run_task` 能指定真机 UDID 跑完整执行器（观察-动作循环），以便真机自动化闭环。
4. 作为测试工程师，我想套件（suite run --device）能对真机逐例复位与执行，以便回归。
5. 作为测试工程师，我想 `design_device_diff` / `compare_design_and_device` 支持真机截图源，以便真机做设计对比。
6. 作为测试工程师，我想支持 `.ipa` 安装（合法签名）与已安装应用/系统 App 两种路径，以便覆盖不同交付形态。
7. 作为使用者，我想 AOS 检测 Appium/xcuitest 驱动与隧道状态，缺失时给出可行动指引，而不是运行中才报错。
8. 作为使用者，我想有 `AOS_APPIUM_URL` 时直连既有 server，无则 AOS 托管懒启动/回收，以便适配本机与 CI 两类环境。
9. 作为使用者，我想 WDA 自动签名（复用本机 Apple Development 身份）且关键参数可 env 覆盖，以便签名链路可控。
10. 作为使用者，我想同一 UDID 的任务互斥排队、不同设备可并行，以便避免 WDA 会话冲突。
11. 作为使用者，我想 WDA 失联时任务能自愈重建会话（有限次），以便长会话稳定。
12. 作为使用者，我想 iOS 18+ 隧道未建立时有明确指引（sudo 一次性建立），已存在则复用，以便首次接入顺畅。
13. 作为使用者，我想设备被长任务占用时，观测请求快速得到 `device_busy` 与最近缓存帧（带时间戳/过期标记），而不是无限等待。
14. 作为使用者，我想真机日志/崩溃在 M9c 前被显式标注降级（而非静默失败），以便判断证据完备性。
15. 作为开发者，我想响应/警告带 `backend: wda|idb` 标识，以便区分设备画像。
16. 作为服务开发者，我想 WebDriver 交互全 mock 可测（fetch 打桩、不触网不用设备），以便 CI 稳定。
17. 作为服务开发者，我想 doctor/aos_status 呈现 Appium 与 iOS 真机链路状态，以便排障。
18. 作为服务维护者，我想行为变更同步 DESIGN/README/AGENTS/CONTEXT，以便文档是事实源。

## Implementation Decisions

- **后端与依赖**：AOS 新增 `ios/appium` 领域模块——依赖检测（appium 二进制、xcuitest 驱动版本、隧道就绪）、WebDriver HTTP 客户端、会话管理、Appium server 生命周期、WDA 设备 façade。唯一新增运行时依赖为 `fast-xml-parser`（纯 JS 零依赖；先例 `exceljs`）用于 page source 解析，其余用 Node 内置 fetch/child_process；Appium 采用检测现有安装（缺失给指引），托管安装后置。
- **配置**：`AOS_APPIUM_URL`（有则直连）；`AOS_IOS_WDA_BUNDLE_ID` / `AOS_IOS_XCODE_ORG_ID` / `AOS_IOS_XCODE_SIGNING_ID`（签名覆盖）；`AOS_IOS_SESSION_IDLE_MS`（观测类会话空闲回收，默认 30min，0=进程存活期不回收）；`AOS_IOS_OBSERVE_WAIT_MS`（观测请求拿锁有界等待，默认 5s，超时返回 `device_busy` + 最近缓存帧）；`AOS_IOS_APPIUM_TIMEOUT_MS`（WebDriver 请求超时，默认 120s）；`AOS_IOS_APPIUM_PORT`（托管启动端口，0/未设=自动）。读取项目 `.env` 打底、进程 env（客户端配置）覆盖（后置修订，见 DESIGN §13.57；原案为宿主级进程 env）。
- **会话管理**：按 UDID 的互斥 + FIFO 排队（一个设备同时最多一个 WDA session）；`mobile_run_task`/套件期间持有任务级 lease（finally 释放，不存在死锁路径），结束释放；观测类调用共享惰性会话，空闲回收默认 30min（`AOS_IOS_SESSION_IDLE_MS`，0=进程存活期保活）；观测请求拿不到锁时**有界等待**（`AOS_IOS_OBSERVE_WAIT_MS` 默认 5s）→ 结构化 `device_busy` + 最近缓存帧（`capturedAt`/`stale` 标记），不无限排队；自愈阶梯：best-effort `DELETE /session/:id`（忽略失败）→ `POST /session` → 仅托管模式有界重启 appium 一次（含退避）。capabilities 显式 `useNewWDA=false`（复用已装 WDA，避免每次重编译；WDA 进程启动成本仍需会话保活规避，首次构建耗时在 spike 实测）。v1 不做任务执行中的观测插队（WDA 会话有状态，读写锁/step 间隙复杂度过高，列入后续评估）。
- **能力映射**：截图（WebDriver screenshot → PNG）、层级（page source XML 经 `fast-xml-parser` → 现有 `IosUiNode` 结构；**解析失败降级**：只回截图 + `hierarchy:"parse_failed"`，不阻断流程）、动作（W3C actions：tap/swipe；文本输入为组合动作：有 `at` 坐标先 tap 聚焦 → 有界轮询键盘可见 → `typeText`；无坐标且键盘不可见给可行动错误；非 ASCII 走元素 setValue 路径，不可行时显式失败）、复位（`mobile: terminateApp` + `mobile: activateApp`；`--app` 语义）、应用安装（`mobile: installApp`，`.ipa` 需合法签名；`app_path` 语义在真机上=安装本地 .ipa）。
- **路由与降级**：`classifyIosSerial` 的 device 分支改用 WDA façade（模拟器保持 idb/simctl）；截图源 `captureIosPng` 增加 device 分支；观测/对比响应带 `backend` 标识；M9c 前真机日志缺失按 `ios-log-unsupported` 类显式降级，不静默。
- **Appium 生命周期**：未配置 `AOS_APPIUM_URL` 时懒启动 `appium --port <auto>`（检测二进制；healthz `/status` 就绪轮询），进程随 Runtime 释放；已配置时只校验可达性。隧道：检测并复用；未建立时返回可行动指引（`sudo appium driver run xcuitest tunnel-creation`），AOS 不执行 sudo。
- **签名**：capabilities 默认 `xcodeSigningId=Apple Development`、`updatedWDABundleId` 可覆盖；doctor/status 显示签名身份与隧道状态。
- **里程碑**：M9a（façade + 路由 + 设计对比）、M9b（执行器 + 套件）、M9c（日志/崩溃，候选 devicectl/pymobiledevice3）；spike 票先行（真机最小回路人工验证）。
- **约束**：仅新增 `fast-xml-parser` 一个运行时依赖（XML 解析；先例 `exceljs`）；stdout 规范不变；离线可测；真机冒烟为人工验收（文档化步骤）。

## Testing Decisions

- 好测试只验证外部行为：WebDriver 请求形状（URL/method/body）、会话复用/自愈/互斥、XML→节点转换、facade 语义、检测与错误文案；不测私有实现。
- 接缝与先例：
  1. **HTTP**：`globalThis.fetch`/注入 fetchImpl 打桩（先例 `test/figma-limits.test.js`、`test/jira-client.test.js`）——session 创建/删除、截图 base64、source XML、W3C actions payload、超时与错误映射。
  2. **XML 解析**：XCTest page source 单测（fixture 字符串）——嵌套、自闭合、属性实体（`&amp;`/`&quot;` 等）、`fast-xml-parser` 选项行为、畸形输入（解析失败 → 降级断言：只回截图 + `hierarchy:"parse_failed"`）。
  3. **会话管理**：注入假客户端 + 假时钟——任务级 lease（finally 释放）、空闲回收（默认 30min）、互斥排队、观测有界等待 → `device_busy` + 缓存帧、失联自愈阶梯（DELETE → POST → 托管重启有界一次）。
  4. **检测/生命周期**：注入 exec/env——二进制与驱动检测、`AOS_APPIUM_URL` 直连、缺失指引。
  5. **facade**：假客户端直测 tap/swipe/text/reset/截图/层级；`inputText` 覆盖键盘组合动作（有 `at` 聚焦 + 键盘有界等待、无键盘错误、非 ASCII 路径）。
  6. **路由**：`loadTestRuntime` + 假代理（先例 `test/ios-*.test.js`）——device UDID 走 WDA、模拟器不变、backend 标识、降级标注。
- 全程不依赖真机/外网；真机冒烟走 `scripts/` 人工脚本或文档步骤。

## Out of Scope

- iPad、watchOS/tvOS、无线（Wi-Fi）设备连接、iOS <18 兼容保证。
- Appium 托管自动安装（托管目录安装 appium/xcuitest 驱动）。
- WDA 预构建分发与签名工具链（fastlane/证书管理）。
- 真机并行多任务（同设备互斥；不同设备并行可用）。
- 任务执行期间的观测插队（读写锁 / step 间隙观测）——WDA 会话有状态，列入后续评估。
- 观测缓存帧的持久化（v1 仅进程内保留每设备最近一帧）。
- M9c 的日志/崩溃工具链选型（届时另开 spec/票据）。
- 模拟器后端迁移到 WDA（保持双后端；后续单独评估）。

## Further Notes

- 环境实测（2026-10-08）：Xcode 27.0 + iOS SDK 27、Apple Development 身份 2 个、Appium 3.8.0（xcuitest 12.15.0、appium-ios-remotexpc 已装）、`appium driver doctor xcuitest` 0 必需修复（applesimutils 可选缺失，仅 setPermission 用）；测试设备 iPhone 12（iOS 26.6.2，UDID 00008101-000359440C69001E）。
- idb 1.6.5 对真机：`ui` 命令明确拒绝（`Target is not a simulator`），screenshotr 失败（与 iOS 26 不兼容或设备锁屏/信任状态无关的版本问题）；真机能力以 WDA 为准。
- 隧道（iOS 18+）：官方要求 `sudo appium driver run xcuitest tunnel-creation`；AOS 只检测与指引。
- 真机冒烟目标：系统 App（设置/Safari）；Jira 两端验收在 M9b 后接真机 `mobile_run_task`。
- **评审反馈处理（2026-10-08）**：H1 成立（机制纠正：`usePrebuiltWDA` 只省构建不省 WDA 进程启动，关键在会话保活）→ 空闲回收默认 30min + `useNewWDA=false` 显式 + spike 实测冷启动；H2 部分成立（OOM/崩溃风险被夸大，实体与边界确实烦）→ 引入 `fast-xml-parser` + 解析失败强制降级；H3 成立 → `inputText` 改为聚焦 + 键盘有界等待的组合动作；M1 部分成立（非死锁，是等待 UX）→ 观测有界等待 + `device_busy` + 最近缓存帧，不做读写锁插队；M2 成立 → 自愈阶梯 DELETE → POST → 托管重启一次。
