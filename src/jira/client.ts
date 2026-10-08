import { createHash } from "node:crypto";

export class JiraRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly reason: string;

  constructor(retryAfterSeconds: number, reason: string) {
    super(
      `Jira API 限流（reason=${reason}，retry-after=${retryAfterSeconds}s）。` +
        "冷却期内不会再发起请求；请等待冷却结束或降低调用频率。"
    );
    this.name = "JiraRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
  }
}

export class JiraApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly hint: string | null;

  constructor(status: number, body: string, hint: string | null) {
    super(`Jira API ${status}: ${body}`);
    this.name = "JiraApiError";
    this.status = status;
    this.body = body;
    this.hint = hint;
  }
}

function hintFor(status: number): string | null {
  if (status === 400) {
    return "Jira 拒绝了请求：常见原因是 JQL 未加界（如需 project = X）或字段/流转名不合法。";
  }
  if (status === 401) {
    return "凭证无效或已过期：Jira API token 现为一年有效期制，请在 id.atlassian.com 轮换后经 aos_configure 更新 JIRA_API_TOKEN。";
  }
  if (status === 403) {
    return "权限不足：确认账号对目标项目/issue 有相应权限（scoped token 还需包含所需 scope）。";
  }
  if (status === 404) {
    return "未找到：确认 issue key、JQL、站点 URL 与账号可见性。";
  }
  if (status === 413) {
    return "附件超过站点允许的大小。";
  }
  return null;
}

const cooldowns = new Map<string, { until: number; retryAfterSeconds: number; reason: string }>();

function fingerprint(email: string, apiToken: string): string {
  return createHash("sha256").update(`${email}:${apiToken}`).digest("hex").slice(0, 12);
}

function retryMaxWaitMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AOS_JIRA_RETRY_MAX_WAIT_MS ?? 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AOS_JIRA_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get("Retry-After");
  if (header === null) return null;
  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export interface JiraClientOptions {
  siteUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

export class JiraClient {
  private readonly siteUrl: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: JiraClientOptions) {
    this.siteUrl = options.siteUrl.replace(/\/+$/, "");
    this.email = options.email;
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async rawRequest(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | FormData } = {},
    attempt = 0
  ): Promise<Response> {
    const fp = fingerprint(this.email, this.apiToken);
    const cooldown = cooldowns.get(fp);
    if (cooldown && Date.now() < cooldown.until) {
      throw new JiraRateLimitError(
        Math.ceil((cooldown.until - Date.now()) / 1000),
        cooldown.reason
      );
    }
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
      Accept: "application/json",
      ...(init.headers ?? {})
    };
    const res = await this.fetchImpl(`${this.siteUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs(this.env))
    });
    if (res.status === 429) {
      const reason = res.headers.get("RateLimit-Reason") ?? "unknown";
      const seconds = parseRetryAfter(res) ?? 60;
      if (seconds * 1000 <= retryMaxWaitMs(this.env) && attempt < 1) {
        await this.sleep(seconds * 1000);
        return this.rawRequest(path, init, attempt + 1);
      }
      cooldowns.set(fp, { until: Date.now() + seconds * 1000, retryAfterSeconds: seconds, reason });
      throw new JiraRateLimitError(seconds, reason);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new JiraApiError(res.status, text, hintFor(res.status));
    }
    return res;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await this.rawRequest(path, { method: init.method, headers, body });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** 写操作（无返回值）：不解析响应体，兼容 200/201/204/空体。 */
  private async requestVoid(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<void> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    await this.rawRequest(path, { method: init.method, headers, body });
  }

  async getIssue(key: string, fields: string[]): Promise<Record<string, unknown>> {
    const query = fields.length > 0 ? `?fields=${fields.map(encodeURIComponent).join(",")}` : "";
    return await this.request<Record<string, unknown>>(
      `/rest/api/3/issue/${encodeURIComponent(key)}${query}`
    );
  }

  async searchJql(
    jql: string,
    options: { maxResults?: number; fields?: string[]; nextPageToken?: string } = {}
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { jql, maxResults: options.maxResults ?? 20 };
    if (options.fields && options.fields.length > 0) body.fields = options.fields;
    if (options.nextPageToken) body.nextPageToken = options.nextPageToken;
    return await this.request<Record<string, unknown>>("/rest/api/3/search/jql", {
      method: "POST",
      body
    });
  }

  async getComments(issueKey: string): Promise<Array<{ id: string; body: unknown }>> {
    const payload = await this.request<{ comments?: Array<{ id?: unknown; body?: unknown }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=100&orderBy=-created`
    );
    return (payload.comments ?? [])
      .filter((comment) => comment && typeof comment.id === "string")
      .map((comment) => ({ id: comment.id as string, body: comment.body }));
  }

  async createComment(issueKey: string, body: unknown): Promise<string> {
    const payload = await this.request<{ id?: unknown }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      { method: "POST", body: { body } }
    );
    if (typeof payload.id !== "string" || payload.id === "") {
      throw new Error("Jira 未返回评论 id");
    }
    return payload.id;
  }

  async updateComment(issueKey: string, commentId: string, body: unknown): Promise<void> {
    await this.requestVoid(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { method: "PUT", body: { body } }
    );
  }

  /** 评论属性（marker）：失败不抛错（账号可能无属性 scope），返回是否写入。 */
  async setCommentProperty(
    issueKey: string,
    commentId: string,
    propertyKey: string,
    value: unknown
  ): Promise<boolean> {
    try {
      await this.requestVoid(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}/properties/${encodeURIComponent(propertyKey)}`,
        { method: "PUT", body: value }
      );
      return true;
    } catch {
      return false;
    }
  }

  async getAttachmentMeta(): Promise<{ enabled: boolean; uploadLimit: number | null }> {
    const payload = await this.request<{ enabled?: unknown; uploadLimit?: unknown }>(
      "/rest/api/3/attachment/meta"
    );
    return {
      enabled: payload.enabled === true,
      uploadLimit: typeof payload.uploadLimit === "number" ? payload.uploadLimit : null
    };
  }

  async listAttachments(
    issueKey: string
  ): Promise<Array<{ id: string; filename: string; size: number }>> {
    const payload = await this.request<{
      fields?: { attachment?: Array<{ id?: unknown; filename?: unknown; size?: unknown }> };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`);
    return (payload.fields?.attachment ?? [])
      .filter(
        (item): item is { id: string; filename: string; size: number } =>
          Boolean(item) &&
          typeof item.id === "string" &&
          typeof item.filename === "string" &&
          typeof item.size === "number"
      )
      .map((item) => ({ id: item.id, filename: item.filename, size: item.size }));
  }

  async uploadAttachment(
    issueKey: string,
    file: { filename: string; content: Buffer; mimeType?: string }
  ): Promise<void> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.content], { type: file.mimeType ?? "application/octet-stream" }),
      file.filename
    );
    await this.rawRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: "POST",
      headers: { "X-Atlassian-Token": "no-check" },
      body: form
    });
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const payload = await this.request<{ id?: unknown; key?: unknown }>("/rest/api/3/issue", {
      method: "POST",
      body: { fields }
    });
    if (typeof payload.key !== "string" || payload.key === "") {
      throw new Error("Jira 未返回 issue key");
    }
    return { id: typeof payload.id === "string" ? payload.id : "", key: payload.key };
  }

  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.requestVoid(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: { fields }
    });
  }

  async getTransitions(
    issueKey: string
  ): Promise<Array<{ id: string; name: string; to: string | null }>> {
    const payload = await this.request<{
      transitions?: Array<{ id?: unknown; name?: unknown; to?: { name?: unknown } }>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    return (payload.transitions ?? [])
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({
        id: item.id as string,
        name: typeof item.name === "string" ? item.name : "",
        to: typeof item.to?.name === "string" ? item.to.name : null
      }));
  }

  async doTransition(issueKey: string, transitionId: string): Promise<void> {
    await this.requestVoid(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: transitionId } }
    });
  }

  async createIssueLink(input: {
    typeName: string;
    inwardKey: string;
    outwardKey: string;
  }): Promise<void> {
    await this.requestVoid("/rest/api/3/issueLink", {
      method: "POST",
      body: {
        type: { name: input.typeName },
        inwardIssue: { key: input.inwardKey },
        outwardIssue: { key: input.outwardKey }
      }
    });
  }
}
