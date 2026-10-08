# 03 — 真机路由与设计对比集成（M9a 收口）

**What to build:** 把真机 UDID 的观测路径切到 WDA：`mobile_get_device_state`（screenshot/hierarchy）真机走 WDA；截图源 `captureIosPng` 增加 device 分支；`design_device_diff` 与 `compare_design_and_device` 支持真机截图源；响应/警告带 `backend: wda|idb`；真机日志类能力显式降级标注（M9c 前）。模拟器现有 idb/simctl 行为不变。

**Blocked by:** 02 — WDA 设备 façade 与会话管理。

**Status:** ready-for-agent

- [ ] device UDID：`mobile_get_device_state` 截图/层级走 WDA；Appium 不可用时结构化错误 + 指引（不回落模拟器后端）
- [ ] 观测请求遇长任务占用：有界等待后返回 `device_busy` + 最近缓存帧（`capturedAt`/`stale`）；层级解析失败时只回截图 + `hierarchy:"parse_failed"`
- [ ] `design_device_diff` / `compare_design_and_device` 真机可用（`device.platform:"ios"` 接受真机 UDID）
- [ ] `backend` 标识出现在响应/警告；真机日志调用标注降级
- [ ] 测试：假客户端路由、模拟器回归、Appium 缺失、busy/缓存帧与 parse_failed 分支

## Comments
