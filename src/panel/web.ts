import fs from "node:fs";
import path from "node:path";

import { AmbiguousProjectError } from "../db/types.js";
import type { HostRecord, ProjectRecord, ProjectStore, RunnerTools } from "../db/types.js";
import { formatBytes } from "../figma/retention.js";
import type { Runtime } from "../runtime.js";
import type { VerdictEnvironmentGroup } from "../tasks/verdict-exits.js";
import { escapeHtml } from "../util.js";
import { renderConsoleShell, renderGroupTabs, setConsoleShellDefaults, type ConsoleCapabilities, type ConsoleNavKey, type ConsoleShellInput } from "../console/shell.js";
import { INTEGRATION_ACTIONS, INTEGRATION_LABELS } from "../figma/integration-readiness.js";
import {
  computeDispatchPreview,
  dispatchFormSignature,
  dispatchPreviewId,
  hostScopedStore,
  renderDispatchPage,
  type DispatchPreview
} from "../console/dispatch.js";
import {
  readQuarantineSummary,
  renderArchivePage,
  renderAuditPage,
  renderEventsPage,
  renderLibraryPage,
  renderOpsPage,
  renderSearchPage,
  type LibraryPageData,
  type SearchPageData
} from "../console/pages.js";
import { listArtifacts, type ArtifactRecord } from "../artifacts/index.js";
import type { AuditEventRecord, CaseSetRecord, ProjectEventRecord } from "../db/types.js";
import { cBadge, cCard, cEmpty, cStat, cTable } from "../console/components.js";
import { relativeTime, relativeTimeText } from "../console/time.js";
import {
  confidenceLabel,
  failureDomainHtml,
  failureDomainLabel,
  runStatusLabel,
  sourceHtml,
  verdictLabel
} from "../console/vocab.js";
import { storeKindLabel } from "../db/labels.js";
import type { WarningSummary } from "../design/warnings.js";
import {
  buildPanelBatchDetail,
  buildPanelOverview,
  buildPanelProjectDetail,
  buildPanelReviewQueue,
  buildPanelStatsView,
  buildPanelTaskDetail,
  hostDisplayLabel,
  PANEL_BATCH_LIMIT_DEFAULT,
  PANEL_BATCH_LIMIT_MAX,
  panelProjectExcluded,
  type PanelBatchDetail,
  type PanelBatchRow,
  type PanelBatchSummary,
  type PanelDeps,
  type PanelImprovementItem,
  type PanelOverview,
  type PanelProjectDetail,
  type PanelProjectRow,
  type PanelReviewItem,
  type PanelStandaloneRow,
  type PanelStatsView,
  type PanelTaskDetail
} from "./overview.js";
import { PANEL_IOS_PROBE_TTL_MS, type PanelDeepProbe } from "./deep.js";
import {
  buildPanelCompare,
  PANEL_COMPARE_RUNNER_LIMIT,
  PANEL_COMPARE_TASK_LIMIT,
  PANEL_COMPARE_TREND_LIMIT,
  type PanelCompareProject,
  type PanelCompareView
} from "./compare.js";

/** 总览面板 Web 处理（overview-panel T3/T4，DESIGN §13.97/§13.98）：
 * 服务端渲染 HTML（内联 CSS、零依赖）+ 同源 JSON；只读、默认 loopback；
 * 进程内短缓存（TTL 默认 5s，`AOS_PANEL_CACHE_MS` 可配）；`AOS_PANEL_WEB=0` 关闭。 */

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const PROJECT_KEY_RE = /^[A-Za-z0-9._-]+$/;

export const PANEL_CACHE_TTL_DEFAULT_MS = 5_000;

export interface PanelWebDeps {
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string | null;
  serviceRepo?: string;
  buildStale?: boolean | null;
  now?: () => number;
  cache?: PanelWebCache | null;
  /** 深探层（HTTP 模式注入；懒建 Runtime 纯读子集）。 */
  deep?: PanelDeepProbe | null;
  /** 面板建单动作的运行时解析（HTTP 模式注入 deepRuntimeFor）。 */
  runtimeFor?: (rootPath: string) => Promise<Runtime | null>;
  /** 面板进程本机主机身份（用于拒绝跨主机项目导入；缺省不校验）。 */
  localHostId?: string | null;
  /** 存储回退说明（装配期 reason；运维页展示）。 */
  storeNote?: string | null;
  /** 主机作用域存储视图（跨主机同路径解析用）；未提供时回退 `deps.store`。 */
  storeForHost?: (hostId: string) => ProjectStore | null;
  /** 能力标记（承载模式/写动作/统计页）；缺省按 HTTP 全开渲染。 */
  capabilities?: ConsoleCapabilities;
  /** 当前请求身份名（HTTP 认证用户）；缺省审计记 panel。 */
  actor?: string;
}

export interface PanelWebResponse {
  status: number;
  contentType: string;
  body: string | Buffer;
}

export interface PanelWebCache {
  get(key: string): PanelWebResponse | undefined;
  set(key: string, response: PanelWebResponse): void;
  /** 动作层写后失效：POST 成功后 reload 立即看到新状态。 */
  clear(): void;
}

export function createPanelWebCache(ttlMs: number, now: () => number = Date.now): PanelWebCache {
  const entries = new Map<string, { at: number; response: PanelWebResponse }>();
  return {
    get(key: string): PanelWebResponse | undefined {
      if (!(ttlMs > 0)) return undefined;
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.response;
    },
    set(key: string, response: PanelWebResponse): void {
      if (!(ttlMs > 0)) return;
      entries.set(key, { at: now(), response });
    },
    clear(): void {
      entries.clear();
    }
  };
}

export function panelWebEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_PANEL_WEB;
  return typeof raw !== "string" || raw.trim() !== "0";
}

export function panelCacheTtlFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.AOS_PANEL_CACHE_MS?.trim();
  if (!raw) return PANEL_CACHE_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : PANEL_CACHE_TTL_DEFAULT_MS;
}

type PanelView =
  | { kind: "overview"; overview: PanelOverview }
  | { kind: "compare"; compare: PanelCompareView }
  | {
      kind: "dispatch";
      rootPath: string;
      hostId: string | null;
      legacyHostless: boolean;
      rootLabel: string;
      preview: DispatchPreview;
      previewId: string;
      formSignature: string;
      query: Record<string, string>;
    }
  | {
      kind: "library";
      rootPath: string;
      hostId: string | null;
      rootLabel: string;
      sets: CaseSetRecord[];
      quarantine: LibraryPageData["quarantine"];
      caseCandidates: LibraryPageData["caseCandidates"];
    }
  | {
      kind: "archive";
      rootPath: string;
      hostId: string | null;
      rootLabel: string;
      artifacts: ArtifactRecord[];
      query: Record<string, string>;
      page: { offset: number; hasNext: boolean; pageSize: number };
    }
  | {
      kind: "audit";
      rootPath: string;
      hostId: string | null;
      rootLabel: string;
      events: AuditEventRecord[];
      query: Record<string, string>;
      page: { offset: number; hasNext: boolean; pageSize: number };
    }
  | {
      kind: "ops";
      rootPath: string;
      hostId: string | null;
      rootLabel: string;
      storeKind: ProjectStore["kind"];
      storeNote: string | null;
      writeError: string | null;
      artifacts: number;
    }
  | {
      kind: "events";
      rootPath: string;
      hostId: string | null;
      rootLabel: string;
      events: ProjectEventRecord[];
      query: Record<string, string>;
      includePayload: boolean;
      error: string | null;
    }
  | { kind: "project"; rootPath: string; hostId: string | null; detail: PanelProjectDetail; active?: ConsoleNavKey | null }
  | { kind: "search"; data: SearchPageData }
  | { kind: "task"; rootPath: string; hostId: string | null; detail: PanelTaskDetail; flash?: string }
  | { kind: "review"; rootPath: string; hostId: string | null; detail: { items: PanelReviewItem[]; warnings: string[] } }
  | { kind: "stats"; rootPath: string; hostId: string | null; detail: PanelStatsView }
  | { kind: "batch"; rootPath: string; hostId: string | null; detail: PanelBatchDetail };

class PanelNotFoundError extends Error {}

function notFound(message = "not found", asJson = false): PanelWebResponse {
  if (asJson) {
    return { status: 404, contentType: JSON_CONTENT_TYPE, body: JSON.stringify({ error: message }) };
  }
  const html = renderConsoleShell({
    title: "未找到",
    active: null,
    body: [
      "<h1>未找到</h1>",
      `<p>${escapeHtml(message)}</p>`,
      '<p><a class="c-button c-button-primary" href="/panel">← 多项目总览</a></p>'
    ].join("\n")
  });
  return { status: 404, contentType: HTML_CONTENT_TYPE, body: html };
}

function ambiguousProjectResponse(error: AmbiguousProjectError, asJson: boolean): PanelWebResponse {
  if (asJson) {
    return {
      status: 409,
      contentType: JSON_CONTENT_TYPE,
      body: JSON.stringify(
        {
          error: error.message,
          candidates: error.candidates.map((candidate) => ({
            hostId: candidate.hostId,
            rootPath: candidate.rootPath,
            name: candidate.name
          }))
        },
        null,
        2
      )
    };
  }
  const html = renderConsoleShell({
    title: "项目歧义",
    active: null,
    body: [
      "<h1>项目路径跨主机重复</h1>",
      `<p>${escapeHtml(error.message)}</p>`,
      "<ul>",
      ...error.candidates.map(
        (candidate) =>
          `<li><code>${escapeHtml(candidate.hostId ?? "（无主机）")}</code> · ${escapeHtml(
            candidate.name
          )}（${escapeHtml(candidate.rootPath)}）</li>`
      ),
      "</ul>",
      "<p>请用 <code>?host=&lt;machine_id&gt;</code> 指定主机。</p>"
    ].join("\n")
  });
  return { status: 409, contentType: HTML_CONTENT_TYPE, body: html };
}

