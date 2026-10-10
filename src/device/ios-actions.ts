import fs from "node:fs";

import { defaultExec, type ExecFn } from "./adb.js";
import {
  captureIosPng,
  describeIosUi,
  resolveIdbPath,
  resolveObserveRetry,
  resolveXcrunPath,
  type IosUiNode
} from "./ios.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface IosDeviceOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  timeoutMs?: number;
}

export interface IosPoint {
  x: number;
  y: number;
}

export interface IosInputResult {
  mode: "type" | "set";
}

export interface IosAlertPolicy {
  accept?: string[];
  dismiss?: string[];
  mode?: "accept" | "dismiss" | "keep";
}

export const IOS_DEFAULT_ALERTS = {
  accept: ["使用App时允许", "允许一次", "允许", "好"],
  dismiss: ["不允许", "拒绝"]
};

export interface IosAlertResult {
  handled: number;
  tapped: string[];
}

export interface IosDevice {
  serial: string;
  platform: "ios";
  capabilities: { back: "none" };
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>;
  inputText(text: string, at?: IosPoint): Promise<IosInputResult>;
  launch(bundleId: string): Promise<void>;
  terminate(bundleId: string): Promise<boolean>;
  openUrl(url: string): Promise<void>;
  nodes(): Promise<IosUiNode[]>;
  size(): Promise<{ width: number; height: number } | null>;
  screenshot(): Promise<Buffer>;
  handleAlerts(policy?: IosAlertPolicy): Promise<IosAlertResult>;
}

interface RunContext {
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
  platform: NodeJS.Platform;
  pathExists: (candidate: string) => boolean;
  timeoutMs: number;
  serial: string;
}

