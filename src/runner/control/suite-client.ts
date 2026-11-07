import type { ProjectStore } from "../../db/types.js";
import { leaseTokenFor } from "./lease-token.js";

export interface SuiteStoreClientOptions {
  baseUrl: string;
  token: string;
  hostId: string;
  fetchImpl?: typeof fetch;
  /** 单次数据面请求超时；缺省 15s。 */
  timeoutMs?: number;
  /** 任务写入实例 fencing；缺省不发送（兼容手工 CLI）。 */
  instanceId?: string;
  /** 中心项目根路径：runner 本地路径与中心不同时，控制面调用的 rootPath 统一改写成它。 */
  controlRootPath?: string;
}

export interface RunnerDefaultProject {
  found: boolean;
  rootPath?: string;
  name?: string;
}

export interface RunnerLlmEntry {
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}

export interface RunnerLlmConfig {
  found: boolean;
  entry?: RunnerLlmEntry;
}

export class SuiteStoreHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SuiteStoreHttpError";
    this.status = status;
    this.code = code;
  }
}

/** suite runner 的数据面客户端：只暴露 runner 需要的受限操作，不是任意 SQL/RPC。 */
export class SuiteStoreClient {
  readonly hostId: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly instanceId: string;
  private readonly controlRootPath: string | null;

  constructor(options: SuiteStoreClientOptions) {
    this.hostId = options.hostId;
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.instanceId = (options.instanceId ?? "").trim();
    this.controlRootPath = (options.controlRootPath ?? "").trim() || null;
  }

  private root(rootPath: string): string {
    return this.controlRootPath ?? rootPath;
  }