function normalizeSince(raw: string | null): string | null {
  if (raw === null) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return raw;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

function trimmed(value: string | null): string | null {
  if (value === null) return null;
  const out = value.trim();
  return out === "" ? null : out;
}

function intParam(params: URLSearchParams, key: string): number | null {
  const raw = trimmed(params.get(key));
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

export async function resolveProjectKey(
  deps: PanelWebDeps,
  key: string,
  hostId?: string
): Promise<{ rootPath: string; name: string; hostId: string | null } | null> {
  let projects: ProjectRecord[] = [];
  try {
    projects = await deps.store.listProjects();
  } catch {
    projects = [];
  }

  const explicitHost =
    typeof hostId === "string" && hostId.trim() !== "" ? hostId.trim() : null;
  const localHost = explicitHost ?? deps.store.localHostId;

  // 主机作用域解析优先（显式 host，或本机 host）。
  if (localHost !== null) {
    const scoped = deps.storeForHost?.(localHost) ?? deps.store;
    const byPath = await scoped.getProjectByPath(key).catch(() => null);
    if (byPath) return { rootPath: byPath.rootPath, name: byPath.name, hostId: byPath.hostId };
    const byName = projects.find(
      (project) =>
        project.hostId === localHost && project.name === key && fs.existsSync(project.rootPath)
    );
    if (byName) return { rootPath: byName.rootPath, name: byName.name, hostId: byName.hostId };
    if (explicitHost !== null) {
      const workspace = resolveWorkspaceKey(deps, key);
      return workspace ? { ...workspace, hostId: explicitHost } : null;
    }
  }

  // 无 host：跨主机唯一匹配（路径优先，再工作区目录，再名称）；多行歧义即抛错，不取其一。
  const byPath = projects.filter((project) => project.rootPath === key);
  if (byPath.length === 1) {
    const project = byPath[0]!;
    return { rootPath: project.rootPath, name: project.name, hostId: project.hostId };
  }
  if (byPath.length > 1) throw new AmbiguousProjectError(key, byPath);

  const workspace = resolveWorkspaceKey(deps, key);
  if (workspace) return { ...workspace, hostId: null };

  const byName = projects.filter(
    (project) => project.name === key && fs.existsSync(project.rootPath)
  );
  if (byName.length === 1) {
    const project = byName[0]!;
    return { rootPath: project.rootPath, name: project.name, hostId: project.hostId };
  }
  if (byName.length > 1) throw new AmbiguousProjectError(key, byName);
  return null;
}

function resolveWorkspaceKey(
  deps: PanelWebDeps,
  key: string
): { rootPath: string; name: string } | null {
  if (deps.workspaceRoot !== null && path.isAbsolute(key)) {
    const candidate = path.resolve(key);
    const within = candidate === deps.workspaceRoot || candidate.startsWith(deps.workspaceRoot + path.sep);
    if (within) {
      try {
        if (fs.statSync(candidate).isDirectory()) {
          return { rootPath: candidate, name: path.basename(candidate) };
        }
      } catch {
        /* fall through */
      }
    }
  }
  if (deps.workspaceRoot && PROJECT_KEY_RE.test(key) && key !== "." && key !== "..") {
    const rootPath = path.join(deps.workspaceRoot, key);
    try {
      if (fs.statSync(rootPath).isDirectory()) return { rootPath, name: key };
    } catch {
      /* fall through */
    }
  }
  return null;
}

async function buildView(url: URL, deps: PanelWebDeps): Promise<PanelView> {
  let projectKey = trimmed(url.searchParams.get("project"));
  const hostParam = trimmed(url.searchParams.get("host"));
  const sectionParam = trimmed(url.searchParams.get("section"));
  if (sectionParam === "search") {
    return {
      kind: "search",
      data: await buildSearch(deps, trimmed(url.searchParams.get("q")) ?? "")
    };
  }

  if (projectKey === null && sectionParam === "dispatch" && hostParam !== null) {
    const projects = (await deps.store.listProjects().catch(() => []))
      .filter((project) => project.hostId === hostParam)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    const picked = projects[0];
    if (picked !== undefined) {
      projectKey = picked.rootPath;
    } else {
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) query[key] = value;
      const preview = await computeDispatchPreview(
        {
          store: deps.store,
          env: deps.env ?? process.env,
          ...(deps.storeForHost ? { storeForHost: deps.storeForHost } : {})
        },
        "",
        url.searchParams
      );
      const formSignature = dispatchFormSignature(url.searchParams);
      return {
        kind: "dispatch",
        rootPath: "",
        hostId: hostParam,
        legacyHostless: false,
        rootLabel: "未选择项目",
        preview,
        previewId: dispatchPreviewId(preview, formSignature),
        formSignature,
        query
      };
    }
  }

  const resolved =
    projectKey === null ? null : await resolveProjectKey(deps, projectKey, hostParam ?? undefined);
  const projectStore =
    resolved !== null && resolved.hostId !== null
      ? (deps.storeForHost?.(resolved.hostId) ?? deps.store)
      : deps.store;

  const panelDeps: PanelDeps = {
    store: projectStore,
    env: deps.env ?? process.env,
    workspaceRoot: deps.workspaceRoot ?? null,
    ...(deps.serviceRepo !== undefined ? { serviceRepo: deps.serviceRepo } : {}),
    buildStale: deps.buildStale ?? null,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.deep !== undefined ? { deepProbe: deps.deep } : {}),
    ...(deps.storeForHost ? { storeForHost: deps.storeForHost } : {})
  };

  if (projectKey === null) {
    if (trimmed(url.searchParams.get("view")) === "compare") {
      return { kind: "compare", compare: await buildPanelCompare(panelDeps) };
    }
    return { kind: "overview", overview: await buildPanelOverview(panelDeps) };
  }
  if (!resolved) throw new PanelNotFoundError(`未知项目 "${projectKey}"`);

  const section = sectionParam;
  if (section === "dispatch") {
    const preview = await computeDispatchPreview(
      {
        store: projectStore,
        env: deps.env ?? process.env,
        ...(deps.storeForHost ? { storeForHost: deps.storeForHost } : {})
      },
      resolved.rootPath,
      url.searchParams
    );
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    const formSignature = dispatchFormSignature(url.searchParams);
    const legacyRecord =
      resolved.hostId === null
        ? await deps.store.getProjectByPath(resolved.rootPath).catch(() => null)
        : null;
    return {
      kind: "dispatch",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      legacyHostless: legacyRecord !== null && legacyRecord.hostId === null,
      rootLabel: resolved.name,
      preview,
      previewId: dispatchPreviewId(preview, formSignature),
      formSignature,
      query
    };
  }
  if (section === "library") {
    const recentRuns = await projectStore
      .listSuiteRuns(resolved.rootPath, { limit: 5 })
      .catch(() => []);
    const candidateMap = new Map<string, LibraryPageData["caseCandidates"][number]>();
    for (const run of recentRuns) {
      const full = await projectStore.getSuiteRun(resolved.rootPath, run.id).catch(() => null);
      const at = full?.finishedAt ?? full?.startedAt ?? run.finishedAt ?? run.startedAt ?? null;
      for (const entry of full?.cases ?? []) {
        if (entry.status === "passed") continue;
        if (candidateMap.has(entry.caseId)) continue;
        candidateMap.set(entry.caseId, { caseId: entry.caseId, name: entry.name, runId: run.id, at });
      }
      if (candidateMap.size >= 100) break;
    }
    return {
      kind: "library",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      rootLabel: resolved.name,
      sets: await projectStore.listCaseSets(resolved.rootPath),
      quarantine: await readQuarantineSummary(resolved.rootPath),
      caseCandidates: [...candidateMap.values()]
    };
  }
  if (section === "archive") {
    const kindRaw = trimmed(url.searchParams.get("kind"));
    const kind =
      kindRaw !== null &&
      ["run", "case-set", "report", "diff", "crash", "trace"].includes(kindRaw)
        ? (kindRaw as ArtifactRecord["kind"])
        : undefined;
    const q = trimmed(url.searchParams.get("q"));
    const since = normalizeSince(trimmed(url.searchParams.get("since")));
    const offsetRaw = trimmed(url.searchParams.get("offset"));
    const offset =
      offsetRaw !== null && Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) > 0
        ? Math.floor(Number(offsetRaw))
        : 0;
    const pageSize = 50;
    const fetched = await listArtifacts(resolved.rootPath, {
      ...(kind === undefined ? {} : { kind }),
      ...(q === null ? {} : { q }),
      ...(since === null ? {} : { since }),
      limit: pageSize + 1,
      offset
    });
    const hasNext = fetched.length > pageSize;
    const artifacts = hasNext ? fetched.slice(0, pageSize) : fetched;
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    return {
      kind: "archive",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      rootLabel: resolved.name,
      artifacts,
      query,
      page: { offset, hasNext, pageSize }
    };
  }
  if (section === "audit") {
    const domain = trimmed(url.searchParams.get("domain"));
    const resultRaw = trimmed(url.searchParams.get("result"));
    const result =
      resultRaw === "ok" || resultRaw === "skipped" || resultRaw === "failed" ? resultRaw : undefined;
    const since = normalizeSince(trimmed(url.searchParams.get("since")));
    const offsetRaw = trimmed(url.searchParams.get("offset"));
    const offset =
      offsetRaw !== null && Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) > 0
        ? Math.floor(Number(offsetRaw))
        : 0;
    const pageSize = 50;
    const page = await projectStore.listAudit(resolved.rootPath, {
      ...(domain === null ? {} : { domain }),
      ...(result === undefined ? {} : { result }),
      ...(since === null ? {} : { since }),
      limit: pageSize + 1,
      offset
    });
    const hasNext = page.length > pageSize;
    const events = hasNext ? page.slice(0, pageSize) : page;
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    return {
      kind: "audit",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      rootLabel: resolved.name,
      events,
      query,
      page: { offset, hasNext, pageSize }
    };
  }
  if (section === "events") {
    const type = trimmed(url.searchParams.get("type"));
    const status = trimmed(url.searchParams.get("status"));
    const consumedRaw = trimmed(url.searchParams.get("consumed"));
    const consumed =
      consumedRaw === "0" ? false : consumedRaw === "1" ? true : undefined;
    const includePayload = trimmed(url.searchParams.get("payload")) === "1";
    const since = normalizeSince(trimmed(url.searchParams.get("since")));
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    let events: ProjectEventRecord[] = [];
    let error: string | null = null;
    try {
      events = await projectStore.listProjectEvents(resolved.rootPath, {
        ...(type === null ? {} : { type }),
        ...(status === null ? {} : { status }),
        ...(consumed === undefined ? {} : { consumed }),
        ...(since === null ? {} : { since }),
        includePayload,
        order: "desc",
        limit: includePayload ? 50 : 200
      });
    } catch (cause) {
      error = `项目事件读取失败：${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return {
      kind: "events",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      rootLabel: resolved.name,
      events,
      query,
      includePayload,
      error
    };
  }
  if (section === "ops") {
    const health = (
      projectStore as { writeErrors?: () => { count: number; lastError: string | null } }
    ).writeErrors?.();
    const artifacts = (await listArtifacts(resolved.rootPath, { limit: 500 })).length;
    return {
      kind: "ops",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      rootLabel: resolved.name,
      storeKind: projectStore.kind,
      storeNote: deps.storeNote ?? null,
      writeError:
        health && health.count > 0
          ? `台账写失败 ${health.count} 次：${health.lastError ?? "未知原因"}`
          : null,
      artifacts
    };
  }

  const taskId = trimmed(url.searchParams.get("task"));
  if (taskId !== null) {
    const detail = await buildPanelTaskDetail(panelDeps, resolved.rootPath, taskId);
    if (!detail) throw new PanelNotFoundError(`未知回归任务 "${taskId}"`);
    const dispatched = trimmed(url.searchParams.get("dispatched"));
    return {
      kind: "task",
      rootPath: resolved.rootPath,
      hostId: resolved.hostId,
      detail,
      ...(dispatched === null ? {} : { flash: dispatched })
    };
  }

  const batchFile = trimmed(url.searchParams.get("batch"));
  if (batchFile !== null) {
    const detail = await buildPanelBatchDetail(panelDeps, resolved.rootPath, batchFile);
    if (!detail) throw new PanelNotFoundError(`未知项目 "${projectKey}"`);
    return { kind: "batch", rootPath: resolved.rootPath, hostId: resolved.hostId, detail };
  }

  if (trimmed(url.searchParams.get("view")) === "review") {
    const detail = await buildPanelReviewQueue(panelDeps, resolved.rootPath, { limit: 10 });
    return { kind: "review", rootPath: resolved.rootPath, hostId: resolved.hostId, detail };
  }

  if (trimmed(url.searchParams.get("view")) === "stats") {
    const detail = await buildPanelStatsView(panelDeps, resolved.rootPath);
    return { kind: "stats", rootPath: resolved.rootPath, hostId: resolved.hostId, detail };
  }

  const limitRaw = intParam(url.searchParams, "limit");
  const batchLimit = Math.min(Math.max(limitRaw ?? PANEL_BATCH_LIMIT_DEFAULT, 1), PANEL_BATCH_LIMIT_MAX);
  const detail = await buildPanelProjectDetail(panelDeps, resolved.rootPath, {
    batchLimit,
    iosProbe: trimmed(url.searchParams.get("ios")) === "1"
  });
  if (!detail) throw new PanelNotFoundError(`未知项目 "${projectKey}"`);
  const sectionActive: ConsoleNavKey | null =
    section === "tasks"
      ? "tasks"
      : section === "runners"
        ? "runners"
        : section === "schedules"
          ? "schedules"
          : null;
  return {
    kind: "project",
    rootPath: resolved.rootPath,
    hostId: resolved.hostId,
    detail,
    ...(sectionActive === null ? {} : { active: sectionActive })
  };
}

function toJsonView(view: PanelView): Record<string, unknown> {
  if (view.kind === "overview") return { ...view.overview, view: "overview" };
  if (view.kind === "compare") return { ...view.compare, view: "compare" };
  if (view.kind === "dispatch") return { ok: true, view: "dispatch", previewId: view.previewId, ...view.preview };
  if (view.kind === "library") {
    return { ok: true, view: "library", sets: view.sets, quarantine: view.quarantine, caseCandidates: view.caseCandidates };
  }
  if (view.kind === "archive") return { ok: true, view: "archive", artifacts: view.artifacts, page: view.page };
  if (view.kind === "audit") return { ok: true, view: "audit", events: view.events };
  if (view.kind === "events") {
    return {
      ok: true,
      view: "events",
      events: view.events,
      includePayload: view.includePayload,
      error: view.error,
      query: view.query
    };
  }
  if (view.kind === "ops") {
    return {
      ok: true,
      view: "ops",
      storeKind: view.storeKind,
      storeNote: view.storeNote,
      writeError: view.writeError,
      artifacts: view.artifacts
    };
  }
  if (view.kind === "search") {
    return { ok: true, view: "search", ...view.data };
  }
  if (view.kind === "project") return { ok: true, view: "project", ...view.detail };
  if (view.kind === "task") return { ok: true, view: "task", ...view.detail };
  if (view.kind === "review") return { ok: true, view: "review", ...view.detail };
  if (view.kind === "stats") return { ok: true, view: "stats", ...view.detail };
  return { ok: true, view: "batch", ...view.detail };
}

/** `GET /panel/api/hosts` 的只读投影：只暴露展示字段（不含 env/工具路径/完整行）。 */
export interface PanelHostApiRow {
  id: string;
  label: string | null;
  owner: string | null;
  hostname: string;
  kind: string;
  osPlatform: string;
  osVersion: string | null;
  arch: string | null;
  capabilities: string[];
  clientSeenAt: string | null;
  runnerSeenAt: string | null;
  lastSeenAt: string;
  queuePaused: boolean;
  registeredAt: string | null;
  expectedOs: string | null;
  expectedHostname: string | null;
}

export function panelHostApiRow(host: HostRecord): PanelHostApiRow {
  return {
    id: host.id,
    label: host.label,
    owner: host.owner,
    hostname: host.hostname,
    kind: host.kind,
    osPlatform: host.osPlatform,
    osVersion: host.osVersion,
    arch: host.arch,
    capabilities: [...host.capabilities],
    clientSeenAt: host.clientSeenAt,
    runnerSeenAt: host.runnerSeenAt,
    lastSeenAt: host.lastSeenAt,
    queuePaused: host.queuePaused,
    registeredAt: host.registeredAt,
    expectedOs: host.expectedOs,
    expectedHostname: host.expectedHostname
  };
}

/** 只读主机列表（设计稿 §12.2）：不受 `AOS_PANEL_ACTIONS` 影响；受 `AOS_PANEL_WEB` 约束。
 * 单机模式（file/memory）无中心主机台账 → `{ok:true,hosts:[]}`；
 * PostgreSQL 读取失败 → 503（不能伪装成空台账）。 */
export async function handlePanelHostsRequest(deps: PanelWebDeps): Promise<PanelWebResponse> {
  const env = deps.env ?? process.env;
  if (!panelWebEnabled(env)) return notFound("not found", true);
  if (deps.store.kind !== "postgres") {
    return {
      status: 200,
      contentType: JSON_CONTENT_TYPE,
      body: JSON.stringify({ ok: true, hosts: [] }, null, 2)
    };
  }
  let hosts: HostRecord[];
  try {
    hosts = await deps.store.listHosts();
  } catch {
    return {
      status: 503,
      contentType: JSON_CONTENT_TYPE,
      body: JSON.stringify({ ok: false, error: "主机台账读取失败" }, null, 2)
    };
  }
  return {
    status: 200,
    contentType: JSON_CONTENT_TYPE,
    body: JSON.stringify({ ok: true, hosts: hosts.map(panelHostApiRow) }, null, 2)
  };
}

export async function handlePanelRequest(url: URL, deps: PanelWebDeps): Promise<PanelWebResponse> {
  const env = deps.env ?? process.env;
  if (!panelWebEnabled(env)) {
    return url.pathname === "/panel/api/hosts" ? notFound("not found", true) : notFound();
  }
  if (url.pathname === "/panel/api/hosts") return handlePanelHostsRequest(deps);
  if (url.pathname !== "/panel" && url.pathname !== "/panel.json") return notFound();

  // 角色影响能力/按钮可见性：缓存必须按角色隔离，避免 viewer 命中 admin 页面。
  const cacheKey = `${url.pathname}${url.search}|role=${deps.capabilities?.role ?? ""}`;
  const cached = deps.cache?.get(cacheKey);
  if (cached) return cached;

  let view: PanelView;
  try {
    view = await buildView(url, deps);
  } catch (error) {
    if (error instanceof PanelNotFoundError) {
      return notFound(error.message, url.pathname.endsWith(".json"));
    }
    if (error instanceof AmbiguousProjectError) {
      return ambiguousProjectResponse(error, url.pathname.endsWith(".json"));
    }
    throw error;
  }

  const response: PanelWebResponse =
    url.pathname === "/panel.json"
      ? { status: 200, contentType: JSON_CONTENT_TYPE, body: JSON.stringify(toJsonView(view), null, 2) }
      : {
          status: 200,
          contentType: HTML_CONTENT_TYPE,
          body: renderPanelHtml(
            view,
            deps,
            await loadStoreHealth(deps, view),
            await loadProjectSwitcher(deps, view)
          )
        };
  deps.cache?.set(cacheKey, response);
  return response;
}

// ---------------------------------------------------------------------------
// HTML rendering


function renderTable(headers: string[], rows: string[][], emptyText: string, caption?: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return cTable({
    columns: headers,
    rows,
    empty: emptyText,
    ...(caption === undefined ? {} : { caption })
  });
}

function hostSuffix(hostId?: string | null): string {
  return hostId ? `&host=${encodeURIComponent(hostId)}` : "";
}

function projectHref(rootPath: string, hostId?: string | null): string {
  return `/panel?project=${encodeURIComponent(rootPath)}${hostSuffix(hostId)}`;
}

function dispatchHref(rootPath: string, hostId?: string | null): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&section=dispatch${hostSuffix(hostId)}`;
}

function batchHref(rootPath: string, file: string, hostId?: string | null): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&batch=${encodeURIComponent(file)}${hostSuffix(hostId)}`;
}

function taskHref(rootPath: string, taskId: string, hostId?: string | null): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&task=${encodeURIComponent(taskId)}${hostSuffix(hostId)}`;
}

function reviewHref(rootPath: string, hostId?: string | null): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&view=review${hostSuffix(hostId)}`;
}

function statsHref(rootPath: string, hostId?: string | null): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&view=stats${hostSuffix(hostId)}`;
}

function gateSpan(gate: "pass" | "fail" | null): string {
  if (gate === null) return '<span class="muted">—</span>';
  return gate === "pass"
    ? '<span class="gate-pass">通过</span>'
    : '<span class="gate-fail">未通过</span>';
}

function batchGateCell(gate: "pass" | "fail" | null, summary: { total?: number | null } | null): string {
  return summary !== null && summary.total === 0
    ? '<span class="muted">未执行（无用例）</span>'
    : gateSpan(gate);
}

function uiBadge(
  ui: PanelBatchSummary["ui"] | undefined,
  coverage?: PanelBatchSummary["uiCoverage"]
): string {
  if (ui === null || ui === undefined) return "";
  const status =
    ui.failed > 0
      ? `<span class="chip gate-fail">UI 失败 ${ui.failed}</span>`
      : ui.unverified > 0
        ? `<span class="chip">UI 未验证 ${ui.unverified}</span>`
        : ui.passed > 0
          ? `<span class="chip gate-pass">UI 通过 ${ui.passed}</span>`
          : "";
  const text = ui.textStyles;
  const weight =
    text !== undefined && (text.checked > 0 || text.unverified > 0)
      ? `<span class="chip" title="字重仅提示，不参与 UI 门禁">字重 heavier ${text.heavier}/${text.checked}${text.unverified > 0 ? ` · 未验证 ${text.unverified}` : ""}</span>`
      : "";
  const coverageChip =
    coverage !== undefined && coverage !== null && coverage.contractScreens > 0
      ? (() => {
          const missing = coverage.contractNotCompared
            .slice(0, 10)
            .map((screen) => screen.name || screen.id)
            .join("、");
          const title = `UI 覆盖：已比对 ${coverage.comparedScreens.length} / 契约 ${coverage.contractScreens}；未覆盖 ${coverage.contractNotCompared.length}${
            missing === "" ? "" : `（${missing}${coverage.contractNotCompared.length > 10 ? "…" : ""}）`
          }`;
          return `<span class="chip" title="${escapeHtml(title)}">UI 覆盖 ${coverage.comparedScreens.length}/${coverage.contractScreens}${
            coverage.contractNotCompared.length > 0
              ? ` · 未覆盖 ${coverage.contractNotCompared.length}`
              : ""
          }</span>`;
        })()
      : "";
  return `${status}${weight}${coverageChip}`;
}

/** 批次 API 说明状态（台账优先；旧记录无该字段 → 未记录）。 */
function apiReviewBadge(review: PanelBatchDetail["apiReview"]): string {
  if (review === null) return '<span class="muted">API 说明：未记录</span>';
  const suffix = review.carriedForward
    ? review.designChanged
      ? "（沿用上次，设计已变）"
      : "（沿用上次）"
    : "";
  if (review.status === "pending") {
    return `<span class="chip gate-fail">API 说明待补充${suffix}</span>`;
  }
  if (review.status === "provided") {
    return `<span class="chip gate-pass">API 说明已提供${suffix}</span>`;
  }
  if (review.status === "not-applicable") {
    return `<span class="chip">API 无变更${suffix}</span>`;
  }
  return `<span class="chip">API 说明未确认${suffix}</span>`;
}

/** 批次用例级 UI 状态；旧清单无该字段 → —。 */
function uiCaseCell(ui: PanelBatchDetail["cases"][number]["ui"]): string {
  if (ui === null || ui === undefined) return '<span class="muted">—</span>';
  const title = ui.reason ? ` title="${escapeHtml(ui.reason)}"` : "";
  if (ui.status === "passed") return `<span class="ok c-nowrap"${title}>通过</span>`;
  if (ui.status === "failed") return `<span class="err c-nowrap"${title}>失败</span>`;
  if (ui.status === "not-applicable") return `<span class="muted c-nowrap"${title}>不适用</span>`;
  return `<span class="muted c-nowrap"${title}>未验证</span>`;
}

const LAMP_LABELS: Record<PanelProjectRow["lamp"], string> = {
  red: "阻断",
  yellow: "需关注",
  green: "健康",
  gray: "未知"
};

function lampDot(lamp: PanelProjectRow["lamp"]): string {
  return `<span class="lamp lamp-${lamp}" aria-hidden="true"></span>`;
}

function lampSpan(lamp: PanelProjectRow["lamp"]): string {
  return `${lampDot(lamp)}${LAMP_LABELS[lamp]}`;
}

function renderProjectCell(row: PanelProjectRow): string {
  const reasons =
    row.lampReasons.length > 0
      ? `<div class="muted">${row.lampReasons.map((reason) => escapeHtml(reason)).join("；")}</div>`
      : "";
  const integration = row.integration?.total
    ? `<div class="muted">集成 ${row.integration.ready}/${row.integration.total}${
        row.integration.missing.length > 0
          ? `（缺 ${row.integration.missing.map((item) => escapeHtml(item)).join("、")}）`
          : ""
      }</div>`
    : "";
  const designWarnings = `<div class="muted">${escapeHtml(designWarningsText(row.designWarnings))}</div>`;
  return `<span>${lampSpan(row.lamp)}</span>${reasons}${integration}${designWarnings}`;
}

function designWarningsText(summary: WarningSummary | null): string {
  if (summary === null || !summary.available) {
    return "设计源警告：不可用（缺 tests.json / flows.json 快照）";
  }
  const codes = summary.codes.length > 0 ? `（${summary.codes.join("、")}）` : "";
  return `设计源警告 ${summary.total} 条${codes}`;
}

function renderLatestBatchCell(row: PanelProjectRow): string {
  const batch = row.latestBatch;
  if (batch === null) return '<span class="muted">无批次记录</span>';
  const summary =
    batch.summary === null
      ? ""
      : ` · 通过 ${batch.summary.passed ?? "—"}/${batch.summary.total ?? "—"}`;
  const note = batch.note !== null ? ` · ${escapeHtml(batch.note)}` : "";
  const runId = batch.runId ?? "（不可读）";
  return [
    '<div class="c-batch-cell">',
    `<div class="c-batch-head">${batchGateCell(batch.gate, batch.summary)}${uiBadge(batch.ui, batch.uiCoverage)}<span class="c-batch-time">· ${relativeTime(batch.finishedAt)}${summary}${note}</span></div>`,
    `<code class="c-run-id" title="${escapeHtml(runId)}">${escapeHtml(runId)}</code>`,
    "</div>"
  ].join("");
}

function hostDepsLabel(status: string): string {
  if (status === "ready") return "就绪";
  if (status === "stale") return "需更新";
  if (status === "missing") return "缺失";
  return status;
}

function machineKindLabel(kind: string): string {
  if (kind === "mac") return "Mac";
  if (kind === "pc") return "PC";
  if (kind === "linux") return "Linux";
  return kind;
}

