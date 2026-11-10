import type { IosPoint } from "../device/ios-actions.js";
import type { StructuredDevice } from "../structured/device.js";
import type { IosUiNode } from "../device/ios.js";
import type {
  StructuredAction,
  StructuredActionExpect,
  StructuredTarget
} from "../figma/structured-actions.js";
import { normalizeMatchText } from "./script-plan.js";

export type StructuredIosStepStatus = "passed" | "failed" | "error";

export interface StructuredIosStepResult {
  index: number;
  action: StructuredAction["action"];
  status: StructuredIosStepStatus;
  target?: StructuredTarget;
  resolvedBy?: "id" | "label" | "value" | "point" | "ancestor";
  expected?: StructuredActionExpect;
  actual?: { texts: string[]; screen: { width: number; height: number } | null };
  error?: string;
}

export interface StructuredIosRunResult {
  status: "passed" | "failed" | "error";
  steps: StructuredIosStepResult[];
  error?: string;
}

export interface StructuredIosRunInput {
  device: StructuredDevice;
  actions: StructuredAction[];
  /** Per-step observation timeout; default 8000ms. */
  stepTimeoutMs?: number;
  /** Poll interval while waiting for UI stability; default 150ms. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 执行期 secret 解析；返回 null/undefined 时该步显式失败，不回退明文。 */
  resolveSecret?: (ref: string) => string | null | undefined;
}

function pointOfTarget(target: StructuredTarget): IosPoint | null {
  if (target.kind !== "point") return null;
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(target.value.trim());
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function targetMatches(node: IosUiNode, target: StructuredTarget): boolean {
  if (target.kind === "resource-id" || target.kind === "view-tag") {
    return node.id === target.value;
  }
  if (
    target.kind === "content-desc" ||
    target.kind === "semantics-label" ||
    target.kind === "text"
  ) {
    const wanted = normalizeMatchText(target.value);
    return (
      normalizeMatchText(node.label) === wanted || normalizeMatchText(node.value) === wanted
    );
  }
  return false;
}

function visibleNodes(
  nodes: IosUiNode[],
  screen: { width: number; height: number } | null
): IosUiNode[] {
  return nodes.filter((node) => {
    if (!Number.isFinite(node.rect.width) || !Number.isFinite(node.rect.height)) return false;
    if (node.rect.width <= 0 || node.rect.height <= 0) return false;
    if (screen === null) return true;
    return (
      node.rect.x < screen.width &&
      node.rect.y < screen.height &&
      node.rect.x + node.rect.width > 0 &&
      node.rect.y + node.rect.height > 0
    );
  });
}

function resolveTarget(
  nodes: IosUiNode[],
  action: StructuredAction,
  options: { preferEditable?: boolean } = {}
): { point: IosPoint; node?: IosUiNode; target: StructuredTarget; resolvedBy: StructuredIosStepResult["resolvedBy"] } | { error: string } {
  const targets = [action.target, ...(action.fallbackTargets ?? [])].filter(
    (target): target is StructuredTarget => target !== undefined
  );
  for (const target of targets) {
    const point = pointOfTarget(target);
    if (point !== null) {
      return { point, target, resolvedBy: "point" };
    }
    let matches = nodes.filter((node) => targetMatches(node, target));
    if (options.preferEditable === true && matches.length > 1) {
      const editable = matches.filter((node) => /textfield|edittext|securetextfield/i.test(node.type));
      if (editable.length > 0) matches = editable;
    }
    if (matches.length > 1) return { error: `target-ambiguous:${target.kind}:${target.value}` };
    if (matches.length === 1) {
      const node = matches[0]!;
      return {
        point: {
          x: node.rect.x + node.rect.width / 2,
          y: node.rect.y + node.rect.height / 2
        },
        node,
        target,
        resolvedBy:
          target.kind === "resource-id" || target.kind === "view-tag"
            ? "id"
            : target.kind === "text"
              ? "value"
              : "label"
      };
    }
  }
  return { error: "target-not-found" };
}

function textsOf(nodes: IosUiNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    for (const value of [node.label, node.value]) {
      const text = value.trim();
      if (text !== "") out.push(text);
    }
  }
  return [...new Set(out)];
}

const INVISIBLE_BETWEEN = "[\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u206f\\ufeff]*";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactValue(value: string, secrets: Set<string>): string {
  let out = value;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("***");
    if (secret.length < 4) continue;
    const spaced = new RegExp(
      secret.split("").map(escapeRegExp).join(INVISIBLE_BETWEEN),
      "g"
    );
    out = out.replace(spaced, "***");
  }
  return out;
}

function expectError(
  expect: StructuredActionExpect | undefined,
  nodes: IosUiNode[]
): string | null {
  if (expect === undefined) return null;
  const texts = textsOf(nodes);
  const normalized = texts.map(normalizeMatchText);
  const all = normalized.join(" | ");
  if (expect.screen !== undefined) {
    const wanted = normalizeMatchText(expect.screen);
    if (!normalized.includes(wanted)) return `screen-mismatch:${expect.screen}`;
  }
  for (const hint of expect.hints ?? []) {
    const wanted = normalizeMatchText(hint);
    if (!all.includes(wanted)) return `hint-missing:${hint}`;
  }
  for (const absent of expect.absent ?? []) {
    const wanted = normalizeMatchText(absent);
    if (all.includes(wanted)) return `unexpected-text:${absent}`;
  }
  return null;
}

