import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";
import { pruneJsonSidecars, sidecarRetentionFromEnv } from "./task-sidecar-retention.js";
import {
  buildExecutionPlan,
  type ExecutionEngine,
  type ExecutionPlanView,
  type ExecutionPlatform
} from "./execution-plan.js";

export interface TaskExecutionPlan {
  schemaVersion: 1;
  taskId: string;
  createdAt: string;
  hostId: string | null;
  platforms: ExecutionPlatform[];
  plans: ExecutionPlanView[];
  warnings: string[];
}

export function taskExecutionPlanPath(rootPath: string, taskId: string): string {
  return path.join(rootPath, ".artemis", "design", "task-plans", `${taskId}.json`);
}

export function writeTaskExecutionPlan(rootPath: string, plan: TaskExecutionPlan): void {
  const file = taskExecutionPlanPath(rootPath, plan.taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(plan, null, 2)}\n`);
}

export function readTaskExecutionPlan(
  rootPath: string,
  taskId: string
): TaskExecutionPlan | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(taskExecutionPlanPath(rootPath, taskId), "utf8")
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1 || record.taskId !== taskId) return null;
    if (!Array.isArray(record.platforms) || !Array.isArray(record.plans)) return null;
    return {
      ...(record as unknown as TaskExecutionPlan),
      warnings: Array.isArray(record.warnings) ? (record.warnings as string[]) : []
    };
  } catch {
    return null;
  }
}

/** 派发/执行前的最小 plan 校验：平台集合与 plan 视图必须覆盖任务目标端。 */
export function validateTaskExecutionPlan(
  plan: TaskExecutionPlan,
  task: { platforms: readonly string[]; targetHostId: string | null }
): string[] {
  const reasons: string[] = [];
  for (const platform of task.platforms) {
    if (platform !== "ios" && platform !== "android") continue;
    if (!plan.platforms.includes(platform)) reasons.push(`plan-missing-platform:${platform}`);
    if (!plan.plans.some((entry) => entry.platform === platform)) {
      reasons.push(`plan-view-missing:${platform}`);
    }
  }
  if (plan.hostId !== null && task.targetHostId !== null && plan.hostId !== task.targetHostId) {
    reasons.push("plan-host-mismatch");
  }
  return reasons;
}

/** 创建任务后写旁车：所有创建入口共用，避免重跑/定时/Web job 漏写。 */
export function writeTaskExecutionPlanForTask(
  rootPath: string,
  task: { id: string; platforms: readonly string[]; targetHostId: string | null },
  options: {
    env?: NodeJS.ProcessEnv;
    warnings?: readonly string[];
    createdAt?: string;
  } = {}
): TaskExecutionPlan {
  const plan = buildTaskExecutionPlan({
    taskId: task.id,
    hostId: task.targetHostId,
    platforms: task.platforms,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt })
  });
  writeTaskExecutionPlan(rootPath, plan);
  try {
    const policy = sidecarRetentionFromEnv(options.env ?? process.env);
    pruneJsonSidecars(path.dirname(taskExecutionPlanPath(rootPath, plan.taskId)), policy);
    pruneJsonSidecars(path.join(rootPath, ".artemis", "design", "system-dialogs"), policy);
  } catch {
    /* 保留期清理 best effort，不影响任务创建 */
  }
  return plan;
}

export function buildTaskExecutionPlan(input: {
  taskId: string;
  hostId: string | null;
  platforms: readonly string[];
  aliases?: readonly string[];
  env?: NodeJS.ProcessEnv;
  engine?: ExecutionEngine;
  createdAt?: string;
  warnings?: readonly string[];
}): TaskExecutionPlan {
  const platforms = input.platforms.filter(
    (platform): platform is ExecutionPlatform => platform === "ios" || platform === "android"
  );
  const env = input.env ?? process.env;
  const screenshots = (env.AOS_RUNNER_EVIDENCE_SCREENSHOTS ?? "1").trim() !== "0";
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    hostId: input.hostId,
    platforms,
    plans: platforms.map((platform) =>
      buildExecutionPlan({
        platform,
        engine: input.engine ?? (platform === "ios" ? "ios-llm" : "proxy"),
        aliases: [...(input.aliases ?? [])],
        env,
        screenshots
      })
    ),
    warnings: [...(input.warnings ?? [])]
  };
}
