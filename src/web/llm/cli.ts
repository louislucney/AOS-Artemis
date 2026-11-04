import { createProjectStore } from "../../db/index.js";
import { defaultBuildRuntime, type CliRuntimeBundle } from "../../cli-runtime.js";
import { errorMessage } from "../../util.js";
import { executeAndroidLlmCase } from "./artemis-case.js";
import { ingestLlmResults } from "./ingest.js";
import { loadLlmCases } from "./cases.js";
import { loadWebSecrets } from "./secrets.js";
import {
  runLlmWorkerLoop,
  runLlmWorkerOnce,
  type RunLlmWorkerOnceInput
} from "./worker.js";

export interface LlmWorkerCliOptions {
  once?: boolean;
  pollMs?: number;
  maxJobs?: number;
  caseTimeoutMs?: number;
  jobMaxMs?: number;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

export async function runLlmWorkerCli(
  options: LlmWorkerCliOptions = {}
): Promise<number> {
  const log = options.log ?? ((line) => console.log(line));
  const errorLog = options.errorLog ?? ((line) => console.error(line));
  const { store } = await createProjectStore();
  const runtimes = new Map<string, CliRuntimeBundle>();
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const runtimeFor = async (rootPath: string): Promise<CliRuntimeBundle> => {
    const existing = runtimes.get(rootPath);
    if (existing !== undefined) return existing;
    const bundle = await defaultBuildRuntime(rootPath);
    runtimes.set(rootPath, bundle);
    return bundle;
  };
  const input: RunLlmWorkerOnceInput = {
    store,
    runnerId: `center-llm-${process.pid}`,
    instanceId: `center-llm-${process.pid}-${Date.now()}`,
    signal: controller.signal,
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    ...(options.caseTimeoutMs === undefined ? {} : { caseTimeoutMs: options.caseTimeoutMs }),
    ...(options.jobMaxMs === undefined ? {} : { jobMaxMs: options.jobMaxMs }),
    loadCases: async (job) =>
      loadLlmCases({ store, rootPath: job.rootPath, job }),
    executeCase: async ({ job, testCase, signal }) => {
      const runtime = await runtimeFor(job.rootPath);
      const secrets = await loadWebSecrets({ store, rootPath: job.rootPath });
      const web = await store.getWebProject(job.rootPath);
      return executeAndroidLlmCase({
        proxy: runtime.runtime.proxy,
        traceDir: (traceId) => runtime.runtime.traceDir(traceId),
        testCase,
        deviceSerial: job.deviceSerial,
        appPackage: web?.appPackage ?? null,
        secrets,
        signal
      });
    },
    ingest: async ({ job, results }) => {
      await ingestLlmResults({ store, job, results });
    }
  };
  try {
    if (options.once === true) {
      const result = await runLlmWorkerOnce(input);
      log(`[web-llm-worker] 领取 ${result.claimed} 个任务`);
      for (const job of result.jobs) {
        log(
          `[web-llm-worker] ${job.taskId} ${job.status}（${job.results.length} 例，${job.rootPath}）`
        );
      }
      return result.jobs.some((job) => job.status === "failed") ? 1 : 0;
    }
    await runLlmWorkerLoop({
      ...input,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs })
    });
    return 0;
  } catch (error) {
    errorLog(`[web-llm-worker] 失败：${errorMessage(error)}`);
    return 2;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const bundle of runtimes.values()) {
      try {
        bundle.runtime.proxy.disposeSync();
      } catch {
        /* ignore */
      }
      await bundle.dispose().catch(() => undefined);
    }
    await store.close().catch(() => undefined);
  }
}
