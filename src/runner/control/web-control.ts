import type { DeviceGatewayRecord } from "../../db/types.js";
import type { RunnerInventory } from "../inventory.js";
import type {
  LeaseReleaseResponse,
  LeaseRenewResponse,
  TaskBeginResponse,
  TaskProgressResponse,
  TaskTerminalResponse,
  WebClaimResponse,
  WebHeartbeatResponse
} from "./contract.js";

export interface WebRunnerHostDescriptor {
  hostname: string;
  username: string;
  osPlatform: string;
  osVersion: string | null;
  arch: string | null;
  kind: string;
}

export interface WebRunnerHeartbeatInput {
  host: WebRunnerHostDescriptor;
  name: string;
  version: string;
  artifactBaseUrl: string | null;
  gateway?: DeviceGatewayRecord | null;
  inventory: RunnerInventory;
  active: Array<{ taskId: string; serial: string }>;
}

export type WebRunnerTerminalStatus = "completed" | "partial" | "failed";
export type WebRunnerTerminalOutcome = TaskTerminalResponse["outcome"];

/** web-runner 与中心之间的窄控制面；直连 PG 与 HTTP 两种实现共用同一组语义。 */
export interface WebRunnerControl {
  readonly hostId: string;
  readonly instanceId: string;

  heartbeat(input: WebRunnerHeartbeatInput): Promise<WebHeartbeatResponse>;
  claim(deviceSerial: string): Promise<WebClaimResponse>;
  begin(taskId: string): Promise<TaskBeginResponse>;
  progress(taskId: string): Promise<TaskProgressResponse>;
  terminal(
    taskId: string,
    status: WebRunnerTerminalStatus,
    detail?: string
  ): Promise<WebRunnerTerminalOutcome>;
  cancelAck(taskId: string): Promise<void>;
  release(taskId: string, to: "pending" | "failed"): Promise<void>;

  renewLease(taskId: string, serial: string, leaseToken: string): Promise<LeaseRenewResponse>;
  releaseLease(taskId: string, serial: string, leaseToken: string): Promise<LeaseReleaseResponse>;

  stop(): Promise<void>;
}
