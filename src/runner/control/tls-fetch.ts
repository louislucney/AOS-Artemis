import fs from "node:fs";
import http from "node:http";
import https from "node:https";

interface RunnerFetchOptions {
  cert?: Buffer;
  key?: Buffer;
  ca?: Buffer;
  timeoutMs?: number;
}

function readOptional(path: string | undefined, label: string): Buffer | undefined {
  const value = (path ?? "").trim();
  if (value === "") return undefined;
  try {
    return fs.readFileSync(value);
  } catch (error) {
    throw new Error(
      `读取 ${label} 失败（${value}）：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** 控制面单次请求超时（默认 15s）。 */
export function runnerHttpTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = 15_000
): number {
  const raw = Number((env.AOS_RUNNER_HTTP_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallbackMs;
}

/** 数据面（spec/资产/结果）单次请求超时（默认 300s，避免大安装包被控制面短超时截断）。 */
export function runnerDataTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return runnerHttpTimeoutMs(env, 300_000);
}

/** runner 侧 TLS fetch：有 AOS_RUNNER_TLS_CA/CERT/KEY 时启用，否则返回 undefined 让调用方用全局 fetch。 */
export function createRunnerFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch | undefined {
  const ca = readOptional(env.AOS_RUNNER_TLS_CA, "AOS_RUNNER_TLS_CA");
  const cert = readOptional(env.AOS_RUNNER_TLS_CERT, "AOS_RUNNER_TLS_CERT");
  const key = readOptional(env.AOS_RUNNER_TLS_KEY, "AOS_RUNNER_TLS_KEY");
  if (ca === undefined && cert === undefined && key === undefined) return undefined;
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error("AOS_RUNNER_TLS_CERT 与 AOS_RUNNER_TLS_KEY 必须同时配置");
  }
  const timeoutMs = runnerDataTimeoutMs(env);
  const options: RunnerFetchOptions = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    timeoutMs
  };
  return createFetch(options);
}

function createFetch(options: RunnerFetchOptions): typeof fetch {
  const agent = new https.Agent({
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    ...(options.cert === undefined ? {} : { cert: options.cert }),
    ...(options.key === undefined ? {} : { key: options.key }),
    rejectUnauthorized: true,
    keepAlive: true
  });

  const impl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const normalized = new Headers(init.headers);
      normalized.forEach((value, key) => {
        headers[key] = value;
      });
    }
    const body = normalizeBody(init?.body as unknown);
    if (body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(body.byteLength);
    }
    const client = url.protocol === "https:" ? https : http;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = client.request(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          ...(url.protocol === "https:" ? { agent } : {})
        },
        resolve
      );
      request.setTimeout(options.timeoutMs ?? 300_000, () => {
        request.destroy(new Error(`runner TLS fetch 超时（${options.timeoutMs ?? 300_000}ms）`));
      });
      request.on("error", reject);
      const signal = init?.signal;
      const onAbort = (): void => {
        request.destroy(new Error("runner request aborted"));
      };
      if (signal != null) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        request.on("close", () => signal.removeEventListener("abort", onAbort));
      }
      if (body !== undefined) request.write(body);
      request.end();
    });
    return await toResponse(response);
  };
  return impl as typeof fetch;
}

function normalizeBody(body: unknown): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Buffer) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  throw new Error("runner TLS fetch 仅支持字符串/字节类请求体");
}

async function toResponse(response: http.IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, String(value));
    }
  }
  const status = response.statusCode ?? 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: response.statusMessage ?? "",
    headers,
    url: "",
    redirected: false,
    type: "basic",
    body: null,
    bodyUsed: false,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    },
    async blob(): Promise<Blob> {
      return new Blob([raw]);
    },
    async bytes(): Promise<Uint8Array> {
      return raw;
    },
    async json(): Promise<unknown> {
      return JSON.parse(raw.toString("utf8"));
    },
    async text(): Promise<string> {
      return raw.toString("utf8");
    },
    clone(): Response {
      throw new Error("runner TLS fetch 不支持 clone()");
    }
  } as unknown as Response;
}
