import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
