import fs from "node:fs";
import path from "node:path";

import type { ProjectStore } from "../../db/types.js";
import { configDirAbs } from "../../artemis/assembly.js";
import { loadProject } from "../../config/loader.js";
import { designFlowsPath } from "../../figma/design-source.js";
import { leaseTokenMatches } from "./lease-token.js";
import { RunnerControlError } from "./errors.js";
import { assertLlmProject, resolveCenterLlm } from "./llm-resolver.js";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES = 20 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function assertProject(
  store: ProjectStore,
  rootPath: string,
  hostId: string
): Promise<void> {
  const project = await store.getProjectByPath(rootPath);
  if (project === null) throw new RunnerControlError("not-found", `项目未登记：${rootPath}`);
  if (project.hostId !== null && project.hostId !== hostId) {
    throw new RunnerControlError("forbidden", `项目不属于主机 ${hostId}`);
  }
}

async function assertTaskVisible(
  store: ProjectStore,
  rootPath: string,
  taskId: string,
  hostId: string
): Promise<void> {
  const task = await store.getRegressionTask(rootPath, taskId);
  if (task === null) throw new RunnerControlError("not-found", `未知任务 ${taskId}`);
  if (task.targetHostId !== null && task.targetHostId !== hostId) {
    throw new RunnerControlError("forbidden", `任务 ${taskId} 不属于主机 ${hostId}`);
  }
  if (task.claimedHostId !== null && task.claimedHostId !== hostId) {
    throw new RunnerControlError("forbidden", `任务 ${taskId} 已被其他主机领取`);
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RunnerControlError("invalid-state", `参数 ${key} 必须是非空字符串`);
  }
  return value;
}

function requireObject<T>(args: Record<string, unknown>, key: string): T {
  const value = asRecord(args[key]);
  if (value === null) throw new RunnerControlError("invalid-state", `参数 ${key} 必须是对象`);
  return value as T;
}


/** suite 数据面领域服务：收口 host/project/task 校验与 store 操作，HTTP 层只做鉴权/路由。 */
export class SuiteControlService {
  constructor(
    private readonly store: ProjectStore,
    private readonly hostId: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly instanceId: string = "",
    private readonly publicBaseUrl: string = ""
  ) {}

  /** 跨主机 runner 只被授权访问中心指定的默认项目；其余仍按项目 host 校验。 */
  private async assertRunnerProject(rootPath: string, _hostId?: string): Promise<void> {
    const defaultProject = (this.env.AOS_RUNNER_DEFAULT_PROJECT ?? "").trim();
    if (
      defaultProject !== "" &&
      path.resolve(defaultProject) === path.resolve(rootPath)
    ) {
      const project = await this.store.getProjectByPath(rootPath);
      if (project === null) {
        throw new RunnerControlError("not-found", `项目未登记：${rootPath}`);
      }
      return;
    }
    await assertProject(this.store, rootPath, this.hostId);
  }

  private async assertTaskInstance(rootPath: string, taskId: string): Promise<void> {
    const task = await this.store.getRegressionTask(rootPath, taskId);
    if (task === null) throw new RunnerControlError("not-found", `未知任务 ${taskId}`);
    const claimed = (task.claimedInstanceId ?? "").trim();
    if (claimed !== "" && claimed !== this.instanceId) {
      throw new RunnerControlError(
        "instance-mismatch",
        `任务 ${taskId} 已绑定执行实例 ${claimed}，当前实例 ${this.instanceId || "（缺失）"} 不能写入`
      );
    }
  }

