import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore } from "../../db/types.js";
import { ingestWebJobResult } from "../results.js";
import type { LlmWorkerCaseResult, LlmWorkerJob } from "./worker.js";
import { packageFilename } from "./cases.js";

function executionStatus(
  results: LlmWorkerCaseResult[]
): "passed" | "failed" | "partial" | "error" {
  if (results.length === 0) return "error";
  if (results.some((entry) => entry.status === "FAIL" || entry.status === "ERROR")) {
    return "failed";
  }
  if (results.some((entry) => entry.status === "SKIP" || entry.status === "UNVERIFIED")) {
    return "partial";
  }
  return "passed";
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

async function artifact(
  filePath: string | undefined,
  fallback: string
): Promise<{ filename: string; base64: string } | undefined> {
  if (filePath === undefined) return undefined;
  try {
    const buffer = await readFile(filePath);
    return {
      filename: path.basename(filePath) === "" ? fallback : path.basename(filePath),
      base64: buffer.toString("base64")
    };
  } catch {
    return undefined;
  }
}

/** 中心 LLM worker 的结果入库：复用 ingestWebJobResult，允许 UNVERIFIED。 */
export async function ingestLlmResults(input: {
  store: ProjectStore;
  job: LlmWorkerJob;
  results: LlmWorkerCaseResult[];
  nowMs?: number;
}): Promise<void> {
  const now = input.nowMs ?? Date.now();
  const pkg = await packageFilename(
    input.store,
    input.job.rootPath,
    input.job.spec.packageAssetId
  );
  const traces = input.results
    .map((entry) => entry.traceId)
    .filter((entry): entry is string => typeof entry === "string" && entry !== "");
  const tokenUsage = input.results.flatMap((entry) =>
    Array.isArray(entry.tokenUsage) ? entry.tokenUsage : []
  );
  const statusJson = await artifact(
    input.results.find((entry) => entry.artifacts?.statusJsonPath !== undefined)?.artifacts
      ?.statusJsonPath,
    "status.json"
  );
  const dataEngineDb = await artifact(
    input.results.find((entry) => entry.artifacts?.dataEngineDbPath !== undefined)?.artifacts
      ?.dataEngineDbPath,
    "data_engine.db"
  );
  const startedAt =
    input.job.task.startedAt ?? iso(now - Math.max(1, ...input.results.map((entry) => entry.durationMs)));
  await ingestWebJobResult({
    store: input.store,
    jobId: input.job.task.id,
    centerOrigin: true,
    actor: "web-llm-worker",
    nowMs: now,
    payload: {
      execution: {
        status: executionStatus(input.results),
        cases: input.results.map((entry) => ({
          caseId: entry.caseId,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          status: entry.status,
          durationMs: entry.durationMs,
          ...(entry.failureReason === undefined ? {} : { failureReason: entry.failureReason }),
          ...(entry.traceId === undefined ? {} : { traceId: entry.traceId })
        })),
        startedAt,
        finishedAt: iso(now),
        detail: null
      },
      device: {
        serial: input.job.deviceSerial,
        model: "unknown",
        osVersion: "unknown"
      },
      package: {
        name: "",
        version: "",
        filename: pkg?.filename ?? "package.bin"
      },
      startedAt,
      finishedAt: iso(now),
      evidence: traces,
      tokenUsage,
      ...(statusJson === undefined && dataEngineDb === undefined
        ? {}
        : {
            tokenArtifacts: {
              ...(dataEngineDb === undefined ? {} : { dataEngineDb }),
              ...(statusJson === undefined ? {} : { statusJson })
            }
          })
    }
  });
}
