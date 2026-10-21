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
}

interface InternalJob extends JobRecord {
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

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

  constructor(options: JobManagerOptions = {}) {
    this.maxQueue = options.maxQueue ?? DEFAULTS.maxQueue;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULTS.jobTimeoutMs;
    this.retentionMs = options.retentionMs ?? DEFAULTS.retentionMs;
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => randomUUID());
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
      finishedAtMs: null
    };
    this.jobs.set(job.id, job);
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
    next.step = "extracting";
    return publicView(next);
  }

  setStep(id: string, step: string): void {
    const job = this.jobs.get(id);
    if (job && job.status === "running") job.step = step;
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
    } else if (job.status === "running") {
      job.cancelRequested = true;
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
  }

  /** Enforce running-job timeouts and retention; returns the number of jobs changed. */
  tick(): number {
    const nowMs = this.now();
    let changed = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status === "running" &&
        job.startedAtMs !== null &&
        nowMs - job.startedAtMs > this.jobTimeoutMs
      ) {
        job.status = "failed";
        job.step = "failed";
        job.error = {
          code: "job_timeout",
          message: `生成超时（>${Math.round(this.jobTimeoutMs / 1000)}s）`,
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
        changed += 1;
      }
    }
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