function renderMachinesSection(view: PanelOverview): string {
  if (view.machines.length === 0) {
    return [
      '<section id="machines">',
      "<h2>接入主机</h2>",
      '<p class="empty">单机模式（无中心台账）</p>',
      "</section>"
    ].join("\n");
  }
  const rows = view.machines.map((machine) => {
    const system = [machineKindLabel(machine.kind), machine.osPlatform, machine.osVersion, machine.arch]
      .filter((part) => part !== null && part !== "")
      .join(" · ");
    const ide = machine.clientOnline
      ? `${cBadge({ label: "IDE 在线", tone: "success" })}${
          machine.clientSessions > 0 ? ` <span class="muted">${machine.clientSessions} 会话</span>` : ""
        }`
      : cBadge({ label: "IDE 离线", tone: "neutral" });
    const runner = machine.runnerOnline
      ? cBadge({ label: "执行机在线", tone: "success" })
      : cBadge({ label: "执行机离线", tone: "warning" });
    const ip = [
      machine.ipPrimary === null
        ? '<span class="muted">—</span>'
        : `<code>${escapeHtml(machine.ipPrimary)}</code>`,
      machine.ipChange === null
        ? ""
        : ` <span class="note">上次 ${escapeHtml(machine.ipChange.prior)}，变更于 ${relativeTime(
            machine.ipChange.changedAt
          )}</span>`,
      machine.ipShared ? ' <span class="chip gate-fail" title="同一观测地址最近 10 分钟出现在多台主机（NAT/复用）">IP 复用</span>' : ""
    ].join("");
    const capabilities =
      machine.capabilities.length === 0
        ? '<span class="muted">—</span>'
        : machine.capabilities
            .map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`)
            .join(" ");
    const queue = machine.queuePaused
      ? `${cBadge({ label: `队列暂停`, tone: "warning" })} <span class="muted">待 ${machine.pendingTasks}</span>`
      : `<span class="muted">待 ${machine.pendingTasks}</span>`;
    const drift =
      machine.drift.length === 0
        ? '<span class="muted">—</span>'
        : machine.drift.map((line) => `<span class="note">${escapeHtml(line)}</span>`).join("<br>");
    const registration = machine.registered
      ? cBadge({ label: "已登记", tone: "neutral" })
      : cBadge({ label: "未登记", tone: "neutral" });
    return [
      `<code>${escapeHtml(machine.hostname)}</code>${
        machine.label === null ? "" : ` <span class="muted">${escapeHtml(machine.label)}</span>`
      } ${registration}`,
      escapeHtml(system),
      `${ide} / ${runner}`,
      ip,
      capabilities,
      queue,
      `<span class="c-nowrap">${relativeTime(machine.lastSeenAt)}</span>`,
      drift
    ];
  });
  return [
    '<section id="machines">',
    "<h2>接入主机</h2>",
    renderTable(
      ["主机", "系统", "IDE/执行机", "IP", "能力", "队列", "最后活跃", "漂移"],
      rows,
      "单机模式（无中心台账）",
      "接入主机"
    ),
    "</section>"
  ].join("\n");
}

function renderOverviewPage(view: PanelOverview, cacheNote: string): string {
  const store = view.store.degraded
    ? cBadge({ label: "存储：会话内存", tone: "warning" })
    : view.store.kind === "file"
      ? cBadge({ label: "存储：文件台账", tone: "neutral" })
      : cBadge({ label: "存储：PostgreSQL", tone: "neutral" });
  const excludedNote =
    view.excludedProjects > 0 ? ` · 已隐藏 ${view.excludedProjects} 个排除项目` : "";
  const overviewScript =
    view.projects.length === 0
      ? ""
      : `<script>(function(){var projects=${JSON.stringify(
          view.projects.map((row) => ({ name: row.name, rootPath: row.rootPath, url: projectHref(row.rootPath, row.hostId) }))
        ).replace(/</g, "\\u003c")};
try{
  var last=localStorage.getItem("aos-last-project");
  if(last){for(var i=0;i<projects.length;i++){if(projects[i].rootPath===last){var box=document.getElementById("aos-resume");if(box){box.textContent="继续上次：";var a=document.createElement("a");a.className="c-button c-button-primary";a.href=projects[i].url;a.textContent=projects[i].name+" →";box.appendChild(a);box.hidden=false;}break;}}}
  if(projects.length===1&&!sessionStorage.getItem("aos-auto-entered")){sessionStorage.setItem("aos-auto-entered","1");location.replace(projects[0].url);}
}catch(e){}
})();</script>`;
  const rows = view.projects.map((row) => {
    const href = projectHref(row.rootPath, row.hostId);
    return [
      `<a class="c-project-link" href="${escapeHtml(href)}" title="进入项目：${escapeHtml(row.name)}">${escapeHtml(row.name)}<span class="c-project-arrow" aria-hidden="true">→</span></a>`,
      `<span title="${escapeHtml(row.hostId ?? "未归属主机")}">${escapeHtml(
        hostDisplayLabel(row.hostId, view.machines)
      )}</span>`,
      renderProjectCell(row),
      escapeHtml(row.stacks.join("、") || "—"),
      `<span class="c-nowrap">${relativeTime(row.lastSeenAt)}</span>`,
      renderLatestBatchCell(row),
      escapeHtml(row.warnings.join("；") || "—")
    ];
  });
  return renderConsoleShell({
    title: "多项目总览",
    active: "overview",
    meta: `项目 ${view.projects.length} 个${escapeHtml(excludedNote)} · ${escapeHtml(cacheNote)}`,
    autoRefreshSeconds: 15,
    project: currentShell.project,
    capabilities: currentShell.capabilities,
    body: [
      "<header>",
      "<h1>多项目总览</h1>",
      '<p><a href="/panel?view=compare">多项目对比</a></p>',
      `<p>${store}${cBadge({ label: `服务依赖：${hostDepsLabel(view.host.deps)}`, tone: "neutral" })} ${cBadge({
        label: `构建：${view.host.buildStale === null ? "未知" : view.host.buildStale ? "陈旧（需重启）" : "最新"}`,
        tone: view.host.buildStale === null ? "neutral" : view.host.buildStale ? "warning" : "success"
      })}</p>`,
      "</header>",
      view.excludedProjects > 0
        ? `<p class="muted">已隐藏 ${view.excludedProjects} 个项目（服务仓库默认隐藏，或由 <code>AOS_PANEL_EXCLUDE_PROJECTS</code> 指定）；直接项目 URL 仍可访问。</p>`
        : "",
      renderMachinesSection(view),
      view.projects.length === 0
        ? cEmpty({
            title: "还没有接入项目",
            body: "在 MCP 客户端配置 AOS_PROJECT_DIR 指向项目目录，或把项目放入本次工作区后刷新；接入步骤见项目根 README。",
            action: '<code>node dist/cli.js install</code>（生成客户端挂载配置）'
          })
        : [
            `<p><a class="c-button c-button-primary" href="${escapeHtml(projectHref(view.projects[0].rootPath, view.projects[0].hostId))}">进入最近活跃项目：${escapeHtml(view.projects[0].name)} →</a></p>`,
            cCard({
              title: "项目",
              subtitle: `生成时间 ${relativeTimeText(view.generatedAt)} · 项目 ${view.projects.length} 个${excludedNote} · ${cacheNote}`,
              body: cTable({
                columns: ["项目", "主机", "接入健康", "栈", "最后活跃", "最新批次", "备注"],
                columnWidths: ["18%", "12%", "25%", "10%", "10%", "20%", "5%"],
                rows,
                empty: "暂无项目"
              })
            }).toString()
          ].join("\n"),
      view.projects.length === 0 ? "" : '<p id="aos-resume" hidden></p>',
      overviewScript
    ].join("\n")
  });
}

function runnableAxis(detail: PanelProjectDetail): { lamp: PanelProjectRow["lamp"]; note: string } {
  if (!detail.project.diskReachable) return { lamp: "gray", note: "（磁盘不可达，仅台账可见）" };
  const online = detail.runners.filter((runner) => runner.online).length;
  if (online === 0) {
    return { lamp: "yellow", note: "（无在线执行机；任务将排队，可 CLI 手动执行）" };
  }
  return { lamp: "green", note: `（在线执行机 ${online}）` };
}

function renderProjectPulse(detail: PanelProjectDetail, rootPath: string, hostId: string | null): string {
  const row = detail.project;
  const axis = runnableAxis(detail);
  const active = detail.tasks.filter(
    (task) => task.status === "claimed" || task.status === "running"
  );
  const pending = detail.tasks.filter((task) => task.status === "pending");
  const activeHint =
    active.length > 0 ? `${active[0].status} · ${active[0].id.slice(0, 8)}` : "当前无执行中任务";
  const activeLinks = active
    .slice(0, 3)
    .map(
      (task) =>
        `<a href="${escapeHtml(taskHref(rootPath, task.id, hostId))}"><code>${escapeHtml(task.id.slice(0, 8))}</code></a>`
    )
    .join(" · ");
  const pendingLinks = pending
    .slice(0, 3)
    .map(
      (task) =>
        `<a href="${escapeHtml(taskHref(rootPath, task.id, hostId))}"><code>${escapeHtml(task.id.slice(0, 8))}</code></a>`
    )
    .join(" · ");
  const activityLine =
    activeLinks === "" && pendingLinks === ""
      ? ""
      : `<p class="muted">${activeLinks === "" ? "" : `执行中：${activeLinks}`}${activeLinks !== "" && pendingLinks !== "" ? "　" : ""}${pendingLinks === "" ? "" : `待领取：${pendingLinks}`}</p>`;
  const refs = detail.regressionRefs.length;
  const libraryHref = `/panel?project=${encodeURIComponent(rootPath)}&section=library${hostSuffix(hostId)}`;
  const dispatchHintHtml =
    refs === 0
      ? `<p>先生成或导入用例，再走下发向导。 <a href="${escapeHtml(libraryHref)}">去用例库</a></p>`
      : `<p>${escapeHtml(
          `当前有 ${refs} 份可引用的用例集；新建任务走下发向导：选来源 → 设参数 → 预览 → 确认。`
        )}</p>`;
  return [
    '<div class="c-stats-row">',
    cStat({
      label: "可运行",
      value:
        axis.lamp === "green"
          ? "正常"
          : axis.lamp === "red"
            ? "阻断"
            : axis.lamp === "gray"
              ? "不可达"
              : "需关注",
      hint: axis.note
    }),
    cStat({ label: "在跑什么", value: String(active.length), hint: activeHint }),
    cStat({
      label: "待执行",
      value: String(pending.length),
      hint: pending.length > 0 ? "等待执行机领取" : "队列为空"
    }),
    cCard({
      tone: "accent",
      title: "下一步",
      actions:
        detail.reviewQueue.undecided > 0
          ? `<a class="c-button c-button-primary" href="${escapeHtml(reviewHref(rootPath, hostId))}">先去裁决 ${detail.reviewQueue.undecided} 条 →</a> <a class="c-button" href="${escapeHtml(dispatchHref(rootPath, hostId))}">新建任务</a>`
        : detail.regressionRefs.length === 0
        ? `<a class="c-button c-button-primary" href="${escapeHtml(
            `/panel?project=${encodeURIComponent(rootPath)}&section=library${hostSuffix(hostId)}`
          )}">先去生成/导入用例 →</a>`
        : `<a class="c-button c-button-primary" href="${escapeHtml(dispatchHref(rootPath, hostId))}">新建任务</a>`,
      body:
        [
          dispatchHintHtml,
          detail.reviewQueue.undecided === 0 && detail.reviewQueue.unissued === 0
            ? `<p><a href="${escapeHtml(reviewHref(rootPath, hostId))}">失败分析</a> · <a href="${escapeHtml(statsHref(rootPath, hostId))}">统计</a></p>`
            : `<p><a href="${escapeHtml(reviewHref(rootPath, hostId))}">待判定 ${detail.reviewQueue.undecided} 条</a> · <a href="${escapeHtml(statsHref(rootPath, hostId))}#issues">未建单缺陷 ${detail.reviewQueue.unissued} 项</a> · <a href="${escapeHtml(statsHref(rootPath, hostId))}">统计</a></p>`
        ].join("\n")
    }),
    activityLine,
    "</div>"
  ].join("");
}

function renderCredentialRows(detail: PanelProjectDetail): string[][] {
  const integration = detail.integration;
  if (integration === null) return [];
  const { figma, jira, penKey } = integration.credentials;
  return [
    ["Figma token", figma ? "已配置" : "未配置", "—"],
    [
      "Jira",
      jira.configured ? "已配置" : "未配置",
      jira.siteUrl ?? (jira.missing.length > 0 ? `缺 ${jira.missing.join("、")}` : "—")
    ],
    ["pen CLI key", penKey ? "已配置" : "未配置", "—"]
  ];
}

