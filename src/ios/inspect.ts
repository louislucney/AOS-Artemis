import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { renderActionOverlay } from "./overlay.js";
import { getIosTask } from "./task-registry.js";
import type { IosTaskRecord, IosTaskStep } from "./types.js";
import { reconcileIosTrace, type IosTraceDeps } from "./trace-store.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonText(payload: unknown): CallToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

interface InspectTraceLike {
  traceId: string;
  status: string;
  taskDesc: string | null;
  udid: string | null;
  model: string | null;
  steps: IosTaskStep[];
  result: { success: boolean; summary: string } | null;
  error: string | null;
  vision: IosTaskRecord["vision"];
  visionDegraded: string | null;
  verification?: IosTaskRecord["verification"];
  failureLogs?: IosTaskRecord["failureLogs"];
  runDir: string;
}

function shotAbs(record: InspectTraceLike, step: IosTaskStep): string | null {
  if (!step.shot) return null;
  return path.join(record.runDir, step.shot);
}

function postShotAbs(record: InspectTraceLike, step: IosTaskStep): string | null {
  if (!step.postShot) return null;
  return path.join(record.runDir, step.postShot);
}

function overlayFor(
  record: InspectTraceLike,
  step: IosTaskStep
): { path: string | null; error: string | null } {
  const base = step.shot
    ? path.join(record.runDir, step.shot)
    : step.postShot
      ? path.join(record.runDir, step.postShot)
      : null;
  if (!base) return { path: null, error: "no-screenshot" };
  const out = path.join(record.runDir, "shots", `step-${step.step}-overlay.png`);
  try {
    if (fs.existsSync(out)) return { path: out, error: null };
    const rendered = renderActionOverlay(
      fs.readFileSync(base),
      step.action,
      step.params,
      step.scale ?? null
    );
    if (!rendered) return { path: null, error: "unsupported-action-or-scale" };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rendered);
    return { path: out, error: null };
  } catch (error) {
    return { path: null, error: errorMessage(error) };
  }
}

function stepLine(step: IosTaskStep): string {
  const params = Object.keys(step.params).length > 0 ? ` ${JSON.stringify(step.params)}` : "";
  const thought = step.thought ? ` | ${step.thought}` : "";
  return `[Step ${step.step}] ${step.action}${params}${thought} | ${step.outcome}`;
}

