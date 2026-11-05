import { readFile } from "node:fs/promises";
import path from "node:path";
import { runnerDataTimeoutMs } from "./control/tls-fetch.js";

import { defaultExec, resolveAdbPath, type ExecFn } from "../device/adb.js";
import { resolveMaestroPath } from "../device/maestro.js";
import { errorMessage } from "../util.js";
import { parseWebJobSpec } from "../web/job-spec.js";
import { inspectAndroidPackage } from "../web/package-inspect.js";
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
  /** 控制面需要的结果上传实例 fencing；缺省不发送。 */
  instanceId?: string;
  /** 单次 HTTP 请求超时；缺省 AOS_RUNNER_HTTP_TIMEOUT_MS/15s。 */
  requestTimeoutMs?: number;
  /** Maestro 执行超时（透传 `executeWebJob`）。 */
  timeoutMs?: number;
  /** 执行过程日志（runner 控制台）。 */
  onLog?: (message: string) => void;
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
  "AOS_MAESTRO_REINSTALL_DRIVER",
  "AOS_ADB_PATH",
  "AOS_IDEVICESYSLOG_PATH",
  "AOS_RUNNER_WORK_DIR",
  "AOS_RUNNER_CACHE_DIR"
]);
const CHILD_ENV_DENY = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|DATABASE_URL|_KEY$)/i;

/** 子进程环境最小集：白名单 + 工具前缀；剔除 runner 令牌、DB URL 与任意 TOKEN/KEY 类变量。 */
const CHILD_ENV_CANONICAL = new Map(
  [...CHILD_ENV_ALLOW].map((key) => [key.toLowerCase(), key])
);

export function webRunnerChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CHILD_ENV_DENY.test(key)) continue;
    const canonical = CHILD_ENV_CANONICAL.get(key.toLowerCase());
    const allowed =
      canonical !== undefined ||
      key.startsWith("LC_") ||
      key.startsWith("ANDROID_") ||
      key.startsWith("MAESTRO_");
    if (!allowed) continue;
    // Windows 环境变量大小写不敏感（常见 `Path`）；输出统一为白名单规范名，避免子进程丢 PATH。
    out[canonical ?? key] = value;
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

function authHeaders(
  hostId: string,
  token: string,
  instanceId?: string
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-aos-host-id": hostId,
    ...(instanceId === undefined || instanceId === "" ? {} : { "x-mobile-testing-instance-id": instanceId })
  };
}

function safeSlug(rootPath: string): string {
  const base = path.basename(path.resolve(rootPath)).trim();
  if (base === "" || base === "." || base === "..") return "project";
  return base;
}

const ANDROID_PACKAGE_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** 脚本包 manifest 的 appId（根目录 manifest.json），缺失/非法返回 null。 */
async function readManifestAppId(flowsDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(path.dirname(flowsDir), "manifest.json"), "utf-8");
    const parsed = JSON.parse(raw) as { appId?: unknown };
    const appId = typeof parsed.appId === "string" ? parsed.appId.trim() : "";
    return ANDROID_PACKAGE_RE.test(appId) ? appId : null;
  } catch {
    return null;
  }
}

