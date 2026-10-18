import { type AdfNode, adfParagraph, adfToText } from "./adf.js";
import type { JiraClient } from "./client.js";

export const AOS_TRACE_PROPERTY_KEY = "aos-trace";

export function traceMarker(traceId: string): string {
  return `AOS-TRACE:${traceId}`;
}

function withMarker(body: AdfNode, marker: string): AdfNode {
  if (adfToText(body).includes(marker)) return body;
  return { ...body, content: [...(body.content ?? []), adfParagraph(marker)] };
}

export function withTraceMarker(body: AdfNode, traceId: string): AdfNode {
  return withMarker(body, traceMarker(traceId));
}

/** 在评论列表中按 marker 字符串定位（跨账号可读的正文页脚标记）。 */
export function findCommentByMarker(
  comments: Array<{ id: string; body?: unknown }>,
  marker: string
): { id: string } | null {
  for (const comment of comments) {
    if (adfToText(comment.body).includes(marker)) return { id: comment.id };
  }
  return null;
}

export function findCommentByTrace(
  comments: Array<{ id: string; body?: unknown }>,
  traceId: string
): { id: string } | null {
  return findCommentByMarker(comments, traceMarker(traceId));
}

export interface UpsertCommentResult {
  action: "created" | "updated";
  commentId: string;
  propertySet: boolean;
}

export interface UpsertMarkedCommentOptions {
  marker: string;
  body: AdfNode;
  property?: { key: string; value: unknown };
}

/** 同 issue + 同 marker 幂等回写：存在则更新（PUT），否则新建（POST）；随后 best-effort 写评论属性。 */
export async function upsertMarkedComment(
  client: JiraClient,
  issueKey: string,
  options: UpsertMarkedCommentOptions
): Promise<UpsertCommentResult> {
  const marked = withMarker(options.body, options.marker);
  const comments = await client.getComments(issueKey);
  const existing = findCommentByMarker(comments, options.marker);
  let action: "created" | "updated";
  let commentId: string;
  if (existing) {
    await client.updateComment(issueKey, existing.id, marked);
    action = "updated";
    commentId = existing.id;
  } else {
    commentId = await client.createComment(issueKey, marked);
    action = "created";
  }
  let propertySet = false;
  if (options.property) {
    propertySet = await client.setCommentProperty(
      issueKey,
      commentId,
      options.property.key,
      options.property.value
    );
  }
  return { action, commentId, propertySet };
}

/** 同 issue + 同 trace 幂等回写：marker `AOS-TRACE:<traceId>`，属性键 `aos-trace`。 */
export async function upsertTraceComment(
  client: JiraClient,
  issueKey: string,
  options: { traceId: string; body: AdfNode }
): Promise<UpsertCommentResult> {
  return upsertMarkedComment(client, issueKey, {
    marker: traceMarker(options.traceId),
    body: options.body,
    property: { key: AOS_TRACE_PROPERTY_KEY, value: { traceId: options.traceId } }
  });
}
