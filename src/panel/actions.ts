import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuthIdentity } from "../auth.js";
import { AmbiguousProjectError } from "../db/types.js";
import type { CaseVerdict, HostRecord, ProjectStore } from "../db/types.js";
import { recordAuditSafe } from "../db/audit-event.js";
import { resolveHostReference } from "../center/store.js";
import { LEGACY_HOST_REASON } from "../host/legacy.js";
import { exportProjectData, type ExportWhat } from "../export/index.js";
import { errorMessage, log, maskSecret, writeFileAtomic } from "../util.js";
import { importTestDocument, type ImportColumns } from "../workflow/excel-import.js";
import { designAssistedImport } from "../workflow/design-enrich.js";
import { figmaExtractFlows, type ExtractFlowsArgs } from "../figma/flows.js";
import { listFigmaFrames } from "../figma/inventory.js";
import { penExtractFlows, type PenExtractFlowsArgs } from "../pen/flows.js";
import type { Runtime } from "../runtime.js";
import { writeEnvUpdates } from "../env-file.js";
import { aosConfigure } from "../tools/configure.js";
import { syncFigmaTokenEnv } from "../figma/token.js";
import { createRunCaseIssues, MAX_ISSUE_ITEMS, normalizeLabels, retryIssueEvidence } from "./issues.js";
import { sameOriginAllowed } from "./http-guard.js";
import {
  assertProjectActive,
  createWebProject,
  normalizeProjectName,
  projectSlug,
  WebProjectCreateError,
  WebProjectStateError
} from "../web/project-service.js";
import {
  isWebAssetKind,
  storeWebAsset,
  WebAssetError,
  WEB_ASSET_KINDS,
  webAssetExtensions,
  webAssetMaxBytes,
  type WebAssetKind
} from "../web/assets.js";
import {
  ExcelMappingServiceError,
  previewExcelAsset,
  saveExcelMapping
} from "../web/excel-mapping.js";
import { ExcelMappingError, normalizeExcelHeader, readExcelHeaders } from "../web/excel.js";
import { suggestExcelMapping } from "../web/excel-columns.js";
import {
  DEFAULT_SYSTEM_COLUMN_MODE,
  parseSystemColumnMode,
  rebaseWorkbookJournal,
  type RebaseWorkbookJournalResult,
  type SystemColumnMode
} from "../web/workbook-reupload.js";
import { parseMultipartUpload, UploadError } from "./upload.js";
import { parseWebJobSpec, WebJobDispatchError, normalizeCaseFilter, type WebJobExecutionMode } from "../web/job-spec.js";
import { createWebJob } from "../web/jobs.js";
import { PenReferenceError, storePenReference, type PenReferenceResult } from "../web/pen-reference.js";
import { FigmaReferenceError, storeFigmaReference } from "../web/figma-reference.js";
import { inferAppIdFromPackage } from "../web/package-inspect.js";
import {
  compareOsVersions,
  parseOsVersion,
  selectWebAssignment,
  type WebDispatchRequirements,
  type WebToolName
} from "../web/dispatch.js";
import { authenticateRunner } from "../runner/control/auth.js";
import { runnerTtlFrom } from "../runner/status.js";
import { applyWebJobManualStatus, ingestWebJobResult, WebResultError } from "../web/results.js";
import {
  computeDispatchPreview,
  dispatchFormSignature,
  dispatchPreviewId,
  hostScopedStore,
  isHostOnline,
  precheckTask
} from "../console/dispatch.js";
import { auditActionLabel } from "../console/vocab.js";
import { resolveAppInstallPlan } from "../tasks/app-install.js";
import { resolveProjectKey, type PanelWebDeps, type PanelWebResponse } from "./web.js";
import {
  panelRequiredRoleForPath,
  panelRoleAtLeast,
  panelRoleFrom
} from "./roles.js";

/** 面板动作层（DESIGN：回归服务 §5.4）：HTTP 模式接线；独立进程需 `AOS_PANEL_ACTIONS=1`＋loopback。
 * 写请求加同源校验（CSRF 纵深防御）；`AOS_PANEL_ACTIONS=0` 整体关闭。body 为已解析 JSON。 */
export interface PanelActionRequest {
  method: string;
  url: URL;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  contentType?: string;
  /** HTTP 认证解析出的用户身份；stdio/独立面板缺省回退环境角色。 */
  identity?: AuthIdentity;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_REFS = 100;
const MAX_VERDICT_ITEMS = 500;

const CASE_VERDICTS = new Set<CaseVerdict>([
  "case-defect",
  "execution-deviation",
  "app-defect",
  "uncertain"
]);
const PLATFORMS = new Set(["ios", "android"]);

function taskPriority(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 100) return null;
  return numeric;
}

export function panelActionsEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_PANEL_ACTIONS;
  return typeof raw !== "string" || raw.trim() !== "0";
}

function json(status: number, payload: unknown): PanelWebResponse {
  return { status, contentType: JSON_CONTENT_TYPE, body: JSON.stringify(payload, null, 2) };
}

/** 失败审计的哨兵根：绝不使用请求里的项目路径（可能在 rollback 后重建目录/写进别的项目）。 */
function auditSentinelRoot(deps: PanelWebDeps): string {
  return deps.workspaceRoot ?? process.cwd();
}

/**
 * 资产上传/预览/映射都在服务本机读写文件；跨主机项目必须回到项目机执行，
 * 否则会在中心磁盘上写出一份与项目机无关的副本。
 */
function crossHostWriteResponse(
  deps: PanelWebDeps,
  resolved: { rootPath: string; hostId: string | null }
): PanelWebResponse | null {
  if (resolved.hostId === null) return null;
  const localHostId = deps.localHostId ?? deps.store.localHostId ?? null;
  if (resolved.hostId === localHostId) return null;
  return json(409, {
    ok: false,
    code: "cross-host-write",
    error: `项目属于主机 ${resolved.hostId}，当前服务本机身份为 ${localHostId ?? "未设置（MOBILE_TESTING_HOST_ID）"}；资产上传/预览/列映射读写本机磁盘，请在项目机面板执行（或先切换到该项目机的 HTTP 服务）`
  });
}

function webProjectStateResponse(error: unknown): PanelWebResponse | null {
  if (!(error instanceof WebProjectStateError)) return null;
  return json(error.status, { ok: false, error: error.message, code: error.code });
}

const RUNNER_JOB_PATH_RE = /^\/panel\/api\/jobs\/([^/]+)\/(?:(spec|results)|assets\/([^/]+))\/?$/;

export interface RunnerJobPath {
  jobId: string;
  assetId: string | null;
  /** `results` 只接受 POST；`spec`/`asset` 保持 GET。 */
  kind: "spec" | "results" | "asset";
}

/** runner 专用 job 路由（spec / 结果上传 / 资产字节流）；其余 `/panel/api/jobs/*` 不在此匹配。 */
export function matchRunnerJobPath(pathname: string): RunnerJobPath | null {
  const match = RUNNER_JOB_PATH_RE.exec(pathname);
  if (!match) return null;
  const jobId = match[1]!;
  if (jobId === "." || jobId === ".." || jobId.includes("\\")) return null;
  const kind = match[2] === "results" ? "results" : match[3] !== undefined ? "asset" : "spec";
  return { jobId, assetId: match[3] ?? null, kind };
}

export interface RunnerJobRequestInput {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
  /** 已解析 JSON body（直接调用方可传；HTTP 路径用 `rawBody`）。 */
  body?: unknown;
  /** 未解析的请求体（HTTP）：鉴权通过后才解析，避免未认证请求先触发 body 校验分支。 */
  rawBody?: Buffer;
  contentType?: string;
}

export interface RunnerJobResponse {
  status: number;
  contentType: string;
  body?: string | Buffer;
  /** 直接落盘流（资产下载）；与 body 互斥。 */
  streamPath?: string;
  streamSize?: number;
  extraHeaders?: Record<string, string>;
}

const RUNNER_JOB_JSON_TYPE = "application/json; charset=utf-8";

