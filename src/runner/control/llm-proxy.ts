import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ProjectStore } from "../../db/types.js";
import { errorMessage, log, logWarn } from "../../util.js";
import { authenticateRunner } from "./auth.js";
import { RunnerControlError } from "./errors.js";
import { assertLlmProject, resolveCenterLlm } from "./llm-resolver.js";

const PREFIX = "/panel/api/runners/suite/llm/proxy/";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 300_000;

export interface LlmProxyInput {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 中心 LLM 代理：runner 用 runner token 调中心，中心替换成真实 provider key 后转发。
 * 只支持 OpenAI 兼容 provider；google 直接拒绝（不伪装成功）。 */
export async function handleLlmProxyRequest(input: LlmProxyInput): Promise<void> {
  const env = input.env ?? process.env;
  const startedAt = Date.now();
  const hostHeader = input.req.headers["x-aos-host-id"];
  log(
    `中心 LLM 代理请求：${input.req.method} ${input.url.pathname}（host=${typeof hostHeader === "string" ? hostHeader : "-"}）`
  );
  const auth = authenticateRunner(input.req.headers, env);
  if (!auth.ok) {
    logWarn(`中心 LLM 代理鉴权失败：HTTP ${auth.status} ${auth.code} · ${auth.error}`);
    json(input.res, auth.status, { ok: false, code: auth.code, error: auth.error });
    return;
  }
  const rest = input.url.pathname.slice(PREFIX.length);
  if (rest === "") {
    logWarn("中心 LLM 代理缺少中心项目路径");
    json(input.res, 404, { ok: false, code: "not-found", error: "缺少中心项目路径" });
    return;
  }
  const slash = rest.indexOf("/");
  const encodedRoot = slash === -1 ? rest : rest.slice(0, slash);
  const suffix = slash === -1 ? "" : rest.slice(slash);
  let rootPath: string;
  try {
    rootPath = Buffer.from(encodedRoot, "base64url").toString("utf8");
  } catch {
    json(input.res, 400, { ok: false, code: "invalid-path", error: "项目路径编码无效" });
    return;
  }
  if (rootPath === "") {
    logWarn("中心 LLM 代理项目路径为空");
    json(input.res, 400, { ok: false, code: "invalid-path", error: "项目路径为空" });
    return;
  }
  try {
    await assertLlmProject(input.store, env, auth.hostId, rootPath);
  } catch (error) {
    if (error instanceof RunnerControlError) {
      logWarn(`中心 LLM 代理项目校验失败：HTTP ${error.status} ${error.code} · ${error.message}`);
      json(input.res, error.status, { ok: false, code: error.code, error: error.message });
      return;
    }
    json(input.res, 500, { ok: false, code: "internal", error: errorMessage(error) });
    return;
  }
  const active = await resolveCenterLlm(input.store, env, rootPath);
  if (active === null || !active.baseUrl || !active.apiKey) {
    logWarn(`中心 LLM 代理无可用条目：${rootPath}`);
    json(input.res, 503, {
      ok: false,
      code: "llm-not-configured",
      error: "中心项目没有可用的 active LLM（model/baseUrl/apiKey）"
    });
    return;
  }
  if (active.provider === "google") {
    json(input.res, 501, {
      ok: false,
      code: "llm-proxy-unsupported",
      error: "中心 LLM 代理暂不支持 Google provider"
    });
    return;
  }

  let body: Buffer | undefined;
  if (input.req.method !== "GET" && input.req.method !== "HEAD") {
    try {
      body = await readBody(input.req);
    } catch (error) {
      if (error instanceof Error && error.message === "body-too-large") {
        json(input.res, 413, { ok: false, code: "body-too-large", error: "请求体超过 32MB" });
        return;
      }
      json(input.res, 400, { ok: false, code: "invalid-body", error: errorMessage(error) });
      return;
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${active.apiKey}`,
    "accept-encoding": "identity"
  };
  for (const name of [
    "content-type",
    "accept",
    "openai-organization",
    "openai-beta",
    "user-agent"
  ]) {
    const value = input.req.headers[name];
    if (typeof value === "string" && value.trim() !== "") headers[name] = value;
  }
  const forwardUrl = `${active.baseUrl.replace(/\/+$/, "")}${suffix}`;
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(forwardUrl, {
      method: input.req.method,
      headers,
      ...(body === undefined || body.length === 0 ? {} : { body }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    logWarn(
      `中心 LLM 代理请求失败：${suffix} · ${Date.now() - startedAt}ms（host=${auth.hostId} · ${active.name}/${active.model}）· ${errorMessage(error)}`
    );
    json(input.res, timeout ? 504 : 502, {
      ok: false,
      code: timeout ? "upstream-timeout" : "upstream-error",
      error: `上游 LLM 请求失败：${errorMessage(error)}`
    });
    return;
  }

  const responseHeaders: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store"
  };
  for (const name of ["x-request-id", "openai-processing-ms", "openai-version"]) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders[name] = value;
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    logWarn(
      `中心 LLM 代理上游失败：HTTP ${upstream.status}${suffix} · ${Date.now() - startedAt}ms（host=${auth.hostId} · ${active.name}/${active.model}）${text.trim() === "" ? "" : ` · ${text.slice(0, 500)}`}`
    );
    input.res.writeHead(upstream.status, responseHeaders);
    input.res.end(text);
    return;
  }
  log(
    `中心 LLM 代理完成：HTTP ${upstream.status}${suffix} · ${Date.now() - startedAt}ms（host=${auth.hostId} · ${active.name}/${active.model}）`
  );
  input.res.writeHead(upstream.status, responseHeaders);
  if (input.req.method === "HEAD" || upstream.body === null) {
    input.res.end();
    return;
  }
  Readable.fromWeb(upstream.body as never)
    .on("error", () => {
      if (!input.res.writableEnded) input.res.destroy();
    })
    .pipe(input.res);
}