function renderIntegration(detail: PanelProjectDetail): string {
  const integration = detail.integration;
  if (integration === null) {
    return [
      '<section id="integration">',
      "<h2>接入</h2>",
      '<p class="note">磁盘不可达：集成软读不可用（仅台账视图）。</p>',
      "</section>"
    ].join("\n");
  }
  const deviceHosts = integration.deviceHosts.configured
    ? [
        integration.deviceHosts.iosAppiumUrl !== null
          ? `iOS Appium：<code>${escapeHtml(integration.deviceHosts.iosAppiumUrl)}</code>`
          : null,
        integration.deviceHosts.androidAdbHost !== null
          ? `Android adbHost：<code>${escapeHtml(integration.deviceHosts.androidAdbHost)}</code>`
          : null
      ]
        .filter((line): line is string => line !== null)
        .join("<br>")
    : '<span class="muted">未配置</span>';
  const validation = [
    ...integration.validation.errors.map((message) => `<p class="note">错误：${escapeHtml(message)}</p>`),
    ...integration.validation.warnings.map((message) => `<p class="note">警告：${escapeHtml(message)}</p>`)
  ].join("");
  const assets = integration.assets.map((asset) => [
    escapeHtml(asset.id),
    `<code>${escapeHtml(asset.path)}</code>`,
    asset.present ? '<span class="ok">存在</span>' : '<span class="muted">缺失</span>',
    relativeTime(asset.modifiedAt)
  ]);
  return [
    '<section id="integration">',
    "<h2>接入</h2>",
    '<div class="cards">',
    `<div class="card"><div class="k">LLM 条目</div><div class="v">${integration.llm.entries}</div></div>`,
    `<div class="card"><div class="k">active</div><div class="v">${escapeHtml(integration.llm.activeName ?? "—")}</div></div>`,
    `<div class="card"><div class="k">LLM 可用</div><div class="v">${integration.llm.usable ? "是" : "否"}</div></div>`,
    "</div>",
    integration.llm.usable
      ? ""
      : `<p class="note">缺项：${escapeHtml(integration.llm.missing.slice(0, 5).join("；"))}</p>`,
    renderTable(["凭证", "状态", "备注"], renderCredentialRows(detail), "—", "接入凭证"),
    validation,
    `<h3>设备宿主</h3><p>${deviceHosts}</p>`,
    `<h3>宿主</h3><p class="muted">deps：${escapeHtml(integration.host.deps)} · 构建：${
      integration.host.buildStale === null ? "未知" : integration.host.buildStale ? "陈旧（需重启）" : "最新"
    }</p>`,
    `<h3>设计资产</h3>`,
    renderTable(["资产", "路径", "状态", "更新时间"], assets, "暂无资产", "磁盘文件"),
    "</section>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderBatches(detail: PanelProjectDetail, rootPath: string, hostId: string | null): string {
  const rows = detail.batches.map((batch: PanelBatchRow) => [
    relativeTime(batch.startedAt),
    relativeTime(batch.finishedAt),
    sourceHtml(batch.source),
    batchGateCell(batch.gate, batch.summary),
    batch.summary === null
      ? "—"
      : `${batch.summary.passed ?? "—"}/${batch.summary.total ?? "—"}`,
    uiBadge(batch.ui, batch.uiCoverage) || "—",
    batch.failureDomains === null
      ? "—"
      : escapeHtml(
          Object.entries(batch.failureDomains)
            .map(([domain, count]) => `${failureDomainLabel(domain)}×${count}`)
            .join("、") || "—"
        ),
    `<a href="${escapeHtml(batchHref(rootPath, batch.file, hostId))}"><code>${escapeHtml(batch.file)}</code></a>` +
      (batch.note !== null ? `<div class="muted">${escapeHtml(batch.note)}</div>` : "")
  ]);
  const empty =
    detail.emptyState === null
      ? "暂无批次记录"
      : `暂无批次记录（可能原因：${detail.emptyState.causes.map((cause) => escapeHtml(cause)).join("；")}）`;
  const trend = detail.trend;
  const trendLine =
    trend === null
      ? ""
      : [
          `<p class="muted">趋势（旧→新${
            trend.points.length > 20 ? "，仅最近 20 批" : ""
          }）：${trend.points
            .slice(-20)
            .map((point) => {
              const empty = point.total !== null && point.total === 0;
              const cls = empty ? "muted" : point.gate === "fail" ? "gate-fail" : "gate-pass";
              return `<span class="${cls}"${empty ? ' title="无用例：未执行（不计门禁）"' : ""}>${
                point.passed ?? "—"
              }/${point.total ?? "—"}${empty ? "（未执行）" : ""}</span>`;
            })
            .join(" → ")}</p>`,
          Object.keys(trend.domainTotals).length > 0
            ? `<p>${Object.entries(trend.domainTotals)
                .map(
                  ([domain, count]) =>
                    `<span class="chip" title="${escapeHtml(domain)}">${escapeHtml(failureDomainLabel(domain))} × ${count}</span>`
                )
                .join("")}</p>`
            : ""
        ].join("\n");
  return [
    '<section id="batches">',
    "<h2>最近运行</h2>",
    trendLine,
    renderTable(["开始", "结束", "来源", "门禁", "通过/总数", "UI", "失败域", "清单"], rows, empty),
    "</section>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderStandalones(detail: PanelProjectDetail): string {
  const outcomeLabel: Record<PanelStandaloneRow["outcome"], string> = {
    passed: '<span class="ok">通过</span>',
    failed: '<span class="err">失败</span>',
    pending: "运行中"
  };
  const rows = detail.standalones.map((row) => [
    `<code>${escapeHtml(row.traceId)}</code>`,
    escapeHtml(row.caseId ?? "—"),
    outcomeLabel[row.outcome],
    escapeHtml(row.status),
    escapeHtml(row.model ?? "—"),
    relativeTime(row.submittedAt),
    relativeTime(row.finishedAt)
  ]);
  return [
    '<section id="standalones">',
    "<h2>单次运行</h2>",
    renderTable(["trace", "用例", "结果", "台账状态", "模型", "提交", "完成"], rows, "暂无单次运行"),
    "</section>"
  ].join("\n");
}

function renderDeepSection(detail: PanelProjectDetail): string {
  const deep = detail.deep;
  if (deep === null) return "";
  const child = deep.artemis.child;
  const rows: string[][] = [
    ["active Profile", escapeHtml(deep.activeProfile ?? "—")],
    ["LLM 条目", String(deep.llmEntries)],
    ["setup required", deep.setupRequired ? "是" : "否"],
    [
      "存储",
      escapeHtml(
        `${storeKindLabel(deep.store.kind)}${
          deep.store.note ? ` · ${deep.store.note}` : ""
        }`
      )
    ],
    [
      "artemis 子进程",
      child.running
        ? `运行中（pid ${child.pid ?? "—"} · 重启 ${child.restarts}）`
        : `未运行（重启 ${child.restarts}）`
    ],
    ...(child.lastError !== null
      ? [["子进程错误", escapeHtml(child.lastError)] as string[]]
      : []),
    [
      "artemis python",
      deep.artemis.python.found
        ? escapeHtml(deep.artemis.python.path ?? "已找到")
        : escapeHtml(
            `未找到${deep.artemis.python.hint ? `（${deep.artemis.python.hint.split("\n")[0]}）` : ""}`
          )
    ],
    [
      "Figma 桥",
      escapeHtml(
        `${deep.figma.bridge.status}${
          deep.figma.bridge.port !== null ? `（:${deep.figma.bridge.port}）` : ""
        }`
      )
    ],
    ["构建", deep.build.stale ? '<span class="gate-fail">陈旧（需重启会话）</span>' : "最新"],
    ["日志", deep.logs.file === null ? "—" : `<code>${escapeHtml(deep.logs.file)}</code>`]
  ];
  const ios = deep.iosProbe;
  const iosBlock =
    ios === null
      ? `<p class="muted">iOS 环境检测未执行（URL 加 <code>?ios=1</code> 显式检测；会调用本地 appium CLI）</p>`
      : ios.error !== null
        ? `<p class="note">iOS 环境检测失败：${escapeHtml(ios.error)}</p>`
        : [
            `<p class="muted">检测时间 ${escapeHtml(ios.probedAt)}（缓存 ${Math.round(
              PANEL_IOS_PROBE_TTL_MS / 1000
            )}s）</p>`,
            renderTable(
              ["项", "状态"],
              [
                [
                  "appium CLI",
                  ios.appium.found
                    ? `已安装${ios.appium.version ? `（${escapeHtml(ios.appium.version)}）` : ""}`
                    : "未检测到"
                ],
                [
                  "xcuitest 驱动",
                  ios.xcuitest.installed
                    ? `已安装${ios.xcuitest.version ? `（${escapeHtml(ios.xcuitest.version)}）` : ""}`
                    : "未安装"
                ]
              ],
              "—"
            ),
            ios.guidance.length > 0
              ? `<ul>${ios.guidance.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
              : ""
          ]
            .filter((part) => part !== "")
            .join("\n");
  return [
    '<section id="deep">',
    "<h2>运行时细节</h2>",
    cTable({ columns: ["项", "值"], rows, caption: "深探项", empty: "—" }),
    "<h3>iOS 环境检测</h3>",
    iosBlock,
    "</section>"
  ].join("\n");
}

function renderDiskAssets(detail: PanelProjectDetail): string {
  const assets = detail.diskAssets;
  if (assets === null) return "";
  const crashes =
    assets.crashes === null
      ? '<p class="empty">不可用</p>'
      : [
          renderTable(
            ["签名", "类型", "包名", "异常", "次数", "最近出现"],
            assets.crashes.recent.slice(0, 5).map((record) => [
              `<code>${escapeHtml(record.id)}</code>`,
              escapeHtml(record.kind),
              escapeHtml(record.package),
              escapeHtml(record.exceptionClass),
              String(record.occurrences),
      relativeTime(record.lastSeenAt)
            ]),
            "无崩溃签名"
          ),
          assets.crashes.total > 0 ? `<p class="muted">共 ${assets.crashes.total} 个签名</p>` : ""
        ]
          .filter((part) => part !== "")
          .join("\n");
  const reconciliation =
    assets.reconciliation === null || !assets.reconciliation.present
      ? '<p class="empty">暂无对账信息</p>'
      : `<p class="muted">边 ${assets.reconciliation.edges} · 升级 ${assets.reconciliation.byStatus.upgraded} · 待审 ${assets.reconciliation.byStatus.pending} · 已确认 ${assets.reconciliation.byStatus.confirmed} · 已驳回 ${assets.reconciliation.byStatus.rejected} · 逆向观测 ${assets.reconciliation.runtimeOnly} · 更新 ${escapeHtml(
          assets.reconciliation.updatedAt ?? "—"
        )}</p>`;
  const baselines =
    assets.baselines === null
      ? '<p class="empty">不可用</p>'
      : renderTable(
          ["设备", "用例", "步骤", "区域", "类别"],
          assets.baselines.hotspots.map((hotspot) => [
            `<code>${escapeHtml(hotspot.serial)}</code>`,
            escapeHtml(hotspot.caseId),
            String(hotspot.step),
            String(hotspot.regions),
            escapeHtml(hotspot.categories.join("、") || "—")
          ]),
          "无未消除热点"
        );
  const retention =
    assets.retention === null
      ? '<p class="empty">不可用</p>'
      : [
          `<p class="muted">≥${assets.retention.days} 天：${assets.retention.overdue.count} 项 / ${formatBytes(
            assets.retention.overdue.totalBytes
          )}（只读，不删除）</p>`,
          `<p>${assets.retention.categories
            .map(
              (category) =>
                `<span class="chip">${escapeHtml(category.id)} ${category.overdue}/${category.total}</span>`
            )
            .join("")}</p>`
        ].join("\n");
  const warnings = assets.warnings
    .map((warning) => `<p class="note">${escapeHtml(warning)}</p>`)
    .join("");
  const designWarnings = `<p class="muted">${escapeHtml(designWarningsText(assets.designWarnings))}</p>`;
  const vision =
    assets.vision == null
      ? '<p class="empty">不可用</p>'
      : [
          `<p class="muted">最近 ${assets.vision.checked} 条 iOS trace：降级 ${assets.vision.degraded} 条${
            assets.vision.checked > 0
              ? `（${Math.round((assets.vision.degraded / assets.vision.checked) * 100)}%）`
              : ""
          }</p>`,
          assets.vision.byReason.length > 0
            ? `<p>${assets.vision.byReason
                .slice(0, 3)
                .map(
                  (entry) =>
                    `<span class="chip" title="${escapeHtml(entry.reason)}">${escapeHtml(
                      entry.reason
                    )} × ${entry.count}</span>`
                )
                .join("")}</p>`
            : ""
        ]
          .filter((part) => part !== "")
          .join("\n");
  return [
    '<section id="disk-assets">',
    "<h2>磁盘文件</h2>",
    "<h3>崩溃签名</h3>",
    crashes,
    "<h3>对账信息</h3>",
    reconciliation,
    "<h3>设备基线热点</h3>",
    baselines,
    "<h3>设计源警告</h3>",
    designWarnings,
    "<h3>视觉降级（iOS）</h3>",
    vision,
    "<h3>保留期</h3>",
    retention,
    warnings,
    "</section>"
  ].join("\n");
}

function renderOnboarding(rootPath: string, hostId: string | null): string {
  const libraryHref = `/panel?project=${encodeURIComponent(rootPath)}&section=library${hostSuffix(hostId)}`;
  const opsHref = `/panel?project=${encodeURIComponent(rootPath)}&section=ops${hostSuffix(hostId)}`;
  return [
    '<section id="onboarding">',
    "<h2>三步开始</h2>",
    cCard({
      body: [
        "<ol>",
        `<li><strong>接入检查（可选）</strong>：LLM / Figma / Jira 缺失不影响执行（缺 LLM 不生成用例、缺 Jira 不建单）；详见 <a href="${escapeHtml(opsHref)}">运维与数据</a> 与下方「环境自查与明细」。</li>`,
        `<li><strong>生成或导入第一份用例</strong>：MCP 工具 <code>figma_generate_tests</code> / <code>pen_extract_flows</code>，或 <a href="${escapeHtml(libraryHref)}">用例库 → Excel 导入</a>。</li>`,
        `<li><strong>下发第一条回归</strong>：<a href="${escapeHtml(dispatchHref(rootPath, hostId))}">去下发向导</a>（需先完成第 ② 步；预览与确认同源、字段变更即失效）。</li>`,
        "</ol>"
      ].join("\n")
    }),
    "</section>"
  ].join("\n");
}

function bulkBindScript(formSelector: string, itemName: string, countId: string): string[] {
  return [
    "function aosBindBulk(scopeSel,itemName,countId){",
    "  var scope=document.querySelector(scopeSel);if(!scope)return;",
    "  var countEl=document.getElementById(countId);",
    "  function refresh(){if(countEl)countEl.textContent=String(scope.querySelectorAll('input[name=\"'+itemName+'\"]:checked').length);}",
    "  scope.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button[data-bulk]'):null;if(!b)return;var op=b.getAttribute('data-bulk');var boxes=scope.querySelectorAll('input[name=\"'+itemName+'\"]');for(var i=0;i<boxes.length;i++){boxes[i].checked=(op==='all');}refresh();});",
    "  scope.addEventListener('change',function(e){if(e.target&&e.target.name===itemName)refresh();});",
    "  refresh();",
    "}",
    `aosBindBulk('${formSelector}','${itemName}','${countId}');`
  ];
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  claimed: "已领取",
  running: "执行中",
  stopping: "停止中",
  stopped: "已停止",
  cancelled: "已取消",
  completed: "已完成",
  partial: "部分失败",
  failed: "失败"
};

function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

function taskStatusTone(status: string): "accent" | "success" | "warning" | "error" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "claimed" || status === "running") return "accent";
  if (status === "stopping") return "warning";
  if (status === "stopped" || status === "cancelled") return "neutral";
  if (status === "pending" || status === "partial") return "warning";
  return "neutral";
}

function toolBadges(tools: RunnerTools): string {
  const entries: Array<[string, boolean]> = [
    ["adb", tools.adb],
    ["idb", tools.idb],
    ["simctl", tools.simctl],
    ["idevice_id", tools.ideviceId],
    ["appium", tools.appium]
  ];
  return entries
    .map(
      ([name, ok]) =>
        `<span class="chip"${ok ? "" : ' style="opacity:.45"'}>${escapeHtml(name)} ${ok ? "✓" : "✗"}</span>`
    )
    .join(" ");
}

function renderRunners(detail: PanelProjectDetail, rootPath: string, hostId: string | null): string {
  const fleet = detail.fleet;
  const fleetStats = `<div class="c-stats-row">${[
    cStat({
      label: "执行机",
      value: `${fleet.runners.online} 在线`,
      hint: `失联 ${fleet.runners.offline}`
    }),
    cStat({
      label: "设备容量",
      value: String(fleet.devices.total),
      hint: `iOS ${fleet.devices.ios} · Android ${fleet.devices.android} · 租约中 ${fleet.devices.busy}`
    }),
    cStat({
      label: "任务队列",
      value: String(fleet.queue.pending),
      hint: `待领取 · 领取中 ${fleet.queue.claimed} · 运行中 ${fleet.queue.running} · 停止中 ${fleet.queue.stopping}`
    }),
    cStat({
      label: "设备租约",
      value: String(fleet.leases.filter((lease) => !lease.expired).length),
      hint: `已过期 ${fleet.leases.filter((lease) => lease.expired).length}`
    })
  ].join("")}</div>`;
  const leaseRows = fleet.leases.map((lease) => [
    `<code>${escapeHtml(lease.serial)}</code>`,
    escapeHtml(lease.hostId),
    `<a href="${escapeHtml(taskHref(rootPath, lease.taskId, hostId))}"><code>${escapeHtml(lease.taskId)}</code></a>`,
    relativeTime(lease.expiresAt),
    cBadge({
      label: lease.expired ? "已过期" : "有效",
      tone: lease.expired ? "warning" : "success"
    })
  ]);
  const leases = [
    "<h3>设备租约</h3>",
    renderTable(["设备", "主机", "任务", "到期", "状态"], leaseRows, "暂无设备租约")
  ].join("\n");
  if (detail.runners.length === 0) {
    return [
      '<section id="runners">',
      "<h2>执行机</h2>",
      fleetStats,
      '<p class="empty">暂无执行机心跳（在项目机运行 <code>node dist/cli.js suite runner</code>）</p>',
      leases,
      "</section>"
    ].join("\n");
  }
  const rows = detail.runners.map((runner) => [
    `${cBadge({ label: runner.online ? "在线" : "失联", tone: runner.online ? "success" : "warning" })} <code>${escapeHtml(runner.name)}</code>`,
    escapeHtml(runner.hostname),
    runner.devices.length === 0
      ? '<span class="muted">—</span>'
      : runner.devices
          .map((device) => {
            const label =
              device.name === ""
                ? `${device.platform}:${device.serial}`
                : `${device.platform}:${device.name}(${device.serial})`;
            return `<span class="chip">${escapeHtml(label)}</span>`;
          })
          .join(""),
    toolBadges(runner.tools),
    `${relativeTime(runner.lastSeenAt)}`,
    runner.artifactBaseUrl === null ? "—" : `<code>${escapeHtml(runner.artifactBaseUrl)}</code>`
  ]);
  return [
    '<section id="runners">',
    "<h2>执行机</h2>",
    fleetStats,
    renderTable(["名称", "主机", "设备", "工具", "最后心跳", "产物基址"], rows, "暂无执行机"),
    leases,
    "</section>"
  ].join("\n");
}

function renderTaskList(rootPath: string, detail: PanelProjectDetail, hostId: string | null): string {
  const rows = detail.tasks.map((task) => [
    `<a href="${escapeHtml(taskHref(rootPath, task.id, hostId))}"><code>${escapeHtml(task.id)}</code></a>`,
    cBadge({
      label: `P${task.priority}`,
      tone: task.priority > 0 ? "warning" : "neutral",
      title: "优先级（越大越先领取）"
    }),
    escapeHtml(taskStatusLabel(task.status)),
    String(task.refs),
    escapeHtml(task.platforms.join(", ")),
    String(task.runIds),
    relativeTime(task.createdAt)
  ]);
  return [
    '<section id="tasks">',
    "<h2>任务</h2>",
    renderTable(
      ["任务", "优先级", "状态", "引用用例集数", "目标端", "运行数", "创建时间"],
      rows,
      "暂无任务（从上方「下一步」创建）"
    ),
    "</section>"
  ].join("\n");
}

function renderSchedules(rootPath: string, detail: PanelProjectDetail, hostId: string | null): string {
  const capabilities = currentShell.capabilities;
  const actionsOff =
    capabilities?.actions === false || capabilities?.scopes?.schedules === false;
  const role = capabilities?.role ?? "";
  const readOnlyReason =
    capabilities?.actions === false
      ? capabilities.mode === "standalone"
        ? '独立看板默认只读。用 <code>AOS_PANEL_ACTIONS=1 node dist/cli.js panel --web …</code> 重启（仅 loopback 可用）后即可创建、启停与删除计划；或在 HTTP 模式用 maintainer/admin 身份访问。'
        : `当前身份角色为 <strong>${escapeHtml(role === "" ? "viewer" : role)}</strong>；计划写操作需要 maintainer 或 admin 角色。`
      : `当前角色为 <strong>${escapeHtml(role === "" ? "viewer" : role)}</strong>，没有「计划」写权限；需要 maintainer 或 admin。`;
  const readOnlyNote = actionsOff
    ? `<div class="c-banner c-banner-info" role="status"><strong>只读：定时任务动作已关闭</strong><p>${readOnlyReason}</p></div>`
    : "";
  const featureNames = new Map<string, string>();
  for (const ref of detail.regressionRefs) {
    if (!featureNames.has(ref.featureKey)) featureNames.set(ref.featureKey, ref.featureName);
  }
  const seenFeatureKeys = new Set<string>();
  const featureBoxes: string[] = [];
  for (const ref of detail.regressionRefs) {
    if (seenFeatureKeys.has(ref.featureKey)) continue;
    seenFeatureKeys.add(ref.featureKey);
    featureBoxes.push(
      `<label class="dispatch-option"><input type="checkbox" name="featureKeys" value="${escapeHtml(ref.featureKey)}"> ${escapeHtml(ref.featureName)}（${ref.caseCount} 例）</label>`
    );
  }
  const featureField =
    featureBoxes.length > 0
      ? `<fieldset class="c-fieldset"><legend>功能（可多选）</legend><div class="c-check-grid">${featureBoxes.join("")}</div></fieldset>`
      : `<label class="c-form-field">功能 key <input type="text" name="featureKeys" aria-label="功能 key（暂无可引用用例集，可手输）" size="28" placeholder="login,pay"></label> <span class="muted">暂无可引用用例集；多个用英文逗号分隔</span>`;
  const form = actionsOff
    ? ""
    : [
        `<form id="schedule-form" class="c-form" data-project="${escapeHtml(rootPath)}">`,
        '<div class="c-form-row">',
        '<label class="c-form-field">名称 <input type="text" name="name" aria-label="计划名称" placeholder="例：每日回归" required></label>',
        '<label class="c-form-field">每 <input type="number" name="everyMinutes" aria-label="间隔分钟" value="60" min="1" step="1" style="width:5em"> 分钟</label>',
        "</div>",
        featureField,
        '<fieldset class="c-fieldset"><legend>端</legend><div class="c-check-grid">',
        '<label><input type="checkbox" name="platform" value="android" checked> android</label>',
        '<label><input type="checkbox" name="platform" value="ios"> ios</label>',
        "</div></fieldset>",
        '<p class="c-form-actions"><button class="c-button c-button-primary" type="submit">创建计划</button> <span id="schedule-status" role="status" class="muted"></span></p>',
        "</form>"
      ].join("\n");
  const rows = detail.schedules.map((schedule) => {
    const featureChips = schedule.featureKeys
      .map((key) => {
        const name = featureNames.get(key) ?? key;
        return `<span class="chip" title="${escapeHtml(key)}">${escapeHtml(name)}</span>`;
      })
      .join(" ");
    const cells = [
      escapeHtml(schedule.name),
      featureChips,
      escapeHtml(schedule.platforms.join(", ")),
      `每 ${schedule.everyMinutes} 分钟`,
      schedule.enabled
        ? cBadge({ label: "启用", tone: "success" })
        : cBadge({ label: "停用", tone: "neutral" }),
      `${relativeTime(schedule.lastFiredAt)}${
        schedule.lastNote === null ? "" : ` <span class="note">${escapeHtml(schedule.lastNote)}</span>`
      }`,
      schedule.lastTaskId === null
        ? "—"
        : `<a href="${escapeHtml(taskHref(rootPath, schedule.lastTaskId, hostId))}">${escapeHtml(
            schedule.lastTaskStatus ?? "任务"
          )}</a>`
    ];
    if (!actionsOff) {
      cells.push(
        `<button class="c-button" type="button" data-schedule="${escapeHtml(schedule.id)}" data-op="${
          schedule.enabled ? "disable" : "enable"
        }">${schedule.enabled ? "停用" : "启用"}</button> <button class="c-button c-button-danger" type="button" data-schedule="${escapeHtml(
          schedule.id
        )}" data-op="delete">删除</button>`
      );
    }
    return cells;
  });
  const headers = [
    "名称",
    "功能",
    "端",
    "节奏",
    "状态",
    "上次触发",
    "最近任务",
    ...(actionsOff ? [] : ["操作"])
  ];
  const emptyRow =
    '<div class="c-empty"><p><strong>暂无定时任务</strong></p><p class="muted">创建后由执行机按窗口自动触发；每次触发引用该功能的最新用例集。</p></div>';
  const table =
    rows.length === 0
      ? emptyRow
      : cTable({ columns: headers, rows, caption: "已登记的定时任务" });
  const script = actionsOff
    ? ""
    : `<script>(function(){if(window.__aosSchedulesBound){return;}window.__aosSchedulesBound=true;var root=${JSON.stringify(rootPath).replace(/</g, "\\u003c")};var hostId=${JSON.stringify(hostId).replace(/</g, "\\u003c")};function say(message,ok){var status=document.getElementById('schedule-status');if(!status)return;status.textContent=message;status.className=ok?'ok':'note';}function post(body){return fetch('/panel/api/schedules',{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}function done(message){if(window.aosFlash){window.aosFlash(message);}location.reload();}document.addEventListener('submit',function(e){var form=e.target;if(!form||form.id!=='schedule-form')return;e.preventDefault();var name=String((form.querySelector('input[name="name"]')||{}).value||'').trim();if(name===''){say('请填写计划名称');return;}var boxes=form.querySelectorAll('input[type="checkbox"][name="featureKeys"]');var keys;if(boxes.length>0){keys=Array.prototype.slice.call(boxes).filter(function(box){return box.checked;}).map(function(box){return String(box.value).trim();}).filter(Boolean);}else{var input=form.querySelector('input[name="featureKeys"]');keys=String(input?input.value:'').split(',').map(function(key){return key.trim();}).filter(Boolean);}if(keys.length===0){say('请至少选择一个功能');return;}var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platform"]:checked')).map(function(box){return box.value;});if(platforms.length===0){say('请至少选择一个端');return;}var every=Number((form.querySelector('input[name="everyMinutes"]')||{}).value||0);if(!isFinite(every)||Math.floor(every)!==every||every<=0){say('间隔须为正整数分钟');return;}var button=form.querySelector('button[type="submit"]');if(button)button.disabled=true;post({project:root,host:hostId,action:'create',name:name,featureKeys:keys,platforms:platforms,everyMinutes:every}).then(function(res){if(res.ok&&res.j.ok){done('计划已创建 · 已写入审计');return;}if(button)button.disabled=false;say('创建失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));}).catch(function(err){if(button)button.disabled=false;say('创建失败：'+err);});});document.addEventListener('click',function(e){var button=e.target&&e.target.closest?e.target.closest('button[data-schedule]'):null;if(!button)return;var op=button.getAttribute('data-op');var id=button.getAttribute('data-schedule');function run(){post({project:root,host:hostId,action:op,id:id}).then(function(res){if(res.ok&&res.j.ok){done('计划已更新 · 已写入审计');return;}say('操作失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));}).catch(function(err){say('操作失败：'+err);});}if(op==='delete'){if(window.aosInlineConfirm){window.aosInlineConfirm(button,'确认删除该计划？',run);}else{run();}}else{run();}});})();</script>`;
  return [
    '<section id="schedules">',
    "<h2>定时任务</h2>",
    readOnlyNote,
    form,
    table,
    script,
    "</section>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderTaskPage(view: { rootPath: string; hostId: string | null; detail: PanelTaskDetail; flash?: string }): string {
  const { detail } = view;
  const task = detail.task;
  const refRows = detail.refs.map((ref) => [
    escapeHtml(ref.featureName ?? ref.featureKey),
    `<code>${escapeHtml(ref.caseSetId)}</code>`,
    ref.caseCount === null ? "—" : String(ref.caseCount),
    ref.jsonPath === null
      ? '<span class="muted">（用例集已清理）</span>'
      : `${
          ref.jsonUrl === null
            ? `<code>${escapeHtml(ref.jsonPath)}</code>`
            : `<a href="${escapeHtml(ref.jsonUrl)}" target="_blank" rel="noreferrer"><code>${escapeHtml(ref.jsonPath)}</code></a>`
        }${
          ref.xlsxUrl === null
            ? ""
            : ` · <a href="${escapeHtml(ref.xlsxUrl)}" target="_blank" rel="noreferrer">xlsx</a>`
        }`
  ]);
  const runRows = detail.runs.map((run) => [
    escapeHtml(run.platform),
    escapeHtml(run.device ?? "—"),
    escapeHtml(runStatusLabel(run.status)),
    `${run.passed}/${run.total}`,
    run.failed === 0 ? "0" : `<span class="err">${run.failed}</span>`,
    uiBadge(run.ui) || "—",
    Object.keys(run.failureDomains).length === 0
      ? "—"
      : Object.entries(run.failureDomains)
          .map(
            ([domain, count]) =>
              `<span class="chip" title="${escapeHtml(domain)}">${escapeHtml(failureDomainLabel(domain))} × ${count}</span>`
          )
          .join(""),
    run.comparison === null
      ? "—"
      : `${escapeHtml(run.comparison.baseline === "established" ? "基准建立" : "对比")}：修复 ${run.comparison.fixed} · 回归 ${run.comparison.regressed}`,
    run.manifestPath === null
      ? "—"
      : run.artifacts.manifestUrl === null
        ? `<code>${escapeHtml(run.manifestPath)}</code>`
        : `<a href="${escapeHtml(run.artifacts.manifestUrl)}" target="_blank" rel="noreferrer"><code>${escapeHtml(run.manifestPath)}</code></a>`,
    relativeTime(run.createdAt)
  ]);
  const crossRows = detail.crossPlatform.map((delta) => [
    `<code>${escapeHtml(delta.caseId)}</code>`,
    escapeHtml(delta.name),
    Object.entries(delta.results)
      .map(([platform, outcome]) => `${escapeHtml(platform)}=${escapeHtml(outcome)}`)
      .join(" · ")
  ]);
  const warnings = detail.warnings
    .map((warning) => `<p class="note">${escapeHtml(warning)}</p>`)
    .join("");
  const claimLine =
    task.claimedBy === null
      ? ""
      : detail.runner === null
        ? ` · 领取：<code>${escapeHtml(task.claimedBy)}</code>（未知执行机）`
        : ` · 领取：「${escapeHtml(detail.runner.name)}」（${detail.runner.online ? "在线" : "失联"}）`;
  const cancelParts: string[] = [];
  if (task.cancelSource !== null) cancelParts.push(`来源 ${task.cancelSource}`);
  if (task.cancelledBy !== null) cancelParts.push(`操作人 ${task.cancelledBy}`);
  if (task.cancelledAt !== null) cancelParts.push(`时间 ${task.cancelledAt}`);
  if (task.cancelNote !== null) cancelParts.push(`备注 ${task.cancelNote}`);
  const cancelLine =
    cancelParts.length === 0 ? "" : ` · 取消：${escapeHtml(cancelParts.join(" · "))}`;
  const covered = detail.runners.some(
    (entry) =>
      entry.online && task.platforms.every((platform) => entry.platforms.includes(platform))
  );
  const coverageHint =
    task.status === "pending" && !covered
      ? '<p class="note">当前无在线执行机完整覆盖任务目标端（双端任务需单机双端执行机）；可手动执行或等待执行机上线。</p>'
      : "";
  return page(
    `任务 · ${task.id}`,
    [
      ...(view.flash === undefined
        ? []
        : [
            `<div class="c-banner c-banner-accent" role="status">已派发任务 <code>${escapeHtml(view.flash)}</code>；已写入审计（<a href="/panel?project=${encodeURIComponent(view.rootPath)}&section=audit${hostSuffix(view.hostId)}">查看审计</a>）。</div>`
          ]),
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath, view.hostId))}">项目</a></p>`,
      `<h1>任务 <code>${escapeHtml(task.id)}</code></h1>`,
      `<p>状态：${escapeHtml(taskStatusLabel(task.status))}（<code>${escapeHtml(task.status)}</code>）${claimLine}${cancelLine} · 目标端 ${escapeHtml(task.platforms.join(", "))} · 基线 ${escapeHtml(task.baseline)} · 优先级 P${task.priority} · 创建 ${relativeTime(task.createdAt)} · 共 ${detail.runs.length} 个设备运行${task.attempts > 1 ? ` · 已尝试 ${task.attempts} 次` : ""}${task.createdBy === null ? "" : ` · 来源 ${sourceHtml(task.createdBy)}`}</p>`,
      (() => {
        const badge = cBadge({ label: taskStatusLabel(task.status), tone: taskStatusTone(task.status) });
        const priorityBadge = cBadge({
          label: `P${task.priority}`,
          tone: task.priority > 0 ? "warning" : "neutral",
          title: "优先级（越大越先领取）"
        });
        const actionsOff =
          currentShell.capabilities?.actions === false ||
          currentShell.capabilities?.scopes?.tasks === false;
        if (actionsOff) {
          return `<p>${badge} ${priorityBadge} <button class="c-button" type="button" disabled title="写动作未启用">任务动作</button> <span class="muted">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式。</span></p>`;
        }
        const projectJson = JSON.stringify(view.rootPath).replace(/</g, "\\u003c");
        const taskJson = JSON.stringify(task.id).replace(/</g, "\\u003c");
        const runnerNote =
          detail.runner === null
            ? `${task.claimedBy ?? "无领取方"}（未知执行机）`
            : `${detail.runner.name}（${detail.runner.online ? "在线" : "失联"}）`;
        const running = task.status === "claimed" || task.status === "running";
        const stopping = task.status === "stopping";
        const cancellable =
          task.status === "pending" || running || stopping;
        const cancelConfirm = `确认取消该任务？${running || stopping ? "执行机将在当前用例边界停止并确认（状态先为「停止中」，确认后「已取消」）。" : "任务尚未执行，将直接标记为「已取消」。"}取消为终态：不释放、不自动重试；需重跑请用「重新派发」或新建任务。`;
        const stopConfirm = `确认停止该任务？领取方：${runnerNote}；执行机将在当前用例边界停止后续（已产生设备运行 ${detail.runs.length} 个保留）；状态先为「停止中」，执行机确认后转「已取消」。`;
        const rerunConfirm = "确认重新派发？将按原引用/端/基线创建一个新任务（当前任务保留）。";
        const buttons = [
          cancellable
            ? `<button class="c-button c-button-danger" type="button" data-task-action="cancel" data-confirm="${escapeHtml(cancelConfirm)}">取消任务</button>`
            : "",
          running
            ? `<button class="c-button c-button-danger" type="button" data-task-action="stop" data-confirm="${escapeHtml(stopConfirm)}">停止执行</button>`
            : "",
          stopping
            ? '<span class="muted">停止中：等待执行机确认（离线时为下次心跳读取）；确认后为「已取消」终态</span>'
            : "",
          !running && !stopping && task.status !== "pending"
            ? `<button class="c-button c-button-primary" type="button" data-task-action="rerun" data-confirm="${escapeHtml(rerunConfirm)}">重新派发</button>`
            : "",
          task.status === "pending" ? '<span class="muted">等待执行机领取</span>' : "",
          running ? '<span class="muted">运行中可直接释放回队列，或先「取消任务」等执行机确认</span>' : ""
        ]
          .filter((part) => part !== "")
          .join(" ");
        const actionsScript = `<script>(function(){var project=${projectJson};var taskId=${taskJson};var hostId=${JSON.stringify(view.hostId).replace(/</g, "\\u003c")};var statusEl=document.getElementById('task-action-status');function show(m,ok){statusEl.textContent=m;statusEl.className=ok?'c-banner c-banner-accent':'c-banner c-banner-warn';statusEl.hidden=false;}var paths={stop:'/panel/api/tasks/stop',release:'/panel/api/tasks/release',rerun:'/panel/api/tasks/rerun',cancel:'/panel/api/tasks/cancel'};var noteEl=document.getElementById('task-cancel-note');function aosBindTaskActions(){document.querySelectorAll('[data-task-action]').forEach(function(b){if(b.getAttribute('data-aos-bound')==='1')return;b.setAttribute('data-aos-bound','1');b.addEventListener('click',function(){var action=b.getAttribute('data-task-action');window.aosInlineConfirm(b,b.getAttribute('data-confirm')||'确认执行该动作？',function(){b.disabled=true;fetch(paths[action],{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify({project:project,taskId:taskId,host:hostId,note:action==='cancel'&&noteEl?noteEl.value:undefined})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(!res.ok||res.j.ok===false){throw new Error((res.j&&res.j.error)||('HTTP '+res.status));}if(action==='rerun'){var newId=res.j.task&&res.j.task.id?res.j.task.id:'';window.aosFlash&&aosFlash('已重新派发新任务 '+newId+' · 已写入审计');location.href='/panel?project='+encodeURIComponent(project)+'&task='+encodeURIComponent(newId)+${JSON.stringify(hostSuffix(view.hostId))};return;}window.aosFlash&&aosFlash(action==='stop'?'已请求停止（等待执行机确认） · 已写入审计':action==='cancel'?(res.j&&res.j.status==='cancelled'?'任务已取消':'已请求取消（等待执行机确认）')+' · 已写入审计':'已释放任务回队列 · 已写入审计');location.reload();}).catch(function(e){b.disabled=false;show('动作失败：'+(e&&e.message?e.message:e),false);});});});});}window.aosBindTaskActions=aosBindTaskActions;var prevHook=window.aosOnRefresh;window.aosOnRefresh=function(){aosBindTaskActions();if(typeof prevHook==='function')prevHook();};aosBindTaskActions();})();</script>`;
        return [
          `<p id="task-actions">${badge} ${priorityBadge} ${buttons}${cancellable ? ' <label class="muted">取消备注 <input type="text" id="task-cancel-note" size="24" placeholder="可选（写入任务与审计）"></label>' : ""}</p>`,
          `<p id="task-action-status" role="status" class="c-banner" hidden></p>`,
          actionsScript
        ].join("\n");
      })(),

      coverageHint,
      warnings,
      "</header>",
      "<main>",
      '<section id="refs">',
      "<h2>引用用例集</h2>",
      renderTable(["功能", "用例集", "用例数", "存档路径"], refRows, "无引用", "任务引用用例集"),
      "</section>",
      '<section id="runs">',
      "<h2>设备运行</h2>",
      renderTable(
        ["端", "设备", "状态", "通过", "失败", "UI", "失败域", "对比", "清单", "时间"],
        runRows,
        "暂无运行（触发执行见下方指引）"
      ),
      "</section>",
      '<section id="cross">',
      "<h2>跨端差异</h2>",
      renderTable(["用例", "名称", "结果"], crossRows, "两端结果一致（或仅单端运行）"),
      "</section>",
      '<section id="run-hint">',
      "<h2>触发执行</h2>",
      `<p class="muted">在线执行机会自动领取执行；也可手动：<code>node dist/cli.js suite run --task ${escapeHtml(task.id)} --device &lt;serial&gt;</code>。产物在执行机磁盘（上方清单路径），中心侧仅展示路径。</p>`,
      "</section>",
      "</main>"
    ].join("\n"),
    task.status === "pending" || task.status === "claimed" || task.status === "running" || task.status === "stopping"
      ? 10
      : undefined
  );
}

