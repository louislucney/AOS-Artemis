import { createHash } from "node:crypto";
import path from "node:path";

import { JiraClient } from "./client.js";
import { errorMessage } from "../util.js";

export interface AttachEntry {
  file: string;
  filename: string;
  size: number;
  content: Buffer;
}

export interface UploadResult {
  file: string;
  filename: string | null;
  size: number;
  status: string;
  reason?: string;
}

const DEFAULT_ATTACH_MAX_MB = 20;

export function shortContentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** 确定性附件名：`<basename>-<sha8><ext>`（同名同大小视为已存在，内容哈希内置在名字里）。 */
export function deterministicAttachmentName(original: string, hash: string): string {
  const parsed = path.parse(original);
  const base = parsed.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
  return `${base}-${hash}${parsed.ext}`;
}

/** 附件去重上传单一事实源：读站点/本地上限 → 列出既有附件 → 逐条 skip/upload。 */
export async function uploadAttachmentsDeduped(
  client: JiraClient,
  key: string,
  entries: AttachEntry[],
  options: { env?: Record<string, string | undefined> } = {}
): Promise<{ results: UploadResult[]; degraded: string[] }> {
  const env = options.env ?? process.env;
  const envCapMb = Number(env.AOS_JIRA_ATTACH_MAX_MB ?? "");
  const localCapMb = Number.isFinite(envCapMb) && envCapMb > 0 ? envCapMb : DEFAULT_ATTACH_MAX_MB;

  let siteLimit: number | null = null;
  const degraded: string[] = [];
  try {
    const meta = await client.getAttachmentMeta();
    if (!meta.enabled) degraded.push("attachments-disabled");
    siteLimit = meta.uploadLimit;
  } catch (error) {
    degraded.push(`meta-failed: ${errorMessage(error)}`);
  }

  const existing = new Set<string>();
  try {
    for (const item of await client.listAttachments(key)) {
      existing.add(`${item.filename}:${item.size}`);
    }
  } catch (error) {
    degraded.push(`list-failed: ${errorMessage(error)}`);
  }

  const limitBytes = Math.min(siteLimit ?? Number.POSITIVE_INFINITY, localCapMb * 1024 * 1024);

  const results: UploadResult[] = entries.map((entry) => ({
    file: entry.file,
    filename: entry.filename || null,
    size: entry.size,
    status: "pending"
  }));

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const result = results[index];
    if (entry.size > limitBytes) {
      result.status = "skipped-too-large";
      result.reason = `超过上限 ${Math.round(limitBytes / (1024 * 1024))}MB（站点/本地取小）`;
      continue;
    }
    if (existing.has(`${entry.filename}:${entry.size}`)) {
      result.status = "skipped-duplicate";
      continue;
    }
    try {
      await client.uploadAttachment(key, {
        filename: entry.filename,
        content: entry.content
      });
      result.status = "uploaded";
      existing.add(`${entry.filename}:${entry.size}`);
    } catch (error) {
      result.status = "error";
      result.reason = errorMessage(error);
    }
  }

  return { results, degraded };
}
