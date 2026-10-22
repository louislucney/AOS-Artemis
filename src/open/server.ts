import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { JobManager, JobQueueFullError, type JobError, type JobRecord } from "./jobs.js";
import { loadJobs, saveJobs } from "./job-store.js";
import { isJson, isMultipart, parseMultipart } from "./multipart.js";
import {
  OpenJobError,
  runOpenJob,
  type OpenJobInput,
  type OpenJobResult
} from "./pipeline.js";

const JSON_LIMIT = 1 * 1024 * 1024;
const MULTIPART_LIMIT = 55 * 1024 * 1024;
const FILE_LIMIT = 50 * 1024 * 1024;

export interface CmsOpenServerOptions {
  host?: string;
  port?: number;
  cors?: string[];
  allowedHosts?: string[];
  /** 设置后除 GET /healthz 与 OPTIONS 外必须携带 Authorization: Bearer <token>。 */
  authToken?: string;
  maxQueue?: number;
  maxConcurrent?: number;
  jobTimeoutMs?: number;
  retentionMs?: number;
  workRoot?: string;
  now?: () => number;
  runner?: (
    input: OpenJobInput,
    workDir: string,
    isCancelled: () => boolean
  ) => Promise<OpenJobResult>;
}

export interface CmsOpenServer {
  host: string;
  port: number;
  bootId: string;
  /** 手动触发超时/保留期检查（测试与运维用；正常由 30s ticker 驱动）。 */
  tick: () => void;
  close: () => Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  readonly headers?: Record<string, string>;
  constructor(
    status: number,
    code: string,
    message: string,
    hint?: string,
    headers?: Record<string, string>
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.headers = headers;
  }
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function hostNameOf(header: string | undefined): string {
  if (!header) return "";
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    return end >= 0 ? header.slice(1, end) : header;
  }
  return header.split(":")[0] ?? "";
}

function defaultHosts(host: string): string[] {
  const allowed = new Set(["127.0.0.1", "localhost", "::1"]);
  if (host !== "0.0.0.0" && host !== "::") allowed.add(host);
  return [...allowed];
}

/** HTTP 状态响应不暴露服务端绝对路径；下载统一走 /jobs/:id/download。 */
function publicJob(job: JobRecord): Omit<JobRecord, "artifactPath"> {
  const { artifactPath: _artifactPath, ...rest } = job;
  return rest;
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(413, "payload_too_large", `请求体超过上限（${limit} bytes）`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseLlm(value: unknown): OpenJobInput["llm"] {
  if (value === undefined || value === null || value === "") return null;
  let raw: unknown;
  try {
    raw = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw new HttpError(400, "invalid_request", "llm 不是合法 JSON");
  }
  if (!raw || typeof raw !== "object") throw new HttpError(400, "invalid_request", "llm 必须是对象");
  const record = raw as { baseUrl?: unknown; model?: unknown; apiKey?: unknown };
  if (
    typeof record.baseUrl !== "string" ||
    typeof record.model !== "string" ||
    typeof record.apiKey !== "string" ||
    record.baseUrl.trim() === "" ||
    record.model.trim() === "" ||
    record.apiKey.trim() === ""
  ) {
    throw new HttpError(400, "invalid_request", "llm 需要 baseUrl / model / apiKey");
  }
  return { baseUrl: record.baseUrl, model: record.model, apiKey: record.apiKey };
}

function sourceOf(value: unknown): { type: "figma" | "pen"; url?: string; token?: string; nodeId?: string } {
  if (typeof value === "string") {
    if (value === "figma" || value === "pen") return { type: value };
    throw new HttpError(400, "invalid_source", `未知 source：${value}`);
  }
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_source", "缺少 source");
  }
  const record = value as { type?: unknown; url?: unknown; token?: unknown; nodeId?: unknown };
  const type = record.type === "pen" ? "pen" : record.type === "figma" ? "figma" : null;
  if (type === null) throw new HttpError(400, "invalid_source", "source.type 必须是 figma 或 pen");
  return {
    type,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.token === "string" ? { token: record.token } : {}),
    ...(typeof record.nodeId === "string" ? { nodeId: record.nodeId } : {})
  };
}

