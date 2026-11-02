import { z } from "zod";

/** 控制面请求体上限：心跳带设备清单，1MB 足够；不接收资产/结果。 */
export const MAX_RUNNER_CONTROL_BODY_BYTES = 1024 * 1024;

export const RUNNER_CONTROL_PREFIX = "/panel/api/runners";

export const RunnerDeviceSchema = z.object({
  serial: z.string().min(1),
  name: z.string(),
  model: z.string().nullable(),
  osVersion: z.string().nullable(),
  platform: z.enum(["ios", "android"]),
  kind: z.enum(["device", "emulator", "simulator"]),
  state: z.string()
});

export const RunnerToolsSchema = z.object({
  adb: z.boolean(),
  idb: z.boolean(),
  simctl: z.boolean(),
  ideviceId: z.boolean(),
  appium: z.boolean(),
  maestro: z.boolean(),
  devicectl: z.boolean()
});

export const RunnerInventorySchema = z.object({
  platforms: z.array(z.enum(["ios", "android"])),
  devices: z.array(RunnerDeviceSchema),
  tools: RunnerToolsSchema
});

export const WebHeartbeatRequestSchema = z.object({
  host: z.object({
    hostname: z.string().min(1),
    username: z.string(),
    osPlatform: z.string().min(1),
    osVersion: z.string().nullable(),
    arch: z.string().nullable(),
    kind: z.string().min(1)
  }),
  name: z.string().min(1),
  version: z.string(),
  artifactBaseUrl: z.string().nullable(),
  instanceId: z.string().min(1),
  inventory: RunnerInventorySchema,
  active: z.array(
    z.object({
      taskId: z.string().min(1),
      serial: z.string().min(1)
    })
  )
});

export const WebHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  runnerId: z.string().min(1),
  queuePaused: z.boolean(),
  cancelTaskIds: z.array(z.string().min(1)),
  leaseLostTaskIds: z.array(z.string().min(1)),
  assigned: z.number().int().nonnegative(),
  reassigned: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  serverTime: z.string().min(1)
});

const RegressionTaskStatusSchema = z.enum([
  "pending",
  "claimed",
  "running",
  "stopping",
  "stopped",
  "cancelled",
  "completed",
  "partial",
  "failed"
]);

export const WebJobTaskSchema = z.object({
  id: z.string().min(1),
  jobSpec: z.record(z.unknown()).nullable(),
  attempts: z.number().int().nonnegative(),
  deviceSerial: z.string().nullable(),
  claimedHostId: z.string().nullable(),
  targetHostId: z.string().nullable(),
  status: RegressionTaskStatusSchema
});

export const WebClaimRequestSchema = z.object({
  instanceId: z.string().min(1),
  deviceSerial: z.string().min(1)
});

export const WebClaimResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claimed"),
    task: WebJobTaskSchema,
    projectSlug: z.string().min(1),
    maxAttempts: z.number().int().positive(),
    leaseToken: z.string().min(1)
  }),
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("paused") }),
  z.object({
    kind: z.literal("busy"),
    reason: z.enum(["device-busy", "lease-lost"])
  }),
  z.object({
    kind: z.literal("exhausted"),
    taskId: z.string().min(1),
    projectSlug: z.string().min(1),
    cancelled: z.boolean()
  })
]);

export const LeaseRenewRequestSchema = z.object({
  instanceId: z.string().min(1),
  taskId: z.string().min(1),
  serials: z.array(z.string().min(1)).min(1),
  leaseToken: z.string().min(1)
});

export const LeaseRenewResponseSchema = z.object({
  renewed: z.number().int().nonnegative(),
  serverTime: z.string().min(1)
});

export const LeaseReleaseRequestSchema = z.object({
  instanceId: z.string().min(1),
  taskId: z.string().min(1),
  serials: z.array(z.string().min(1)).min(1),
  leaseToken: z.string().min(1)
});

export const LeaseReleaseResponseSchema = z.object({
  released: z.number().int().nonnegative()
});

export const TaskBeginResponseSchema = z.discriminatedUnion("started", [
  z.object({ started: z.literal(true), startedAt: z.string().min(1) }),
  z.object({
    started: z.literal(false),
    reason: z.enum(["claim-lost", "cancelled", "not-found"])
  })
]);

export const TaskProgressResponseSchema = z.object({
  cancelRequested: z.boolean(),
  status: RegressionTaskStatusSchema
});

export const RunnerInstanceRequestSchema = z.object({
  instanceId: z.string().min(1)
});

export const TaskTerminalRequestSchema = z.object({
  instanceId: z.string().min(1),
  status: z.enum(["completed", "partial", "failed"]),
  detail: z.string().optional()
});

export const TaskTerminalResponseSchema = z.object({
  outcome: z.enum(["written", "cancelled", "skipped"])
});

export const TaskCancelAckResponseSchema = z.object({
  ok: z.literal(true)
});

