# 04 — 真机执行器与套件（M9b）

**What to build:** `mobile_run_task` 在真机 UDID 上跑通（复用现有 iOS observe-think-act 执行器循环，设备 façade 切换为 WDA）；套件 `run --device <UDID>` 对真机逐例复位/执行/记录；任务台账与产物路径与模拟器同语义；`--app` 复位语义对齐（terminate+activate）。

**Blocked by:** 03 — 真机路由与设计对比集成。

**Status:** ready-for-agent

- [x] `mobile_run_task(device_serial=<真机 UDID>, locked_app_package=...)` 任务级会话、执行器动作/截图/层级全走 WDA
- [x] 任务台账/notes/步骤截图落盘与模拟器同构；失败分类沿用
- [x] 套件 `--device` 真机逐例复位与执行；`--app` 语义（terminate+activate）
- [ ] Jira 两端验收路径打通（真机 mobile_run_task 可跑；系统 App 冒烟）
- [x] 测试：执行器接口级 mock；真机冒烟为人工验收（文档化）

## Comments

- 2026-10-08 M9b 接线：`mobile_run_task` 真机设备 façade 走 `runtime.iosWda().device()`（执行器循环/截图/动作/复位语义原样复用）；`suiteResetFor` 支持第二参数 `{device}`，套件对真机在逐例复位前注入 WDA façade（`resetIosApp` 优先使用注入设备，terminate+activate），模拟器/无 runtime 注入时行为不变。全量 666 绿、lint 干净。Jira 两端验收与真机套件冒烟为人工验收（真机 `mobile_run_task` 已具备）。