function renderReviewPage(view: {
  rootPath: string;
  hostId: string | null;
  detail: { items: PanelReviewItem[]; warnings: string[] };
}): string {
  const { items, warnings } = view.detail;
  const appDefects = items.filter((item) => item.verdict === "app-defect");
  const canVerdict =
    currentShell.capabilities?.actions !== false &&
    currentShell.capabilities?.scopes?.verdicts !== false;
  const verdictDisabled = canVerdict ? "" : " disabled";
  const rootJson = JSON.stringify(view.rootPath).replace(/</g, "\\u003c");
  const hostJson = JSON.stringify(view.hostId).replace(/</g, "\\u003c");
  const evidenceCell = (item: PanelReviewItem): string => {
    if (item.evidencePath === null) return "—";
    let present = false;
    try {
      present = fs.statSync(item.evidencePath).isDirectory();
    } catch {
      present = false;
    }
    const link =
      item.evidenceUrl === null
        ? ""
        : ` <a href="${escapeHtml(item.evidenceUrl)}" target="_blank" rel="noreferrer">打开证据</a>`;
    return present
      ? `<code>${escapeHtml(item.evidencePath)}</code>${link}`
      : `<code>${escapeHtml(item.evidencePath)}</code> <span class="muted">[已清理]</span>${link}`;
  };
  const rows = items.map((item) => [
    `<input type="checkbox" name="item" value="${escapeHtml(`${item.runId}|${item.caseId}`)}" aria-label="选择用例 ${escapeHtml(item.caseId)}（${escapeHtml(item.name)}）"${verdictDisabled}>`,
    `<code title="${escapeHtml(item.runId)}">${escapeHtml(item.runId.slice(0, 8))}</code>`,
    relativeTime(item.createdAt),
    `<code>${escapeHtml(item.caseId)}</code>`,
    escapeHtml(item.name),
    escapeHtml(item.featureName ?? "—"),
    escapeHtml(item.platform),
    escapeHtml(item.device ?? "—"),
    escapeHtml(runStatusLabel(item.status)),
    item.failureDomain === null
      ? "—"
      : `${failureDomainHtml(item.failureDomain)}${
          item.failureConfidence === null
            ? ""
            : ` <span class="muted">${escapeHtml(confidenceLabel(item.failureConfidence))}</span>`
        }`,
    escapeHtml(item.failureReason ?? "—"),
    evidenceCell(item),
    item.verdict === null
      ? '<span class="muted">未裁决</span>'
      : `<span class="chip" title="${escapeHtml(item.verdict)}">${escapeHtml(verdictLabel(item.verdict))}</span>${
          item.verdictBy === null ? "" : ` <span class="muted">${escapeHtml(item.verdictBy)}</span>`
        }${item.verdictNote === null ? "" : `<br><span class="muted">${escapeHtml(item.verdictNote)}</span>`}`
  ]);
  const undecided = items.filter((item) => item.verdict === null).length;
  const warningsHtml =
    warnings.length > 0
      ? warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")
      : "";
  const body =
    items.length === 0
      ? [
          '<section id="queue">',
          "<h2>失败用例</h2>",
          '<p class="empty">暂无失败用例（最近 10 次运行无失败，或尚无运行记录——完成下发后此处会列出失败用例）</p>',
          "</section>"
        ]
      : [
          canVerdict ? "" : '<p class="note">当前角色无裁决权限（需要 maintainer）。</p>',
          '<form id="verdict-form" onsubmit="return submitVerdicts(event)">',
          renderTable(
            [
              "选择",
              "运行",
              "时间",
              "用例",
              "名称",
              "功能",
              "端",
              "设备",
              "状态",
              "初判",
              "理由",
              "证据",
              "裁决"
            ],
            rows,
            "暂无失败用例"
          ),
          `<p class="bulk-tools"><button type="button" class="c-button" data-bulk="all"${verdictDisabled}>全选</button> <button type="button" class="c-button" data-bulk="none"${verdictDisabled}>清空</button> <span class="muted">已选 <span id="verdict-count">0</span> 条</span></p>`,
          '<fieldset class="c-fieldset"><legend>裁决（对所选条目批量写入）</legend>',
          `<label><input type="radio" name="verdict" value="case-defect" checked${verdictDisabled}> 案例问题</label> `,
          `<label><input type="radio" name="verdict" value="execution-deviation"${verdictDisabled}> 执行偏差</label> `,
          `<label><input type="radio" name="verdict" value="app-defect"${verdictDisabled}> 应用缺陷</label> `,
          `<label><input type="radio" name="verdict" value="uncertain"${verdictDisabled}> 不确定</label>`,
          "</fieldset>",
          `<p><label>备注：<input type="text" name="note" size="40" placeholder="可选（写入裁决历史）"${verdictDisabled}></label></p>`,
          `<p><button type="submit"${verdictDisabled}>提交裁决</button> <span id="verdict-status" role="status" class="muted"></span></p>`,
          '<p class="note">需启用 JavaScript 提交；勾选多条 → 同一裁决批量写入。</p>',
          "</form>",
          "<script>",
          "function submitVerdicts(event){",
          "  event.preventDefault();",
          "  var form=event.target;",
          "  var items=Array.prototype.slice.call(form.querySelectorAll('input[name=item]:checked')).map(function(el){var idx=el.value.indexOf('|');return {runId:el.value.slice(0,idx),caseId:el.value.slice(idx+1)};});",
          "  var verdict=form.querySelector('input[name=verdict]:checked').value;",
          "  var note=form.querySelector('input[name=note]').value;",
          "  var status=document.getElementById('verdict-status');",
          "  if(items.length===0){status.textContent='请先勾选至少一条失败用例';return false;}",
          "  status.textContent='提交中…';",
          "  fetch('/panel/api/verdicts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:" +
            rootJson +
            ",host:" +
            hostJson +
            ",items:items,verdict:verdict,note:note})})",
          "    .then(function(response){return response.json().then(function(payload){if(!response.ok){throw new Error(payload.error||('HTTP '+response.status));}var parts=['裁决已提交 '+payload.updated+' 条'];if(payload.missed>0)parts.push('跳过 '+payload.missed);if(payload.failed>0)parts.push('失败 '+payload.failed);parts.push('已写入审计');window.aosFlash&&aosFlash(parts.join(' · '));location.reload();});})",
          "    .catch(function(error){status.textContent='提交失败：'+error.message;});",
          "  return false;",
          "}",
          ...bulkBindScript("#verdict-form", "item", "verdict-count"),
          "</script>"
        ];
  return page(
    `失败分析 · ${path.basename(view.rootPath)}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath, view.hostId))}">项目</a></p>`,
      "<h1>失败分析</h1>",
      renderGroupTabs({
        group: "results",
        active: "review",
        project: view.rootPath,
        hostId: view.hostId
      }),
      `<p class="muted">最近 10 次运行的失败用例 · 共 ${items.length} 条 · 未裁决 ${undecided} 条</p>`,
      warningsHtml,
      "</header>",
      "<main>",
      ...(items.length === 0
        ? []
        : [
            cCard({
              title: "失败处理路径",
              subtitle: "发现 → 证据 → 裁决 → 修用例/建单 → 复跑",
              body: [
                "<ol>",
                `<li><strong>发现</strong>：最近 10 次运行的失败用例；当前未裁决 ${undecided} 条。</li>`,
                '<li><strong>证据</strong>：在下方队列查看证据，打开 trace / 截图 / 日志。</li>',
                '<li><strong>裁决</strong>：勾选用例后提交（应用缺陷 / 用例缺陷 / 执行偏差 / 不确定）。</li>',
                `<li><strong>修用例或建单</strong>：<a href="#improvement">改进出口</a> · <a href="${escapeHtml(statsHref(view.rootPath, view.hostId))}#issues">应用缺陷建单</a>。</li>`,
                '<li><strong>复跑</strong>：按 <a href="#run-hint">动作指引</a> 重跑整任务或单用例。</li>',
                "</ol>"
              ].join("\n")
            })
          ]),
      ...(appDefects.length === 0
        ? []
        : [
            `<p><a class="c-button c-button-primary" href="${escapeHtml(statsHref(view.rootPath, view.hostId))}#issues">下一步：去建单（应用缺陷 ${appDefects.length} 条）→</a></p>`
          ]),
      ...body,
      '<section id="run-hint">',
      "<h2>动作指引</h2>",
      '<p class="muted">重跑：<code>node dist/cli.js suite run --task &lt;task-id&gt; --device &lt;serial&gt;</code>（整任务）或 <code>node dist/cli.js suite run --tests &lt;tests.json&gt; --case &lt;caseId&gt; --device &lt;serial&gt;</code>（单用例）。</p>',
      '<p class="muted">隔离：写入 <code>.artemis/design/quarantine.json</code>（owner 签字名单；suite run 默认跳过，<code>--no-quarantine</code> 严格跑）。</p>',
      '<p class="muted">口径：仅「用例集」来源的运行参与统计与改进出口/生成建议；无用例集来源的运行（<code>suite run --tests</code>）的裁决仅存档。</p>',
      "</section>",
      "</main>"
    ].join("\n")
  );
}