async function runIdb(
  ctx: RunContext,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const idb = resolveIdbPath(ctx.env, ctx.pathExists);
  const result = await ctx.exec(idb.path, args, { timeoutMs: ctx.timeoutMs });
  return { ok: result.code === 0 && !result.error, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

async function runIdbOrThrow(ctx: RunContext, args: string[], label: string): Promise<string> {
  const result = await runIdb(ctx, args);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.error || "exit != 0";
    throw new Error(`${label}失败：${detail}`);
  }
  return result.stdout;
}

async function runSimctlFallback(ctx: RunContext, args: string[]): Promise<boolean> {
  const xcrun = resolveXcrunPath(ctx.env, ctx.pathExists);
  const result = await ctx.exec(xcrun.path, ["simctl", ...args], { timeoutMs: ctx.timeoutMs });
  return result.code === 0 && !result.error;
}

function assertPlatform(ctx: RunContext): void {
  if (ctx.platform !== "darwin") {
    throw new Error("iOS 模拟器仅支持 macOS。");
  }
}

/** iOS simulator device facade (idb backend, simctl for lifecycle fallbacks).
 * Coordinates are logical points; idb requires integer values. */
export function makeIosDevice(serial: string, options: IosDeviceOptions = {}): IosDevice {
  const ctx: RunContext = {
    env: options.env ?? process.env,
    exec: options.exec ?? defaultExec,
    platform: options.platform ?? process.platform,
    pathExists: options.pathExists ?? fs.existsSync,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    serial: serial.trim()
  };
  if (!ctx.serial) throw new Error("iOS 设备需要模拟器 UDID。");

  return {
    serial: ctx.serial,
    platform: "ios",
    capabilities: { back: "none" },

    async tap(x, y) {
      assertPlatform(ctx);
      await runIdbOrThrow(
        ctx,
        ["ui", "tap", "--udid", ctx.serial, String(Math.round(x)), String(Math.round(y))],
        "idb tap "
      );
    },

    async swipe(x1, y1, x2, y2, ms) {
      assertPlatform(ctx);
      const duration = Math.max(0.1, ms / 1000);
      await runIdbOrThrow(
        ctx,
        [
          "ui",
          "swipe",
          "--udid",
          ctx.serial,
          String(Math.round(x1)),
          String(Math.round(y1)),
          String(Math.round(x2)),
          String(Math.round(y2)),
          "--duration",
          String(duration)
        ],
        "idb swipe "
      );
    },

    async inputText(text, at) {
      assertPlatform(ctx);
      const value = String(text);
      if (/^[\x20-\x7E]*$/.test(value)) {
        await runIdbOrThrow(ctx, ["ui", "text", "--udid", ctx.serial, value], "idb text ");
        return { mode: "type" };
      }
      if (!at) {
        throw new Error("idb 输入非 ASCII 需要目标坐标（set-value 路径）；请提供 at（logical point）。");
      }
      await runIdbOrThrow(
        ctx,
        [
          "ui",
          "set-value",
          "--api",
          "ax",
          "--udid",
          ctx.serial,
          "--value",
          value,
          String(Math.round(at.x)),
          String(Math.round(at.y))
        ],
        "idb set-value "
      );
      return { mode: "set" };
    },

    async launch(bundleId) {
      assertPlatform(ctx);
      const viaIdb = await runIdb(ctx, ["launch", "--udid", ctx.serial, bundleId]);
      if (viaIdb.ok) return;
      if (await runSimctlFallback(ctx, ["launch", ctx.serial, bundleId])) return;
      const detail = viaIdb.stderr.trim() || viaIdb.error || "exit != 0";
      throw new Error(`启动 ${bundleId} 失败：${detail}`);
    },

    async terminate(bundleId) {
      assertPlatform(ctx);
      const viaIdb = await runIdb(ctx, ["terminate", "--udid", ctx.serial, bundleId]);
      if (viaIdb.ok) return true;
      return runSimctlFallback(ctx, ["terminate", ctx.serial, bundleId]);
    },

    async openUrl(url) {
      assertPlatform(ctx);
      const viaIdb = await runIdb(ctx, ["open", "--udid", ctx.serial, url]);
      if (viaIdb.ok) return;
      if (await runSimctlFallback(ctx, ["openurl", ctx.serial, url])) return;
      const detail = viaIdb.stderr.trim() || viaIdb.error || "exit != 0";
      throw new Error(`打开 URL 失败：${detail}`);
    },

    async nodes() {
      assertPlatform(ctx);
      const attempts = 1 + resolveObserveRetry(ctx.env);
      let lastError = "unknown";
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = await describeIosUi({
          env: ctx.env,
          exec: ctx.exec,
          platform: ctx.platform,
          pathExists: ctx.pathExists,
          serial: ctx.serial,
          timeoutMs: ctx.timeoutMs
        });
        if (result.ok) return result.nodes;
        lastError = result.error;
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`idb ui describe-all 失败（${lastError}）。`);
    },

    async size() {
      const nodes = await this.nodes();
      const application = nodes.find((node) => node.type === "Application" && node.rect.width > 200);
      if (!application) return null;
      return { width: application.rect.width, height: application.rect.height };
    },

    async screenshot() {
      assertPlatform(ctx);
      const captured = await captureIosPng({
        env: ctx.env,
        exec: ctx.exec,
        platform: ctx.platform,
        pathExists: ctx.pathExists,
        serial: ctx.serial,
        timeoutMs: ctx.timeoutMs
      });
      if (!captured.ok || !captured.bytes) {
        throw new Error(`iOS 截图失败（${captured.error ?? "unknown"}）。`);
      }
      return captured.bytes;
    },

    async handleAlerts(policy = {}) {
      const mode = policy.mode ?? "accept";
      const result: IosAlertResult = { handled: 0, tapped: [] };
      if (mode === "keep") return result;
      const targets = mode === "dismiss"
        ? policy.dismiss ?? IOS_DEFAULT_ALERTS.dismiss
        : policy.accept ?? IOS_DEFAULT_ALERTS.accept;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let nodes: IosUiNode[];
        try {
          nodes = await this.nodes();
        } catch {
          return result;
        }
        const exact = nodes.find((node) => targets.includes(node.label.trim()));
        const fuzzy = exact ?? nodes.find((node) => targets.some((label) => node.label.includes(label)));
        if (!fuzzy) return result;
        const label = fuzzy.label.trim();
        try {
          await this.tap(fuzzy.rect.x + fuzzy.rect.width / 2, fuzzy.rect.y + fuzzy.rect.height / 2);
        } catch {
          return result;
        }
        result.handled += 1;
        result.tapped.push(label);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return result;
    }
  };
}
