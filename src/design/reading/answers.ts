import fs from "node:fs";
import path from "node:path";

import type { FlowWarning } from "../../figma/flows.js";
import { writeFileAtomic } from "../../util.js";
import type { ReadingAnswer, ReadingInteraction, ReadingQuestion, ReadingScreenObservation } from "./types.js";

export interface ReadingAnswersLoad {
  answers: ReadingAnswer[];
  warnings: FlowWarning[];
}

function contains(haystack: string | null | undefined, needle: string | undefined): boolean {
  return needle === undefined || (typeof haystack === "string" && haystack.includes(needle));
}

export function answerMatchesQuestion(answer: ReadingAnswer, question: ReadingQuestion): boolean {
  const match = answer.match;
  const hasSelector =
    match.questionIncludes !== undefined ||
    match.screenId !== undefined ||
    match.screenNameIncludes !== undefined ||
    match.elementIncludes !== undefined;
  if (!hasSelector) return false;
  if (match.screenId !== undefined && question.screenId !== match.screenId) return false;
  if (!contains(question.screenName, match.screenNameIncludes)) return false;
  if (match.elementIncludes !== undefined) {
    // 结构性提问的 element 常为空，元素名只出现在问题正文里。
    const haystack = `${question.element ?? ""} ${question.question}`;
    if (!haystack.includes(match.elementIncludes)) return false;
  }
  return contains(question.question, match.questionIncludes);
}

export function answerMatchesInteraction(answer: ReadingAnswer, interaction: ReadingInteraction): boolean {
  const match = answer.match;
  if (match.questionIncludes !== undefined) return false;
  const hasSelector =
    match.screenId !== undefined ||
    match.screenNameIncludes !== undefined ||
    match.elementIncludes !== undefined;
  if (!hasSelector) return false;
  if (match.screenId !== undefined && interaction.fromScreenId !== match.screenId) return false;
  if (match.screenNameIncludes !== undefined) return false;
  return match.elementIncludes === undefined || interaction.fromElement.includes(match.elementIncludes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadReadingAnswers(root: string): ReadingAnswersLoad {
  const file = path.join(root, "answers.json");
  if (!fs.existsSync(file)) return { answers: [], warnings: [] };
  const warnings: FlowWarning[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { answers?: unknown };
    if (!Array.isArray(parsed.answers)) {
      return {
        answers: [],
        warnings: [{ code: "reading-answers-invalid", message: "answers.json 缺 answers 数组" }]
      };
    }
    const answers: ReadingAnswer[] = [];
    for (const [index, raw] of parsed.answers.entries()) {
      if (!isRecord(raw)) continue;
      const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `answer-${index + 1}`;
      const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
      const match = isRecord(raw.match) ? raw.match : null;
      if (answer === "" || match === null) {
        warnings.push({
          code: "reading-answers-invalid",
          message: `answers[${index}] 缺 answer 或 match，已忽略`
        });
        continue;
      }
      const normalizedMatch = {
        ...(typeof match.screenId === "string" ? { screenId: match.screenId } : {}),
        ...(typeof match.screenNameIncludes === "string" ? { screenNameIncludes: match.screenNameIncludes } : {}),
        ...(typeof match.elementIncludes === "string" ? { elementIncludes: match.elementIncludes } : {}),
        ...(typeof match.questionIncludes === "string" ? { questionIncludes: match.questionIncludes } : {})
      };
      const resolution = isRecord(raw.resolution)
        ? {
            ...(typeof raw.resolution.toScreenId === "string" || raw.resolution.toScreenId === null
              ? { toScreenId: raw.resolution.toScreenId }
              : {}),
            ...(typeof raw.resolution.toLabel === "string" || raw.resolution.toLabel === null
              ? { toLabel: raw.resolution.toLabel }
              : {}),
            ...(typeof raw.resolution.action === "string" ? { action: raw.resolution.action } : {}),
            ...(raw.resolution.dropInteraction === true ? { dropInteraction: true } : {}),
            ...(typeof raw.resolution.screenTitle === "string" || raw.resolution.screenTitle === null
              ? { screenTitle: raw.resolution.screenTitle }
              : {})
          }
        : undefined;
      answers.push({
        id,
        match: normalizedMatch,
        answer,
        ...(resolution === undefined ? {} : { resolution })
      });
    }
    return { answers, warnings };
  } catch {
    return {
      answers: [],
      warnings: [{ code: "reading-answers-invalid", message: "answers.json 不是合法 JSON，已忽略" }]
    };
  }
}

export function applyAnswerToScreen(
  answer: ReadingAnswer,
  screen: ReadingScreenObservation
): ReadingScreenObservation | null {
  if (answer.resolution?.screenTitle === undefined) return null;
  if (answer.match.screenId !== undefined && screen.screenId !== answer.match.screenId) return null;
  return { ...screen, title: answer.resolution.screenTitle };
}

export function writeReadingAnswers(root: string, answers: ReadingAnswer[]): string {
  const file = path.join(root, "answers.json");
  fs.mkdirSync(root, { recursive: true });
  writeFileAtomic(file, JSON.stringify({ version: 1, answers }, null, 2) + "\n");
  return file;
}