const ENVIRONMENT_NOTE_SUMMARY_MAX = 120;

function environmentNoteSummary(notes: string[]): string {
  const joined = notes.join("；");
  if (joined === "") return "—";
  return joined.length <= ENVIRONMENT_NOTE_SUMMARY_MAX
    ? joined
    : `${joined.slice(0, ENVIRONMENT_NOTE_SUMMARY_MAX)}…`;
}

function appDefectBlock(
  rootPath: string,
  hostId: string | null,
  items: PanelImprovementItem[]
): string {
  const title = '<h3 id="issues">应用缺陷 → 建单（Jira）</h3>';
  if (items.length === 0) return `${title}<p class="empty">（空）</p>`;
  const canIssues =
    currentShell.capabilities?.actions !== false &&
    currentShell.capabilities?.scopes?.issues !== false;
  const rootJson = JSON.stringify(rootPath).replace(/</g, "\\u003c");
  const hostJson = JSON.stringify(hostId).replace(/</g, "\\u003c");
  const rows = items.map((item) => [
    `<input type="checkbox" name="issue-item" value="${escapeHtml(`${item.runId}|${item.caseId}`)}" aria-label="选择应用缺陷 ${escapeHtml(item.caseId)}（${escapeHtml(item.name)}）">`,
    `<code>${escapeHtml(item.caseId)}</code>`,
    escapeHtml(item.name),
    escapeHtml(item.featureName ?? "—"),
    item.jiraKey === null || item.jiraKey === ""
      ? '<span class="muted">—</span>'
      : `<span class="chip">${escapeHtml(item.jiraKey)}</span>`
  ]);
  const table = renderTable(["选择", "用例", "名称", "功能", "已建单"], rows, "无应用缺陷裁决", "应用缺陷（可建单）");
  if (!canIssues) {
    return [title, table, '<p class="note">当前角色无建单权限（需要 admin）。</p>'].join("\n");
  }
  if (currentShell.jiraReady === false) {
    return [
      title,
      table,
      '<div class="c-banner c-banner-warn" role="status"><strong>未检测到 Jira 凭据：预览与建单不可用。</strong><p>在项目 .env 配置 <code>JIRA_BASE_URL</code> / <code>JIRA_EMAIL</code> / <code>JIRA_API_TOKEN</code> 后重启会话；建单为外部副作用，未配置时被前置拦截。</p></div>'
    ].join("\n");
  }
  const projectDefault = escapeHtml(currentShell.jiraDefaults?.projectKey ?? "");
  const typeDefault = escapeHtml(currentShell.jiraDefaults?.issueType ?? "");
  const labelsDefault = escapeHtml(currentShell.jiraDefaults?.labels ?? "");
  const script = `<script>(function(){
var form=document.getElementById('issues-form');if(!form)return;
var status=document.getElementById('issues-status');
var result=document.getElementById('issues-result');
var stale=document.getElementById('issues-stale');
var previewBtn=document.getElementById('issues-preview');
var createBtn=document.getElementById('issues-create');
var previewId=null;var issueStatusLabels={preview:'预览',created:'已创建',existing:'已存在',skipped:'跳过',error:'失败'};function issueStatusLabel(s){return issueStatusLabels[s]||s;}
function showStale(on){if(stale)stale.hidden=!on;createBtn.disabled=(on||previewId===null);}
function payload(dryRun){
  var items=Array.prototype.slice.call(form.querySelectorAll('input[name=issue-item]:checked')).map(function(el){var idx=el.value.indexOf('|');return {runId:el.value.slice(0,idx),caseId:el.value.slice(idx+1)};});
  var data={project:${rootJson},host:${hostJson},items:items,dryRun:dryRun};
  if(previewId!==null)data.previewId=previewId;
  var projectKey=form.querySelector('input[name=projectKey]').value.trim();
  var issueType=form.querySelector('input[name=issueType]').value.trim();
  var labels=form.querySelector('input[name=labels]').value.trim();
  if(projectKey!=='')data.projectKey=projectKey;
  if(issueType!=='')data.issueType=issueType;
  if(labels!=='')data.labels=labels;
  return data;
}
function post(data){
  return fetch('/panel/api/issues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json().then(function(j){return {status:r.status,ok:r.ok,j:j};});});
}
function renderResults(results){
  result.replaceChildren();
  var fragment=document.createDocumentFragment();
  if(!results||results.length===0){var empty=document.createElement('p');empty.className='muted';empty.textContent='无结果';fragment.appendChild(empty);result.appendChild(fragment);return;}
  var list=document.createElement('ul');
  results.forEach(function(item){
    var li=document.createElement('li');
    li.appendChild(document.createTextNode(item.caseId+'（'+issueStatusLabel(item.status)+'）'));
    if(item.key){var code=document.createElement('code');code.textContent=' '+item.key;li.appendChild(code);}
    if(item.url){var link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noreferrer';link.textContent=' 打开';li.appendChild(link);}
    if(item.reason){var reason=document.createElement('span');reason.className='muted';reason.textContent=' '+item.reason;li.appendChild(reason);}
    if(item.summary){var summary=document.createElement('span');summary.className='muted';summary.textContent=' '+item.summary;li.appendChild(summary);}
    if(item.attachments&&item.attachments.length){var at=document.createElement('span');at.className='muted';at.textContent=' 将附证据 '+item.attachments.length+' 个';li.appendChild(at);}
    if(item.evidence==='posted'){var ev=document.createElement('span');ev.className='muted';ev.textContent=' 证据已附';li.appendChild(ev);}
    else if(item.evidence==='error'){var ev2=document.createElement('span');ev2.className='muted';ev2.textContent=' 证据附加失败';ev2.setAttribute('data-evidence-note',item.caseId);li.appendChild(ev2);}
    else if(item.evidence==='skipped'){var ev3=document.createElement('span');ev3.className='muted';ev3.textContent=' 无证据（无轨迹）';li.appendChild(ev3);}
    if(item.evidence==='error'&&item.key){var rb=document.createElement('button');rb.type='button';rb.className='c-button';rb.setAttribute('data-evidence-retry',item.runId+'|'+item.caseId);rb.textContent='重试附件';li.appendChild(document.createTextNode(' '));li.appendChild(rb);}
    if(item.attachmentsFailed){var aw=document.createElement('span');aw.className='muted';aw.textContent=' 附件预览失败（不影响建单）';li.appendChild(aw);}
    list.appendChild(li);
  });
  fragment.appendChild(list);
  result.appendChild(fragment);
}
previewBtn.addEventListener('click',function(){
  var data=payload(true);
  if(!data.items.length){status.textContent='请先勾选至少一条应用缺陷';return;}
  previewBtn.disabled=true;status.textContent='预览中…';
  post(data).then(function(res){
    previewBtn.disabled=false;
    if(!res.ok||res.j.ok===false){status.textContent='预览失败：'+(res.j.error||('HTTP '+res.status))+((res.j.hints&&res.j.hints.length>0)?('（'+res.j.hints.join('；')+'）'):'');return;}
    previewId=res.j.previewId||null;
    renderResults(res.j.results);
    showStale(false);
    status.textContent='预览完成（未创建）：将创建 '+res.j.results.filter(function(r){return r.status==='preview';}).length+' 条 · 已存在 '+res.j.existing+' · 跳过 '+res.j.skipped+'。核对后点「建单」。';
  }).catch(function(e){previewBtn.disabled=false;status.textContent='预览失败：'+e.message;});
});
createBtn.addEventListener('click',function(){
  if(previewId===null){status.textContent='请先预览核对（外部副作用防误建）';return;}
  var data=payload(false);
  window.aosInlineConfirm(createBtn,'确认在 Jira 创建外部可见单据（外部副作用）？',function(){
  createBtn.disabled=true;status.textContent='提交中…';
  post(data).then(function(res){
    if(res.status===409||res.j.stale===true){previewId=null;showStale(true);createBtn.disabled=true;renderResults([]);status.textContent='预览已过期：勾选或字段已变化，请重新预览后再建单';return;}
    if(!res.ok||res.j.ok===false){createBtn.disabled=false;status.textContent='失败：'+(res.j.error||('HTTP '+res.status))+((res.j.hints&&res.j.hints.length>0)?('（'+res.j.hints.join('；')+'）'):'');return;}
    previewId=null;
    createBtn.disabled=true;showStale(false);
    renderResults(res.j.results);
    status.textContent='完成：新建 '+res.j.created+' · 已存在 '+res.j.existing+' · 跳过 '+res.j.skipped+' · 失败 '+res.j.failed+((res.j.results||[]).filter(function(r){return r.evidence==='error';}).length>0?' · 证据失败 '+res.j.results.filter(function(r){return r.evidence==='error';}).length:'')+'（明细见下，已写入审计；刷新页面更新「已建单」列）';
    window.aosFlash&&aosFlash('已建单 '+res.j.created+' 张（外部副作用） · 已写入审计');
  }).catch(function(e){createBtn.disabled=false;status.textContent='请求失败：'+e.message;});
  });
});
form.addEventListener('input',function(){previewId=null;showStale(true);});
form.addEventListener('change',function(){previewId=null;showStale(true);});
result.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('[data-evidence-retry]'):null;if(!b)return;var v=b.getAttribute('data-evidence-retry');var idx=v.indexOf('|');var rId=v.slice(0,idx);var cId=v.slice(idx+1);window.aosInlineConfirm(b,'确认向 Jira 单据重试上传证据附件？',function(){b.disabled=true;fetch('/panel/api/issues/evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:${rootJson},host:${hostJson},runId:rId,caseId:cId})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(!res.ok||res.j.ok===false){throw new Error((res.j&&res.j.error)||('HTTP '+res.status));}if(res.j.evidence==='posted'){status.textContent='证据已补传（'+cId+'） · 已写入审计';var notes=result.querySelectorAll('[data-evidence-note]');for(var i=0;i<notes.length;i++){if(notes[i].getAttribute('data-evidence-note')===cId){notes[i].textContent=' 证据已补传';}}if(b.parentNode)b.parentNode.removeChild(b);}else{b.disabled=false;status.textContent='证据重试未成功：'+((res.j&&res.j.reason)||'未知');}}).catch(function(err){b.disabled=false;status.textContent='证据重试失败：'+(err&&err.message?err.message:err);});});});
showStale(false);
})();</script>`;
  return [
    title,
    '<form id="issues-form" onsubmit="return false">',
    table,
    '<p class="bulk-tools"><button type="button" class="c-button" data-bulk="all">全选</button> <button type="button" class="c-button" data-bulk="none">清空</button> <span class="muted">已选 <span id="issues-count">0</span> 条</span></p>',
    `<p><label>Jira 项目：<input type="text" name="projectKey" size="12" value="${projectDefault}" placeholder="默认 JIRA_ISSUE_PROJECT"></label> `,
    `<label>类型：<input type="text" name="issueType" size="10" value="${typeDefault}" placeholder="默认 Bug"></label> `,
    `<label>标签：<input type="text" name="labels" size="20" value="${labelsDefault}" placeholder="逗号分隔"></label></p>`,
    '<p id="issues-stale" role="status" class="c-banner c-banner-warn" hidden>勾选或字段已变化：预览已失效，请重新预览后再建单。</p>',
    '<p><button class="c-button" type="button" id="issues-preview">预览</button> ',
    '<button class="c-button" type="button" id="issues-create" disabled>建单（外部副作用）</button> <span id="issues-status" role="status" class="muted"></span></p>',
    '<div id="issues-result"></div>',
    '<p class="note">建单为外部副作用：必须先「预览」（服务端签发预览回执），再点「建单」；勾选/字段变化会立即作废预览。</p>',
    "</form>",
    script,
    ...bulkBindScript("#issues-form", "issue-item", "issues-count")
  ].join("\n");
}

