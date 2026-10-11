import type { AppiumClient } from "./client.js";

export interface CachedFrame {
  png: Buffer;
  capturedAt: string;
  /** epoch ms（旧数据/测试桩缺失时回退解析 `capturedAt`）。 */
  capturedAtMs?: number;
}

export const CACHED_FRAME_MAX_AGE_MS_DEFAULT = 10 * 60_000;

/** `AOS_IOS_CACHED_FRAME_MAX_AGE_MS`（默认 10min；0 = 关闭陈旧判定）。 */
export function resolveCachedFrameMaxAgeMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_IOS_CACHED_FRAME_MAX_AGE_MS ?? "", 10);
  if (!Number.isInteger(raw) || raw < 0) return CACHED_FRAME_MAX_AGE_MS_DEFAULT;
  return raw;
}

/** 帧年龄（ms）：优先 `capturedAtMs`，否则解析 ISO `capturedAt`；不可解析返回 null。 */
export function frameAgeMs(frame: CachedFrame, nowMs: number): number | null {
  const captured =
    typeof frame.capturedAtMs === "number" && Number.isFinite(frame.capturedAtMs)
      ? frame.capturedAtMs
      : Date.parse(frame.capturedAt);
  if (!Number.isFinite(captured)) return null;
  return Math.max(0, nowMs - (captured as number));
}

/** maxAgeMs <= 0 关闭陈旧判定（始终视为 fresh）。 */
export function isFrameStale(frame: CachedFrame, nowMs: number, maxAgeMs: number): boolean {
  if (maxAgeMs <= 0) return false;
  const age = frameAgeMs(frame, nowMs);
  return age !== null && age > maxAgeMs;
}

export class IosDeviceBusyError extends Error {
  readonly cachedFrame: CachedFrame | null;

  constructor(cachedFrame: CachedFrame | null) {
    super("iOS 设备正被任务占用，观测请求有界等待超时。");
    this.name = "IosDeviceBusyError";
    this.cachedFrame = cachedFrame;
  }
}

export interface SessionLease {
  sessionId: string;
  release(): void;
  markInvalid(): void;
}

export interface TimerHandle {
  cancel(): void;
}

export interface TimerApi {
  set(fn: () => void, ms: number): TimerHandle;
}

export const defaultTimers: TimerApi = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  }
};

interface Waiter {
  mode: "task" | "observe";
  resolve: (lease: SessionLease) => void;
  reject: (error: unknown) => void;
  timer: TimerHandle | null;
}

interface DeviceState {
  sessionId: string | null;
  staleId: string | null;
  holders: number;
  queue: Waiter[];
  idle: TimerHandle | null;
  frame: CachedFrame | null;
  disposed: boolean;
}

export interface AppiumSessionManagerOptions {
  client: AppiumClient;
  capabilitiesFor: (udid: string) => Record<string, unknown>;
  idleMs?: number;
  observeWaitMs?: number;
  timers?: TimerApi;
  recoverAppium?: () => Promise<boolean>;
}

export const SESSION_IDLE_MS_DEFAULT = 30 * 60_000;
export const OBSERVE_WAIT_MS_DEFAULT = 5_000;

/** Per-UDID WDA session broker: FIFO mutex, task/observation leases, idle
 * recycling, self-heal (cleanup -> recreate -> optional managed restart) and a
 * last-frame cache for busy observation requests. */
export class AppiumSessionManager {
  private readonly client: AppiumClient;
  private readonly capabilitiesFor: (udid: string) => Record<string, unknown>;
  private readonly idleMs: number;
  private readonly observeWaitMs: number;
  private readonly timers: TimerApi;
  private readonly recoverAppium: (() => Promise<boolean>) | null;
  private readonly states = new Map<string, DeviceState>();

  constructor(options: AppiumSessionManagerOptions) {
    this.client = options.client;
    this.capabilitiesFor = options.capabilitiesFor;
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS_DEFAULT;
    this.observeWaitMs = options.observeWaitMs ?? OBSERVE_WAIT_MS_DEFAULT;
    this.timers = options.timers ?? defaultTimers;
    this.recoverAppium = options.recoverAppium ?? null;
  }

  private stateFor(udid: string): DeviceState {
    let state = this.states.get(udid);
    if (!state) {
      state = {
        sessionId: null,
        staleId: null,
        holders: 0,
        queue: [],
        idle: null,
        frame: null,
        disposed: false
      };
      this.states.set(udid, state);
    }
    return state;
  }

