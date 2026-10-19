import { createHash } from "node:crypto";

import type { ProjectStore, SuiteRunCaseRecord, SuiteRunRecord } from "../db/types.js";
import { recordAuditSafe } from "../db/audit-event.js";
import {
  buildRegressionIssueDescription,
  buildRegressionIssueSummary,
  type RegressionIssueFacts
} from "../jira/issue-template.js";
import { postEvidenceToIssue, type JiraEvidencePostArgs } from "../jira/post.js";
import { jiraMissingConfigPayload, resolveJiraClient } from "../jira/resolve.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, log } from "../util.js";
import { artifactUrl } from "./overview.js";

/** 面板一键建单（回归服务 P3b）：外部副作用（Jira create/evidence）＋准入语义。
 * 建单路径只读配置＋trace 产物，不拉起子进程；注入缝（clientFor/postEvidence）供离线测试。 */

export const MAX_ISSUE_ITEMS = 20;

const JIRA_ISSUE_PROJECT = "JIRA_ISSUE_PROJECT";
const JIRA_ISSUE_TYPE = "JIRA_ISSUE_TYPE";
const JIRA_ISSUE_LABELS = "JIRA_ISSUE_LABELS";

export interface IssueClientLike {
  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }>;
}

export interface CreateIssuesOptions {
  store: ProjectStore;
  /** 缺省 → 无 Runtime，返回指引错误。 */
  runtimeFor?: (rootPath: string) => Promise<Runtime | null>;
  /** 缺省 resolveJiraClient。 */
  clientFor?: (runtime: Runtime) => { client: IssueClientLike; siteUrl: string } | null;
  /** 缺省 postEvidenceToIssue。 */
  postEvidence?: (runtime: Runtime, args: JiraEvidencePostArgs) => Promise<Record<string, unknown>>;
}

export type IssueItemStatus = "created" | "existing" | "skipped" | "error" | "preview";

export interface IssueItemResult {
  runId: string;
  caseId: string;
  status: IssueItemStatus;
  key?: string;
  url?: string;
  evidence?: "posted" | "skipped" | "error";
  summary?: string;
  attachments?: string[];
  reason?: string;
}

export type IssuesOutcome =
  | {
      ok: true;
      /** 预览回执：dryRun 签发；建单必须原样携带（服务端复算比对）。 */
      previewId: string;
      results: IssueItemResult[];
      created: number;
      existing: number;
      skipped: number;
      failed: number;
    }
  | { ok: false; error: string; hints?: string[]; stale?: boolean };