  async getTaskBundle(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    const taskId = requireString(args, "taskId");
    await this.assertRunnerProject(rootPath, this.hostId);
    const task = await this.store.getRegressionTask(rootPath, taskId);
    if (task === null) return null;
    await assertTaskVisible(this.store, rootPath, taskId, this.hostId);
    const [project, caseSets] = await Promise.all([
      this.store.getProjectByPath(rootPath),
      this.store.listCaseSets(rootPath)
    ]);
    const wanted = new Set(task.refs.map((ref) => ref.caseSetId));
    const selected = caseSets.filter((set) => wanted.has(set.id));
    const documents: Array<{
      caseSetId: string;
      featureKey: string;
      jsonPath: string;
      content: string;
    }> = [];
    let totalBytes = 0;
    for (const set of selected) {
      for (const feature of set.features) {
        try {
          const stat = fs.statSync(feature.jsonPath);
          if (stat.size > MAX_DOCUMENT_BYTES || totalBytes + stat.size > MAX_TOTAL_DOCUMENT_BYTES) {
            continue;
          }
          documents.push({
            caseSetId: set.id,
            featureKey: feature.key,
            jsonPath: feature.jsonPath,
            content: fs.readFileSync(feature.jsonPath, "utf8")
          });
          totalBytes += stat.size;
        } catch {
          /* 缺失份由 runner 在执行时如实报“份不可读”，不阻断 bundle。 */
        }
      }
    }
    let flows: { path: string; content: string } | null = null;
    try {
      const loaded = loadProject({
        env: { ...this.env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" }
      });
      const flowsPath = designFlowsPath(
        { configDirAbs: configDirAbs(loaded.config, loaded.rootDir), project: loaded },
        this.env
      );
      const stat = fs.statSync(flowsPath);
      if (stat.size <= MAX_DOCUMENT_BYTES) {
        flows = { path: flowsPath, content: fs.readFileSync(flowsPath, "utf8") };
      }
    } catch {
      flows = null;
    }
    return {
      task,
      project,
      caseSets: selected,
      documents,
      flows
    };
  }

  async getTask(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    const taskId = requireString(args, "taskId");
    await this.assertRunnerProject(rootPath, this.hostId);
    await assertTaskVisible(this.store, rootPath, taskId, this.hostId);
    return await this.store.getRegressionTask(rootPath, taskId);
  }

  async updateTask(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    const taskId = requireString(args, "taskId");
    await this.assertRunnerProject(rootPath, this.hostId);
    await assertTaskVisible(this.store, rootPath, taskId, this.hostId);
    await this.assertTaskInstance(rootPath, taskId);
    const patch = requireObject<Parameters<ProjectStore["updateRegressionTask"]>[2]>(args, "patch");
    return await this.store.updateRegressionTask(rootPath, taskId, patch);
  }

  async listCaseSets(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    await this.assertRunnerProject(rootPath, this.hostId);
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return await this.store.listCaseSets(rootPath, limit);
  }

  async recordRun(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["recordSuiteRun"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    if (input.run.regressionTaskId !== null && input.run.regressionTaskId !== "") {
      await this.assertTaskInstance(input.rootPath, input.run.regressionTaskId);
    }
    return await this.store.recordSuiteRun(input);
  }

  async listRuns(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    await this.assertRunnerProject(rootPath, this.hostId);
    const rawQuery = args.query;
    const query =
      rawQuery === undefined || rawQuery === null
        ? undefined
        : (asRecord(rawQuery) as Parameters<ProjectStore["listSuiteRuns"]>[1]);
    return await this.store.listSuiteRuns(rootPath, query);
  }

  async getRun(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    const runId = requireString(args, "runId");
    await this.assertRunnerProject(rootPath, this.hostId);
    return await this.store.getSuiteRun(rootPath, runId);
  }

  async upsertProject(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["upsertProject"]>[0]>(args, "input");
    const existing = await this.store.getProjectByPath(input.rootPath);
    return await this.store.upsertProject({
      ...input,
      hostId: existing !== null ? existing.hostId : this.hostId
    });
  }

  async getProject(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    await this.assertRunnerProject(rootPath, this.hostId);
    return await this.store.getProjectByPath(rootPath);
  }

  /** 中心分配给 runner 的默认项目；runner 用它作为控制面 rootPath，不需要用户填路径。 */
  async getDefaultProject(): Promise<unknown> {
    const rootPath = (this.env.AOS_RUNNER_DEFAULT_PROJECT ?? "").trim();
    if (rootPath === "") return { found: false };
    const project = await this.store.getProjectByPath(rootPath);
    if (project === null) return { found: false };
    return { found: true, rootPath, name: project.name };
  }

  /** Runner 从中心取 LLM 访问方式：返回中心代理 URL（runner token 作为 key），
   * 真实 provider key 不出中心。仅经 runner token + host 校验后返回。 */
  async getLlm(args: Record<string, unknown>): Promise<unknown> {
    const requested = typeof args.rootPath === "string" ? args.rootPath.trim() : "";
    const rootPath =
      requested || (this.env.AOS_RUNNER_DEFAULT_PROJECT ?? "").trim();
    if (rootPath === "") {
      throw new RunnerControlError(
        "invalid-state",
        "中心未配置 AOS_RUNNER_DEFAULT_PROJECT，runner 请求也未带项目"
      );
    }
    await assertLlmProject(this.store, this.env, this.hostId, rootPath);
    const active = await resolveCenterLlm(this.store, this.env, rootPath);
    if (active === null) return { found: false };
    if (active.provider === "google") {
      throw new RunnerControlError(
        "invalid-state",
        "中心 LLM 代理暂不支持 Google provider；请把项目 active LLM 切到 OpenAI 兼容 provider"
      );
    }
    const base = this.publicBaseUrl.trim().replace(/\/+$/, "");
    if (base === "") {
      throw new RunnerControlError("invalid-state", "中心缺少 public base URL，无法生成 LLM 代理地址");
    }
    return {
      found: true,
      entry: {
        name: active.name,
        provider: "custom",
        model: active.model,
        baseUrl: `${base}/panel/api/runners/suite/llm/proxy/${Buffer.from(rootPath, "utf8").toString("base64url")}`,
        apiKey: null
      }
    };
  }

  async upsertHost(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["upsertHost"]>[0]>(args, "input");
    return await this.store.upsertHost({ ...input, id: this.hostId });
  }

  async upsertHostAddresses(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["upsertHostAddresses"]>[0]>(
      args,
      "input"
    );
    return await this.store.upsertHostAddresses({ ...input, hostId: this.hostId });
  }

  async upsertRunner(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["upsertRunner"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.upsertRunner({ ...input, hostId: this.hostId });
  }

  async markStopped(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["markRunnerStopped"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.markRunnerStopped(input);
  }

  async claimTask(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["claimRegressionTask"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.claimRegressionTask({ ...input, hostId: this.hostId });
  }

  async beginTask(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["beginExecution"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    await assertTaskVisible(this.store, input.rootPath, input.taskId, this.hostId);
    await this.assertTaskInstance(input.rootPath, input.taskId);
    return await this.store.beginExecution(input);
  }

  async releaseTasks(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["releaseRegressionTasks"]>[0]>(
      args,
      "input"
    );
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.releaseRegressionTasks(input);
  }

  async releaseTask(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["releaseRegressionTask"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    await assertTaskVisible(this.store, input.rootPath, input.taskId, this.hostId);
    return await this.store.releaseRegressionTask(input);
  }

  async listStopping(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["listStoppingTasks"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.listStoppingTasks(input);
  }

  async finalizeCancellation(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["finalizeCancellation"]>[0]>(
      args,
      "input"
    );
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.finalizeCancellation(input);
  }

  async ackCancellation(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["ackCancellation"]>[0]>(args, "input");
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.ackCancellation(input);
  }

  async cancelTask(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["cancelRegressionTask"]>[0]>(
      args,
      "input"
    );
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.cancelRegressionTask({ ...input, actorHostId: this.hostId });
  }

  async releaseStale(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["releaseStaleClaims"]>[0]>(
      args,
      "input"
    );
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.releaseStaleClaims(input);
  }

  async acquireLeases(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["acquireDeviceLeases"]>[0]>(
      args,
      "input"
    );
    return await this.store.acquireDeviceLeases({ ...input, hostId: this.hostId });
  }

  async renewLeases(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["renewDeviceLeases"]>[0]>(args, "input");
    const tokens = asRecord((input as { leaseTokens?: unknown }).leaseTokens);
    if (tokens === null) {
      throw new RunnerControlError("forbidden", "suite 租约续租缺少 leaseTokens");
    }
    for (const serial of input.serials) {
      const token = typeof tokens[serial] === "string" ? tokens[serial] : "";
      if (!leaseTokenMatches(this.env, this.hostId, input.taskId, serial, token)) {
        throw new RunnerControlError("forbidden", `suite 设备租约令牌无效（${serial}）`);
      }
    }
    return await this.store.renewDeviceLeases({ ...input, hostId: this.hostId });
  }

  async listSchedules(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    await this.assertRunnerProject(rootPath, this.hostId);
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return await this.store.listSchedules(rootPath, limit);
  }

  async claimSchedule(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["claimScheduleWindow"]>[0]>(
      args,
      "input"
    );
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.claimScheduleWindow(input);
  }

  async updateSchedule(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    const scheduleId = requireString(args, "scheduleId");
    await this.assertRunnerProject(rootPath, this.hostId);
    const patch = requireObject<Parameters<ProjectStore["updateSchedule"]>[2]>(args, "patch");
    return await this.store.updateSchedule(rootPath, scheduleId, patch);
  }

  async createTask(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["createRegressionTask"]>[0]>(
      args,
      "input"
    );
    await this.assertRunnerProject(input.rootPath, this.hostId);
    return await this.store.createRegressionTask({ ...input, createdHostId: this.hostId });
  }

  async recordAudit(args: Record<string, unknown>): Promise<unknown> {
    const rootPath = requireString(args, "rootPath");
    await this.assertRunnerProject(rootPath, this.hostId);
    const input = requireObject<Parameters<ProjectStore["recordAudit"]>[1]>(args, "input");
    return await this.store.recordAudit(rootPath, input);
  }

  async releaseLeases(args: Record<string, unknown>): Promise<unknown> {
    const input = requireObject<Parameters<ProjectStore["releaseDeviceLeases"]>[0]>(
      args,
      "input"
    );
    const serials = input.serials ?? [];
    const tokens = asRecord((input as { leaseTokens?: unknown }).leaseTokens);
    if (tokens === null) {
      throw new RunnerControlError("forbidden", "suite 租约释放缺少 leaseTokens");
    }
    for (const serial of serials) {
      const token = typeof tokens[serial] === "string" ? tokens[serial] : "";
      if (!leaseTokenMatches(this.env, this.hostId, input.taskId, serial, token)) {
        throw new RunnerControlError("forbidden", `suite 设备租约令牌无效（${serial}）`);
      }
    }
    return await this.store.releaseDeviceLeases({ ...input, hostId: this.hostId });
  }

  async execute(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "getTaskBundle":
        return await this.getTaskBundle(args);
      case "getTask":
        return await this.getTask(args);
      case "updateTask":
        return await this.updateTask(args);
      case "listCaseSets":
        return await this.listCaseSets(args);
      case "recordRun":
        return await this.recordRun(args);
      case "listRuns":
        return await this.listRuns(args);
      case "getRun":
        return await this.getRun(args);
      case "upsertProject":
        return await this.upsertProject(args);
      case "getProject":
        return await this.getProject(args);
      case "getDefaultProject":
        return await this.getDefaultProject();
      case "getLlm":
        return await this.getLlm(args);
      case "upsertHost":
        return await this.upsertHost(args);
      case "upsertHostAddresses":
        return await this.upsertHostAddresses(args);
      case "upsertRunner":
        return await this.upsertRunner(args);
      case "markStopped":
        return await this.markStopped(args);
      case "claimTask":
        return await this.claimTask(args);
      case "beginTask":
        return await this.beginTask(args);
      case "releaseTasks":
        return await this.releaseTasks(args);
      case "releaseTask":
        return await this.releaseTask(args);
      case "listStopping":
        return await this.listStopping(args);
      case "finalizeCancellation":
        return await this.finalizeCancellation(args);
      case "ackCancellation":
        return await this.ackCancellation(args);
      case "cancelTask":
        return await this.cancelTask(args);
      case "releaseStale":
        return await this.releaseStale(args);
      case "acquireLeases":
        return await this.acquireLeases(args);
      case "renewLeases":
        return await this.renewLeases(args);
      case "listSchedules":
        return await this.listSchedules(args);
      case "claimSchedule":
        return await this.claimSchedule(args);
      case "updateSchedule":
        return await this.updateSchedule(args);
      case "createTask":
        return await this.createTask(args);
      case "recordAudit":
        return await this.recordAudit(args);
      case "releaseLeases":
        return await this.releaseLeases(args);
      default:
        throw new RunnerControlError("not-found", `未知 suite 数据操作 ${op}`);
    }
  }
}
