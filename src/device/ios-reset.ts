import fs from "node:fs";

import { errorMessage } from "../util.js";
import { type IosDevice, type IosDeviceOptions } from "./ios-actions.js";
import { resolveIosDevice } from "./ios-facade.js";
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
const DEFAULT_RESET_WAIT_MS = 1_000;

function resetWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_IOS_RESET_WAIT_MS ?? "", 10);
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_RESET_WAIT_MS;
  return Math.min(raw, 30_000);
}

/** iOS app reset: terminate (best effort) → launch；配置了 AOS_IOS_RESET_URL 时
 * 再打开 App 内建复位入口，等待后重新 launch。普通 reset 不清 Keychain，
 * 需要 fresh 的场景必须由 App 提供内建复位或明确的 fresh 适配器。 */
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
    (await resolveIosDevice(serial, {
      simulatorOptions: {
        env,
        exec: options.exec,
        platform,
        pathExists: options.pathExists ?? fs.existsSync
      }
    }));
  if (device === null) {
    return {
      ok: false,
      reason: "ios-unsupported",
      message: "无法解析 iOS 设备。",
      serial,
      adb: MISSING_ADB,
      commands
    };
  }

  const backgroundBundles = (env.AOS_IOS_BACKGROUND_BUNDLES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== packageName);
  for (const bundle of backgroundBundles) {
    commands.push(["terminate", bundle]);
    await device.terminate(bundle).catch(() => undefined);
  }

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

  const alertMode = (env.AOS_IOS_RESET_ALERTS ?? "").trim();
  if (alertMode === "accept" || alertMode === "dismiss" || alertMode === "keep") {
    commands.push(["alerts", alertMode]);
    try {
      await device.handleAlerts({ mode: alertMode });
    } catch (error) {
      return {
        ok: false,
        reason: "launch-failed",
        message: `系统弹窗处理失败：${errorMessage(error)}`,
        serial,
        adb: MISSING_ADB,
        commands
      };
    }
  }

  const resetUrl = (env.AOS_IOS_RESET_URL ?? "").trim();
  if (resetUrl !== "") {
    commands.push(["openUrl", resetUrl]);
    try {
      await device.openUrl(resetUrl);
    } catch (error) {
      return {
        ok: false,
        reason: "app-internal-reset-failed",
        message: `应用内建复位入口打开失败：${errorMessage(error)}`,
        serial,
        adb: MISSING_ADB,
        commands
      };
    }
    await new Promise((resolve) => setTimeout(resolve, resetWaitMs(env)));
    commands.push(["idb", "launch", "--udid", serial, packageName]);
    try {
      await device.launch(packageName);
    } catch (error) {
      return {
        ok: false,
        reason: "app-internal-reset-failed",
        message: `应用内建复位后重新启动失败：${errorMessage(error)}`,
        serial,
        adb: MISSING_ADB,
        commands
      };
    }
  }

  return { ok: true, serial, adb: MISSING_ADB, commands };
}
