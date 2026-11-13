import { classifyIosSerial } from "../../device/ios.js";

export const DEFAULT_WDA_BUNDLE_ID = "com.aos.mcp.wda";
export const DEFAULT_IOS_SIGNING_ID = "Apple Development";

export interface IosCapabilitiesOptions {
  udid: string;
  env?: NodeJS.ProcessEnv;
}

/** WDA/XCUITest capabilities for a physical device, with spike-validated
 * defaults (reuse installed WDA, auto device registration) and env overrides. */
export function buildIosCapabilities(options: IosCapabilitiesOptions): Record<string, unknown> {
  const env = options.env ?? process.env;
  const bundleId = env.AOS_IOS_WDA_BUNDLE_ID?.trim();
  const signingId = env.AOS_IOS_XCODE_SIGNING_ID?.trim();
  const capabilities: Record<string, unknown> = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:udid": options.udid.trim(),
    "appium:useNewWDA": false,
    "appium:allowProvisioningDeviceRegistration": true,
    "appium:updatedWDABundleId": bundleId && bundleId !== "" ? bundleId : DEFAULT_WDA_BUNDLE_ID,
    "appium:xcodeSigningId":
      signingId && signingId !== "" ? signingId : DEFAULT_IOS_SIGNING_ID,
    "appium:newCommandTimeout": 300
  };
  const team = env.AOS_IOS_XCODE_ORG_ID?.trim();
  if (team && team !== "") capabilities["appium:xcodeOrgId"] = team;
  // 真机默认把 xcodebuild 输出写入 Appium 日志（AOS 落盘 .artemis/logs/appium.log）；
  // AOS_IOS_SHOW_XCODE_LOG=0 可关闭。
  const showXcodeLog = (env.AOS_IOS_SHOW_XCODE_LOG ?? "").trim();
  if (classifyIosSerial(options.udid) === "device" && showXcodeLog !== "0") {
    capabilities["appium:showXcodeLog"] = true;
  }
  return capabilities;
}