function searchFailureLogs(
  trace: InspectTraceLike,
  needle: string,
  terms: string[]
): string | null {
  const rel = trace.failureLogs?.rel;
  if (!rel) return null;
  try {
    const text = fs.readFileSync(path.join(trace.runDir, rel), "utf-8");
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at === -1) {
      for (const term of terms) {
        const index = lower.indexOf(term);
        if (index !== -1) {
          at = index;
          break;
        }
      }
    }
    if (at === -1) return null;
    const start = Math.max(0, at - 120);
    const end = Math.min(text.length, at + 200);
    return text.slice(start, end).replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

function renderInspectTrace(trace: InspectTraceLike, args: Record<string, unknown>): CallToolResult {
  const action = typeof args.action === "string" ? args.action : "";
  const stepNumber = typeof args.step_number === "number" ? args.step_number : null;

  switch (action) {
    case "view_summary":
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: trace.traceId,
        status: trace.status,
        task_desc: trace.taskDesc,
        device_serial: trace.udid,
        model: trace.model,
        ...(trace.vision ? { vision: trace.vision } : {}),
        ...(trace.visionDegraded ? { vision_degraded: trace.visionDegraded } : {}),
        ...(trace.verification
          ? {
              verification: {
                status: trace.verification.status,
                ...(trace.verification.model ? { model: trace.verification.model } : {}),
                ...(trace.verification.reason ? { reason: trace.verification.reason } : {}),
                ...(trace.verification.failedItems.length > 0
                  ? { failed_items: trace.verification.failedItems }
                  : {})
              }
            }
          : {}),
        ...(trace.failureLogs ? { failure_logs: trace.failureLogs } : {}),
        steps: trace.steps.map((step) => ({
          step: step.step,
          action: step.action,
          outcome: step.outcome,
          ...(step.thought ? { thought: step.thought } : {})
        })),
        result: trace.result,
        ...(trace.error ? { error: trace.error } : {})
      });

    case "view_step_details": {
      if (stepNumber === null) return jsonText({ ok: false, error: "view_step_details 需要 step_number。" });
      const step = trace.steps.find((item) => item.step === stepNumber);
      if (!step) {
        return jsonText({
          ok: false,
          error: `iOS trace ${trace.traceId} 没有步骤 ${stepNumber}（共 ${trace.steps.length} 步）。`
        });
      }
      const file = shotAbs(trace, step);
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: trace.traceId,
        step_number: step.step,
        device_serial: trace.udid,
        thought: step.thought,
        action: step.action,
        params: step.params,
        outcome: step.outcome,
        ...(step.perception ? { perception: step.perception } : {}),
        ...(file ? { screenshot: file } : {})
      });
    }

    case "view_step_screenshots": {
      if (stepNumber === null) {
        return jsonText({ ok: false, error: "view_step_screenshots 需要 step_number。" });
      }
      const step = trace.steps.find((item) => item.step === stepNumber);
      if (!step) {
        return jsonText({
          ok: false,
          error: `iOS trace ${trace.traceId} 没有步骤 ${stepNumber}（共 ${trace.steps.length} 步）。`
        });
      }
      const overlay = overlayFor(trace, step);
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: trace.traceId,
        step_number: stepNumber,
        before_screenshot: shotAbs(trace, step),
        after_screenshot: postShotAbs(trace, step),
        action_overlay_screenshot: overlay.path,
        ...(overlay.error ? { action_overlay_error: overlay.error } : {}),
        device_serial: trace.udid
      });
    }

    case "search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return jsonText({ ok: false, error: "search 需要 query。" });
      const range =
        Array.isArray(args.step_range) && args.step_range.length === 2
          ? [Number(args.step_range[0]), Number(args.step_range[1])]
          : null;
      const maxResults =
        typeof args.max_results === "number" && args.max_results > 0
          ? Math.min(Math.floor(args.max_results), 50)
          : 5;
      const needle = query.toLowerCase();
      const haystackOf = (step: IosTaskStep): string => JSON.stringify(step).toLowerCase();
      const terms = needle.split(/[\s,，。;；:：、]+/).filter((term) => term.length >= 2);
      let matched = trace.steps.filter((step) => haystackOf(step).includes(needle));
      if (matched.length === 0) {
        matched = trace.steps.filter((step) => terms.some((term) => haystackOf(step).includes(term)));
      }
      if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
        matched = matched.filter((step) => step.step >= range[0]! && step.step <= range[1]!);
      }
      const lines = matched.map(stepLine);
      const logHit = searchFailureLogs(trace, needle, terms);
      if (logHit) lines.push(`[device.log] ${logHit}`);
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: trace.traceId,
        query,
        matches: lines.length,
        results: lines.slice(0, maxResults).join("\n")
      });
    }

    default:
      return jsonText({
        ok: false,
        trace_id: trace.traceId,
        error: `iOS trace 不支持 action=${action}（支持 view_summary/view_step_details/view_step_screenshots/search）。`
      });
  }
}

/** Route `mobile_inspect_trace` to the iOS runner: the in-process record
 * first, then the trace directory on disk (cross-process). Returns null to
 * keep the ARTEMIS passthrough otherwise. */
export function maybeIosInspectTrace(
  runtime: Runtime,
  args: Record<string, unknown>,
  deps: IosTraceDeps = {}
): CallToolResult | null {
  const traceId = typeof args.trace_id === "string" ? args.trace_id.trim() : "";
  const record = traceId ? getIosTask(traceId) : null;
  if (record) return renderInspectTrace(record, args);
  if (!traceId) return null;
  const trace = reconcileIosTrace(runtime.traceDir(traceId), traceId, deps);
  if (!trace) return null;
  return renderInspectTrace(trace, args);
}
