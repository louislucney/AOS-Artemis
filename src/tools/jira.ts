import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { plainTextToAdf } from "../jira/adf.js";
import { upsertTraceComment } from "../jira/comments.js";
import { JiraApiError, JiraClient, JiraRateLimitError } from "../jira/client.js";
import { ENV_JIRA_API_TOKEN, ENV_JIRA_BASE_URL, ENV_JIRA_EMAIL } from "../jira/config.js";
import { issueSummaryRow, normalizeIssue, parseIssueKey } from "../jira/context.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";

export interface JiraIssueGetArgs {
  key: string;
}

export interface JiraIssueSearchArgs {
  jql: string;
  limit?: number;
  fields?: string[];
  nextPageToken?: string;
}

const ISSUE_GET_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "labels",
  "project",
  "assignee",
  "reporter",
  "updated",
  "created",
  "description"
];

const ISSUE_SEARCH_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "labels",
  "updated",
  "assignee",
  "project"
];

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

function clientFor(runtime: Runtime): { client: JiraClient; siteUrl: string } | null {
  const config = runtime.jiraConfig();
  if (!config.configured || config.siteUrl === null || config.email === null || config.apiToken === null) {
    return null;
  }
  return {
    client: new JiraClient({
      siteUrl: config.siteUrl,
      email: config.email,
      apiToken: config.apiToken
    }),
    siteUrl: config.siteUrl
  };
}

function missingConfigResult(runtime: Runtime): CallToolResult {
  const config = runtime.jiraConfig();
  return jsonResult(
    {
      ok: false,
      error: `尚未配置 Jira 凭证：缺少 ${config.missing.join(" / ")}。`,
      howToFix: [
        "调用 aos_configure 同时提供 jiraSite / jiraEmail / jiraApiToken（写入项目 .env 并即时刷新）",
        `或在 ${runtime.project.rootDir}/.env 中添加 ${ENV_JIRA_BASE_URL} / ${ENV_JIRA_EMAIL} / ${ENV_JIRA_API_TOKEN} 后重启 MCP 会话`
      ]
    },
    true
  );
}

function jiraErrorResult(error: unknown): CallToolResult {
  if (error instanceof JiraRateLimitError) {
    return jsonResult(
      {
        ok: false,
        error: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
        reason: error.reason
      },
      true
    );
  }
  if (error instanceof JiraApiError) {
    return jsonResult(
      {
        ok: false,
        error: `Jira API ${error.status}: ${error.body}`,
        status: error.status,
        hint: error.hint
      },
      true
    );
  }
  return jsonResult({ ok: false, error: `Jira 请求失败：${errorMessage(error)}` }, true);
}

export async function jiraIssueGet(
  runtime: Runtime,
  args: JiraIssueGetArgs
): Promise<CallToolResult> {
  const resolved = clientFor(runtime);
  if (resolved === null) return missingConfigResult(runtime);
  const key = parseIssueKey(args.key);
  if (key === null) {
    return jsonResult(
      { ok: false, error: `无法解析 issue key："${args.key}"。请传 key（如 AOS-123）或 browse URL。` },
      true
    );
  }
  try {
    const raw = await resolved.client.getIssue(key, ISSUE_GET_FIELDS);
    return jsonResult({
      ok: true,
      site: resolved.siteUrl,
      issue: normalizeIssue(raw, resolved.siteUrl)
    });
  } catch (error) {
    return jiraErrorResult(error);
  }
}

export async function jiraIssueSearch(
  runtime: Runtime,
  args: JiraIssueSearchArgs
): Promise<CallToolResult> {
  const resolved = clientFor(runtime);
  if (resolved === null) return missingConfigResult(runtime);
  const jql = args.jql.trim();
  if (jql === "") {
    return jsonResult({ ok: false, error: "jql 不能为空（需有界查询，如 project = X ORDER BY created DESC）。" }, true);
  }
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const fields = args.fields && args.fields.length > 0 ? args.fields : ISSUE_SEARCH_FIELDS;
  try {
    const raw = await resolved.client.searchJql(jql, {
      maxResults: limit,
      fields,
      nextPageToken: args.nextPageToken
    });
    const rawIssues = Array.isArray(raw.issues) ? raw.issues : [];
    const issues = rawIssues.map((issue) => issueSummaryRow(issue, resolved.siteUrl));
    return jsonResult({
      ok: true,
      jql,
      count: issues.length,
      isLast: raw.isLast === true,
      nextPageToken: typeof raw.nextPageToken === "string" ? raw.nextPageToken : null,
      issues
    });
  } catch (error) {
    return jiraErrorResult(error);
  }
}

export interface JiraIssueCommentArgs {
  key: string;
  body: string;
  traceId?: string;
  dryRun?: boolean;
}

export interface JiraIssueAttachArgs {
  key: string;
  files: string[];
  dryRun?: boolean;
}

const DEFAULT_ATTACH_MAX_MB = 20;

