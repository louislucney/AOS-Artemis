import type { ValueResolver } from "../config/validate.js";

export const ENV_JIRA_BASE_URL = "JIRA_BASE_URL";
export const ENV_JIRA_EMAIL = "JIRA_EMAIL";
export const ENV_JIRA_API_TOKEN = "JIRA_API_TOKEN";

export interface ResolvedJiraConfig {
  siteUrl: string | null;
  email: string | null;
  apiToken: string | null;
  configured: boolean;
  missing: string[];
}

const SITE_PATTERN = /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/?$/i;

/** Jira Cloud site URL: https only, <site>.atlassian.net, no path; trailing slash dropped. */
export function normalizeJiraSiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!SITE_PATTERN.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, "");
}

export function validateJiraSiteUrl(raw: string): string | null {
  if (normalizeJiraSiteUrl(raw) !== null) return null;
  return `Jira 站点必须是 https://<site>.atlassian.net（当前：${raw.trim()}）`;
}

export function jiraConfigFrom(resolver: ValueResolver): ResolvedJiraConfig {
  const siteRaw = resolver.getValue(ENV_JIRA_BASE_URL).value;
  const email = resolver.getValue(ENV_JIRA_EMAIL).value;
  const apiToken = resolver.getValue(ENV_JIRA_API_TOKEN).value;
  const siteUrl = siteRaw !== null ? normalizeJiraSiteUrl(siteRaw) : null;
  const missing: string[] = [];
  if (siteUrl === null) missing.push(ENV_JIRA_BASE_URL);
  if (email === null) missing.push(ENV_JIRA_EMAIL);
  if (apiToken === null) missing.push(ENV_JIRA_API_TOKEN);
  return { siteUrl, email, apiToken, configured: missing.length === 0, missing };
}
