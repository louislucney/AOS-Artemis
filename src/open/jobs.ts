import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobError {
  code: string;
  message: string;
  hint?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  step: string;
  createdAt: string;
  finishedAt: string | null;
  error: JobError | null;
  artifactPath: string | null;
  cancelRequested: boolean;
}

/** 可持久化的完整任务快照（含内部时间戳；不含任何请求凭证）。 */
export interface JobSnapshot extends JobRecord {
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  lastProgressAtMs: number | null;
}

export class JobQueueFullError extends Error {
  readonly code = "queue_full";
  constructor(limit: number) {
    super(`任务队列已满（上限 ${limit}）`);
    this.name = "JobQueueFullError";
  }
}

export interface JobManagerOptions {
  maxQueue?: number;
  maxConcurrent?: number;
  jobTimeoutMs?: number;
  retentionMs?: number;
  now?: () => number;
  id?: () => string;
  /** 启动时恢复的持久化快照；queued/running 会标记为 job_interrupted。 */
  initial?: JobSnapshot[];
  /** 任意状态变更后的快照回调（持久化用）。 */
  onChange?: (snapshot: JobSnapshot[]) => void;
  /** 保留期到期、记录被移除时回调（清理工作目录用）。 */
  onExpire?: (id: string) => void;
}

type InternalJob = JobSnapshot;

const DEFAULTS = {
  maxQueue: 20,
  maxConcurrent: 3,
  jobTimeoutMs: 10 * 60_000,
  retentionMs: 2 * 60 * 60_000
};

function publicView(job: InternalJob): JobRecord {
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    error: job.error,
    artifactPath: job.artifactPath,
    cancelRequested: job.cancelRequested
  };
}

