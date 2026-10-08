import type { CliRuntimeBundle } from "./cli-runtime.js";
import { defaultBuildRuntime } from "./cli-runtime.js";
import { plainTextToAdf } from "./jira/adf.js";
import { upsertTraceComment } from "./jira/comments.js";
import { JiraApiError, JiraClient, JiraRateLimitError } from "./jira/client.js";
import { parseIssueKey } from "./jira/context.js";
import type { Runtime } from "./runtime.js";
import { errorMessage } from "./util.js";

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  list: (key: string) => string[];
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let key: string;
    let value: string | true;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    const existing = flags.get(key);
    if (existing === undefined) flags.set(key, value);
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags.set(key, [String(existing), String(value)]);
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    },
    list: (key) => {
      const value = flags.get(key);
      if (value === undefined || value === true) return [];
      return Array.isArray(value) ? value : [value];
    }
  };
}

function splitList(values: string[]): string[] {
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== "");
}

export interface JiraCliDeps {
  buildRuntime?: (projectDir: string | null) => Promise<CliRuntimeBundle>;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

export function printJiraUsage(log: (line: string) => void): void {
  log(`aos-mcp jira — Jira 工作流 CLI（与 MCP 工具共用客户端与凭证）

Usage:
  aos-mcp jira issue create --project-key <KEY> --summary <text> [options]
       --type Task|Bug（默认 Task） [--description <text>] [--label a,b]...
       [--parent <KEY>] [--blocks <KEY>]...
  aos-mcp jira issue comment <KEY> --body <text> [--trace <traceId>]
  aos-mcp jira issue label <KEY> (--add a,b | --remove c,d)...
  aos-mcp jira issue transition <KEY> --to "<status name>"
  aos-mcp jira issue link --inward <KEY> --outward <KEY> [--type Blocks]
common: [--project <dir>] [--json]
exit codes: 0 成功 / 1 请求或配置失败 / 2 用法错误`);
}

interface ResolvedClient {
  client: JiraClient;
  siteUrl: string;
}

function clientFor(runtime: Runtime): { ok: true; resolved: ResolvedClient } | { ok: false; message: string } {
  const config = runtime.jiraConfig();
  if (!config.configured || config.siteUrl === null || config.email === null || config.apiToken === null) {
    return {
      ok: false,
      message:
        `尚未配置 Jira 凭证：缺少 ${config.missing.join(" / ")}。` +
        "用 aos_configure 提供 jiraSite/jiraEmail/jiraApiToken，或写入项目 .env（JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN）。"
    };
  }
  return {
    ok: true,
    resolved: {
      client: new JiraClient({
        siteUrl: config.siteUrl,
        email: config.email,
        apiToken: config.apiToken
      }),
      siteUrl: config.siteUrl
    }
  };
}

function failureOf(error: unknown, errorLog: (line: string) => void): number {
  if (error instanceof JiraRateLimitError) {
    errorLog(`${error.message}（retry-after=${error.retryAfterSeconds}s，reason=${error.reason}）`);
    return 1;
  }
  if (error instanceof JiraApiError) {
    errorLog(`Jira API ${error.status}: ${error.body}${error.hint ? `（${error.hint}）` : ""}`);
    return 1;
  }
  errorLog(`Jira 请求失败: ${errorMessage(error)}`);
  return 1;
}

const ISSUE_ACTIONS = ["create", "comment", "label", "transition", "link"] as const;
type IssueAction = (typeof ISSUE_ACTIONS)[number];

async function issueCreate(
  client: JiraClient,
  siteUrl: string,
  flags: ParsedFlags,
  output: (payload: Record<string, unknown>, lines: string[]) => void,
  errorLog: (line: string) => void
): Promise<number> {
  const projectKey = flags.get("project-key")?.trim() ?? "";
  const summary = flags.get("summary")?.trim() ?? "";
  const issueType = (flags.get("type") ?? "Task").trim();
  if (projectKey === "" || summary === "") {
    errorLog("用法: aos-mcp jira issue create --project-key <KEY> --summary <text> [--type Task|Bug] [--description <text>] [--label a,b] [--parent <KEY>] [--blocks <KEY>]");
    return 2;
  }
  if (issueType !== "Task" && issueType !== "Bug") {
    errorLog(`--type 仅支持 Task|Bug（收到 "${issueType}"）`);
    return 2;
  }
  const description = flags.get("description");
  const labels = splitList(flags.list("label"));
  const parent = flags.get("parent")?.trim() ?? "";
  const blocks: string[] = [];
  for (const raw of splitList(flags.list("blocks"))) {
    const key = parseIssueKey(raw);
    if (key === null) {
      errorLog(`--blocks 含无法解析的 issue key："${raw}"`);
      return 2;
    }
    blocks.push(key);
  }
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary,
    ...(description ? { description: plainTextToAdf(description) } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(parent !== "" ? { parent: { key: parent } } : {})
  };
  const created = await client.createIssue(fields);
  const linked: string[] = [];
  for (const blocked of blocks) {
    await client.createIssueLink({ typeName: "Blocks", inwardKey: created.key, outwardKey: blocked });
    linked.push(blocked);
  }
  output(
    {
      ok: true,
      issue: { key: created.key, url: `${siteUrl}/browse/${created.key}` },
      type: issueType,
      labels,
      parent: parent || null,
      blocks: linked
    },
    [
      `已创建 ${created.key}（${issueType}）：${summary}`,
      ...(linked.length > 0 ? [`Blocks: ${created.key} → ${linked.join(", ")}`] : [])
    ]
  );
  return 0;
}

async function issueComment(
  client: JiraClient,
  flags: ParsedFlags,
  positional: string[],
  output: (payload: Record<string, unknown>, lines: string[]) => void,
  errorLog: (line: string) => void
): Promise<number> {
  const key = positional[2] ? parseIssueKey(positional[2]) : null;
  const body = flags.get("body");
  const traceId = flags.get("trace")?.trim() ?? "";
  if (key === null || !body || body.trim() === "") {
    errorLog("用法: aos-mcp jira issue comment <KEY> --body <text> [--trace <traceId>]");
    return 2;
  }
  const adf = plainTextToAdf(body);
  const result =
    traceId !== ""
      ? await upsertTraceComment(client, key, { traceId, body: adf })
      : { action: "created" as const, commentId: await client.createComment(key, adf), propertySet: false };
  output(
    { ok: true, issue: key, traceId: traceId || null, ...result },
    [`评论 ${result.action === "created" ? "已新建" : "已更新"}: ${key} #${result.commentId}`]
  );
  return 0;
}

async function issueLabel(
  client: JiraClient,
  flags: ParsedFlags,
  positional: string[],
  output: (payload: Record<string, unknown>, lines: string[]) => void,
  errorLog: (line: string) => void
): Promise<number> {
  const key = positional[2] ? parseIssueKey(positional[2]) : null;
  const add = splitList(flags.list("add"));
  const remove = splitList(flags.list("remove"));
  if (key === null || (add.length === 0 && remove.length === 0)) {
    errorLog("用法: aos-mcp jira issue label <KEY> (--add a,b | --remove c,d)");
    return 2;
  }
  const issue = await client.getIssue(key, ["labels"]);
  const fields = (issue.fields ?? {}) as { labels?: unknown };
  const current = Array.isArray(fields.labels)
    ? fields.labels.filter((label): label is string => typeof label === "string")
    : [];
  const next = [...new Set([...current.filter((label) => !remove.includes(label)), ...add])];
  await client.updateIssue(key, { labels: next });
  output(
    { ok: true, issue: key, before: current, after: next, added: add, removed: remove },
    [`${key} 标签: ${current.join(", ") || "-"} → ${next.join(", ") || "-"}`]
  );
  return 0;
}

async function issueTransition(
  client: JiraClient,
  flags: ParsedFlags,
  positional: string[],
  output: (payload: Record<string, unknown>, lines: string[]) => void,
  errorLog: (line: string) => void
): Promise<number> {
  const key = positional[2] ? parseIssueKey(positional[2]) : null;
  const target = flags.get("to")?.trim() ?? "";
  if (key === null || target === "") {
    errorLog('用法: aos-mcp jira issue transition <KEY> --to "<status name>"');
    return 2;
  }
  const transitions = await client.getTransitions(key);
  const wanted = target.toLowerCase();
  const match = transitions.find(
    (transition) =>
      transition.to?.toLowerCase() === wanted || transition.name.toLowerCase() === wanted
  );
  if (!match) {
    const available = transitions
      .map((transition) => transition.to ?? transition.name)
      .filter((name) => name !== "");
    errorLog(`未找到目标状态 "${target}"；当前可用: ${available.join("、") || "（无）"}`);
    return 1;
  }
  await client.doTransition(key, match.id);
  output(
    { ok: true, issue: key, transition: { id: match.id, name: match.name, to: match.to } },
    [`${key} → ${match.to ?? match.name}`]
  );
  return 0;
}

async function issueLink(
  client: JiraClient,
  flags: ParsedFlags,
  output: (payload: Record<string, unknown>, lines: string[]) => void,
  errorLog: (line: string) => void
): Promise<number> {
  const typeName = (flags.get("type") ?? "Blocks").trim();
  const inwardRaw = flags.get("inward") ?? "";
  const outwardRaw = flags.get("outward") ?? "";
  const inward = parseIssueKey(inwardRaw);
  const outward = parseIssueKey(outwardRaw);
  if (inward === null || outward === null) {
    errorLog("用法: aos-mcp jira issue link --inward <KEY> --outward <KEY> [--type Blocks]");
    return 2;
  }
  await client.createIssueLink({ typeName, inwardKey: inward, outwardKey: outward });
  output(
    { ok: true, link: { type: typeName, inward, outward } },
    [`已链接: ${inward} ${typeName} ${outward}`]
  );
  return 0;
}

export async function runJiraCommand(argv: string[], deps: JiraCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const flags = parseFlags(argv);
  const group = flags.positional[0];
  if (!group || group === "help" || group === "--help" || group === "-h") {
    printJiraUsage(log);
    return group ? 0 : 2;
  }
  if (group !== "issue") {
    errorLog(`未知 jira 子命令组 "${group}"（仅支持 issue）`);
    printJiraUsage(log);
    return 2;
  }
  const action = flags.positional[1] as IssueAction | undefined;
  if (!action || !ISSUE_ACTIONS.includes(action)) {
    errorLog(`未知 jira issue 子命令 "${flags.positional[1] ?? ""}"`);
    printJiraUsage(log);
    return 2;
  }

  const buildRuntime = deps.buildRuntime ?? defaultBuildRuntime;
  let built: CliRuntimeBundle | null = null;
  try {
    built = await buildRuntime(flags.get("project"));
    const resolved = clientFor(built.runtime);
    if (!resolved.ok) {
      errorLog(resolved.message);
      return 1;
    }
    const output = (payload: Record<string, unknown>, lines: string[]): void => {
      if (flags.bool("json")) log(JSON.stringify(payload, null, 2));
      else for (const line of lines) log(line);
    };
    try {
      switch (action) {
        case "create":
          return await issueCreate(resolved.resolved.client, resolved.resolved.siteUrl, flags, output, errorLog);
        case "comment":
          return await issueComment(resolved.resolved.client, flags, flags.positional, output, errorLog);
        case "label":
          return await issueLabel(resolved.resolved.client, flags, flags.positional, output, errorLog);
        case "transition":
          return await issueTransition(resolved.resolved.client, flags, flags.positional, output, errorLog);
        case "link":
          return await issueLink(resolved.resolved.client, flags, output, errorLog);
      }
    } catch (error) {
      return failureOf(error, errorLog);
    }
  } catch (error) {
    errorLog(`jira ${action} 失败: ${errorMessage(error)}`);
    return 1;
  } finally {
    if (built) await built.dispose();
  }
  return 0;
}
