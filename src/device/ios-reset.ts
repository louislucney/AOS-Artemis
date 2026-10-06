import fs from "node:fs";

import { errorMessage } from "../util.js";
import { makeIosDevice, type IosDevice, type IosDeviceOptions } from "./ios-actions.js";
import { classifyIosSerial } from "./ios.js";
import {
  APP_PACKAGE_PATTERN,
  type AppResetOutcome,
  type AppResetRequest
} from "./reset.js";

export interface IosResetOptions extends IosDeviceOptions {
  device?: IosDevice;
}

const MISSING_ADB = { path: null, source: "missing" as const };

/** iOS simulator app reset: terminate (best effort) then launch. */
export async function resetIosApp(
  request: AppResetRequest,
  options: IosResetOptions = {}
): Promise<AppResetOutcome> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const serial = request.serial ?? null;
  const packageName = request.packageName?.trim() ?? "";
  const commands: string[][] = [];

  if (!APP_PACKAGE_PATTERN.test(packageName)) {
    return {
      ok: false,
      reason: "invalid-package",
      message: `非法应用包名：${request.packageName}`,
      serial,
      adb: MISSING_ADB,
      commands
    };
  }
  if (platform !== "darwin") {
    return {
      ok: false,
      reason: "ios-unsupported",
      message: "iOS 复位仅支持 macOS。",
      serial,
      adb: MISSING_ADB,
      commands
    };
  }
  if (!serial || !classifyIosSerial(serial)) {
    return {
      ok: false,
      reason: "ios-unsupported",
      message: "iOS 复位需要 iOS 设备 UDID（模拟器或真机）。",
      serial,
      adb: MISSING_ADB,
      commands
    };
  }

  const device =
    options.device ??
    makeIosDevice(serial, {
      env,
      exec: options.exec,
      platform,
      pathExists: options.pathExists ?? fs.existsSync
    });

  commands.push(["idb", "terminate", "--udid", serial, packageName]);
  try {
    await device.terminate(packageName);
  } catch {
    /* best effort */
  }

  commands.push(["idb", "launch", "--udid", serial, packageName]);
  try {
    await device.launch(packageName);
  } catch (error) {
    return {
      ok: false,
      reason: "launch-failed",
      message: errorMessage(error),
      serial,
      adb: MISSING_ADB,
      commands
    };
  }

  return { ok: true, serial, adb: MISSING_ADB, commands };
}
