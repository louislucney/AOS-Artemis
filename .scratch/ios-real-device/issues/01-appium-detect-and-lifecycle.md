# 01 — Appium 检测与生命周期

**What to build:** `ios/appium` 模块的依赖检测与服务生命周期：检测 appium 二进制、xcuitest 驱动、隧道与签名身份；`AOS_APPIUM_URL` 有则直连（仅校验可达），无则懒启动/回收 appium server；doctor 与 `aos_status` 呈现状态与可行动指引。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 检测分支：appium 缺失 / xcuitest 驱动缺失 / 隧道未建立，分别返回可行动指引（工具错误与 doctor 一致口径）
- [ ] `AOS_APPIUM_URL` 设置时只校验 `/status` 可达；未设置时懒启动 `appium`（端口自动，`AOS_IOS_APPIUM_PORT` 可指定），就绪轮询，Runtime 释放时回收子进程
- [ ] doctor 与 `aos_status.ios` 显示 appium 版本、xcuitest 版本、隧道/签名状态
- [ ] 测试：注入 exec/env/fetch 覆盖检测分支、直连与托管启动、失败指引；不触网不用设备

## Comments