function renderStatsPage(view: { rootPath: string; hostId: string | null; detail: PanelStatsView }): string {
  const { stats, usage, improvement, guidance, warnings } = view.detail;
  const featureRows = stats.features.map((feature) => [
    `<code>${escapeHtml(feature.featureKey)}</code>`,
    escapeHtml(feature.featureName ?? "—"),
    String(feature.runs),
    feature.passRate === null ? "—" : `${Math.round(feature.passRate * 100)}%`,
    feature.trend
      .map((entry) => (entry === "pass" ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'))
      .join(" "),
    Object.entries(feature.failureDomains)
      .map(
        ([domain, count]) =>
          `<span class="chip" title="${escapeHtml(domain)}">${escapeHtml(failureDomainLabel(domain))} × ${count}</span>`
      )
      .join(" ") || "—",
    Object.entries(feature.verdicts)
      .map(
        ([verdict, count]) =>
          `<span class="chip" title="${escapeHtml(verdict)}">${escapeHtml(verdictLabel(verdict))} × ${count}</span>`
      )
      .join(" ") || "—"
  ]);
  const caseRows = stats.unstableCases.map((entry) => [
    `<code>${escapeHtml(entry.caseId)}</code>`,
    escapeHtml(entry.name),
    escapeHtml(entry.featureName ?? "—"),
    String(entry.runs),
    entry.failed === 0 ? "0" : `<span class="err">${entry.failed}</span>`,
    String(entry.consecutiveFailures),
    String(entry.flaky),
    entry.lastStatus === null ? "—" : escapeHtml(runStatusLabel(entry.lastStatus)),
    entry.lastFailureDomain === null
      ? "—"
      : failureDomainHtml(entry.lastFailureDomain),
    entry.verdict === null
      ? '<span class="muted">未裁决</span>'
      : `<span class="chip" title="${escapeHtml(entry.verdict)}">${escapeHtml(verdictLabel(entry.verdict))}</span>`
  ]);
  const crossRows = stats.crossPlatform.map((delta) => [
    `<code>${escapeHtml(delta.caseId)}</code>`,
    escapeHtml(delta.name),
    Object.entries(delta.results)
      .map(([platform, outcome]) => `${escapeHtml(platform)}=${escapeHtml(outcome)}`)
      .join(" · ")
  ]);
  const improvementList = (title: string, items: PanelImprovementItem[]): string => {
    const body =
      items.length === 0
        ? '<p class="empty">（空）</p>'
        : `<ul>${items
            .map(
              (item) =>
                `<li><code>${escapeHtml(item.caseId)}</code> ${escapeHtml(item.name)}${
                  item.featureName === null ? "" : ` · ${escapeHtml(item.featureName)}`
                }</li>`
            )
            .join("")}</ul>`;
    return `<h3>${escapeHtml(title)}</h3>${body}`;
  };
  const environmentTable = (groups: VerdictEnvironmentGroup[]): string => {
    const rows = groups.map((group) => [
      escapeHtml(group.device ?? "—"),
      escapeHtml(group.platform),
      String(group.count),
      escapeHtml(group.features.join("、") || "—"),
      relativeTime(group.lastAt),
      escapeHtml(environmentNoteSummary(group.notes))
    ]);
    return [
      "<h3>执行偏差 → 环境核对 / 重跑</h3>",
      renderTable(["设备", "端", "次数", "涉及功能", "最近裁决", "备注摘要"], rows, "无执行偏差裁决", "执行偏差按设备")
    ].join("\n");
  };
  const guidanceHtml = guidance
    .map((line) => `<p class="muted">${escapeHtml(line)}</p>`)
    .join("");
  const warningsHtml = warnings
    .map((warning) => `<p class="note">${escapeHtml(warning)}</p>`)
    .join("");
  const usageRows = usage.top.map((entry) => [
    `<code>${escapeHtml(entry.tool)}</code>`,
    String(entry.calls),
    entry.p95 === null ? "—" : String(entry.p95)
  ]);
  const usageHtml = usage.available
    ? [
        '<p class="muted">客户端工具调用口径（内部编排不计入）；耗时为本地观测，不是计费金额。</p>',
        `<p>总调用 ${usage.total} · 成功率 ${Math.round(usage.successRate * 100)}% · p95 ${
          usage.p95 ?? "—"
        } ms · 生成 ${usage.generation.calls}（p95 ${usage.generation.p95 ?? "—"} ms） · 执行 ${
          usage.execution.calls
        }（p95 ${usage.execution.p95 ?? "—"} ms） · 其他 ${usage.other.calls}</p>`,
        renderTable(["工具", "调用", "p95 ms"], usageRows, "无工具调用")
      ].join("\n")
    : '<p class="empty">近 7 天无客户端工具调用（内部编排不计入；AOS_USAGE=0 时采集关闭）。</p>';
  return page(
    `统计 · ${path.basename(view.rootPath)}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath, view.hostId))}">项目</a></p>`,
      "<h1>统计</h1>",
      renderGroupTabs({
        group: "results",
        active: "stats",
        project: view.rootPath,
        hostId: view.hostId
      }),
      warningsHtml,
      "</header>",
      "<main>",
      '<section id="features">',
      "<h2>功能维度</h2>",
      renderTable(
        ["功能", "名称", "运行", "通过率", "趋势", "失败域", "归因构成"],
        featureRows,
        '暂无用例集来源运行（先创建回归任务并执行）'
      ),
      "</section>",
      '<section id="cases">',
      "<h2>最不稳用例</h2>",
      renderTable(
        ["用例", "名称", "功能", "运行", "失败", "连败", "flaky", "最近状态", "最近失败域", "裁决"],
        caseRows,
        "暂无用例数据"
      ),
      "</section>",
      '<section id="cross">',
      "<h2>跨端差异</h2>",
      renderTable(["用例", "名称", "结果"], crossRows, "两端结果一致（或仅单端运行）"),
      "</section>",
      '<section id="usage">',
      "<h2>调用量与耗时（近 7 天）</h2>",
      usageHtml,
      "</section>",
      '<section id="improvement">',
      "<h2>改进出口</h2>",
      improvementList("案例问题（case-defect）→ 修订期望 / 重新生成", improvement.caseDefects),
      environmentTable(improvement.environment),
      appDefectBlock(view.rootPath, view.hostId, improvement.appDefects),
      guidanceHtml,
      "</section>",
      "</main>"
    ].join("\n")
  );
}

function renderProjectPage(view: { rootPath: string; hostId: string | null; detail: PanelProjectDetail }, cacheNote: string): string {
  const { detail } = view;
  const row = detail.project;
  const reasons =
    row.lampReasons.length > 0
      ? `<ul>${row.lampReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
      : "";
  const warnings =
    detail.warnings.length > 0
      ? detail.warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")
      : "";
  const emptyProject =
    detail.batches.length === 0 &&
    detail.tasks.length === 0 &&
    detail.regressionRefs.length === 0;

  return page(
    `项目 · ${row.name}`,
    [
      "<header>",
      '<p><a href="/panel">← 多项目总览</a></p>',
      `<h1>${escapeHtml(row.name)}</h1>`,
      (() => {
        const axis = runnableAxis(detail);
        const health = currentShell.storeHealth;
        const persist =
          health === undefined
            ? "—"
            : health.writeIssue === null || health.label.includes("会话内存")
              ? escapeHtml(health.label)
              : `${escapeHtml(health.label)}（${escapeHtml(health.writeIssue)}）`;
        return `<p>运行：${lampSpan(axis.lamp)}${escapeHtml(axis.note)} · 存储：${persist} · 接入：${row.integration.ready}/${row.integration.total} 就绪${
          row.integration.missing.length > 0
            ? `（缺 ${row.integration.missing.map((item) => escapeHtml(item)).join("、")}；不影响执行）`
            : ""
        }</p>`;
      })(),
      `<p class="muted"><code>${escapeHtml(row.rootPath)}</code> · 最后活跃 ${relativeTime(row.lastSeenAt)} · ${
        row.diskReachable ? "磁盘可达" : "磁盘不可达"
      }</p>`,
      reasons,
      warnings,
      `<p class="muted">生成时间 ${relativeTime(detail.generatedAt)} · ${escapeHtml(cacheNote)}</p>`,
      '<p class="muted">页内：<a href="#tasks">任务</a> · <a href="#runners">执行机</a> · <a href="#schedules">计划</a></p>',
      "</header>",
      "<main>",
      ...(emptyProject ? [renderOnboarding(view.rootPath, view.hostId)] : []),
      renderProjectPulse(detail, view.rootPath, view.hostId),
      ...(emptyProject
        ? [
            '<details class="c-details"><summary>详细状态（批次 / 任务 / 执行机 / 计划）</summary>'
          ]
        : []),
      renderBatches(detail, view.rootPath, view.hostId),
      renderTaskList(view.rootPath, detail, view.hostId),
      renderRunners(detail, view.rootPath, view.hostId),
      renderSchedules(view.rootPath, detail, view.hostId),
      ...(emptyProject ? ["</details>"] : []),
      '<details class="c-details">',
      "<summary>环境自查与明细（接入自检 / 运行时细节 / 磁盘文件 / 单次运行）</summary>",
      renderIntegration(detail),
      renderDeepSection(detail),
      renderDiskAssets(detail),
      renderStandalones(detail),
      "</details>",
      "</main>"
    ].join("\n"),
    15
  );
}

function artifactHref(rootPath: string, filePath: string, hostId?: string | null): string {
  const rel = filePath.startsWith(rootPath)
    ? filePath.slice(rootPath.length).replace(/^[/\\]/, "")
    : filePath;
  return `/panel/artifact?project=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(rel)}${
    hostId ? `&host=${encodeURIComponent(hostId)}` : ""
  }`;
}

function renderEvidence(
  links: PanelBatchDetail["cases"][number]["evidence"],
  rootPath: string,
  hostId: string | null
): string {
  if (links.length === 0) return '<span class="muted">—</span>';
  return links
    .map((link) => {
      const label = `${escapeHtml(link.kind)}: <code>${escapeHtml(link.path)}</code>`;
      if (link.status !== "present") return `${label} <span class="muted">[已清理]</span>`;
      return `<a href="${escapeHtml(artifactHref(rootPath, link.path, hostId))}">${label}</a>`;
    })
    .join("<br>");
}

const DASH_CELL = '<span class="muted">—</span>';

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 24;
const SPARK_PAD = 2;

function clampPassRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampPassRateOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : clampPassRate(value);
}

function sparkNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** 通过率迷你图（纯字符串）：≤10 点、null 断开、0–100 钳制；
 * 仅拼接钳制后的数值，不嵌入任何外部文本。 */
export function trendPassRateSvg(
  points: Array<{ at: string | null; passRate: number | null }>
): string {
  const window = points.slice(-PANEL_COMPARE_TREND_LIMIT);
  if (window.length === 0) return "";
  const coords = window.map((point, index) => {
    const rate = clampPassRateOrNull(point.passRate);
    const x = window.length === 1 ? SPARK_WIDTH / 2 : (index * SPARK_WIDTH) / (window.length - 1);
    const y = rate === null ? null : SPARK_HEIGHT - SPARK_PAD - rate * (SPARK_HEIGHT - SPARK_PAD * 2);
    return { x, y };
  });
  const shapes: string[] = [];
  let segment: Array<{ x: number; y: number }> = [];
  const flush = (): void => {
    if (segment.length >= 2) {
      const path = segment
        .map((point) => `${sparkNumber(point.x)},${sparkNumber(point.y)}`)
        .join(" ");
      shapes.push(`<polyline points="${path}"></polyline>`);
    } else if (segment.length === 1) {
      const only = segment[0];
      shapes.push(
        `<circle cx="${sparkNumber(only.x)}" cy="${sparkNumber(only.y)}" r="1.5"></circle>`
      );
    }
    segment = [];
  };
  for (const coord of coords) {
    if (coord.y === null) flush();
    else segment.push({ x: coord.x, y: coord.y });
  }
  flush();
  if (shapes.length === 0) return "";
  return (
    `<svg class="spark" width="${SPARK_WIDTH}" height="${SPARK_HEIGHT}" viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" role="img" aria-label="通过率趋势（旧→新，断点＝缺数）">` +
    shapes.join("") +
    "</svg>"
  );
}

function renderCompareProjectCell(project: PanelCompareProject): string {
  const reasons =
    project.lampReasons.length > 0
      ? `<div class="muted">${project.lampReasons.map((reason) => escapeHtml(reason)).join("；")}</div>`
      : "";
  const error =
    project.error === null ? "" : `<div class="note">读取失败：${escapeHtml(project.error)}</div>`;
  return `<a href="${escapeHtml(projectHref(project.rootPath, project.hostId))}"><code>${escapeHtml(
    project.name
  )}</code></a> ${lampSpan(project.lamp)}${reasons}${error}`;
}

function renderCompareHostCell(project: PanelCompareProject): string {
  return `<span title="${escapeHtml(project.hostId ?? "未归属主机")}">${escapeHtml(
    project.hostLabel
  )}</span>`;
}

function renderCompareLatestCell(project: PanelCompareProject): string {
  const batch = project.latestBatch;
  if (batch === null) {
    return `<span class="muted">无用例集来源批次</span> <a href="${escapeHtml(
      projectHref(project.rootPath, project.hostId)
    )}">看项目页</a>`;
  }
  const rate =
    batch.passRate === null ? "—" : `${Math.round(clampPassRate(batch.passRate) * 100)}%`;
  return [
    `<div class="muted">${relativeTime(batch.at)}</div>`,
    `${gateSpan(batch.gate)} · ${rate}`
  ].join("");
}

function renderCompareQualityCell(project: PanelCompareProject): string {
  const domains = project.domains.map(
    (entry) =>
      `<span class="chip" title="${escapeHtml(entry.domain)}">${escapeHtml(failureDomainLabel(entry.domain))} × ${entry.count}</span>`
  );
  return [`flaky ${project.flaky}`, ...domains].join(" ");
}

function renderCompareTodoCell(project: PanelCompareProject): string {
  const backlog = project.taskBacklog;
  const open = backlog.pending + backlog.claimed + backlog.running;
  return [
    `<div>未裁决失败 ${project.pendingVerdicts} 条 · 未建单缺陷 ${project.unissuedAppDefects} 项</div>`,
    `<div>任务积压 ${open}（待 ${backlog.pending} / 领 ${backlog.claimed} / 跑 ${backlog.running}） · 失败 ${backlog.failed}</div>`
  ].join("");
}

function renderCompareRunCell(project: PanelCompareProject): string {
  return [
    `<div>执行机 在线 ${project.runners.online} · 设备 ${project.runners.devices}</div>`,
    `<div>定时任务 启用 ${project.schedules.enabled} · 最近触发 ${escapeHtml(
      project.schedules.lastFiredAt ?? "—"
    )}</div>`
  ].join("");
}

function renderCompareRow(project: PanelCompareProject): string[] {
  const projectCell = renderCompareProjectCell(project);
  const hostCell = renderCompareHostCell(project);
  if (project.error !== null) {
    return [projectCell, hostCell, DASH_CELL, DASH_CELL, DASH_CELL, DASH_CELL, DASH_CELL];
  }
  const spark = trendPassRateSvg(project.trend);
  return [
    projectCell,
    hostCell,
    renderCompareLatestCell(project),
    spark === "" ? DASH_CELL : spark,
    renderCompareQualityCell(project),
    renderCompareTodoCell(project),
    renderCompareRunCell(project)
  ];
}

function renderFeatureAlignmentSection(view: PanelCompareView): string {
  const { groups, unmatched } = view.featureAlignment;
  const scope = [
    "匹配规则：设计源归一化（figma:fileKey / pen:相对路径 / 相对化路径）＋功能名归一（NFC·trim·折叠空白·小写）一致才成组",
    `窗口＝用例集最近 ${view.window.runs} 批`,
    "误报口径：flaky 为窗口内累加；未裁决＝状态非 passed 且未裁决的用例数",
    `未匹配 ${unmatched} 个（仅单项目出现）`
  ].join("；");

  if (groups.length === 0) {
    return [
      '<section id="feature-alignment">',
      "<h2>功能对齐（跨项目）</h2>",
      `<p class="muted">${escapeHtml(scope)}</p>`,
      '<p class="empty">暂无跨项目对齐的功能（同名同源在 ≥2 个项目出现才成组）</p>',
      "</section>"
    ].join("\n");
  }

  const blocks = groups.map((group) => {
    const header = `${escapeHtml(group.displayName)} · <span class="muted">${escapeHtml(
      group.sourceLabel
    )} · ${group.entries.length} 个项目</span>`;
    const rows = group.entries.map((entry) => [
      escapeHtml(entry.project),
      entry.passRate === null ? "—" : `${Math.round(clampPassRate(entry.passRate) * 100)}%`,
      String(entry.runs),
      String(entry.flaky),
      String(entry.pendingVerdicts),
      relativeTime(entry.latestAt)
    ]);
    return [
      `<h3>${header}</h3>`,
      renderTable(["项目", "通过率", "批次", "flaky", "未裁决", "最近"], rows, "—")
    ].join("\n");
  });

  return [
    '<section id="feature-alignment">',
    "<h2>功能对齐（跨项目）</h2>",
    `<p class="muted">${escapeHtml(scope)}</p>`,
    blocks.join("\n"),
    "</section>"
  ].join("\n");
}

function renderComparePage(view: PanelCompareView, cacheNote: string): string {
  const rows = view.projects.map((project) => renderCompareRow(project));
  const warnings = view.warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("");
  const scope = [
    `口径：窗口＝用例集最近 ${view.window.runs} 批`,
    "仅计入「用例集」来源批次（suite run --tests／单次运行等其余来源见项目页）",
    `任务积压为最近 ${PANEL_COMPARE_TASK_LIMIT} 条近似`,
    `执行机为最近 ${PANEL_COMPARE_RUNNER_LIMIT} 条近似`,
    "数据源＝中央台账",
    "精确待办以失败分析为准"
  ].join("；");
  return page(
    "多项目对比",
    [
      "<header>",
      '<p><a href="/panel">← 多项目总览</a></p>',
      "<h1>多项目对比</h1>",
      `<p class="muted">生成时间 ${relativeTime(view.generatedAt)} · 项目 ${view.projects.length} 个${
        view.truncated ? "（已截断）" : ""
      }${view.excludedProjects > 0 ? ` · 已隐藏 ${view.excludedProjects} 个排除项目` : ""} · ${escapeHtml(cacheNote)}</p>`,
      `<p class="muted">${escapeHtml(scope)}</p>`,
      warnings,
      "</header>",
      "<main>",
      cCard({
        title: "项目对比",
        body: cTable({
          columns: [
            "项目",
            "主机",
            "最近用例集批次（时间·门禁·通过率）",
            "趋势（最近 10 批）",
            "质量（flaky·失败域 top3）",
            "待办（未裁决·未建单·积压·failed）",
            "执行（执行机·定时任务）"
          ],
          rows,
          caption: "项目对比矩阵",
          empty: "暂无项目"
        })
      }),
      renderFeatureAlignmentSection(view),
      "</main>"
    ].join("\n")
  );
}

