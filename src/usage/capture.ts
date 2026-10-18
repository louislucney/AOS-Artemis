import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { traceIdOf } from "../artemis/task-result.js";
import type {
  RecordUsageEventInput,
  UsageErrorClass,
  UsageEventFamily,
  UsagePrunePolicy,
  UsageSignal
} from "../db/types.js";

export const USAGE_RETENTION_DAYS_DEFAULT = 90;
export const USAGE_MAX_EVENTS_DEFAULT = 50_000;
export const USAGE_DISABLED_NOTE =
  "使用统计采集已关闭（AOS_USAGE=0）；以下为已记录的历史数据。";

const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "design_to_test",
  "run_regression",
  "verify_jira_issue",
  "project_archive"
]);

const NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "analyze_structure",
  "aos_configure",
  "aos_crashes",
  "aos_status",
  "aos_tasks",
  "aos_usage",
  "compare_design_and_device",
  "design_device_diff",
  "design_to_test",
  "run_regression",
  "verify_jira_issue",
  "project_archive",
  "export_image",
  "extract_design_system",
  "find_assets",
  "get_all_pages",
  "get_component_definitions",
  "get_component_variants",
  "get_current_page",
  "get_current_selection",
  "get_file_from_url",
  "get_frame_by_name",
  "get_node_from_url",
  "get_node_info",
  "get_nodes_info",
  "get_selected_colors",
  "get_selected_interactions",
  "get_selected_spacing",
  "get_selected_texts",
  "get_variables",
  "llm_list",
  "llm_models",
  "llm_switch",
  "scan_nodes_by_types",
  "screen_map"
]);

const TIMEOUT_MARKERS = ["timeout", "timed out", "etimedout", "deadline", "超时"];
const FIGMA_MARKERS = ["figma", "限流", "rate limit", "rate-limit", "retry-after"];
const TEXT_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["vision_degraded", "vision_degraded"],
  ["ios-log-unsupported", "ios-log-unsupported"],
  ["ios-unsupported", "ios-unsupported"],
  ["param_ignored", "param_ignored"],
  ["skipped_unmanaged", "skipped_unmanaged"],
  ["skipped_occupied", "skipped_occupied"],
  ["无损 PNG 不可用", "lossless_fallback"],
  ["已回退 live JPEG", "lossless_fallback"],
  ["simctl 兜底", "simctl_fallback"]
];

function rawEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function usageEnabledFrom(env: NodeJS.ProcessEnv): boolean {
  return rawEnv(env, "AOS_USAGE") !== "0";
}

export function usagePolicyFrom(env: NodeJS.ProcessEnv): UsagePrunePolicy {
  return {
    retentionDays: parseNonNegativeInt(
      rawEnv(env, "AOS_USAGE_RETENTION_DAYS"),
      USAGE_RETENTION_DAYS_DEFAULT
    ),
    maxEvents: parseNonNegativeInt(rawEnv(env, "AOS_USAGE_MAX_EVENTS"), USAGE_MAX_EVENTS_DEFAULT)
  };
}

export function usageEventSampleLimit(env: NodeJS.ProcessEnv): number {
  const maxEvents = usagePolicyFrom(env).maxEvents ?? 0;
  return maxEvents > 0 ? maxEvents : USAGE_MAX_EVENTS_DEFAULT;
}

export function usageFamilyOf(tool: string): UsageEventFamily {
  if (tool.startsWith("mobile_")) return "mobile";
  if (tool.startsWith("figma_")) return "figma";
  if (tool.startsWith("pen_")) return "pen";
  if (tool.startsWith("jira_")) return "jira";
  if (WORKFLOW_TOOL_NAMES.has(tool)) return "workflow";
  if (NATIVE_TOOL_NAMES.has(tool)) return "native";
  return "unknown";
}

function firstTextContent(result: CallToolResult): string {
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") {
      return item.text;
    }
  }
  return "";
}

