import type { RegressionTaskRecord, RunnerDevice } from "../db/types.js";

/** 任务执行设备选择：
 * - `task.deviceSerial` 显式指定时只用该设备；
 * - 否则每个平台选一台，优先真实设备（kind=device），再模拟器/模拟机；
 * - 保序、去重；找不到匹配设备时返回空数组，由 runner 释放任务。 */
export function selectTaskDevices(
  devices: readonly RunnerDevice[],
  task: Pick<RegressionTaskRecord, "platforms" | "deviceSerial">
): RunnerDevice[] {
  const serial = (task.deviceSerial ?? "").trim();
  if (serial !== "") {
    const target = devices.find((device) => device.serial === serial);
    return target === undefined ? [] : [target];
  }
  const selected: RunnerDevice[] = [];
  for (const platform of [...new Set(task.platforms)]) {
    const candidates = devices.filter((device) => device.platform === platform);
    if (candidates.length === 0) continue;
    const real = candidates.filter((device) => device.kind === "device");
    selected.push(real[0] ?? candidates[0]!);
  }
  return selected;
}