function runnerJson(
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): RunnerJobResponse {
  return {
    status,
    contentType: RUNNER_JOB_JSON_TYPE,
    body: JSON.stringify(payload),
    extraHeaders
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return value.trim();
}

function runnerJobAuthResponse(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv
): RunnerJobResponse | null {
  const auth = authenticateRunner(headers, env);
  if (!auth.ok) {
    return runnerJson(auth.status, { ok: false, code: auth.code, error: auth.error });
  }
  return null;
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".apk": "application/vnd.android.package-archive",
  ".ipa": "application/octet-stream",
  ".app": "application/octet-stream",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function assetContentType(filename: string): string {
  return ASSET_CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** 资产必须真实落在项目 `<root>/.artemis/web/assets` 内（realpath + 前缀校验）。 */
async function resolveAssetFile(
  rootPath: string,
  storagePath: string
): Promise<{ filePath: string; size: number } | null> {
  const assetsRoot = path.join(path.resolve(rootPath), ".artemis", "web", "assets");
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(assetsRoot);
    realFile = await realpath(path.resolve(storagePath));
  } catch {
    return null;
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;
  try {
    const info = await stat(realFile);
    if (!info.isFile()) return null;
    return { filePath: realFile, size: info.size };
  } catch {
    return null;
  }
}

/**
 * runner 面向的 job 规格与资产下载（`GET /panel/api/jobs/:id/spec`、
 * `GET /panel/api/jobs/:id/assets/:assetId`）。仅 `AOS_RUNNER_JOB_TOKEN` 放行；
 * 未配置即 503，绝不使用管理员用户令牌。
 */
export async function handleRunnerJobRequest(
  input: RunnerJobRequestInput
): Promise<RunnerJobResponse> {
  const route = matchRunnerJobPath(input.url.pathname);
  if (route === null) return runnerJson(404, { ok: false, error: "not found" });
  if (route.kind === "results") {
    if (input.method !== "POST") {
      return runnerJson(405, { ok: false, error: "method not allowed (POST)" });
    }
  } else if (input.method !== "GET") {
    return runnerJson(405, { ok: false, error: "method not allowed (GET)" });
  }
  const authFailure = runnerJobAuthResponse(input.headers, input.env ?? process.env);
  if (authFailure !== null) return authFailure;

  const job = await input.store.getWebJobById(route.jobId);
  if (job === null) return runnerJson(404, { ok: false, error: `未知 job ${route.jobId}` });
  const hostId = headerValue(input.headers, "x-aos-host-id");
  const allowedHosts = [job.task.claimedHostId, job.task.targetHostId].filter(
    (value): value is string => typeof value === "string" && value !== ""
  );
  if (hostId === "" || !allowedHosts.includes(hostId)) {
    return runnerJson(403, {
      ok: false,
      code: "host-not-allowed",
      error: `主机 ${hostId || "（缺失 X-AOS-Host-Id）"} 无权访问 job ${route.jobId}`
    });
  }
  if (route.kind === "results") {
    const claimedInstanceId = job.task.claimedInstanceId ?? "";
    const instanceId =
      headerValue(input.headers, "x-mobile-testing-instance-id") ||
      headerValue(input.headers, "x-aos-instance-id");
    if (claimedInstanceId !== "" && instanceId !== claimedInstanceId) {
      return runnerJson(409, {
        ok: false,
        code: "instance-mismatch",
        error:
          instanceId === ""
            ? `job ${route.jobId} 已绑定执行实例 ${claimedInstanceId}，结果上传缺少 X-Mobile-Testing-Instance-Id`
            : `执行实例 ${instanceId} 不是 job ${route.jobId} 的当前实例 ${claimedInstanceId}`
      });
    }
    const contentType = (input.contentType ?? headerValue(input.headers, "content-type")).toLowerCase();
    if (contentType !== "" && !contentType.includes("application/json")) {
      return runnerJson(415, {
        ok: false,
        code: "unsupported-media-type",
        error: "结果上传需要 Content-Type: application/json"
      });
    }
    let payload: unknown;
    if (input.body !== undefined) {
      payload = input.body;
    } else if (input.rawBody !== undefined) {
      const text = input.rawBody.toString("utf8").trim();
      if (text === "") {
        return runnerJson(400, {
          ok: false,
          code: "invalid-result",
          error: "结果 body 为空"
        });
      }
      try {
        payload = JSON.parse(text);
      } catch (error) {
        return runnerJson(400, {
          ok: false,
          code: "invalid-result",
          error: `结果 body 不是合法 JSON：${errorMessage(error)}`
        });
      }
    }
    try {
      const summary = await ingestWebJobResult({
        store: input.store,
        jobId: route.jobId,
        payload,
        actor: hostId
      });
      return runnerJson(200, {
        ok: true,
        jobId: summary.jobId,
        resultSha256: summary.resultSha256,
        taskStatus: summary.taskStatus,
        dbStatus: summary.dbStatus,
        gate: summary.gate,
        writtenCells: summary.writtenCells.map((cell) => ({
          caseId: cell.caseId,
          key: cell.key,
          value: cell.value
        })),
        warnings: summary.warnings.map((warning) =>
          warning.split(job.rootPath).join("<project>")
        ),
        writebackStatus: summary.writebackStatus,
        resultCsvPath:
          summary.resultCsvPath === null
            ? null
            : summary.resultCsvPath.split(job.rootPath).join("<project>"),
        idempotent: summary.idempotent
      });
    } catch (error) {
      if (error instanceof WebResultError) {
        return runnerJson(error.status, {
          ok: false,
          code: error.code === "task-not-running" ? "result-already-recorded" : error.code,
          error: error.message
        });
      }
      throw error;
    }
  }
  const spec = parseWebJobSpec(job.task.jobSpec);
  if (spec === null) {
    return runnerJson(404, { ok: false, error: `job ${route.jobId} 没有可用的规格` });
  }

  if (route.assetId === null) {
    const assets = [];
    for (const snapshot of spec.assetSnapshot) {
      const record = await input.store.getWebAsset(job.rootPath, snapshot.id);
      assets.push({
        id: snapshot.id,
        kind: snapshot.kind,
        sha256: snapshot.sha256,
        filename: snapshot.filename,
        secret: record?.metadata?.secret === true,
        downloadUrl: `/panel/api/jobs/${encodeURIComponent(route.jobId)}/assets/${encodeURIComponent(
          snapshot.id
        )}`
      });
    }
    return runnerJson(200, {
      ok: true,
      job: {
        id: job.task.id,
        status: job.task.status,
        deviceSerial: job.task.deviceSerial,
        claimedBy: job.task.claimedBy
      },
      spec: job.task.jobSpec,
      assets
    });
  }

  const snapshot = spec.assetSnapshot.find((entry) => entry.id === route.assetId);
  if (snapshot === undefined) {
    return runnerJson(404, { ok: false, error: `资产 ${route.assetId} 不属于 job ${route.jobId}` });
  }
  const record = await input.store.getWebAsset(job.rootPath, route.assetId);
  if (record === null || record.kind !== snapshot.kind) {
    return runnerJson(404, { ok: false, error: `资产 ${route.assetId} 不在项目内` });
  }
  const resolved = await resolveAssetFile(job.rootPath, record.storagePath);
  if (resolved === null) {
    return runnerJson(404, { ok: false, error: `资产 ${route.assetId} 文件不可用` });
  }
  return {
    status: 200,
    contentType: assetContentType(record.filename),
    streamPath: resolved.filePath,
    streamSize: resolved.size,
    extraHeaders: {
      "Content-Length": String(resolved.size),
      "X-Aos-Sha256": record.sha256
    }
  };
}

export async function handlePanelActionRequest(
  request: PanelActionRequest,
  deps: PanelWebDeps
): Promise<PanelWebResponse> {
  const env = deps.env ?? process.env;
  if (!panelActionsEnabled(env)) return json(404, { error: "not found" });
  if (!request.url.pathname.startsWith("/panel/api/")) return json(404, { error: "not found" });
  if (!sameOriginAllowed(request.headers)) {
    return json(403, { error: "跨站请求被拒绝（同源校验失败）" });
  }
  const role = request.identity?.role ?? panelRoleFrom(env);
  const actor = request.identity?.name ?? deps.actor ?? "panel";
  const required = panelRequiredRoleForPath(request.url.pathname);
  if (required !== null && !panelRoleAtLeast(role, required)) {
    return json(403, {
      error: `当前角色 ${role} 无权限执行该动作（需要 ${required}）`,
      code: "role_forbidden",
      role,
      required
    });
  }
  const isExportDownload =
    request.method === "GET" && request.url.pathname === "/panel/api/export";
  if (request.url.pathname === "/panel/api/jobs/preview") {
    return await previewWebJobAction(deps, request);
  }
  if (request.method !== "POST" && !isExportDownload) {
    return json(405, { error: "method not allowed (POST)" });
  }
  let payload: Record<string, unknown>;
  if (isExportDownload) {
    payload = {
      project: request.url.searchParams.get("project") ?? "",
      what: request.url.searchParams.get("what") ?? "",
      ...(request.url.searchParams.get("format") === null
        ? {}
        : { format: request.url.searchParams.get("format") }),
      ...(request.url.searchParams.get("since") === null
        ? {}
        : { since: request.url.searchParams.get("since") }),
      ...(request.url.searchParams.get("limit") === null
        ? {}
        : { limit: request.url.searchParams.get("limit") })
    };
  } else {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      if (request.rawBody !== undefined) {
        // multipart 上传（导入）：字段不在 JSON body 中，project/host 由查询参数携带。
        payload = {};
      } else {
        return json(400, { error: "请求体不是合法 JSON（检查 Content-Type 与 body）" });
      }
    } else {
      payload = request.body as Record<string, unknown>;
    }
  }
  if (request.url.pathname === "/panel/api/projects/config") {
    const projectKey = typeof payload.project === "string" ? payload.project.trim() : "";
    if (projectKey === "") return json(400, { error: "缺少 project" });
    const hostParam = typeof payload.host === "string" ? payload.host.trim() : "";
    const resolved = await resolveProjectKey(
      deps,
      projectKey,
      hostParam === "" ? undefined : hostParam
    ).catch(() => null);
    if (resolved === null) return json(404, { error: `未知项目 "${projectKey}"` });
    const response = await configureProject(deps, resolved.rootPath, payload);
    await auditPanel(deps, resolved.rootPath, "action.config", response, {
      project: projectKey
    });
    if (response.status === 200) deps.cache?.clear();
    return response;
  }
  if (request.url.pathname === "/panel/api/projects/assets/figma") {
    return await uploadFigmaReferenceAction(deps, payload, actor);
  }
  if (request.url.pathname === "/panel/api/projects/assets/archive") {
    return await archiveAssetAction(deps, payload, actor);
  }
  if (request.url.pathname === "/panel/api/projects/assets/delete") {
    return await deleteAssetAction(deps, payload, actor);
  }
  if (request.url.pathname === "/panel/api/projects/assets") {
    return await uploadAssetAction(deps, request, actor);
  }
  if (request.url.pathname === "/panel/api/hosts/register") {
    const response = await registerHost(deps, payload);
    const hostId = typeof payload.host === "string" ? payload.host.trim() : "";
    const auditRoot = await hostAuditRoot(deps, payload, hostId);
    await auditPanel(
      deps,
      auditRoot,
      "action.hosts.register",
      response,
      hostId === "" ? undefined : { hostId }
    );
    if (response.status === 200) deps.cache?.clear();
    return response;
  }
  if (
    request.url.pathname === "/panel/api/queue/pause" ||
    request.url.pathname === "/panel/api/queue/resume"
  ) {
    const paused = request.url.pathname === "/panel/api/queue/pause";
    const hostRef = typeof payload.host === "string" ? payload.host.trim() : "";
    let response: PanelWebResponse;
    let resolvedHostId: string | null = null;
    if (hostRef === "") {
      response = json(400, { error: "缺少 host" });
    } else {
      const lookup = await resolveHostReference(deps.store, hostRef);
      if (!lookup.ok) {
        response =
          lookup.reason === "ambiguous"
            ? json(400, {
                error: `主机名不唯一 "${hostRef}"，请改用主机 id`,
                candidates: lookup.candidates.map((host) => host.id)
              })
            : json(404, { error: `未知主机 "${hostRef}"（先用 host list 查看已登记主机）` });
      } else {
        resolvedHostId = lookup.host.id;
        const record = await deps.store.setHostQueuePaused({
          hostId: lookup.host.id,
          paused,
          by: "panel"
        });
        response = record
          ? json(200, { ok: true, host: record })
          : json(404, { error: `未知主机 "${hostRef}"` });
      }
    }
    const note = typeof payload.note === "string" ? payload.note.trim() : "";
    const auditRoot = await hostAuditRoot(deps, payload, hostRef);
    await auditPanel(
      deps,
      auditRoot,
      paused ? "action.queue.pause" : "action.queue.resume",
      response,
      {
        ...(resolvedHostId === null ? {} : { hostId: resolvedHostId }),
        ...(note === "" ? {} : { note })
      },
      { actor, actorHostId: resolvedHostId, channel: "panel" }
    );
    if (response.status === 200) deps.cache?.clear();
    return response;
  }
  if (request.url.pathname === "/panel/api/projects") {
    return await createProjectAction(deps, payload, actor);
  }
  if (request.url.pathname === "/panel/api/projects/archive") {
    return await archiveProjectAction(deps, payload, actor);
  }
  const queryProject =
    request.url.pathname === "/panel/api/import" && request.rawBody !== undefined
      ? (request.url.searchParams.get("project") ?? "").trim()
      : "";
  const projectKey =
    (typeof payload.project === "string" ? payload.project.trim() : "") || queryProject;
  if (projectKey === "") return json(400, { error: "缺少 project" });
  const hostParam =
    (request.url.searchParams.get("host") ?? "").trim() ||
    (typeof payload.host === "string" ? payload.host.trim() : "");
  let resolved: { rootPath: string; name: string; hostId: string | null } | null;
  try {
    resolved = await resolveProjectKey(deps, projectKey, hostParam === "" ? undefined : hostParam);
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return json(409, {
        error: error.message,
        candidates: error.candidates.map((candidate) => ({
          hostId: candidate.hostId,
          rootPath: candidate.rootPath,
          name: candidate.name
        }))
      });
    }
    throw error;
  }
  if (!resolved) return json(404, { error: `未知项目 "${projectKey}"` });
  const scopedDeps: PanelWebDeps = {
    ...(resolved.hostId === null
      ? deps
      : { ...deps, store: deps.storeForHost?.(resolved.hostId) ?? deps.store }),
    actor: deps.actor ?? actor
  };

  try {
    if (request.url.pathname === "/panel/api/projects/excel/preview") {
      return await previewExcelMappingAction(scopedDeps, resolved, payload);
    }
    if (request.url.pathname === "/panel/api/projects/excel/mapping") {
      return await saveExcelMappingAction(scopedDeps, resolved, payload, actor);
    }
    if (request.url.pathname === "/panel/api/tasks") {
      const response = await createTask(
        scopedDeps,
        resolved.rootPath,
        payload,
        resolved.hostId,
        deps.store.localHostId ?? null
      );
      if (response.status === 200) scopedDeps.cache?.clear();
      await auditPanel(scopedDeps, resolved.rootPath, "action.tasks", response);
      return response;
    }
    const manualStatusMatch = /^\/panel\/api\/jobs\/([^/]+)\/cases\/([^/]+)\/status$/.exec(
      request.url.pathname
    );
    if (manualStatusMatch !== null) {
      const jobId = decodeURIComponent(manualStatusMatch[1]!);
      const caseId = decodeURIComponent(manualStatusMatch[2]!);
      const rawStatus = payload.status;
      const status =
        rawStatus === "" || rawStatus === null || rawStatus === undefined
          ? null
          : rawStatus === "NOT_IMPL" || rawStatus === "未实现"
            ? "NOT_IMPL"
            : rawStatus === "BLOCKED" || rawStatus === "阻塞"
              ? "BLOCKED"
              : undefined;
      if (status === undefined) {
        return json(400, { error: "status 必须是 NOT_IMPL / BLOCKED / 空" });
      }
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      try {
        const result = await applyWebJobManualStatus({
          store: scopedDeps.store,
          rootPath: resolved.rootPath,
          jobId,
          caseId,
          status,
          reason,
          actor
        });
        const response = json(200, {
          ok: true,
          jobId,
          caseId,
          status,
          gate: result.document.gate,
          taskStatus: result.document.taskStatus,
          writebackStatus: result.document.writebackStatus,
          warnings: result.warnings
        });
        await auditPanel(scopedDeps, resolved.rootPath, "action.jobs.case-status", response, {
          taskId: jobId,
          caseId
        });
        if (response.status === 200) scopedDeps.cache?.clear();
        return response;
      } catch (error) {
        if (error instanceof WebResultError) {
          return json(error.status, { error: error.message, code: error.code });
        }
        throw error;
      }
    }
    if (request.url.pathname === "/panel/api/jobs") {
      // Web 测试资产属于中心项目；执行机 host 只作为 targetHostId，不要求项目在 runner 上登记。
      // 但同一 rootPath 在多 host 有登记时，优先用目标 host 的 store，避免中心视角歧义。
      let webStore = deps.store;
      if (resolved.hostId !== null) {
        const scoped = deps.storeForHost?.(resolved.hostId);
        if (scoped && (await scoped.getProjectByPath(resolved.rootPath).catch(() => null)) !== null) {
          webStore = scoped;
        }
      }
      const webDeps: PanelWebDeps = { ...scopedDeps, store: webStore };
      const response = await createWebJobAction(webDeps, resolved.rootPath, payload, actor);
      if (response.status === 200) scopedDeps.cache?.clear();
      const refs: Record<string, string | undefined> = {};
      try {
        const raw =
          typeof response.body === "string" ? response.body : response.body.toString("utf8");
        const created = JSON.parse(raw) as { job?: { id?: unknown } };
        if (typeof created.job?.id === "string") refs.taskId = created.job.id;
      } catch {
        /* 非 JSON：仅记动作结果 */
      }
      await auditPanel(scopedDeps, resolved.rootPath, "action.jobs", response, refs);
      return response;
    }
    if (request.url.pathname === "/panel/api/verdicts") {
      const response = await saveVerdicts(scopedDeps, resolved.rootPath, payload);
      await auditPanel(scopedDeps, resolved.rootPath, "action.verdicts", response);
      return response;
    }
    if (request.url.pathname === "/panel/api/issues") {
      const response = await createIssues(scopedDeps, resolved.rootPath, payload);
      await auditPanel(scopedDeps, resolved.rootPath, "action.issues", response);
      return response;
    }
    if (request.url.pathname === "/panel/api/tasks/cancel") {
      const response = await cancelTask(scopedDeps, resolved.rootPath, payload, resolved.hostId, actor);
      await auditPanel(
        scopedDeps,
        resolved.rootPath,
        "action.tasks.cancel",
        response,
        {
          taskId: String(payload.taskId ?? ""),
          ...(resolved.hostId === null ? {} : { hostId: resolved.hostId })
        },
        { actor, actorHostId: resolved.hostId, channel: "panel" }
      );
      return response;
    }
    if (request.url.pathname === "/panel/api/tasks/release") {
      const response = await releaseTask(scopedDeps, resolved.rootPath, payload);
      await auditPanel(scopedDeps, resolved.rootPath, "action.release", response, {
        taskId: String(payload.taskId ?? "")
      });
      return response;
    }
    if (request.url.pathname === "/panel/api/tasks/stop") {
      const response = await stopTask(scopedDeps, resolved.rootPath, payload, resolved.hostId, actor);
      await auditPanel(scopedDeps, resolved.rootPath, "action.stop", response, {
        taskId: String(payload.taskId ?? "")
      });
      return response;
    }
    if (request.url.pathname === "/panel/api/tasks/rerun") {
      const response = await rerunTask(scopedDeps, resolved.rootPath, payload);
      await auditPanel(scopedDeps, resolved.rootPath, "action.rerun", response, {
        taskId: String(payload.taskId ?? "")
      });
      return response;
    }
    if (request.url.pathname === "/panel/api/issues/evidence") {
      const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
      const caseId = typeof payload.caseId === "string" ? payload.caseId.trim() : "";
      if (runId === "" || caseId === "") return json(400, { error: "缺少 runId/caseId" });
      const outcome = await retryIssueEvidence(
        { store: scopedDeps.store, runtimeFor: scopedDeps.runtimeFor },
        { rootPath: resolved.rootPath, runId, caseId }
      );
      const response = outcome.ok ? json(200, outcome) : json(400, outcome);
      await auditPanel(scopedDeps, resolved.rootPath, "action.issues.evidence", response, { runId, caseId });
      return response;
    }
    if (request.url.pathname === "/panel/api/schedules") {
      const response = await manageSchedules(scopedDeps, resolved.rootPath, payload);
      await auditPanel(scopedDeps, resolved.rootPath, "action.schedules", response);
      return response;
    }
    if (request.url.pathname === "/panel/api/quarantine") {
      const response = await manageQuarantine(resolved.rootPath, payload);
      if (response.status === 200) scopedDeps.cache?.clear();
      await auditPanel(scopedDeps, resolved.rootPath, "action.quarantine", response);
      return response;
    }
    if (request.url.pathname === "/panel/api/export") {
      const response = await runExport(scopedDeps, resolved.rootPath, payload);
      await auditPanel(scopedDeps, resolved.rootPath, "action.export", response);
      return response;
    }
    if (request.url.pathname === "/panel/api/import") {
      const response = await runImport(
        scopedDeps,
        resolved.rootPath,
        payload,
        request,
        resolved.hostId
      );
      if (response.status === 200) scopedDeps.cache?.clear();
      await auditPanel(scopedDeps, resolved.rootPath, "action.import", response);
      return response;
    }
    return json(404, { error: "not found" });
  } catch (error) {
    log(`面板动作失败: ${errorMessage(error)}`);
    await recordAuditSafe(scopedDeps.store, resolved.rootPath, {
      domain: "panel",
      action: "action.error",
      result: "failed",
      actor,
      summary: `面板动作异常：${errorMessage(error)}`
    });
    return json(500, { ok: false, error: "服务内部错误（已写入审计；可重试或查看日志）" });
  }
}

async function createProjectAction(
  deps: PanelWebDeps,
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const rawName = typeof payload.name === "string" ? payload.name.trim() : "";
  if (rawName === "") return json(400, { error: "缺少 name（项目名称）" });
  let name: string;
  try {
    name = normalizeProjectName(rawName).name;
  } catch (error) {
    return json(400, { error: errorMessage(error) });
  }
  if (!Array.isArray(payload.platforms) || payload.platforms.length === 0) {
    return json(400, { error: "platforms 至少选择一个（android、ios）" });
  }
  if (
    payload.platforms.some(
      (platform) => typeof platform !== "string" || !PLATFORMS.has(platform)
    )
  ) {
    return json(400, { error: "platforms 仅支持 ios/android" });
  }
  if (payload.appPackage === undefined || payload.appPackage === null) {
    return json(400, { error: "缺少 appPackage（应用包名）" });
  }
  if (typeof payload.appPackage !== "string") {
    return json(400, { error: "appPackage 必须是字符串" });
  }
  if (payload.appPackage.trim() === "") {
    return json(400, { error: "appPackage 不能为空" });
  }
  if (
    payload.customerName !== undefined &&
    payload.customerName !== null &&
    typeof payload.customerName !== "string"
  ) {
    return json(400, { error: "customerName 必须是字符串或 null" });
  }
  const platforms = [...new Set(payload.platforms as string[])];
  const appPackage = payload.appPackage.trim();
  const customerName =
    typeof payload.customerName === "string" && payload.customerName.trim() !== ""
      ? payload.customerName.trim()
      : null;
  const workspaceRoot = deps.workspaceRoot ?? process.cwd();
  const intendedRoot = path.join(workspaceRoot, projectSlug(name));

  try {
    const result = await createWebProject({
      store: deps.store,
      workspaceRoot,
      name,
      platforms,
      appPackage,
      customerName,
      owner: actor
    });
    deps.cache?.clear();
    const response = json(200, {
      ok: true,
      project: {
        rootPath: result.rootPath,
        name: result.web.name,
        platforms: result.web.platforms,
        appPackage: result.web.appPackage
      }
    });
    await recordAuditSafe(deps.store, result.rootPath, {
      domain: "project",
      action: "project.create",
      result: "ok",
      actor,
      summary: `创建 Web 项目：${result.web.name}（${result.rootPath}）`
    });
    return response;
  } catch (error) {
    const message = errorMessage(error);
    const conflict =
      error instanceof WebProjectCreateError &&
      (error.code === "duplicate-name" || error.code === "directory-exists");
    await recordAuditSafe(deps.store, auditSentinelRoot(deps), {
      domain: "project",
      action: "project.create",
      result: "failed",
      actor,
      summary: `创建 Web 项目失败：${name}（${intendedRoot}）：${message}`
    });
    return json(
      conflict ? 409 : 500,
      conflict ? { ok: false, error: message } : { ok: false, error: `创建项目失败：${message}` }
    );
  }
}

async function archiveProjectAction(
  deps: PanelWebDeps,
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const projectKey = typeof payload.project === "string" ? payload.project.trim() : "";
  if (projectKey === "") return json(400, { error: "缺少 project" });
  let resolved: { rootPath: string; name: string; hostId: string | null } | null;
  try {
    resolved = await resolveProjectKey(deps, projectKey);
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return json(409, {
        error: error.message,
        candidates: error.candidates.map((candidate) => ({
          hostId: candidate.hostId,
          rootPath: candidate.rootPath,
          name: candidate.name
        }))
      });
    }
    throw error;
  }
  if (!resolved) {
    await recordAuditSafe(deps.store, auditSentinelRoot(deps), {
      domain: "project",
      action: "project.archive",
      result: "failed",
      actor,
      summary: `归档 Web 项目失败：未知项目 "${projectKey}"`
    });
    return json(404, { error: `未知项目 "${projectKey}"` });
  }
  const archived = await deps.store.archiveWebProject(resolved.rootPath, new Date().toISOString());
  if (!archived) {
    await recordAuditSafe(deps.store, resolved.rootPath, {
      domain: "project",
      action: "project.archive",
      result: "failed",
      actor,
      summary: `归档 Web 项目失败：未登记 Web 项目（${resolved.rootPath}）`
    });
    return json(404, { error: `未登记 Web 项目 "${projectKey}"` });
  }
  deps.cache?.clear();
  await recordAuditSafe(deps.store, resolved.rootPath, {
    domain: "project",
    action: "project.archive",
    result: "ok",
    actor,
    summary: `归档 Web 项目：${resolved.name}（${resolved.rootPath}）`
  });
  return json(200, { ok: true });
}

