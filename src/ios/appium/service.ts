import { spawn as defaultSpawn } from "node:child_process";

import type { IosDevice } from "../../device/ios-actions.js";
import { resolveObserveRetry, type IosUiNode } from "../../device/ios.js";
import { errorMessage, sleep } from "../../util.js";
import { buildIosCapabilities } from "./capabilities.js";
import { AppiumClient } from "./client.js";
import { IosHierarchyParseError, makeWdaDevice } from "./facade.js";
import { AppiumServerManager } from "./server.js";
import {
  AppiumSessionManager,
  IosDeviceBusyError,
  OBSERVE_WAIT_MS_DEFAULT,
  SESSION_IDLE_MS_DEFAULT,
  type CachedFrame
} from "./session.js";

/** 观测结果：`busy:true` 变体携带最近缓存帧（观察会话被任务占用时的结构化降级，DESIGN §13.79）。 */
export type WdaCaptureResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; busy?: false }
  | { ok: false; error: string; busy: true; cachedFrame: CachedFrame | null };

export interface IosWdaServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof defaultSpawn;
  sleep?: (ms: number) => Promise<void>;
  logPath?: string | null;
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, allowZero = false): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) return fallback;
  return Math.floor(value);
}

/** Runtime-scoped WDA service: lazily starts/reuses the Appium server, owns the
 * session manager and exposes device/observation captures for the iOS backend. */
export class IosWdaService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly spawnImpl: typeof defaultSpawn | undefined;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly logPath: string | null;
  private readonly server: AppiumServerManager;
  private client: AppiumClient | null = null;
  private sessions: AppiumSessionManager | null = null;

  constructor(options: IosWdaServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.spawnImpl = options.spawnImpl;
    this.sleep = options.sleep;
    this.logPath = options.logPath ?? null;
    this.server = new AppiumServerManager({
      env: this.env,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
      ...(this.sleep ? { sleep: this.sleep } : {}),
      logPath: this.logPath
    });
  }

  private async ensureClient(): Promise<AppiumClient> {
    if (this.client !== null) return this.client;
    const handle = await this.server.ensureReady();
    this.client = new AppiumClient({
      baseUrl: handle.baseUrl,
      timeoutMs: envNumber(this.env, "AOS_IOS_APPIUM_TIMEOUT_MS", 120_000),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
    });
    return this.client;
  }

  async device(udid: string): Promise<IosDevice> {
    const client = await this.ensureClient();
    if (this.sessions === null) {
      this.sessions = new AppiumSessionManager({
        client,
        capabilitiesFor: (id) => buildIosCapabilities({ udid: id, env: this.env }),
        idleMs: envNumber(this.env, "AOS_IOS_SESSION_IDLE_MS", SESSION_IDLE_MS_DEFAULT, true),
        observeWaitMs: envNumber(this.env, "AOS_IOS_OBSERVE_WAIT_MS", OBSERVE_WAIT_MS_DEFAULT)
      });
    }
    return makeWdaDevice({ udid, manager: this.sessions, client, leaseMode: "observe" });
  }

  async screenshot(udid: string): Promise<WdaCaptureResult<Buffer>> {
    try {
      const device = await this.device(udid);
      return { ok: true, value: await device.screenshot() };
    } catch (error) {
      if (error instanceof IosDeviceBusyError) {
        return { ok: false, error: errorMessage(error), busy: true, cachedFrame: error.cachedFrame };
      }
      return { ok: false, error: errorMessage(error) };
    }
  }

  async nodes(udid: string): Promise<WdaCaptureResult<IosUiNode[]>> {
    const attempts = 1 + resolveObserveRetry(this.env);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const device = await this.device(udid);
        return { ok: true, value: await device.nodes() };
      } catch (error) {
        lastError = error;
        if (error instanceof IosHierarchyParseError && attempt < attempts - 1) {
          await (this.sleep ?? sleep)(300);
          continue;
        }
        break;
      }
    }
    if (lastError instanceof IosHierarchyParseError) return { ok: false, error: "parse_failed" };
    if (lastError instanceof IosDeviceBusyError) {
      return {
        ok: false,
        error: errorMessage(lastError),
        busy: true,
        cachedFrame: lastError.cachedFrame
      };
    }
    return { ok: false, error: errorMessage(lastError) };
  }

  async installIpa(udid: string, ipaPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.device(udid);
      const sessions = this.sessions;
      const client = this.client;
      if (sessions === null || client === null) return { ok: false, error: "Appium 未就绪。" };
      const lease = await sessions.acquire(udid, "task");
      try {
        await client.installApp(lease.sessionId, ipaPath);
      } finally {
        lease.release();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async dispose(): Promise<void> {
    const sessions = this.sessions;
    this.sessions = null;
    this.client = null;
    if (sessions !== null) await sessions.dispose();
    await this.server.dispose();
  }
}
