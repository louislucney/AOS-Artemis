import {
  IOS_DEFAULT_ALERTS,
  type IosAlertPolicy,
  type IosAlertResult,
  type IosDevice,
  type IosInputResult
} from "../../device/ios-actions.js";
import type { IosUiNode } from "../../device/ios.js";
import { errorMessage, sleep as defaultSleep } from "../../util.js";
import { AppiumError, type AppiumClient, type W3cAction } from "./client.js";
import type { AppiumSessionManager } from "./session.js";
import { parsePageSource } from "./xml.js";

export class IosHierarchyParseError extends Error {
  constructor() {
    super("WDA 层级解析失败（page source 不可解析）。");
    this.name = "IosHierarchyParseError";
  }
}

export interface WdaDeviceOptions {
  udid: string;
  manager: AppiumSessionManager;
  client: AppiumClient;
  leaseMode?: "task" | "observe";
  keyboardTimeoutMs?: number;
  keyboardPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function isSessionDead(error: unknown): boolean {
  if (!(error instanceof AppiumError)) return false;
  if (error.status === null || error.status === 404) return true;
  return error.wdError !== null && /invalid session|no such session/i.test(error.wdError);
}

function pointer(actions: Array<Record<string, unknown>>): W3cAction[] {
  return [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }];
}

function tapActions(x: number, y: number): W3cAction[] {
  return pointer([
    { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 100 },
    { type: "pointerUp", button: 0 }
  ]);
}

export function makeWdaDevice(options: WdaDeviceOptions): IosDevice {
  const { udid, manager, client } = options;
  const leaseMode = options.leaseMode ?? "observe";
  const keyboardTimeoutMs = options.keyboardTimeoutMs ?? 5_000;
  const keyboardPollMs = options.keyboardPollMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;

  const withLease = async <T>(fn: (sessionId: string) => Promise<T>): Promise<T> => {
    const lease = await manager.acquire(udid, leaseMode);
    try {
      return await fn(lease.sessionId);
    } catch (error) {
      if (isSessionDead(error)) lease.markInvalid();
      throw error;
    } finally {
      lease.release();
    }
  };

  const device: IosDevice = {
    serial: udid,
    platform: "ios",
    capabilities: { back: "none" },

    async tap(x, y) {
      await withLease((sessionId) => client.actions(sessionId, tapActions(x, y)));
    },

    async swipe(x1, y1, x2, y2, ms) {
      const duration = Math.max(1, Math.round(ms));
      await withLease((sessionId) =>
        client.actions(
          sessionId,
          pointer([
            { type: "pointerMove", duration: 0, x: Math.round(x1), y: Math.round(y1) },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 100 },
            { type: "pointerMove", duration, x: Math.round(x2), y: Math.round(y2) },
            { type: "pointerUp", button: 0 }
          ])
        )
      );
    },

    async inputText(text, at) {
      return await withLease(async (sessionId) => {
        if (at !== undefined) {
          await client.actions(sessionId, tapActions(at.x, at.y));
        }
        const attempts = Math.max(1, Math.ceil(keyboardTimeoutMs / keyboardPollMs));
        let visible = false;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            if (await client.isKeyboardShown(sessionId)) {
              visible = true;
              break;
            }
          } catch {
            break;
          }
          await sleep(keyboardPollMs);
        }
        if (!visible && at === undefined) {
          throw new Error("文本输入失败：键盘未出现；请先点击输入框（提供 at 坐标）后重试。");
        }
        try {
          await client.typeText(sessionId, text);
        } catch (error) {
          const hint = /^[\x20-\x7E]*$/.test(text)
            ? ""
            : "；真机非 ASCII 输入可能受 WDA 键盘限制（见 spike 结论）";
          throw new Error(`文本输入失败：${errorMessage(error)}${hint}`);
        }
        return { mode: "type" } satisfies IosInputResult;
      });
    },

    async launch(bundleId) {
      await withLease((sessionId) => client.activateApp(sessionId, bundleId));
    },

    async terminate(bundleId) {
      return await withLease((sessionId) => client.terminateApp(sessionId, bundleId));
    },

    async openUrl(url) {
      await withLease((sessionId) => client.execute(sessionId, "mobile: deepLink", [{ url }]));
    },

    async nodes() {
      const xml = await withLease((sessionId) => client.source(sessionId));
      const nodes = parsePageSource(xml);
      if (nodes === null) throw new IosHierarchyParseError();
      return nodes;
    },

    async size() {
      const application = (await device.nodes()).find(
        (node) => node.type === "Application" && node.rect.width > 200
      );
      if (!application) return null;
      return { width: application.rect.width, height: application.rect.height };
    },

    async screenshot() {
      const png = await withLease((sessionId) => client.screenshot(sessionId));
      manager.noteFrame(udid, png);
      return png;
    },

    async handleAlerts(policy: IosAlertPolicy = {}) {
      const mode = policy.mode ?? "accept";
      const result: IosAlertResult = { handled: 0, tapped: [] };
      if (mode === "keep") return result;
      const targets =
        mode === "dismiss"
          ? policy.dismiss ?? IOS_DEFAULT_ALERTS.dismiss
          : policy.accept ?? IOS_DEFAULT_ALERTS.accept;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let nodes: IosUiNode[];
        try {
          nodes = await device.nodes();
        } catch {
          return result;
        }
        const exact = nodes.find((node) => targets.includes(node.label.trim()));
        const fuzzy =
          exact ?? nodes.find((node) => targets.some((label) => node.label.includes(label)));
        if (!fuzzy) return result;
        const label = fuzzy.label.trim();
        try {
          await device.tap(fuzzy.rect.x + fuzzy.rect.width / 2, fuzzy.rect.y + fuzzy.rect.height / 2);
        } catch {
          return result;
        }
        result.handled += 1;
        result.tapped.push(label);
        await sleep(800);
      }
      return result;
    }
  };

  return device;
}
