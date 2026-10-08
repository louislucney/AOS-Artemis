import fs from "node:fs";
import path from "node:path";

export interface QuarantineEntry {
  caseId: string;
  reason: string | null;
  owner: string;
  signedAt: string;
  expiresAt: string | null;
}

export interface QuarantineParse {
  active: Map<string, QuarantineEntry>;
  stale: QuarantineEntry[];
  invalid: string[];
}

export interface QuarantineLoad extends QuarantineParse {
  file: string;
  exists: boolean;
  errors: string[];
}

/** 解析 quarantine.json（纯函数）：缺 owner/signedAt 视为无效；过期进入 stale（不再隔离）。 */
export function parseQuarantine(raw: string, now: Date): QuarantineParse {
  const active = new Map<string, QuarantineEntry>();
  const stale: QuarantineEntry[] = [];
  const invalid: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { active, stale, invalid: ["quarantine.json 不是合法 JSON"] };
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    return { active, stale, invalid: ["quarantine.json 缺少 entries 数组"] };
  }
  for (const item of entries) {
    if (!item || typeof item !== "object") {
      invalid.push("条目不是对象（忽略）");
      continue;
    }
    const record = item as Record<string, unknown>;
    const caseId = typeof record.caseId === "string" ? record.caseId.trim() : "";
    const owner = typeof record.owner === "string" ? record.owner.trim() : "";
    const signedAt = typeof record.signedAt === "string" ? record.signedAt : "";
    const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : null;
    if (!caseId) {
      invalid.push("缺少 caseId（忽略）");
      continue;
    }
    if (!owner || !signedAt || !Number.isFinite(Date.parse(signedAt))) {
      invalid.push(`${caseId}: 缺少 owner 或有效 signedAt 签字（忽略，需 owner 签字）`);
      continue;
    }
    const entry: QuarantineEntry = {
      caseId,
      reason: typeof record.reason === "string" ? record.reason : null,
      owner,
      signedAt,
      expiresAt
    };
    if (expiresAt !== null) {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry)) {
        invalid.push(`${caseId}: expiresAt 无法解析（按未过期处理）`);
      } else if (expiry <= now.getTime()) {
        stale.push(entry);
        continue;
      }
    }
    active.set(caseId, entry);
  }
  return { active, stale, invalid };
}

export function loadQuarantine(configDirAbs: string, now: Date = new Date()): QuarantineLoad {
  const file = path.join(configDirAbs, "design", "quarantine.json");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return { file, exists: true, errors: [], ...parseQuarantine(raw, now) };
  } catch {
    return { file, exists: false, active: new Map(), stale: [], invalid: [], errors: [] };
  }
}
