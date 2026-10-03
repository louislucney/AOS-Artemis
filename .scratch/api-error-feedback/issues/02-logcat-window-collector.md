# 02 — trace 时间窗 logcat 采集

**What to build:** 复用 `src/device/adb.ts`，实现按 trace 时间窗（start-5s 起）拉取设备日志的采集器；设备时钟探测、裁剪上限、失败分类与崩溃采集一致；顺带把 `formatLogTime`/时钟探测从 crash 采集抽出共用。

**Blocked by:** None.

**Status:** ready-for-agent

- [x] `collectLogcatWindow`：单设备/指定 serial；无 adb/无设备/日志为空 → 结构化 degraded，不抛错
- [x] 时钟探测失败按 0 偏差并回传 `clockWarning`
- [x] 假 exec 单测覆盖命令构造与降级分支；crash 采集用例不回归

## Comments

- 2026-10-02 实施：新增 `src/device/logcat.ts`——`formatLogcatTime`/`boundLogText`/`listAdbDevices`/`probeDeviceClock` 与 `AdbLogcatCollector.collect`（`logcat -v threadtime -d -T <start-5s>`，时钟偏差探测，`adb-not-found/no-serial/device-offline/log-empty` 结构化降级，`AOS_LOGCAT_TIMEOUT_MS` 可调）；`src/crash/collect.ts` 改为复用这些实现（`DeviceListResult` 保留再导出）；测试 `test/logcat-window.test.js` 3 例，crash 用例全绿。
