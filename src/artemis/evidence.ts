import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CrashSummary } from "../crash/types.js";
import {
  captureStepScreenshot,
  resolveTraceStepAnchor,
  type StepAnchor
} from "../diff/device-source.js";
import { designDeviceDiff, type DesignDeviceDiffArgs } from "../diff/tool.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { resultPayload } from "./task-result.js";

export interface EvidenceFailedItem {
  itemText: string | null;
  kind: string | null;
  evidence: string | null;
}

export interface EvidenceCrashRef {
  id: string;
  kind: string;
  package: string;
  exceptionClass: string;
  occurrences: number;
}

export interface EvidenceArtifact {
  kind: "screenshot" | "status" | "stderr" | "stdout" | "notes" | "crash-record" | "design-diff";
  path: string;
  copied: boolean;
}

export interface EvidenceDesignDiff {
  ok: boolean;
  reportPath: string | null;
  error: string | null;
}

export interface EvidenceBundle {
  ok: boolean;
  traceId: string;
  status: string | null;
  error: string | null;
  failedItems: EvidenceFailedItem[];
  crashes: EvidenceCrashRef[];
  anchor: StepAnchor | null;
  designDiff: EvidenceDesignDiff | null;
  degraded: string[];
  artifacts: EvidenceArtifact[];
  dir: string | null;
}

export interface EvidenceOptions {
  traceId: string;
  fullTrace?: boolean;
  save?: boolean;
  outputDir?: string;
  design?: { figmaUrl?: string; penPath?: string; nodeId?: string } | null;
  diffRunner?: typeof designDeviceDiff;
}

const FULL_TRACE_STEP_CAP = 10;

function crashRef(record: CrashSummary): EvidenceCrashRef {
  return {
    id: record.id,
    kind: record.kind,
    package: record.package,
    exceptionClass: record.exceptionClass,
    occurrences: record.occurrences
  };
}

export async function traceEvidence(
  runtime: Runtime,
  options: EvidenceOptions
): Promise<EvidenceBundle> {
  const traceId = options.traceId;
  const degraded: string[] = [];
  const artifacts: EvidenceArtifact[] = [];

  const status = await runtime.traceStatus(traceId);
  if (!status) degraded.push("trace-status-missing");
  if (status && !status.testSummary) degraded.push("no-run-outcome");
  const failedItems: EvidenceFailedItem[] = (status?.testSummary?.failedItems ?? []).map((item) => ({
    itemText: item.itemText,
    kind: item.kind,
    evidence: item.evidence
  }));

  let crashes: EvidenceCrashRef[] = [];
  try {
    crashes = runtime.crashStore
      .list({ limit: 100 })
      .records.filter((record) => record.traceIds.includes(traceId))
      .map(crashRef);
  } catch (error) {
    degraded.push(`crash-index-unreadable: ${errorMessage(error)}`);
  }

  let anchor: StepAnchor | null = null;
  if (failedItems.length > 0) {
    try {
      anchor = await resolveTraceStepAnchor(runtime, traceId);
    } catch (error) {
      degraded.push(`anchor-unavailable: ${errorMessage(error)}`);
    }
  } else {
    degraded.push("anchor-skipped");
  }

  let designDiff: EvidenceDesignDiff | null = null;
  if (options.design) {
    const runner = options.diffRunner ?? designDeviceDiff;
    const args: DesignDeviceDiffArgs = {
      design: {
        ...(options.design.figmaUrl ? { figmaUrl: options.design.figmaUrl } : {}),
        ...(options.design.penPath ? { penPath: options.design.penPath } : {}),
        ...(options.design.nodeId ? { nodeId: options.design.nodeId } : {})
      },
      device: { mode: "step", traceId },
      save: true
    };
    try {
      const result: CallToolResult = await runner(runtime, args);
      const payload = resultPayload(result);
      const saved = payload?.saved as { report?: unknown } | undefined;
      if (result.isError === true || typeof saved?.report !== "string") {
        const error = result.isError === true ? String(payload?.error ?? "设计差异生成失败") : "设计差异生成失败";
        designDiff = { ok: false, reportPath: null, error };
        degraded.push("design-diff-failed");
      } else {
        designDiff = { ok: true, reportPath: saved.report, error: null };
        artifacts.push({ kind: "design-diff", path: saved.report, copied: false });
      }
    } catch (error) {
      designDiff = { ok: false, reportPath: null, error: errorMessage(error) };
      degraded.push("design-diff-failed");
    }
  }

  const traceDir = runtime.traceDir(traceId);
  const reference = (kind: EvidenceArtifact["kind"], candidate: string | null | undefined): void => {
    if (!candidate) return;
    artifacts.push({ kind, path: candidate, copied: false });
  };
  reference("status", path.join(traceDir, "status.json"));
  reference("stderr", status?.stderrLog ?? path.join(traceDir, "stderr.log"));
  reference("stdout", status?.stdoutLog ?? path.join(traceDir, "stdout.log"));
  reference("notes", status?.notesDir);
  for (const crash of crashes) {
    reference("crash-record", path.join(runtime.crashStore.dirPath, `${crash.id}.json`));
  }

  let dir: string | null = null;
  if (options.save !== false && (status !== null || crashes.length > 0)) {
    dir = options.outputDir
      ? path.resolve(runtime.project.rootDir, options.outputDir)
      : path.join(runtime.configDirAbs, "design", "evidence", traceId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (anchor) {
        const stepNumbers = options.fullTrace
          ? anchor.candidates
              .map((candidate) => candidate.stepNumber)
              .slice(0, FULL_TRACE_STEP_CAP)
          : [anchor.stepNumber];
        for (const stepNumber of stepNumbers) {
          for (const image of ["pre", "post"] as const) {
            try {
              const captured = await captureStepScreenshot(runtime, { traceId, stepNumber, image });
              const file = path.join(dir, `step-${stepNumber}-${image}.png`);
              fs.writeFileSync(file, captured.bytes);
              artifacts.push({ kind: "screenshot", path: file, copied: true });
            } catch (error) {
              degraded.push(
                `screenshot-unavailable:step ${stepNumber} ${image}: ${errorMessage(error)}`
              );
            }
          }
        }
      }
    } catch (error) {
      degraded.push(`evidence-write-failed: ${errorMessage(error)}`);
      dir = null;
    }
  }

  const bundle: EvidenceBundle = {
    ok: status !== null || crashes.length > 0,
    traceId,
    status: status?.status ?? null,
    error: status?.error ?? null,
    failedItems,
    crashes,
    anchor,
    designDiff,
    degraded,
    artifacts,
    dir
  };

  if (dir) {
    try {
      fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`);
    } catch (error) {
      bundle.degraded = [...bundle.degraded, `manifest-write-failed: ${errorMessage(error)}`];
    }
  }

  return bundle;
}