export class JobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly maxQueue: number;
  private readonly maxConcurrent: number;
  private readonly jobTimeoutMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly onChange: ((snapshot: JobSnapshot[]) => void) | null;
  private readonly onExpire: ((id: string) => void) | null;

  constructor(options: JobManagerOptions = {}) {
    this.maxQueue = options.maxQueue ?? DEFAULTS.maxQueue;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULTS.jobTimeoutMs;
    this.retentionMs = options.retentionMs ?? DEFAULTS.retentionMs;
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => randomUUID());
    this.onChange = options.onChange ?? null;
    this.onExpire = options.onExpire ?? null;
    if (options.initial) this.restore(options.initial);
  }

  private notify(): void {
    if (this.onChange === null) return;
    try {
      this.onChange(this.snapshot());
    } catch {
      /* 持久化失败不阻断任务执行 */
    }
  }

  private restore(initial: JobSnapshot[]): void {
    const nowMs = this.now();
    for (const raw of initial) {
      if (!raw || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw.id)) continue;
      if (!["queued", "running", "done", "failed", "cancelled"].includes(raw.status)) continue;
      const interrupted = raw.status === "queued" || raw.status === "running";
      const createdAtMs = Number.isFinite(raw.createdAtMs)
        ? raw.createdAtMs
        : (Date.parse(raw.createdAt) || nowMs);
      const finishedAtMs = interrupted
        ? nowMs
        : Number.isFinite(raw.finishedAtMs)
          ? raw.finishedAtMs
          : raw.finishedAt
            ? Date.parse(raw.finishedAt) || null
            : null;
      this.jobs.set(raw.id, {
        ...raw,
        status: interrupted ? "failed" : raw.status,
        step: interrupted ? "failed" : raw.step,
        finishedAt: interrupted ? new Date(nowMs).toISOString() : raw.finishedAt,
        error: interrupted
          ? { code: "job_interrupted", message: "服务重启，任务已中断", hint: "请重新提交生成任务" }
          : raw.error,
        artifactPath: raw.artifactPath ?? null,
        cancelRequested: false,
        createdAtMs,
        startedAtMs: raw.startedAtMs ?? null,
        finishedAtMs,
        lastProgressAtMs: raw.lastProgressAtMs ?? null
      });
    }
  }

  snapshot(): JobSnapshot[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  create(): JobRecord {
    const active = [...this.jobs.values()].filter(
      (job) => job.status === "queued" || job.status === "running"
    ).length;
    if (active >= this.maxQueue) throw new JobQueueFullError(this.maxQueue);
    const nowMs = this.now();
    const job: InternalJob = {
      id: this.nextId(),
      status: "queued",
      step: "queued",
      createdAt: new Date(nowMs).toISOString(),
      finishedAt: null,
      error: null,
      artifactPath: null,
      cancelRequested: false,
      createdAtMs: nowMs,
      startedAtMs: null,
      finishedAtMs: null,
      lastProgressAtMs: null
    };
    this.jobs.set(job.id, job);
    this.notify();
    return publicView(job);
  }

  get(id: string): JobRecord | null {
    const job = this.jobs.get(id);
    return job ? publicView(job) : null;
  }

  claimNext(): JobRecord | null {
    const running = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (running >= this.maxConcurrent) return null;
    const next = [...this.jobs.values()].find((job) => job.status === "queued");
    if (!next) return null;
    next.status = "running";
    next.startedAtMs = this.now();
    next.lastProgressAtMs = next.startedAtMs;
    next.step = "extracting";
    this.notify();
    return publicView(next);
  }

  setStep(id: string, step: string): void {
    const job = this.jobs.get(id);
    if (job && job.status === "running") {
      job.step = step;
      job.lastProgressAtMs = this.now();
      this.notify();
    }
  }

  complete(id: string, artifactPath: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    const nowMs = this.now();
    job.status = "done";
    job.step = "done";
    job.artifactPath = artifactPath;
    job.finishedAt = new Date(nowMs).toISOString();
    job.finishedAtMs = nowMs;
    this.notify();
  }

  fail(id: string, error: JobError): void {
    const job = this.jobs.get(id);
    if (!job || job.status === "done" || job.status === "cancelled") return;
    const nowMs = this.now();
    job.status = "failed";
    job.step = "failed";
    job.error = error;
    job.finishedAt = new Date(nowMs).toISOString();
    job.finishedAtMs = nowMs;
    this.notify();
  }

  cancel(id: string): JobRecord | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "queued") {
      const nowMs = this.now();
      job.status = "cancelled";
      job.step = "cancelled";
      job.finishedAt = new Date(nowMs).toISOString();
      job.finishedAtMs = nowMs;
      this.notify();
    } else if (job.status === "running") {
      job.cancelRequested = true;
      this.notify();
    }
    return publicView(job);
  }

  cancelRequested(id: string): boolean {
    return this.jobs.get(id)?.cancelRequested === true;
  }

  markCancelled(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    const nowMs = this.now();
    job.status = "cancelled";
    job.step = "cancelled";
    job.finishedAt = new Date(nowMs).toISOString();
    job.finishedAtMs = nowMs;
    this.notify();
  }

  /** Enforce running-job timeouts and retention; returns the number of jobs changed. */
  tick(): number {
    const nowMs = this.now();
    let changed = 0;
    for (const job of this.jobs.values()) {
      const progressAt = job.lastProgressAtMs ?? job.startedAtMs;
      if (job.status === "running" && progressAt !== null && nowMs - progressAt > this.jobTimeoutMs) {
        job.status = "failed";
        job.step = "failed";
        job.error = {
          code: "job_timeout",
          message: `生成超时（>${Math.round(this.jobTimeoutMs / 1000)}s 无进度）`,
          hint: "请缩小 maxFlows 或稍后重试"
        };
        job.finishedAt = new Date(nowMs).toISOString();
        job.finishedAtMs = nowMs;
        changed += 1;
      }
    }
    for (const [id, job] of this.jobs) {
      if (job.finishedAtMs !== null && nowMs - job.finishedAtMs > this.retentionMs) {
        this.jobs.delete(id);
        try {
          this.onExpire?.(id);
        } catch {
          /* 清理失败不阻断 tick */
        }
        changed += 1;
      }
    }
    if (changed > 0) this.notify();
    return changed;
  }

  size(): { total: number; queued: number; running: number } {
    const all = [...this.jobs.values()];
    return {
      total: all.length,
      queued: all.filter((job) => job.status === "queued").length,
      running: all.filter((job) => job.status === "running").length
    };
  }
}
