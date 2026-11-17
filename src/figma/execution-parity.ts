import path from "node:path";

import type { SuiteRunRecord } from "../db/types.js";
import type { Runtime } from "../runtime.js";
import { readExecutionEvidence } from "./execution-evidence.js";
import {
  compareExecutionParity,
  type ExecutionParityRecord,
  type ExecutionParityResult
} from "./execution-plan.js";
import {
  compareSystemDialogs,
  readSystemDialogs,
  type SystemDialogParity
} from "./system-dialog-store.js";

export interface TaskExecutionParity {
  cases: ExecutionParityResult[];
  systemDialog: SystemDialogParity;
}

function parityStatus(value: string): ExecutionParityRecord["status"] {
  return value === "passed" || value === "failed" || value === "timeout" || value === "submit-error"
    ? value
    : "failed";
}

/** 从 suite_runs + 执行证据 + 弹窗旁车计算任务级跨端一致性（CLI parity / 报告共用）。 */
export function evaluateTaskExecutionParity(
  runtime: Pick<Runtime, "project" | "traceDir">,
  taskId: string,
  runs: readonly SuiteRunRecord[]
): TaskExecutionParity {
  const records = new Map<string, ExecutionParityRecord>();
  for (const run of runs) {
    for (const entry of run.cases) {
      const platform =
        entry.platform === "ios" ? "ios" : entry.platform === "android" ? "android" : null;
      if (platform === null || entry.caseId === "") continue;
      const key = `${entry.caseId}\u0000${platform}`;
      if (records.has(key)) continue;
      let evidence = null;
      if (entry.traceId !== null) {
        for (const file of [
          path.join(
            runtime.project.rootDir,
            ".artemis",
            "remote-evidence",
            taskId,
            entry.traceId,
            "execution-evidence.json"
          ),
          path.join(runtime.traceDir(entry.traceId), "execution-evidence.json")
        ]) {
          evidence = readExecutionEvidence(file);
          if (evidence !== null) break;
        }
      }
      records.set(key, {
        caseId: entry.caseId,
        platform,
        status: parityStatus(entry.status),
        plan: evidence?.plan ?? null,
        stepsAvailable: evidence?.stepsAvailable ?? false,
        resetOk: evidence?.resetOk ?? null
      });
    }
  }
  return {
    cases: compareExecutionParity([...records.values()]),
    systemDialog: compareSystemDialogs(readSystemDialogs(runtime.project.rootDir, taskId))
  };
}