  private rewriteRoot<T extends { rootPath?: string }>(input: T): T {
    if (this.controlRootPath === null || input.rootPath === undefined) return input;
    return { ...input, rootPath: this.controlRootPath };
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<T> {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/panel/api/runners/suite${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-aos-host-id": this.hostId,
          ...(this.instanceId === "" ? {} : { "x-mobile-testing-instance-id": this.instanceId }),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new SuiteStoreHttpError(
        0,
        "network-error",
        `suite 数据面请求失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.trim() === "" ? null : JSON.parse(text);
    } catch {
      throw new SuiteStoreHttpError(
        response.status,
        "invalid-json",
        `suite 数据面返回非 JSON（HTTP ${response.status}）`
      );
    }
    const record =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!response.ok || record.ok !== true) {
      const code = typeof record.code === "string" ? record.code : `http-${response.status}`;
      const message =
        typeof record.error === "string" ? record.error : `suite 数据面失败（HTTP ${response.status}）`;
      throw new SuiteStoreHttpError(response.status, code, message);
    }
    return record.value as T;
  }

  async getRegressionTask(
    ...args: Parameters<ProjectStore["getRegressionTask"]>
  ): Promise<Awaited<ReturnType<ProjectStore["getRegressionTask"]>>> {
    return await this.request(
      "GET",
      `/tasks/${encodeURIComponent(args[1])}?rootPath=${encodeURIComponent(this.root(args[0]))}`
    );
  }

  async getTaskBundle(
    ...args: Parameters<NonNullable<ProjectStore["getTaskBundle"]>>
  ): Promise<Awaited<ReturnType<NonNullable<ProjectStore["getTaskBundle"]>>>> {
    return await this.request(
      "GET",
      `/tasks/${encodeURIComponent(args[1])}/bundle?rootPath=${encodeURIComponent(this.root(args[0]))}`
    );
  }

  async getDefaultProject(): Promise<RunnerDefaultProject> {
    return await this.request("GET", "/default-project");
  }

  async getLlm(rootPath: string): Promise<RunnerLlmConfig> {
    return await this.request(
      "GET",
      `/llm?rootPath=${encodeURIComponent(this.root(rootPath))}`
    );
  }

  async updateRegressionTask(
    ...args: Parameters<ProjectStore["updateRegressionTask"]>
  ): Promise<Awaited<ReturnType<ProjectStore["updateRegressionTask"]>>> {
    return await this.request("PATCH", `/tasks/${encodeURIComponent(args[1])}`, {
      rootPath: this.root(args[0]),
      patch: args[2]
    });
  }

  async listCaseSets(
    ...args: Parameters<ProjectStore["listCaseSets"]>
  ): Promise<Awaited<ReturnType<ProjectStore["listCaseSets"]>>> {
    const query = new URLSearchParams({ rootPath: this.root(args[0]) });
    if (args[1] !== undefined) query.set("limit", String(args[1]));
    return await this.request("GET", `/case-sets?${query.toString()}`);
  }

  async recordSuiteRun(
    ...args: Parameters<ProjectStore["recordSuiteRun"]>
  ): Promise<Awaited<ReturnType<ProjectStore["recordSuiteRun"]>>> {
    return await this.request("POST", "/runs", this.rewriteRoot(args[0]));
  }

  async listSuiteRuns(
    ...args: Parameters<ProjectStore["listSuiteRuns"]>
  ): Promise<Awaited<ReturnType<ProjectStore["listSuiteRuns"]>>> {
    const query = new URLSearchParams({ rootPath: this.root(args[0]) });
    for (const [key, value] of Object.entries(args[1] ?? {})) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    return await this.request("GET", `/runs?${query.toString()}`);
  }

  async getSuiteRun(
    ...args: Parameters<ProjectStore["getSuiteRun"]>
  ): Promise<Awaited<ReturnType<ProjectStore["getSuiteRun"]>>> {
    return await this.request(
      "GET",
      `/runs/${encodeURIComponent(args[1])}?rootPath=${encodeURIComponent(this.root(args[0]))}`
    );
  }

  async upsertProject(
    ...args: Parameters<ProjectStore["upsertProject"]>
  ): Promise<Awaited<ReturnType<ProjectStore["upsertProject"]>>> {
    return await this.request("POST", "/projects", this.rewriteRoot(args[0]));
  }

  async getProjectByPath(
    ...args: Parameters<ProjectStore["getProjectByPath"]>
  ): Promise<Awaited<ReturnType<ProjectStore["getProjectByPath"]>>> {
    return await this.request(
      "GET",
      `/projects?rootPath=${encodeURIComponent(this.root(args[0]))}`
    );
  }

  async upsertHost(
    ...args: Parameters<ProjectStore["upsertHost"]>
  ): Promise<Awaited<ReturnType<ProjectStore["upsertHost"]>>> {
    return await this.request("POST", "/hosts", args[0]);
  }

  async upsertHostAddresses(
    ...args: Parameters<ProjectStore["upsertHostAddresses"]>
  ): Promise<Awaited<ReturnType<ProjectStore["upsertHostAddresses"]>>> {
    return await this.request(
      "POST",
      `/hosts/${encodeURIComponent(args[0].hostId)}/addresses`,
      args[0]
    );
  }

  async upsertRunner(
    ...args: Parameters<ProjectStore["upsertRunner"]>
  ): Promise<Awaited<ReturnType<ProjectStore["upsertRunner"]>>> {
    return await this.request("POST", "/runners", this.rewriteRoot(args[0]));
  }

  async markRunnerStopped(
    ...args: Parameters<ProjectStore["markRunnerStopped"]>
  ): Promise<Awaited<ReturnType<ProjectStore["markRunnerStopped"]>>> {
    return await this.request(
      "POST",
      `/runners/${encodeURIComponent(args[0].runnerId)}/stop`,
      this.rewriteRoot(args[0])
    );
  }

  async claimRegressionTask(
    ...args: Parameters<ProjectStore["claimRegressionTask"]>
  ): Promise<Awaited<ReturnType<ProjectStore["claimRegressionTask"]>>> {
    return await this.request("POST", "/tasks/claim", this.rewriteRoot(args[0]));
  }

  async beginExecution(
    ...args: Parameters<ProjectStore["beginExecution"]>
  ): Promise<Awaited<ReturnType<ProjectStore["beginExecution"]>>> {
    return await this.request(
      "POST",
      `/tasks/${encodeURIComponent(args[0].taskId)}/begin`,
      this.rewriteRoot(args[0])
    );
  }

  async releaseRegressionTasks(
    ...args: Parameters<ProjectStore["releaseRegressionTasks"]>
  ): Promise<Awaited<ReturnType<ProjectStore["releaseRegressionTasks"]>>> {
    return await this.request("POST", "/tasks/release", this.rewriteRoot(args[0]));
  }

  async releaseRegressionTask(
    ...args: Parameters<ProjectStore["releaseRegressionTask"]>
  ): Promise<Awaited<ReturnType<ProjectStore["releaseRegressionTask"]>>> {
    return await this.request(
      "POST",
      `/tasks/${encodeURIComponent(args[0].taskId)}/release`,
      this.rewriteRoot(args[0])
    );
  }

  async listStoppingTasks(
    ...args: Parameters<ProjectStore["listStoppingTasks"]>
  ): Promise<Awaited<ReturnType<ProjectStore["listStoppingTasks"]>>> {
    const query = new URLSearchParams({ rootPath: this.root(args[0].rootPath) });
    if (args[0].deadline !== undefined) query.set("deadline", args[0].deadline);
    if (args[0].limit !== undefined) query.set("limit", String(args[0].limit));
    return await this.request("GET", `/tasks/stopping?${query.toString()}`);
  }

  async finalizeCancellation(
    ...args: Parameters<ProjectStore["finalizeCancellation"]>
  ): Promise<Awaited<ReturnType<ProjectStore["finalizeCancellation"]>>> {
    return await this.request(
      "POST",
      `/tasks/${encodeURIComponent(args[0].taskId)}/finalize-cancellation`,
      this.rewriteRoot(args[0])
    );
  }

  async ackCancellation(
    ...args: Parameters<ProjectStore["ackCancellation"]>
  ): Promise<Awaited<ReturnType<ProjectStore["ackCancellation"]>>> {
    return await this.request(
      "POST",
      `/tasks/${encodeURIComponent(args[0].taskId)}/ack-cancellation`,
      this.rewriteRoot(args[0])
    );
  }

  async cancelRegressionTask(
    ...args: Parameters<ProjectStore["cancelRegressionTask"]>
  ): Promise<Awaited<ReturnType<ProjectStore["cancelRegressionTask"]>>> {
    return await this.request(
      "POST",
      `/tasks/${encodeURIComponent(args[0].taskId)}/cancel`,
      this.rewriteRoot(args[0])
    );
  }

  async releaseStaleClaims(
    ...args: Parameters<ProjectStore["releaseStaleClaims"]>
  ): Promise<Awaited<ReturnType<ProjectStore["releaseStaleClaims"]>>> {
    return await this.request("POST", "/tasks/release-stale", this.rewriteRoot(args[0]));
  }

  async acquireDeviceLeases(
    ...args: Parameters<ProjectStore["acquireDeviceLeases"]>
  ): Promise<Awaited<ReturnType<ProjectStore["acquireDeviceLeases"]>>> {
    return await this.request("POST", "/leases/acquire", args[0]);
  }

  async renewDeviceLeases(
    ...args: Parameters<ProjectStore["renewDeviceLeases"]>
  ): Promise<Awaited<ReturnType<ProjectStore["renewDeviceLeases"]>>> {
    const input = args[0];
    const leaseTokens = Object.fromEntries(
      input.serials.map((serial) => [
        serial,
        leaseTokenFor({ MOBILE_TESTING_RUNNER_JOB_TOKEN: this.token }, this.hostId, input.taskId, serial)
      ])
    );
    return await this.request("POST", "/leases/renew", { ...input, leaseTokens });
  }

  async listSchedules(
    ...args: Parameters<ProjectStore["listSchedules"]>
  ): Promise<Awaited<ReturnType<ProjectStore["listSchedules"]>>> {
    const query = new URLSearchParams({ rootPath: this.root(args[0]) });
    if (args[1] !== undefined) query.set("limit", String(args[1]));
    return await this.request("GET", `/schedules?${query.toString()}`);
  }

  async claimScheduleWindow(
    ...args: Parameters<ProjectStore["claimScheduleWindow"]>
  ): Promise<Awaited<ReturnType<ProjectStore["claimScheduleWindow"]>>> {
    return await this.request("POST", "/schedules/claim", this.rewriteRoot(args[0]));
  }

  async updateSchedule(
    ...args: Parameters<ProjectStore["updateSchedule"]>
  ): Promise<Awaited<ReturnType<ProjectStore["updateSchedule"]>>> {
    return await this.request("PATCH", `/schedules/${encodeURIComponent(args[1])}`, {
      rootPath: this.root(args[0]),
      patch: args[2]
    });
  }

  async createRegressionTask(
    ...args: Parameters<ProjectStore["createRegressionTask"]>
  ): Promise<Awaited<ReturnType<ProjectStore["createRegressionTask"]>>> {
    return await this.request("POST", "/tasks", this.rewriteRoot(args[0]));
  }

  async recordAudit(
    ...args: Parameters<ProjectStore["recordAudit"]>
  ): Promise<Awaited<ReturnType<ProjectStore["recordAudit"]>>> {
    return await this.request("POST", "/audit", {
      rootPath: this.root(args[0]),
      input: args[1]
    });
  }

  async releaseDeviceLeases(
    ...args: Parameters<ProjectStore["releaseDeviceLeases"]>
  ): Promise<Awaited<ReturnType<ProjectStore["releaseDeviceLeases"]>>> {
    const input = args[0];
    const serials = input.serials ?? [];
    const leaseTokens = Object.fromEntries(
      serials.map((serial) => [
        serial,
        leaseTokenFor({ MOBILE_TESTING_RUNNER_JOB_TOKEN: this.token }, this.hostId, input.taskId, serial)
      ])
    );
    return await this.request("POST", "/leases/release", { ...input, leaseTokens });
  }
}
