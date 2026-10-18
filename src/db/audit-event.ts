import { randomUUID } from "node:crypto";

import type { AuditEventInput, AuditEventRecord } from "./types.js";

export const AUDIT_SUMMARY_MAX = 300;
export const AUDIT_DEFAULT_LIMIT = 200;

export function buildAuditEvent(rootPath: string, input: AuditEventInput): AuditEventRecord {
  return {
    id: randomUUID(),
    rootPath,
    at: input.at ?? new Date().toISOString(),
    domain: input.domain,
    action: input.action,
    result: input.result,
    summary: input.summary.slice(0, AUDIT_SUMMARY_MAX),
    refs: input.refs ? { ...input.refs } : {}
  };
}

export function cloneAuditEvent(record: AuditEventRecord): AuditEventRecord {
  return { ...record, refs: { ...record.refs } };
}

export function normalizeAuditLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : AUDIT_DEFAULT_LIMIT;
}