/** `jira_issue_comment`：纯文本→ADF 评论；带 traceId 时按 marker 幂等（更新既有/新建）。 */
export async function jiraIssueComment(
  runtime: Runtime,
  args: JiraIssueCommentArgs
): Promise<CallToolResult> {
  const resolved = clientFor(runtime);
  if (resolved === null) return missingConfigResult(runtime);
  const key = parseIssueKey(args.key);
  if (key === null) {
    return jsonResult(
      { ok: false, error: `无法解析 issue key："${args.key}"。请传 key（如 AOS-123）或 browse URL。` },
      true
    );
  }
  const body = typeof args.body === "string" ? args.body : "";
  if (body.trim() === "") {
    return jsonResult({ ok: false, error: "body 不能为空。" }, true);
  }
  const adf = plainTextToAdf(body);
  const traceId = typeof args.traceId === "string" && args.traceId.trim() !== "" ? args.traceId.trim() : null;
  if (args.dryRun === true) {
    return jsonResult({
      ok: true,
      dryRun: true,
      site: resolved.siteUrl,
      issue: key,
      traceId,
      idempotent: traceId !== null,
      blocks: adf.content?.length ?? 0,
      excerpt: body.slice(0, 200)
    });
  }
  try {
    const result =
      traceId !== null
        ? await upsertTraceComment(resolved.client, key, { traceId, body: adf })
        : {
            action: "created" as const,
            commentId: await resolved.client.createComment(key, adf),
            propertySet: false
          };
    return jsonResult({ ok: true, site: resolved.siteUrl, issue: key, traceId, ...result });
  } catch (error) {
    return jiraErrorResult(error);
  }
}

function shortContentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** 确定性附件名：`<basename>-<sha8><ext>`（同名同大小视为已存在，内容哈希内置在名字里）。 */
function deterministicAttachmentName(original: string, hash: string): string {
  const parsed = path.parse(original);
  const base = parsed.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
  return `${base}-${hash}${parsed.ext}`;
}

interface AttachEntry {
  file: string;
  abs: string;
  filename: string;
  size: number;
  content: Buffer;
  status: "pending" | "rejected" | "read-error" | "uploaded" | "skipped-duplicate" | "skipped-too-large" | "error";
  reason?: string;
}

/** `jira_issue_attach`：项目根内路径、multipart 上传、内容哈希去重、超限 warning 跳过。 */
export async function jiraIssueAttach(
  runtime: Runtime,
  args: JiraIssueAttachArgs
): Promise<CallToolResult> {
  const resolved = clientFor(runtime);
  if (resolved === null) return missingConfigResult(runtime);
  const key = parseIssueKey(args.key);
  if (key === null) {
    return jsonResult(
      { ok: false, error: `无法解析 issue key："${args.key}"。请传 key（如 AOS-123）或 browse URL。` },
      true
    );
  }
  const files = Array.isArray(args.files) ? args.files.filter((file) => typeof file === "string" && file.trim() !== "") : [];
  if (files.length === 0) {
    return jsonResult({ ok: false, error: "files 不能为空（项目根内相对路径数组）。" }, true);
  }
  const root = runtime.project.rootDir;
  const env = { ...runtime.project.dotenvValues, ...process.env };
  const envCapMb = Number(env.AOS_JIRA_ATTACH_MAX_MB ?? "");
  const localCapMb = Number.isFinite(envCapMb) && envCapMb > 0 ? envCapMb : DEFAULT_ATTACH_MAX_MB;

  const entries: AttachEntry[] = [];
  for (const file of files) {
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      entries.push({
        file,
        abs,
        filename: "",
        size: 0,
        content: Buffer.alloc(0),
        status: "rejected",
        reason: "路径必须在项目根内"
      });
      continue;
    }
    try {
      const content = fs.readFileSync(abs);
      entries.push({
        file,
        abs,
        filename: deterministicAttachmentName(path.basename(abs), shortContentHash(content)),
        size: content.byteLength,
        content,
        status: "pending"
      });
    } catch (error) {
      entries.push({
        file,
        abs,
        filename: "",
        size: 0,
        content: Buffer.alloc(0),
        status: "read-error",
        reason: errorMessage(error)
      });
    }
  }

  if (args.dryRun === true) {
    return jsonResult({
      ok: true,
      dryRun: true,
      site: resolved.siteUrl,
      issue: key,
      results: entries.map((entry) => ({
        file: entry.file,
        filename: entry.filename || null,
        size: entry.size,
        status: entry.status === "pending" ? "planned" : entry.status,
        ...(entry.reason ? { reason: entry.reason } : {})
      }))
    });
  }

  let siteLimit: number | null = null;
  const degraded: string[] = [];
  try {
    const meta = await resolved.client.getAttachmentMeta();
    if (!meta.enabled) degraded.push("attachments-disabled");
    siteLimit = meta.uploadLimit;
  } catch (error) {
    degraded.push(`meta-failed: ${errorMessage(error)}`);
  }
  const existing = new Set<string>();
  try {
    for (const item of await resolved.client.listAttachments(key)) {
      existing.add(`${item.filename}:${item.size}`);
    }
  } catch (error) {
    degraded.push(`list-failed: ${errorMessage(error)}`);
  }
  const limitBytes = Math.min(siteLimit ?? Number.POSITIVE_INFINITY, localCapMb * 1024 * 1024);

  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    if (entry.size > limitBytes) {
      entry.status = "skipped-too-large";
      entry.reason = `超过上限 ${Math.round(limitBytes / (1024 * 1024))}MB（站点/本地取小）`;
      continue;
    }
    if (existing.has(`${entry.filename}:${entry.size}`)) {
      entry.status = "skipped-duplicate";
      continue;
    }
    try {
      await resolved.client.uploadAttachment(key, {
        filename: entry.filename,
        content: entry.content
      });
      entry.status = "uploaded";
      existing.add(`${entry.filename}:${entry.size}`);
    } catch (error) {
      entry.status = "error";
      entry.reason = errorMessage(error);
    }
  }

  return jsonResult({
    ok: true,
    site: resolved.siteUrl,
    issue: key,
    degraded: degraded.length > 0 ? degraded : null,
    results: entries.map((entry) => ({
      file: entry.file,
      filename: entry.filename || null,
      size: entry.size,
      status: entry.status,
      ...(entry.reason ? { reason: entry.reason } : {})
    }))
  });
}
