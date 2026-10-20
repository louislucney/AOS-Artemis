import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Runtime } from "../runtime.js";
import { runBackfill } from "../tasks/backfill.js";
import { errorMessage, log } from "../util.js";
import { migrateLegacyLedger } from "./migrate.js";

export interface LedgerAutoImportResult {
  status: "skipped" | "imported" | "error";
  reason?: string;
  usageInserted: number;
  runsInserted: number;
  caseSetsInserted: number;
}

const STAMP_FILE = ".pg-sync.json";

function statSignature(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function dirSignature(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => statSignature(path.join(dir, entry.name)))
      .filter((entry): entry is string => entry !== null)
      .sort();
  } catch {
    return [];
  }
}

/** Cheap change detector for the local ledger + suite artifacts. */
function localSignature(rootPath: string): string {
  const ledgerDir = path.join(rootPath, ".artemis", "ledger");
  const designDir = path.join(rootPath, ".artemis", "design");
  const parts = [
    statSignature(path.join(ledgerDir, "usage.jsonl")),
    statSignature(path.join(ledgerDir, "state.json")),
    ...dirSignature(path.join(designDir, "runs")),
    ...dirSignature(path.join(designDir, "case-sets"))
  ].filter((entry): entry is string => entry !== null);
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function readStamp(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { signature?: unknown };
    return typeof parsed.signature === "string" ? parsed.signature : null;
  } catch {
    return null;
  }
}

function writeStamp(file: string, input: LedgerAutoImportResult, signature: string): void {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ signature, syncedAt: new Date().toISOString(), ...input }, null, 2),
      "utf-8"
    );
  } catch {
    /* best effort */
  }
}

/** Bring a project's local file ledger/artifacts into the central PostgreSQL
 * ledger when the configured store is PG. Idempotent: IDs are preserved and
 * suite backfill only registers missing artifacts. Runs at startup so a project
 * switching from file storage to PG does not silently keep history local. */
export async function autoImportLocalLedger(
  runtime: Runtime,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<LedgerAutoImportResult> {
  const env = options.env ?? process.env;
  const skipped: LedgerAutoImportResult = {
    status: "skipped",
    usageInserted: 0,
    runsInserted: 0,
    caseSetsInserted: 0
  };
  if (env.AOS_LEDGER_AUTO_IMPORT === "0") return { ...skipped, reason: "disabled" };
  if (runtime.store.kind !== "postgres") return { ...skipped, reason: "non-postgres" };

  const rootPath = runtime.project.rootDir;
  const ledgerDir = path.join(rootPath, ".artemis", "ledger");
  const usageFile = path.join(ledgerDir, "usage.jsonl");
  const stateFile = path.join(ledgerDir, "state.json");
  const runsDir = path.join(rootPath, ".artemis", "design", "runs");
  const caseSetsDir = path.join(rootPath, ".artemis", "design", "case-sets");
  const hasUsage = fs.existsSync(usageFile) || fs.existsSync(stateFile);
  const hasSuiteArtifacts = fs.existsSync(runsDir) || fs.existsSync(caseSetsDir);
  if (!hasUsage && !hasSuiteArtifacts) return { ...skipped, reason: "no-local-data" };

  const signature = localSignature(rootPath);
  const stampFile = path.join(ledgerDir, STAMP_FILE);
  if (readStamp(stampFile) === signature) return { ...skipped, reason: "up-to-date" };

  const result: LedgerAutoImportResult = {
    status: "imported",
    usageInserted: 0,
    runsInserted: 0,
    caseSetsInserted: 0
  };
  try {
    if (hasUsage) {
      const migrated = await migrateLegacyLedger(runtime.store, rootPath, { dryRun: false });
      if (!migrated.ok) {
        return {
          ...result,
          status: "error",
          reason: migrated.error ?? "ledger-migrate failed"
        };
      }
      result.usageInserted = migrated.counts?.usage.inserted ?? 0;
    }
    if (hasSuiteArtifacts) {
      const backfill = await runBackfill(runtime, { dryRun: false });
      result.runsInserted = backfill.registered.runs;
      result.caseSetsInserted = backfill.registered.caseSets;
    }
    writeStamp(stampFile, result, signature);
    if (result.usageInserted + result.runsInserted + result.caseSetsInserted > 0) {
      log(
        `本地台账已回流中心 PG：usage=${result.usageInserted} runs=${result.runsInserted} caseSets=${result.caseSetsInserted}`
      );
    }
    return result;
  } catch (error) {
    return {
      ...result,
      status: "error",
      reason: errorMessage(error)
    };
  }
}