async function uploadFigmaReferenceAction(
  deps: PanelWebDeps,
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const projectKey = typeof payload.project === "string" ? payload.project.trim() : "";
  const figmaUrl = typeof payload.figmaUrl === "string" ? payload.figmaUrl.trim() : "";
  if (projectKey === "" || figmaUrl === "") {
    return json(400, { ok: false, error: "缺少 project 或 figmaUrl" });
  }
  const hostParam = typeof payload.host === "string" ? payload.host.trim() : "";
  let resolved: { rootPath: string; name: string; hostId: string | null } | null;
  try {
    resolved = await resolveProjectKey(deps, projectKey, hostParam === "" ? undefined : hostParam);
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return json(409, { error: error.message, candidates: error.candidates });
    }
    throw error;
  }
  if (!resolved) return json(404, { error: `未知项目 "${projectKey}"` });
  const crossHost = crossHostWriteResponse(deps, resolved);
  if (crossHost !== null) return crossHost;
  const scopedDeps: PanelWebDeps = {
    ...(resolved.hostId === null
      ? deps
      : { ...deps, store: deps.storeForHost?.(resolved.hostId) ?? deps.store }),
    actor: deps.actor ?? actor
  };
  try {
    await assertProjectActive(scopedDeps.store, resolved.rootPath);
    const result = await storeFigmaReference({
      store: scopedDeps.store,
      rootPath: resolved.rootPath,
      figmaUrl,
      nodeId: typeof payload.nodeId === "string" ? payload.nodeId : null,
      uploadedBy: actor
    });
    await recordAuditSafe(scopedDeps.store, resolved.rootPath, {
      domain: "asset",
      action: "asset.upload",
      result: "ok",
      actor,
      summary: `导入 Figma 参考图：node ${result.nodeId}（${result.asset.filename}）`,
      refs: {
        assetId: result.asset.id,
        kind: result.asset.kind,
        fileKey: result.fileKey,
        nodeId: result.nodeId
      }
    });
    deps.cache?.clear();
    return json(200, { ok: true, asset: result.asset, fileKey: result.fileKey, nodeId: result.nodeId });
  } catch (error) {
    if (error instanceof FigmaReferenceError) {
      return json(400, { ok: false, code: error.code, error: error.message });
    }
    throw error;
  }
}

async function assetReferences(
  store: ProjectStore,
  rootPath: string,
  assetId: string
): Promise<string[]> {
  const refs: string[] = [];
  const tasks = await store.listRegressionTasks(rootPath, 1000).catch(() => []);
  for (const task of tasks) {
    if (task.appAssetId === assetId) refs.push(`任务 ${task.id}（安装包）`);
    if (task.materialsAssetId === assetId) refs.push(`任务 ${task.id}（测试资料）`);
    const spec =
      task.jobSpec !== null && typeof task.jobSpec === "object"
        ? (task.jobSpec as Record<string, unknown>)
        : null;
    if (spec === null) continue;
    for (const key of [
      "excelAssetId",
      "packageAssetId",
      "materialsAssetId",
      "referenceAssetId"
    ] as const) {
      if (spec[key] === assetId) refs.push(`Web 任务 ${task.id}（${key}）`);
    }
    const snapshot = Array.isArray(spec.assetSnapshot) ? spec.assetSnapshot : [];
    if (
      snapshot.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as { id?: unknown }).id === assetId
      )
    ) {
      refs.push(`Web 任务 ${task.id}（资产快照）`);
    }
  }
  const mappings = await store.listExcelMappings(rootPath, assetId).catch(() => []);
  if (mappings.length > 0) refs.push(`Excel 列映射 ${mappings.length} 条`);
  return refs;
}

async function assetProjectContext(
  deps: PanelWebDeps,
  payload: Record<string, unknown>
): Promise<
  | { ok: true; rootPath: string; store: ProjectStore }
  | { ok: false; response: PanelWebResponse }
> {
  const projectKey = panelTextField(payload, "project");
  if (projectKey === "") {
    return { ok: false, response: json(400, { error: "缺少 project" }) };
  }
  const host = panelTextField(payload, "host");
  let resolved: Awaited<ReturnType<typeof resolveProjectKey>> = null;
  try {
    resolved = await resolveProjectKey(deps, projectKey, host === "" ? undefined : host);
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return {
        ok: false,
        response: json(409, {
          error: error.message,
          candidates: error.candidates.map((candidate) => ({
            hostId: candidate.hostId,
            rootPath: candidate.rootPath,
            name: candidate.name
          }))
        })
      };
    }
    throw error;
  }
  if (resolved === null) {
    return { ok: false, response: json(404, { error: `未知项目 "${projectKey}"` }) };
  }
  const store =
    resolved.hostId === null
      ? deps.store
      : (deps.storeForHost?.(resolved.hostId) ?? deps.store);
  return { ok: true, rootPath: resolved.rootPath, store };
}

async function archiveAssetAction(
  deps: PanelWebDeps,
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const assetId = panelTextField(payload, "assetId");
  if (assetId === "") return json(400, { error: "缺少 assetId" });
  const context = await assetProjectContext(deps, payload);
  if (!context.ok) return context.response;
  try {
    await assertProjectActive(context.store, context.rootPath);
  } catch (error) {
    return json(400, { error: errorMessage(error) });
  }
  const asset = await context.store.getWebAsset(context.rootPath, assetId);
  if (asset === null) return json(404, { error: `未知资产 "${assetId}"` });
  const archived = payload.archived !== false;
  const changed = await context.store.setWebAssetArchived(
    context.rootPath,
    assetId,
    archived
  );
  const response = changed
    ? json(200, {
        ok: true,
        assetId,
        archived,
        asset: await context.store.getWebAsset(context.rootPath, assetId)
      })
    : json(404, { error: `未知资产 "${assetId}"` });
  await auditPanel(deps, context.rootPath, "action.assets.archive", response, {
    assetId,
    archived: archived ? "true" : "false"
  }, { actor });
  if (response.status === 200) deps.cache?.clear();
  return response;
}

async function deleteAssetAction(
  deps: PanelWebDeps,
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const assetId = panelTextField(payload, "assetId");
  if (assetId === "") return json(400, { error: "缺少 assetId" });
  const context = await assetProjectContext(deps, payload);
  if (!context.ok) return context.response;
  try {
    await assertProjectActive(context.store, context.rootPath);
  } catch (error) {
    return json(400, { error: errorMessage(error) });
  }
  const asset = await context.store.getWebAsset(context.rootPath, assetId);
  if (asset === null) return json(404, { error: `未知资产 "${assetId}"` });
  const refs = await assetReferences(context.store, context.rootPath, assetId);
  if (refs.length > 0) {
    return json(409, {
      ok: false,
      error: "资产仍被引用：先归档或删除引用它的任务/映射",
      references: refs.slice(0, 20)
    });
  }
  const removed = await context.store.deleteWebAsset(context.rootPath, assetId);
  if (removed === null) return json(404, { error: `未知资产 "${assetId}"` });
  const remaining = await context.store
    .listWebAssets(context.rootPath, undefined, { includeArchived: true })
    .catch(() => []);
  if (!remaining.some((entry) => entry.storagePath === removed.storagePath)) {
    await unlink(removed.storagePath).catch(() => undefined);
  }
  deps.cache?.clear();
  const response = json(200, {
    ok: true,
    assetId,
    filename: removed.filename,
    fileRetained: remaining.some((entry) => entry.storagePath === removed.storagePath)
  });
  await auditPanel(deps, context.rootPath, "action.assets.delete", response, { assetId }, {
    actor
  });
  return response;
}

