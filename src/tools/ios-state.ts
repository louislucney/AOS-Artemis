import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { liveScreenshotsDir } from "../artemis/assembly.js";
import type { IosDevice } from "../device/ios-actions.js";
import {
  classifyIosSerial,
  describeIosUi,
  listIosSimulators,
  type IosUiNode
} from "../device/ios.js";
import { IosDeviceBusyError } from "../ios/appium/session.js";
import type { WdaCaptureResult } from "../ios/appium/service.js";
import { annotateOcclusionWarnings, computeOcclusions } from "../ios/occlusion.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";

const MAX_HIERARCHY_LINES = 300;

export interface IosWdaDeps {
  nodes: (udid: string) => Promise<WdaCaptureResult<IosUiNode[]>>;
}

export interface IosDeviceStateDeps {
  platform?: NodeJS.Platform;
  listSimulators?: typeof listIosSimulators;
  describeIosUi?: (options: { serial: string }) => Promise<Awaited<ReturnType<typeof describeIosUi>>>;
  /** 截图取源（设备解析门面；缺省经 `runtime.iosDevice(serial)`）。 */
  device?: IosDevice;
  wda?: IosWdaDeps;
}

function writeLivePng(runtime: Runtime, serial: string, bytes: Buffer): string | null {
  const dir = liveScreenshotsDir(runtime.project.config, runtime.project.rootDir);
  const safe = serial.replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(dir, `live_screenshot_${safe}.png`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
  } catch {
    return null;
  }
  return file;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const IOS_STATE_ERRORS: Record<string, string> = {
  "ios-unsupported": "iOS 模拟器仅支持 macOS。",
  "no-serial": "缺少模拟器 UDID。",
  "not-found": "未找到 idb（iOS 设备工具；可用 AOS_IDB_PATH 指定，brew 安装 idb-companion + pipx install fb-idb）。",
  timeout: "idb 命令超时。",
  "command-failed": "idb 命令执行失败。"
};

function stateError(error: string | undefined, serial: string): string {
  const message = IOS_STATE_ERRORS[error ?? ""] ?? `未知错误（${error ?? "unknown"}）`;
  return `${message}（serial=${serial}）`;
}

export function formatIosHierarchy(nodes: IosUiNode[], maxLines = MAX_HIERARCHY_LINES): string {
  const application = nodes.find((node) => node.type === "Application" && node.rect.width > 200);
  const width = application
    ? application.rect.width
    : Math.max(1, ...nodes.map((node) => node.rect.x + node.rect.width));
  const height = application
    ? application.rect.height
    : Math.max(1, ...nodes.map((node) => node.rect.y + node.rect.height));
  const normalize = (value: number, total: number): number =>
    Math.max(0, Math.min(1000, Math.round((value * 1000) / total)));

  const lines: string[] = [];
  const lineIndexByNode = new Map<IosUiNode, number>();
  let processed = 0;
  for (const node of nodes) {
    const label = node.label.trim();
    const value = node.value.trim();
    if (!label && !value) continue;
    processed += 1;
    if (lines.length >= maxLines) continue;
    lineIndexByNode.set(node, lines.length + 1);
    const left = normalize(node.rect.x, width);
    const top = normalize(node.rect.y, height);
    const right = normalize(node.rect.x + node.rect.width, width);
    const bottom = normalize(node.rect.y + node.rect.height, height);
    const index = lines.length + 1;
    if (label) {
      let line = `[${index}] Text: '${label}' | Bounds: [${left},${top}][${right},${bottom}]`;
      if (value && value !== label) line += ` | Value: '${value}'`;
      lines.push(line);
    } else {
      lines.push(`[${index}] Value: '${value}' | Bounds: [${left},${top}][${right},${bottom}]`);
    }
  }
  const truncated = processed - lines.length;
  if (truncated > 0) lines.push(`... (truncated, ${truncated} more elements)`);
  const items = nodes.map((node) => ({
    rect: node.rect,
    type: node.type,
    hasText: Boolean(node.label.trim() || node.value.trim()),
    lineIndex: lineIndexByNode.get(node) ?? null
  }));
  const occlusions = computeOcclusions(items, width * height);
  return annotateOcclusionWarnings(lines, occlusions).join("\n");
}

/** Route `mobile_get_device_state` to the iOS simulator backend when the
 * requested serial is a simulator UDID; returns null to keep the ARTEMIS
 * passthrough for everything else. */
export async function maybeIosDeviceState(
  runtime: Runtime,
  args: Record<string, unknown>,
  deps: IosDeviceStateDeps = {}
): Promise<CallToolResult | null> {
  const serial = typeof args.device_serial === "string" ? args.device_serial.trim() : "";
  const serialKind = classifyIosSerial(serial);
  if (!serial || !serialKind) return null;

  const viewType = typeof args.view_type === "string" ? args.view_type : "";
  if (viewType !== "screenshot" && viewType !== "hierarchy") {
    return textResult(
      `Error: Invalid view_type '${viewType}'. Supported types are 'screenshot' and 'hierarchy'.`
    );
  }

  if (serialKind === "simulator") {
    const platform = deps.platform ?? process.platform;
    const listSimulators = deps.listSimulators ?? listIosSimulators;
    const listed = await listSimulators({ platform });
    if (!listed.ok) return textResult(`Error: ${stateError(listed.error, serial)}`);
    const simulator = listed.simulators.find((item) => item.udid === serial);
    if (!simulator) {
      return textResult(`Error: 未找到模拟器 ${serial}（xcrun simctl list devices 中无此 UDID）。`);
    }
    if (simulator.state !== "Booted") {
      return textResult(
        `Error: 模拟器 ${simulator.name || serial} 未启动（state=${simulator.state}）；请先执行 xcrun simctl boot ${serial}。`
      );
    }
  }

  const wda: IosWdaDeps =
    deps.wda ?? {
      nodes: (udid: string) => runtime.iosWda().nodes(udid)
    };

  if (viewType === "screenshot") {
    const device = deps.device ?? (await runtime.iosDevice(serial));
    if (!device) return textResult(`Error: 无法解析 iOS 设备（serial=${serial}）。`);
    let bytes: Buffer;
    try {
      bytes = await device.screenshot();
    } catch (error) {
      if (serialKind === "device" && error instanceof IosDeviceBusyError) {
        const frame = error.cachedFrame;
        if (frame !== null) {
          const file = writeLivePng(runtime, serial, frame.png);
          if (file === null) return textResult(`Error: iOS 截图写入失败（serial=${serial}）。`);
          return textResult(
            `file://${file}\n（device_busy：返回最近缓存帧，capturedAt=${frame.capturedAt}）`
          );
        }
        return textResult(
          `Error: iOS 真机截图失败（device_busy：设备正被任务占用；serial=${serial}）。`
        );
      }
      return textResult(
        serialKind === "device"
          ? `Error: iOS 真机截图失败（${errorMessage(error)}；serial=${serial}）。`
          : `Error: ${errorMessage(error)}（serial=${serial}）。`
      );
    }
    const file = writeLivePng(runtime, serial, bytes);
    if (file === null) return textResult(`Error: iOS 截图写入失败（serial=${serial}）。`);
    return textResult(`file://${file}`);
  }

  if (serialKind === "device") {
    const described = await wda.nodes(serial);
    if (!described.ok) {
      if (described.busy === true) {
        return textResult(
          `Error: iOS 真机层级失败（device_busy：设备正被任务占用，稍后重试；serial=${serial}）。`
        );
      }
      if (described.error === "parse_failed") {
        const device = deps.device ?? (await runtime.iosDevice(serial));
        let file: string | null = null;
        if (device) {
          try {
            file = writeLivePng(runtime, serial, await device.screenshot());
          } catch {
            file = null;
          }
        }
        const suffix = file !== null ? `；已回退截图: file://${file}` : "";
        return textResult(
          `Error: WDA 层级解析失败（hierarchy=parse_failed，serial=${serial}）${suffix}`
        );
      }
      return textResult(`Error: iOS 真机层级失败（${described.error}；serial=${serial}）。`);
    }
    return textResult(formatIosHierarchy(described.value));
  }

  const describe = deps.describeIosUi ?? ((options) => describeIosUi(options));
  const described = await describe({ serial });
  if (!described.ok) return textResult(`Error: ${stateError(described.error, serial)}`);
  return textResult(formatIosHierarchy(described.nodes));
}
