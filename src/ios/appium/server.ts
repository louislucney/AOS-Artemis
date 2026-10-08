import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

import { errorMessage, sleep as defaultSleep } from "../../util.js";

export type AppiumServerState = "stopped" | "starting" | "running" | "direct" | "failed";

export interface AppiumServerHandle {
  baseUrl: string;
  managed: boolean;
}

export interface AppiumServerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof defaultSpawn;
  sleep?: (ms: number) => Promise<void>;
  logPath?: string | null;
  startupTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export const APPIUM_PORT_DEFAULT = 4723;
export const APPIUM_STARTUP_TIMEOUT_MS_DEFAULT = 30_000;

/** Appium server lifecycle: direct connection via AOS_APPIUM_URL or a lazily
 * spawned managed server with /status readiness polling. */
export class AppiumServerManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof defaultSpawn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logPath: string | null;
  private readonly startupTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private state: AppiumServerState = "stopped";

  constructor(options: AppiumServerOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.sleep = options.sleep ?? defaultSleep;
    this.logPath = options.logPath ?? null;
    this.startupTimeoutMs = options.startupTimeoutMs ?? APPIUM_STARTUP_TIMEOUT_MS_DEFAULT;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  }

  current(): { state: AppiumServerState; baseUrl: string | null; managed: boolean } {
    return {
      state: this.state,
      baseUrl: this.baseUrl,
      managed: this.child !== null && this.baseUrl !== null
    };
  }

  private async probe(baseUrl: string, timeoutMs: number): Promise<void> {
    const res = await this.fetchImpl(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`/status 返回 ${res.status}`);
  }

  async ensureReady(): Promise<AppiumServerHandle> {
    const direct = this.env.AOS_APPIUM_URL?.trim();
    if (direct && direct !== "") {
      const baseUrl = direct.replace(/\/+$/, "");
      await this.probe(baseUrl, this.probeTimeoutMs);
      this.baseUrl = baseUrl;
      this.state = "direct";
      return { baseUrl, managed: false };
    }
    if (this.child !== null && this.baseUrl !== null) {
      return { baseUrl: this.baseUrl, managed: true };
    }
    const port = Number(this.env.AOS_IOS_APPIUM_PORT ?? APPIUM_PORT_DEFAULT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`AOS_IOS_APPIUM_PORT 非法：${this.env.AOS_IOS_APPIUM_PORT ?? ""}`);
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await this.probe(baseUrl, this.probeTimeoutMs);
      this.baseUrl = baseUrl;
      this.state = "running";
      return { baseUrl, managed: false };
    } catch {
      /* no existing server on the port — spawn one */
    }
    this.state = "starting";
    const child = this.spawnImpl("appium", ["--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.attachLog(child);
    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      if (child.exitCode !== null) {
        this.state = "failed";
        throw new Error(`appium 启动失败（exit code ${child.exitCode}）。`);
      }
      try {
        await this.probe(baseUrl, this.probeTimeoutMs);
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          this.state = "failed";
          throw new Error(`appium 启动超时：${errorMessage(error)}`);
        }
        await this.sleep(250);
      }
    }
    this.baseUrl = baseUrl;
    this.state = "running";
    return { baseUrl, managed: true };
  }

  private attachLog(child: ChildProcess): void {
    if (this.logPath === null) return;
    try {
      fs.mkdirSync(this.logPath.substring(0, this.logPath.lastIndexOf("/")), { recursive: true });
      const stream = fs.createWriteStream(this.logPath, { flags: "a" });
      child.stdout?.pipe(stream);
      child.stderr?.pipe(stream);
    } catch {
      /* logging is best effort */
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    this.state = "stopped";
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}
