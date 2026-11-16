import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";
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
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    hostId: input.hostId,
    platforms,
    plans: platforms.map((platform) =>
      buildExecutionPlan({
        platform,
        engine: input.engine ?? "proxy",
        aliases: [...(input.aliases ?? [])],
        env: input.env
      })
    ),
    warnings: [...(input.warnings ?? [])]
  };
}