async function uploadAssetAction(
  deps: PanelWebDeps,
  request: PanelActionRequest,
  actor: string
): Promise<PanelWebResponse> {
  if (request.rawBody === undefined) {
    return json(400, { error: "资产上传需要 multipart/form-data（字段 project、kind、file）" });
  }
  let upload: Awaited<ReturnType<typeof parseMultipartUpload>>;
  try {
    // kind 是 multipart 文本字段，只能解析后才知道；先按全类型并集接收（上限取最大值＋
    // multipart 头开销），再由 storeWebAsset 按 kind 精确校验扩展名与大小并返回 typed 错误。
    upload = await parseMultipartUpload(request.rawBody, request.contentType, {
      maxBytes:
        Math.max(...WEB_ASSET_KINDS.map((candidate) => webAssetMaxBytes(candidate))) +
        64 * 1024,
      extensions: WEB_ASSET_KINDS.flatMap((candidate) => [...webAssetExtensions(candidate)])
    });
  } catch (error) {
    if (error instanceof UploadError) return json(error.status, { error: error.message });
    throw error;
  }

  const projectKey =
    (upload.fields.project ?? "").trim() ||
    (request.url.searchParams.get("project") ?? "").trim();
  if (projectKey === "") return json(400, { error: "缺少 project" });

  const kindRaw = (upload.fields.kind ?? "").trim().toLowerCase();
  if (kindRaw === "") {
    return json(400, { error: `缺少 kind（支持 ${WEB_ASSET_KINDS.join("/")}）` });
  }
  if (!isWebAssetKind(kindRaw)) {
    return json(400, {
      error: `未知 kind "${kindRaw}"（仅支持 ${WEB_ASSET_KINDS.join("、")}）`
    });
  }
  const kind: WebAssetKind = kindRaw;
  const secretFlag = (upload.fields.secret ?? "").trim().toLowerCase();
  if (secretFlag === "true" && kind !== "materials") {
    return json(400, {
      error: "secret=true 仅适用于 materials 资产",
      code: "invalid-metadata"
    });
  }
  const metadata: Record<string, unknown> = secretFlag === "true" ? { secret: true } : {};

  // 下载工作副本后重上传：默认 human（8 个系统格全部按人工冻结），inherit 需显式声明；
  // 只对 excel 有意义，其他 kind 携带该字段按 typed 400 拒绝（不静默忽略）。
  const systemColumnsRaw = (upload.fields.systemColumns ?? "").trim();
  let systemColumnsMode: SystemColumnMode = DEFAULT_SYSTEM_COLUMN_MODE;
  if (systemColumnsRaw !== "") {
    if (kind !== "excel") {
      return json(400, {
        error: `systemColumns 仅适用于 excel 资产（当前 kind=${kind}）`,
        code: "invalid-system-columns"
      });
    }
    const parsed = parseSystemColumnMode(systemColumnsRaw);
    if (parsed === null) {
      return json(400, {
        error: `未知 systemColumns "${systemColumnsRaw}"（仅支持 inherit、human）`,
        code: "invalid-system-columns"
      });
    }
    systemColumnsMode = parsed;
  }

  const hostParam =
    (upload.fields.host ?? "").trim() ||
    (request.url.searchParams.get("host") ?? "").trim();
  let resolved: { rootPath: string; name: string; hostId: string | null } | null;
  try {
    resolved = await resolveProjectKey(
      deps,
      projectKey,
      hostParam === "" ? undefined : hostParam
    );
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return json(409, {
        error: error.message,
        candidates: error.candidates.map((candidate) => ({
          hostId: candidate.hostId,
          rootPath: candidate.rootPath,
          name: candidate.name
        }))
      });
    }
    throw error;
  }
  if (!resolved) return json(404, { error: `未知项目 "${projectKey}"` });
  const crossHost = crossHostWriteResponse(deps, resolved);
  if (crossHost !== null) return crossHost;

  const scopedDeps: PanelWebDeps = {
    ...(resolved.hostId === null
      ? deps
      : { ...deps, store: deps.storeForHost?.(resolved.hostId) ?? deps.store }),
    actor: deps.actor ?? actor
  };

  try {
    await assertProjectActive(scopedDeps.store, resolved.rootPath);
    // 必须在登记新版本前取「上一版本」，否则拿到的是自己。
    const previousExcelAsset =
      kind === "excel"
        ? ((await scopedDeps.store.listWebAssets(resolved.rootPath, "excel"))[0] ?? null)
        : null;
    let asset: Awaited<ReturnType<typeof storeWebAsset>>;
    let penReference: PenReferenceResult | null = null;
    if (kind === "reference" && upload.filename.toLowerCase().endsWith(".pen")) {
      try {
        penReference = await storePenReference({
          store: scopedDeps.store,
          rootPath: resolved.rootPath,
          filename: upload.filename,
          buffer: upload.content,
          uploadedBy: actor
        });
        asset = penReference.assets[0]!;
      } catch (error) {
        if (error instanceof PenReferenceError) {
          return json(400, { ok: false, code: error.code, error: error.message });
        }
        throw error;
      }
    } else {
      asset = await storeWebAsset({
        store: scopedDeps.store,
        rootPath: resolved.rootPath,
        kind,
        filename: upload.filename,
        buffer: upload.content,
        uploadedBy: actor,
        metadata
      });
    }
    let systemColumns: RebaseWorkbookJournalResult | null = null;
    if (kind === "excel") {
      try {
        systemColumns = await rebaseWorkbookJournal({
          store: scopedDeps.store,
          rootPath: resolved.rootPath,
          previousAssetId: previousExcelAsset?.id ?? null,
          newAssetId: asset.id,
          workbookPath: asset.storagePath,
          mode: systemColumnsMode,
          actor
        });
      } catch (error) {
        // 重播种失败不阻断上传：资产已落盘，journal 留空＝全部按人工格冻结。
        systemColumns = {
          mode: systemColumnsMode,
          rebased: 0,
          frozen: 0,
          mismatched: [],
          systemHeaders: [],
          warnings: [`系统格 journal 重播种失败：${errorMessage(error)}`]
        };
      }
    }
    await recordAuditSafe(scopedDeps.store, resolved.rootPath, {
      domain: "asset",
      action: "asset.upload",
      result: "ok",
      actor,
      summary:
        penReference === null
          ? `上传 Web 资产：${asset.kind} v${asset.version} ${asset.filename}（sha256 ${asset.sha256.slice(0, 12)}）${
              systemColumns === null
                ? ""
                : `；系统列 ${systemColumns.mode}：重播种 ${systemColumns.rebased}、冻结 ${systemColumns.frozen}`
            }`
          : `上传 .pen 参考图：${penReference.assets.length}/${penReference.screenCount} 屏（source sha256 ${penReference.sourceSha256.slice(0, 12)}）`,
      refs: {
        assetId: asset.id,
        ...(penReference === null
          ? {}
          : { assetIds: penReference.assets.map((entry) => entry.id).join(","), sourceSha256: penReference.sourceSha256 }),
        kind: asset.kind,
        filename: asset.filename,
        sha256: asset.sha256,
        version: String(asset.version),
        ...(systemColumns === null
          ? {}
          : {
              systemColumns: systemColumns.mode,
              rebased: String(systemColumns.rebased),
              frozen: String(systemColumns.frozen)
            })
      }
    });
    deps.cache?.clear();
    return json(200, {
      ok: true,
      asset,
      ...(penReference === null
        ? {}
        : {
            assets: penReference.assets,
            pen: {
              sourceSha256: penReference.sourceSha256,
              screenCount: penReference.screenCount,
              missing: penReference.missing,
              warnings: penReference.warnings
            }
          }),
      ...(systemColumns === null ? {} : { systemColumns })
    });
  } catch (error) {
    const state = webProjectStateResponse(error);
    if (state !== null) {
      await recordAuditSafe(scopedDeps.store, resolved.rootPath, {
        domain: "asset",
        action: "asset.upload",
        result: "failed",
        actor,
        summary: `上传 Web 资产失败：${upload.filename}：${errorMessage(error)}`,
        refs: { kind, filename: upload.filename }
      });
      return state;
    }
    const code = error instanceof WebAssetError ? error.code : null;
    const status =
      code === null
        ? 500
        : code === "too-large"
          ? 413
          : code === "project-root-missing"
            ? 409
            : 400;
    await recordAuditSafe(scopedDeps.store, resolved.rootPath, {
      domain: "asset",
      action: "asset.upload",
      result: "failed",
      actor,
      summary: `上传 Web 资产失败：${upload.filename}：${errorMessage(error)}`,
      refs: { kind, filename: upload.filename }
    });
    if (code === null) {
      log(`Web 资产上传失败: ${errorMessage(error)}`);
      return json(500, { ok: false, error: "资产写入失败（已写入审计；可重试或查看日志）" });
    }
    return json(status, { ok: false, error: errorMessage(error), code });
  }
}

function headerRowParam(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new ExcelMappingError("invalid-header-row", `表头行无效：${String(value)}`);
  }
  return numeric;
}

function excelMappingErrorResponse(error: unknown): PanelWebResponse | null {
  const state = webProjectStateResponse(error);
  if (state !== null) return state;
  if (error instanceof ExcelMappingError) {
    return json(400, { ok: false, error: error.message, code: error.code });
  }
  if (error instanceof ExcelMappingServiceError) {
    return json(error.status, { ok: false, error: error.message, code: error.code });
  }
  return null;
}

