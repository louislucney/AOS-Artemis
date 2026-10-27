import { createHash } from "node:crypto";

import type { FlowWarning } from "../../figma/flows.js";
import type {
  ReadingAnnotation,
  ReadingBBox,
  ReadingChunk,
  ReadingChunkPlan,
  ReadingContentGroup,
  ReadingControl,
  ReadingInteraction,
  ReadingQuestion,
  ReadingScreenObservation,
  ReadingScreenRef,
  ReadingStatus
} from "./types.js";

const STATUSES: ReadingStatus[] = ["observed", "inferred", "unconfirmed"];
const CHROME_RE = /flow\/|(^|\/)(header|remarks?)$|状态栏|狀態欄|备注|備註/i;
const KEY_CONTROL_RE = /搜尋|搜索|search|返回|back|購物袋|cart|tab|確認|結帳|支付|取餐|門市|首頁|訂單狀態/i;

function objectOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseBBox(value: unknown): ReadingBBox | null {
  const record = objectOf(value);
  if (!record) return null;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const x = clamp01(record.x as number);
  const y = clamp01(record.y as number);
  const width = Math.min(clamp01(record.width as number), 1 - x);
  const height = Math.min(clamp01(record.height as number), 1 - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function normalizeStatus(value: unknown): ReadingStatus {
  return typeof value === "string" && (STATUSES as string[]).includes(value)
    ? (value as ReadingStatus)
    : "inferred";
}

function questionId(screenId: string, element: string | null, question: string): string {
  return `q-${createHash("sha256").update(`${screenId}\u0000${element ?? ""}\u0000${question}`).digest("hex").slice(0, 10)}`;
}

function interactionId(fromScreenId: string, element: string, action: string, to: string | null): string {
  return `edge-${createHash("sha256")
    .update(`${fromScreenId}\u0000${element}\u0000${action}\u0000${to ?? ""}`)
    .digest("hex")
    .slice(0, 10)}`;
}

function warning(code: string, message: string, details?: string[]): FlowWarning {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function parseControl(value: unknown, warnings: FlowWarning[]): ReadingControl | null {
  const record = objectOf(value);
  if (!record) {
    warnings.push(warning("reading-control-invalid", "控件不是对象，已丢弃"));
    return null;
  }
  const bbox = parseBBox(record.bbox);
  const kind = stringOf(record.kind) ?? "other";
  if (bbox === null) {
    warnings.push(warning("reading-control-bbox-missing", `控件 ${kind} 缺合法 bbox；保留控件、仅失去几何`));
  }
  return {
    kind,
    label: stringOf(record.label),
    bbox,
    confidence:
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? Math.min(Math.max(record.confidence, 0), 1)
        : null
  };
}

function parseAnnotation(value: unknown, warnings: FlowWarning[]): ReadingAnnotation | null {
  const record = objectOf(value);
  if (!record) {
    warnings.push(warning("reading-annotation-invalid", "标注不是对象，已丢弃"));
    return null;
  }
  const text = stringOf(record.text);
  if (text === null) {
    warnings.push(warning("reading-annotation-invalid", "标注缺 text，已丢弃"));
    return null;
  }
  return {
    text,
    source: stringOf(record.source) ?? "unknown",
    target: stringOf(record.target),
    bbox: parseBBox(record.bbox)
  };
}

function parseContentGroup(value: unknown): ReadingContentGroup | null {
  const record = objectOf(value);
  if (!record) return null;
  const label = stringOf(record.label);
  if (label === null) return null;
  return { label, items: stringArray(record.items) };
}

function ensureQuestion(
  questions: ReadingQuestion[],
  input: {
    screenId: string;
    screenName: string;
    element: string | null;
    question: string;
    why: string;
  }
): void {
  const id = questionId(input.screenId, input.element, input.question);
  if (questions.some((entry) => entry.id === id)) return;
  questions.push({
    id,
    screenId: input.screenId,
    screenName: input.screenName,
    element: input.element,
    question: input.question,
    why: input.why
  });
}

function parseQuestion(
  value: unknown,
  plan: ReadingChunkPlan,
  warnings: FlowWarning[]
): ReadingQuestion | null {
  const record = objectOf(value);
  if (!record) return null;
  const screenId = stringOf(record.screenId);
  const question = stringOf(record.question);
  if (screenId === null || question === null) {
    warnings.push(warning("reading-question-invalid", "question 缺 screenId/question，已丢弃"));
    return null;
  }
  const screen = plan.screens.find((entry) => entry.id === screenId);
  if (!screen) {
    warnings.push(warning("reading-question-unknown-screen", `question 指向块外屏幕 ${screenId}，已丢弃`));
    return null;
  }
  return {
    id: stringOf(record.id) ?? questionId(screenId, stringOf(record.element), question),
    screenId,
    screenName: screen.name,
    element: stringOf(record.element),
    question,
    why: stringOf(record.why) ?? "",
    ...(Array.isArray(record.options) ? { options: stringArray(record.options) } : {})
  };
}

function parseScreen(
  value: unknown,
  plan: ReadingChunkPlan,
  warnings: FlowWarning[]
): ReadingScreenObservation | null {
  const record = objectOf(value);
  if (!record) {
    warnings.push(warning("reading-screen-invalid", "屏幕不是对象，已丢弃"));
    return null;
  }
  const screenId = stringOf(record.screenId);
  const screen = plan.screens.find((entry) => entry.id === screenId);
  if (screenId === null || !screen) {
    warnings.push(warning("reading-screen-unknown", `屏幕 ${screenId ?? "?"} 不在本块，已丢弃`));
    return null;
  }
  const observed = objectOf(record.observed);
  if (!observed) {
    warnings.push(warning("reading-screen-invalid", `屏幕 ${screenId} 缺 observed，已丢弃`));
    return null;
  }
  const requiredArrays = ["headerControls", "contentGroups", "floatingActions", "annotations"];
  for (const key of requiredArrays) {
    if (!Array.isArray(observed[key])) {
      warnings.push(warning("reading-screen-invalid", `屏幕 ${screenId} 缺 ${key} 数组，已丢弃`));
      return null;
    }
  }
  if (objectOf(observed.persistentNav) === null) {
    warnings.push(warning("reading-screen-invalid", `屏幕 ${screenId} 缺 persistentNav 对象，已丢弃`));
    return null;
  }
  const headerControls = (observed.headerControls as unknown[])
    .map((entry) => parseControl(entry, warnings))
    .filter((entry): entry is ReadingControl => entry !== null);
  const floatingActions = (observed.floatingActions as unknown[])
    .map((entry) => parseControl(entry, warnings))
    .filter((entry): entry is ReadingControl => entry !== null);
  const annotations = (observed.annotations as unknown[])
    .map((entry) => parseAnnotation(entry, warnings))
    .filter((entry): entry is ReadingAnnotation => entry !== null);
  const contentGroups = (observed.contentGroups as unknown[])
    .map(parseContentGroup)
    .filter((entry): entry is ReadingContentGroup => entry !== null);
  const nav = objectOf(observed.persistentNav);
  const title = stringOf(observed.title);
  if (
    title !== null &&
    CHROME_RE.test(title)
  ) {
    warnings.push(warning("chrome-suspect", `屏幕 ${screenId} 的标题像设计 chrome：${title}`));
  }
  for (const control of [...headerControls, ...floatingActions]) {
    if (control.label !== null && CHROME_RE.test(control.label)) {
      warnings.push(warning("chrome-suspect", `屏幕 ${screenId} 的控件标签像 chrome：${control.label}`));
    }
  }
  return {
    screenId,
    name: stringOf(record.name) ?? screen.name,
    boardLabel: stringOf(record.boardLabel) ?? stringOf(observed.boardLabel),
    stateLabel: stringOf(record.stateLabel) ?? stringOf(observed.stateLabel),
    title,
    headerControls,
    persistentNav: {
      sideNav: nav ? stringArray(nav.sideNav) : [],
      bottomTabs: nav ? stringArray(nav.bottomTabs) : [],
      activeTab: nav ? stringOf(nav.activeTab) : null
    },
    contentGroups,
    floatingActions,
    annotations,
    states: []
  };
}

function normalizeTarget(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』()（）【】<>《》，,。.;；:：!！?？/\\|_-]+/g, "")
    .replace(/頁面|页面|頁|页|tab|按鈕|按钮|圖示|图标|入口/g, "");
}

function resolveTargetScreen(
  raw: string | null,
  knownScreens: ReadingScreenRef[]
): string | null {
  if (raw === null) return null;
  const exact =
    knownScreens.find((screen) => screen.id === raw)?.id ??
    knownScreens.find((screen) => screen.name === raw)?.id;
  if (exact !== undefined) return exact;
  const normalized = normalizeTarget(raw);
  if (normalized.length < 2) return null;
  const candidates = knownScreens.filter((screen) => {
    const name = normalizeTarget(screen.name);
    return name.length >= 2 && (normalized.includes(name) || name.includes(normalized));
  });
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function parseInferredInteraction(
  value: unknown,
  screen: ReadingScreenObservation,
  plan: ReadingChunkPlan,
  knownScreens: ReadingScreenRef[],
  warnings: FlowWarning[],
  questions: ReadingQuestion[]
): ReadingInteraction | null {
  const record = objectOf(value);
  if (!record) return null;
  const element = stringOf(record.element);
  if (element === null) {
    warnings.push(warning("reading-interaction-invalid", `屏幕 ${screen.screenId} 的交互缺 element，已丢弃`));
    return null;
  }
  const status = normalizeStatus(record.status);
  const action = stringOf(record.action) ?? "tap";
  const rawTo = stringOf(record.toScreenId) ?? stringOf(record.to);
  const resolved = resolveTargetScreen(rawTo, knownScreens);
  const knownTarget = resolved !== null;
  const toScreenId = resolved;
  const toLabel = knownTarget ? null : (stringOf(record.toLabel) ?? rawTo);
  if (!knownTarget && status === "observed") {
    warnings.push(warning("reading-interaction-unconfirmed", `屏幕 ${screen.screenId} 的 observed 交互目标无法解析，已降为 unconfirmed`));
  }
  const effectiveStatus: ReadingStatus = !knownTarget ? "unconfirmed" : status;
  if (effectiveStatus === "unconfirmed" && (rawTo !== null || KEY_CONTROL_RE.test(element))) {
    ensureQuestion(questions, {
      screenId: screen.screenId,
      screenName: screen.name,
      element,
      question: `「${element}」的目标页面/状态是什么？`,
      why: stringOf(record.why) ?? "目标不在本块屏幕集内"
    });
  }
  return {
    id: interactionId(screen.screenId, element, action, toScreenId ?? toLabel),
    fromScreenId: screen.screenId,
    fromElement: element,
    action,
    toScreenId,
    toLabel,
    status: effectiveStatus,
    basis: stringOf(record.basis) ?? "unknown",
    confidence:
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? Math.min(Math.max(record.confidence, 0), 1)
        : null,
    why: stringOf(record.why)
  };
}

export function parseReadingReply(
  content: string,
  plan: ReadingChunkPlan,
  knownScreens: ReadingScreenRef[] = plan.screens
): { chunk: ReadingChunk | null; invalid: number; warnings: FlowWarning[] } {
  const parsed = extractJsonObject(content);
  const root = objectOf(parsed);
  if (!root || !Array.isArray(root.screens)) {
    return {
      chunk: null,
      invalid: 1,
      warnings: [warning("reading-json-invalid", "阅读结果不是合法 JSON 或缺 screens 数组")]
    };
  }
  const warnings: FlowWarning[] = [];
  const questions: ReadingQuestion[] = [];
  const screens = (root.screens as unknown[])
    .map((entry) => parseScreen(entry, plan, warnings))
    .filter((entry): entry is ReadingScreenObservation => entry !== null);
  const screenIds = screens.map((entry) => entry.screenId);
  const interactions: ReadingInteraction[] = [];
  // Inferred interactions are parsed from the raw screen objects (they carry a
  // different shape than the normalized observation).
  for (const rawScreen of root.screens as unknown[]) {
    const record = objectOf(rawScreen);
    if (!record) continue;
    const normalized = screens.find((entry) => entry.screenId === stringOf(record.screenId));
    if (!normalized) continue;
    const inferred = Array.isArray(record.inferredInteractions) ? record.inferredInteractions : [];
    for (const entry of inferred) {
      const parsedInteraction = parseInferredInteraction(
        entry,
        normalized,
        plan,
        knownScreens,
        warnings,
        questions
      );
      if (parsedInteraction) interactions.push(parsedInteraction);
    }
  }
  if (Array.isArray(root.crossScreenLinks)) {
    for (const raw of root.crossScreenLinks as unknown[]) {
      const record = objectOf(raw);
      if (!record) continue;
      const fromScreenId = stringOf(record.fromScreenId);
      const fromElement = stringOf(record.fromElement);
      const screen = screens.find((entry) => entry.screenId === fromScreenId);
      if (fromScreenId === null || !screen || fromElement === null) {
        warnings.push(warning("reading-interaction-invalid", "crossScreenLink 源屏/元素无效，已丢弃"));
        continue;
      }
      const status = normalizeStatus(record.status);
      const rawTo = stringOf(record.toScreenId) ?? stringOf(record.to);
      const resolved = resolveTargetScreen(rawTo, knownScreens);
      const knownTarget = resolved !== null;
      const effectiveStatus: ReadingStatus = !knownTarget ? "unconfirmed" : status;
      if (effectiveStatus === "unconfirmed") {
        ensureQuestion(questions, {
          screenId: fromScreenId,
          screenName: screen.name,
          element: fromElement,
          question: `「${fromElement}」的目标页面/状态是什么？`,
          why: stringOf(record.why) ?? "目标不在本块屏幕集内"
        });
      }
      interactions.push({
        id: interactionId(fromScreenId, fromElement, stringOf(record.action) ?? "tap", resolved),
        fromScreenId,
        fromElement,
        action: stringOf(record.action) ?? "tap",
        toScreenId: resolved,
        toLabel: knownTarget ? null : (stringOf(record.toLabel) ?? rawTo),
        status: effectiveStatus,
        basis: stringOf(record.basis) ?? "unknown",
        confidence: null,
        why: stringOf(record.why)
      });
    }
  }
  if (Array.isArray(root.questions)) {
    for (const raw of root.questions as unknown[]) {
      const question = parseQuestion(raw, plan, warnings);
      if (question) questions.push(question);
    }
  }
  const uniqueQuestions = [...new Map(questions.map((entry) => [entry.id, entry])).values()];
  const droppedScreens = plan.screens.map((screen) => screen.id).filter((id) => !screenIds.includes(id));
  return {
    chunk: {
      chunkId: plan.chunkId,
      cacheKey: "",
      plannedScreenIds: plan.screens.map((screen) => screen.id),
      screenIds,
      screens,
      interactions,
      questions: uniqueQuestions,
      droppedScreens,
      unreadScreens: droppedScreens,
      calls: 1,
      warnings
    },
    invalid: warnings.filter((entry) => entry.code === "reading-screen-invalid").length,
    warnings
  };
}
