import type { ProjectStore, RegressionTaskRecord, TaskProgress } from "../db/types.js";

export interface ProgressRuntime {
  store: Pick<ProjectStore, "updateRegressionTask">;
  project: { rootDir: string };
}

/** runner → 中心的最小进度上报器：只维护最新快照，失败不影响设备执行。 */
export class TaskProgressReporter {
  private seq: number;
  private percent = 0;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly runtime: ProgressRuntime,
    private readonly task: Pick<RegressionTaskRecord, "id" | "progress">
  ) {
    this.seq = task.progress?.seq ?? 0;
    this.percent = task.progress?.percent ?? 0;
  }

  async report(
    phase: TaskProgress["phase"],
    percent: number,
    extra: Partial<Pick<TaskProgress, "caseId" | "traceId" | "message" | "errorCode">> = {}
  ): Promise<void> {
    const bounded = Math.max(this.percent, Math.min(100, Math.round(percent)));
    this.percent = bounded;
    const progress: TaskProgress = {
      seq: this.seq + 1,
      phase,
      percent: bounded,
      caseId: extra.caseId ?? null,
      traceId: extra.traceId ?? null,
      message: extra.message ?? null,
      errorCode: extra.errorCode ?? null,
      at: new Date().toISOString()
    };
    this.seq = progress.seq;
    try {
      await this.runtime.store.updateRegressionTask(this.runtime.project.rootDir, this.task.id, {
        progress,
        lastProgressAt: progress.at
      });
    } catch {
      /* 控制面短暂不可达不阻断设备执行；下一条进度会携带更新后的快照。 */
    }
  }

  startedAtIso(): string {
    return this.startedAt;
  }
}