/** 已保存的 Excel 模板映射 → importTestDocument 的列覆盖；未保存/空映射返回 undefined（走自动识别）。 */
function importColumnsFromMapping(
  columnMap: Record<string, string> | undefined
): ImportColumns | undefined {
  if (columnMap === undefined) return undefined;
  const value = (key: string): string | undefined => {
    const raw = columnMap[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  };
  const columns: ImportColumns = {
    ...(value("name") !== undefined ? { name: value("name") } : {}),
    ...(value("steps") !== undefined ? { steps: value("steps") } : {}),
    ...(value("expected") !== undefined ? { expected: value("expected") } : {}),
    ...(value("preconditions") !== undefined ? { preconditions: value("preconditions") } : {}),
    ...(value("module") !== undefined ? { module: value("module") } : {}),
    ...(value("section") !== undefined ? { section: value("section") } : {}),
    ...(value("caseId") !== undefined ? { displayId: value("caseId") } : {}),
    ...(value("testData") !== undefined ? { testData: value("testData") } : {}),
    ...(value("wireframe") !== undefined ? { wireframe: value("wireframe") } : {}),
    ...(value("relatedTc") !== undefined ? { relatedTc: value("relatedTc") } : {})
  };
  return Object.keys(columns).length > 0 ? columns : undefined;
}

async function previewExcelMappingAction(
  deps: PanelWebDeps,
  resolved: { rootPath: string; hostId: string | null },
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const crossHost = crossHostWriteResponse(deps, resolved);
  if (crossHost !== null) return crossHost;
  const rootPath = resolved.rootPath;
  const assetId = typeof payload.assetId === "string" ? payload.assetId.trim() : "";
  const sheetName = typeof payload.sheetName === "string" ? payload.sheetName.trim() : "";
  try {
    if (assetId === "") {
      throw new ExcelMappingServiceError("missing-asset-id", "缺少 assetId（资产 id）");
    }
    const headerRow = headerRowParam(payload.headerRow);
    const preview = await previewExcelAsset({
      store: deps.store,
      rootPath,
      assetId,
      ...(sheetName === "" ? {} : { sheetName }),
      ...(headerRow === undefined ? {} : { headerRow })
    });
    return json(200, { ok: true, ...preview });
  } catch (error) {
    const response = excelMappingErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function saveExcelMappingAction(
  deps: PanelWebDeps,
  resolved: { rootPath: string; hostId: string | null },
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const crossHost = crossHostWriteResponse(deps, resolved);
  if (crossHost !== null) return crossHost;
  const rootPath = resolved.rootPath;
  const assetId = typeof payload.assetId === "string" ? payload.assetId.trim() : "";
  const sheetName = typeof payload.sheetName === "string" ? payload.sheetName.trim() : "";
  const refs = {
    assetId,
    ...(sheetName === "" ? {} : { sheetName })
  };
  try {
    if (assetId === "") {
      throw new ExcelMappingServiceError("missing-asset-id", "缺少 assetId（资产 id）");
    }
    await assertProjectActive(deps.store, rootPath);
    const headerRow = headerRowParam(payload.headerRow);
    const mapping = await saveExcelMapping({
      store: deps.store,
      rootPath,
      assetId,
      sheetName,
      ...(headerRow === undefined ? {} : { headerRow }),
      columnMap: payload.columnMap,
      createdBy: actor
    });
    await recordAuditSafe(deps.store, rootPath, {
      domain: "excel",
      action: "excel.mapping.save",
      result: "ok",
      actor,
      summary: `保存 Excel 列映射：${mapping.sheetName}（指纹 ${mapping.headerFingerprint.slice(0, 12)}）`,
      refs: { ...refs, headerFingerprint: mapping.headerFingerprint }
    });
    deps.cache?.clear();
    return json(200, { ok: true, mapping });
  } catch (error) {
    const response = excelMappingErrorResponse(error);
    if (!response) throw error;
    await recordAuditSafe(deps.store, rootPath, {
      domain: "excel",
      action: "excel.mapping.save",
      result: "failed",
      actor,
      summary: `保存 Excel 列映射失败：${errorMessage(error)}`,
      refs
    });
    return response;
  }
}

async function auditPanel(  deps: PanelWebDeps,
  rootPath: string,
  action: string,
  response: PanelWebResponse,
  refs?: Record<string, string | undefined>,
  meta?: {
    actor?: string | null;
    actorHostId?: string | null;
    channel?: string | null;
  }
): Promise<void> {
  let detail = "";
  if (response.status !== 200) {
    try {
      const raw =
        typeof response.body === "string" ? response.body : response.body.toString("utf8");
      const payload = JSON.parse(raw) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error !== "") detail = payload.error;
    } catch {
      /* 非 JSON 响应：仅保留状态码 */
    }
  }
  await recordAuditSafe(deps.store, rootPath, {
    domain: "panel",
    action,
    result: response.status === 200 ? "ok" : "failed",
    summary:
      response.status === 200
        ? `${auditActionLabel(action)}：完成`
        : `${auditActionLabel(action)}：失败（${detail === "" ? `HTTP ${response.status}` : detail}）`,
    ...(refs === undefined ? {} : { refs }),
    actor: meta?.actor ?? deps.actor ?? null,
    actorHostId: meta?.actorHostId ?? null,
    channel: meta?.channel ?? null
  });
}

const EXPECTED_OS = new Set(["darwin", "win32", "linux"]);

type RegistrationField = { ok: true; value: string | null | undefined } | { ok: false };

function registrationField(payload: Record<string, unknown>, key: string): RegistrationField {
  const raw = payload[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

async function registerHost(
  deps: PanelWebDeps,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const hostRef = typeof payload.host === "string" ? payload.host.trim() : "";
  if (hostRef === "") return json(400, { error: "缺少 host" });
  const host = await deps.store.getHost(hostRef).catch(() => null);
  if (!host) return json(404, { error: `未知主机 "${hostRef}"（先用 host list 查看已登记主机）` });

  const label = registrationField(payload, "label");
  const owner = registrationField(payload, "owner");
  const expectedHostname = registrationField(payload, "expectedHostname");
  const expectedOs = registrationField(payload, "expectedOs");
  for (const [field, value] of [
    ["label", label],
    ["owner", owner],
    ["expectedHostname", expectedHostname],
    ["expectedOs", expectedOs]
  ] as const) {
    if (!value.ok) return json(400, { error: `${field} 必须是字符串或 null` });
  }
  if (
    expectedOs.ok &&
    typeof expectedOs.value === "string" &&
    !EXPECTED_OS.has(expectedOs.value.toLowerCase())
  ) {
    return json(400, { error: "expectedOs 仅支持 darwin/win32/linux" });
  }

  const record = await deps.store.updateHostRegistration({
    id: host.id,
    ...(label.ok && label.value !== undefined ? { label: label.value } : {}),
    ...(owner.ok && owner.value !== undefined ? { owner: owner.value } : {}),
    ...(expectedHostname.ok && expectedHostname.value !== undefined
      ? { expectedHostname: expectedHostname.value }
      : {}),
    ...(expectedOs.ok && expectedOs.value !== undefined
      ? {
          expectedOs:
            expectedOs.value === null ? null : expectedOs.value.toLowerCase()
        }
      : {}),
    registeredBy: "panel"
  });
  if (!record) return json(404, { error: `未知主机 "${hostRef}"` });
  return json(200, { ok: true, host: record });
}

async function hostAuditRoot(
  deps: PanelWebDeps,
  payload: Record<string, unknown>,
  hostId: string
): Promise<string> {
  const project = typeof payload.project === "string" ? payload.project.trim() : "";
  if (project !== "") return project;
  if (hostId === "") return "";
  try {
    const projects = (await deps.store.listProjects())
      .filter((record) => record.hostId === hostId)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    return projects[0]?.rootPath ?? "";
  } catch {
    return "";
  }
}

async function checkDispatchPreviewFreshness(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse | null> {
  const previewId = typeof payload.previewId === "string" ? payload.previewId.trim() : "";
  if (previewId === "") return null;
  const mode = payload.source === "keyword" ? "keyword" : "case-set";
  const params = new URLSearchParams();
  params.set("source", mode);
  if (mode === "keyword") params.set("keyword", String(payload.keyword ?? "").trim());
  else params.set("ref", String(payload.ref ?? "").trim());
  const platforms = Array.isArray(payload.platforms)
    ? payload.platforms.filter((value): value is string => typeof value === "string")
    : [];
  params.set("platforms", platforms.join(","));
  params.set("baseline", payload.baseline === "none" ? "none" : "latest");
  if (typeof payload.appAssetId === "string" && payload.appAssetId.trim() !== "") {
    params.set("appAssetId", payload.appAssetId.trim());
  }
  if (typeof payload.materialsAssetId === "string" && payload.materialsAssetId.trim() !== "") {
    params.set("materialsAssetId", payload.materialsAssetId.trim());
  }
  if (typeof payload.appPackage === "string" && payload.appPackage.trim() !== "") {
    params.set("appPackage", payload.appPackage.trim());
  }
  params.set("skipIosInstall", payload.skipIosInstall === true ? "1" : "0");
  if (typeof payload.appVersionExpected === "string" && payload.appVersionExpected.trim() !== "") {
    params.set("appVersionExpected", payload.appVersionExpected.trim());
  }
  const host = typeof payload.host === "string" ? payload.host.trim() : "";
  if (host !== "") params.set("host", host);
  const preview = await computeDispatchPreview(
    {
      store: deps.store,
      env: deps.env ?? process.env,
      ...(deps.storeForHost ? { storeForHost: deps.storeForHost } : {})
    },
    rootPath,
    params
  );
  const expected = dispatchPreviewId(
    preview,
    dispatchFormSignature(params, preview.appPackage),
    rootPath
  );
  if (expected !== previewId) {
    return json(409, {
      ok: false,
      stale: true,
      error: "预览已过期：份/端/基线或匹配范围已变化，请刷新预览后重新确认"
    });
  }
  return null;
}

async function createTask(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>,
  resolvedHostId: string | null,
  dispatcherHostId: string | null
): Promise<PanelWebResponse> {
  const hostParam = typeof payload.host === "string" ? payload.host.trim() : "";
  const explicitHost = hostParam !== "";
  let hosts: HostRecord[] = [];
  try {
    hosts = await deps.store.listHosts();
  } catch {
    hosts = [];
  }
  if (resolvedHostId === null && hosts.length > 0 && hostParam === "") {
    const legacy = (await deps.store.listProjects().catch(() => [])).some(
      (project) => project.rootPath === rootPath && project.hostId === null
    );
    if (legacy) {
      return json(409, {
        ok: false,
        error: "该项目是未归属主机的历史数据，无法定向下发",
        reasons: [LEGACY_HOST_REASON]
      });
    }
  }
  if (hostParam === "" && hosts.length > 0) {
    return json(400, { ok: false, error: "缺少 host（已登记主机时必选）" });
  }
  const hostRef = explicitHost ? hostParam : (deps.store.localHostId ?? "");
  const targetHost =
    hostRef === "" ? null : (hosts.find((host) => host.id === hostRef) ?? null);
  if (targetHost === null && explicitHost) {
    return json(404, { error: `未知主机 "${hostRef}"（请刷新预览后重选）` });
  }
  const stalePreview = await checkDispatchPreviewFreshness(deps, rootPath, payload);
  if (stalePreview !== null) return stalePreview;
  let targetStore = deps.store;
  let taskStore = deps.store;
  let targetProject: { hostId: string | null } | null = null;
  if (targetHost !== null) {
    targetStore = hostScopedStore(deps, targetHost.id);
    targetProject = await targetStore.getProjectByPath(rootPath).catch(() => null);
    taskStore = targetStore;
    if (targetProject === null) {
      const ownerProject = await deps.store.getProjectByPath(rootPath).catch(() => null);
      let crossRootRunner = false;
      if (ownerProject !== null) {
        crossRootRunner = (await deps.store.listRunners(rootPath).catch(() => [])).some(
          (runner) => (runner.hostId ?? runner.name) === targetHost.id
        );
      }
      if (ownerProject === null || !crossRootRunner) {
        return json(404, {
          error: `主机 "${targetHost.id}" 未登记项目 "${rootPath}"：请先在目标机接入项目`
        });
      }
      targetProject = ownerProject;
      taskStore = deps.store;
    }
  }
  const sets = await taskStore.listCaseSets(rootPath);
  let refs: Array<{ caseSetId: string; featureKey: string }> = [];
  const sourceMode = payload.source;
  if (sourceMode === "case-set" || sourceMode === "keyword") {
    if (sourceMode === "case-set") {
      const refId = typeof payload.ref === "string" ? payload.ref.trim() : "";
      const set = sets.find((entry) => entry.id === refId);
      if (!set) return json(400, { error: `未知份 "${refId}"（请刷新预览后重选）` });
      refs = set.features.map((feature) => ({ caseSetId: set.id, featureKey: feature.key }));
    } else {
      const keyword = typeof payload.keyword === "string" ? payload.keyword.trim() : "";
      if (keyword === "") return json(400, { error: "keyword 为空" });
      const hits = sets.filter(
        (set) =>
          set.basename.includes(keyword) ||
          set.features.some(
            (feature) => feature.name.includes(keyword) || feature.key.includes(keyword)
          )
      );
      if (hits.length === 0) return json(400, { error: `关键词「${keyword}」未匹配到份` });
      refs = hits.flatMap((set) =>
        set.features.map((feature) => ({ caseSetId: set.id, featureKey: feature.key }))
      );
    }
    if (refs.length === 0) return json(400, { error: "解析后 refs 为空（份无功能段？）" });
    if (refs.length > MAX_REFS) return json(400, { error: `refs 数量超过上限 ${MAX_REFS}` });
  } else {
    const rawRefs = Array.isArray(payload.refs) ? payload.refs : [];
    for (const entry of rawRefs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as { caseSetId?: unknown; featureKey?: unknown };
      if (typeof record.caseSetId !== "string" || record.caseSetId === "") continue;
      if (typeof record.featureKey !== "string" || record.featureKey === "") continue;
      refs.push({ caseSetId: record.caseSetId, featureKey: record.featureKey });
    }
    if (refs.length === 0) return json(400, { error: "refs 为空或格式非法" });
    if (refs.length > MAX_REFS) return json(400, { error: `refs 数量超过上限 ${MAX_REFS}` });

    const known = new Set(
      sets.flatMap((set) => set.features.map((feature) => `${set.id}|${feature.key}`))
    );
    const unknown = refs.filter((ref) => !known.has(`${ref.caseSetId}|${ref.featureKey}`));
    if (unknown.length > 0) {
      return json(400, {
        error: `未知用例集：${unknown.map((ref) => ref.featureKey).join("、")}（先重新生成/登记用例集）`
      });
    }
  }

  const rawPlatforms = Array.isArray(payload.platforms) ? payload.platforms : undefined;
  const platforms = rawPlatforms === undefined ? ["ios", "android"] : rawPlatforms;
  if (
    platforms.length === 0 ||
    platforms.some((platform) => typeof platform !== "string" || !PLATFORMS.has(platform))
  ) {
    return json(400, { error: "platforms 仅支持 ios/android" });
  }
  const uniquePlatforms = [...new Set(platforms as string[])];
  if (
    payload.baseline !== undefined &&
    payload.baseline !== "latest" &&
    payload.baseline !== "none"
  ) {
    return json(400, { error: "baseline 仅支持 latest/none" });
  }
  const baseline = payload.baseline === "none" ? "none" : "latest";
  const priority = taskPriority(payload.priority);
  if (priority === null) {
    return json(400, { error: "优先级须为 0–100 的整数（priority）" });
  }
  const rawAppPackage =
    typeof payload.appPackage === "string" ? payload.appPackage.trim() : "";
  let appPackage: string | null = null;
  if (rawAppPackage !== "") {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(rawAppPackage)) {
      return json(400, { error: "appPackage 格式非法（示例：com.example.app）" });
    }
    appPackage = rawAppPackage;
  }
  const caseIds = Array.isArray(payload.caseIds)
    ? payload.caseIds
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .map((value) => value.trim())
    : [];
  const rawAppAssetId =
    typeof payload.appAssetId === "string" ? payload.appAssetId.trim() : "";
  let appAssetId: string | null = null;
  let appAssetFilename: string | null = null;
  if (rawAppAssetId !== "") {
    const asset = await taskStore.getWebAsset(rootPath, rawAppAssetId).catch(() => null);
    if (asset === null || asset.kind !== "package" || asset.archivedAt) {
      return json(400, { error: `未知安装包资产 "${rawAppAssetId}"（请刷新预览后重选）` });
    }
    const lower = asset.filename.toLowerCase();
    if (lower.endsWith(".apk") && !uniquePlatforms.includes("android")) {
      return json(400, { error: "所选 APK 与目标端不匹配：需要勾选 Android" });
    }
    if (lower.endsWith(".ipa") && !uniquePlatforms.includes("ios")) {
      return json(400, { error: "所选 IPA 与目标端不匹配：需要勾选 iOS" });
    }
    try {
      const derived = await inferAppIdFromPackage(
        await readFile(asset.storagePath),
        asset.filename
      );
      if (derived !== null) appPackage = derived;
    } catch {
      /* 读不到安装包时保留手填值/空；执行机会沿用设备当前应用 */
    }
    appAssetId = rawAppAssetId;
    appAssetFilename = asset.filename;
  }
  const skipIosInstall = payload.skipIosInstall === true;
  const iosInstalledConfirmed = payload.iosInstalledConfirmed === true;
  const appVersionExpected =
    typeof payload.appVersionExpected === "string" ? payload.appVersionExpected.trim() : null;
  // 面板表单总会显式发送 skipIosInstall；旧 API/legacy 调用不发送，保留“设备已安装”兼容行为。
  if (
    typeof payload.skipIosInstall === "boolean" &&
    uniquePlatforms.includes("ios") &&
    appAssetId === null &&
    !skipIosInstall
  ) {
    return json(400, {
      error:
        "iOS 任务未选择 IPA：请选择 IPA，或勾选「不下发 iOS 安装包」并确认设备已通过 TestFlight 安装"
    });
  }
  const installPlan = resolveAppInstallPlan({
    platforms: uniquePlatforms,
    appAssetFilename,
    appPackage,
    skipIosInstall,
    iosInstallConfirmed: iosInstalledConfirmed,
    appVersionExpected
  });
  if (!installPlan.ok) return json(400, { error: installPlan.error });
  const installWarnings = installPlan.plan.warnings;
  const rawMaterialsAssetId =
    typeof payload.materialsAssetId === "string" ? payload.materialsAssetId.trim() : "";
  let materialsAssetId: string | null = null;
  if (rawMaterialsAssetId !== "") {
    const asset = await taskStore.getWebAsset(rootPath, rawMaterialsAssetId).catch(() => null);
    if (asset === null || asset.kind !== "materials" || asset.archivedAt) {
      return json(400, { error: `未知测试资料资产 "${rawMaterialsAssetId}"（请刷新预览后重选）` });
    }
    if (asset.metadata?.secret !== true) {
      return json(400, {
        error: `测试资料 "${asset.filename}" 未标记 secret：套件回归只支持 secret 资料占位符，请勾选 secret 后重新上传`
      });
    }
    materialsAssetId = rawMaterialsAssetId;
  }

  let warnings: string[] = [...installWarnings];
  if (targetHost !== null) {
    const precheck = precheckTask(
      {
        id: targetHost.id,
        kind: targetHost.kind,
        osPlatform: targetHost.osPlatform,
        capabilities: targetHost.capabilities,
        online: isHostOnline(targetHost, deps.now?.() ?? Date.now(), deps.env ?? process.env)
      },
      uniquePlatforms
    );
    if (!precheck.ok) {
      return json(400, {
        ok: false,
        error: "目标主机无法满足所需平台",
        reasons: precheck.reasons
      });
    }
    warnings = [...installWarnings, ...precheck.reasons];
  }

  const targetHostId =
    targetHost?.id ??
    targetProject?.hostId ??
    (explicitHost ? null : (deps.store.localHostId ?? null));
  const task = await taskStore.createRegressionTask({
    rootPath,
    refs,
    platforms: uniquePlatforms,
    baseline,
    createdBy: "panel",
    targetHostId,
    createdHostId: dispatcherHostId,
    priority,
    appAssetId,
    appPackage,
    appInstallMode: installPlan.plan.appInstallMode,
    appVersionExpected: installPlan.plan.appVersionExpected,
    appVersionCheck: installPlan.plan.appVersionCheck,
    materialsAssetId,
    caseIds
  });
  return json(200, { ok: true, task, ...(warnings.length > 0 ? { warnings } : {}) });
}

function panelTextField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function panelStringList(raw: unknown): string[] {
  const out: string[] = [];
  const push = (entry: unknown): void => {
    if (typeof entry !== "string") return;
    const trimmed = entry.trim();
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) push(entry);
    return out;
  }
  if (typeof raw === "string") {
    for (const entry of raw.split(",")) push(entry);
  }
  return out;
}

type PanelWebJobAssignment = {
  assignment: "auto" | "manual";
  devicePinned: boolean;
  targetHostId: string | null;
  deviceSerial: string | null;
};

type PanelWebJobParse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

function parseWebJobAssignmentFields(
  payload: Record<string, unknown>
): PanelWebJobParse<PanelWebJobAssignment> {
  const raw = panelTextField(payload, "assignment");
  if (raw !== "" && raw !== "auto" && raw !== "manual") {
    return {
      ok: false,
      code: "invalid-assignment",
      error: `assignment 仅支持 auto/manual（当前 ${raw}）`
    };
  }
  if (raw !== "manual") {
    return {
      ok: true,
      value: { assignment: "auto", devicePinned: false, targetHostId: null, deviceSerial: null }
    };
  }
  const targetHostId = panelTextField(payload, "targetHostId");
  if (targetHostId === "") {
    return {
      ok: false,
      code: "manual-requires-host",
      error: "manual 下发必须指定 targetHostId（执行机主机）"
    };
  }
  const serial = panelTextField(payload, "deviceSerial");
  return {
    ok: true,
    value: {
      assignment: "manual",
      devicePinned: serial !== "",
      targetHostId,
      deviceSerial: serial === "" ? null : serial
    }
  };
}

function parseWebJobRequirements(
  payload: Record<string, unknown>
): PanelWebJobParse<WebDispatchRequirements> {
  const raw = payload.requirements;
  const record =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const platform = record === null ? payload.platform : record.platform;
  if (platform !== "android" && platform !== "ios") {
    return { ok: false, error: `requirements.platform 仅支持 android/ios（当前 ${String(platform)}）` };
  }
  const kindRaw = (record === null ? payload.deviceKind : record.deviceKind) ?? "any";
  const deviceKind =
    kindRaw === "device" || kindRaw === "simulator"
      ? kindRaw
      : kindRaw === "any" || kindRaw === ""
        ? "any"
        : null;
  if (deviceKind === null) {
    return { ok: false, error: "requirements.deviceKind 仅支持 device/simulator/any" };
  }
  const deviceModel = panelStringList(record === null ? payload.deviceModel : record.deviceModel);
  const osRaw = record === null ? null : record.osVersion;
  const osRecord =
    osRaw !== null && typeof osRaw === "object" && !Array.isArray(osRaw)
      ? (osRaw as Record<string, unknown>)
      : null;
  const minRaw = osRecord?.min ?? (record === null ? payload.osMin : record.osMin);
  const maxRaw = osRecord?.max ?? (record === null ? payload.osMax : record.osMax);
  const min = typeof minRaw === "string" ? minRaw.trim() : "";
  const max = typeof maxRaw === "string" ? maxRaw.trim() : "";
  const parsedMin = min === "" ? null : parseOsVersion(min);
  const parsedMax = max === "" ? null : parseOsVersion(max);
  if (min !== "" && parsedMin === null) {
    return { ok: false, error: `requirements.osVersion.min 非法：${min}` };
  }
  if (max !== "" && parsedMax === null) {
    return { ok: false, error: `requirements.osVersion.max 非法：${max}` };
  }
  if (parsedMin !== null && parsedMax !== null && compareOsVersions(parsedMin, parsedMax) > 0) {
    return {
      ok: false,
      error: `requirements.osVersion 下界 ${min} 大于上界 ${max}`
    };
  }
  const tools = panelStringList(record === null ? payload.tools : record.tools);
  return {
    ok: true,
    value: {
      platform,
      deviceKind,
      ...(deviceModel.length === 0 ? {} : { deviceModel }),
      ...(min === "" && max === ""
        ? {}
        : { osVersion: { ...(min === "" ? {} : { min }), ...(max === "" ? {} : { max }) } }),
      ...(tools.length === 0 ? {} : { tools: tools as WebToolName[] })
    }
  };
}

interface PanelWebJobCreateInput extends PanelWebJobAssignment {
  requirements: WebDispatchRequirements;
  executionMode: WebJobExecutionMode;
  caseFilter: { modules: string[]; caseIds: string[] };
  excelAssetId: string;
  packageAssetId: string;
  materialsAssetId: string | null;
  referenceAssetId: string | null;
  referenceGate: "off" | "report" | "unverified";
  l2Screenshots: boolean;
  scriptSetId: string | null;
  retry: number;
  priority: number;
  allowStaleScript: boolean;
  allowPartialUnresolved: boolean;
  allowUnverified: boolean;
}

function parseWebJobCreateForm(
  payload: Record<string, unknown>
): PanelWebJobParse<PanelWebJobCreateInput> {
  const assignment = parseWebJobAssignmentFields(payload);
  if (assignment.ok === false) return assignment;
  const requirements = parseWebJobRequirements(payload);
  if (requirements.ok === false) return requirements;

  const modeRaw = panelTextField(payload, "executionMode");
  const executionMode = modeRaw === "" ? "maestro" : modeRaw;
  if (executionMode !== "maestro" && executionMode !== "llm") {
    return { ok: false, error: `executionMode 仅支持 maestro/llm（当前 ${modeRaw}）` };
  }
  const excelAssetId = panelTextField(payload, "excelAssetId");
  if (excelAssetId === "") return { ok: false, error: "缺少 excelAssetId（Excel 用例资产）" };
  const packageAssetId = panelTextField(payload, "packageAssetId");
  if (packageAssetId === "") return { ok: false, error: "缺少 packageAssetId（安装包资产）" };

  const caseFilter = normalizeCaseFilter(
    payload.caseFilter ?? {
      modules: panelStringList(payload.caseModules),
      caseIds: panelStringList(payload.caseIds)
    }
  );
  const rawRetry = payload.retry;
  let retry = 0;
  if (rawRetry !== undefined && rawRetry !== null && rawRetry !== "") {
    const numeric =
      typeof rawRetry === "number"
        ? rawRetry
        : typeof rawRetry === "string"
          ? Number(rawRetry.trim())
          : Number.NaN;
    if (!Number.isInteger(numeric) || numeric < 0) {
      return { ok: false, error: "retry 须为 ≥0 的整数" };
    }
    retry = numeric;
  }
  const priority = taskPriority(payload.priority);
  if (priority === null) {
    return { ok: false, error: "优先级须为 0–100 的整数（priority）" };
  }
  const materialsAssetId = panelTextField(payload, "materialsAssetId");
  const referenceAssetId = panelTextField(payload, "referenceAssetId");
  const referenceGateRaw = panelTextField(payload, "referenceGate");
  const referenceGate =
    referenceGateRaw === "off" || referenceGateRaw === "unverified"
      ? referenceGateRaw
      : "report";
  const l2Screenshots =
    payload.l2Screenshots === true || payload.l2Screenshots === "true";
  const scriptSetId = panelTextField(payload, "scriptSetId");
  const allowStaleScript =
    payload.allowStaleScript === true || payload.allowStaleScript === "true";
  const allowPartialUnresolved = !(
    payload.allowPartialUnresolved === false || payload.allowPartialUnresolved === "false"
  );
  const allowUnverified =
    payload.allowUnverified === true || payload.allowUnverified === "true";
  return {
    ok: true,
    value: {
      ...assignment.value,
      requirements: requirements.value,
      executionMode,
      caseFilter,
      excelAssetId,
      packageAssetId,
      materialsAssetId: materialsAssetId === "" ? null : materialsAssetId,
      referenceAssetId: referenceAssetId === "" ? null : referenceAssetId,
      referenceGate,
      l2Screenshots,
      scriptSetId: scriptSetId === "" ? null : scriptSetId,
      retry,
      priority,
      allowStaleScript,
      allowPartialUnresolved,
      allowUnverified
    }
  };
}

async function createWebJobAction(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>,
  actor: string
): Promise<PanelWebResponse> {
  const parsed = parseWebJobCreateForm(payload);
  if (parsed.ok === false) {
    return json(400, {
      ok: false,
      ...(parsed.code === undefined ? {} : { code: parsed.code }),
      error: parsed.error
    });
  }
  const input = parsed.value;
  try {
    const outcome = await createWebJob({
      store: deps.store,
      env: deps.env ?? process.env,
      rootPath,
      assignment: input.assignment,
      devicePinned: input.devicePinned,
      targetHostId: input.targetHostId,
      deviceSerial: input.deviceSerial,
      requirements: input.requirements,
      excelAssetId: input.excelAssetId,
      packageAssetId: input.packageAssetId,
      materialsAssetId: input.materialsAssetId,
      referenceAssetId: input.referenceAssetId,
      referenceGate: input.referenceGate,
      l2Screenshots: input.l2Screenshots,
      scriptSetId: input.scriptSetId,
      executionMode: input.executionMode,
      caseFilter: input.caseFilter,
      retry: input.retry,
      priority: input.priority,
      allowStaleScript: input.allowStaleScript,
      allowPartialUnresolved: input.allowPartialUnresolved,
      allowUnverified: input.allowUnverified,
      createdBy: actor,
      nowMs: deps.now?.() ?? Date.now()
    });
    const binding = outcome.assignment;
    if (
      outcome.script !== null &&
      (outcome.script.autoGenerated || outcome.script.rebuiltFrom !== null)
    ) {
      const trigger = outcome.script.rebuiltFrom !== null ? "rebuild" : "dispatch";
      await recordAuditSafe(deps.store, rootPath, {
        domain: "web",
        action: "web.scripts.generate",
        result: "ok",
        actor,
        summary: `下发时生成 Web 脚本集（trigger=${trigger}）：可执行 ${outcome.script.runnable}（完整 ${outcome.script.ready} / 部分 ${outcome.script.partial}）/ 未就绪 ${outcome.script.unresolved}`,
        refs: {
          assetId: outcome.script.id,
          ...(outcome.script.rebuiltFrom === null
            ? {}
            : { from: outcome.script.rebuiltFrom })
        }
      });
    }
    const scriptWarning =
      outcome.script !== null && outcome.script.unresolved > 0
        ? `；${outcome.script.unresolved} 条未就绪将 SKIP`
        : "";
    const workerOffline = outcome.warnings.includes("llm-worker-offline")
      ? "；中心 LLM Worker 未在线（任务会等待）"
      : "";
    const noExpectation = outcome.warnings.includes("llm-no-expectation")
      ? "；Excel 没有预期列，LLM 结果将全部 UNVERIFIED"
      : "";
    return json(200, {
      ok: true,
      job: outcome.task,
      assignment: binding,
      pendingReason: outcome.pendingReason,
      status: binding === null ? "pending" : "bound",
      script: outcome.script,
      autoGeneratedScript: outcome.script?.autoGenerated === true,
      ...(outcome.script !== null && outcome.script.rebuiltFrom !== null
        ? {
            rebuiltScriptSet: {
              from: outcome.script.rebuiltFrom,
              to: outcome.script.id
            }
          }
        : {}),
      warnings: outcome.warnings,
      message:
        (binding === null
          ? "等待满足要求的执行机"
          : `已绑定 ${binding.hostId} / ${binding.deviceSerial}`) +
        (outcome.script?.autoGenerated === true
          ? "；已自动生成脚本集"
          : outcome.script?.rebuiltFrom !== null && outcome.script !== null
            ? "；脚本集已按当前资产重建"
            : "") +
        scriptWarning +
        workerOffline +
        noExpectation
    });
  } catch (error) {
    const generationFailure =
      error instanceof WebJobDispatchError &&
      (error.code === "script-generation-failed" ||
        error.code === "script-generation-timeout" ||
        error.code === "script-set-rebuild-failed");
    if (generationFailure) {
      await recordAuditSafe(deps.store, rootPath, {
        domain: "web",
        action: "web.scripts.generate",
        result: "failed",
        actor,
        summary: `下发时生成 Web 脚本集失败：${errorMessage(error)}`
      });
    } else if (!(error instanceof WebJobDispatchError)) {
      await recordAuditSafe(deps.store, rootPath, {
        domain: "web",
        action: "action.jobs",
        result: "failed",
        actor,
        summary: `下发任务异常：${errorMessage(error)}`
      });
    }
    if (error instanceof WebJobDispatchError) {
      return json(error.status, { ok: false, code: error.code, error: error.message });
    }
    throw error;
  }
}

/** 只读选机预览：与下发同源（`selectWebAssignment`），不建任务、不占租约、不回传任何 runner 令牌。 */
async function previewWebJobAction(
  deps: PanelWebDeps,
  request: PanelActionRequest
): Promise<PanelWebResponse> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(405, { ok: false, error: "method not allowed (GET)" });
  }
  const params = request.url.searchParams;
  const flat: Record<string, unknown> = {};
  for (const key of [
    "project",
    "host",
    "assignment",
    "targetHostId",
    "deviceSerial",
    "platform",
    "deviceKind",
    "osMin",
    "osMax"
  ]) {
    const value = params.get(key);
    if (value !== null) flat[key] = value;
  }
  for (const key of ["deviceModel", "tools"]) {
    const values = params.getAll(key);
    if (values.length === 1) flat[key] = values[0];
    else if (values.length > 1) flat[key] = values;
  }
  const projectKey = typeof flat.project === "string" ? flat.project.trim() : "";
  if (projectKey === "") return json(400, { ok: false, error: "缺少 project" });
  const hostParam = typeof flat.host === "string" ? flat.host.trim() : "";
  let resolved: { rootPath: string; name: string; hostId: string | null } | null;
  try {
    resolved = await resolveProjectKey(deps, projectKey, hostParam === "" ? undefined : hostParam);
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return json(409, { ok: false, error: error.message });
    }
    throw error;
  }
  if (resolved === null) return json(404, { ok: false, error: `未知项目 "${projectKey}"` });
  const assignment = parseWebJobAssignmentFields(flat);
  if (assignment.ok === false) return json(400, { ok: false, error: assignment.error });
  const requirements = parseWebJobRequirements(flat);
  if (requirements.ok === false) return json(400, { ok: false, error: requirements.error });
  const store =
    resolved.hostId === null
      ? deps.store
      : (deps.storeForHost?.(resolved.hostId) ?? deps.store);
  const [runners, leases] = await Promise.all([
    store.listWebRunners().catch(() => []),
    store.listDeviceLeases().catch(() => [])
  ]);
  const selection = selectWebAssignment({
    runners: runners.map((runner) => ({
      id: runner.id,
      hostId: runner.hostId,
      hostname: runner.hostname,
      platforms: runner.platforms,
      devices: runner.devices,
      tools: runner.tools,
      lastSeenAt: runner.lastSeenAt
    })),
    leases,
    request: { ...assignment.value, requirements: requirements.value },
    nowMs: deps.now?.() ?? Date.now(),
    runnerTtlMs: runnerTtlFrom(deps.env ?? process.env)
  });
  if (!selection.ok) {
    return json(200, {
      ok: true,
      project: resolved.rootPath,
      selection: null,
      code: selection.code,
      message: selection.message
    });
  }
  return json(200, {
    ok: true,
    project: resolved.rootPath,
    selection: {
      hostId: selection.hostId,
      deviceSerial: selection.deviceSerial,
      score: selection.score,
      reasons: selection.reasons
    }
  });
}

