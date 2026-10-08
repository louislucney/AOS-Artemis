# 06 — 真机日志与崩溃取证（M9c，选型待定）

**What to build:** 真机设备日志与崩溃取证（当前两者都是模拟器专用路径）：先做工具链 spike（候选：`xcrun devicectl`、pymobiledevice3、libimobiledevice），确定后接通任务/套件证据链；在此之前真机调用保持显式降级标注。

**Blocked by:** 03 — 真机路由与设计对比集成。

**Status:** ready-for-agent

- [ ] 工具链 spike：三候选在本机（Xcode 27 / iOS 26.6）可用性、安装成本、日志窗口过滤与崩溃拉取能力，结论记入 Comments
- [ ] 选定后端接入任务/套件：日志采集与崩溃签名（与 Android 语义对齐或在文档明示差异）
- [ ] 降级标注移除/收窄；`aos_crashes` 真机来源可辨识（kind/来源字段）
- [ ] 测试：解析/窗口纯单测；真实拉取人工冒烟

## Comments