async function observeStable(
  device: StructuredDevice,
  screen: { width: number; height: number } | null,
  timeoutMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<IosUiNode[]> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let latest: IosUiNode[] = [];
  for (;;) {
    const nodes = visibleNodes(await device.nodes(), screen);
    const signature = nodes
      .map((node) => `${node.id}\u0000${node.label}\u0000${node.value}\u0000${node.rect.x},${node.rect.y},${node.rect.width},${node.rect.height}`)
      .join("\n");
    latest = nodes;
    if (signature === last) return nodes;
    last = signature;
    if (Date.now() >= deadline) return latest;
    await sleep(pollMs);
  }
}

/** Minimal deterministic iOS runner for Phase 1 `actions[]`.
 * No LLM: target resolution + action + stable AX observation + expect checks.
 * Supports tap/type/wait; back/swipe are explicitly unsupported on iOS. */
export async function runStructuredIosCase(
  input: StructuredIosRunInput
): Promise<StructuredIosRunResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stepTimeoutMs = input.stepTimeoutMs ?? 8000;
  const pollMs = input.pollMs ?? 150;
  const results: StructuredIosStepResult[] = [];
  const secretValues = new Set<string>();
  let screen: { width: number; height: number } | null = null;
  try {
    screen = await input.device.size();
  } catch {
    screen = null;
  }

  for (const action of [...input.actions].sort((left, right) => left.stepIndex - right.stepIndex)) {
    const base: StructuredIosStepResult = {
      index: action.stepIndex,
      action: action.action,
      status: "error",
      ...(action.target === undefined ? {} : { target: action.target }),
      ...(action.expect === undefined ? {} : { expected: action.expect })
    };
    if (action.action === "back" || action.action === "swipe") {
      results.push({ ...base, error: "unsupported-action" });
      return { status: "error", steps: results, error: `step ${action.stepIndex}: unsupported-action` };
    }

    try {
      if (action.action === "tap" || action.action === "type") {
        const resolved = resolveTarget(
          visibleNodes(await input.device.nodes(), screen),
          action,
          { preferEditable: action.action === "type" }
        );
        if ("error" in resolved) {
          results.push({ ...base, error: resolved.error });
          return { status: "failed", steps: results, error: `step ${action.stepIndex}: ${resolved.error}` };
        }
        base.resolvedBy = resolved.resolvedBy;
        await input.device.tap(resolved.point.x, resolved.point.y);
        if (action.action === "type") {
          if (action.input === undefined) {
            results.push({ ...base, error: "type-input-missing" });
            return { status: "error", steps: results, error: `step ${action.stepIndex}: type-input-missing` };
          }
          let typeText: string;
          if (action.input.kind === "text" && typeof action.input.text === "string") {
            typeText = action.input.text;
          } else if (action.input.kind === "secretRef") {
            const ref = action.input.ref;
            if (typeof ref !== "string" || ref === "") {
              results.push({ ...base, error: "type-input-missing" });
              return { status: "error", steps: results, error: `step ${action.stepIndex}: type-input-missing` };
            }
            const resolvedSecret = input.resolveSecret?.(ref);
            if (
              resolvedSecret === undefined ||
              resolvedSecret === null ||
              resolvedSecret === ""
            ) {
              results.push({ ...base, error: `secret-unresolved:${ref}` });
              return {
                status: "error",
                steps: results,
                error: `step ${action.stepIndex}: secret-unresolved:${ref}`
              };
            }
            typeText = resolvedSecret;
            secretValues.add(resolvedSecret);
          } else {
            results.push({ ...base, error: "type-input-missing" });
            return { status: "error", steps: results, error: `step ${action.stepIndex}: type-input-missing` };
          }
          let at = resolved.point;
          if (resolved.target.kind !== "point") {
            const refreshedNodes = visibleNodes(await input.device.nodes(), screen);
            const refreshed = resolveTarget(refreshedNodes, action, { preferEditable: true });
            if (!("error" in refreshed)) {
              at = refreshed.point;
            } else {
              const editable = refreshedNodes.filter((node) =>
                /textfield|edittext|securetextfield/i.test(node.type)
              );
              if (editable.length > 0) {
                const nearest = editable
                  .map((node) => ({
                    node,
                    distance:
                      Math.abs(node.rect.x + node.rect.width / 2 - resolved.point.x) +
                      Math.abs(node.rect.y + node.rect.height / 2 - resolved.point.y)
                  }))
                  .sort((left, right) => left.distance - right.distance)[0]!.node;
                at = {
                  x: nearest.rect.x + nearest.rect.width / 2,
                  y: nearest.rect.y + nearest.rect.height / 2
                };
              }
            }
          }
          await input.device.inputText(typeText, at);
        }
      } else if (action.action === "wait") {
        await sleep(action.timeoutMs ?? Math.min(stepTimeoutMs, 1000));
      }
      const observed = await observeStable(
        input.device,
        screen,
        action.expect?.timeoutMs ?? action.timeoutMs ?? stepTimeoutMs,
        pollMs,
        sleep
      );
      base.actual = {
        texts: textsOf(observed)
          .map((text) => redactValue(text, secretValues))
          .slice(0, 30),
        screen
      };
      const mismatch = expectError(action.expect, observed);
      if (mismatch !== null) {
        results.push({ ...base, status: "failed", error: mismatch });
        return { status: "failed", steps: results, error: `step ${action.stepIndex}: ${mismatch}` };
      }
      results.push({ ...base, status: "passed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...base, error: message });
      return { status: "error", steps: results, error: `step ${action.stepIndex}: ${message}` };
    }
  }
  return { status: "passed", steps: results };
}

/** Platform-neutral alias: the runner only depends on `StructuredDevice`. */
export const runStructuredCase = runStructuredIosCase;
