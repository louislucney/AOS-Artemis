import type { ZodType } from "zod";

import type { ProjectStore } from "../../db/types.js";
import { WebRunnerAlreadyActiveError } from "../../db/types.js";
import { errorMessage } from "../../util.js";
import {
  LeaseReleaseRequestSchema,
  LeaseRenewRequestSchema,
  MAX_RUNNER_CONTROL_BODY_BYTES,
  RunnerControlErrorResponseSchema,
  RunnerInstanceRequestSchema,
  RunnerStopRequestSchema,
  TaskReleaseRequestSchema,
  TaskTerminalRequestSchema,
  WebClaimRequestSchema,
  WebHeartbeatRequestSchema,
  matchRunnerControlPath,
  type RunnerControlRoute
} from "./contract.js";
import { authenticateRunner } from "./auth.js";
import { RunnerControlError, WebRunnerControlService } from "./service.js";

export interface RunnerControlHttpInput {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface RunnerControlHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

const JSON_TYPE = "application/json; charset=utf-8";

function json(status: number, payload: unknown): RunnerControlHttpResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(payload) };
}

function errorJson(status: number, code: string, error: string): RunnerControlHttpResponse {
  const payload = RunnerControlErrorResponseSchema.parse({ ok: false, code, error });
  return json(status, payload);
}

function parseBody<T>(
  schema: ZodType<T>,
  body: unknown
): { ok: true; value: T } | { ok: false; response: RunnerControlHttpResponse } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const message = parsed.error.issues.map((issue) => issue.message).join("；") || "请求体不合法";
  return { ok: false, response: errorJson(400, "invalid-body", message) };
}

function routeMethodAllowed(method: string): boolean {
  return method === "POST";
}

export function runnerControlBodyLimit(): number {
  return MAX_RUNNER_CONTROL_BODY_BYTES;
}

export async function handleRunnerControlRequest(
  input: RunnerControlHttpInput
): Promise<RunnerControlHttpResponse> {
  const env = input.env ?? process.env;
  if ((env.AOS_RUNNER_CONTROL ?? "").trim() === "0") {
    return errorJson(404, "control-disabled", "runner 控制面已关闭（AOS_RUNNER_CONTROL=0）");
  }
  const route = matchRunnerControlPath(input.url.pathname);
  if (route === null) return errorJson(404, "not-found", "未知 runner 控制面路由");
  if (!routeMethodAllowed(input.method)) {
    return errorJson(405, "method-not-allowed", "runner 控制面仅接受 POST");
  }
  const auth = authenticateRunner(input.headers, env);
  if (!auth.ok) return errorJson(auth.status, auth.code, auth.error);
  const hostId = auth.hostId;
  try {
    switch (route.kind) {
      case "heartbeat":
        return await handleHeartbeat(input, hostId, env);
      case "claim":
        return await handleClaim(input, hostId, env);
      case "renewLeases":
        return await handleRenewLeases(input, hostId, env);
      case "releaseLeases":
        return await handleReleaseLeases(input, hostId, env);
      case "begin":
        return await handleBegin(input, hostId, route, env);
      case "progress":
        return await handleProgress(input, hostId, route, env);
      case "terminal":
        return await handleTerminal(input, hostId, route, env);
      case "cancelAck":
        return await handleCancelAck(input, hostId, route, env);
      case "releaseTask":
        return await handleReleaseTask(input, hostId, route, env);
      case "stop":
        return await handleStop(input, hostId, env);
      default:
        return errorJson(404, "not-found", "未知 runner 控制面路由");
    }
  } catch (error) {
    return mapError(error);
  }
}

function serviceFor(
  input: RunnerControlHttpInput,
  hostId: string,
  env: NodeJS.ProcessEnv,
  instanceId: string
): WebRunnerControlService {
  return new WebRunnerControlService({
    store: input.store,
    hostId,
    instanceId,
    env,
    ...(input.now === undefined ? {} : { now: input.now })
  });
}

async function handleHeartbeat(
  input: RunnerControlHttpInput,
  hostId: string,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(WebHeartbeatRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const service = serviceFor(input, hostId, env, body.instanceId);
  const response = await service.heartbeat({
    host: body.host,
    name: body.name,
    version: body.version,
    artifactBaseUrl: body.artifactBaseUrl,
    inventory: body.inventory,
    active: body.active
  });
  return json(200, response);
}

async function handleClaim(
  input: RunnerControlHttpInput,
  hostId: string,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(WebClaimRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  return json(200, await service.claim(parsed.value.deviceSerial));
}

async function handleRenewLeases(
  input: RunnerControlHttpInput,
  hostId: string,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(LeaseRenewRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  const results = [];
  for (const serial of parsed.value.serials) {
    results.push(
      await service.renewLease(parsed.value.taskId, serial, parsed.value.leaseToken)
    );
  }
  return json(200, {
    renewed: results.filter((entry) => entry.renewed > 0).length,
    serverTime: new Date(input.now?.() ?? Date.now()).toISOString()
  });
}

async function handleReleaseLeases(
  input: RunnerControlHttpInput,
  hostId: string,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(LeaseReleaseRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  const results = [];
  for (const serial of parsed.value.serials) {
    results.push(
      await service.releaseLease(parsed.value.taskId, serial, parsed.value.leaseToken)
    );
  }
  return json(200, {
    released: results.reduce((total, entry) => total + entry.released, 0)
  });
}

async function handleBegin(
  input: RunnerControlHttpInput,
  hostId: string,
  route: Extract<RunnerControlRoute, { kind: "begin" }>,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(RunnerInstanceRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  return json(200, await service.begin(route.taskId));
}

async function handleProgress(
  input: RunnerControlHttpInput,
  hostId: string,
  route: Extract<RunnerControlRoute, { kind: "progress" }>,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(RunnerInstanceRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  return json(200, await service.progress(route.taskId));
}

async function handleTerminal(
  input: RunnerControlHttpInput,
  hostId: string,
  route: Extract<RunnerControlRoute, { kind: "terminal" }>,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(TaskTerminalRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  const outcome = await service.terminal(
    route.taskId,
    parsed.value.status,
    parsed.value.detail
  );
  return json(200, { outcome });
}

async function handleCancelAck(
  input: RunnerControlHttpInput,
  hostId: string,
  route: Extract<RunnerControlRoute, { kind: "cancelAck" }>,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(RunnerInstanceRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  await service.cancelAck(route.taskId);
  return json(200, { ok: true });
}

async function handleReleaseTask(
  input: RunnerControlHttpInput,
  hostId: string,
  route: Extract<RunnerControlRoute, { kind: "releaseTask" }>,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(TaskReleaseRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  await service.release(route.taskId, parsed.value.to);
  return json(200, { ok: true });
}

async function handleStop(
  input: RunnerControlHttpInput,
  hostId: string,
  env: NodeJS.ProcessEnv
): Promise<RunnerControlHttpResponse> {
  const parsed = parseBody(RunnerStopRequestSchema, input.body);
  if (!parsed.ok) return parsed.response;
  const service = serviceFor(input, hostId, env, parsed.value.instanceId);
  await service.stop();
  return json(200, { ok: true });
}

function mapError(error: unknown): RunnerControlHttpResponse {
  if (error instanceof RunnerControlError) {
    return errorJson(error.status, error.code, error.message);
  }
  if (error instanceof WebRunnerAlreadyActiveError) {
    return errorJson(409, "runner-already-active", error.message);
  }
  return errorJson(500, "internal", errorMessage(error));
}