  async acquire(udid: string, mode: "task" | "observe"): Promise<SessionLease> {
    const state = this.stateFor(udid);
    if (state.disposed) throw new Error("AppiumSessionManager 已释放。");
    if (state.holders === 0 && state.queue.length === 0) {
      if (state.idle) {
        state.idle.cancel();
        state.idle = null;
      }
      return await this.grant(udid, state);
    }
    return await new Promise<SessionLease>((resolve, reject) => {
      const timer =
        mode === "observe"
          ? this.timers.set(() => {
              const index = state.queue.indexOf(waiter);
              if (index >= 0) state.queue.splice(index, 1);
              reject(new IosDeviceBusyError(state.frame));
            }, this.observeWaitMs)
          : null;
      const waiter: Waiter = { mode, resolve, reject, timer };
      state.queue.push(waiter);
    });
  }

  private async openSession(udid: string, state: DeviceState): Promise<string> {
    if (state.sessionId !== null) return state.sessionId;
    const capabilities = this.capabilitiesFor(udid);
    if (state.staleId !== null) {
      const stale = state.staleId;
      state.staleId = null;
      try {
        await this.client.deleteSession(stale);
      } catch {
        /* best effort */
      }
    }
    let created: string;
    try {
      created = (await this.client.createSession(capabilities)).sessionId;
    } catch (error) {
      if (this.recoverAppium === null) throw error;
      const recovered = await this.recoverAppium().catch(() => false);
      if (!recovered) throw error;
      created = (await this.client.createSession(capabilities)).sessionId;
    }
    state.sessionId = created;
    return created;
  }

  private async grant(udid: string, state: DeviceState): Promise<SessionLease> {
    const sessionId = await this.openSession(udid, state);
    state.holders += 1;
    let released = false;
    return {
      sessionId,
      release: () => {
        if (released) return;
        released = true;
        this.release(udid, state);
      },
      markInvalid: () => {
        if (state.sessionId !== null) {
          state.staleId = state.sessionId;
          state.sessionId = null;
        }
      }
    };
  }

  private release(udid: string, state: DeviceState): void {
    state.holders = Math.max(0, state.holders - 1);
    if (state.holders > 0) return;
    this.drainQueue(udid, state);
  }

  private drainQueue(udid: string, state: DeviceState): void {
    if (state.disposed) return;
    if (state.idle) {
      state.idle.cancel();
      state.idle = null;
    }
    const next = state.queue.shift();
    if (next) {
      if (next.timer) next.timer.cancel();
      this.grant(udid, state).then(next.resolve, (error) => {
        next.reject(error);
        this.drainQueue(udid, state);
      });
      return;
    }
    if (state.sessionId === null && state.staleId === null) return;
    if (this.idleMs <= 0) return;
    state.idle = this.timers.set(() => {
      state.idle = null;
      void this.closeIdle(state);
    }, this.idleMs);
  }

  private async closeIdle(state: DeviceState): Promise<void> {
    if (state.holders > 0 || state.queue.length > 0) return;
    const sessionId = state.sessionId;
    state.sessionId = null;
    if (sessionId !== null) {
      try {
        await this.client.deleteSession(sessionId);
      } catch {
        /* best effort */
      }
    }
  }

  cachedFrame(udid: string): CachedFrame | null {
    return this.states.get(udid)?.frame ?? null;
  }

  noteFrame(udid: string, png: Buffer): void {
    const state = this.stateFor(udid);
    const now = Date.now();
    state.frame = { png, capturedAt: new Date(now).toISOString(), capturedAtMs: now };
  }

  async dispose(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    for (const state of states) {
      state.disposed = true;
      if (state.idle) state.idle.cancel();
      for (const waiter of state.queue) {
        if (waiter.timer) waiter.timer.cancel();
        waiter.reject(new Error("AppiumSessionManager 已释放。"));
      }
      state.queue.length = 0;
      for (const sessionId of [state.sessionId, state.staleId]) {
        if (sessionId === null) continue;
        try {
          await this.client.deleteSession(sessionId);
        } catch {
          /* best effort */
        }
      }
      state.sessionId = null;
      state.staleId = null;
    }
  }
}
