import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";

export type DataResource = "email" | "phone" | "otp" | "card" | "account";
export type DataRiskLevel = "low" | "medium" | "high";

export interface DataLeaseRecord {
  id: string;
  resource: DataResource;
  value: string;
  /** 中心租约归属任务（本地租约可缺省）。 */
  taskId?: string;
  provider: string;
  riskLevel: DataRiskLevel;
  cooldownMs: number;
  leasedAt: string;
  releasedAt: string | null;
  cooldownUntil: string | null;
}

export type DataLeaseErrorCode = "busy" | "cooldown" | "not-found" | "already-released";

export class DataLeaseError extends Error {
  constructor(
    readonly code: DataLeaseErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DataLeaseError";
  }
}

interface RegistryState {
  v: 1;
  leases: DataLeaseRecord[];
}

export interface DataLeaseRegistryOptions {
  /** 本地状态文件；缺省仅内存。 */
  file?: string | null;
  now?: () => number;
  /** 跨实例文件锁等待上限（默认 5000ms；0=只尝试一次）。 */
  lockTimeoutMs?: number;
  /** 活跃租约 TTL（默认 6h；0=不自动回收）。 */
  leaseTtlMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readState(file: string | null): RegistryState {
  if (file === null) return { v: 1, leases: [] };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { v?: unknown; leases?: unknown };
      if (record.v === 1 && Array.isArray(record.leases)) {
        return { v: 1, leases: record.leases as DataLeaseRecord[] };
      }
    }
  } catch {
    /* first run / malformed */
  }
  return { v: 1, leases: [] };
}

/** 本地 Data Broker 核心：资源租约、释放冷却、号段风险。
 * 不访问外部供应商；跨 runner 的原子分配仍由中心 API 承担（待接入）。 */
export class DataLeaseRegistry {
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private state: RegistryState;

  constructor(options: DataLeaseRegistryOptions = {}) {
    this.file = options.file ?? null;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = Math.max(0, Math.trunc(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
    this.leaseTtlMs = Math.max(0, Math.trunc(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
    this.state = readState(this.file);
  }

  private withLock<T>(fn: () => T): T {
    if (this.file === null) return fn();
    const lock = `${this.file}.lock`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lock, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const staleMs = Math.max(this.lockTimeoutMs, 1_000);
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.rmSync(lock, { force: true });
            continue;
          }
        } catch {
          /* 锁刚被释放 */
        }
        if (Date.now() >= deadline) {
          throw new DataLeaseError("busy", "数据租约文件锁等待超时");
        }
        sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
      try {
        fs.rmSync(lock, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private reload(): void {
    if (this.file !== null) this.state = readState(this.file);
  }

  private persist(): void {
    if (this.file === null) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private activeFor(value: string): DataLeaseRecord | undefined {
    return this.state.leases.find((lease) => lease.value === value && lease.releasedAt === null);
  }

  private lastReleasedFor(value: string): DataLeaseRecord | undefined {
    return [...this.state.leases]
      .filter((lease) => lease.value === value && lease.releasedAt !== null)
      .sort((a, b) => (a.releasedAt! < b.releasedAt! ? 1 : -1))[0];
  }

  allocate(input: {
    resource: DataResource;
    value: string;
    taskId?: string;
    provider?: string;
    riskLevel?: DataRiskLevel;
    cooldownMs?: number;
  }): DataLeaseRecord {
    return this.withLock(() => {
      this.reload();
      const value = input.value.trim();
      if (value === "") throw new DataLeaseError("not-found", "数据值为空");
      const nowMs = this.now();
      if (this.leaseTtlMs > 0) {
        for (const lease of this.state.leases) {
          if (lease.releasedAt !== null) continue;
          const leasedAt = Date.parse(lease.leasedAt);
          if (Number.isFinite(leasedAt) && nowMs - leasedAt > this.leaseTtlMs) {
            lease.releasedAt = new Date(nowMs).toISOString();
            lease.cooldownUntil =
              lease.cooldownMs > 0
                ? new Date(nowMs + lease.cooldownMs).toISOString()
                : null;
          }
        }
      }
      const active = this.activeFor(value);
      if (active !== undefined) {
        throw new DataLeaseError("busy", `资源正在租用中：${active.id}`);
      }
      const previous = this.lastReleasedFor(value);
      if (previous?.cooldownUntil !== null && previous?.cooldownUntil !== undefined) {
        const until = Date.parse(previous.cooldownUntil);
        if (Number.isFinite(until) && until > nowMs) {
          throw new DataLeaseError(
            "cooldown",
            `资源冷却中，${new Date(until).toISOString()} 后才可再次分配`
          );
        }
      }
      const lease: DataLeaseRecord = {
        id: randomUUID(),
        resource: input.resource,
        value,
        ...(input.taskId === undefined || input.taskId.trim() === ""
          ? {}
          : { taskId: input.taskId.trim() }),
        provider: input.provider?.trim() || "local",
        riskLevel: input.riskLevel ?? "low",
        cooldownMs: Math.max(0, Math.trunc(input.cooldownMs ?? 0)),
        leasedAt: new Date(nowMs).toISOString(),
        releasedAt: null,
        cooldownUntil: null
      };
      this.state.leases.push(lease);
      this.persist();
      return { ...lease };
    });
  }

  release(id: string): DataLeaseRecord {
    return this.withLock(() => {
      this.reload();
      const lease = this.state.leases.find((entry) => entry.id === id);
      if (lease === undefined) throw new DataLeaseError("not-found", `未知租约：${id}`);
      if (lease.releasedAt !== null) {
        throw new DataLeaseError("already-released", `租约已释放：${id}`);
      }
      const nowMs = this.now();
      lease.releasedAt = new Date(nowMs).toISOString();
      lease.cooldownUntil =
        lease.cooldownMs > 0 ? new Date(nowMs + lease.cooldownMs).toISOString() : null;
      this.persist();
      return { ...lease };
    });
  }

  get(id: string): DataLeaseRecord | null {
    this.reload();
    const lease = this.state.leases.find((entry) => entry.id === id);
    return lease === undefined ? null : { ...lease };
  }

  list(): DataLeaseRecord[] {
    this.reload();
    return this.state.leases.map((lease) => ({ ...lease }));
  }
}
