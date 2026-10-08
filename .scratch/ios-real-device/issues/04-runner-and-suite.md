# 04 — 真机执行器与套件（M9b）

**What to build:** `mobile_run_task` 在真机 UDID 上跑通（复用现有 iOS observe-think-act 执行器循环，设备 façade 切换为 WDA）；套件 `run --device <UDID>` 对真机逐例复位/执行/记录；任务台账与产物路径与模拟器同语义；`--app` 复位语义对齐（terminate+activate）。

**Blocked by:** 03 — 真机路由与设计对比集成。

**Status:** ready-for-agent

- [ ] `mobile_run_task(device_serial=<真机 UDID>, locked_app_package=...)` 任务级会话、执行器动作/截图/层级全走 WDA
- [ ] 任务台账/notes/步骤截图落盘与模拟器同构；失败分类沿用
- [ ] 套件 `--device` 真机逐例复位与执行；`--app` 语义（terminate+activate）
- [ ] Jira 两端验收路径打通（真机 mobile_run_task 可跑；系统 App 冒烟）
- [ ] 测试：执行器接口级 mock；真机冒烟为人工验收（文档化）

## Comments
