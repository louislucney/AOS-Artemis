import fs from "node:fs";

import { pngDimensions } from "../design/screens.js";
import {
  defaultExec,
  defaultExecBuffer,
  resolveAdbPath,
  type ExecBufferFn,
  type ExecFn
} from "./adb.js";
import type { IosAlertPolicy, IosAlertResult, IosInputResult } from "./ios-actions.js";
import type { IosUiNode } from "./ios.js";
import type { StructuredDevice } from "../structured/device.js";

export interface AndroidDeviceOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  execBuffer?: ExecBufferFn;
  pathExists?: (candidate: string) => boolean;
  timeoutMs?: number;
}

function attr(attrs: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1] ?? "";
}

function boundsOf(value: string): IosUiNode["rect"] {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value);
  if (match === null) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

/** `uiautomator dump` XML → the same node shape the structured runner uses.
 * `type` carries the Android class so `preferEditable` can find EditText. */
export function parseAndroidUiNodes(xml: string): IosUiNode[] {
  const nodes: IosUiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? "";
    const text = attr(attrs, "text");
    const desc = attr(attrs, "content-desc");
    nodes.push({
      type: attr(attrs, "class"),
      label: text !== "" ? text : desc,
      value: desc !== text ? desc : "",
      id: attr(attrs, "resource-id"),
      rect: boundsOf(attr(attrs, "bounds"))
    });
  }
  return nodes;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createAdbAndroidDevice(
  serial: string,
  options: AndroidDeviceOptions = {}
): StructuredDevice {
  const env = options.env ?? process.env;
  const adb = resolveAdbPath(env, process.platform, options.pathExists ?? fs.existsSync).path;
  if (adb === null) throw new Error("adb 不可用");
  const exec = options.exec ?? defaultExec;
  const execBuffer = options.execBuffer ?? defaultExecBuffer;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let cachedSize: { width: number; height: number } | null = null;

  const shell = async (args: string[]): Promise<string> => {
    const result = await exec(adb, ["-s", serial, "shell", ...args], { timeoutMs });
    if (result.code !== 0 || result.error) {
      throw new Error(
        `adb shell ${args.join(" ")} 失败：${result.stderr.trim() || result.error || "exit != 0"}`
      );
    }
    return result.stdout;
  };

  return {
    serial,
    platform: "android",
    capabilities: { back: "keyevent" },
    async size() {
      if (cachedSize !== null) return cachedSize;
      try {
        const output = await shell(["wm", "size"]);
        const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/i.exec(output);
        if (match !== null) {
          cachedSize = { width: Number(match[1]), height: Number(match[2]) };
          return cachedSize;
        }
      } catch {
        /* fall through to screenshot dimensions */
      }
      const shot = await execBuffer(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
        timeoutMs
      });
      if (shot.code === 0 && !shot.error) {
        const dims = pngDimensions(shot.stdout);
        if (dims !== null) {
          cachedSize = dims;
          return cachedSize;
        }
      }
      return null;
    },
    async nodes() {
      await shell(["uiautomator", "dump", "/sdcard/aos-window.xml"]);
      const xml = await shell(["cat", "/sdcard/aos-window.xml"]);
      return parseAndroidUiNodes(xml);
    },
    async tap(x, y) {
      await shell(["input", "tap", String(Math.round(x)), String(Math.round(y))]);
    },
    async swipe(x1, y1, x2, y2, ms) {
      await shell([
        "input",
        "swipe",
        String(Math.round(x1)),
        String(Math.round(y1)),
        String(Math.round(x2)),
        String(Math.round(y2)),
        String(Math.max(1, Math.round(ms)))
      ]);
    },
    async inputText(text): Promise<IosInputResult> {
      if (/^[\x20-\x7e]*$/.test(text)) {
        await shell(["input", "text", shellQuote(text.replace(/ /g, "%s"))]);
        return { mode: "type" };
      }
      const imes = await shell(["ime", "list", "-s"]);
      if (!imes.includes("com.android.adbkeyboard/.AdbIME")) {
        throw new Error("input-unsupported:adbkeyboard-missing");
      }
      await shell([
        "am",
        "broadcast",
        "-a",
        "ADB_INPUT_B64",
        "--es",
        "msg",
        Buffer.from(text, "utf8").toString("base64")
      ]);
      return { mode: "type" };
    },
    async clearText(length) {
      const count = Math.min(Math.max(1, Math.trunc(length)), 200);
      await shell(["input", "keyevent", "KEYCODE_MOVE_END"]);
      await shell([
        "input",
        "keyevent",
        ...Array.from({ length: count }, () => "KEYCODE_DEL")
      ]);
    },
    async hideKeyboard() {
      const state = await shell(["dumpsys", "input_method"]).catch(() => "");
      if (/mInputShown=true/.test(state)) {
        await shell(["input", "keyevent", "KEYCODE_BACK"]);
      }
    },
    async launch(appId) {
      await shell(["monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1"]);
    },
    async terminate(appId) {
      try {
        await shell(["am", "force-stop", appId]);
        return true;
      } catch {
        return false;
      }
    },
    async openUrl() {
      /* deterministic runner does not open URLs */
    },
    async screenshot() {
      const result = await execBuffer(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
        timeoutMs
      });
      if (result.code !== 0 || result.error) {
        throw new Error(result.error ?? "adb screencap 失败");
      }
      return result.stdout;
    },
    async handleAlerts(_policy?: IosAlertPolicy): Promise<IosAlertResult> {
      return { handled: 0, tapped: [] };
    }
  };
}
