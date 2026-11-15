import fs from "node:fs";
import path from "node:path";

import type { SecretEntry } from "../web/llm/secrets.js";

export interface EvidenceAxStep {
  index: number;
  action: string;
  screen?: string;
  texts: string[];
}

export interface EvidenceAxDocument {
  schemaVersion: 1;
  redacted: true;
  steps: EvidenceAxStep[];
}

const DEFAULT_MAX_STEPS = 8;
const MAX_TEXTS_PER_STEP = 80;
const MAX_TEXT_CHARS = 200;
const MAX_FILE_BYTES = 200 * 1024;

function enabled(env: NodeJS.ProcessEnv): boolean {
  return (env.AOS_RUNNER_EVIDENCE_AX ?? "1").trim() !== "0";
}

function maxSteps(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_RUNNER_EVIDENCE_MAX_AX_STEPS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_STEPS;
  return Math.min(raw, 20);
}

function redact(text: string, secrets: readonly SecretEntry[]): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret.value;
    if (value.length < 3) continue;
    out = out.split(value).join("***");
  }
  return out.slice(0, MAX_TEXT_CHARS);
}

function stringTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_TEXTS_PER_STEP) break;
    if (typeof entry === "string" && entry.trim() !== "") out.push(entry);
    else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string" && text.trim() !== "") out.push(text);
    }
  }
  return out;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 只提取失败步骤的 AX 文本摘要；params/taskDesc/输入值不落盘。
 * 用 secret 原值做精确脱敏；没有可用 AX 时返回 null。 */
export function collectEvidenceAx(
  traceDir: string,
  secrets: readonly SecretEntry[],
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!enabled(env)) return null;
  const candidates: Array<{ step: number; action: string; screen?: string; texts: string[] }> = [];
  const run = readJson(path.join(traceDir, "run.json"));
  const runSteps = run?.steps;
  if (Array.isArray(runSteps)) {
    for (const [offset, raw] of runSteps.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const step = raw as Record<string, unknown>;
      const texts = stringTexts(step.texts);
      if (texts.length === 0) continue;
      candidates.push({
        step: typeof step.step === "number" ? step.step : offset + 1,
        action: typeof step.action === "string" ? step.action : "unknown",
        ...(typeof step.screen === "string" && step.screen.trim() !== ""
          ? { screen: step.screen }
          : {}),
        texts
      });
    }
  }
  if (candidates.length === 0) {
    for (const name of ["native-ios.json", "native-android.json"]) {
      const native = readJson(path.join(traceDir, name));
      const steps = native?.steps;
      if (!Array.isArray(steps)) continue;
      for (const [offset, raw] of steps.entries()) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const step = raw as Record<string, unknown>;
        const actual = step.actual;
        const texts =
          actual !== null && typeof actual === "object" && !Array.isArray(actual)
            ? stringTexts((actual as Record<string, unknown>).texts)
            : [];
        if (texts.length === 0) continue;
        candidates.push({
          step: typeof step.index === "number" ? step.index : offset + 1,
          action: typeof step.action === "string" ? step.action : "unknown",
          texts
        });
      }
      if (candidates.length > 0) break;
    }
  }
  if (candidates.length === 0) return null;
  const document: EvidenceAxDocument = {
    schemaVersion: 1,
    redacted: true,
    steps: candidates.slice(-maxSteps(env)).map((entry) => ({
      index: entry.step,
      action: entry.action,
      ...(entry.screen === undefined ? {} : { screen: redact(entry.screen, secrets) }),
      texts: entry.texts.map((text) => redact(text, secrets))
    }))
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) return null;
  return serialized;
}
