import fs from "node:fs";
import path from "node:path";

import { logWarn, writeFileAtomic } from "../util.js";
import type {
  CrashIndex,
  CrashListFilter,
  CrashRecord,
  CrashSummary,
  ParsedCrash,
  ScannedEntry,
  ScannedIndex
} from "./types.js";

const INDEX_VERSION = 1 as const;
const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_SCANNED_KEEP = 200;
const MAX_TRACE_IDS = 20;

export interface CrashUpsertMeta {
  traceId: string;
  taskOutcome: string;
  deviceSerial: string | null;
  capturedAt: string;
  source: CrashSummary["source"];
}

export interface CrashUpsertResult {
  newIds: string[];
  updatedIds: string[];
}

function emptyIndex(): CrashIndex {
  return { version: INDEX_VERSION, records: [] };
}

function emptyScanned(): ScannedIndex {
  return { version: INDEX_VERSION, traces: {} };
}

export class CrashIndexStore {
  private readonly maxRecords: number;
  private readonly scannedKeep: number;

  constructor(
    private readonly dir: string,
    options: { maxRecords?: number; scannedKeep?: number } = {}
  ) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.scannedKeep = options.scannedKeep ?? DEFAULT_SCANNED_KEEP;
  }

  get dirPath(): string {
    return this.dir;
  }

  private get indexPath(): string {
    return path.join(this.dir, "index.json");
  }

  private get scannedPath(): string {
    return path.join(this.dir, "scanned.json");
  }

  private recordPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private quarantine(filePath: string, label: string): void {
    const target = `${filePath}.corrupt`;
    try {
      fs.rmSync(target, { force: true });
      fs.renameSync(filePath, target);
      logWarn(`崩溃索引损坏（${label}）：已隔离为 ${path.basename(target)}`);
    } catch (error) {
      logWarn(`崩溃索引损坏（${label}）且隔离失败: ${String(error)}`);
    }
  }

  private readIndex(): CrashIndex {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexPath, "utf-8");
    } catch {
      return emptyIndex();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CrashIndex>;
      if (!Array.isArray(parsed.records)) throw new Error("records 不是数组");
      return { version: INDEX_VERSION, records: parsed.records as CrashSummary[] };
    } catch {
      this.quarantine(this.indexPath, "index.json");
      return emptyIndex();
    }
  }

  private writeIndex(index: CrashIndex): void {
    writeFileAtomic(this.indexPath, JSON.stringify(index, null, 2));
  }

  private readScanned(): ScannedIndex {
    let raw: string;
    try {
      raw = fs.readFileSync(this.scannedPath, "utf-8");
    } catch {
      return emptyScanned();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ScannedIndex>;
      if (!parsed.traces || typeof parsed.traces !== "object") throw new Error("traces 缺失");
      return { version: INDEX_VERSION, traces: parsed.traces as Record<string, ScannedEntry> };
    } catch {
      this.quarantine(this.scannedPath, "scanned.json");
      return emptyScanned();
    }
  }

  private writeScanned(scanned: ScannedIndex): void {
    writeFileAtomic(this.scannedPath, JSON.stringify(scanned, null, 2));
  }

  private writeRecord(record: CrashRecord): void {
    writeFileAtomic(this.recordPath(record.id), JSON.stringify(record, null, 2));
  }

  private readRecordFile(id: string): CrashRecord | null {
    try {
      const raw = fs.readFileSync(this.recordPath(id), "utf-8");
      const parsed = JSON.parse(raw) as CrashRecord;
      if (parsed.id !== id) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  list(filter: CrashListFilter = {}): { total: number; records: CrashSummary[] } {
    const index = this.readIndex();
    const sinceMs = filter.sinceMs ?? null;
    const filtered = index.records
      .filter((record) => {
        if (filter.kind && record.kind !== filter.kind) return false;
        if (filter.package && record.package !== filter.package) return false;
        if (sinceMs !== null) {
          const seen = Date.parse(record.lastSeenAt);
          if (!Number.isFinite(seen) || seen < sinceMs) return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    const limit = Math.max(1, Math.min(filter.limit ?? 20, 100));
    return { total: filtered.length, records: filtered.slice(0, limit) };
  }

  get(id: string): CrashRecord | null {
    const file = this.readRecordFile(id);
    if (file) return file;
    const index = this.readIndex();
    const summary = index.records.find((record) => record.id === id);
    if (!summary) return null;
    return { ...summary, frames: [], causedBy: [], excerpt: "" };
  }

  upsert(found: ParsedCrash[], meta: CrashUpsertMeta): CrashUpsertResult {
    const index = this.readIndex();
    const seen = new Set<string>();
    const newIds: string[] = [];
    const updatedIds: string[] = [];

    for (const crash of found) {
      if (seen.has(crash.signature)) continue;
      seen.add(crash.signature);

      const existing = index.records.find((record) => record.id === crash.signature);
      if (existing) {
        existing.occurrences += 1;
        existing.lastSeenAt = meta.capturedAt;
        existing.occurredAt = crash.occurredAt ?? existing.occurredAt;
        existing.exceptionClass = crash.exceptionClass;
        existing.message = crash.message;
        existing.rootCauseClass = crash.rootCauseClass;
        existing.topFrame = crash.topFrame;
        existing.signatureBasis = crash.signatureBasis;
        existing.attribution = crash.attribution;
        existing.source = meta.source;
        existing.deviceSerial = meta.deviceSerial ?? existing.deviceSerial;
        existing.outcomeCounts[meta.taskOutcome] =
          (existing.outcomeCounts[meta.taskOutcome] ?? 0) + 1;
        if (!existing.traceIds.includes(meta.traceId)) {
          existing.traceIds = [...existing.traceIds, meta.traceId].slice(-MAX_TRACE_IDS);
        }
        this.writeRecord({
          ...existing,
          frames: crash.frames,
          causedBy: crash.causedBy,
          excerpt: crash.excerpt
        });
        updatedIds.push(existing.id);
        continue;
      }

      const summary: CrashSummary = {
        id: crash.signature,
        kind: crash.kind,
        package: crash.package,
        attribution: crash.attribution,
        exceptionClass: crash.exceptionClass,
        message: crash.message,
        rootCauseClass: crash.rootCauseClass,
        topFrame: crash.topFrame,
        signatureBasis: crash.signatureBasis,
        source: meta.source,
        deviceSerial: meta.deviceSerial,
        occurredAt: crash.occurredAt,
        capturedAt: meta.capturedAt,
        occurrences: 1,
        outcomeCounts: { [meta.taskOutcome]: 1 },
        firstSeenAt: meta.capturedAt,
        lastSeenAt: meta.capturedAt,
        traceIds: [meta.traceId]
      };
      index.records.push(summary);
      this.writeRecord({
        ...summary,
        frames: crash.frames,
        causedBy: crash.causedBy,
        excerpt: crash.excerpt
      });
      newIds.push(summary.id);
    }

    this.evict(index);
    this.writeIndex(index);
    return { newIds, updatedIds };
  }

  private evict(index: CrashIndex): void {
    if (index.records.length <= this.maxRecords) return;
    const sorted = [...index.records].sort(
      (a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt)
    );
    const overflow = sorted.slice(0, index.records.length - this.maxRecords);
    const drop = new Set(overflow.map((record) => record.id));
    index.records = index.records.filter((record) => !drop.has(record.id));
    for (const record of overflow) {
      try {
        fs.rmSync(this.recordPath(record.id), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  isScanned(traceId: string): boolean {
    const scanned = this.readScanned();
    return Object.prototype.hasOwnProperty.call(scanned.traces, traceId);
  }

  recordScan(traceId: string, entry: ScannedEntry): void {
    const scanned = this.readScanned();
    scanned.traces[traceId] = entry;
    const keys = Object.keys(scanned.traces);
    if (keys.length > this.scannedKeep) {
      const ordered = keys.sort(
        (a, b) => Date.parse(scanned.traces[a]!.at) - Date.parse(scanned.traces[b]!.at)
      );
      for (const key of ordered.slice(0, keys.length - this.scannedKeep)) {
        delete scanned.traces[key];
      }
    }
    this.writeScanned(scanned);
  }

  counts(): { records: number; scanned: number } {
    const index = this.readIndex();
    const scanned = this.readScanned();
    return { records: index.records.length, scanned: Object.keys(scanned.traces).length };
  }
}
