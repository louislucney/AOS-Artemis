import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ArtemisProxyLike } from "../artemis/proxy.js";
import { resultPayload, taskStatusFromFile, taskStatusOf, type TaskStatus } from "../artemis/task-result.js";
import { TERMINAL_TASK_STATUSES } from "../db/types.js";
import type { ProjectStore, TaskStatRecord } from "../db/types.js";
import { findGeneratedCaseId } from "../figma/case-index.js";
import { reconcileIosTrace } from "../ios/trace-store.js";

/** 任务台账模块（DESIGN §13.86）：提交/结果记账（含 local- 占位与 caseId 回填）、
 * 状态读取（status.json 优先、iOS orphan 对账、代理回退）与待终态同步。
 * 终态回调（崩溃取证）由调用方注入，保持本模块无副作用面。 */
export interface TaskLedgerDeps {
  projectRoot: string;
  configDirAbs: string;
  tracesDir: string;
  store: ProjectStore;
  proxy: ArtemisProxyLike;
  safeStore: <T>(fn: () => Promise<T>, fallback: T) => Promise<T>;
  onTerminalTask: (task: TaskStatRecord, status: string) => void;
}

export class TaskLedger {
  private readonly lockedPackages = new Map<string, string>();

  constructor(private readonly deps: TaskLedgerDeps) {}

  /** 提交时记录的 locked_app_package（崩溃取证进程名推断用）。 */
  lockedPackageFor(traceId: string): string | null {
    return this.lockedPackages.get(traceId) ?? null;
  }

  async recordSubmission(input: {
    traceId?: string | null;
    model?: string | null;
    profile?: string | null;
    status?: string;
    taskDesc?: string | null;
    caseId?: string | null;
    lockedAppPackage?: string | null;
  }): Promise<void> {
    const providedTrace = input.traceId?.trim() ?? "";
    const traceId = providedTrace !== "" ? providedTrace : `local-${randomUUID()}`;
    const status = providedTrace === "" ? "failed" : input.status ?? "submitted";
    if (input.lockedAppPackage && status === "submitted") {
      this.lockedPackages.set(traceId, input.lockedAppPackage);
      if (this.lockedPackages.size > 200) {
        const oldest = this.lockedPackages.keys().next().value;
        if (oldest !== undefined) this.lockedPackages.delete(oldest);
      }
    }
    await this.deps.safeStore<void>(async () => {
      await this.deps.store.recordTask({
        rootPath: this.deps.projectRoot,
        traceId,
        model: input.model ?? null,
        profile: input.profile ?? null,
        status,
        taskDesc: input.taskDesc ?? null,
        caseId: input.caseId ?? null,
        finishedAt: status === "submitted" ? null : new Date().toISOString()
      });
    }, undefined);
  }

  async recordResult(input: {
    isError: boolean;
    traceId?: string | null;
    model?: string | null;
    taskDesc?: string | null;
    lockedAppPackage?: string | null;
  }): Promise<void> {
    const traceId = input.isError ? null : input.traceId?.trim() || null;
    await this.recordSubmission({
      traceId,
      model: input.model ?? null,
      profile: null,
      status: input.isError || !traceId ? "failed" : "submitted",
      taskDesc: input.taskDesc ?? null,
      caseId: findGeneratedCaseId(this.deps.configDirAbs, input.taskDesc),
      lockedAppPackage: input.lockedAppPackage ?? null
    });
  }

  /** 状态读取：status.json 优先（跨会话可用，无需子进程）；running/缺失时经
   * iOS orphan 对账；仍无终态则回退 live 代理。 */
  async traceStatus(traceId: string): Promise<TaskStatus | null> {
    const statusPath = path.join(this.deps.tracesDir, traceId, "status.json");
    let fromFile = taskStatusFromFile(statusPath);
    if (fromFile?.status === "running" || fromFile === null) {
      const reconciled = reconcileIosTrace(path.join(this.deps.tracesDir, traceId), traceId);
      if (reconciled?.status === "orphaned") fromFile = taskStatusFromFile(statusPath) ?? fromFile;
    }
    if (fromFile?.status) return fromFile;
    if (!this.deps.proxy.isRunning()) return fromFile;
    try {
      const result = await this.deps.proxy.callTool("mobile_manage_task", {
        action: "status",
        trace_id: traceId
      });
      return taskStatusOf(resultPayload(result)) ?? fromFile;
    } catch {
      return fromFile;
    }
  }

  async syncTaskStatuses(): Promise<{ checked: number; updated: number }> {
    const pending = await this.deps.safeStore(
      () => this.deps.store.listPendingTasks(this.deps.projectRoot, 20),
      [] as TaskStatRecord[]
    );
    let updated = 0;
    for (const task of pending) {
      let status = this.readTraceStatus(task.traceId);
      if (status === null) status = await this.queryTaskStatusViaProxy(task.traceId);
      if (status && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
        const done = await this.deps.safeStore(
          () => this.deps.store.markTaskFinished(this.deps.projectRoot, task.traceId, status!),
          false
        );
        if (done) {
          updated += 1;
          this.deps.onTerminalTask(task, status);
        }
      }
    }
    return { checked: pending.length, updated };
  }

  private readTraceStatus(traceId: string): string | null {
    const statusPath = path.join(this.deps.tracesDir, traceId, "status.json");
    return taskStatusFromFile(statusPath)?.status ?? null;
  }

  private async queryTaskStatusViaProxy(traceId: string): Promise<string | null> {
    if (!this.deps.proxy.isRunning()) return null;
    try {
      const result = await this.deps.proxy.callTool("mobile_manage_task", {
        action: "status",
        trace_id: traceId
      });
      return taskStatusOf(resultPayload(result))?.status ?? null;
    } catch {
      /* fall through */
    }
    return null;
  }
}
