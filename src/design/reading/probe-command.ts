import fs from "node:fs";
import path from "node:path";

import type { Runtime } from "../../runtime.js";
import { resolveProbeDevice } from "./probe.js";
import {
  interactionCandidatesFromReading,
  type InteractionCandidate
} from "./interaction.js";
import {
  assertionFromObserved,
  loadObservedCache,
  observedKey,
  probeScrollCollapse,
  saveObservedCache,
  type ProbeResult,
  type ScrollProbeDevice
} from "./probe.js";

interface ReadingFile {
  interactionCandidates?: InteractionCandidate[];
  flowsFingerprint?: string;
}

interface FlowRaw {
  screens?: Array<{
    id?: unknown;
    name?: unknown;
    states?: Array<{ id?: unknown; label?: unknown; frameName?: unknown }>;
  }>;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function frameNames(runtime: Runtime): Map<string, string> {
  const names = new Map<string, string>();
  const flowsPath = path.join(runtime.configDirAbs, "design", "flows.json");
  try {
    const raw = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as FlowRaw;
    for (const screen of raw.screens ?? []) {
      const id = stringOf(screen.id);
      const name = stringOf(screen.name);
      if (id !== null && name !== null) names.set(id, name);
      for (const state of screen.states ?? []) {
        const stateId = stringOf(state.id);
        const stateName = stringOf(state.label) ?? stringOf(state.frameName);
        if (stateId !== null && stateName !== null) names.set(stateId, stateName);
      }
    }
  } catch {
    /* names are optional */
  }
  return names;
}

function candidateName(candidate: InteractionCandidate, names: Map<string, string>): string {
  const before = names.get(candidate.beforeFrameId) ?? candidate.beforeFrameId;
  const after = names.get(candidate.afterFrameId) ?? candidate.afterFrameId;
  return `${before} → ${after}`;
}

function matchesQuery(candidate: InteractionCandidate, query: string, names: Map<string, string>): boolean {
  const wanted = normalize(query);
  if (wanted === "") return false;
  const ids = [candidate.beforeFrameId, candidate.afterFrameId].map(normalize);
  const labels = [
    names.get(candidate.beforeFrameId) ?? "",
    names.get(candidate.afterFrameId) ?? ""
  ].map(normalize);
  return [...ids, ...labels].some((value) => value === wanted || value.includes(wanted));
}

export interface InteractionProbeOptions {
  screen: string;
  deviceSerial: string;
  appVersion?: string;
  designFingerprint?: string;
  maxScroll?: number;
  step?: number;
  outDir?: string;
  noSave?: boolean;
}

export interface InteractionProbeDeps {
  device?: ScrollProbeDevice;
}

export interface InteractionProbeResult {
  exitCode: 0 | 1 | 2;
  payload: Record<string, unknown>;
}

export async function runInteractionProbe(
  runtime: Runtime,
  options: InteractionProbeOptions,
  deps: InteractionProbeDeps = {}
): Promise<InteractionProbeResult> {
  const readingPath = path.join(runtime.configDirAbs, "design", "reading", "reading.json");
  let reading: ReadingFile;
  try {
    reading = JSON.parse(fs.readFileSync(readingPath, "utf-8")) as ReadingFile;
  } catch {
    return {
      exitCode: 2,
      payload: {
        ok: false,
        error: `缺少 reading.json：${readingPath}；先运行 design_to_test / 设计阅读`
      }
    };
  }
  const candidates = interactionCandidatesFromReading(reading.interactionCandidates).filter(
    (candidate) => candidate.kind === "scroll-collapse"
  );
  if (candidates.length === 0) {
    return {
      exitCode: 2,
      payload: { ok: false, error: "reading.json 没有 scroll-collapse 候选" }
    };
  }
  const names = frameNames(runtime);
  const matched = candidates.filter((candidate) => matchesQuery(candidate, options.screen, names));
  if (matched.length === 0) {
    return {
      exitCode: 2,
      payload: {
        ok: false,
        error: `没有匹配「${options.screen}」的 scroll 候选`,
        candidates: candidates.map((candidate) => ({
          before: candidate.beforeFrameId,
          after: candidate.afterFrameId,
          name: candidateName(candidate, names)
        }))
      }
    };
  }
  if (matched.length > 1) {
    return {
      exitCode: 2,
      payload: {
        ok: false,
        error: `「${options.screen}」匹配到多个 scroll 候选`,
        candidates: matched.map((candidate) => ({
          before: candidate.beforeFrameId,
          after: candidate.afterFrameId,
          name: candidateName(candidate, names)
        }))
      }
    };
  }
  const candidate = matched[0]!;
  const device = deps.device ?? resolveProbeDevice(runtime, options.deviceSerial);
  const designRoot = path.join(runtime.configDirAbs, "design");
  const result: ProbeResult = await probeScrollCollapse(device, candidate, {
    screenId: options.screen,
    deviceSerial: options.deviceSerial,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.designFingerprint === undefined && reading.flowsFingerprint === undefined
      ? {}
      : { designFingerprint: options.designFingerprint ?? reading.flowsFingerprint! }),
    ...(options.maxScroll === undefined ? {} : { maxScroll: options.maxScroll }),
    ...(options.step === undefined ? {} : { step: options.step }),
    outDir: options.outDir ?? path.join(designRoot, "interactions", "probes")
  });
  if (result.observed === null) {
    return {
      exitCode: 1,
      payload: {
        ok: false,
        error: result.reason,
        candidate: {
          before: candidate.beforeFrameId,
          after: candidate.afterFrameId,
          name: candidateName(candidate, names)
        },
        evidenceDir: result.evidenceDir
      }
    };
  }
  const cache = loadObservedCache(designRoot);
  const key = observedKey(candidate.afterFrameId, options.deviceSerial);
  cache[key] = {
    fingerprint: {
      deviceSerial: options.deviceSerial,
      appVersion: options.appVersion ?? null,
      designFingerprint: options.designFingerprint ?? reading.flowsFingerprint ?? null
    },
    observed: result.observed
  };
  if (options.noSave !== true) saveObservedCache(designRoot, cache);
  return {
    exitCode: 0,
    payload: {
      ok: true,
      candidate: {
        before: candidate.beforeFrameId,
        after: candidate.afterFrameId,
        name: candidateName(candidate, names)
      },
      observed: result.observed,
      assertion: assertionFromObserved(result.observed),
      evidenceDir: result.evidenceDir,
      cached: options.noSave !== true
    }
  };
}
