import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  LlmBudgetSnapshot,
  LlmPoolTokenRecord,
  LlmPriceRecord,
  LlmReservationRecord,
  LlmUsageSource,
  LlmUsageStatus,
  NormalizedUsage,
  ProjectStore
} from "../../db/types.js";
import { errorMessage, log, logWarn } from "../../util.js";
import { reserveForRequest, settleReservation } from "../../llm/pool/budget-service.js";
import { estimateRequest, type RequestEstimate } from "../../llm/pool/estimate.js";
import {
  baseCurrencyFrom,
  computeCost,
  findPrice,
  penaltyRate
} from "../../llm/pool/pricing.js";
import { rewriteProviderRequest } from "../../llm/pool/provider-adapter.js";
import { createStreamTap } from "../../llm/pool/stream.js";
import { estimatedUsage, normalizeUsage } from "../../llm/pool/usage.js";
import { authenticateRunner } from "./auth.js";
import { assertLlmProject, resolveCenterLlmCandidates } from "./llm-resolver.js";
import { RunnerControlError } from "./errors.js";

const PREFIX = "/panel/api/runners/suite/llm/proxy/";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 300_000;
const RECONCILE_INTERVAL_MS = 60_000;

let lastReconcileAt = 0;

export interface LlmProxyInput {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
}

