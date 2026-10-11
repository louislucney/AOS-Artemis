import { classifyIosSerial } from "./ios.js";
import { makeIosDevice, type IosDevice, type IosDeviceOptions } from "./ios-actions.js";

export interface ResolveIosDeviceDeps {
  /** Physical-device (WDA) provider; production binds `Runtime.iosWda().device`. */
  wdaDevice?: (udid: string) => Promise<IosDevice>;
  /** Simulator constructor options (tests inject exec/env/platform). */
  simulatorOptions?: IosDeviceOptions;
}

/** Device resolution: serial kind picks the backend. Non-iOS serial → null;
 * physical serial without a WDA provider throws (never silently builds a
 * simulator device for a real UDID). */
export async function resolveIosDevice(
  serial: string,
  deps: ResolveIosDeviceDeps = {}
): Promise<IosDevice | null> {
  const trimmed = serial.trim();
  const kind = classifyIosSerial(trimmed);
  if (!kind) return null;
  if (kind === "simulator") return makeIosDevice(trimmed, deps.simulatorOptions);
  if (!deps.wdaDevice) {
    throw new Error(
      `真机设备需要 WDA provider（经 Runtime.iosDevice 注入）后再解析：${trimmed}`
    );
  }
  return await deps.wdaDevice(trimmed);
}
