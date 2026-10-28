import path from "node:path";

import { defaultExec, type ExecFn } from "../device/adb.js";
import { errorMessage } from "../util.js";
import { parseWebJobSpec } from "../web/job-spec.js";
import { executeWebJob, type WebJobExecutionResult } from "./web-executors.js";
import {
  cleanupWebJobWorkspace,
  installWebPackage,
  prepareWebJobWorkspace,
  removeWebJobSecrets,
  type WebJobWorkspaceAsset
} from "./web-job-workspace.js";
import type { WebJobExecutor } from "./web-agent.js";

export interface DefaultWebJobExecutorOptions {
  /** 执行机主机身份（缺省取任务的 claimedHostId / targetHostId）。 */
  hostId?: string;
  /** 中心基址（如 `http://center:8765`，不含尾斜杠也可）。 */
  panelBaseUrl: string;
  /** 中心 runner 专用令牌（AOS_RUNNER_JOB_TOKEN）。 */
  runnerToken: string;
  /** job 工作目录根（AOS_RUNNER_WORK_DIR）。 */
  workRoot: string;
  /** 资产 CAS 根（缺省 `<workRoot>/cache`）。 */
  cacheRoot?: string;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Maestro 执行超时（透传 `executeWebJob`）。 */
  timeoutMs?: number;
}

/** 执行器 → 结果契约状态：`error` 必须原样上传，绝不降级成 failed。 */
export const RESULT_STATUS_FROM_EXECUTOR = {
  passed: "passed",
  partial: "partial",
  failed: "failed",
  error: "error"
} as const;

/** 执行器 → runner 任务终态（上传失败时 Task 5 兜底写库用）。 */
export const RUNNER_STATUS_FROM_EXECUTOR = {
  passed: "completed",
  partial: "partial",
  failed: "failed",
  error: "failed"
} as const;

interface RunnerSpecAsset {
  kind: WebJobWorkspaceAsset["kind"];
  sha256: string;
  filename: string;
  downloadUrl: string;
  secret: boolean;
}

const CHILD_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ADB_SERVER_SOCKET",
  "AOS_MAESTRO_PATH",
  "AOS_ADB_PATH",
  "AOS_IDEVICESYSLOG_PATH",
  "AOS_RUNNER_WORK_DIR",
  "AOS_RUNNER_CACHE_DIR"
]);
const CHILD_ENV_DENY = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|DATABASE_URL|_KEY$)/i;

/** 子进程环境最小集：白名单 + 工具前缀；剔除 runner 令牌、DB URL 与任意 TOKEN/KEY 类变量。 */
export function webRunnerChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CHILD_ENV_DENY.test(key)) continue;
    const allowed =
      CHILD_ENV_ALLOW.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("ANDROID_") ||
      key.startsWith("MAESTRO_");
    if (!allowed) continue;
    out[key] = value;
  }
  return out;
}

