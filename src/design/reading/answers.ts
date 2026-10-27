import fs from "node:fs";
import path from "node:path";

import type { FlowWarning } from "../../figma/flows.js";
import { writeFileAtomic } from "../../util.js";
import { canonicalizeMatch, type ReadingNamingStyle } from "./naming.js";
import type { ReadingAnswer, ReadingInteraction, ReadingQuestion, ReadingScreenObservation } from "./types.js";

export interface ReadingAnswersLoad {
  answers: ReadingAnswer[];
  style: ReadingNamingStyle;
  warnings: FlowWarning[];
}

function matches(
  haystack: string | null | undefined,
  needle: string | undefined,
  synonyms: Record<string, string[]> | undefined
): boolean {
  if (needle === undefined) return true;
  if (typeof haystack !== "string") return false;
  return canonicalizeMatch(haystack, synonyms).includes(canonicalizeMatch(needle, synonyms));
}

export function answerMatchesQuestion(
  answer: ReadingAnswer,
  question: ReadingQuestion,
  style?: ReadingNamingStyle
): boolean {
  const match = answer.match;
  const synonyms = style?.synonyms;
  const hasSelector =
    match.questionIncludes !== undefined ||
    match.screenId !== undefined ||
    match.screenNameIncludes !== undefined ||
    match.elementIncludes !== undefined;
  if (!hasSelector) return false;
  if (match.screenId !== undefined && question.screenId !== match.screenId) return false;
  if (!matches(question.screenName, match.screenNameIncludes, synonyms)) return false;
  if (match.elementIncludes !== undefined) {
    // 结构性提问的 element 常为空，元素名只出现在问题正文里。
    const haystack = `${question.element ?? ""} ${question.question}`;
    if (!matches(haystack, match.elementIncludes, synonyms)) return false;
  }
  return matches(question.question, match.questionIncludes, synonyms);
}

export function answerMatchesInteraction(
  answer: ReadingAnswer,
  interaction: ReadingInteraction,
  style?: ReadingNamingStyle
): boolean {
  const match = answer.match;
  const synonyms = style?.synonyms;
  if (match.questionIncludes !== undefined) return false;
  const hasSelector =
    match.screenId !== undefined ||
    match.screenNameIncludes !== undefined ||
    match.elementIncludes !== undefined;
  if (!hasSelector) return false;
  if (match.screenId !== undefined && interaction.fromScreenId !== match.screenId) return false;
  if (match.screenNameIncludes !== undefined) return false;
  return match.elementIncludes === undefined || matches(interaction.fromElement, match.elementIncludes, synonyms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
  warnings: FlowWarning[]
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push({ code: "reading-answers-invalid", message: `${field} 必须是数组，已忽略` });
    return undefined;
  }
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry.length <= maxLength)
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function normalizeStyle(value: unknown, warnings: FlowWarning[]): ReadingNamingStyle {
  if (!isRecord(value)) return {};
  const style: ReadingNamingStyle = {};
  const separators = stringList(value.separators, "style.separators", 20, 8, warnings);
  if (separators !== undefined) style.separators = separators;
  const stateKeywords = stringList(value.stateKeywords, "style.stateKeywords", 200, 64, warnings);
  if (stateKeywords !== undefined) style.stateKeywords = stateKeywords;
  if (isRecord(value.synonyms)) {
    const synonyms: Record<string, string[]> = {};
    let count = 0;
    for (const [key, raw] of Object.entries(value.synonyms)) {
      if (count >= 200) break;
      if (!Array.isArray(raw) || key.trim() === "") continue;
      const aliases = raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "" && entry.length <= 64)
        .slice(0, 50);
      if (aliases.length === 0) continue;
      synonyms[key.trim()] = aliases;
      count += 1;
    }
    if (Object.keys(synonyms).length > 0) style.synonyms = synonyms;
  }
  return style;
}

export function loadReadingAnswers(root: string): ReadingAnswersLoad {
  const file = path.join(root, "answers.json");
  if (!fs.existsSync(file)) return { answers: [], style: {}, warnings: [] };
  const warnings: FlowWarning[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      answers?: unknown;
      style?: unknown;
    };
    const style = normalizeStyle(parsed.style, warnings);
    if (!Array.isArray(parsed.answers)) {
      return {
        answers: [],
        style,
        warnings: [
          ...warnings,
          { code: "reading-answers-invalid", message: "answers.json 缺 answers 数组" }
        ]
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
    return { answers, style, warnings };
  } catch {
    return {
      answers: [],
      style: {},
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

export function writeReadingAnswers(
  root: string,
  answers: ReadingAnswer[],
  style?: ReadingNamingStyle
): string {
  const file = path.join(root, "answers.json");
  fs.mkdirSync(root, { recursive: true });
  writeFileAtomic(
    file,
    JSON.stringify({ version: 1, ...(style === undefined ? {} : { style }), answers }, null, 2) + "\n"
  );
  return file;
}