interface ProxyAttempt {
  candidate: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    poolTokenId: string | null;
  };
  token: LlmPoolTokenRecord | null;
  reservation: LlmReservationRecord | null;
  estimate: RequestEstimate;
  price: LlmPriceRecord;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export { rewriteProviderRequest as rewriteDeepSeekStructuredOutput };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBillableRequest(body: Record<string, unknown> | null): boolean {
  return (
    body !== null &&
    (Array.isArray(body.messages) ||
      typeof body.prompt === "string" ||
      Array.isArray(body.prompt) ||
      typeof body.input === "string" ||
      Array.isArray(body.input))
  );
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

function reconcileInBackground(store: ProjectStore): void {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  lastReconcileAt = now;
  void store.reconcileLlmReservations({ limit: 20 }).catch((error: unknown) => {
    logWarn(`LLM 预留 TTL 回收失败：${errorMessage(error)}`);
  });
}

async function updateTokenHealth(
  store: ProjectStore,
  token: LlmPoolTokenRecord | null,
  status: number
): Promise<void> {
  if (token === null) return;
  try {
    await store.upsertLlmPoolToken({
      id: token.id,
      name: token.name,
      provider: token.provider,
      baseUrl: token.baseUrl,
      status: status === 401 || status === 403 ? "invalid" : "active",
      lastError: `upstream-http-${status}`
    });
  } catch (error) {
    logWarn(`LLM token 健康状态回写失败：${errorMessage(error)}`);
  }
}

function priceFor(
  prices: readonly LlmPriceRecord[],
  provider: string,
  model: string,
  at: string,
  baseCurrency: string,
  env: NodeJS.ProcessEnv
): LlmPriceRecord {
  return (
    findPrice(prices, provider, model, at) ??
    penaltyRate(prices, baseCurrency, env)
  );
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
  const auth = authenticateRunner(input.req.headers, env, {
    // Artemis/OpenAI 客户端只带 Authorization；共享 LLM 模式下允许无 host，
    // 仍由全局 runner token 鉴权（项目 host 校验由 assertLlmProject 负责）。
    allowHostless: (env.AOS_RUNNER_SHARED_LLM ?? "").trim() === "1"
  });
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

  reconcileInBackground(input.store);

  const resolution = await resolveCenterLlmCandidates(input.store, env, rootPath);
  if (resolution === null) {
    logWarn(`中心 LLM 代理无可用条目：${rootPath}`);
    json(input.res, 503, {
      ok: false,
      code: "llm-not-configured",
      error: "中心项目没有可用的 active LLM（model/baseUrl/apiKey）"
    });
    return;
  }
  if (resolution.error !== null) {
    json(input.res, 503, {
      ok: false,
      code: "llm-pool-token-unavailable",
      error: resolution.error
    });
    return;
  }
  const candidates = resolution.candidates.filter(
    (candidate) => candidate.baseUrl !== "" && candidate.apiKey !== ""
  );
  if (candidates.length === 0) {
    if (resolution.candidates.some((candidate) => candidate.provider === "google")) {
      json(input.res, 501, {
        ok: false,
        code: "llm-proxy-unsupported",
        error: "中心 LLM 代理暂不支持 Google provider"
      });
      return;
    }
    logWarn(`中心 LLM 代理无可用条目：${rootPath}`);
    json(input.res, 503, {
      ok: false,
      code: "llm-not-configured",
      error: "中心项目没有可用的 active LLM（model/baseUrl/apiKey）"
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

  const requestContentType = input.req.headers["content-type"];
  const contentType =
    typeof requestContentType === "string" ? requestContentType.toLowerCase() : "";
  const billablePath = suffix === "/chat/completions" || suffix === "/responses";
  let parsedBody: Record<string, unknown> | null = null;
  if (body !== undefined && body.length > 0) {
    try {
      parsedBody = asRecord(JSON.parse(body.toString("utf8")) as unknown);
    } catch {
      parsedBody = null;
    }
    if (billablePath && parsedBody === null) {
      json(input.res, 400, {
        ok: false,
        code: "invalid-body",
        error: "计费路径需要合法 JSON 请求体"
      });
      return;
    }
    if (contentType.includes("application/json") && parsedBody === null) {
      json(input.res, 400, { ok: false, code: "invalid-body", error: "请求体不是合法 JSON" });
      return;
    }
  }
  if (
    resolution.mode !== "project" &&
    parsedBody !== null &&
    typeof parsedBody.model === "string" &&
    parsedBody.model !== resolution.model
  ) {
    json(input.res, 400, {
      ok: false,
      code: "llm-model-mismatch",
      error: `请求模型 "${parsedBody.model}" 与项目绑定模型 "${resolution.model}" 不一致`
    });
    return;
  }

  const billable = isBillableRequest(parsedBody);
  const at = new Date().toISOString();
  const baseCurrency = baseCurrencyFrom(env);
  let prices: LlmPriceRecord[] = [];
  try {
    prices = await input.store.listLlmPrices();
  } catch (error) {
    logWarn(`LLM 价格表读取失败（按惩罚价）：${errorMessage(error)}`);
  }
  const incomingRequestId = input.req.headers["x-request-id"];
  const requestId = typeof incomingRequestId === "string" ? incomingRequestId : null;

  let chosen: ProxyAttempt | null = null;
  let lastSnapshot: LlmBudgetSnapshot | null = null;
  for (const candidate of candidates) {
    if (!billable) {
      chosen = {
        candidate,
        token: null,
        reservation: null,
        estimate: estimateRequest(parsedBody, env),
        price: priceFor(prices, candidate.provider, candidate.model, at, baseCurrency, env)
      };
      break;
    }
    if (candidate.poolTokenId === null) {
      chosen = {
        candidate,
        token: null,
        reservation: null,
        estimate: estimateRequest(parsedBody, env),
        price: priceFor(prices, candidate.provider, candidate.model, at, baseCurrency, env)
      };
      break;
    }
    const token = await input.store.getLlmPoolToken(candidate.poolTokenId);
    if (token === null) continue;
    const reserved = await reserveForRequest({
      store: input.store,
      token,
      projectRoot: rootPath,
      provider: candidate.provider,
      model: candidate.model,
      source: "center_proxy",
      requestBody: parsedBody,
      env,
      prices,
      baseCurrency,
      at,
      context: { hostId: auth.hostId, requestId }
    });
    if (!reserved.ok) {
      lastSnapshot = reserved.snapshot;
      continue;
    }
    chosen = {
      candidate,
      token,
      reservation: reserved.reservation,
      estimate: reserved.estimate,
      price: reserved.price
    };
    break;
  }
  if (chosen === null) {
    if (lastSnapshot !== null) {
      json(input.res, 402, {
        ok: false,
        code: "llm-budget-exhausted",
        error: "所有可用 token 的预算或并发已满",
        snapshot: lastSnapshot
      });
      return;
    }
    json(input.res, 503, {
      ok: false,
      code: "llm-pool-token-unavailable",
      error: "no-token"
    });
    return;
  }

  const isStream = parsedBody?.stream === true;
  let forwardBody = body;
  if (parsedBody !== null) {
    const rewritten = rewriteProviderRequest(parsedBody, {
      provider: chosen.candidate.provider,
      model: chosen.candidate.model,
      baseUrl: chosen.candidate.baseUrl
    });
    let outbound = asRecord(rewritten.body) ?? parsedBody;
    let changed = rewritten.rewritten;
    if (isStream && chosen.token?.supportsStreamUsage === true) {
      const existing = asRecord(outbound.stream_options) ?? {};
      outbound = { ...outbound, stream_options: { ...existing, include_usage: true } };
      changed = true;
    }
    if (changed) {
      forwardBody = Buffer.from(JSON.stringify(outbound), "utf8");
      if (rewritten.rewritten) {
        log(
          `中心 LLM 代理：DeepSeek 不支持 json_schema，已降级为 json_object（schema 已追加到提示）`
        );
      }
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${chosen.candidate.apiKey}`,
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
  const forwardUrl = `${chosen.candidate.baseUrl.replace(/\/+$/, "")}${suffix}`;
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(forwardUrl, {
      method: input.req.method,
      headers,
      ...(forwardBody === undefined || forwardBody.length === 0 ? {} : { body: forwardBody }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    logWarn(
      `中心 LLM 代理请求失败：${suffix} · ${Date.now() - startedAt}ms（host=${auth.hostId} · ${chosen.candidate.provider}/${chosen.candidate.model}）· ${errorMessage(error)}`
    );
    if (chosen.reservation !== null) {
      await settleReservation({
        store: input.store,
        reservation: chosen.reservation,
        usage: null,
        usageSource: "estimated",
        price: chosen.price,
        baseCurrency,
        status: "settled_estimated",
        errorClass: timeout ? "timeout" : "network"
      }).catch((settleError: unknown) => {
        logWarn(`LLM 预留结算失败：${errorMessage(settleError)}`);
      });
    }
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
      `中心 LLM 代理上游失败：HTTP ${upstream.status}${suffix} · ${Date.now() - startedAt}ms（host=${auth.hostId} · ${chosen.candidate.provider}/${chosen.candidate.model}）${text.trim() === "" ? "" : ` · ${text.slice(0, 500)}`}`
    );
    if (chosen.reservation !== null) {
      await input.store
        .releaseLlmReservation({ reservationId: chosen.reservation.id })
        .catch((releaseError: unknown) => {
          logWarn(`LLM 预留释放失败：${errorMessage(releaseError)}`);
        });
    }
    await updateTokenHealth(input.store, chosen.token, upstream.status);
    input.res.writeHead(upstream.status, responseHeaders);
    input.res.end(text);
    return;
  }

  log(
    `中心 LLM 代理完成：HTTP ${upstream.status}${suffix} · ${Date.now() - startedAt}ms（host=${auth.hostId} · ${chosen.candidate.provider}/${chosen.candidate.model}）`
  );
  input.res.writeHead(upstream.status, responseHeaders);

  let settled = false;
  const finalize = async (
    usage: NormalizedUsage | null,
    usageSource: LlmUsageSource,
    status: LlmUsageStatus,
    errorClass: string | null = null
  ): Promise<void> => {
    if (settled) return;
    settled = true;
    if (!billable && chosen.reservation === null) return;
    try {
      if (chosen.reservation !== null) {
        await settleReservation({
          store: input.store,
          reservation: chosen.reservation,
          usage,
          usageSource,
          price: chosen.price,
          baseCurrency,
          status,
          errorClass,
          at: new Date().toISOString()
        });
        return;
      }
      const actual =
        usage ?? estimatedUsage(chosen.estimate.promptTokens, chosen.estimate.completionTokens);
      const cost = computeCost(actual, chosen.price, baseCurrency);
      await input.store.recordLlmUsage({
        projectRoot: rootPath,
        hostId: auth.hostId,
        poolTokenId: null,
        provider: chosen.candidate.provider,
        model: chosen.candidate.model,
        usage: actual,
        usageSource: usage === null ? "estimated" : usageSource,
        costMicros: cost.costMicros,
        currency: cost.currency,
        costMicrosBase: cost.costMicrosBase,
        baseCurrency,
        fxRateToBase: cost.fxRateToBase,
        priceBookId: cost.priceBookId,
        priceVersion: cost.priceVersion,
        source: "center_proxy",
        requestId,
        status,
        errorClass
      });
    } catch (error) {
      logWarn(`LLM 用量结算失败：${errorMessage(error)}`);
    }
  };

  if (input.req.method === "HEAD" || upstream.body === null) {
    await finalize(null, "estimated", "settled_estimated");
    input.res.end();
    return;
  }

  const upstreamContentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  if (upstreamContentType.includes("text/event-stream")) {
    const tap = createStreamTap();
    const stream = Readable.fromWeb(upstream.body as never);
    let finished = false;
    input.res.on("close", () => {
      if (finished) return;
      finished = true;
      stream.destroy();
      void finalize(
        estimatedUsage(chosen.estimate.promptTokens, tap.estimatedOutputTokens()),
        "partial",
        "settled_estimated"
      );
    });
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tap.push(buffer);
      if (!input.res.writableEnded) input.res.write(buffer);
    });
    stream.on("end", () => {
      if (finished) return;
      finished = true;
      tap.end();
      const actual = tap.usage();
      const usage =
        actual ?? estimatedUsage(chosen.estimate.promptTokens, tap.estimatedOutputTokens());
      void finalize(
        usage,
        actual === null ? "estimated" : "provider",
        actual === null ? "settled_estimated" : "ok"
      ).finally(() => {
        if (!input.res.writableEnded) input.res.end();
      });
    });
    stream.on("error", (error: unknown) => {
      if (!finished) {
        finished = true;
        void finalize(
          estimatedUsage(chosen.estimate.promptTokens, tap.estimatedOutputTokens()),
          "partial",
          "settled_estimated",
          "stream-error"
        );
      }
      logWarn(`中心 LLM 代理流读取失败：${errorMessage(error)}`);
      if (!input.res.writableEnded) input.res.destroy();
    });
    return;
  }

  const text = await upstream.text().catch(() => "");
  let usage: NormalizedUsage | null = null;
  try {
    const parsed = asRecord(JSON.parse(text) as unknown);
    usage = normalizeUsage(parsed?.usage);
  } catch {
    usage = null;
  }
  await finalize(
    usage,
    usage === null ? "estimated" : "provider",
    usage === null ? "settled_estimated" : "ok"
  );
  input.res.end(text);
}