/** APK 自身的 package/versionCode 优先于脚本 manifest；解析失败回退 manifest appId。 */
async function readApkInfo(
  packagePath: string
): Promise<{ packageName: string | null; versionCode: number | null } | null> {
  try {
    const info = await inspectAndroidPackage(await readFile(packagePath));
    return info === null ? null : { packageName: info.packageName, versionCode: info.versionCode };
  } catch {
    return null;
  }
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

const L2_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
const L2_SCREENSHOT_TOTAL_BYTES = 6 * 1024 * 1024;

async function wakeAndroidDevice(input: {
  adbCommand: string;
  serial: string;
  exec: ExecFn;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const commands: string[][] = [
    ["shell", "svc", "power", "stayon", "true"],
    ["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
    ["shell", "input", "keyevent", "82"],
    ["shell", "wm", "dismiss-keyguard"],
    ["shell", "settings", "put", "system", "screen_off_timeout", "1800000"]
  ];
  for (const args of commands) {
    try {
      await input.exec(
        input.adbCommand,
        ["-s", input.serial, ...args],
        { timeoutMs: 10_000, env: input.env }
      );
    } catch {
      /* 设备可能不允许某条设置；继续执行，Maestro 仍会尝试 */
    }
  }
}

export async function executedPayload(
  executed: WebJobExecutionResult,
  jobDir: string,
  device: { serial: string; model: string | null; osVersion: string | null },
  pkg: { name: string | null; version: string | null; filename: string },
  jobSpec: ReturnType<typeof parseWebJobSpec>
): Promise<Record<string, unknown>> {
  const evidence = new Set<string>();
  for (const entry of executed.cases) {
    for (const file of entry.screenshotPaths ?? []) {
      evidence.add(path.relative(jobDir, file));
    }
    if (entry.logPath !== undefined) evidence.add(path.relative(jobDir, entry.logPath));
  }
  for (const file of executed.diagnostics ?? []) {
    evidence.add(path.relative(jobDir, file));
  }

  // L2 最终截图：只在显式开启时上传；PASS 优先占用预算，单图/总量均有上限。
  const screenshots = new Map<number, { filename: string; base64: string }>();
  if (jobSpec?.l2Screenshots === true && jobSpec.executionMode === "maestro") {
    const candidates = executed.cases
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (entry.screenshotPaths?.length ?? 0) > 0)
      .sort(
        (a, b) => Number(b.entry.status === "PASS") - Number(a.entry.status === "PASS")
      );
    let total = 0;
    for (const { entry, index } of candidates) {
      const paths = entry.screenshotPaths ?? [];
      const file = paths[paths.length - 1];
      if (file === undefined) continue;
      try {
        const buffer = await readFile(file);
        if (buffer.length === 0 || buffer.length > L2_SCREENSHOT_MAX_BYTES) continue;
        if (total + buffer.length > L2_SCREENSHOT_TOTAL_BYTES) continue;
        total += buffer.length;
        screenshots.set(index, {
          filename: path.basename(file),
          base64: buffer.toString("base64")
        });
      } catch {
        /* 截图缺失/不可读：不上传，中心按 unverified 处理 */
      }
    }
  }

  return {
    execution: {
      status: RESULT_STATUS_FROM_EXECUTOR[executed.status],
      cases: executed.cases.map((entry, index) => {
        const screenshot = screenshots.get(index);
        return {
          caseId: entry.caseId,
          name: entry.name,
          status: entry.status,
          durationMs: entry.durationMs,
          ...(entry.assertionCount === undefined ? {} : { assertionCount: entry.assertionCount }),
          ...(entry.assertions === undefined ? {} : { assertions: entry.assertions }),
          ...(entry.manualSteps === undefined ? {} : { manualSteps: entry.manualSteps }),
          ...(entry.failureStep === undefined ? {} : { failureStep: entry.failureStep }),
          ...(entry.failureReason === undefined ? {} : { failureReason: entry.failureReason }),
          ...(screenshot === undefined ? {} : { screenshot })
        };
      }),
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
  const requestTimeoutMs = options.requestTimeoutMs ?? runnerDataTimeoutMs(env);
  const exec: ExecFn = options.exec ?? defaultExec;
  const childEnv = webRunnerChildEnv(env);
  // 用父进程完整 env 解析工具绝对路径：不依赖子进程 env 的 PATH 大小写/白名单。
  const maestroCommand = resolveMaestroPath(env).path ?? "maestro";
  const adbCommand = resolveAdbPath(env, process.platform).path ?? "adb";
  const envTimeoutMs = positiveInt(env.AOS_WEB_JOB_TIMEOUT_MS);
  const executeTimeoutMs = options.timeoutMs ?? envTimeoutMs;
  const installTimeoutMs = positiveInt(env.AOS_WEB_INSTALL_TIMEOUT_MS) ?? 300_000;
  const forceInstall = /^(1|true|yes|on)$/i.test((env.AOS_WEB_FORCE_INSTALL ?? "").trim());
  const onLog = options.onLog ?? (() => undefined);

  return async (input) => {
    const jobId = input.task.id;
    const hostId = (options.hostId ?? input.task.claimedHostId ?? input.task.targetHostId ?? "").trim();
    if (hostId === "") throw new Error("web-job-host-missing");
    const headers = authHeaders(hostId, token, options.instanceId);

    let specResponse: Awaited<ReturnType<typeof fetch>>;
    try {
      specResponse = await fetchImpl(
        `${base}/panel/api/jobs/${encodeURIComponent(jobId)}/spec`,
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(Math.floor(requestTimeoutMs))
        }
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
      const response = await fetchImpl(target, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.floor(requestTimeoutMs))
      });
      if (!response.ok) {
        throw new Error(`web-job-asset-download-failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    };

    const prepared = await prepareWebJobWorkspace({
      jobId,
      projectSlug: safeSlug(input.projectSlug ?? input.rootPath),
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
      const apkInfo = platform === "android" ? await readApkInfo(packagePath) : null;
      const appId =
        apkInfo?.packageName ?? (platform === "android" ? await readManifestAppId(flowsDir) : null);

      const install = await installWebPackage({
        platform,
        deviceSerial,
        packagePath,
        jobDir: prepared.jobDir,
        deviceKind: input.device.kind === "simulator" ? "simulator" : "device",
        exec,
        env: childEnv,
        adbCommand,
        timeoutMs: installTimeoutMs,
        ...(appId === null ? {} : { expectedPackageName: appId }),
        ...(apkInfo?.versionCode === null || apkInfo?.versionCode === undefined
          ? {}
          : { expectedVersionCode: apkInfo.versionCode }),
        skipIfInstalled: !forceInstall
      });
      if (!install.ok) {
        throw new Error(
          `web-job-install-failed:${install.reason}${install.detail === undefined ? "" : `:${install.detail}`}`
        );
      }
      if (install.packageName !== null) {
        const label = install.version === null
          ? install.packageName
          : `${install.packageName} (${install.version})`;
        if (install.skipped === true) {
          onLog(`设备 ${deviceSerial} 已安装 ${label}，跳过安装`);
        } else if (install.recovered === true) {
          onLog(`设备 ${deviceSerial} 已存在 ${label}（安装命令未确认，按已安装继续）`);
        } else {
          onLog(`设备 ${deviceSerial} 已安装 ${label}`);
        }
      }
      if (input.shouldAbort?.() === true) throw new Error("web-job-aborted");
      if (platform === "android") {
        await wakeAndroidDevice({
          adbCommand,
          serial: deviceSerial,
          exec,
          env: childEnv
        });
      }

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
        maestroCommand,
        adbCommand,
        onLog,
        ...(executeTimeoutMs === undefined ? {} : { timeoutMs: executeTimeoutMs })
      });
      if (input.shouldAbort?.() === true) throw new Error("web-job-aborted");

      const payload = await executedPayload(
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
        },
        jobSpec
      );
      let resultResponse: Awaited<ReturnType<typeof fetch>>;
      try {
        resultResponse = await fetchImpl(
          `${base}/panel/api/jobs/${encodeURIComponent(jobId)}/results`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(Math.floor(requestTimeoutMs))
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