function numberField(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid_request", `${name} 必须是正数`);
  }
  return Math.trunc(parsed);
}

function booleanField(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(text)) return true;
  if (["false", "0", "no"].includes(text)) return false;
  throw new HttpError(400, "invalid_request", `${name} 必须是布尔值`);
}

function validateFigma(source: { type: string; url?: string }, penFile?: string): void {
  if (source.type === "figma" && !source.url) {
    throw new HttpError(400, "invalid_source", "缺少 figmaUrl");
  }
  if (source.type === "pen" && !penFile) {
    throw new HttpError(400, "invalid_source", "缺少 penFile 上传");
  }
}

async function saveUpload(
  file: { filename: string; data: Buffer },
  workDir: string,
  fallback: string,
  extensions: string[]
): Promise<string> {
  const ext = path.extname(file.filename).toLowerCase();
  if (!extensions.includes(ext)) {
    throw new HttpError(400, "invalid_source", `仅支持 ${extensions.join("/")} 文件`);
  }
  if (file.data.length > FILE_LIMIT) {
    throw new HttpError(413, "payload_too_large", "单文件超过 50 MB");
  }
  const rawBase = path.basename(file.filename, ext);
  const safeBase =
    rawBase
      .replace(/[^\w\u4e00-\u9fff.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || fallback;
  const target = path.join(workDir, `${safeBase}${ext}`);
  await mkdir(workDir, { recursive: true });
  await writeFile(target, file.data);
  return target;
}

export async function startCmsOpenServer(
  options: CmsOpenServerOptions = {}
): Promise<CmsOpenServer> {
  const host = options.host ?? "127.0.0.1";
  const cors = options.cors ?? [];
  const allowedHosts = new Set([...defaultHosts(host), ...(options.allowedHosts ?? [])]);
  const workRoot = path.resolve(options.workRoot ?? path.join(os.tmpdir(), "aos-cms-open"));
  await mkdir(workRoot, { recursive: true });
  const bootId = randomUUID();
  const jobsFile = path.join(workRoot, "jobs.json");
  const authToken = options.authToken?.trim() || null;
  const manager = new JobManager({
    maxQueue: options.maxQueue,
    maxConcurrent: options.maxConcurrent,
    jobTimeoutMs: options.jobTimeoutMs,
    retentionMs: options.retentionMs,
    now: options.now,
    initial: loadJobs(jobsFile),
    onChange: (snapshot) => saveJobs(jobsFile, snapshot),
    onExpire: (id) => {
      try {
        rmSync(path.join(workRoot, id), { recursive: true, force: true });
      } catch {
        /* 清理失败不阻断 tick */
      }
    }
  });
  // 启动时把 queued/running 标为 job_interrupted，并清掉没有台账记录的孤儿工作目录。
  saveJobs(jobsFile, manager.snapshot());
  const knownJobs = new Set(manager.snapshot().map((job) => job.id));
  for (const entry of await readdir(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || knownJobs.has(entry.name)) continue;
    try {
      await rm(path.join(workRoot, entry.name), { recursive: true, force: true });
    } catch {
      /* 孤儿清理 best effort */
    }
  }
  const inputs = new Map<string, OpenJobInput>();
  const customRunner = options.runner;
  let active = 0;

  const tick = (): void => {
    manager.tick();
  };

  const pump = (): void => {
    while (active < (options.maxConcurrent ?? 3)) {
      const job = manager.claimNext();
      if (!job) return;
      const input = inputs.get(job.id);
      if (!input) {
        manager.fail(job.id, { code: "internal", message: "任务输入丢失" });
        continue;
      }
      active += 1;
      const workDir = path.join(workRoot, job.id);
      const run =
        customRunner ??
        ((jobInput: OpenJobInput, dir: string, isCancelled: () => boolean) =>
          runOpenJob(jobInput, dir, {
            isCancelled,
            onStep: (step) => manager.setStep(job.id, step)
          }));
      run(input, workDir, () => manager.cancelRequested(job.id))
        .then((result) => {
          if (manager.cancelRequested(job.id)) manager.markCancelled(job.id);
          else manager.complete(job.id, result.zipPath);
        })
        .catch((error: unknown) => {
          manager.fail(job.id, toJobError(error));
        })
        .finally(() => {
          active -= 1;
          inputs.delete(job.id);
          pump();
        });
    }
  };

  const json = (
    res: http.ServerResponse,
    status: number,
    payload: unknown,
    origin: string | null,
    extraHeaders: Record<string, string> = {}
  ): void => {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    };
    if (origin !== null) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  };
  const fail = (res: http.ServerResponse, error: HttpError, origin: string | null): void => {
    json(
      res,
      error.status,
      { error: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) },
      origin,
      error.headers ?? {}
    );
  };

  const server = http.createServer(async (request, response) => {
    const originHeader = request.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : null;
    const allowedOrigin = origin !== null && (cors.includes("*") || cors.includes(origin)) ? origin : null;
    try {
      const hostName = hostNameOf(request.headers.host);
      if ((origin !== null && allowedOrigin === null) || !allowedHosts.has(hostName)) {
        throw new HttpError(403, "forbidden", "来源或主机不在允许列表");
      }
      if (request.method === "OPTIONS") {
        if (origin !== null && allowedOrigin === null) {
          throw new HttpError(403, "forbidden", "来源不在 CORS 白名单");
        }
        const headers: Record<string, string> = {
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization"
        };
        if (allowedOrigin !== null) {
          headers["access-control-allow-origin"] = allowedOrigin;
          headers.vary = "Origin";
        }
        response.writeHead(204, headers);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { ok: true, bootId }, allowedOrigin);
        return;
      }
      if (authToken !== null && !isAuthorized(request.headers.authorization, authToken)) {
        throw new HttpError(
          401,
          "unauthorized",
          "缺少或错误的访问令牌",
          "请在 Authorization 头使用 Bearer <token>",
          { "www-authenticate": "Bearer" }
        );
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        const contentType = request.headers["content-type"] ?? "";
        const limit = isMultipart(request) ? MULTIPART_LIMIT : JSON_LIMIT;
        if (!isJson(request) && !isMultipart(request)) {
          throw new HttpError(400, "invalid_request", "仅支持 application/json 或 multipart/form-data");
        }
        const body = await readBody(request, limit);
        let input: OpenJobInput;
        let penUpload: { filename: string; data: Buffer } | null = null;
        let templateUpload: { filename: string; data: Buffer } | null = null;
        if (isMultipart(request)) {
          const parsed = await parseMultipart(body, String(contentType));
          const source = sourceOf(
            parsed.fields.get("source") ??
              parsed.fields.get("sourceType") ??
              (parsed.fields.get("figmaUrl") ? "figma" : undefined)
          );
          const urlField = parsed.fields.get("figmaUrl")?.trim();
          const tokenField = parsed.fields.get("figmaToken")?.trim();
          const nodeField = parsed.fields.get("figmaNodeId")?.trim();
          const merged = {
            type: source.type,
            ...(source.url ?? (urlField ? urlField : undefined)
              ? { url: source.url ?? urlField }
              : {}),
            ...(source.token ?? (tokenField ? tokenField : undefined)
              ? { token: source.token ?? tokenField }
              : {}),
            ...(source.nodeId ?? (nodeField ? nodeField : undefined)
              ? { nodeId: source.nodeId ?? nodeField }
              : {})
          };
          penUpload = parsed.files.get("penFile") ?? null;
          templateUpload = parsed.files.get("template") ?? null;
          validateFigma(merged, penUpload ? "pending" : undefined);
          const staticFallback = booleanField(
            parsed.fields.get("staticFallback"),
            "staticFallback"
          );
          input = {
            source: merged.type,
            ...(merged.url ? { figmaUrl: merged.url } : {}),
            ...(merged.token ? { figmaToken: merged.token } : {}),
            ...(merged.nodeId ? { nodeId: merged.nodeId } : {}),
            ...(staticFallback === undefined ? {} : { staticFallback }),
            llm: parseLlm(parsed.fields.get("llm")),
            ...(numberField(parsed.fields.get("maxFlows"), "maxFlows") === undefined
              ? {}
              : { maxFlows: numberField(parsed.fields.get("maxFlows"), "maxFlows") }),
            ...(numberField(parsed.fields.get("maxDepth"), "maxDepth") === undefined
              ? {}
              : { maxDepth: numberField(parsed.fields.get("maxDepth"), "maxDepth") })
          };
        } else {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body.toString("utf-8") || "{}") as Record<string, unknown>;
          } catch {
            throw new HttpError(400, "invalid_request", "请求体不是合法 JSON");
          }
          const source = sourceOf(parsed.source);
          validateFigma(source);
          const staticFallback = booleanField(parsed.staticFallback, "staticFallback");
          input = {
            source: source.type,
            ...(source.url ? { figmaUrl: source.url } : {}),
            ...(source.token ? { figmaToken: source.token } : {}),
            ...(source.nodeId ? { nodeId: source.nodeId } : {}),
            ...(staticFallback === undefined ? {} : { staticFallback }),
            llm: parseLlm(parsed.llm),
            ...(numberField(parsed.maxFlows, "maxFlows") === undefined
              ? {}
              : { maxFlows: numberField(parsed.maxFlows, "maxFlows") }),
            ...(numberField(parsed.maxDepth, "maxDepth") === undefined
              ? {}
              : { maxDepth: numberField(parsed.maxDepth, "maxDepth") })
          };
        }
        const job = manager.create();
        const workDir = path.join(workRoot, job.id);
        if (penUpload) {
          input.penFile = await saveUpload(penUpload, workDir, "design", [".pen"]);
        }
        if (templateUpload) {
          input.templatePath = await saveUpload(templateUpload, workDir, "template", [".xlsx"]);
        }
        inputs.set(job.id, input);
        json(response, 202, { jobId: job.id }, allowedOrigin);
        pump();
        return;
      }
      const match = /^\/jobs\/([^/]+)(\/download)?$/.exec(url.pathname);
      if (match) {
        const jobId = decodeURIComponent(match[1]!);
        const job = manager.get(jobId);
        if (!job) {
          throw new HttpError(
            404,
            "job_not_found",
            "任务不存在或服务已重启",
            "请重新提交生成任务"
          );
        }
        if (request.method === "GET" && match[2] === undefined) {
          json(response, 200, { ...publicJob(job), jobId: job.id }, allowedOrigin);
          return;
        }
        if (request.method === "DELETE" && match[2] === undefined) {
          const cancelled = manager.cancel(jobId);
          json(
            response,
            200,
            cancelled === null ? cancelled : { ...publicJob(cancelled), jobId: cancelled.id },
            allowedOrigin
          );
          return;
        }
        if (request.method === "GET" && match[2] === "/download") {
          if (job.status !== "done" || job.artifactPath === null) {
            throw new HttpError(409, "job_not_ready", `任务状态 ${job.status}，暂不可下载`);
          }
          try {
            await stat(job.artifactPath);
          } catch {
            throw new HttpError(410, "job_expired", "产物已过期或已清理");
          }
          const headers: Record<string, string> = {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="design-tests-${jobId}.zip"`
          };
          if (allowedOrigin !== null) {
            headers["access-control-allow-origin"] = allowedOrigin;
            headers.vary = "Origin";
          }
          response.writeHead(200, headers);
          createReadStream(job.artifactPath).pipe(response);
          return;
        }
      }
      throw new HttpError(404, "not_found", "not found");
    } catch (error) {
      if (error instanceof HttpError) {
        fail(response, error, allowedOrigin);
        return;
      }
      if (error instanceof JobQueueFullError) {
        fail(response, new HttpError(429, "queue_full", error.message, "稍后重试"), allowedOrigin);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      fail(response, new HttpError(500, "internal", message), allowedOrigin);
    }
  });

  const ticker = setInterval(tick, 30_000);
  ticker.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8780, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 8780);
  return {
    host,
    port,
    bootId,
    tick,
    close: async () => {
      clearInterval(ticker);
      try {
        saveJobs(jobsFile, manager.snapshot());
      } catch {
        /* 关闭时持久化 best effort */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function toJobError(error: unknown): JobError {
  if (error instanceof OpenJobError) {
    return { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error)
  };
}