/** 只读过滤预览：dry-run 生成（不写资产），返回匹配数与未就绪计数。 */
async function saveVerdicts(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const verdict = payload.verdict;
  if (typeof verdict !== "string" || !CASE_VERDICTS.has(verdict as CaseVerdict)) {
    return json(400, {
      error: "verdict 仅支持 case-defect/execution-deviation/app-defect/uncertain"
    });
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: Array<{ runId: string; caseId: string }> = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { runId?: unknown; caseId?: unknown };
    if (typeof record.runId !== "string" || typeof record.caseId !== "string") continue;
    items.push({ runId: record.runId, caseId: record.caseId });
  }
  if (items.length === 0) return json(400, { error: "items 为空或格式非法" });
  if (items.length > MAX_VERDICT_ITEMS) {
    return json(400, { error: `items 数量超过上限 ${MAX_VERDICT_ITEMS}` });
  }
  const note =
    typeof payload.note === "string" && payload.note.trim() !== "" ? payload.note.trim() : null;
  const by =
    typeof payload.by === "string" && payload.by.trim() !== "" ? payload.by.trim() : "panel";

  let updated = 0;
  let failed = 0;
  let lastError: string | null = null;
  for (const item of items) {
    try {
      const ok = await deps.store.updateCaseVerdict({
        rootPath,
        runId: item.runId,
        caseId: item.caseId,
        verdict: verdict as CaseVerdict,
        verdictBy: by,
        verdictNote: note
      });
      if (ok) updated += 1;
    } catch (error) {
      failed += 1;
      lastError = errorMessage(error);
    }
  }
  deps.cache?.clear();
  if (updated === 0 && failed > 0) {
    log(`裁决写入失败: ${lastError ?? "unknown"}`);
    return json(500, {
      ok: false,
      error: "裁决写入失败",
      updated,
      failed,
      missed: items.length - updated - failed
    });
  }
  if (updated === 0) {
    return json(400, {
      ok: false,
      error: "未命中任何用例（run/case 不存在）",
      updated,
      missed: items.length
    });
  }
  return json(200, {
    ok: true,
    updated,
    missed: items.length - updated - failed,
    ...(failed > 0 ? { failed } : {})
  });
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  return value.trim() === "" ? undefined : value.trim();
}