/** 预览回执哈希：勾选（排序后）＋项目/类型/标签（归一后）＋标题覆盖。 */
export function issuePreviewId(input: {
  items: Array<{ runId: string; caseId: string }>;
  projectKey: string;
  issueType: string;
  labels: string[];
  summary?: string | null;
}): string {
  const items = input.items
    .map((item) => `${item.runId}|${item.caseId}`)
    .sort()
    .join(",");
  const labels = [...input.labels].sort().join(",");
  return createHash("sha256")
    .update(`${items}#${input.projectKey}#${input.issueType}#${labels}#${input.summary ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

const defaultRuntimeFor = async (): Promise<Runtime | null> => null;
const defaultClientFor = (runtime: Runtime) => resolveJiraClient(runtime);

/** labels 归一：逗号串或字符串数组 → 去空串 + 去重。 */
export function normalizeLabels(source: string | string[] | null | undefined): string[] {
  if (source == null) return [];
  const tokens = Array.isArray(source) ? source : source.split(",");
  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token !== ""))];
}

function resolverValue(runtime: Runtime, name: string): string | null {
  return runtime.project.resolver.getValue(name).value;
}

function evidencePlatform(platform: string): "android" | "ios" | undefined {
  return platform === "ios" || platform === "android" ? platform : undefined;
}

/** 产物基址：任务 ID → 领取 runner 的 artifact_base_url（尽力；失败仅日志）。 */
async function artifactBaseByTaskId(
  store: ProjectStore,
  rootPath: string
): Promise<Map<string, string | null>> {
  const baseByTaskId = new Map<string, string | null>();
  try {
    const runnerById = new Map(
      (await store.listRunners(rootPath)).map((runner) => [runner.id, runner])
    );
    for (const task of await store.listRegressionTasks(rootPath, 50)) {
      const runner = task.claimedBy === null ? undefined : runnerById.get(task.claimedBy);
      baseByTaskId.set(task.id, runner?.artifactBaseUrl ?? null);
    }
  } catch (error) {
    log(`产物基址解析失败（尽力）：${errorMessage(error)}`);
  }
  return baseByTaskId;
}

interface ItemContext {
  rootPath: string;
  runtime: Runtime;
  client: IssueClientLike;
  siteUrl: string;
  postEvidence: (runtime: Runtime, args: JiraEvidencePostArgs) => Promise<Record<string, unknown>>;
  projectKey: string;
  issueType: string;
  labels: string[];
  summaryInput: string | undefined;
  dryRun: boolean;
  baseByTaskId: Map<string, string | null>;
}

function buildFacts(ctx: ItemContext, run: SuiteRunRecord, c: SuiteRunCaseRecord): RegressionIssueFacts {
  const traceId = c.traceId ?? null;
  const evidencePath = traceId !== null ? ctx.runtime.traceDir(traceId) : null;
  const base =
    run.regressionTaskId === null ? null : (ctx.baseByTaskId.get(run.regressionTaskId) ?? null);
  return {
    runId: run.id,
    taskId: run.regressionTaskId,
    featureName: run.featureName,
    platform: run.platform,
    device: run.device,
    appVersion: run.appVersion,
    runAt: run.startedAt,
    caseId: c.caseId,
    caseName: c.name,
    failureDomain: c.failureDomain,
    failureConfidence: c.failureConfidence,
    failureReason: c.failureReason,
    traceId,
    evidencePaths: evidencePath !== null ? [evidencePath] : [],
    artifactUrl: evidencePath !== null ? artifactUrl(base, ctx.rootPath, evidencePath) : null,
    verdictNote: c.verdictNote
  };
}

async function previewAttachments(ctx: ItemContext, traceId: string): Promise<string[]> {
  try {
    const payload = await ctx.postEvidence(ctx.runtime, { key: "", traceId, dryRun: true });
    const attachments = payload.attachments;
    return Array.isArray(attachments)
      ? attachments.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch (error) {
    log(`dryRun 证据预览失败（${traceId}）：${errorMessage(error)}`);
    return [];
  }
}

async function processItem(
  store: ProjectStore,
  ctx: ItemContext,
  item: { runId: string; caseId: string }
): Promise<IssueItemResult> {
  const { runId, caseId } = item;
  const run = await store.getSuiteRun(ctx.rootPath, runId);
  const c = run === null ? undefined : run.cases.find((entry) => entry.caseId === caseId);
  if (run === null || c === undefined) {
    return { runId, caseId, status: "skipped", reason: "未知运行或用例" };
  }
  if (c.status === "passed") {
    return { runId, caseId, status: "skipped", reason: "用例已通过，无需建单" };
  }
  if (c.verdict !== null && c.verdict !== "" && c.verdict !== "app-defect") {
    return { runId, caseId, status: "skipped", reason: `裁决为 ${c.verdict}，与建单不符` };
  }
  if (c.jiraIssueKey !== null && c.jiraIssueKey !== "") {
    return {
      runId,
      caseId,
      status: "existing",
      key: c.jiraIssueKey,
      url: `${ctx.siteUrl}/browse/${c.jiraIssueKey}`
    };
  }

  const facts = buildFacts(ctx, run, c);
  const summary = ctx.summaryInput ?? buildRegressionIssueSummary(facts);

  if (ctx.dryRun) {
    const attachments = c.traceId === null || c.traceId === "" ? [] : await previewAttachments(ctx, c.traceId);
    return { runId, caseId, status: "preview", summary, attachments };
  }

  let key: string;
  try {
    const createdIssue = await ctx.client.createIssue({
      project: { key: ctx.projectKey },
      issuetype: { name: ctx.issueType },
      summary,
      description: buildRegressionIssueDescription(facts),
      labels: ctx.labels
    });
    key = createdIssue.key;
  } catch (error) {
    log(`建单失败（${runId}/${caseId}）：${errorMessage(error)}`);
    return { runId, caseId, status: "error", reason: "Jira 建单失败" };
  }

  const result: IssueItemResult = { runId, caseId, status: "created", key, url: `${ctx.siteUrl}/browse/${key}` };

  if (c.traceId === null || c.traceId === "") {
    result.evidence = "skipped";
  } else {
    try {
      const payload = await ctx.postEvidence(ctx.runtime, {
        key,
        traceId: c.traceId,
        platform: evidencePlatform(run.platform),
        deviceSerial: run.device ?? undefined,
        dryRun: false
      });
      result.evidence = payload.ok === true ? "posted" : "error";
    } catch (error) {
      result.evidence = "error";
      log(`证据回写失败（${key}/${c.traceId}）：${errorMessage(error)}`);
    }
  }

  try {
    await store.setCaseIssueKey({ rootPath: ctx.rootPath, runId, caseId, jiraKey: key });
    await recordAuditSafe(store, ctx.rootPath, {
      domain: "issues",
      action: "linked",
      result: "ok",
      summary: `回写单号 ${key}`,
      refs: { runId, caseId, issueKey: key }
    });
  } catch (error) {
    log(`建单回写失败（${runId}/${caseId}/${key}）：${errorMessage(error)}`);
  }

  return result;
}

export async function createRunCaseIssues(
  options: CreateIssuesOptions,
  input: {
    rootPath: string;
    items: Array<{ runId: string; caseId: string }>;
    projectKey?: string;
    issueType?: string;
    labels?: string[];
    summary?: string;
    dryRun?: boolean;
    /** 建单（dryRun=false）必须携带 dryRun 签发的预览回执。 */
    previewId?: string;
  }
): Promise<IssuesOutcome> {
  const runtimeFor = options.runtimeFor ?? defaultRuntimeFor;
  const clientFor = options.clientFor ?? defaultClientFor;
  const postEvidence = options.postEvidence ?? postEvidenceToIssue;

  const runtime = await runtimeFor(input.rootPath);
  if (runtime === null) {
    return { ok: false, error: "项目运行时不可用（仅限 workspace 内项目、HTTP 模式）" };
  }

  const resolved = clientFor(runtime);
  if (resolved === null) {
    const missing = jiraMissingConfigPayload(runtime);
    return { ok: false, error: missing.error, hints: missing.howToFix };
  }

  const projectKey = (input.projectKey ?? resolverValue(runtime, JIRA_ISSUE_PROJECT) ?? "").trim();
  if (projectKey === "") {
    return {
      ok: false,
      error: "缺少 Jira 项目 key（payload.projectKey 或项目 .env JIRA_ISSUE_PROJECT）"
    };
  }
  const issueType =
    (input.issueType ?? resolverValue(runtime, JIRA_ISSUE_TYPE) ?? "Bug").trim() || "Bug";
  const labels = normalizeLabels(input.labels ?? resolverValue(runtime, JIRA_ISSUE_LABELS));

  const previewId = issuePreviewId({
    items: input.items,
    projectKey,
    issueType,
    labels,
    summary: input.summary ?? null
  });
  if (input.dryRun !== true) {
    const provided = (input.previewId ?? "").trim();
    if (provided === "") {
      return {
        ok: false,
        error: "请先在面板点「预览」：建单必须携带服务端预览回执（外部副作用防误建）"
      };
    }
    if (provided !== previewId) {
      return {
        ok: false,
        stale: true,
        error: "预览已过期：勾选或字段已变化，请重新预览后再建单"
      };
    }
  }

  const baseByTaskId = await artifactBaseByTaskId(options.store, input.rootPath);

  const results: IssueItemResult[] = [];
  let created = 0;
  let existing = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of input.items) {
    const result = await processItem(
      options.store,
      {
        rootPath: input.rootPath,
        runtime,
        client: resolved.client,
        siteUrl: resolved.siteUrl,
        postEvidence,
        projectKey,
        issueType,
        labels,
        summaryInput: input.summary,
        dryRun: input.dryRun === true,
        baseByTaskId
      },
      item
    );
    results.push(result);
    if (result.status === "created") created += 1;
    else if (result.status === "existing") existing += 1;
    else if (result.status === "skipped") skipped += 1;
    else if (result.status === "error") failed += 1;
  }

  return { ok: true, previewId, results, created, existing, skipped, failed };
}
