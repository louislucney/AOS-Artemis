import type { ChatFn, ChatMessage } from "../llm/chat.js";
import { errorMessage } from "../util.js";

/** Jira 单 → 用例库候选的 LLM 约束映射：只能从清单中选 id，或答"没有"。 */

export interface MappingCandidate {
  feature: string;
  provenance: string;
  cases: Array<{ id: string; name: string }>;
}

export interface MappingIssue {
  key: string;
  summary: string;
  descriptionText: string;
  acceptanceCriteria: string[];
}

export type MappingSelection = { ok: true; caseIds: string[] } | { ok: false; error: string };

export const MAPPING_CASE_CAP = 400;
export const MAPPING_SELECTION_CAP = 10;
const MAPPING_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = [
  "你是测试用例映射助手：阅读 Jira 工单，从给定候选用例清单中选出与该工单最相关的用例。",
  "约束：只能从清单中选 id，不能编造；没有合适的就返回空数组；最多选 10 条。",
  '只输出 JSON：{"caseIds":["…"]}（不要其它文字）。'
].join("\n");

function candidateIdsOf(candidates: MappingCandidate[]): Set<string> {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    for (const entry of candidate.cases) ids.add(entry.id);
  }
  return ids;
}

export function buildMappingMessages(input: {
  issue: MappingIssue;
  candidates: MappingCandidate[];
  previous?: string[];
}): ChatMessage[] {
  const lines: string[] = [`工单：${input.issue.key} ${input.issue.summary}`];
  if (input.issue.descriptionText.trim() !== "") lines.push(input.issue.descriptionText.trim());
  if (input.issue.acceptanceCriteria.length > 0) {
    lines.push("验收标准：");
    for (const criterion of input.issue.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  lines.push("候选用例：");
  let count = 0;
  let truncated = false;
  for (const candidate of input.candidates) {
    if (count >= MAPPING_CASE_CAP) {
      truncated = true;
      break;
    }
    lines.push(`- ${candidate.feature}（${candidate.provenance}）`);
    for (const entry of candidate.cases) {
      if (count >= MAPPING_CASE_CAP) {
        truncated = true;
        break;
      }
      lines.push(`  - ${entry.id} ${entry.name}`);
      count += 1;
    }
  }
  if (truncated) {
    lines.push(`候选已达上限 ${MAPPING_CASE_CAP} 条（仅列出前 ${MAPPING_CASE_CAP} 条）`);
  }
  if (input.previous && input.previous.length > 0) {
    lines.push(`上次验证选择的用例（仅供参考）：${input.previous.join(", ")}`);
  }
  lines.push('请只输出 JSON：{"caseIds":["…"]}');
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") }
  ];
}

function parseCaseIds(reply: string): string[] | null {
  const attempt = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  let parsed = attempt(reply.trim());
  if (parsed === null) {
    const match = /\{[\s\S]*\}/.exec(reply);
    if (match) parsed = attempt(match[0]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = (parsed as { caseIds?: unknown }).caseIds;
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === "string");
}

export async function selectCasesWithLlm(
  chat: ChatFn,
  input: { issue: MappingIssue; candidates: MappingCandidate[]; previous?: string[] }
): Promise<MappingSelection> {
  let reply: string;
  try {
    reply = await chat(buildMappingMessages(input), AbortSignal.timeout(MAPPING_TIMEOUT_MS));
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  const rawIds = parseCaseIds(reply);
  if (rawIds === null) {
    return { ok: false, error: `映射响应不是合法 JSON：${reply.trim().slice(0, 200)}` };
  }
  const allowed = candidateIdsOf(input.candidates);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const id of rawIds) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
    if (selected.length >= MAPPING_SELECTION_CAP) break;
  }
  return { ok: true, caseIds: selected };
}
