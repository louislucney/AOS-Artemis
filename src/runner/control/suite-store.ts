import type { ProjectStore } from "../../db/types.js";
import type { SuiteStoreClient } from "./suite-client.js";

type Overrides = Partial<ProjectStore>;

/**
 * 项目机本地台账 + 中心 suite 数据面。
 * 本地 FileStore 负责项目配置、LLM、usage/audit 等本地数据；任务/用例集/run/租约/runner 注册走 HTTP。
 */
export function createHybridSuiteStore(
  local: ProjectStore,
  client: SuiteStoreClient
): ProjectStore {
  const overrides: Overrides = {
    getRegressionTask: (rootPath, id) => client.getRegressionTask(rootPath, id),
    getTaskBundle: (rootPath, id) => client.getTaskBundle(rootPath, id),
    downloadTaskApp: (rootPath, id) => client.downloadTaskApp(rootPath, id),
    updateRegressionTask: (rootPath, id, patch) =>
      client.updateRegressionTask(rootPath, id, patch),
    listCaseSets: (rootPath, limit) => client.listCaseSets(rootPath, limit),
    recordSuiteRun: (input) => client.recordSuiteRun(input),
    listSuiteRuns: (rootPath, query) => client.listSuiteRuns(rootPath, query),
    getSuiteRun: (rootPath, runId) => client.getSuiteRun(rootPath, runId),
    getProjectByPath: (rootPath) => client.getProjectByPath(rootPath),
    upsertProject: async (input) => {
      const remote = await client.upsertProject(input);
      await local.upsertProject(input);
      return remote;
    },
    upsertHost: (input) => client.upsertHost(input),
    upsertHostAddresses: (input) => client.upsertHostAddresses(input),
    upsertRunner: (input) => client.upsertRunner(input),
    markRunnerStopped: (input) => client.markRunnerStopped(input),
    claimRegressionTask: (input) => client.claimRegressionTask(input),
    beginExecution: (input) => client.beginExecution(input),
    releaseRegressionTasks: (input) => client.releaseRegressionTasks(input),
    releaseRegressionTask: (input) => client.releaseRegressionTask(input),
    listStoppingTasks: (input) => client.listStoppingTasks(input),
    finalizeCancellation: (input) => client.finalizeCancellation(input),
    ackCancellation: (input) => client.ackCancellation(input),
    cancelRegressionTask: (input) => client.cancelRegressionTask(input),
    releaseStaleClaims: (input) => client.releaseStaleClaims(input),
    acquireDeviceLeases: (input) => client.acquireDeviceLeases(input),
    renewDeviceLeases: (input) => client.renewDeviceLeases(input),
    releaseDeviceLeases: (input) => client.releaseDeviceLeases(input),
    listSchedules: (rootPath, limit) => client.listSchedules(rootPath, limit),
    claimScheduleWindow: (input) => client.claimScheduleWindow(input),
    updateSchedule: (rootPath, scheduleId, patch) =>
      client.updateSchedule(rootPath, scheduleId, patch),
    createRegressionTask: (input) => client.createRegressionTask(input),
    recordAudit: (rootPath, input) => client.recordAudit(rootPath, input)
  };

  const wrap = (store: ProjectStore): ProjectStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "scopeHost") {
          return (hostId: string | null): ProjectStore => wrap(target.scopeHost(hostId));
        }
        if (prop === "bindHost") {
          return (hostId: string): void => {
            target.bindHost(hostId);
          };
        }
        if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) {
          return overrides[prop as keyof Overrides];
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ProjectStore;

  return wrap(local);
}
