# 04 — 用例间状态复位：语义验证与确定性复位通道

**What to build:** 确认上游"锁定应用"的启动语义（app 已在前台时不会回到入口屏），并提供一个可被运行器复用的确定性复位能力：给定设备 serial 与应用包名，执行 force-stop + launcher 启动；无 adb / 云真机部署时返回可报告的降级状态而不是阻塞。真机验证一次即可定论。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] 真机验证记录（无设备时给出静态结论与待验证标记）：前台不重启、非前台 monkey 启动落点
- [x] 复位能力可复用并返回结构化结果（成功/降级/原因）
- [x] 无 adb 或设备不可用时降级，不抛出阻塞运行
- [x] 单测覆盖命令构造与降级分支（假 exec），不依赖真实设备

## Comments

- 2026-10-01 真机验证（emulator-5554，Android sdk_gphone16k_arm64）：初始主 `Settings` 前台；`am start -a android.settings.WIFI_SETTINGS` 进入深层页后，单独 `monkey -p com.android.settings -c LAUNCHER 1` 可把主 Activity 拉回前台（同 task）；`am force-stop` + monkey 产生全新 task（t207）并落主界面。结合上游 `_handle_initial_app_launch`「已在前台即跳过启动」（`artemis/artemis/utils/app_launch_utils.py:369-378`），确认深层页会被带入下一用例；复位用 force-stop + monkey 确定性最强。
- 2026-10-01 实施：adb 解析/执行/失败分类抽到 `src/device/adb.ts`（`src/crash/collect.ts` 导出面保留，崩溃测试不回归）；新增 `src/device/reset.ts`（`resetApp`：包名校验 → force-stop → monkey LAUNCHER；返回 `{ok, reason, message, serial, adb, commands}`；`invalid-package/adb-not-found/device-offline/timeout/force-stop-failed/launch-failed` 分类，环境类降级不抛错；`AOS_RESET_TIMEOUT_MS` 1s–120s，默认 15s）。测试 `test/reset.test.js`（9 例）；全量 330 例通过，lint 绿。运行器消费见票据 08。
