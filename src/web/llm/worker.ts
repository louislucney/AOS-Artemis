import type { ProjectStore, RegressionTaskRecord } from "../../db/types.js";
import { parseWebJobSpec, type WebJobSpec } from "../job-spec.js";

export type LlmWorkerCaseStatus = "PASS" | "FAIL" | "SKIP" | "ERROR" | "UNVERIFIED";

export interface LlmWorkerCase {
  caseId: string;
  name?: string;
  module?: string | null;
  taskDesc: string;
}

export interface LlmWorkerCaseResult {
  caseId: string;
  name?: string;
  status: LlmWorkerCaseStatus;
  durationMs: number;
  failureReason?: string;
  traceId?: string;
  tokenUsage?: unknown[];
  evidenceSteps?: unknown[];
  verification?: unknown;
  artifacts?: {
    statusJsonPath?: string;
    dataEngineDbPath?: string;
  };
}

export interface LlmWorkerJob {
  task: RegressionTaskRecord;
  rootPath: string;
  spec: WebJobSpec;
  deviceSerial: string;
}

export interface RunLlmWorkerOnceInput {
  store: ProjectStore;
  runnerId: string;
  instanceId: string;
  nowMs?: number;
  maxJobs?: number;
  caseTimeoutMs?: number;
  jobMaxMs?: number;
  signal?: AbortSignal;
  loadCases: (job: LlmWorkerJob) => Promise<LlmWorkerCase[]>;
  executeCase: (input: {
    job: LlmWorkerJob;
    testCase: LlmWorkerCase;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<LlmWorkerCaseResult>;
  /** 中心结果入库；负责写 result.json/Excel/门禁。 */
  ingest?: (input: {
    job: LlmWorkerJob;
    results: LlmWorkerCaseResult[];
  }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunLlmWorkerOnceResult {
  claimed: number;
  jobs: Array<{
    taskId: string;
    rootPath: string;
    results: LlmWorkerCaseResult[];
    status: "completed" | "partial" | "failed";
  }>;
}

export interface RunLlmWorkerLoopInput extends RunLlmWorkerOnceInput {
  pollMs?: number;
  maxRounds?: number;
}

const DEFAULT_CASE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_JOB_MAX_MS = 8 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

function finalStatus(
  results: LlmWorkerCaseResult[]
): "completed" | "partial" | "failed" {
  if (results.some((entry) => entry.status === "FAIL" || entry.status === "ERROR")) {
    return "failed";
  }
  if (
    results.length === 0 ||
    results.some((entry) => entry.status === "SKIP" || entry.status === "UNVERIFIED")
  ) {
    return "partial";
  }
  return "completed";
}

function filterCases(
  cases: LlmWorkerCase[],
  spec: WebJobSpec
): LlmWorkerCase[] {
  const modules = new Set(spec.caseFilter.modules);
  const caseIds = new Set(spec.caseFilter.caseIds);
  return cases.filter(
    (entry) =>
      (modules.size === 0 || (entry.module !== undefined && entry.module !== null && modules.has(entry.module))) &&
      (caseIds.size === 0 || caseIds.has(entry.caseId))
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function executeClaimedJob(
  input: RunLlmWorkerOnceInput,
  job: LlmWorkerJob
): Promise<RunLlmWorkerOnceResult["jobs"][number]> {
  const startedAtMs = Date.now();
  const caseTimeoutMs = input.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const jobMaxMs = input.jobMaxMs ?? DEFAULT_JOB_MAX_MS;
  await input.store.updateRegressionTask(job.rootPath, job.task.id, {
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    lastProgressAt: new Date(startedAtMs).toISOString()
  });
  const cases = filterCases(await input.loadCases(job), job.spec);
  const results: LlmWorkerCaseResult[] = [];
  for (const testCase of cases) {
    if (input.signal?.aborted === true || Date.now() - startedAtMs >= jobMaxMs) {
      results.push({
        caseId: testCase.caseId,
        ...(testCase.name === undefined ? {} : { name: testCase.name }),
        status: "SKIP",
        durationMs: 0,
        failureReason: input.signal?.aborted === true ? "cancelled" : "budget-exceeded"
      });
      continue;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const caseStarted = Date.now();
    try {
      const result = await withTimeout(
        input.executeCase({
          job,
          testCase,
          timeoutMs: caseTimeoutMs,
          signal: controller.signal
        }),
        caseTimeoutMs,
        () => ({
          caseId: testCase.caseId,
          ...(testCase.name === undefined ? {} : { name: testCase.name }),
          status: "ERROR" as const,
          durationMs: Date.now() - caseStarted,
          failureReason: "case-timeout"
        })
      );
      results.push(result);
    } catch (error) {
      results.push({
        caseId: testCase.caseId,
        ...(testCase.name === undefined ? {} : { name: testCase.name }),
        status: "ERROR",
        durationMs: Date.now() - caseStarted,
        failureReason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }
  const status = finalStatus(results);
  if (input.ingest !== undefined) {
    await input.ingest({ job, results });
  }
  await input.store.releaseDeviceLeases({
    hostId: job.task.targetHostId ?? "",
    taskId: job.task.id,
    serials: [job.deviceSerial]
  });
  await input.store.updateRegressionTask(job.rootPath, job.task.id, {
    status,
    deviceLeaseId: null,
    lastProgressAt: new Date().toISOString()
  });
  return { taskId: job.task.id, rootPath: job.rootPath, results, status };
}

function pendingLlmJobs(
  entries: Array<{ task: RegressionTaskRecord; rootPath: string }>
): Array<{ task: RegressionTaskRecord; rootPath: string; spec: WebJobSpec; deviceSerial: string }> {
  const out: Array<{
    task: RegressionTaskRecord;
    rootPath: string;
    spec: WebJobSpec;
    deviceSerial: string;
  }> = [];
  for (const entry of entries) {
    if (entry.task.jobSpec === null) continue;
    let spec: WebJobSpec | null;
    try {
      spec = parseWebJobSpec(entry.task.jobSpec);
    } catch {
      continue;
    }
    if (spec === null || spec.executionMode !== "llm") continue;
    const deviceSerial = entry.task.deviceSerial;
    if (entry.task.targetHostId === null || deviceSerial === null) continue;
    out.push({ ...entry, spec, deviceSerial });
  }
  return out;
}

/** 领取并执行一轮 LLM 任务；P0 单实例、同宿主 gateway。 */
export async function runLlmWorkerOnce(
  input: RunLlmWorkerOnceInput
): Promise<RunLlmWorkerOnceResult> {
  const nowMs = input.nowMs ?? Date.now();
  const pending = pendingLlmJobs(await input.store.listPendingWebJobs());
  const maxJobs = input.maxJobs ?? 1;
  let claimed = 0;
  const jobs: RunLlmWorkerOnceResult["jobs"] = [];
  for (const entry of pending) {
    if (claimed >= maxJobs) break;
    const lease = await input.store.claimWebJob({
      runnerId: input.runnerId,
      hostId: entry.task.targetHostId!,
      deviceSerial: entry.deviceSerial,
      instanceId: input.instanceId,
      executionMode: "llm",
      nowMs
    });
    if (lease === null) continue;
    claimed += 1;
    const job: LlmWorkerJob = {
      task: lease.task,
      rootPath: lease.rootPath,
      spec: entry.spec,
      deviceSerial: entry.deviceSerial
    };
    try {
      jobs.push(await executeClaimedJob(input, job));
    } catch {
      await input.store.releaseDeviceLeases({
        hostId: job.task.targetHostId ?? "",
        taskId: job.task.id,
        serials: [job.deviceSerial]
      });
      await input.store.updateRegressionTask(job.rootPath, job.task.id, {
        status: "failed",
        lastProgressAt: new Date().toISOString()
      });
      jobs.push({
        taskId: job.task.id,
        rootPath: job.rootPath,
        results: [],
        status: "failed"
      });
    }
  }
  return { claimed, jobs };
}

export async function runLlmWorkerLoop(
  input: RunLlmWorkerLoopInput
): Promise<void> {
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let rounds = 0;
  while (input.signal?.aborted !== true) {
    await runLlmWorkerOnce(input);
    rounds += 1;
    if (input.maxRounds !== undefined && rounds >= input.maxRounds) return;
    await sleep(pollMs);
  }
}
