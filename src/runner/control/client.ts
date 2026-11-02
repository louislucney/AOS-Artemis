import { WebRunnerAlreadyActiveError } from "../../db/types.js";
import {
  LeaseReleaseRequestSchema,
  LeaseReleaseResponseSchema,
  LeaseRenewRequestSchema,
  LeaseRenewResponseSchema,
  RUNNER_CONTROL_PATHS,
  RunnerControlErrorResponseSchema,
  RunnerInstanceRequestSchema,
  RunnerStopRequestSchema,
  RunnerStopResponseSchema,
  TaskBeginResponseSchema,
  TaskCancelAckResponseSchema,
  TaskProgressResponseSchema,
  TaskReleaseRequestSchema,
  TaskReleaseResponseSchema,
  TaskTerminalRequestSchema,
  TaskTerminalResponseSchema,
  WebClaimRequestSchema,
  WebClaimResponseSchema,
  WebHeartbeatRequestSchema,
  WebHeartbeatResponseSchema,
  runnerTaskPath,
  type LeaseReleaseResponse,
  type LeaseRenewResponse,
  type RunnerInstanceRequest,
  type TaskBeginResponse,
  type TaskProgressResponse,
  type TaskReleaseResponse,
  type WebClaimResponse,
  type WebHeartbeatResponse
} from "./contract.js";
import type {
  WebRunnerControl,
  WebRunnerHeartbeatInput,
  WebRunnerTerminalOutcome,
  WebRunnerTerminalStatus
} from "./web-control.js";

export class RunnerControlHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RunnerControlHttpError";
    this.status = status;
    this.code = code;
  }
}

export interface HttpWebRunnerControlOptions {
  baseUrl: string;
  token: string;
  hostId: string;
  instanceId: string;
  fetchImpl?: typeof fetch;
  /** 单次控制面请求超时；缺省 15s。 */
  timeoutMs?: number;
}

/** 执行机侧控制面客户端：只发命令，不持有数据库连接。 */
export class HttpWebRunnerControl implements WebRunnerControl {
  readonly hostId: string;
  readonly instanceId: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpWebRunnerControlOptions) {
    this.hostId = options.hostId;
    this.instanceId = options.instanceId;
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "x-aos-host-id": this.hostId,
      "content-type": "application/json"
    };
  }

  private async request<T>(
    path: string,
    body: unknown,
    schema: { parse: (value: unknown) => T }
  ): Promise<T> {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new RunnerControlHttpError(
        0,
        "network-error",
        `控制面请求失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    const text = await response.text();
    let payload: unknown = undefined;
    if (text.trim() !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RunnerControlHttpError(
          response.status,
          "invalid-json",
          `控制面返回非 JSON（HTTP ${response.status}）`
        );
      }
    }
    if (!response.ok) {
      const parsed = RunnerControlErrorResponseSchema.safeParse(payload);
      const code = parsed.success ? parsed.data.code : `http-${response.status}`;
      const message = parsed.success ? parsed.data.error : `控制面请求失败（HTTP ${response.status}）`;
      if (code === "runner-already-active") {
        throw new WebRunnerAlreadyActiveError({
          hostId: this.hostId,
          existingInstanceId: null,
          incomingInstanceId: this.instanceId
        });
      }
      throw new RunnerControlHttpError(response.status, code, message);
    }
    try {
      return schema.parse(payload);
    } catch (error) {
      throw new RunnerControlHttpError(
        response.status,
        "invalid-response",
        `控制面响应不符合契约：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async heartbeat(input: WebRunnerHeartbeatInput): Promise<WebHeartbeatResponse> {
    const body = {
      host: input.host,
      name: input.name,
      version: input.version,
      artifactBaseUrl: input.artifactBaseUrl,
      instanceId: this.instanceId,
      inventory: input.inventory,
      active: input.active
    };
    WebHeartbeatRequestSchema.parse(body);
    return await this.request(RUNNER_CONTROL_PATHS.heartbeat, body, WebHeartbeatResponseSchema);
  }

  async claim(deviceSerial: string): Promise<WebClaimResponse> {
    const body = WebClaimRequestSchema.parse({ instanceId: this.instanceId, deviceSerial });
    return await this.request(RUNNER_CONTROL_PATHS.claim, body, WebClaimResponseSchema);
  }

  async begin(taskId: string): Promise<TaskBeginResponse> {
    const body: RunnerInstanceRequest = RunnerInstanceRequestSchema.parse({
      instanceId: this.instanceId
    });
    return await this.request(runnerTaskPath(taskId, "begin"), body, TaskBeginResponseSchema);
  }

  async progress(taskId: string): Promise<TaskProgressResponse> {
    const body: RunnerInstanceRequest = RunnerInstanceRequestSchema.parse({
      instanceId: this.instanceId
    });
    return await this.request(runnerTaskPath(taskId, "progress"), body, TaskProgressResponseSchema);
  }

  async terminal(
    taskId: string,
    status: WebRunnerTerminalStatus,
    detail?: string
  ): Promise<WebRunnerTerminalOutcome> {
    const body = TaskTerminalRequestSchema.parse({
      instanceId: this.instanceId,
      status,
      ...(detail === undefined ? {} : { detail })
    });
    const response = await this.request(
      runnerTaskPath(taskId, "terminal"),
      body,
      TaskTerminalResponseSchema
    );
    return response.outcome;
  }

  async cancelAck(taskId: string): Promise<void> {
    await this.request(
      runnerTaskPath(taskId, "cancel-ack"),
      RunnerInstanceRequestSchema.parse({ instanceId: this.instanceId }),
      TaskCancelAckResponseSchema
    );
  }

  async release(taskId: string, to: "pending" | "failed"): Promise<void> {
    const body = TaskReleaseRequestSchema.parse({ instanceId: this.instanceId, to });
    await this.request<TaskReleaseResponse>(
      runnerTaskPath(taskId, "release"),
      body,
      TaskReleaseResponseSchema
    );
  }

  async renewLease(
    taskId: string,
    serial: string,
    leaseToken: string
  ): Promise<LeaseRenewResponse> {
    const body = LeaseRenewRequestSchema.parse({
      instanceId: this.instanceId,
      taskId,
      serials: [serial],
      leaseToken
    });
    return await this.request(RUNNER_CONTROL_PATHS.renewLeases, body, LeaseRenewResponseSchema);
  }

  async releaseLease(
    taskId: string,
    serial: string,
    leaseToken: string
  ): Promise<LeaseReleaseResponse> {
    const body = LeaseReleaseRequestSchema.parse({
      instanceId: this.instanceId,
      taskId,
      serials: [serial],
      leaseToken
    });
    return await this.request(RUNNER_CONTROL_PATHS.releaseLeases, body, LeaseReleaseResponseSchema);
  }

  async stop(): Promise<void> {
    const body = RunnerStopRequestSchema.parse({ instanceId: this.instanceId });
    await this.request(
      RUNNER_CONTROL_PATHS.stop,
      body,
      RunnerStopResponseSchema
    );
  }
}

export function createHttpWebRunnerControl(
  options: HttpWebRunnerControlOptions
): WebRunnerControl {
  return new HttpWebRunnerControl(options);
}