async function createIssues(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: Array<{ runId: string; caseId: string }> = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { runId?: unknown; caseId?: unknown };
    if (typeof record.runId !== "string" || record.runId.trim() === "") continue;
    if (typeof record.caseId !== "string" || record.caseId.trim() === "") continue;
    items.push({ runId: record.runId.trim(), caseId: record.caseId.trim() });
  }
  if (items.length === 0) return json(400, { error: "items 为空或格式非法" });
  if (items.length > MAX_ISSUE_ITEMS) {
    return json(400, { error: `items 数量超过上限 ${MAX_ISSUE_ITEMS}` });
  }

  const projectKey = optionalString(payload.projectKey);
  if (projectKey === null) return json(400, { error: "projectKey 必须是字符串" });
  const issueType = optionalString(payload.issueType);
  if (issueType === null) return json(400, { error: "issueType 必须是字符串" });
  const summary = optionalString(payload.summary);
  if (summary === null) return json(400, { error: "summary 必须是字符串" });

  let labels: string[] | undefined;
  if (payload.labels !== undefined) {
    if (typeof payload.labels !== "string" && !Array.isArray(payload.labels)) {
      return json(400, { error: "labels 必须是字符串或字符串数组" });
    }
    if (
      Array.isArray(payload.labels) &&
      !payload.labels.every((entry) => typeof entry === "string" && entry.trim() !== "")
    ) {
      return json(400, { error: "labels 必须是字符串数组（非空元素）" });
    }
    labels = normalizeLabels(payload.labels as string | string[]);
  }

  let dryRun: boolean | undefined;
  if (payload.dryRun !== undefined) {
    if (typeof payload.dryRun !== "boolean") return json(400, { error: "dryRun 必须是布尔值" });
    dryRun = payload.dryRun;
  }

  const previewId = optionalString(payload.previewId);
  if (previewId === null) return json(400, { error: "previewId 必须是字符串" });

  const outcome = await createRunCaseIssues(
    { store: deps.store, runtimeFor: deps.runtimeFor },
    { rootPath, items, projectKey, issueType, labels, summary, dryRun, previewId }
  );
  if (!outcome.ok) return json(outcome.stale === true ? 409 : 400, outcome);
  if (outcome.created + outcome.existing > 0) deps.cache?.clear();
  return json(200, outcome);
}

async function cancelTask(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>,
  hostId: string | null,
  actor: string
): Promise<PanelWebResponse> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  if (taskId === "") return json(400, { error: "缺少 taskId" });
  const note = typeof payload.note === "string" && payload.note.trim() !== "" ? payload.note.trim() : null;
  const task = await deps.store.cancelRegressionTask({
    rootPath,
    taskId,
    source: "panel",
    actor,
    actorHostId: hostId,
    note
  });
  if (!task) return json(404, { error: `未知任务 "${taskId}"` });
  deps.cache?.clear();
  const noteText =
    task.status === "stopping"
      ? "已请求取消：执行机将在当前用例边界停止并确认（离线时为下次心跳读取）"
      : task.status === "cancelled"
        ? "任务已取消"
        : `任务状态为 ${task.status}，未改动`;
  return json(200, { ok: true, taskId, status: task.status, note: noteText, task });
}

async function releaseTask(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  if (taskId === "") return json(400, { error: "缺少 taskId" });
  const task = await deps.store.getRegressionTask(rootPath, taskId);
  if (!task) return json(404, { error: `未知任务 "${taskId}"` });
  if (task.status === "stopping") {
    return json(409, {
      error: "任务正在停止：等待执行机确认（离线时为下次心跳读取），确认后方可释放"
    });
  }
  if (task.status === "cancelled") {
    return json(409, { error: "任务已取消（终态），不释放、不重置" });
  }
  if (task.status === "completed" || task.status === "failed") {
    return json(400, { error: `任务已终态（${task.status}），无需释放` });
  }
  const ok = await deps.store.updateRegressionTask(rootPath, taskId, {
    status: "pending",
    claimedBy: null,
    claimedAt: null,
    expectStatuses: ["claimed", "running"]
  });
  if (!ok) {
    const fresh = await deps.store.getRegressionTask(rootPath, taskId);
    if (!fresh) return json(404, { error: `未知任务 "${taskId}"` });
    if (fresh.status === "cancelled") {
      return json(409, { ok: false, error: "任务已取消（终态），不释放、不重置" });
    }
    return json(409, {
      ok: false,
      error: `任务状态已变化（当前 ${fresh.status}），未释放`
    });
  }
  deps.cache?.clear();
  const reloaded = await deps.store.getRegressionTask(rootPath, taskId);
  return json(200, { ok: true, taskId, status: "pending", task: reloaded });
}

async function stopTask(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>,
  hostId: string | null,
  actor: string
): Promise<PanelWebResponse> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  if (taskId === "") return json(400, { error: "缺少 taskId" });
  const task = await deps.store.getRegressionTask(rootPath, taskId);
  if (!task) return json(404, { error: `未知任务 "${taskId}"` });
  if (task.status !== "claimed" && task.status !== "running" && task.status !== "stopping") {
    return json(400, { error: `仅已领取/执行中任务可停止（当前 ${task.status}）` });
  }
  if (task.status === "stopping") {
    return json(200, { ok: true, taskId, status: "stopping", note: "停止请求已存在，等待执行机确认" });
  }
  const updated = await deps.store.cancelRegressionTask({
    rootPath,
    taskId,
    source: "panel",
    actor,
    actorHostId: hostId,
    note: null
  });
  if (!updated) return json(500, { ok: false, error: "停止请求失败" });
  deps.cache?.clear();
  return json(200, {
    ok: true,
    taskId,
    status: updated.status,
    note: "已请求停止：执行机将在当前用例边界停止并确认（离线时为下次心跳读取）"
  });
}

async function configureProject(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const runtime = deps.runtimeFor ? await deps.runtimeFor(rootPath) : null;
  if (runtime === null) {
    return json(400, { error: "配置写入需要服务端运行态（HTTP 模式）；请用 MCP 的 aos_configure 或编辑项目 .env" });
  }
  const text = (key: string): string => (typeof payload[key] === "string" ? payload[key].trim() : "");
  const model = text("model");
  const baseUrl = text("baseUrl");
  const apiKey = text("apiKey");
  const name = text("name");
  const vendor = text("vendor");
  const figmaToken = text("figmaToken");
  const jiraSite = text("jiraSite");
  const jiraEmail = text("jiraEmail");
  const jiraApiToken = text("jiraApiToken");
  const hasLlm = model !== "" || baseUrl !== "" || apiKey !== "" || name !== "" || vendor !== "";
  const jiraProvided = jiraSite !== "" || jiraEmail !== "" || jiraApiToken !== "";
  if (jiraProvided && (jiraSite === "" || jiraEmail === "" || jiraApiToken === "")) {
    return json(400, { error: "Jira 配置需要同时提供站点 URL、邮箱和 API token" });
  }
  if (!hasLlm && figmaToken === "" && !jiraProvided) {
    return json(400, { error: "没有可写入的配置项" });
  }
  if (hasLlm) {
    const active = apiKey === "" ? await runtime.activeEntry() : null;
    const effectiveKey = apiKey !== "" ? apiKey : (active?.apiKey ?? "");
    if (effectiveKey === "") {
      return json(400, { error: "缺少 apiKey（项目尚无可用 LLM key；首次配置必须填写）" });
    }
    const result = await aosConfigure(runtime, {
      ...(model === "" ? {} : { model }),
      ...(baseUrl === "" ? {} : { baseUrl }),
      apiKey: effectiveKey,
      ...(name === "" ? {} : { name }),
      ...(vendor === "" ? {} : { vendor }),
      ...(figmaToken === "" ? {} : { figmaToken }),
      ...(jiraProvided ? { jiraSite, jiraEmail, jiraApiToken } : {})
    });
    const body = result.content[0];
    const parsed = body && body.type === "text" ? JSON.parse(body.text) : { ok: result.isError !== true };
    return result.isError === true ? json(400, parsed) : json(200, parsed);
  }
  const updates: Record<string, string> = {};
  if (figmaToken !== "") updates.FIGMA_ACCESS_TOKEN = figmaToken;
  if (jiraProvided) {
    updates.JIRA_BASE_URL = jiraSite;
    updates.JIRA_EMAIL = jiraEmail;
    updates.JIRA_API_TOKEN = jiraApiToken;
  }
  const envPath = writeEnvUpdates(rootPath, updates);
  if (figmaToken !== "") {
    await runtime.store.setFigmaToken(rootPath, figmaToken);
    syncFigmaTokenEnv(figmaToken);
  }
  runtime.refreshProjectEnv();
  return json(200, {
    ok: true,
    envPath,
    figma: figmaToken === "" ? null : maskSecret(figmaToken),
    jira: jiraProvided ? { site: jiraSite, email: jiraEmail } : null
  });
}

async function rerunTask(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  if (taskId === "") return json(400, { error: "缺少 taskId" });
  const task = await deps.store.getRegressionTask(rootPath, taskId);
  if (!task) return json(404, { error: `未知任务 "${taskId}"` });
  if (task.status === "claimed" || task.status === "running") {
    return json(409, { error: "任务正在执行：请先「停止执行」，再重新派发" });
  }
  let caseIds: string[] = [];
  if (payload.failedOnly === true) {
    const runs = await deps.store
      .listSuiteRuns(rootPath, { taskId: task.id, limit: 100 })
      .catch(() => []);
    const seen = new Set<string>();
    for (const run of runs) {
      for (const entry of run.cases) {
        if (entry.status === "failed") seen.add(entry.caseId);
      }
    }
    caseIds = [...seen];
    if (caseIds.length === 0) {
      return json(400, { error: "该任务没有失败用例可重跑" });
    }
  }
  const created = await deps.store.createRegressionTask({
    rootPath,
    refs: task.refs,
    platforms: [...task.platforms],
    baseline: task.baseline,
    createdBy: "panel",
    targetHostId: task.targetHostId,
    createdHostId: task.createdHostId,
    priority: task.priority,
    appAssetId: task.appAssetId,
    appPackage: task.appPackage,
    materialsAssetId: task.materialsAssetId,
    caseIds
  });
  deps.cache?.clear();
  return json(200, { ok: true, task: created, sourceTaskId: task.id });
}

async function manageSchedules(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const action = payload.action;
  if (action === "create") {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name === "") return json(400, { error: "缺少 name" });
    const featureKeys = Array.isArray(payload.featureKeys)
      ? payload.featureKeys
          .filter((key): key is string => typeof key === "string" && key.trim() !== "")
          .map((key) => key.trim())
      : [];
    if (featureKeys.length === 0) return json(400, { error: "featureKeys 为空" });
    const platformsRaw = Array.isArray(payload.platforms) ? payload.platforms : [];
    const platforms = [
      ...new Set(platformsRaw.filter((p): p is string => typeof p === "string" && PLATFORMS.has(p)))
    ];
    if (platforms.length === 0) return json(400, { error: "platforms 仅支持 ios/android" });
    const everyMinutes =
      typeof payload.everyMinutes === "number" ? Math.floor(payload.everyMinutes) : Number.NaN;
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) {
      return json(400, { error: "everyMinutes 须为正整数" });
    }
    if (
      payload.baseline !== undefined &&
      payload.baseline !== "latest" &&
      payload.baseline !== "none"
    ) {
      return json(400, { error: "baseline 仅支持 latest/none" });
    }
    try {
      const schedule = await deps.store.createSchedule({
        rootPath,
        name,
        featureKeys,
        platforms,
        baseline: payload.baseline === "none" ? "none" : "latest",
        everyMinutes,
        createdBy: "console"
      });
      deps.cache?.clear();
      return json(200, { ok: true, schedule });
    } catch (error) {
      return json(400, { error: errorMessage(error) });
    }
  }

  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (id === "") return json(400, { error: "缺少 id" });
  if (action === "enable" || action === "disable") {
    const updated = await deps.store.updateSchedule(rootPath, id, { enabled: action === "enable" });
    if (!updated) return json(404, { error: `未知计划 "${id}"` });
    deps.cache?.clear();
    return json(200, { ok: true, id, enabled: action === "enable" });
  }
  if (action === "delete") {
    const deleted = await deps.store.deleteSchedule(rootPath, id);
    if (!deleted) return json(404, { error: `未知计划 "${id}"` });
    deps.cache?.clear();
    return json(200, { ok: true, id, deleted: true });
  }
  return json(400, { error: "action 仅支持 create/enable/disable/delete" });
}

async function manageQuarantine(
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const action = payload.action;
  if (action !== "add" && action !== "remove") {
    return json(400, { error: "action 仅支持 add/remove" });
  }
  const caseId = typeof payload.caseId === "string" ? payload.caseId.trim() : "";
  if (caseId === "") return json(400, { error: "缺少 caseId" });

  const file = path.join(rootPath, ".artemis", "design", "quarantine.json");
  let entries: Array<Record<string, unknown>> = [];
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) {
      return json(400, { error: "quarantine.json 缺少 entries 数组（先修复文件）" });
    }
    entries = parsed.entries.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return json(400, { error: `quarantine.json 不可读或非法：${errorMessage(error)}` });
    }
  }

  if (action === "add") {
    const owner = typeof payload.owner === "string" ? payload.owner.trim() : "";
    if (owner === "") return json(400, { error: "add 需要 owner（签字）" });
    const until =
      typeof payload.until === "string" && payload.until.trim() !== "" ? payload.until.trim() : null;
    if (until !== null && Number.isNaN(Date.parse(until))) {
      return json(400, { error: "until 须为可解析的 ISO 时间" });
    }
    const reason =
      typeof payload.reason === "string" && payload.reason.trim() !== ""
        ? payload.reason.trim()
        : null;
    entries = entries.filter((entry) => entry.caseId !== caseId);
    entries.push({ caseId, reason, owner, signedAt: new Date().toISOString(), expiresAt: until });
  } else {
    const before = entries.length;
    entries = entries.filter((entry) => entry.caseId !== caseId);
    if (entries.length === before) return json(404, { error: `quarantine 中不存在 "${caseId}"` });
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify({ entries }, null, 2)}\n`);
  return json(200, { ok: true, action, caseId, count: entries.length });
}

async function runExport(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const whatRaw = payload.what;
  if (whatRaw !== "results" && whatRaw !== "process" && whatRaw !== "data") {
    return json(400, { error: "what 仅支持 results/process/data" });
  }
  const formatRaw = payload.format === undefined ? "json" : payload.format;
  if (formatRaw !== "json" && formatRaw !== "csv") {
    return json(400, { error: "format 仅支持 json/csv" });
  }
  const since =
    typeof payload.since === "string" && payload.since.trim() !== ""
      ? payload.since.trim()
      : undefined;
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    return json(400, { error: "since 须为可解析的 ISO 时间" });
  }
  let limit: number | undefined;
  if (payload.limit !== undefined) {
    const parsed =
      typeof payload.limit === "number"
        ? Math.floor(payload.limit)
        : Number.parseInt(String(payload.limit), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return json(400, { error: "limit 须为正整数" });
    limit = parsed;
  }
  const result = await exportProjectData(rootPath, deps.store, {
    what: whatRaw as ExportWhat,
    format: formatRaw,
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit })
  });
  return { status: 200, contentType: result.contentType, body: result.content };
}

let importInFlight = false;

function uploadTimestamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours()
  )}${pad(now.getMinutes())}`;
}

