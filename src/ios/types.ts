import type { ChatFn } from "../llm/chat.js";
import type { IosScriptAdherence, IosScriptPreflight } from "./script-plan.js";
import type { VisionTarget } from "./vision.js";

export interface IosTaskStep {
  step: number;
  thought: string;
  action: string;
  params: Record<string, unknown>;
  outcome: string;
  shot?: string;
  postShot?: string;
  screen?: string;
  scale?: number;
  perception?: "text" | "image" | "vision-text" | "text-degraded";
  noop?: boolean;
  /** 本条步骤观测时新命中的脚本断言序号（【AOS-EXPECT】，确定性核对）。 */
  scriptHits?: number[];
}

export interface IosVerificationItem {
  item_text: string;
  evidence: string;
  region?: unknown;
}

export interface IosVerification {
  status: "passed" | "failed" | "unavailable";
  model: string | null;
  reason: string;
  failedItems: IosVerificationItem[];
  stale: boolean;
}

export interface IosFailureLogs {
  status: "ok" | "skipped";
  source: "simctl-log" | "idevicesyslog" | "none";
  reason?: string;
  rel?: string;
  lines?: number;
}

export interface IosVisionDropped {
  invalid: number;
  noScale: number;
  duplicate: number;
  overflow: number;
}

export interface IosTaskRecord {
  traceId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  taskDesc: string;
  udid: string;
  model: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  steps: IosTaskStep[];
  result: { success: boolean; summary: string } | null;
  error: string | null;
  runDir: string;
  ownerPid: number;
  ownerStartedAtMs: number;
  stopRequested: boolean;
  instruction: string | null;
  lockedAppPackage: string | null;
  vision: { model: string; source: VisionTarget["source"] } | null;
  visionDegraded: string | null;
  noopStreak: number;
  digest: string | null;
  verification: IosVerification | null;
  failureLogs: IosFailureLogs | null;
  visionDropped: IosVisionDropped | null;
  scriptAdherence: IosScriptAdherence | null;
  preflight: IosScriptPreflight | null;
}

export interface VerifierTarget {
  chat: ChatFn;
  model: string;
  vision: boolean;
}
