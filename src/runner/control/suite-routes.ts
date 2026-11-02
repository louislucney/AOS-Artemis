export interface SuiteResourceRoute {
  op: string;
  args: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function q(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value === "" ? undefined : value;
}

function limit(url: URL): number | undefined {
  const raw = q(url, "limit");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** suite 资源路由：URL/方法 → 领域服务 op；只做形状转换，不做鉴权。 */
export function resolveSuiteResource(
  method: string,
  url: URL,
  body: unknown
): SuiteResourceRoute | null {
  const prefix = "/panel/api/runners/suite";
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  const parts = url.pathname
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const input = asRecord(body) ?? {};
  const root = q(url, "rootPath");

  if (method === "GET") {
    if (parts[0] === "tasks" && parts.length === 3 && parts[2] === "bundle" && root) {
      return { op: "getTaskBundle", args: { rootPath: root, taskId: parts[1] } };
    }
    if (parts[0] === "tasks" && parts.length === 2 && parts[1] !== "stopping" && root) {
      return { op: "getTask", args: { rootPath: root, taskId: parts[1] } };
    }
    if (parts[0] === "tasks" && parts[1] === "stopping" && parts.length === 2 && root) {
      return {
        op: "listStopping",
        args: {
          input: {
            rootPath: root,
            ...(q(url, "deadline") ? { deadline: q(url, "deadline") } : {}),
            ...(limit(url) ? { limit: limit(url) } : {})
          }
        }
      };
    }
    if (parts[0] === "case-sets" && parts.length === 1 && root) {
      return {
        op: "listCaseSets",
        args: { rootPath: root, ...(limit(url) ? { limit: limit(url) } : {}) }
      };
    }
    if (parts[0] === "runs" && parts.length === 1 && root) {
      const query: Record<string, unknown> = {};
      for (const key of ["taskId", "caseSetId", "featureKey", "platform"]) {
        const value = q(url, key);
        if (value) query[key] = value;
      }
      if (limit(url)) query.limit = limit(url);
      return { op: "listRuns", args: { rootPath: root, query } };
    }
    if (parts[0] === "runs" && parts.length === 2 && root) {
      return { op: "getRun", args: { rootPath: root, runId: parts[1] } };
    }
    if (parts[0] === "projects" && parts.length === 1 && root) {
      return { op: "getProject", args: { rootPath: root } };
    }
    if (parts[0] === "schedules" && parts.length === 1 && root) {
      return {
        op: "listSchedules",
        args: { rootPath: root, ...(limit(url) ? { limit: limit(url) } : {}) }
      };
    }
    return null;
  }

  if (method === "PATCH") {
    if (parts[0] === "tasks" && parts.length === 2) {
      const bodyRoot = typeof input.rootPath === "string" ? input.rootPath : undefined;
      const pathRoot = root ?? bodyRoot;
      return pathRoot
        ? { op: "updateTask", args: { rootPath: pathRoot, taskId: parts[1], patch: input.patch ?? {} } }
        : null;
    }
    if (parts[0] === "schedules" && parts.length === 2) {
      const bodyRoot = typeof input.rootPath === "string" ? input.rootPath : undefined;
      const pathRoot = root ?? bodyRoot;
      return pathRoot
        ? {
            op: "updateSchedule",
            args: { rootPath: pathRoot, scheduleId: parts[1], patch: input.patch ?? {} }
          }
        : null;
    }
    return null;
  }

  if (method !== "POST") return null;
  const action = parts[2];
  if (parts[0] === "tasks" && parts[1] === "claim" && parts.length === 2) {
    return { op: "claimTask", args: { input } };
  }
  if (parts[0] === "tasks" && parts[1] === "release" && parts.length === 2) {
    return { op: "releaseTasks", args: { input } };
  }
  if (parts[0] === "tasks" && parts[1] === "release-stale" && parts.length === 2) {
    return { op: "releaseStale", args: { input } };
  }
  if (parts[0] === "tasks" && parts.length === 1) {
    return { op: "createTask", args: { input } };
  }
  if (parts[0] === "tasks" && parts.length === 3) {
    if (action === "begin") return { op: "beginTask", args: { input } };
    if (action === "release") return { op: "releaseTask", args: { input } };
    if (action === "ack-cancellation") return { op: "ackCancellation", args: { input } };
    if (action === "finalize-cancellation") {
      return { op: "finalizeCancellation", args: { input } };
    }
    if (action === "cancel") return { op: "cancelTask", args: { input } };
    return null;
  }
  if (parts[0] === "runs" && parts.length === 1) return { op: "recordRun", args: { input } };
  if (parts[0] === "projects" && parts.length === 1) {
    return { op: "upsertProject", args: { input } };
  }
  if (parts[0] === "hosts" && parts.length === 1) return { op: "upsertHost", args: { input } };
  if (parts[0] === "hosts" && parts.length === 3 && parts[2] === "addresses") {
    return { op: "upsertHostAddresses", args: { input } };
  }
  if (parts[0] === "runners" && parts.length === 1) {
    return { op: "upsertRunner", args: { input } };
  }
  if (parts[0] === "runners" && parts.length === 3 && parts[2] === "stop") {
    return { op: "markStopped", args: { input } };
  }
  if (parts[0] === "leases" && parts.length === 2) {
    if (parts[1] === "acquire") return { op: "acquireLeases", args: { input } };
    if (parts[1] === "renew") return { op: "renewLeases", args: { input } };
    if (parts[1] === "release") return { op: "releaseLeases", args: { input } };
    return null;
  }
  if (parts[0] === "schedules" && parts[1] === "claim" && parts.length === 2) {
    return { op: "claimSchedule", args: { input } };
  }
  if (parts[0] === "audit" && parts.length === 1) {
    const bodyRoot = typeof input.rootPath === "string" ? input.rootPath : undefined;
    const pathRoot = root ?? bodyRoot;
    return pathRoot ? { op: "recordAudit", args: { rootPath: pathRoot, input: input.input ?? {} } } : null;
  }
  return null;
}
