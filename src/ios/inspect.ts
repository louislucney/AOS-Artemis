import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getIosTask, type IosTaskRecord, type IosTaskStep } from "./task-runner.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonText(payload: unknown): CallToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

function shotAbs(record: IosTaskRecord, step: IosTaskStep): string | null {
  if (!step.shot) return null;
  return path.join(record.runDir, step.shot);
}

function stepLine(step: IosTaskStep): string {
  const params = Object.keys(step.params).length > 0 ? ` ${JSON.stringify(step.params)}` : "";
  const thought = step.thought ? ` | ${step.thought}` : "";
  return `[Step ${step.step}] ${step.action}${params}${thought} | ${step.outcome}`;
}

/** Route `mobile_inspect_trace` to the in-process iOS runner for iOS trace ids;
 * returns null to keep the ARTEMIS passthrough otherwise. */
export function maybeIosInspectTrace(args: Record<string, unknown>): CallToolResult | null {
  const traceId = typeof args.trace_id === "string" ? args.trace_id.trim() : "";
  const record = traceId ? getIosTask(traceId) : null;
  if (!record) return null;
  const action = typeof args.action === "string" ? args.action : "";
  const stepNumber = typeof args.step_number === "number" ? args.step_number : null;

  switch (action) {
    case "view_summary":
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: record.traceId,
        status: record.status,
        task_desc: record.taskDesc,
        device_serial: record.udid,
        model: record.model,
        ...(record.vision ? { vision: record.vision } : {}),
        ...(record.visionDegraded ? { vision_degraded: record.visionDegraded } : {}),
        steps: record.steps.map((step) => ({
          step: step.step,
          action: step.action,
          outcome: step.outcome,
          ...(step.thought ? { thought: step.thought } : {})
        })),
        result: record.result,
        ...(record.error ? { error: record.error } : {})
      });

    case "view_step_details": {
      if (stepNumber === null) return jsonText({ ok: false, error: "view_step_details 需要 step_number。" });
      const step = record.steps.find((item) => item.step === stepNumber);
      if (!step) {
        return jsonText({
          ok: false,
          error: `iOS trace ${record.traceId} 没有步骤 ${stepNumber}（共 ${record.steps.length} 步）。`
        });
      }
      const file = shotAbs(record, step);
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: record.traceId,
        step_number: step.step,
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
      const step = record.steps.find((item) => item.step === stepNumber);
      if (!step) {
        return jsonText({
          ok: false,
          error: `iOS trace ${record.traceId} 没有步骤 ${stepNumber}（共 ${record.steps.length} 步）。`
        });
      }
      const next = record.steps.find((item) => item.step === stepNumber + 1) ?? null;
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: record.traceId,
        step_number: stepNumber,
        before_screenshot: shotAbs(record, step),
        after_screenshot: next ? shotAbs(record, next) : null,
        action_overlay_screenshot: null,
        device_serial: record.udid
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
      let matched = record.steps.filter((step) => haystackOf(step).includes(needle));
      if (matched.length === 0) {
        const terms = needle.split(/[\s,，。;；:：、]+/).filter((term) => term.length >= 2);
        matched = record.steps.filter((step) => terms.some((term) => haystackOf(step).includes(term)));
      }
      if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
        matched = matched.filter((step) => step.step >= range[0]! && step.step <= range[1]!);
      }
      return jsonText({
        ok: true,
        platform: "ios",
        trace_id: record.traceId,
        query,
        matches: matched.length,
        results: matched.slice(0, maxResults).map(stepLine).join("\n")
      });
    }

    default:
      return jsonText({
        ok: false,
        trace_id: record.traceId,
        error: `iOS trace 不支持 action=${action}（支持 view_summary/view_step_details/view_step_screenshots/search）。`
      });
  }
}
