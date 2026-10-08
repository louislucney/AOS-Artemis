import { errorMessage } from "../../util.js";

export class AppiumError extends Error {
  readonly status: number | null;
  readonly wdError: string | null;
  readonly value: unknown;

  constructor(status: number | null, wdError: string | null, message: string, value: unknown) {
    super(message);
    this.name = "AppiumError";
    this.status = status;
    this.wdError = wdError;
    this.value = value;
  }
}

function extractWdError(parsed: unknown): { wdError: string | null; message: string } {
  const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const value = root?.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const wdError = typeof record.error === "string" ? record.error : null;
    const message =
      typeof record.message === "string" && record.message.trim() !== ""
        ? record.message.trim()
        : wdError ?? "unknown error";
    return { wdError, message };
  }
  if (typeof value === "string" && value.trim() !== "") {
    return { wdError: null, message: value.trim() };
  }
  return { wdError: null, message: "Appium 请求失败" };
}

export interface AppiumClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AppiumSession {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export interface W3cAction {
  type: string;
  [key: string]: unknown;
}

export class AppiumClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AppiumClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new AppiumError(null, null, `Appium 请求失败：${errorMessage(error)}`, null);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const { wdError, message } = extractWdError(parsed);
      throw new AppiumError(res.status, wdError, `Appium API ${res.status}: ${message}`, parsed);
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "value" in parsed) {
      return (parsed as Record<string, unknown>).value as T;
    }
    return parsed as T;
  }

  async status(): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>("GET", "/status");
  }

  async createSession(capabilities: Record<string, unknown>): Promise<AppiumSession> {
    const value = await this.request<Record<string, unknown>>("POST", "/session", {
      capabilities: { alwaysMatch: capabilities }
    });
    const sessionId = value?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new AppiumError(null, null, "Appium 未返回 sessionId。", value);
    }
    const caps = value.capabilities;
    return {
      sessionId,
      capabilities:
        caps !== null && typeof caps === "object" && !Array.isArray(caps)
          ? (caps as Record<string, unknown>)
          : {}
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/session/${encodeURIComponent(sessionId)}`);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const base64 = await this.request<string>(
      "GET",
      `/session/${encodeURIComponent(sessionId)}/screenshot`
    );
    return Buffer.from(base64, "base64");
  }

  async source(sessionId: string): Promise<string> {
    return await this.request<string>("GET", `/session/${encodeURIComponent(sessionId)}/source`);
  }

  async actions(sessionId: string, actions: W3cAction[]): Promise<void> {
    await this.request<unknown>("POST", `/session/${encodeURIComponent(sessionId)}/actions`, {
      actions
    });
  }

  async execute(sessionId: string, script: string, args: unknown[] = []): Promise<unknown> {
    return await this.request<unknown>(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/execute/sync`,
      { script, args }
    );
  }

  async typeText(sessionId: string, text: string): Promise<void> {
    await this.request<unknown>("POST", `/session/${encodeURIComponent(sessionId)}/keys`, {
      value: [...text]
    });
  }

  async isKeyboardShown(sessionId: string): Promise<boolean> {
    const value = await this.request<unknown>(
      "GET",
      `/session/${encodeURIComponent(sessionId)}/appium/device/is_keyboard_shown`
    );
    return value === true;
  }

  async terminateApp(sessionId: string, bundleId: string): Promise<boolean> {
    const value = await this.execute(sessionId, "mobile: terminateApp", [{ bundleId }]);
    return value === true;
  }

  async activateApp(sessionId: string, bundleId: string): Promise<void> {
    await this.execute(sessionId, "mobile: activateApp", [{ bundleId }]);
  }

  async installApp(sessionId: string, appPath: string): Promise<void> {
    await this.execute(sessionId, "mobile: installApp", [{ app: appPath }]);
  }
}
