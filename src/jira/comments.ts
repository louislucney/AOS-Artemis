import { type AdfNode, adfParagraph, adfToText } from "./adf.js";
import type { JiraClient } from "./client.js";

export const AOS_TRACE_PROPERTY_KEY = "aos-trace";

export function traceMarker(traceId: string): string {
  return `AOS-TRACE:${traceId}`;
}

/** 在评论 ADF 末尾追加 marker 段落（已存在则原样返回，保证幂等）。 */
export function withTraceMarker(body: AdfNode, traceId: string): AdfNode {
  if (adfToText(body).includes(traceMarker(traceId))) return body;
  return { ...body, content: [...(body.content ?? []), adfParagraph(traceMarker(traceId))] };
}

/** 在既有评论列表中按 marker 定位（marker 写进正文页脚，跨账号可读）。 */
export function findCommentByTrace(
  comments: Array<{ id: string; body?: unknown }>,
  traceId: string
): { id: string } | null {
  const marker = traceMarker(traceId);
  for (const comment of comments) {
    if (adfToText(comment.body).includes(marker)) return { id: comment.id };
  }
  return null;
}

export interface UpsertCommentResult {
  action: "created" | "updated";
  commentId: string;
  propertySet: boolean;
}

/** 同 issue + 同 trace 幂等回写：存在则更新（PUT），否则新建（POST）；随后 best-effort 写评论属性。 */
export async function upsertTraceComment(
  client: JiraClient,
  issueKey: string,
  options: { traceId: string; body: AdfNode }
): Promise<UpsertCommentResult> {
  const marked = withTraceMarker(options.body, options.traceId);
  const comments = await client.getComments(issueKey);
  const existing = findCommentByTrace(comments, options.traceId);
  if (existing) {
    await client.updateComment(issueKey, existing.id, marked);
    const propertySet = await client.setCommentProperty(issueKey, existing.id, AOS_TRACE_PROPERTY_KEY, {
      traceId: options.traceId
    });
    return { action: "updated", commentId: existing.id, propertySet };
  }
  const commentId = await client.createComment(issueKey, marked);
  const propertySet = await client.setCommentProperty(issueKey, commentId, AOS_TRACE_PROPERTY_KEY, {
    traceId: options.traceId
  });
  return { action: "created", commentId, propertySet };
}