function allTextContent(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function errorClassOf(family: UsageEventFamily, result: CallToolResult): UsageErrorClass {
  const text = allTextContent(result);
  if (text.trimStart().startsWith("参数校验失败")) return "validation";
  const lower = text.toLowerCase();
  if (TIMEOUT_MARKERS.some((marker) => lower.includes(marker))) return "timeout";
  if (family === "figma" || FIGMA_MARKERS.some((marker) => lower.includes(marker))) return "figma";
  if (text.includes("执行失败")) return family === "mobile" ? "artemis" : "internal";
  if (family === "mobile") return "artemis";
  return "unknown";
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function errorSummaryOf(result: CallToolResult): string | null {
  const raw = firstTextContent(result).trim();
  if (raw === "") return null;
  if (raw.startsWith("{")) {
    const parsed = tryJson(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["error", "message"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim() !== "") return collapse(value);
      }
    }
  }
  const line = raw.split("\n", 1)[0] ?? "";
  return collapse(line) || null;
}

function collectWarningSignals(
  value: unknown,
  out: UsageSignal[],
  depth: number,
  budget: { left: number }
): void {
  if (depth > 2 || budget.left <= 0 || value === null || typeof value !== "object") return;
  budget.left -= 1;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWarningSignals(item, out, depth + 1, budget);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.warnings)) {
    for (const entry of record.warnings) {
      if (typeof entry === "string") {
        if (entry.trim() !== "") out.push({ code: entry.trim() });
        continue;
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const code = (entry as Record<string, unknown>).code;
      if (typeof code !== "string" || code.trim() === "") continue;
      const field = (entry as Record<string, unknown>).field;
      out.push(
        typeof field === "string" && field.trim() !== ""
          ? { code: code.trim(), field: field.trim() }
          : { code: code.trim() }
      );
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (key === "warnings") continue;
    collectWarningSignals(item, out, depth + 1, budget);
  }
}

function dedupeSignals(signals: UsageSignal[]): UsageSignal[] {
  const seen = new Set<string>();
  const out: UsageSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.code}\u0000${signal.field ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}

/** 结构化结果信号（D12）：预期缺失的目标、失败步骤、执行门禁——只取根字段，
 * 不读取参数值。 */
function outcomeSignalsOf(value: unknown): UsageSignal[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const signals: UsageSignal[] = [];
  const needs = record.needs;
  if (needs === "info") {
    signals.push({ code: "needs:info" });
    const category = record.category;
    if (typeof category === "string" && category.trim() !== "") {
      signals.push({ code: "needs:info.category", field: category.trim() });
    }
  } else if (needs === "setup") {
    const checks = Array.isArray(record.checks) ? record.checks : [];
    const targets = new Set<string>();
    for (const entry of checks) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const target = (entry as Record<string, unknown>).target;
      if (typeof target === "string" && target.trim() !== "") targets.add(target.trim());
    }
    if (targets.size === 0) signals.push({ code: "needs:setup" });
    for (const target of targets) signals.push({ code: `needs:${target}` });
    for (const entry of checks) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const check = entry as { target?: unknown; missing?: unknown };
      if (typeof check.target !== "string" || check.target.trim() === "") continue;
      if (!Array.isArray(check.missing)) continue;
      for (const item of check.missing) {
        if (typeof item === "string" && item.trim() !== "") {
          signals.push({ code: `needs:${check.target.trim()}.missing`, field: item.trim() });
        }
      }
    }
  }
  const failedStep = record.failedStep;
  if (typeof failedStep === "string" && failedStep.trim() !== "") {
    signals.push({ code: `failed-step:${failedStep.trim()}` });
  }
  const imported = record.import;
  if (imported !== null && typeof imported === "object" && !Array.isArray(imported)) {
    const outcome = (imported as Record<string, unknown>).outcome;
    if (outcome === "imported" || outcome === "skipped" || outcome === "invalid") {
      signals.push({ code: "import.outcome", field: outcome });
    }
  }
  const scope = record.scope;
  if (scope !== null && typeof scope === "object" && !Array.isArray(scope)) {
    const hits = (scope as Record<string, unknown>).hits;
    if (typeof hits === "number" && Number.isFinite(hits)) {
      signals.push({ code: "scope.match", field: String(hits) });
    }
  }
  const run = record.run;
  if (run !== null && typeof run === "object" && !Array.isArray(run)) {
    const gate = (run as Record<string, unknown>).gate;
    if (typeof gate === "string" && gate.trim() !== "") {
      signals.push({ code: "run.gate", field: gate.trim() });
    }
  }
  const ticket = record.ticket;
  if (ticket !== null && typeof ticket === "object" && !Array.isArray(ticket)) {
    const tier = (ticket as Record<string, unknown>).detailTier;
    if (tier === "detailed" || tier === "coarse") {
      signals.push({ code: "ticket.detailTier", field: tier });
    }
  }
  const stepList = record.steps;
  if (Array.isArray(stepList)) {
    for (const entry of stepList) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const step = (entry as Record<string, unknown>).step;
      const ms = (entry as Record<string, unknown>).ms;
      if (
        typeof step === "string" &&
        step.trim() !== "" &&
        typeof ms === "number" &&
        Number.isFinite(ms) &&
        ms >= 0
      ) {
        signals.push({ code: `step-ms:${step.trim()}`, field: String(ms) });
      }
    }
  }
  const mapping = record.mapping;
  if (mapping !== null && typeof mapping === "object" && !Array.isArray(mapping)) {
    const selected = (mapping as Record<string, unknown>).selected;
    if (typeof selected === "number" && Number.isFinite(selected)) {
      signals.push(
        selected > 0 ? { code: "mapping.selected", field: String(selected) } : { code: "mapping.none" }
      );
    }
  }
  const writeback = record.writeback;
  if (writeback !== null && typeof writeback === "object" && !Array.isArray(writeback)) {
    const outcome = (writeback as Record<string, unknown>).outcome;
    if (outcome === "sent" || outcome === "dryRun") {
      signals.push({ code: "writeback", field: outcome });
    }
  }
  return signals;
}

function signalsOf(result: CallToolResult): UsageSignal[] {
  const found: UsageSignal[] = [];
  const texts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    texts.push(item.text);
    const parsed = tryJson(item.text);
    if (parsed !== null) {
      collectWarningSignals(parsed, found, 0, { left: 200 });
      found.push(...outcomeSignalsOf(parsed));
    }
  }
  const signals = dedupeSignals(found);
  const codes = new Set(signals.map((signal) => signal.code));
  const joined = texts.join("\n");
  for (const [marker, code] of TEXT_MARKERS) {
    if (!joined.includes(marker) || codes.has(code)) continue;
    codes.add(code);
    signals.push({ code });
  }
  return signals;
}

function argKeysOf(args: Record<string, unknown> | undefined): string[] {
  if (args === null || typeof args !== "object") return [];
  return [...new Set(Object.keys(args))].sort();
}

export function usageEventInputFrom(
  tool: string,
  args: Record<string, unknown> | undefined,
  result: CallToolResult,
  durationMs: number
): RecordUsageEventInput {
  const ok = result.isError !== true;
  const family = usageFamilyOf(tool);
  return {
    tool,
    family,
    ok,
    durationMs,
    errorClass: ok ? null : errorClassOf(family, result),
    errorSummary: ok ? null : errorSummaryOf(result),
    signals: signalsOf(result),
    argKeys: argKeysOf(args),
    traceId: traceIdOf(result)
  };
}
