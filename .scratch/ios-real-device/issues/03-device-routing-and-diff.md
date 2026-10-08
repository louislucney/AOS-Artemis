# 03 — 真机路由与设计对比集成（M9a 收口）

**What to build:** 把真机 UDID 的观测路径切到 WDA：`mobile_get_device_state`（screenshot/hierarchy）真机走 WDA；截图源 `captureIosPng` 增加 device 分支；`design_device_diff` 与 `compare_design_and_device` 支持真机截图源；响应/警告带 `backend: wda|idb`；真机日志类能力显式降级标注（M9c 前）。模拟器现有 idb/simctl 行为不变。

**Blocked by:** 02 — WDA 设备 façade 与会话管理。

**Status:** ready-for-agent

- [x] device UDID：`mobile_get_device_state` 截图/层级走 WDA；Appium 不可用时结构化错误 + 指引（不回落模拟器后端）
- [x] 观测请求遇长任务占用：有界等待后返回 `device_busy` + 最近缓存帧（`capturedAt`/`stale`）；层级解析失败时只回截图 + `hierarchy:"parse_failed"`
- [x] `design_device_diff` / `compare_design_and_device` 真机可用（`device.platform:"ios"` 接受真机 UDID）
- [x] `backend` 标识出现在响应/警告（真机截图 note "iOS 真机 WDA PNG（wda，"；日志降级在 M9c 前保持模拟器语义）
- [x] 测试：假客户端路由、模拟器回归、Appium 缺失、busy/缓存帧与 parse_failed 分支

## Comments

- 2026-10-08 进行中：`src/ios/appium/service.ts`（Runtime 级 WDA 服务：懒起 Appium server、会话管理单例、截图/层级/缓存帧/回收）+ Runtime `iosWda()` 惰性访问器；`mobile_get_device_state` 真机分支（截图落盘、层级走 WDA、`parse_failed` 回退截图、失败文案）；`captureLiveScreenshot` 真机分支（design diff / compare 自动受益，含 busy/隧道指引）。测试 `test/ios-wda-service.test.js`（3 例，假 HTTP 全链路 + device-source 分支）；全量 664 绿、lint 干净。待做：`backend` 标识显式化、真机 MCP 端到端冒烟（需重启会话加载新构建）、托管 appium 随进程退出回收（当前 orphan 风险）、文档同步。
- 2026-10-08 续：托管启动前先探测既有实例（复用，避免孤儿端口冲突，含测试）；**真机 MCP 端到端冒烟通过**（`scripts/aos-call.mjs` 全新进程 + 真机 UDID）：截图 ok=true 10.2s → `file://…/live_screenshots/live_screenshot_00008101-….png`（5.6MB PNG）；层级 ok=true 7.2s → 4549 字符格式化层级（真实主屏）；Appium 由服务自动托管拉起。全量 665 绿、lint 干净。剩余：`backend` 显式标识、appium 退出回收钩子、文档同步与设计对比真机抽查。
- 2026-10-08 完成：关停回收钩子（`Runtime.disposeIosWda()` + stdio/HTTP shutdown）；执行器 `mobile_run_task` 真机走 WDA façade（M9b 已接线）；文档同步（DESIGN §6.9/M9/§13.56、README、AGENTS、CONTEXT）；`backend` 由截图 note 承载。全量 665 绿、lint 干净。
