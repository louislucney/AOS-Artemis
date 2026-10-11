import fs from "node:fs";
import path from "node:path";

import type { IosDevice } from "../device/ios-actions.js";
import { logWarn } from "../log.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { IosScriptAdherence, IosScriptPreflight } from "./script-plan.js";
import type { IosTaskRecord, IosVerification } from "./types.js";

function writeJson(file: string, payload: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function processStartedAtIso(record: IosTaskRecord): string {
  return new Date(record.ownerStartedAtMs).toISOString();
}

export function persistRun(record: IosTaskRecord): void {
  try {
    writeJson(path.join(record.runDir, "run.json"), {
      schema_version: 1,
      trace_id: record.traceId,
      platform: "ios",
      device_serial: record.udid,
      task_desc: record.taskDesc,
      model: record.model,
      status: record.status,
      pid: record.ownerPid,
      process_started_at: processStartedAtIso(record),
      started_at: new Date(record.startedAtMs).toISOString(),
      finished_at: record.finishedAtMs ? new Date(record.finishedAtMs).toISOString() : null,
      steps: record.steps,
      result: record.result,
      error: record.error,
      vision: record.vision,
      vision_degraded: record.visionDegraded,
      ...(record.digest ? { digest: record.digest } : {}),
      ...(record.verification ? { verification: verificationPayload(record.verification) } : {}),
      ...(record.failureLogs ? { failure_logs: record.failureLogs } : {}),
      ...(record.visionDropped ? { vision_dropped: record.visionDropped } : {}),
      ...(record.scriptAdherence ? { script_adherence: record.scriptAdherence } : {}),
      ...(record.preflight ? { preflight: record.preflight } : {})
    });
  } catch (error) {
    logWarn(`iOS 任务 run.json 写入失败（${record.traceId}）: ${errorMessage(error)}`);
  }
}

function verificationPayload(verification: IosVerification): Record<string, unknown> {
  return {
    status: verification.status,
    model: verification.model,
    reason: verification.reason,
    stale: verification.stale,
    failed_items: verification.failedItems
  };
}

function synthesisSummary(record: IosTaskRecord): Record<string, unknown> | null {
  if (record.status !== "failed" || !record.result) return null;
  return {
    task_status: "failed",
    passed: 0,
    failed: 1,
    inconclusive: 0,
    unchecked: 0,
    synthesized: true,
    failed_items: [{ item_text: record.result.summary, evidence: record.result.summary }]
  };
}

function adherencePayload(adherence: IosScriptAdherence | null): Record<string, unknown> {
  if (!adherence) return {};
  if (adherence.checkable + adherence.unchecked === 0 && adherence.deferred.total === 0) return {};
  return {
    adherence: {
      checkable: adherence.checkable,
      satisfied: adherence.satisfied,
      unchecked: adherence.unchecked,
      ...(adherence.deferred.total > 0
        ? { deferred: { total: adherence.deferred.total, reached: adherence.deferred.reached } }
        : {}),
      ...(adherence.unresolved.length > 0
        ? {
            unresolved: adherence.unresolved.map(
              (item) =>
                `步骤${item.index}${item.screen ? ` ${item.screen}` : ""}：${item.hints.join("、")}`
            )
          }
        : {})
    }
  };
}

function preflightPayload(preflight: IosScriptPreflight | null): Record<string, unknown> {
  if (!preflight) return {};
  return {
    preflight: {
      screen: preflight.screen,
      status: preflight.status,
      ...(preflight.matchedAtStep !== null ? { matched_at_step: preflight.matchedAtStep } : {})
    }
  };
}

export function testSummaryFor(record: IosTaskRecord): Record<string, unknown> | null {
  const verification = record.verification;
  const adherence = adherencePayload(record.scriptAdherence);
  const preflight = preflightPayload(record.preflight);
  if (record.status === "failed") {
    if (verification && verification.status === "failed" && verification.failedItems.length > 0) {
      return {
        task_status: "failed",
        passed: 0,
        failed: Math.max(1, verification.failedItems.length),
        inconclusive: 0,
        unchecked: 0,
        synthesized: false,
        verification: "model-final",
        ...(verification.model ? { verification_model: verification.model } : {}),
        ...adherence,
        ...preflight,
        failed_items: verification.failedItems
      };
    }
    const synthesized = synthesisSummary(record);
    if (!synthesized) return null;
    return verification
      ? {
          ...synthesized,
          verification: verification.status,
          ...(verification.model ? { verification_model: verification.model } : {}),
          ...adherence,
          ...preflight
        }
      : { ...synthesized, ...adherence, ...preflight };
  }
  if (record.status === "completed" && verification) {
    if (verification.status === "passed") {
      return {
        task_status: "completed",
        passed: 1,
        failed: 0,
        inconclusive: 0,
        unchecked: 0,
        synthesized: false,
        verification: "model-final",
        ...(verification.model ? { verification_model: verification.model } : {}),
        ...adherence,
        ...preflight
      };
    }
    if (verification.status === "unavailable") {
      return {
        task_status: "completed",
        passed: 1,
        failed: 0,
        inconclusive: 0,
        unchecked: 0,
        synthesized: true,
        verification: "unavailable",
        ...(verification.reason ? { note: verification.reason } : {}),
        ...adherence,
        ...preflight
      };
    }
  }
  return null;
}

export function writeStatus(record: IosTaskRecord, message: string): void {
  const testSummary = testSummaryFor(record);
  try {
    writeJson(path.join(record.runDir, "status.json"), {
      trace_id: record.traceId,
      status: record.status,
      platform: "ios",
      device_serial: record.udid,
      task_desc: record.taskDesc,
      model: record.model,
      pid: record.ownerPid,
      process_started_at: processStartedAtIso(record),
      message,
      ...(record.error ? { error: record.error } : {}),
      ...(testSummary ? { test_summary: testSummary } : {}),
      start_time: record.startedAtMs / 1000,
      end_time: record.finishedAtMs ? record.finishedAtMs / 1000 : null
    });
  } catch (error) {
    logWarn(`iOS 任务 status.json 写入失败（${record.traceId}）: ${errorMessage(error)}`);
  }
}

export function finish(
  record: IosTaskRecord,
  status: IosTaskRecord["status"],
  summary: string
): void {
  record.status = status;
  record.finishedAtMs = Date.now();
  if (status === "completed") record.result = { success: true, summary };
  if (status === "failed") record.result = { success: false, summary };
  if (status === "cancelled") record.result = { success: false, summary };
  if (status === "failed") record.error = record.error ?? summary;
  persistRun(record);
  writeStatus(record, summary);
}

export async function captureStepShot(
  device: IosDevice,
  record: IosTaskRecord,
  step: number,
  kind: "pre" | "post"
): Promise<{ rel: string; bytes: Buffer } | null> {
  try {
    const png = await device.screenshot();
    const shotsDir = path.join(record.runDir, "shots");
    fs.mkdirSync(shotsDir, { recursive: true });
    const name = kind === "post" ? `step-${step}-post.png` : `step-${step}.png`;
    const file = path.join(shotsDir, name);
    fs.writeFileSync(file, png);
    return { rel: path.relative(record.runDir, file), bytes: png };
  } catch {
    return null;
  }
}
