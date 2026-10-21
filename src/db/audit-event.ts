import { randomUUID } from "node:crypto";

import { errorMessage, log } from "../util.js";
import type { AuditEventInput, AuditEventRecord, ProjectStore } from "./types.js";

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
    refs: input.refs ? { ...input.refs } : {},
    actor: input.actor ?? null,
    actorHostId: input.actorHostId ?? null,
    channel: input.channel ?? null
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

/** 内部编排审计（best-effort）：写入失败仅告警，绝不影响主流程。 */
export async function recordAuditSafe(
  store: ProjectStore,
  rootPath: string,
  input: AuditEventInput
): Promise<void> {
  try {
    await store.recordAudit(rootPath, input);
  } catch (error) {
    log(`审计写入失败（忽略）：${errorMessage(error)}`);
  }
}
