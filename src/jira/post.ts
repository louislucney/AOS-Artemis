import fs from "node:fs";
import path from "node:path";

import { readApiErrorsArtifact } from "../artemis/api-errors.js";
import { traceEvidence } from "../artemis/evidence.js";
import { classifyFailure } from "../artemis/failure-taxonomy.js";
import { classifyIosSerial } from "../device/ios.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import {
  type AttachEntry,
  deterministicAttachmentName,
  shortContentHash,
  uploadAttachmentsDeduped
} from "./attachments.js";
import { upsertTraceComment } from "./comments.js";
import { parseIssueKey } from "./context.js";
import { buildEvidenceComment, type EvidencePlatform } from "./evidence.js";
import { jiraErrorPayload, jiraMissingConfigPayload, resolveJiraClient } from "./resolve.js";

export interface JiraEvidencePostArgs {
  key: string;
  traceId: string;
  platform?: "android" | "ios";
  deviceSerial?: string;
  dryRun?: boolean;
}

interface PreparedAttachment {
  file: string;
  filename: string;
  size: number;
  content: Buffer | null;
  readError: string | null;
}

/** 失败证据回写：凭证检查 → key 解析 → trace 存在性 → 证据评论幂等 + 附件去重。
 * 错误三态（限流/API/通用）以 payload 字段保留；dryRun 且 key 为空/未提供 → 跳过 key 解析（`issue: null`）。 */
export async function postEvidenceToIssue(
  runtime: Runtime,
  args: JiraEvidencePostArgs
): Promise<Record<string, unknown>> {
  const resolved = resolveJiraClient(runtime);
  if (resolved === null) return jiraMissingConfigPayload(runtime);

  const keyInput = typeof args.key === "string" ? args.key : "";
  const key = parseIssueKey(keyInput);
  const previewNoKey = args.dryRun === true && keyInput.trim() === "";
  if (key === null && !previewNoKey) {
    return {
      ok: false,
      error: `无法解析 issue key："${keyInput}"。请传 key（如 AOS-123）或 browse URL。`
    };
  }

  const traceId = typeof args.traceId === "string" ? args.traceId.trim() : "";
  if (traceId === "") {
    return { ok: false, error: "traceId 不能为空。" };
  }
  const traceDir = runtime.traceDir(traceId);
  const status = await runtime.traceStatus(traceId);
  if (!status && !fs.existsSync(traceDir)) {
    return {
      ok: false,
      error: `未找到 trace ${traceId} 的任何产物。`,
      hints: [
        "确认 traceId（mobile_run_task 返回）；用 mobile_inspect_trace / aos_tasks 查台账",
        "或先跑 suite run / mobile_run_task 生成 trace 产物后再回写"
      ]
    };
  }

  const bundle = await traceEvidence(runtime, { traceId });
  const apiArtifact = readApiErrorsArtifact(traceDir);
  const crashes = bundle.crashes.map((crash) => ({
    id: crash.id,
    kind: crash.kind,
    package: crash.package,
    exceptionClass: crash.exceptionClass
  }));
  const failureDomain =
    bundle.status && bundle.status !== "completed" && bundle.status !== "running"
      ? classifyFailure({
          status,
          crashes,
          apiErrors: (apiArtifact?.errors ?? []).map((error) => ({
            code: error.code,
            handled: error.handled
          }))
        }).domain
      : null;
  const rawPlatform = status ? (status as unknown as { platform?: unknown }).platform : null;
  const statusPlatform = typeof rawPlatform === "string" ? rawPlatform : null;
  const serial =
    typeof args.deviceSerial === "string" && args.deviceSerial.trim() !== ""
      ? args.deviceSerial.trim()
      : (status?.deviceSerial ?? null);
  const platform: EvidencePlatform =
    args.platform ??
    (serial !== null
      ? classifyIosSerial(serial) !== null
        ? "ios"
        : "android"
      : statusPlatform === "ios"
        ? "ios"
        : statusPlatform === "android"
          ? "android"
          : "unknown");

  const draft = buildEvidenceComment(bundle, { platform, deviceSerial: serial, failureDomain });
  const attachmentsRel = draft.attachments
    .map((abs) => path.relative(runtime.project.rootDir, abs))
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));

  if (args.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      site: resolved.siteUrl,
      issue: key,
      traceId,
      platform,
      deviceSerial: serial,
      failureDomain,
      degraded: bundle.degraded,
      commentText: draft.text,
      attachments: attachmentsRel
    };
  }

  const issueKey = key as string;
  let comment: { action: "created" | "updated"; commentId: string; propertySet: boolean };
  try {
    comment = await upsertTraceComment(resolved.client, issueKey, { traceId, body: draft.adf });
  } catch (error) {
    return jiraErrorPayload(error);
  }

  let attachments: unknown[] = [];
  if (attachmentsRel.length > 0) {
    const env = { ...runtime.project.dotenvValues, ...process.env };
    const prepared: PreparedAttachment[] = attachmentsRel.map((rel) => {
      const abs = path.resolve(runtime.project.rootDir, rel);
      try {
        const content = fs.readFileSync(abs);
        return {
          file: rel,
          filename: deterministicAttachmentName(path.basename(abs), shortContentHash(content)),
          size: content.byteLength,
          content,
          readError: null
        };
      } catch (error) {
        return { file: rel, filename: "", size: 0, content: null, readError: errorMessage(error) };
      }
    });
    const ready: AttachEntry[] = prepared
      .filter((entry) => entry.content !== null)
      .map((entry) => ({
        file: entry.file,
        filename: entry.filename,
        size: entry.size,
        content: entry.content as Buffer
      }));
    if (ready.length > 0) {
      const { results } = await uploadAttachmentsDeduped(resolved.client, issueKey, ready, { env });
      let resultIndex = 0;
      attachments = prepared.map((entry) => {
        if (entry.content === null) {
          return {
            file: entry.file,
            filename: null,
            size: 0,
            status: "read-error",
            reason: entry.readError
          };
        }
        return results[resultIndex++];
      });
    }
  }

  return {
    ok: true,
    site: resolved.siteUrl,
    issue: issueKey,
    traceId,
    platform,
    deviceSerial: serial,
    failureDomain,
    action: comment.action,
    commentId: comment.commentId,
    propertySet: comment.propertySet,
    attachments,
    degraded: bundle.degraded
  };
}
