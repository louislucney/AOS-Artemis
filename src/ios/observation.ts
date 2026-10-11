import {
  captureIosPng,
  classifyIosSerial,
  describeIosUi,
  type IosPngCapture,
  type IosUiNode
} from "../device/ios.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { IosDeviceBusyError, type CachedFrame } from "./appium/session.js";
import type { WdaCaptureResult } from "./appium/service.js";

/** 观察模块（DESIGN §13.81）：截图/层级经统一入口返回判别结果——
 * 失败携带 serial 种类与 busy（含缓存帧）信息；模拟器走 idb/simctl 原始捕获，
 * 真机走 WDA 服务（结构化变体），消费方只做展示映射。 */
export interface ObserveDeps {
  captureIosPng?: (options?: { serial?: string | null }) => Promise<IosPngCapture>;
  describeIosUi?: (options: { serial: string }) => Promise<Awaited<ReturnType<typeof describeIosUi>>>;
  wdaScreenshot?: (udid: string) => Promise<WdaCaptureResult<Buffer>>;
  wdaNodes?: (udid: string) => Promise<WdaCaptureResult<IosUiNode[]>>;
}

export type ObserveKind = "device" | "simulator";

export type ScreenshotObservation =
  | { ok: true; serial: string; kind: ObserveKind; bytes: Buffer; backend: "wda" | "idb" | "simctl" }
  | {
      ok: false;
      serial: string;
      kind: ObserveKind;
      error: string;
      busy?: { cachedFrame: CachedFrame | null };
    };

export type HierarchyObservation =
  | { ok: true; serial: string; kind: ObserveKind; nodes: IosUiNode[]; backend: "wda" | "idb" }
  | {
      ok: false;
      serial: string;
      kind: ObserveKind;
      error: string;
      code: "busy" | "parse_failed" | "error";
      busy?: { cachedFrame: CachedFrame | null };
    };

async function captureWda<T>(
  udid: string,
  capture: (udid: string) => Promise<WdaCaptureResult<T>>
): Promise<WdaCaptureResult<T>> {
  try {
    return await capture(udid);
  } catch (error) {
    if (error instanceof IosDeviceBusyError) {
      return { ok: false, error: errorMessage(error), busy: true, cachedFrame: error.cachedFrame };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

export async function observeScreenshot(
  runtime: Runtime,
  serial: string,
  deps: ObserveDeps = {}
): Promise<ScreenshotObservation> {
  if (classifyIosSerial(serial) === "device") {
    const capture =
      deps.wdaScreenshot ?? ((udid: string) => runtime.iosWda().screenshot(udid));
    const wda = await captureWda(serial, capture);
    if (wda.ok) return { ok: true, serial, kind: "device", bytes: wda.value, backend: "wda" };
    return {
      ok: false,
      serial,
      kind: "device",
      error: wda.error,
      ...(wda.busy === true ? { busy: { cachedFrame: wda.cachedFrame } } : {})
    };
  }
  const capture = deps.captureIosPng ?? ((options) => captureIosPng(options ?? {}));
  let png: IosPngCapture;
  try {
    png = await capture({ serial });
  } catch (error) {
    png = { ok: false, serial, error: errorMessage(error) };
  }
  if (png.ok && png.bytes) {
    return {
      ok: true,
      serial: png.serial ?? serial,
      kind: "simulator",
      bytes: png.bytes,
      backend: png.tool === "simctl" ? "simctl" : "idb"
    };
  }
  return { ok: false, serial, kind: "simulator", error: png.error ?? "unknown" };
}

export async function observeHierarchy(
  runtime: Runtime,
  serial: string,
  deps: ObserveDeps = {}
): Promise<HierarchyObservation> {
  if (classifyIosSerial(serial) === "device") {
    const capture = deps.wdaNodes ?? ((udid: string) => runtime.iosWda().nodes(udid));
    const wda = await captureWda(serial, capture);
    if (wda.ok) return { ok: true, serial, kind: "device", nodes: wda.value, backend: "wda" };
    const code = wda.busy === true ? "busy" : wda.error === "parse_failed" ? "parse_failed" : "error";
    return {
      ok: false,
      serial,
      kind: "device",
      error: wda.error,
      code,
      ...(wda.busy === true ? { busy: { cachedFrame: wda.cachedFrame } } : {})
    };
  }
  const describe = deps.describeIosUi ?? ((options) => describeIosUi(options));
  const described = await describe({ serial });
  if (described.ok) {
    return { ok: true, serial, kind: "simulator", nodes: described.nodes, backend: "idb" };
  }
  return { ok: false, serial, kind: "simulator", error: described.error ?? "unknown", code: "error" };
}
