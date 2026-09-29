export type CrashKind = "java" | "native" | "anr" | "unknown";

export type CrashAttribution = "process-line" | "tombstone-header" | "anr-line" | "unknown";

export type CrashSource = "crash-buffer" | "main-buffer";

export interface ParsedCrash {
  kind: CrashKind;
  package: string;
  attribution: CrashAttribution;
  exceptionClass: string;
  message: string;
  rootCauseClass: string;
  topFrame: string;
  frames: string[];
  causedBy: string[];
  signature: string;
  signatureBasis: string;
  occurredAt: string | null;
  occurredAtMs: number | null;
  excerpt: string;
}

export interface CrashSummary {
  id: string;
  kind: CrashKind;
  package: string;
  attribution: CrashAttribution;
  exceptionClass: string;
  message: string;
  rootCauseClass: string;
  topFrame: string;
  signatureBasis: string;
  source: CrashSource;
  deviceSerial: string | null;
  occurredAt: string | null;
  capturedAt: string;
  occurrences: number;
  outcomeCounts: Record<string, number>;
  firstSeenAt: string;
  lastSeenAt: string;
  traceIds: string[];
}

export interface CrashRecord extends CrashSummary {
  frames: string[];
  causedBy: string[];
  excerpt: string;
}

export interface CrashIndex {
  version: 1;
  records: CrashSummary[];
}

export interface ScannedEntry {
  at: string;
  found: number;
  skipped?: string;
}

export interface ScannedIndex {
  version: 1;
  traces: Record<string, ScannedEntry>;
}

export interface CrashScanResult {
  traceId: string;
  status: "captured" | "empty" | "skipped";
  reason?: string;
  found: number;
  newIds?: string[];
  updatedIds?: string[];
  source?: CrashSource;
}

export interface CrashScanReport {
  enabled: boolean;
  results: CrashScanResult[];
}

export interface CrashListFilter {
  kind?: CrashKind;
  package?: string;
  sinceMs?: number;
  limit?: number;
}

export interface CrashCollectRequest {
  serial: string | null;
  windowStartMs: number;
  windowEndMs: number;
  targetPackage: string | null;
}

export interface CrashCollectOutcome {
  status: "ok" | "skipped";
  reason?: string;
  source?: CrashSource;
  text?: string;
  clockOffsetMs?: number;
  clockWarning?: boolean;
  serial?: string | null;
}

export interface CrashCollectorLike {
  collect(request: CrashCollectRequest): Promise<CrashCollectOutcome>;
}

export interface CrashScanInput {
  traceId: string;
  taskOutcome?: string | null;
  targetPackage?: string | null;
  fallbackStartMs?: number | null;
  fallbackEndMs?: number | null;
  force?: boolean;
}

export const CRASH_SCAN_SKIP_REASONS = [
  "disabled",
  "already-scanned",
  "no-window",
  "no-serial",
  "device-offline",
  "adb-not-found",
  "command-failed"
] as const;

export const CRASH_KINDS: CrashKind[] = ["java", "native", "anr", "unknown"];