export const TaskReleaseRequestSchema = z.object({
  instanceId: z.string().min(1),
  to: z.enum(["pending", "failed"])
});

export const TaskReleaseResponseSchema = z.object({
  ok: z.literal(true)
});

export const RunnerStopRequestSchema = z.object({
  instanceId: z.string().min(1)
});

export const RunnerStopResponseSchema = z.object({
  ok: z.literal(true)
});

export const RunnerControlErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string().min(1),
  error: z.string().min(1)
});

export type WebHeartbeatRequest = z.infer<typeof WebHeartbeatRequestSchema>;
export type WebHeartbeatResponse = z.infer<typeof WebHeartbeatResponseSchema>;
export type WebJobTask = z.infer<typeof WebJobTaskSchema>;
export type WebClaimRequest = z.infer<typeof WebClaimRequestSchema>;
export type RunnerInstanceRequest = z.infer<typeof RunnerInstanceRequestSchema>;
export type WebClaimResponse = z.infer<typeof WebClaimResponseSchema>;
export type LeaseRenewRequest = z.infer<typeof LeaseRenewRequestSchema>;
export type LeaseRenewResponse = z.infer<typeof LeaseRenewResponseSchema>;
export type LeaseReleaseRequest = z.infer<typeof LeaseReleaseRequestSchema>;
export type LeaseReleaseResponse = z.infer<typeof LeaseReleaseResponseSchema>;
export type TaskBeginResponse = z.infer<typeof TaskBeginResponseSchema>;
export type TaskProgressResponse = z.infer<typeof TaskProgressResponseSchema>;
export type TaskTerminalRequest = z.infer<typeof TaskTerminalRequestSchema>;
export type TaskTerminalResponse = z.infer<typeof TaskTerminalResponseSchema>;
export type TaskReleaseRequest = z.infer<typeof TaskReleaseRequestSchema>;
export type TaskReleaseResponse = z.infer<typeof TaskReleaseResponseSchema>;
export type RunnerStopRequest = z.infer<typeof RunnerStopRequestSchema>;
export type RunnerControlErrorResponse = z.infer<typeof RunnerControlErrorResponseSchema>;

export const RUNNER_CONTROL_PATHS = {
  heartbeat: `${RUNNER_CONTROL_PREFIX}/heartbeat`,
  claim: `${RUNNER_CONTROL_PREFIX}/claim`,
  renewLeases: `${RUNNER_CONTROL_PREFIX}/leases/renew`,
  releaseLeases: `${RUNNER_CONTROL_PREFIX}/leases/release`,
  stop: `${RUNNER_CONTROL_PREFIX}/stop`
} as const;

export function runnerTaskPath(
  taskId: string,
  action: "begin" | "progress" | "terminal" | "cancel-ack" | "release"
): string {
  return `${RUNNER_CONTROL_PREFIX}/tasks/${encodeURIComponent(taskId)}/${action}`;
}

export type RunnerControlRoute =
  | { kind: "heartbeat" }
  | { kind: "claim" }
  | { kind: "renewLeases" }
  | { kind: "releaseLeases" }
  | { kind: "stop" }
  | { kind: "begin"; taskId: string }
  | { kind: "progress"; taskId: string }
  | { kind: "terminal"; taskId: string }
  | { kind: "cancelAck"; taskId: string }
  | { kind: "releaseTask"; taskId: string };

const STATIC_ROUTES: Record<string, RunnerControlRoute> = {
  [`${RUNNER_CONTROL_PREFIX}/heartbeat`]: { kind: "heartbeat" },
  [`${RUNNER_CONTROL_PREFIX}/claim`]: { kind: "claim" },
  [`${RUNNER_CONTROL_PREFIX}/leases/renew`]: { kind: "renewLeases" },
  [`${RUNNER_CONTROL_PREFIX}/leases/release`]: { kind: "releaseLeases" },
  [`${RUNNER_CONTROL_PREFIX}/stop`]: { kind: "stop" }
};

const TASK_ROUTE_RE = /^\/panel\/api\/runners\/tasks\/([^/]+)\/(begin|progress|terminal|cancel-ack|release)$/;
const TASK_ID_RE = /^[A-Za-z0-9._:-]+$/;

export function matchRunnerControlPath(pathname: string): RunnerControlRoute | null {
  const staticRoute = STATIC_ROUTES[pathname];
  if (staticRoute !== undefined) return staticRoute;
  const match = TASK_ROUTE_RE.exec(pathname);
  if (match === null) return null;
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!TASK_ID_RE.test(taskId)) return null;
  switch (match[2]) {
    case "begin":
      return { kind: "begin", taskId };
    case "progress":
      return { kind: "progress", taskId };
    case "terminal":
      return { kind: "terminal", taskId };
    case "cancel-ack":
      return { kind: "cancelAck", taskId };
    case "release":
      return { kind: "releaseTask", taskId };
    default:
      return null;
  }
}
