import fs from "node:fs";
import path from "node:path";

import type { JobSnapshot } from "./jobs.js";

/** CMS Open 任务台账持久化：只存状态/时间戳/产物路径，不存请求凭证。
 * 原子写（临时文件 → rename），读失败按空台账处理（服务可继续启动）。 */

function isSnapshot(raw: unknown): raw is JobSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.status === "string" &&
    typeof record.step === "string" &&
    typeof record.createdAt === "string"
  );
}

export function loadJobs(file: string): JobSnapshot[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSnapshot) : [];
  } catch {
    return [];
  }
}

export function saveJobs(file: string, jobs: JobSnapshot[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(jobs, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}
