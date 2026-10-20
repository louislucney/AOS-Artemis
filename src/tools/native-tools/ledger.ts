import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { migrateLegacyLedger } from "../../ledger/migrate.js";
import type { NativeToolDefinition } from "./types.js";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

export const LEDGER_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "aos_ledger_migrate",
    description:
      "把当前项目文件台账（.artemis/ledger/usage.jsonl + state.json）中的 usage_events / regression_tasks 幂等补进中心 PostgreSQL（保留原 id）。默认 dryRun 只统计不写库；仅当前存储为 PostgreSQL 时可用。不做任意路径/DB URL 参数，也不处理 suite_runs/case_sets（用 suite backfill）。",
    schema: z.object({
      dryRun: z.boolean().optional().describe("只统计 found/existing/inserted，不写库，默认 true"),
      write: z.boolean().optional().describe("显式写库（等价 dryRun:false）；默认 false")
    }),
    handler: async (runtime, args) => {
      const dryRun = args.write === true ? false : args.dryRun !== false;
      const result = await migrateLegacyLedger(runtime.store, runtime.project.rootDir, { dryRun });
      try {
        await runtime.store.recordAudit(runtime.project.rootDir, {
          domain: "ledger-migrate",
          action: dryRun ? "preview" : "import",
          result: result.ok ? "ok" : "failed",
          summary: result.counts
            ? `usage=${result.counts.usage.inserted}/${result.counts.usage.found} regression=${result.counts.regressionTasks.inserted}/${result.counts.regressionTasks.found} dryRun=${dryRun}`
            : (result.error ?? "ledger migrate failed").slice(0, 300)
        });
      } catch {
        /* audit is best-effort */
      }
      return jsonResult(result, !result.ok);
    }
  }
];