function positiveInt(raw: string | undefined): number | undefined {
  const parsed = Number((raw ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function trimBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function authHeaders(hostId: string, token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-aos-host-id": hostId
  };
}

function safeSlug(rootPath: string): string {
  const base = path.basename(path.resolve(rootPath)).trim();
  if (base === "" || base === "." || base === "..") return "project";
  return base;
}

function readSpecAssets(raw: unknown): RunnerSpecAsset[] {
  if (!Array.isArray(raw)) throw new Error("web-job-spec-assets-invalid");
  return raw.map((entry, index) => {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const kind = record.kind;
    const sha256 = record.sha256;
    const filename = record.filename;
    const downloadUrl = record.downloadUrl;
    if (kind !== "excel" && kind !== "package" && kind !== "materials" && kind !== "scripts") {
      throw new Error(`web-job-spec-assets-invalid: assets[${index}].kind`);
    }
    if (typeof sha256 !== "string" || typeof filename !== "string" || typeof downloadUrl !== "string") {
      throw new Error(`web-job-spec-assets-invalid: assets[${index}]`);
    }
    return {
      kind,
      sha256,
      filename,
      downloadUrl,
      secret: record.secret === true
    };
  });
}

function executedPayload(
  executed: WebJobExecutionResult,
  jobDir: string,
  device: { serial: string; model: string | null; osVersion: string | null },
  pkg: { name: string | null; version: string | null; filename: string }
): Record<string, unknown> {
  const evidence = new Set<string>();
  for (const entry of executed.cases) {
    for (const file of entry.screenshotPaths ?? []) {
      evidence.add(path.relative(jobDir, file));
    }
    if (entry.logPath !== undefined) evidence.add(path.relative(jobDir, entry.logPath));
  }
  return {
    execution: {
      status: RESULT_STATUS_FROM_EXECUTOR[executed.status],
      cases: executed.cases.map((entry) => ({
        caseId: entry.caseId,
        name: entry.name,
        status: entry.status,
        durationMs: entry.durationMs,
        ...(entry.failureStep === undefined ? {} : { failureStep: entry.failureStep }),
        ...(entry.failureReason === undefined ? {} : { failureReason: entry.failureReason })
      })),
      startedAt: executed.startedAt,
      finishedAt: executed.finishedAt,
      detail: executed.detail
    },
    device,
    package: pkg,
    startedAt: executed.startedAt,
    finishedAt: executed.finishedAt,
    evidence: [...evidence]
  };
}

/**
 * runner 侧默认执行器：拉 spec（runner token + host 绑定）→ CAS 工作目录 →
 * 安装 → Maestro → 上传结果。任一步失败都抛错，由 Task 5 回池重试；
 * 上传失败同样抛错，绝不把任务写成成功。
 */
export function createDefaultWebJobExecutor(
  options: DefaultWebJobExecutorOptions
): WebJobExecutor {
  const base = trimBase(options.panelBaseUrl);
  const token = options.runnerToken.trim();
  const env = options.env ?? process.env;
  const workRoot = path.resolve(options.workRoot);
  const cacheRoot = path.resolve(options.cacheRoot ?? path.join(workRoot, "cache"));
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const exec: ExecFn = options.exec ?? defaultExec;
  const childEnv = webRunnerChildEnv(env);
  const envTimeoutMs = positiveInt(env.AOS_WEB_JOB_TIMEOUT_MS);
  const executeTimeoutMs = options.timeoutMs ?? envTimeoutMs;

  return async (input) => {
    const jobId = input.task.id;
    const hostId = (options.hostId ?? input.task.claimedHostId ?? input.task.targetHostId ?? "").trim();
    if (hostId === "") throw new Error("web-job-host-missing");
    const headers = authHeaders(hostId, token);

    let specResponse: Awaited<ReturnType<typeof fetch>>;
    try {
      specResponse = await fetchImpl(
        `${base}/panel/api/jobs/${encodeURIComponent(jobId)}/spec`,
        { method: "GET", headers }
      );
    } catch (error) {
      throw new Error(`web-job-spec-request-failed: ${errorMessage(error)}`);
    }
    if (!specResponse.ok) {
      throw new Error(
        `web-job-spec-failed: ${specResponse.status} ${await specResponse.text().catch(() => "")}`.trim()
      );
    }
    const body = (await specResponse.json()) as Record<string, unknown>;
    const jobSpec = parseWebJobSpec(
      typeof body.spec === "object" && body.spec !== null
        ? (body.spec as Record<string, unknown>)
        : null
    );
    if (jobSpec === null) throw new Error("web-job-spec-invalid");
    const assets = readSpecAssets(body.assets);

    const download = async (url: string): Promise<Buffer> => {
      const target = new URL(url, `${base}/`).toString();
      const response = await fetchImpl(target, { method: "GET", headers });
      if (!response.ok) {
        throw new Error(`web-job-asset-download-failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    };

    const prepared = await prepareWebJobWorkspace({
      jobId,
      projectSlug: safeSlug(input.rootPath),
      workRoot,
      cacheRoot,
      assets: assets.map((asset) => ({
        kind: asset.kind,
        sha256: asset.sha256,
        filename: asset.filename,
        url: asset.downloadUrl,
        secret: asset.secret
      })),
      download,
      exec,
      env: childEnv
    });

    try {
      if (input.shouldAbort?.() === true) throw new Error("web-job-aborted");
      const deviceSerial = (input.task.deviceSerial ?? input.device.serial).trim();
      const platform = jobSpec.requirements.platform;
      const packagePath = prepared.files.get("package");
      if (packagePath === undefined) throw new Error("web-job-package-missing");
      const flowsDir = prepared.flowsDir;
      if (flowsDir === null) throw new Error("web-job-scripts-missing");

      const install = await installWebPackage({
        platform,
        deviceSerial,
        packagePath,
        jobDir: prepared.jobDir,
        deviceKind: input.device.kind === "simulator" ? "simulator" : "device",
        exec,
        env: childEnv
      });
      if (!install.ok) throw new Error(`web-job-install-failed:${install.reason}`);
      if (input.shouldAbort?.() === true) throw new Error("web-job-aborted");

      const executed = await executeWebJob({
        jobSpec,
        jobDir: prepared.jobDir,
        flowsDir,
        device: {
          serial: deviceSerial,
          platform,
          kind: input.device.kind
        },
        exec,
        env: childEnv,
        ...(executeTimeoutMs === undefined ? {} : { timeoutMs: executeTimeoutMs })
      });
      if (input.shouldAbort?.() === true) throw new Error("web-job-aborted");

      const payload = executedPayload(
        executed,
        prepared.jobDir,
        {
          serial: deviceSerial,
          model: input.device.model ?? null,
          osVersion: input.device.osVersion ?? null
        },
        {
          name: install.packageName,
          version: install.version,
          filename: path.basename(packagePath)
        }
      );
      let resultResponse: Awaited<ReturnType<typeof fetch>>;
      try {
        resultResponse = await fetchImpl(
          `${base}/panel/api/jobs/${encodeURIComponent(jobId)}/results`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(payload)
          }
        );
      } catch (error) {
        throw new Error(`web-job-result-upload-failed: ${errorMessage(error)}`);
      }
      if (!resultResponse.ok) {
        throw new Error(
          `web-job-result-upload-failed: ${resultResponse.status} ${await resultResponse
            .text()
            .catch(() => "")}`.trim()
        );
      }
      await cleanupWebJobWorkspace({ workRoot, completedJobIds: [jobId] }).catch(() => undefined);
      return {
        status: RUNNER_STATUS_FROM_EXECUTOR[executed.status],
        ...(executed.detail === null ? {} : { detail: executed.detail })
      };
    } finally {
      await removeWebJobSecrets(prepared.jobDir).catch(() => false);
    }
  };
}