function safeUploadBase(filename: string): string {
  const parsed = path.parse(filename).name.trim();
  const cleaned = parsed.replace(/[/\\:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "upload" : cleaned;
}

async function designImportPreflight(
  runtime: Runtime,
  excelPath: string,
  columns: ImportColumns | undefined
): Promise<{ hasWireframe: boolean; indexKind: "flows" | "ui-contract" | null }> {
  let hasWireframe = columns?.wireframe !== undefined;
  if (!hasWireframe) {
    const buffer = await readFile(excelPath).catch(() => null);
    const isCsv = path.extname(excelPath).toLowerCase() === ".csv";
    const headers =
      buffer === null
        ? null
        : await readExcelHeaders(buffer, isCsv ? { format: "csv" } : {}).catch(() => null);
    if (headers !== null) {
      hasWireframe = suggestExcelMapping(headers.headers).wireframe !== undefined;
    }
  }
  const designDir = path.join(runtime.configDirAbs, "design");
  const flows = path.join(designDir, "flows.json");
  const contract = path.join(designDir, "ui-contract.json");
  const exists = async (target: string): Promise<boolean> =>
    stat(target)
      .then((info) => info.isFile())
      .catch(() => false);
  const indexKind = (await exists(flows))
    ? "flows"
    : (await exists(contract))
      ? "ui-contract"
      : null;
  return { hasWireframe, indexKind };
}

async function runDesignImport(
  runtime: Runtime,
  excelPath: string,
  sourceName: string | undefined,
  columns: ImportColumns | undefined,
  apply: boolean
): Promise<PanelWebResponse> {
  const preflight = await designImportPreflight(runtime, excelPath, columns);
  const baseDesign = {
    hasWireframe: preflight.hasWireframe,
    indexKind: preflight.indexKind
  };
  if (!preflight.hasWireframe) {
    return json(200, {
      ok: true,
      mode: "design-preview",
      design: {
        ...baseDesign,
        available: false,
        reason: "no-wireframe",
        message: "Excel 没有 Wireframe/设计引用列；设计增强不适用，可直接普通导入。"
      }
    });
  }
  if (preflight.indexKind === null) {
    return json(200, {
      ok: true,
      mode: "design-preview",
      design: {
        ...baseDesign,
        available: false,
        reason: "design-index-missing",
        message:
          "未找到 .artemis/design/flows.json 或 ui-contract.json；设计增强需要先生成设计索引（Figma/pen 提取），或选择普通导入。"
      }
    });
  }
  const result = await designAssistedImport(runtime, {
    excelPath,
    ...(sourceName === undefined ? {} : { sourceName }),
    ...(columns === undefined
      ? {}
      : { columns: columns as unknown as Record<string, string> }),
    save: apply,
    apply
  });
  if (!result.ok) {
    const needs = result.needs === "info";
    return json(needs ? 409 : 400, {
      ok: false,
      ...(needs
        ? {
            needs: "info",
            category: result.category,
            questions: result.questions,
            context: result.context
          }
        : {}),
      error: result.error,
      ...(result.report === undefined ? {} : { report: result.report }),
      design: { ...baseDesign, available: true }
    });
  }
  return json(200, {
    ok: true,
    mode: apply ? "design-apply" : "design-preview",
    design: { ...baseDesign, available: true, report: result.report },
    ...(result.apply === undefined ? {} : { apply: result.apply }),
    ...(result.needsInfo === undefined ? {} : { needsInfo: result.needsInfo })
  });
}

async function executeDesignSource(
  store: ProjectStore,
  runtime: Runtime,
  rootPath: string,
  excelPath: string,
  sourceName: string | undefined,
  columns: ImportColumns | undefined,
  payload: Record<string, unknown>,
  designExtract: PanelWebDeps["designExtract"]
): Promise<PanelWebResponse> {
  const source =
    payload.source === "pen" ? "pen" : payload.source === "figma" ? "figma" : null;
  if (source === null) {
    return json(400, { error: "source 仅支持 figma / pen" });
  }
  let toolName: string;
  let args: Record<string, unknown>;
  if (source === "figma") {
    const url = typeof payload.figmaUrl === "string" ? payload.figmaUrl.trim() : "";
    if (url === "") return json(400, { error: "请填写 Figma URL" });
    const nodeId = typeof payload.nodeId === "string" ? payload.nodeId.trim() : "";
    toolName = "figma_extract_flows";
    args = { url, ...(nodeId === "" ? {} : { nodeId }), save: true, screens: false };
  } else {
    const penAssetId =
      typeof payload.penAssetId === "string" ? payload.penAssetId.trim() : "";
    if (penAssetId === "") return json(400, { error: "请选择 .pen 文件" });
    const assets = await store.listWebAssets(rootPath, "reference").catch(() => []);
    const asset = assets.find((entry) => entry.id === penAssetId);
    if (asset === undefined || !asset.filename.toLowerCase().endsWith(".pen")) {
      return json(404, { error: "未找到 .pen 参考资产" });
    }
    toolName = "pen_extract_flows";
    args = { path: asset.storagePath, save: true, screens: false, vision: false };
  }

  let result: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  try {
    if (source === "figma") {
      const figmaToken =
        (runtime.project.dotenvValues?.FIGMA_ACCESS_TOKEN ?? "").trim() ||
        (process.env.FIGMA_ACCESS_TOKEN ?? "").trim() ||
        null;
      result = designExtract?.figma
        ? await designExtract.figma(runtime, args)
        : await figmaExtractFlows(runtime, args as unknown as ExtractFlowsArgs, {
            figmaToken
          });
    } else {
      result = designExtract?.pen
        ? await designExtract.pen(runtime, args)
        : await penExtractFlows(runtime, args as unknown as PenExtractFlowsArgs);
    }
  } catch (error) {
    return json(400, { ok: false, error: `设计提取失败：${errorMessage(error)}` });
  }
  const text = (result.content ?? [])
    .filter(
      (entry): entry is { type: "text"; text: string } =>
        entry.type === "text" && typeof entry.text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    /* non-JSON tool output is handled below */
  }
  if (result.isError === true || parsed?.ok === false) {
    return json(400, {
      ok: false,
      error:
        typeof parsed?.error === "string" && parsed.error !== ""
          ? parsed.error
          : text || `${toolName} 失败`
    });
  }
  return await runDesignImport(runtime, excelPath, sourceName, columns, false);
}

type DesignJobStatus = "running" | "completed" | "failed";

interface DesignJob {
  id: string;
  rootPath: string;
  source: "figma" | "pen";
  status: DesignJobStatus;
  startedAt: string;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

const DESIGN_JOB_TTL_MS = 30 * 60 * 1000;
const DESIGN_JOB_MAX = 20;
const designJobs = new Map<string, DesignJob>();
const designJobByRoot = new Map<string, string>();

function sweepDesignJobs(nowMs = Date.now()): void {
  for (const [id, job] of designJobs) {
    if (job.finishedAt === null) continue;
    if (nowMs - Date.parse(job.finishedAt) > DESIGN_JOB_TTL_MS) {
      designJobs.delete(id);
      if (designJobByRoot.get(job.rootPath) === id) designJobByRoot.delete(job.rootPath);
    }
  }
}

function responseJson(response: PanelWebResponse): Record<string, unknown> {
  const text =
    typeof response.body === "string" ? response.body : response.body.toString("utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* non-JSON response is preserved below */
  }
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    body: text.slice(0, 2000)
  };
}

function designJobPayload(job: DesignJob): Record<string, unknown> {
  return {
    id: job.id,
    source: job.source,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    ...(job.result === null ? {} : { result: job.result })
  };
}

function runDesignSource(
  store: ProjectStore,
  runtime: Runtime,
  rootPath: string,
  excelPath: string,
  sourceName: string | undefined,
  columns: ImportColumns | undefined,
  payload: Record<string, unknown>,
  designExtract: PanelWebDeps["designExtract"]
): PanelWebResponse {
  sweepDesignJobs();
  const existingId = designJobByRoot.get(rootPath);
  const existing = existingId === undefined ? undefined : designJobs.get(existingId);
  if (existing?.status === "running") {
    return json(409, { error: "已有设计提取在进行", jobId: existing.id });
  }
  if (designJobs.size >= DESIGN_JOB_MAX) {
    const stale = [...designJobs.values()]
      .filter((job) => job.status !== "running")
      .sort((left, right) => (left.finishedAt ?? "").localeCompare(right.finishedAt ?? ""))[0];
    if (stale !== undefined) designJobs.delete(stale.id);
  }
  const source = payload.source === "pen" ? "pen" : "figma";
  const job: DesignJob = {
    id: `design-${Date.now()}-${randomUUID().slice(0, 8)}`,
    rootPath,
    source,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null
  };
  designJobs.set(job.id, job);
  designJobByRoot.set(rootPath, job.id);
  void (async () => {
    try {
      const response = await executeDesignSource(
        store,
        runtime,
        rootPath,
        excelPath,
        sourceName,
        columns,
        payload,
        designExtract
      );
      job.result = responseJson(response);
      job.status = job.result.ok === false ? "failed" : "completed";
    } catch (error) {
      job.status = "failed";
      job.error = errorMessage(error);
    } finally {
      job.finishedAt = new Date().toISOString();
      if (designJobByRoot.get(rootPath) === job.id) designJobByRoot.delete(rootPath);
    }
  })();
  return json(202, { ok: true, jobId: job.id, status: "running" });
}

function designJobStatusResponse(jobId: string): PanelWebResponse {
  const job = designJobs.get(jobId);
  if (job === undefined) return json(404, { error: "未知设计提取任务" });
  return json(200, { ok: true, job: designJobPayload(job) });
}

async function runFigmaList(
  runtime: Runtime,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const url = typeof payload.figmaUrl === "string" ? payload.figmaUrl.trim() : "";
  if (url === "") return json(400, { error: "请填写 Figma URL" });
  const token =
    (runtime.project.dotenvValues?.FIGMA_ACCESS_TOKEN ?? "").trim() ||
    (process.env.FIGMA_ACCESS_TOKEN ?? "").trim() ||
    null;
  const inventory = await listFigmaFrames({ url, token });
  if (!inventory.ok) return json(400, { ok: false, error: inventory.error });
  return json(200, { ok: true, mode: "design-figma-list", inventory });
}

async function runImport(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>,
  request: PanelActionRequest,
  hostId: string | null
): Promise<PanelWebResponse> {
  if (importInFlight) return json(409, { error: "已有导入在进行（单飞）" });
  if (
    hostId !== null &&
    deps.localHostId !== undefined &&
    deps.localHostId !== null &&
    hostId !== deps.localHostId
  ) {
    return json(400, {
      error: "跨主机导入请在该项目机上执行，或使用 HTTP 模式"
    });
  }
  importInFlight = true;
  let tmpPath: string | null = null;
  let tmpDir: string | null = null;
  let columns: ImportColumns | undefined;
  try {
    let excelPath: string;
    let sourceName: string | undefined;
    const assetId = typeof payload.assetId === "string" ? payload.assetId.trim() : "";
    if (assetId !== "") {
      const assets = await deps.store.listWebAssets(rootPath, "excel").catch(() => []);
      const asset = assets.find((entry) => entry.id === assetId);
      if (!asset) return json(404, { error: "Excel 资产不存在" });
      excelPath = asset.storagePath;
      sourceName = asset.filename;
      const mappings = await deps.store
        .listExcelMappings(rootPath, assetId)
        .catch(() => []);
      const latest = [...mappings].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )[0];
      columns = importColumnsFromMapping(latest?.columnMap);
      if (columns === undefined) {
        // 同一模板的新资产：按工作表+表头兼容性复用本项目已保存的映射。
        const buffer = await readFile(asset.storagePath).catch(() => null);
        const headerInfo =
          buffer === null ? null : await readExcelHeaders(buffer).catch(() => null);
        if (headerInfo !== null) {
          const normalized = new Set(headerInfo.headers.map(normalizeExcelHeader));
          const compatible = (await deps.store.listExcelMappings(rootPath).catch(() => []))
            .filter((mapping) => mapping.sheetName === headerInfo.sheetName)
            .filter((mapping) =>
              Object.values(mapping.columnMap).every((header) =>
                normalized.has(normalizeExcelHeader(header))
              )
            )
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
          columns = importColumnsFromMapping(compatible?.columnMap);
        }
      }
    } else if (request.rawBody !== undefined) {
      const upload = await parseMultipartUpload(request.rawBody, request.contentType);
      tmpDir = await mkdtemp(path.join(tmpdir(), "aos-import-"));
      tmpPath = path.join(tmpDir, `${safeUploadBase(upload.filename)}_${uploadTimestamp()}.xlsx`);
      await writeFile(tmpPath, upload.content);
      excelPath = tmpPath;
    } else {
      const pathValue = typeof payload.path === "string" ? payload.path.trim() : "";
      if (pathValue === "") return json(400, { error: "缺少 path、assetId 或上传文件" });
      if (!pathValue.toLowerCase().endsWith(".xlsx")) return json(400, { error: "仅支持 .xlsx" });
      excelPath = pathValue;
    }
    const runtime = deps.runtimeFor ? await deps.runtimeFor(rootPath) : null;
    if (!runtime) {
      return json(400, {
        error: "导入需要运行时解析（项目运行时不可用；可改用 CLI：suite task create --excel <file>）"
      });
    }
    const mode = typeof payload.mode === "string" ? payload.mode.trim() : "plain";
    if (mode === "design-source-status") {
      const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
      if (jobId === "") return json(400, { error: "缺少 jobId" });
      return designJobStatusResponse(jobId);
    }
    if (mode === "design-figma-list") {
      if (assetId === "") {
        return json(400, { error: "设计清单需要先上传 Excel 资产（assetId）" });
      }
      return await runFigmaList(runtime, payload);
    }
    if (mode === "design-source") {
      if (assetId === "") {
        return json(400, { error: "设计提取需要先上传 Excel 资产（assetId）" });
      }
      return await runDesignSource(
        deps.store,
        runtime,
        rootPath,
        excelPath,
        sourceName,
        columns,
        payload,
        deps.designExtract
      );
    }
    if (mode === "design-preview" || mode === "design-apply") {
      if (assetId === "") {
        return json(400, { error: "设计增强导入需要先上传 Excel 资产（assetId）" });
      }
      return await runDesignImport(
        runtime,
        excelPath,
        sourceName,
        columns,
        mode === "design-apply"
      );
    }
    const result = await importTestDocument(runtime, {
      excelPath,
      ...(sourceName === undefined ? {} : { sourceName }),
      ...(columns === undefined ? {} : { columns })
    });
    if (!result.ok) return json(400, { ok: false, error: result.error ?? "导入失败" });
    return json(200, {
      ok: true,
      sourceId: result.sourceId,
      caseCount: result.sets.reduce((sum, set) => sum + set.caseCount, 0),
      features: result.sets.map((set) => set.feature),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      ...(result.design !== undefined ? { design: result.design } : {})
    });
  } catch (error) {
    if (error instanceof UploadError) return json(error.status, { error: error.message });
    throw error;
  } finally {
    if (tmpPath !== null) {
      try {
        await rm(tmpPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    if (tmpDir !== null) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    importInFlight = false;
  }
}
