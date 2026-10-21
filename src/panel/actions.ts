import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AmbiguousProjectError } from "../db/types.js";
import type { CaseVerdict, HostRecord } from "../db/types.js";
import { recordAuditSafe } from "../db/audit-event.js";
import { resolveHostReference } from "../center/store.js";
import { LEGACY_HOST_REASON } from "../host/legacy.js";
import { exportProjectData, type ExportWhat } from "../export/index.js";
import { errorMessage, log, writeFileAtomic } from "../util.js";
import { importTestDocument } from "../workflow/excel-import.js";
import { createRunCaseIssues, MAX_ISSUE_ITEMS, normalizeLabels, retryIssueEvidence } from "./issues.js";
import { sameOriginAllowed } from "./http-guard.js";
import { parseMultipartUpload, UploadError } from "./upload.js";
import {
  computeDispatchPreview,
  dispatchFormSignature,
  dispatchPreviewId,
  hostScopedStore,
  isHostOnline,
  precheckTask
} from "../console/dispatch.js";
import { auditActionLabel } from "../console/vocab.js";
import { resolveProjectKey, type PanelWebDeps, type PanelWebResponse } from "./web.js";

/** 面板动作层（DESIGN：回归服务 §5.4）：HTTP 模式接线；独立进程需 `AOS_PANEL_ACTIONS=1`＋loopback。
 * 写请求加同源校验（CSRF 纵深防御）；`AOS_PANEL_ACTIONS=0` 整体关闭。body 为已解析 JSON。 */
export interface PanelActionRequest {
  method: string;
  url: URL;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  contentType?: string;
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
  const isExportDownload =
    request.method === "GET" && request.url.pathname === "/panel/api/export";
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
      { actor: "panel", actorHostId: resolvedHostId, channel: "panel" }
    );
    if (response.status === 200) deps.cache?.clear();
    return response;
  }
  const projectKey =
    (typeof payload.project === "string" ? payload.project.trim() : "") ||
    (request.url.searchParams.get("project") ?? "").trim();
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
  const scopedDeps: PanelWebDeps =
    resolved.hostId === null
      ? deps
      : { ...deps, store: deps.storeForHost?.(resolved.hostId) ?? deps.store };

  try {
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
      const response = await cancelTask(scopedDeps, resolved.rootPath, payload, resolved.hostId);
      await auditPanel(
        scopedDeps,
        resolved.rootPath,
        "action.tasks.cancel",
        response,
        {
          taskId: String(payload.taskId ?? ""),
          ...(resolved.hostId === null ? {} : { hostId: resolved.hostId })
        },
        { actor: "panel", actorHostId: resolved.hostId, channel: "panel" }
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
      const response = await stopTask(scopedDeps, resolved.rootPath, payload, resolved.hostId);
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
      const response = await runImport(scopedDeps, resolved.rootPath, payload, request);
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
      summary: `面板动作异常：${errorMessage(error)}`
    });
    return json(500, { ok: false, error: "服务内部错误（已写入审计；可重试或查看日志）" });
  }
}

async function auditPanel(
  deps: PanelWebDeps,
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
    ...(meta === undefined
      ? {}
      : {
          actor: meta.actor ?? null,
          actorHostId: meta.actorHostId ?? null,
          channel: meta.channel ?? null
        })
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
  const expected = dispatchPreviewId(preview, dispatchFormSignature(params));
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
  if (resolvedHostId === null && hosts.length > 0) {
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
  let targetProject: { hostId: string | null } | null = null;
  if (targetHost !== null) {
    targetStore = hostScopedStore(deps, targetHost.id);
    targetProject = await targetStore.getProjectByPath(rootPath).catch(() => null);
    if (!targetProject) {
      return json(404, {
        error: `主机 "${targetHost.id}" 未登记项目 "${rootPath}"：请先在目标机接入项目`
      });
    }
  }
  const sets = await targetStore.listCaseSets(rootPath);
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
        error: `未知引用份：${unknown.map((ref) => ref.featureKey).join("、")}（先重新生成/登记用例集）`
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

  let warnings: string[] = [];
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
    warnings = precheck.reasons;
  }

  const targetHostId =
    targetHost?.id ??
    targetProject?.hostId ??
    (explicitHost ? null : (deps.store.localHostId ?? null));
  const task = await targetStore.createRegressionTask({
    rootPath,
    refs,
    platforms: uniquePlatforms,
    baseline,
    createdBy: "panel",
    targetHostId,
    createdHostId: dispatcherHostId,
    priority
  });
  return json(200, { ok: true, task, ...(warnings.length > 0 ? { warnings } : {}) });
}

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
  hostId: string | null
): Promise<PanelWebResponse> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  if (taskId === "") return json(400, { error: "缺少 taskId" });
  const note = typeof payload.note === "string" && payload.note.trim() !== "" ? payload.note.trim() : null;
  const task = await deps.store.cancelRegressionTask({
    rootPath,
    taskId,
    source: "panel",
    actor: "panel",
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
  hostId: string | null
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
    actor: "panel",
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
  const created = await deps.store.createRegressionTask({
    rootPath,
    refs: task.refs,
    platforms: [...task.platforms],
    baseline: task.baseline,
    createdBy: "panel",
    targetHostId: task.targetHostId,
    createdHostId: task.createdHostId,
    priority: task.priority
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

async function runImport(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>,
  request: PanelActionRequest
): Promise<PanelWebResponse> {
  if (importInFlight) return json(409, { error: "已有导入在进行（单飞）" });
  importInFlight = true;
  let tmpPath: string | null = null;
  try {
    let excelPath: string;
    if (request.rawBody !== undefined) {
      const upload = await parseMultipartUpload(request.rawBody, request.contentType);
      const hash = createHash("sha256").update(upload.content).digest("hex").slice(0, 12);
      tmpPath = path.join(tmpdir(), `aos-upload-${hash}.xlsx`);
      await writeFile(tmpPath, upload.content);
      excelPath = tmpPath;
    } else {
      const pathValue = typeof payload.path === "string" ? payload.path.trim() : "";
      if (pathValue === "") return json(400, { error: "缺少 path 或上传文件" });
      if (!pathValue.toLowerCase().endsWith(".xlsx")) return json(400, { error: "仅支持 .xlsx" });
      excelPath = pathValue;
    }
    const runtime = deps.runtimeFor ? await deps.runtimeFor(rootPath) : null;
    if (!runtime) {
      return json(400, {
        error: "导入需要运行时解析（HTTP 模式自带；独立面板请用 CLI：suite task create --excel <file>）"
      });
    }
    const result = await importTestDocument(runtime, { excelPath });
    if (!result.ok) return json(400, { ok: false, error: result.error ?? "导入失败" });
    return json(200, {
      ok: true,
      sourceId: result.sourceId,
      caseCount: result.sets.reduce((sum, set) => sum + set.caseCount, 0),
      features: result.sets.map((set) => set.feature)
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
    importInFlight = false;
  }
}
