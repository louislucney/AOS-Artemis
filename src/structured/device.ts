import type { IosAlertPolicy, IosAlertResult, IosInputResult, IosPoint } from "../device/ios-actions.js";
import type { IosUiNode } from "../device/ios.js";

export interface StructuredPoint {
  x: number;
  y: number;
}

/** Shared device surface for the deterministic structured runner. iOS
 * (idb/Appium) and Android (adb) adapters both implement it, so target
 * resolution, assertions and evidence stay identical across platforms. */
export interface StructuredDevice {
  serial: string;
  platform: "ios" | "android";
  capabilities: { back: "none" | "keyevent" };
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>;
  inputText(text: string, at?: StructuredPoint): Promise<IosInputResult>;
  /** 清空当前聚焦输入框（最多 length 个字符）；不支持时 runner 跳过。 */
  clearText?(length: number): Promise<void>;
  /** 输入后收起键盘；不支持时 runner 跳过。 */
  hideKeyboard?(): Promise<void>;
  launch(appId: string): Promise<void>;
  terminate(appId: string): Promise<boolean>;
  openUrl(url: string): Promise<void>;
  nodes(): Promise<IosUiNode[]>;
  size(): Promise<{ width: number; height: number } | null>;
  screenshot(): Promise<Buffer>;
  handleAlerts(policy?: IosAlertPolicy): Promise<IosAlertResult>;
}

export type StructuredInputPoint = IosPoint;