function renderBatchPage(view: { rootPath: string; hostId: string | null; detail: PanelBatchDetail }): string {
  const { detail } = view;
  const meta = [
    `来源 ${sourceHtml(detail.source)}`,
    `开始 ${relativeTime(detail.startedAt)}`,
    `结束 ${relativeTime(detail.finishedAt)}`,
    detail.taxonomyVersion === null ? "失败域口径 —" : `失败域口径 v${detail.taxonomyVersion}`
  ].join(" · ");

  if (detail.read !== "ok") {
    return page(
      `批次 · ${detail.file}`,
      [
        "<header>",
        `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath, view.hostId))}">项目</a></p>`,
        `<h1>批次 ${escapeHtml(detail.runId ?? detail.file)}</h1>`,
        `<p class="muted">${meta}</p>`,
        "</header>",
        "<main>",
        '<section id="batch">',
        "<h2>批次详情</h2>",
        `<p class="note">读取结果：${escapeHtml(detail.read)}${
          detail.note !== null ? ` · ${escapeHtml(detail.note)}` : ""
        }</p>`,
        `<p>${apiReviewBadge(detail.apiReview)}</p>`,
        "</section>",
        "</main>"
      ].join("\n")
    );
  }

  const summary = detail.summary;
  const failureDomains =
    detail.failureDomains === null || Object.keys(detail.failureDomains).length === 0
      ? '<p class="empty">无失败域汇总</p>'
      : `<p>${Object.entries(detail.failureDomains)
          .map(
            ([domain, count]) =>
              `<span class="chip" title="${escapeHtml(domain)}">${escapeHtml(failureDomainLabel(domain))} × ${count}</span>`
          )
          .join("")}</p>`;
  const gate = detail.gate;
  const cases = detail.cases.map((entry) => [
    `<code>${escapeHtml(entry.caseId)}</code>`,
    escapeHtml(entry.name),
    entry.status === "passed" ? '<span class="ok">通过</span>' : `<span class="err c-nowrap">${escapeHtml(entry.status)}</span>`,
    uiCaseCell(entry.ui),
    entry.failure === null
      ? '<span class="muted">—</span>'
      : `${escapeHtml(entry.failure.domain)}（${escapeHtml(entry.failure.confidence)}）<div class="muted">${escapeHtml(
          entry.failure.reason
        )}</div>`,
    entry.scriptProvenance === null
      ? "—"
      : `断言 ${entry.scriptProvenance.asserts} / 探索 ${entry.scriptProvenance.explores}`,
    [entry.quarantined ? "隔离" : null, entry.flaky ? "flaky" : null]
      .filter((tag): tag is string => tag !== null)
      .join("、") || "—",
    renderEvidence(entry.evidence, view.rootPath, view.hostId)
  ]);
  const options = detail.options;
  const optionRows: string[][] = options
    ? [
        ["模型", options.model ?? "—"],
        ["设备", options.deviceSerial ?? "—"],
        ["应用", options.lockedAppPackage ?? "—"],
        ["maxCases", options.maxCases === null ? "—" : String(options.maxCases)],
        ["stopOnFailure", options.stopOnFailure ? "是" : "否"],
        ["strict", options.strict ? "是" : "否"],
        ["failOnUncovered", options.failOnUncovered ? "是" : "否"],
        ["retry", String(options.retry)],
        ["隔离用例", options.quarantinedCaseIds.length === 0 ? "—" : options.quarantinedCaseIds.join("、")]
      ]
    : [];
  const tests = detail.tests;
  const warnings =
    detail.warnings.length > 0
      ? detail.warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")
      : "";
  const readiness = detail.readiness;
  const readinessBody = readiness.needed
    ? [
        '<section id="readiness">',
        "<h2>接入检查（按失败证据）</h2>",
        '<p class="c-readiness-lead">失败不一定是应用缺陷。按顺序核查，确认后再决定是否重写。</p>',
        '<ol class="c-readiness">',
        ...readiness.checks.map((check, index) => {
          const count = [
            check.caseIds.length > 0 ? `${check.caseIds.length} 例` : "",
            check.traceIds.length > 0 ? `${check.traceIds.length} trace` : ""
          ]
            .filter((part) => part !== "")
            .join(" · ");
          const refs = [
            check.caseIds.length > 0
              ? `用例 ${check.caseIds
                  .map((id) => `<code class="c-id">${escapeHtml(id)}</code>`)
                  .join("、")}`
              : "",
            check.traceIds.length > 0
              ? `trace ${check.traceIds
                  .map((id) => `<code class="c-id">${escapeHtml(id)}</code>`)
                  .join("、")}`
              : ""
          ]
            .filter((part) => part !== "")
            .join(" · ");
          return `<li><details class="c-readiness-item" data-readiness-code="${check.code}"><summary><span class="c-readiness-step" aria-hidden="true">${index + 1}</span><span class="c-readiness-title">[${check.code}] ${escapeHtml(INTEGRATION_LABELS[check.code])}</span><span class="c-readiness-action">${escapeHtml(INTEGRATION_ACTIONS[check.code])}</span><span class="c-readiness-count">${escapeHtml(count)}</span><span class="c-readiness-toggle" aria-hidden="true"></span></summary><div class="c-readiness-body"><p>${escapeHtml(check.message)}</p>${
            refs === "" ? "" : `<p class="c-readiness-refs">关联：${refs}</p>`
          }</div></details></li>`;
        }),
        "</ol>",
        "</section>"
      ].join("\n")
    : "";

  return page(
    `批次 · ${detail.runId ?? detail.file}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath, view.hostId))}">项目</a></p>`,
      `<h1>批次 ${escapeHtml(detail.runId ?? detail.file)}</h1>`,
      `<p class="muted">${meta}</p>`,
      gate === null
        ? ""
        : `<p>门禁：${gateSpan(gate.result === "pass" ? "pass" : "fail")}（exit ${gate.exitCode}${
            gate.reasons.length > 0 ? ` · ${gate.reasons.map((reason) => escapeHtml(reason)).join("、")}` : ""
          }）</p>`,
      detail.designWarnings === null
        ? '<p class="muted">设计源警告：未记录（运行期无 preflight 摘要）</p>'
        : `<p class="muted">${escapeHtml(designWarningsText(detail.designWarnings))}</p>`,
      `<p>${apiReviewBadge(detail.apiReview)}</p>`,
      warnings,
      "</header>",
      "<main>",
      '<section id="summary">',
      "<h2>结果概览</h2>",
      uiBadge(detail.ui, detail.uiCoverage) === "" ? "" : `<p>${uiBadge(detail.ui, detail.uiCoverage)}</p>`,
      summary === null
        ? ""
        : [
            '<div class="cards">',
            `<div class="card"><div class="k">用例</div><div class="v">${summary.total ?? "—"}</div></div>`,
            `<div class="card"><div class="k">通过</div><div class="v">${summary.passed ?? "—"}</div></div>`,
            `<div class="card"><div class="k">失败</div><div class="v">${summary.failed ?? "—"}</div></div>`,
            "</div>"
          ].join(""),
      "<h3>失败域汇总</h3>",
      failureDomains,
      "</section>",
      readinessBody,
      '<section id="cases">',
      "<h2>用例结果</h2>",
      cTable({
        columns: ["用例", "名称", "状态", "UI", "失败域", "脚本来源", "标记", "证据"],
        rows: cases,
        empty: "暂无用例",
        columnWidths: ["13%", "12%", "7%", "6%", "31%", "9%", "6%", "16%"]
      }),
      "</section>",
      '<section id="context">',
      "<h2>批次上下文</h2>",
      optionRows.length === 0
        ? ""
        : cTable({
            columns: ["选项", "值"],
            rows: optionRows,
            empty: "—",
            columnWidths: ["16%", "84%"]
          }),
      tests === null
        ? ""
        : `<p class="muted">tests：<code>${escapeHtml(tests.path)}</code> · sha256 ${
            tests.sha256 === null ? "—" : escapeHtml(tests.sha256.slice(0, 12))
          } · 生成 ${escapeHtml(tests.generatedAt ?? "—")}</p>`,
      "</section>",
      "</main>"
    ]
      .filter((part) => part !== "")
      .join("\n")
  );
}

function page(title: string, bodyParts: string, refreshSeconds?: number): string {
  return renderConsoleShell({
    title,
    active: currentShell.active,
    project: currentShell.project,
    projectHostId: currentShell.projectHostId ?? null,
    capabilities: currentShell.capabilities,
    storeHealth: currentShell.storeHealth,
    projectSwitcher: currentShell.projectSwitcher,
    ...(currentShell.project === null
      ? {}
      : { meta: `项目 <code>${escapeHtml(path.basename(currentShell.project))}</code>` }),
    ...(refreshSeconds === undefined ? {} : { autoRefreshSeconds: refreshSeconds }),
    body: bodyParts.replaceAll("<main>", "").replaceAll("</main>", "")
  });
}

interface ShellCtx {
  active: ConsoleNavKey | null;
  project: string | null;
  projectHostId?: string | null;
  capabilities?: ConsoleCapabilities;
  jiraDefaults?: { projectKey?: string; issueType?: string; labels?: string };
  /** 进程 env 中 Jira 凭据三件套齐备（未提供 → 未知，不前置拦截；服务端仍硬闸）。 */
  jiraReady?: boolean;
  storeHealth?: ConsoleShellInput["storeHealth"];
  projectSwitcher?: ConsoleShellInput["projectSwitcher"];
}

let currentShell: ShellCtx = { active: "overview", project: null };

function activeForView(view: PanelView): ConsoleNavKey | null {
  switch (view.kind) {
    case "overview":
    case "compare":
      return "overview";
    case "dispatch":
      return "dispatch";
    case "library":
      return "library";
    case "archive":
      return "archive";
    case "audit":
      return "ops";
    case "events":
      return "ops";
    case "ops":
      return "ops";
    case "project":
      return view.active === "tasks" || view.active === "runners" || view.active === "schedules"
        ? "project"
        : (view.active ?? "project");
    case "review":
      return "review";
    case "stats":
      return "review";
    case "batch":
      return "project";
    case "search":
      return null;
    default:
      return "project";
  }
}

function coherentStoreNote(kind: ProjectStore["kind"], note: string | null): string | null {
  if (note === null || note.trim() === "") return null;
  if (kind === "memory" && !note.includes("内存")) {
    return "会话内存：数据仅当前进程内有效（未配置持久台账）。";
  }
  return note;
}

async function loadStoreHealth(
  deps: PanelWebDeps,
  view: PanelView
): Promise<NonNullable<ConsoleShellInput["storeHealth"]>> {
  const kind = deps.store.kind;
  const health = (
    deps.store as { writeErrors?: () => { count: number; lastError: string | null } }
  ).writeErrors?.();
  const project =
    view.kind === "overview" || view.kind === "compare" || view.kind === "search"
      ? null
      : view.rootPath;
  const projectHostId =
    view.kind === "overview" || view.kind === "compare" || view.kind === "search"
      ? null
      : view.hostId;
  let lastWriteAt: string | null = null;
  if (project !== null) {
    try {
      const recent = await deps.store.listAudit(project, { limit: 1 });
      lastWriteAt = recent[0]?.at ?? null;
    } catch {
      /* best effort：指示器不阻断页面 */
    }
  }
  return {
    label: storeKindLabel(kind),
    lastWriteAt,
    writeIssue:
      health && health.count > 0
        ? `写失败 ${health.count} 次`
        : kind === "memory"
          ? "会话内存（不持久）"
          : null,
    opsHref:
      project === null
        ? null
        : `/panel?project=${encodeURIComponent(project)}&section=ops${hostSuffix(projectHostId)}`
  };
}

async function buildSearch(deps: PanelWebDeps, query: string): Promise<SearchPageData> {
  const data: SearchPageData = { q: query, projects: [], caseSets: [], tasks: [], truncated: false };
  if (query === "") return data;
  const needle = query.toLowerCase();
  const excludeRaw = (deps.env ?? process.env).AOS_PANEL_EXCLUDE_PROJECTS;
  const projects = (await deps.store.listProjects().catch(() => [])).filter(
    (project) => !panelProjectExcluded(project, excludeRaw)
  );
  const capped = projects.slice(0, 50);
  data.truncated = projects.length > capped.length;
  for (const project of capped) {
    if (
      project.name.toLowerCase().includes(needle) ||
      project.rootPath.toLowerCase().includes(needle)
    ) {
      if (data.projects.length < 20)
        data.projects.push({
          name: project.name,
          rootPath: project.rootPath,
          hostId: project.hostId
        });
      else data.truncated = true;
    }
    const projectStore = hostScopedStore(deps, project.hostId);
    const sets = await projectStore.listCaseSets(project.rootPath).catch(() => []);
    for (const set of sets) {
      const matched =
        set.basename.toLowerCase().includes(needle) ||
        set.source.toLowerCase().includes(needle) ||
        set.features.some(
          (feature) =>
            feature.name.toLowerCase().includes(needle) ||
            feature.key.toLowerCase().includes(needle)
        );
      if (!matched) continue;
      if (data.caseSets.length >= 20) {
        data.truncated = true;
        break;
      }
      data.caseSets.push({
        project: project.rootPath,
        hostId: project.hostId,
        id: set.id,
        basename: set.basename,
        source: set.source,
        features: set.features.map((feature) => feature.name).join("、")
      });
    }
    const tasks = await projectStore.listRegressionTasks(project.rootPath, 50).catch(() => []);
    for (const task of tasks) {
      if (!task.id.toLowerCase().includes(needle)) continue;
      if (data.tasks.length >= 20) {
        data.truncated = true;
        break;
      }
      data.tasks.push({ project: project.rootPath, hostId: project.hostId, id: task.id, status: task.status });
    }
  }
  return data;
}

async function loadProjectSwitcher(
  deps: PanelWebDeps,
  view: PanelView
): Promise<NonNullable<ConsoleShellInput["projectSwitcher"]>> {
  const current =
    view.kind === "overview" || view.kind === "compare" || view.kind === "search"
      ? null
      : view.rootPath;
  const currentHostId =
    view.kind === "overview" || view.kind === "compare" || view.kind === "search"
      ? null
      : view.hostId;
  const excludeRaw = (deps.env ?? process.env).AOS_PANEL_EXCLUDE_PROJECTS;
  const projects = (await deps.store.listProjects().catch(() => [])).filter(
    (project) => !panelProjectExcluded(project, excludeRaw)
  );
  const hosts = await deps.store.listHosts().catch(() => []);
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const options = projects.slice(0, 20).map((project) => {
    const host = project.hostId === null ? null : (hostById.get(project.hostId) ?? null);
    const hostLabel =
      project.hostId === null
        ? ""
        : host !== null && host.label !== null && host.label !== ""
          ? host.label
          : host !== null && host.hostname !== ""
            ? host.hostname
            : project.hostId.slice(0, 8);
    return {
      label: hostLabel === "" ? project.name : `${project.name} · ${hostLabel}`,
      href: projectHref(project.rootPath, project.hostId),
      ...(current !== null && project.rootPath === current && project.hostId === currentHostId
        ? { current: true }
        : {})
    };
  });
  const labelCounts = new Map<string, number>();
  for (const option of options) labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
  for (const [index, option] of options.entries()) {
    if ((labelCounts.get(option.label) ?? 0) > 1) {
      option.label = `${option.label}（${projects[index]!.rootPath}）`;
    }
  }
  return { options };
}

function renderPanelHtml(
  view: PanelView,
  deps: PanelWebDeps,
  storeHealth?: ConsoleShellInput["storeHealth"],
  projectSwitcher?: ConsoleShellInput["projectSwitcher"]
): string {
  setConsoleShellDefaults({ storeHealth, projectSwitcher, capabilities: deps.capabilities });
  currentShell = {
    active: activeForView(view),
    project: view.kind === "overview" || view.kind === "compare" || view.kind === "search" ? null : view.rootPath,
    projectHostId:
      view.kind === "overview" || view.kind === "compare" || view.kind === "search" ? null : view.hostId,
    capabilities: deps.capabilities,
    jiraDefaults: {
      projectKey: deps.env?.JIRA_ISSUE_PROJECT?.trim() || undefined,
      issueType: deps.env?.JIRA_ISSUE_TYPE?.trim() || undefined,
      labels: deps.env?.JIRA_ISSUE_LABELS?.trim() || undefined
    },
    storeHealth,
    projectSwitcher,
    jiraReady: (() => {
      const env = deps.env ?? {};
      const jiraKeys = Object.keys(env).filter((key) => key.startsWith("JIRA_"));
      if (jiraKeys.length === 0) return undefined;
      return Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
    })()
  };
  const cacheNote = "缓存 TTL 内数据可能滞后（AOS_PANEL_CACHE_MS）";
  if (view.kind === "overview") return renderOverviewPage(view.overview, cacheNote);
  if (view.kind === "compare") return renderComparePage(view.compare, cacheNote);
  if (view.kind === "dispatch") {
    return renderDispatchPage({
      rootPath: view.rootPath,
      rootLabel: view.rootLabel,
      hostId: view.hostId,
      legacyHostless: view.legacyHostless === true,
      preview: view.preview,
      previewId: view.previewId,
      formSignature: view.formSignature,
      query: view.query,
      capabilities: deps.capabilities,
      storeHealth: currentShell.storeHealth,
      priorityEditable: (deps.env ?? process.env).AOS_PANEL_PRIORITY?.trim() === "1"
    });
  }
  if (view.kind === "library") {
    return renderLibraryPage({
      rootPath: view.rootPath,
      rootLabel: view.rootLabel,
      hostId: view.hostId,
      sets: view.sets,
      quarantine: view.quarantine,
      caseCandidates: view.caseCandidates,
      capabilities: deps.capabilities,
      storeHealth: currentShell.storeHealth
    });
  }
  if (view.kind === "archive") {
    return renderArchivePage({
      rootPath: view.rootPath,
      rootLabel: view.rootLabel,
      hostId: view.hostId,
      artifacts: view.artifacts,
      query: view.query,
      page: view.page,
      storeHealth: currentShell.storeHealth
    });
  }
  if (view.kind === "audit") {
    return renderAuditPage({
      rootPath: view.rootPath,
      rootLabel: view.rootLabel,
      hostId: view.hostId,
      events: view.events,
      query: view.query,
      page: view.page,
      storeHealth: currentShell.storeHealth
    });
  }
  if (view.kind === "events") {
    return renderEventsPage({
      rootPath: view.rootPath,
      rootLabel: view.rootLabel,
      hostId: view.hostId,
      events: view.events,
      query: view.query,
      includePayload: view.includePayload,
      error: view.error,
      storeHealth: currentShell.storeHealth
    });
  }
  if (view.kind === "ops") {
    return renderOpsPage({
      rootPath: view.rootPath,
      rootLabel: view.rootLabel,
      hostId: view.hostId,
      storeKind: view.storeKind,
      storeLabel: storeKindLabel(view.storeKind),
      storeNote: coherentStoreNote(view.storeKind, view.storeNote),
      writeError: view.writeError,
      artifacts: view.artifacts,
      capabilities: deps.capabilities,
      storeHealth: currentShell.storeHealth
    });
  }
  if (view.kind === "project") return renderProjectPage(view, cacheNote);
  if (view.kind === "search") return renderSearchPage(view.data);
  if (view.kind === "task") return renderTaskPage(view);
  if (view.kind === "review") return renderReviewPage(view);
  if (view.kind === "stats") return renderStatsPage(view);
  return renderBatchPage(view);
}
