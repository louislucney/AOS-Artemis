import fs from "node:fs";

import {
  defaultExec,
  defaultExecBuffer,
  resolveAdbPath,
  type ExecBufferFn,
  type ExecFn
} from "../../device/adb.js";
import type { IosUiNode } from "../../device/ios.js";
import { pngDimensions } from "../screens.js";
import type { ScrollProbeDevice } from "./probe.js";

export interface AndroidProbeOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  execBuffer?: ExecBufferFn;
  pathExists?: (candidate: string) => boolean;
  timeoutMs?: number;
}

function parseBounds(value: string | undefined): IosUiNode["rect"] {
  if (value === undefined) return { x: 0, y: 0, width: 0, height: 0 };
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value);
  if (match === null) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function attr(attrs: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1] ?? "";
}

/** Parse `uiautomator dump` XML into the same node shape used by the probe. */
export function parseAndroidNodes(xml: string): IosUiNode[] {
  const nodes: IosUiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = match[1] ?? "";
    const text = attr(attrs, "text");
    const desc = attr(attrs, "content-desc");
    const id = attr(attrs, "resource-id");
    nodes.push({
      type: "android",
      label: text !== "" ? text : desc,
      value: desc !== text ? desc : "",
      id,
      rect: parseBounds(attr(attrs, "bounds"))
    });
  }
  return nodes;
}

export function androidProbeDevice(
  serial: string,
  options: AndroidProbeOptions = {}
): ScrollProbeDevice {
  const env = options.env ?? process.env;
  const resolvedAdb = resolveAdbPath(env, process.platform, options.pathExists ?? fs.existsSync).path;
  if (resolvedAdb === null) throw new Error("adb 不可用");
  const adb = resolvedAdb;
  const exec = options.exec ?? defaultExec;
  const execBuffer = options.execBuffer ?? defaultExecBuffer;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastPng: Buffer | null = null;

  const shell = async (args: string[]): Promise<string> => {
    const result = await exec(adb, ["-s", serial, "shell", ...args], { timeoutMs });
    if (result.code !== 0 || result.error) {
      throw new Error(`adb shell ${args.join(" ")} 失败：${result.stderr.trim() || result.error || "exit != 0"}`);
    }
    return result.stdout;
  };

  return {
    unit: "device-px",
    async size() {
      if (lastPng === null) {
        const result = await execBuffer(adb, ["-s", serial, "exec-out", "screencap", "-p"], { timeoutMs });
        if (result.code !== 0 || result.error) return null;
        lastPng = result.stdout;
      }
      const dims = pngDimensions(lastPng);
      return dims === null ? null : { width: dims.width, height: dims.height };
    },
    async swipe(x1, y1, x2, y2, ms) {
      await shell(["input", "swipe", String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.max(1, Math.round(ms)))]);
    },
    async nodes() {
      await shell(["uiautomator", "dump", "/sdcard/aos-window.xml"]);
      const xml = await shell(["cat", "/sdcard/aos-window.xml"]);
      return parseAndroidNodes(xml);
    },
    async screenshot() {
      const result = await execBuffer(adb, ["-s", serial, "exec-out", "screencap", "-p"], { timeoutMs });
      if (result.code !== 0 || result.error) throw new Error(result.error ?? "adb screencap 失败");
      lastPng = result.stdout;
      return result.stdout;
    }
  };
}
