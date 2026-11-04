import type { ProjectRecord, ProjectStore } from "../db/types.js";
import { parseWebJobSpec } from "../web/job-spec.js";
import { readWebJobResult } from "../web/results.js";

export interface TokenUsageRecordView {
  at: string;
  project: string;
  hostId: string | null;
  jobId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface TokenUsageBucket {
  key: string;
  promptTokens: number;
  completionTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  jobs: number;
}

export interface TokenUsageView {
  promptTokens: number;
  completionTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  jobs: number;
  byModel: TokenUsageBucket[];
  byDay: TokenUsageBucket[];
  records: TokenUsageRecordView[];
  note: string | null;
}

function emptyBucket(key: string): TokenUsageBucket {
  return {
    key,
    promptTokens: 0,
    completionTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    jobs: 0
  };
}

function addToBucket(
  bucket: TokenUsageBucket,
  entry: Omit<TokenUsageRecordView, "at" | "project" | "hostId" | "jobId" | "model">
): void {
  bucket.promptTokens += entry.promptTokens;
  bucket.completionTokens += entry.completionTokens;
  bucket.cacheCreateTokens += entry.cacheCreateTokens;
  bucket.cacheReadTokens += entry.cacheReadTokens;
  bucket.totalTokens += entry.totalTokens;
}

/**
 * 从项目内 Web LLM 任务结果读取 tokenUsage/tokenTotals。
 * 这是当前唯一落库 token 消耗的来源；没有结果的旧任务不会出现在统计里。
 */
export async function collectTokenUsage(input: {
  store: ProjectStore;
  projects: readonly ProjectRecord[];
  since: string | null;
  limit?: number;
}): Promise<TokenUsageView> {
  const result: TokenUsageView = {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    jobs: 0,
    byModel: [],
    byDay: [],
    records: [],
    note: null
  };
  const models = new Map<string, TokenUsageBucket>();
  const days = new Map<string, TokenUsageBucket>();
  const seenJobs = new Set<string>();
  const maxJobs = input.limit ?? 20;

  for (const project of input.projects) {
    const store =
      project.hostId === null ? input.store : input.store.scopeHost(project.hostId);
    let tasks;
    try {
      tasks = await store.listRegressionTasks(project.rootPath, 500);
    } catch {
      continue;
    }
    for (const task of tasks) {
      if (parseWebJobSpec(task.jobSpec) === null) continue;
      const document = await readWebJobResult(project.rootPath, task.id).catch(() => null);
      if (document === null) continue;
      const at = document.finishedAt || document.startedAt || task.createdAt;
      if (input.since !== null && at < input.since) continue;
      const usages =
        document.tokenUsage !== null && document.tokenUsage.length > 0
          ? document.tokenUsage.map((entry) => ({
              model: entry.model || "—",
              promptTokens: entry.promptTokens ?? 0,
              completionTokens: entry.completionTokens ?? 0,
              cacheCreateTokens: entry.cacheCreateTokens ?? 0,
              cacheReadTokens: entry.cacheReadTokens ?? 0
            }))
          : document.tokenTotals !== null
            ? [
                {
                  model: "—",
                  promptTokens: document.tokenTotals.promptTokens,
                  completionTokens: document.tokenTotals.completionTokens,
                  cacheCreateTokens: document.tokenTotals.cacheCreateTokens,
                  cacheReadTokens: document.tokenTotals.cacheReadTokens
                }
              ]
            : [];
      if (usages.length === 0) continue;
      const jobKey = `${project.rootPath}\u0000${task.id}`;
      if (!seenJobs.has(jobKey)) {
        seenJobs.add(jobKey);
        result.jobs += 1;
      }
      result.note = null;
      for (const usage of usages) {
        const totalTokens =
          usage.promptTokens +
          usage.completionTokens +
          usage.cacheCreateTokens +
          usage.cacheReadTokens;
        result.promptTokens += usage.promptTokens;
        result.completionTokens += usage.completionTokens;
        result.cacheCreateTokens += usage.cacheCreateTokens;
        result.cacheReadTokens += usage.cacheReadTokens;
        result.totalTokens += totalTokens;
        const model = models.get(usage.model) ?? emptyBucket(usage.model);
        addToBucket(model, { ...usage, totalTokens });
        model.jobs = seenJobs.size;
        models.set(usage.model, model);
        const day = at.slice(0, 10);
        const dayBucket = days.get(day) ?? emptyBucket(day);
        addToBucket(dayBucket, { ...usage, totalTokens });
        days.set(day, dayBucket);
        if (result.records.length < maxJobs) {
          result.records.push({
            at,
            project: project.name,
            hostId: project.hostId,
            jobId: task.id,
            model: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cacheCreateTokens: usage.cacheCreateTokens,
            cacheReadTokens: usage.cacheReadTokens,
            totalTokens
          });
        }
      }
    }
  }
  result.byModel = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  result.byDay = [...days.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
  if (result.jobs === 0) {
    result.note = "当前项目（或时间窗）没有上报 tokenUsage 的 Web LLM 任务结果。";
  }
  return result;
}
