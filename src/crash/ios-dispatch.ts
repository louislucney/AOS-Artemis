import { classifyIosSerial } from "../device/ios.js";
import { collectIosCrashes, type IosCrashCollectResult } from "./ios.js";
import { collectIosDeviceCrashes, IOS_DEVICE_CRASH_SOURCE } from "./ios-device.js";
import type { CrashSource } from "./types.js";

export interface IosCrashWindow {
  startMs: number | null;
  endMs: number | null;
  processName?: string | null;
}

export type IosCrashCollectFn = (
  window: IosCrashWindow
) => IosCrashCollectResult | Promise<IosCrashCollectResult>;

export type IosDeviceCrashCollectFn = (
  window: IosCrashWindow & { udid: string }
) => IosCrashCollectResult | Promise<IosCrashCollectResult>;

/** 分发依赖（互斥 union）：注入覆盖（任意 kind 都走它，来源标注与实际来源一致与否由调用方自担）
 * 或按 kind 自动分发（可分别覆盖模拟器/真机采集器）。 */
export type IosCrashDispatch =
  | { via: "injected"; collect: IosCrashCollectFn }
  | { via: "auto"; simulator?: IosCrashCollectFn; device?: IosDeviceCrashCollectFn };

export interface IosCrashCollection {
  collected: IosCrashCollectResult;
  source: CrashSource;
}

/** 崩溃采集分发唯一入口：serial 种类决定来源（模拟器读宿主 DiagnosticReports；
 * 真机经 devicectl 拉 systemCrashLogs），调用方不再自行判断。
 * 降级：模拟器为本地文件扫描（无网络/无超时）；真机 devicectl 有界超时，失败返回
 * 空记录或 `skipped`，不阻塞调用；采集器抛错由调用方（Runtime）统一兜底。 */
export async function collectIosCrashesFor(
  serial: string,
  window: IosCrashWindow,
  dispatch: IosCrashDispatch = { via: "auto" }
): Promise<IosCrashCollection> {
  if (dispatch.via === "injected") {
    return { collected: await dispatch.collect(window), source: "diagnostic-reports" };
  }
  if (classifyIosSerial(serial) === "device") {
    const collect = dispatch.device ?? collectIosDeviceCrashes;
    return {
      collected: await collect({ udid: serial, ...window }),
      source: IOS_DEVICE_CRASH_SOURCE
    };
  }
  const collect = dispatch.simulator ?? collectIosCrashes;
  return { collected: await collect(window), source: "diagnostic-reports" };
}
