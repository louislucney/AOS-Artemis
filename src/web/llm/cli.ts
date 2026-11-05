import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { createProjectStore } from "../../db/index.js";
import { defaultBuildRuntime, type CliRuntimeBundle } from "../../cli-runtime.js";
import { resolveHostIdentity } from "../../host/identity.js";
import { errorMessage } from "../../util.js";
import { recordLlmWorkerHeartbeat } from "./heartbeat.js";
import { executeAndroidLlmCase } from "./artemis-case.js";
import { executeIosLlmCase, iosAppUrl } from "./ios-case.js";
import { ingestLlmResults } from "./ingest.js";
import { loadLlmCases } from "./cases.js";
import { loadWebSecrets, writeWebSecretFile } from "./secrets.js";
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
  // LLM worker 强制要求 ARTEMIS hooks；hook 文件缺失时所有 LLM 用例 fail-closed。
  process.env.AOS_LLM_HOOKS_REQUIRED = "1";
  if (process.env.AOS_LLM_HOOKS !== "0") {
    process.env.AOS_LLM_HOOKS = "1";
    process.env.AOS_LLM_HOOKS_STRICT = process.env.AOS_LLM_HOOKS_STRICT ?? "1";
  }
  const { store } = await createProjectStore();
  const instanceId = `center-llm-${process.pid}-${Date.now()}`;
  const identity = await resolveHostIdentity({ env: process.env }).catch(() => null);
  const workerHostId = identity?.id ?? store.localHostId ?? "center-llm";
  const heartbeat = async (): Promise<void> => {
    await recordLlmWorkerHeartbeat({
      store,
      hostId: workerHostId,
      instanceId
    }).catch((error) => {
      errorLog(`[web-llm-worker] 心跳写入失败：${errorMessage(error)}`);
    });
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, 30_000);
  heartbeatTimer.unref();
  const runtimes = new Map<string, CliRuntimeBundle>();
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const runtimeFor = async (
    rootPath: string,
    iosAppiumUrl: string | null = null
  ): Promise<CliRuntimeBundle> => {
    const key = `${rootPath}\u0000${iosAppiumUrl ?? ""}`;
    const existing = runtimes.get(key);
    if (existing !== undefined) return existing;
    const bundle = await defaultBuildRuntime(rootPath, {
      iosAppiumUrl,
      iosWebLlmRedaction: true
    });
    runtimes.set(key, bundle);
    return bundle;
  };
  interface PreparedLlmJob {
    runtime: CliRuntimeBundle;
    secrets: Awaited<ReturnType<typeof loadWebSecrets>>;
    appPackage: string | null;
    appPath: string | null;
    iosAppiumUrl: string | null;
    referencePath: string | null;
    referenceAssetId: string | null;
  }
  const input: RunLlmWorkerOnceInput = {
    store,
    runnerId: `center-llm-${process.pid}`,
    instanceId,
    signal: controller.signal,
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    ...(options.caseTimeoutMs === undefined ? {} : { caseTimeoutMs: options.caseTimeoutMs }),
    ...(options.jobMaxMs === undefined ? {} : { jobMaxMs: options.jobMaxMs }),
    prepareJob: async (job): Promise<PreparedLlmJob> => {
      const targetHostId = job.task.targetHostId;
      const runner =
        job.spec.requirements.platform === "ios" && targetHostId !== null
          ? await store.getWebRunner(targetHostId).catch(() => null)
          : null;
      const iosAppiumUrl = runner?.gateway?.appiumUrl ?? null;
      const runtime = await runtimeFor(job.rootPath, iosAppiumUrl);
      const [secrets, web, pkg, reference] = await Promise.all([
        loadWebSecrets({ store, rootPath: job.rootPath }),
        store.getWebProject(job.rootPath),
        store.getWebAsset(job.rootPath, job.spec.packageAssetId),
        job.spec.referenceAssetId === null
          ? Promise.resolve(null)
          : store.getWebAsset(job.rootPath, job.spec.referenceAssetId).catch(() => null)
      ]);
      const hookFile = path.join(
        runtime.runtime.project.config.artemis.repo,
        "artemis",
        "security",
        "install.py"
      );
      const hooksPresent = await access(hookFile).then(
        () => true,
        () => false
      );
      let hooksCompatible = false;
      if (hooksPresent) {
        const content = await readFile(hookFile, "utf8").catch(() => "");
        hooksCompatible = content.includes("AOS_HOOK_API_VERSION = 1");
      }
      if (hooksCompatible) process.env.AOS_LLM_HOOKS_ACTIVE = "1";
      else delete process.env.AOS_LLM_HOOKS_ACTIVE;
      await writeWebSecretFile({ rootPath: job.rootPath, secrets });
      const packageFile =
        pkg?.kind === "package" &&
        (pkg.filename.toLowerCase().endsWith(".apk") ||
          pkg.filename.toLowerCase().endsWith(".ipa"))
          ? pkg
          : null;
      const platform = job.spec.requirements.platform;
      const appPath =
        packageFile === null
          ? null
          : platform === "ios"
            ? iosAppUrl(
                typeof packageFile.metadata?.url === "string"
                  ? packageFile.metadata.url
                  : null
              )
            : packageFile.storagePath;
      return {
        runtime,
        secrets,
        appPackage: web?.appPackage ?? null,
        appPath,
        iosAppiumUrl,
        referencePath: reference?.storagePath ?? null,
        referenceAssetId: reference?.id ?? null
      };
    },
    loadCases: async (job) =>
      loadLlmCases({ store, rootPath: job.rootPath, job }),
    executeCase: async ({ job, testCase, prepared, signal }) => {
      const context = prepared as PreparedLlmJob;
      if (job.spec.requirements.platform === "ios") {
        if (context.appPackage === null && context.appPath === null) {
          return {
            caseId: testCase.caseId,
            ...(testCase.name === undefined ? {} : { name: testCase.name }),
            status: "ERROR",
            durationMs: 0,
            failureReason: "ios-app-package-required"
          };
        }
        if (job.spec.requirements.deviceKind === "simulator") {
          return {
            caseId: testCase.caseId,
            ...(testCase.name === undefined ? {} : { name: testCase.name }),
            status: "ERROR",
            durationMs: 0,
            failureReason: "ios-remote-simulator-unsupported"
          };
        }
        if (context.iosAppiumUrl === null) {
          return {
            caseId: testCase.caseId,
            ...(testCase.name === undefined ? {} : { name: testCase.name }),
            status: "ERROR",
            durationMs: 0,
            failureReason: "ios-appium-unavailable"
          };
        }
        return executeIosLlmCase({
          proxy: context.runtime.runtime.proxy,
          traceDir: (traceId) => context.runtime.runtime.traceDir(traceId),
          testCase,
          deviceSerial: job.deviceSerial,
          appPackage: context.appPackage,
          appPath: context.appPath,
          secrets: context.secrets,
          redactionActive: true,
          referencePath: context.referencePath,
          referenceAssetId: context.referenceAssetId,
          signal
        });
      }
      return executeAndroidLlmCase({
        proxy: context.runtime.runtime.proxy,
        traceDir: (traceId) => context.runtime.runtime.traceDir(traceId),
        testCase,
        deviceSerial: job.deviceSerial,
        appPackage: context.appPackage,
        appPath: context.appPath,
        secrets: context.secrets,
        referencePath: context.referencePath,
        referenceAssetId: context.referenceAssetId,
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
    clearInterval(heartbeatTimer);
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
