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
  /** 诊断用：记录实际使用的 Appium 地址与归属（managed/external）。 */
  log?: (line: string) => void;
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
  private readonly log: (line: string) => void;

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
    this.log = options.log ?? (() => {});
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
      this.log(`Appium 直连（AOS_APPIUM_URL）：${baseUrl}`);
      return { baseUrl, managed: false };
    }
    if (this.child !== null && this.baseUrl !== null) {
      return { baseUrl: this.baseUrl, managed: true };
    }
    const port = Number(this.env.AOS_IOS_APPIUM_PORT ?? APPIUM_PORT_DEFAULT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`AOS_IOS_APPIUM_PORT 非法：${this.env.AOS_IOS_APPIUM_PORT ?? ""}`);
    }
    const preferredUrl = `http://127.0.0.1:${port}`;
    const reuseExisting = (this.env.AOS_APPIUM_REUSE_EXISTING ?? "").trim() === "1";
    let occupied = false;
    try {
      await this.probe(preferredUrl, this.probeTimeoutMs);
      occupied = true;
    } catch {
      /* free */
    }
    if (occupied) {
      if (reuseExisting) {
        this.baseUrl = preferredUrl;
        this.state = "running";
        this.log(`Appium 复用已有服务（AOS_APPIUM_REUSE_EXISTING=1）：${preferredUrl}`);
        return { baseUrl: preferredUrl, managed: false };
      }
      this.log(
        `端口 ${port} 已有 Appium（非本服务启动）：不静默复用（其驱动/APPIUM_HOME 可能与当前 CLI 不一致），改用托管实例`
      );
    }
    // 端口被占用时依次尝试后续端口；显式 AOS_APPIUM_URL 仍由上面的直连分支处理。
    const candidates: number[] = [];
    for (let offset = 0; offset <= 10; offset += 1) {
      const candidate = port + offset;
      if (candidate > 65535) break;
      if (offset === 0 && !occupied) candidates.push(candidate);
      else if (offset > 0) candidates.push(candidate);
    }
    if (candidates.length === 0) candidates.push(port);
    for (const candidate of candidates) {
      if (candidate !== port) {
        try {
          await this.probe(`http://127.0.0.1:${candidate}`, this.probeTimeoutMs);
          continue;
        } catch {
          /* free */
        }
      }
      return await this.startManaged(candidate);
    }
    throw new Error(
      `Appium 端口 ${port}–${Math.min(port + 10, 65535)} 均被占用：请停止一个实例，或设置 AOS_APPIUM_URL 显式复用。`
    );
  }

  private async startManaged(port: number): Promise<AppiumServerHandle> {
    const baseUrl = `http://127.0.0.1:${port}`;
    this.state = "starting";
    this.log(`Appium 启动：appium --port ${port}`);
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
    this.log(`Appium 就绪（managed）：${baseUrl}`);
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

  /** 托管服务重启（先等端口释放，再按当前策略重新就绪）；外部直连不在此处理。 */
  async restart(): Promise<AppiumServerHandle> {
    const baseUrl = this.baseUrl;
    await this.dispose();
    if (baseUrl !== null) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await this.probe(baseUrl, 500);
          await this.sleep(100);
        } catch {
          break;
        }
      }
    }
    return await this.ensureReady();
  }
}
