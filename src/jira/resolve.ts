import { JiraApiError, JiraClient, JiraRateLimitError } from "./client.js";
import { ENV_JIRA_API_TOKEN, ENV_JIRA_BASE_URL, ENV_JIRA_EMAIL } from "./config.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";

export function resolveJiraClient(runtime: Runtime): { client: JiraClient; siteUrl: string } | null {
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

export function jiraMissingConfigPayload(
  runtime: Runtime
): { ok: false; error: string; howToFix: string[] } {
  const config = runtime.jiraConfig();
  return {
    ok: false,
    error: `尚未配置 Jira 凭证：缺少 ${config.missing.join(" / ")}。`,
    howToFix: [
      "调用 aos_configure 同时提供 jiraSite / jiraEmail / jiraApiToken（写入项目 .env 并即时刷新）",
      `或在 ${runtime.project.rootDir}/.env 中添加 ${ENV_JIRA_BASE_URL} / ${ENV_JIRA_EMAIL} / ${ENV_JIRA_API_TOKEN} 后重启 MCP 会话`
    ]
  };
}

export function jiraErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof JiraRateLimitError) {
    return {
      ok: false,
      error: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
      reason: error.reason
    };
  }
  if (error instanceof JiraApiError) {
    return {
      ok: false,
      error: `Jira API ${error.status}: ${error.body}`,
      status: error.status,
      hint: error.hint
    };
  }
  return { ok: false, error: `Jira 请求失败：${errorMessage(error)}` };
}
