import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { plainTextToAdf } from "../jira/adf.js";
import {
  type AttachEntry,
  deterministicAttachmentName,
  shortContentHash,
  uploadAttachmentsDeduped
} from "../jira/attachments.js";
import { upsertTraceComment } from "../jira/comments.js";
import { issueSummaryRow, normalizeIssue, parseIssueKey } from "../jira/context.js";
import { postEvidenceToIssue, type JiraEvidencePostArgs } from "../jira/post.js";
import { jiraErrorPayload, jiraMissingConfigPayload, resolveJiraClient } from "../jira/resolve.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";

export type { JiraEvidencePostArgs };

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

function jiraErrorResult(error: unknown): CallToolResult {
  return jsonResult(jiraErrorPayload(error), true);
}

export async function jiraIssueGet(
  runtime: Runtime,
  args: JiraIssueGetArgs
): Promise<CallToolResult> {
  const resolved = resolveJiraClient(runtime);
  if (resolved === null) return jsonResult(jiraMissingConfigPayload(runtime), true);
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
  const resolved = resolveJiraClient(runtime);
  if (resolved === null) return jsonResult(jiraMissingConfigPayload(runtime), true);
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

/** `jira_issue_comment`：纯文本→ADF 评论；带 traceId 时按 marker 幂等（更新既有/新建）。 */
export async function jiraIssueComment(
  runtime: Runtime,
  args: JiraIssueCommentArgs
): Promise<CallToolResult> {
  const resolved = resolveJiraClient(runtime);
  if (resolved === null) return jsonResult(jiraMissingConfigPayload(runtime), true);
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

interface ReadEntry {
  file: string;
  filename: string;
  size: number;
  content: Buffer;
  status: "pending" | "rejected" | "read-error";
  reason?: string;
}

/** `jira_issue_attach`：项目根内路径、multipart 上传、内容哈希去重、超限 warning 跳过。 */
export async function jiraIssueAttach(
  runtime: Runtime,
  args: JiraIssueAttachArgs
): Promise<CallToolResult> {
  const resolved = resolveJiraClient(runtime);
  if (resolved === null) return jsonResult(jiraMissingConfigPayload(runtime), true);
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

  const entries: ReadEntry[] = [];
  for (const file of files) {
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      entries.push({
        file,
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
        filename: deterministicAttachmentName(path.basename(abs), shortContentHash(content)),
        size: content.byteLength,
        content,
        status: "pending"
      });
    } catch (error) {
      entries.push({
        file,
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

  const ready: AttachEntry[] = entries
    .filter((entry) => entry.status === "pending")
    .map((entry) => ({
      file: entry.file,
      filename: entry.filename,
      size: entry.size,
      content: entry.content
    }));
  const env = { ...runtime.project.dotenvValues, ...process.env };
  const { results: uploaded, degraded } = await uploadAttachmentsDeduped(resolved.client, key, ready, {
    env
  });

  let uploadedIndex = 0;
  return jsonResult({
    ok: true,
    site: resolved.siteUrl,
    issue: key,
    degraded: degraded.length > 0 ? degraded : null,
    results: entries.map((entry) => {
      if (entry.status !== "pending") {
        return {
          file: entry.file,
          filename: entry.filename || null,
          size: entry.size,
          status: entry.status,
          ...(entry.reason ? { reason: entry.reason } : {})
        };
      }
      return uploaded[uploadedIndex++];
    })
  });
}

/** `jira_evidence_post`：一次调用回写失败证据（评论幂等 + 附件去重），平台/设备维度如实标注。 */
export async function jiraEvidencePost(
  runtime: Runtime,
  args: JiraEvidencePostArgs
): Promise<CallToolResult> {
  const payload = await postEvidenceToIssue(runtime, args);
  return jsonResult(payload, payload.ok === false);
}
