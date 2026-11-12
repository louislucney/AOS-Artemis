import { classifyIosSerial } from "../../device/ios.js";
import type { AppiumDetection } from "./detect.js";

export interface IosDriverPreflightInput {
  /** 真机 UDID：只有真机走 Appium/WDA；模拟器（idb/simctl）不在此检查。 */
  devices: string[];
  detection: AppiumDetection | null;
  /** 直连外部 Appium（AOS_APPIUM_URL）时本地 CLI 探测不代表服务端驱动，跳过。 */
  appiumUrl?: string | null;
}

export interface IosDriverPreflightResult {
  ok: boolean;
  code: "appium-driver-missing" | null;
  message: string;
}

/** 环境预检：只在能确定「Appium 已安装但缺 XCUITest 驱动」时阻断，
 * 避免把探测不到 CLI（远程 Appium / PATH 差异）误判成环境不可用。 */
export function iosDriverPreflight(input: IosDriverPreflightInput): IosDriverPreflightResult {
  const devices = input.devices
    .map((serial) => serial.trim())
    .filter((serial) => classifyIosSerial(serial) === "device");
  if (devices.length === 0) return { ok: true, code: null, message: "" };
  if ((input.appiumUrl ?? "").trim() !== "") return { ok: true, code: null, message: "" };
  const detection = input.detection;
  if (detection === null) return { ok: true, code: null, message: "" };
  if (!detection.appium.found || detection.xcuitest.installed) {
    return { ok: true, code: null, message: "" };
  }
  return {
    ok: false,
    code: "appium-driver-missing",
    message: `iOS 真机执行环境未就绪：Appium 已安装但缺少 XCUITest 驱动（设备 ${devices.join(", ")}）。请在执行机运行 appium driver install xcuitest 后重跑。`
  };
}
