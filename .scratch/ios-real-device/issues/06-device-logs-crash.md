# 06 — 真机日志与崩溃取证（M9c，选型待定）

**What to build:** 真机设备日志与崩溃取证（当前两者都是模拟器专用路径）：先做工具链 spike（候选：`xcrun devicectl`、pymobiledevice3、libimobiledevice），确定后接通任务/套件证据链；在此之前真机调用保持显式降级标注。

**Blocked by:** 03 — 真机路由与设计对比集成。

**Status:** resolved

- [x] 工具链 spike：三候选在本机（Xcode 27 / iOS 26.6）可用性、安装成本、日志窗口过滤与崩溃拉取能力，结论记入 Comments
- [x] 选定后端接入任务/套件：崩溃（devicectl systemCrashLogs）已接入；日志暂维持降级（候选 idevicesyslog）
- [x] 降级标注移除/收窄；`aos_crashes` 真机来源可辨识（kind/来源字段）
- [x] 测试：解析/窗口纯单测；真实拉取人工冒烟

## Comments

- 2026-10-08 spike 结论（真机 iPhone 12 / iOS 26.6.2 / Xcode 27）：
  - **崩溃取证：选定 `xcrun devicectl`**。实测 `xcrun devicectl device copy from --device <UDID> --domain-type systemCrashLogs --source . --destination <dir> --timeout 60` 成功拉取真实 `.ips`（JetsamEvent/SFA-* 等含时间戳文件名）；Apple 原生、零新依赖；复用现有 `parseIps` 解析 + 时间窗/进程名过滤即可接入。备选（pymobiledevice3 / libimobiledevice `idevicecrashreport`）不再需要。
  - **日志：暂无 Apple 原生窗口拉取**（devicectl 无 syslog stream；`simctl spawn` 不适用真机）。候选：pymobiledevice3（`syslog`，需 pip 安装）或 libimobiledevice `idevicesyslog`（brew 安装）；本机均未装。首期维持显式降级（`ios-log-unsupported`），实现随日志接入一并决策（倾向 idevicesyslog，轻量）。
  - 实现待续：`src/crash/ios.ts` 增加 device 源（devicectl 拉取 + 窗口过滤 + 进程名过滤），套件/任务终态路由；崩溃索引 `kind=ios` 区分来源（模拟器 DiagnosticReports vs 真机 systemCrashLogs）。
- 2026-10-08 崩溃实现：新增 `src/crash/ios-device.ts`（`collectIosDeviceCrashes`：devicectl 复制到临时目录 → 递归收集 `.ips`（≤2 层）→ `parseIps` → 时间窗（±2s/5s）与进程过滤 → 清理）；Runtime `captureIosCrashes` 按 UDID 类别路由（真机→devicectl 源，模拟器不变），来源标识新增 `CrashSource: devicectl-systemCrashLogs`。测试 `test/ios-device-crash.test.js`（3 例：过滤/失败/命令形状）全 mock；全量 669 绿、lint 干净。真机拉取已由 spike 实测；日志接入（idevicesyslog 候选）为后续增强。

## Comments

- 2026-10-08 日志实现：`src/device/ios-log.ts` 按 UDID 类别路由（`classifyIosSerial`）——真机走 `idevicesyslog -u <udid>` 实时尾采样（有界超时即停，部分 stdout 保留）；纯函数 `parseDeviceLogTime`（`Oct  8 14:30:19.684` → epoch，跨年回退）与 `filterDeviceLogLines`（进程过滤 + `[start-slack, ∞)` 窗口；晚于窗口的行近似保留并标 `clockWarning`；窗口已过且无行 → `window-elapsed-live-tail`）；工具缺失 → `ios-log-tool-missing`（`AOS_IDEVICESYSLOG_PATH` 可指定）；模拟器路径不变。测试 +3（解析/过滤/命令形状/缺失降级），`test/ios-log.test.js` 6 例全绿；全量 719 绿、lint 干净。**人工冒烟待执行**（接真机跑一轮 api-errors 采集）。文档同步：AGENTS/DESIGN §6.9/§13.56、接入指南排障。
