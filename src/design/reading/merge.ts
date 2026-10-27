import { createHash } from "node:crypto";

import type { FlowEdge } from "../../figma/flows.js";
import {
  answerMatchesInteraction,
  answerMatchesQuestion,
  applyAnswerToScreen
} from "./answers.js";
import { isGenericLabel, type ReadingNamingStyle } from "./naming.js";
import type {
  ReadingAnswer,
  ReadingChunk,
  ReadingCompleteness,
  ReadingFile,
  ReadingInteraction,
  ReadingQuestion,
  ReadingScreenObservation,
  ReadingScreenRef,
  ReadingSpine,
  ReadingStats,
  ReadingStatus
} from "./types.js";

const SEARCH_TEXT_RE = /搜尋|搜索|search|検索|검색/i;
const KEY_QUESTION_RE = /搜尋|搜索|search|検索|검색|返回|back|戻る|뒤로|購物袋|购物袋|购物车|cart|bag|カート|장바구니|tab|タブ|탭|確認|确认|結帳|结账|checkout|confirm|支払|결제|支付|取餐|pickup|受け取り|픽업|門市|门市|门店|store|店舗|매장|首頁|首页|home|ホーム|홈|訂單狀態|订单状态|order status|注文状況|주문 상태/i;
const STATUS_RANK: Record<ReadingStatus, number> = {
  observed: 2,
  inferred: 1,
  unconfirmed: 0
};

function statusOf(value: ReadingStatus): ReadingStatus {
  return value;
}

function normalizedScreen(screen: ReadingScreenObservation): string {
  return JSON.stringify({
    title: screen.title,
    header: screen.headerControls.map((control) => [
      control.kind,
      control.label,
      control.bbox === null ? null : Math.round(control.bbox.x * 1000),
      control.bbox === null ? null : Math.round(control.bbox.y * 1000),
      control.bbox === null ? null : Math.round(control.bbox.width * 1000),
      control.bbox === null ? null : Math.round(control.bbox.height * 1000)
    ]),
    nav: screen.persistentNav
  });
}

function interactionKey(edge: ReadingInteraction): string {
  return [
    edge.fromScreenId,
    edge.fromElement,
    edge.action,
    edge.toScreenId ?? `label:${edge.toLabel ?? ""}`
  ].join("\u0000");
}

function questionKey(question: ReadingQuestion): string {
  return `${question.screenId}\u0000${question.element ?? ""}\u0000${question.question.trim()}`;
}

function questionPriority(question: ReadingQuestion): number {
  const text = `${question.element ?? ""} ${question.question} ${question.why}`;
  if (/annotation|标注|標註|註記|注記|連接|连接|线起点|線起點|コメント|주석/i.test(text)) return 0;
  if (/搜尋|搜索|search|検索|검색|返回|back|戻る|뒤로|購物袋|购物袋|购物车|cart|bag|カート|장바구니|結帳|结账|checkout|支付|取餐|pickup|受け取り|픽업|門市|门市|门店|store|店舗|매장|tab|タブ|탭/i.test(text)) return 1;
  return 2;
}

function questionFor(
  questions: ReadingQuestion[],
  input: {
    screenId: string;
    screenName: string;
    element: string | null;
    question: string;
    why: string;
  }
): void {
  const id = `q-${createHash("sha256")
    .update(`${input.screenId}\u0000${input.element ?? ""}\u0000${input.question}`)
    .digest("hex")
    .slice(0, 10)}`;
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

function fallbackBoardLabel(
  screen: ReadingScreenObservation,
  ref: ReadingScreenRef | undefined
): string | null {
  const candidates = [screen.boardLabel, ref?.name, ref?.sourceFrameName];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && !isGenericLabel(candidate)) return candidate;
  }
  return null;
}

function mergeScreens(
  chunks: ReadingChunk[],
  screens: ReadingScreenRef[],
  questions: ReadingQuestion[]
): { screens: ReadingScreenObservation[]; conflicts: number; overlapConflicts: number } {
  const byId = new Map<string, ReadingScreenObservation>();
  const seen = new Map<string, ReadingScreenObservation>();
  let conflicts = 0;
  let overlapConflicts = 0;
  const nameOf = new Map(screens.map((screen) => [screen.id, screen.name]));
  const statesOf = new Map(screens.map((screen) => [screen.id, screen.states ?? []]));
  const refOf = new Map(screens.map((screen) => [screen.id, screen]));
  for (const chunk of chunks) {
    for (const screen of chunk.screens) {
      const prior = seen.get(screen.screenId);
      const ref = refOf.get(screen.screenId);
      if (prior === undefined) {
        const knownStates = statesOf.get(screen.screenId) ?? [];
        const modelBoardLabel =
          screen.boardLabel !== null &&
          screen.boardLabel !== undefined &&
          !isGenericLabel(screen.boardLabel)
            ? screen.boardLabel
            : null;
        const boardLabel =
          modelBoardLabel ?? (ref?.kind === "state" ? fallbackBoardLabel(screen, ref) : null);
        const resolved = {
          ...screen,
          ...(nameOf.has(screen.screenId) ? { name: nameOf.get(screen.screenId)! } : {}),
          ...(ref === undefined
            ? {}
            : {
                boardLabel,
                kind: ref.kind ?? screen.kind ?? "screen",
                ...(ref.parentScreenId === undefined
                  ? {}
                  : { parentScreenId: ref.parentScreenId }),
                ...(ref.stateLabel === undefined
                  ? {}
                  : { stateLabel: screen.stateLabel ?? ref.stateLabel })
              }),
          ...(knownStates.length > 0 ? { knownStates } : {})
        };
        seen.set(screen.screenId, resolved);
        byId.set(screen.screenId, resolved);
        continue;
      }
      if (
        (prior.boardLabel === null || prior.boardLabel === undefined) &&
        screen.boardLabel !== null &&
        screen.boardLabel !== undefined &&
        !isGenericLabel(screen.boardLabel)
      ) {
        prior.boardLabel = screen.boardLabel;
      }
      if (
        (prior.stateLabel === null || prior.stateLabel === undefined) &&
        screen.stateLabel !== null &&
        screen.stateLabel !== undefined
      ) {
        prior.stateLabel = screen.stateLabel;
      }
      const knownStates = statesOf.get(screen.screenId) ?? [];
      if (
        knownStates.length > 0 &&
        (prior.knownStates === undefined || prior.knownStates.length === 0)
      ) {
        prior.knownStates = knownStates;
      }
      if (ref !== undefined) {
        if (prior.boardLabel === null || prior.boardLabel === undefined) {
          prior.boardLabel = fallbackBoardLabel(prior, ref);
        }
        if (prior.kind === undefined) prior.kind = ref.kind ?? "screen";
        if (prior.parentScreenId === undefined && ref.parentScreenId !== undefined) {
          prior.parentScreenId = ref.parentScreenId;
        }
        if (
          (prior.stateLabel === null || prior.stateLabel === undefined) &&
          ref.stateLabel !== undefined
        ) {
          prior.stateLabel = ref.stateLabel;
        }
      }
      if (normalizedScreen(prior) !== normalizedScreen(screen)) {
        overlapConflicts += 1;
        conflicts += 1;
        prior.alternatives = [...(prior.alternatives ?? []), screen];
        questionFor(questions, {
          screenId: screen.screenId,
          screenName: nameOf.get(screen.screenId) ?? screen.name,
          element: null,
          question: `同一屏在相邻块读到的结构不一致（${screen.screenId}），以哪次为准？`,
          why: "overlap 一致性检查：两次阅读的 title/headerControls/persistentNav 不同"
        });
      }
    }
  }
  for (const screen of byId.values()) {
    const ref = refOf.get(screen.screenId);
    if (ref === undefined) continue;
    if (screen.boardLabel === null || screen.boardLabel === undefined) {
      screen.boardLabel = fallbackBoardLabel(screen, ref);
    }
    if (screen.kind === undefined) screen.kind = ref.kind ?? "screen";
    if (screen.parentScreenId === undefined && ref.parentScreenId !== undefined) {
      screen.parentScreenId = ref.parentScreenId;
    }
    if (
      (screen.stateLabel === null || screen.stateLabel === undefined) &&
      ref.stateLabel !== undefined
    ) {
      screen.stateLabel = ref.stateLabel;
    }
  }
  return { screens: [...byId.values()], conflicts, overlapConflicts };
}

function addInteraction(
  map: Map<string, ReadingInteraction>,
  bySource: Map<string, ReadingInteraction>,
  edge: ReadingInteraction,
  screenIds: Set<string>,
  screenNames: Map<string, string>,
  questions: ReadingQuestion[]
): void {
  let effective = edge;
  if (edge.toScreenId !== null && !screenIds.has(edge.toScreenId)) {
    effective = { ...edge, status: "unconfirmed", toScreenId: null, toLabel: edge.toLabel ?? edge.toScreenId };
    questionFor(questions, {
      screenId: edge.fromScreenId,
      screenName: screenNames.get(edge.fromScreenId) ?? edge.fromScreenId,
      element: edge.fromElement,
      question: `「${edge.fromElement}」的目标屏 ${edge.toScreenId} 不在全局屏集，实际是哪个？`,
      why: "端点机械校验：目标屏不存在，不能当 observed"
    });
  }
  if (!screenIds.has(effective.fromScreenId)) return;
  if (effective.toScreenId === null && effective.toLabel !== null) {
    const raw = effective.toLabel;
    const normalized = raw.toLowerCase().replace(/[\s"'“”‘’「」『』()（）【】<>《》，,。.;；:：!！?？/\\|_-]+/g, "");
    const candidates = [...screenNames.entries()].filter(([, name]) => {
      const target = name.toLowerCase().replace(/[\s"'“”‘’「」『』()（）【】<>《》，,。.;；:：!！?？/\\|_-]+/g, "");
      return target.length >= 2 && (normalized.includes(target) || target.includes(normalized));
    });
    if (candidates.length === 1) {
      effective = {
        ...effective,
        toScreenId: candidates[0]![0],
        toLabel: null,
        status: effective.status === "unconfirmed" ? "inferred" : effective.status,
        basis: `${effective.basis}+resolved-target`
      };
    }
  }
  const sourceKey = `${effective.fromScreenId}\u0000${effective.fromElement}\u0000${effective.action}`;
  const targetOf = (entry: ReadingInteraction): string =>
    entry.toScreenId ?? `label:${entry.toLabel ?? ""}`;
  const sameSource = bySource.get(sourceKey);
  if (sameSource !== undefined && targetOf(sameSource) !== targetOf(effective)) {
    questionFor(questions, {
      screenId: effective.fromScreenId,
      screenName: screenNames.get(effective.fromScreenId) ?? effective.fromScreenId,
      element: effective.fromElement,
      question: `「${effective.fromElement}」出现两个目标（${sameSource.toScreenId ?? sameSource.toLabel ?? "未知"} / ${effective.toScreenId ?? effective.toLabel ?? "未知"}），以哪个为准？`,
      why: "同一来源的交互目标冲突"
    });
  }
  const key = interactionKey(effective);
  const prior = map.get(key);
  if (prior === undefined) {
    map.set(key, effective);
    if (sameSource === undefined || STATUS_RANK[effective.status] >= STATUS_RANK[sameSource.status]) {
      bySource.set(sourceKey, effective);
    }
    return;
  }
  if (STATUS_RANK[effective.status] > STATUS_RANK[prior.status]) {
    map.set(key, effective);
    if (sameSource === undefined || STATUS_RANK[effective.status] >= STATUS_RANK[sameSource.status]) {
      bySource.set(sourceKey, effective);
    }
  }
}

function knownEdgesAsInteractions(edges: FlowEdge[]): ReadingInteraction[] {
  return edges
    .filter((edge) => edge.to !== null)
    .map((edge) => {
      const canvasOrder = /推断跳转|按画板排布/.test(edge.element.name);
      return {
        id: `edge-prototype-${edge.from.id}-${edge.element.id}-${edge.to!.id}`,
        fromScreenId: edge.from.id,
        fromElement: edge.element.name,
        action: edge.trigger || edge.actionType || "tap",
        toScreenId: edge.to!.id,
        toLabel: null,
        status:
          edge.provenance === "explicit" ||
          edge.provenance === "human-confirmed" ||
          edge.provenance === "runtime-observed"
            ? ("observed" as const)
            : edge.provenance === "inferred" || edge.provenance === "vision-inferred"
              ? ("inferred" as const)
              : ("unconfirmed" as const),
        basis: canvasOrder
          ? "canvas-order"
          : edge.provenance === "explicit"
            ? "prototype-edge"
            : "flow-edge",
        confidence: canvasOrder ? 0.3 : 1,
        why: canvasOrder ? "按画板排布推断，不代表真实控件跳转" : null
      };
    });
}

function buildSpine(
  screens: ReadingScreenObservation[],
  edges: ReadingInteraction[],
  screenNames: Map<string, string>
): ReadingSpine | null {
  const mainScreens = screens.filter((screen) => screen.kind !== "state");
  const activeScreens = mainScreens.length > 0 ? mainScreens : screens;
  if (activeScreens.length === 0) return null;
  const screenIds = new Set(activeScreens.map((screen) => screen.screenId));
  const outgoing = new Map<string, ReadingInteraction[]>();
  for (const edge of edges) {
    if (!screenIds.has(edge.fromScreenId)) continue;
    if (edge.toScreenId === null || !screenIds.has(edge.toScreenId)) continue;
    const list = outgoing.get(edge.fromScreenId) ?? [];
    list.push(edge);
    outgoing.set(edge.fromScreenId, list);
  }
  const incoming = new Set(
    edges.map((edge) => edge.toScreenId).filter((id): id is string => id !== null && screenIds.has(id))
  );
  const entries = activeScreens.map((screen) => screen.screenId).filter((id) => !incoming.has(id));
  const starts = entries.length > 0 ? entries : activeScreens.map((screen) => screen.screenId);
  const maxVisits = 5000;
  let visits = 0;
  let bounded = false;
  let best: string[] = [];
  let bestEdges: ReadingInteraction[] = [];
  const visit = (id: string, path: string[], used: ReadingInteraction[], seen: Set<string>): void => {
    if (visits >= maxVisits) {
      bounded = true;
      return;
    }
    visits += 1;
    if (path.length > best.length) {
      best = [...path];
      bestEdges = [...used];
    }
    for (const edge of outgoing.get(id) ?? []) {
      const next = edge.toScreenId;
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      path.push(next);
      used.push(edge);
      visit(next, path, used, seen);
      used.pop();
      path.pop();
      seen.delete(next);
    }
  };
  for (const start of starts) {
    visit(start, [start], [], new Set([start]));
  }
  if (best.length === 0) best = [activeScreens[0]!.screenId];
  const statusSummary: Record<ReadingStatus, number> = { observed: 0, inferred: 0, unconfirmed: 0 };
  for (const edge of bestEdges) statusSummary[statusOf(edge.status)] += 1;
  const status: ReadingStatus =
    activeScreens.length < 3
      ? "unconfirmed"
      : statusSummary.unconfirmed > 0
        ? "unconfirmed"
        : statusSummary.inferred > 0
          ? "inferred"
          : bestEdges.length > 0
            ? "observed"
            : "unconfirmed";
  const basis = [
    entries.length > 0 ? "entry" : "fallback-all",
    "longest-path",
    ...(bounded ? ["bounded-search"] : []),
    ...(bestEdges.length === 0 ? ["no-edges"] : [])
  ];
  return {
    title:
      best.length === 1
        ? screenNames.get(best[0]!) ?? best[0]!
        : `${screenNames.get(best[0]!) ?? best[0]} → … → ${
            screenNames.get(best[best.length - 1]!) ?? best[best.length - 1]
          }`,
    summary: `主线候选：${best.map((id) => screenNames.get(id) ?? id).join(" → ")}`,
    screenIds: best,
    edgeIds: bestEdges.map((edge) => edge.id),
    statusSummary,
    status,
    basis,
    confidence: bestEdges.length === 0 ? null : 0.5
  };
}

export function mergeReadingChunks(
  chunks: ReadingChunk[],
  input: {
    screens: ReadingScreenRef[];
    knownEdges: FlowEdge[];
    source: string;
    orderSource?: "flows" | "canvas" | "unknown";
    flowsFingerprint?: string;
    screensFingerprint?: string;
    model: string;
    chunkSize: number;
    overlap: number;
    generatedAt: string;
    truncatedScreens?: string[];
    stats?: ReadingStats;
    answers?: ReadingAnswer[];
    namingStyle?: ReadingNamingStyle;
  }
): ReadingFile {
  const warnings = chunks.flatMap((chunk) => chunk.warnings);
  const answers = input.answers ?? [];
  const questions: ReadingQuestion[] = [];
  for (const question of chunks.flatMap((chunk) => chunk.questions)) {
    const genericUnresolved =
      /目标页面\/状态|目标屏|目标不在本块/.test(question.question) &&
      !KEY_QUESTION_RE.test(question.element ?? "");
    if (genericUnresolved) continue;
    if (!questions.some((entry) => questionKey(entry) === questionKey(question))) {
      questions.push(question);
    }
  }
  const merged = mergeScreens(chunks, input.screens, questions);
  for (const answer of answers) {
    for (let index = 0; index < merged.screens.length; index += 1) {
      const updated = applyAnswerToScreen(answer, merged.screens[index]!);
      if (updated !== null) merged.screens[index] = updated;
    }
  }
  const screenIds = new Set(input.screens.map((screen) => screen.id));
  const screenNames = new Map(input.screens.map((screen) => [screen.id, screen.name]));
  const edges = new Map<string, ReadingInteraction>();
  const bySource = new Map<string, ReadingInteraction>();
  for (const edge of knownEdgesAsInteractions(input.knownEdges)) {
    addInteraction(edges, bySource, edge, screenIds, screenNames, questions);
  }
  for (const chunk of chunks) {
    for (const edge of chunk.interactions) {
      addInteraction(edges, bySource, edge, screenIds, screenNames, questions);
    }
  }
  let interactions = [...edges.values()];
  for (const answer of answers) {
    const resolution = answer.resolution;
    if (resolution === undefined) continue;
    interactions = interactions.flatMap((edge) => {
      if (!answerMatchesInteraction(answer, edge, input.namingStyle)) return [edge];
      if (resolution.dropInteraction === true) return [];
      const toScreenId =
        resolution.toScreenId === "self"
          ? edge.fromScreenId
          : resolution.toScreenId === undefined
            ? edge.toScreenId
            : resolution.toScreenId;
      return [{
        ...edge,
        ...(resolution.action === undefined ? {} : { action: resolution.action }),
        toScreenId,
        toLabel: resolution.toLabel === undefined ? edge.toLabel : resolution.toLabel,
        status: "observed" as const,
        basis: `human-answer:${answer.id}`,
        confidence: 1
      }];
    });
  }
  // 搜索入口漏识别：旁注/分组出现“搜尋/搜索”，但 header 没有 search。
  for (const screen of merged.screens) {
    const mentionsSearch =
      screen.annotations.some((annotation) => SEARCH_TEXT_RE.test(annotation.text)) ||
      screen.contentGroups.some((group) => SEARCH_TEXT_RE.test(group.label));
    const hasSearch = screen.headerControls.some((control) => control.kind === "search");
    if (mentionsSearch && !hasSearch) {
      questionFor(questions, {
        screenId: screen.screenId,
        screenName: screen.name,
        element: "search",
        question: "旁注/文案出现“搜尋/搜索”，但 header 控件清单没有 search；是否存在漏识别的搜索入口？",
        why: "搜索入口漏识别检查（regex 非穷尽）"
      });
    }
  }
  const uniqueInteractions = new Map<string, ReadingInteraction>();
  for (const edge of interactions) {
    const key = interactionKey(edge);
    const prior = uniqueInteractions.get(key);
    if (
      prior === undefined ||
      STATUS_RANK[edge.status] > STATUS_RANK[prior.status] ||
      (STATUS_RANK[edge.status] === STATUS_RANK[prior.status] &&
        (edge.confidence ?? 0) > (prior.confidence ?? 0))
    ) {
      uniqueInteractions.set(key, edge);
    }
  }
  const usedIds = new Set<string>();
  interactions = [...uniqueInteractions.values()].map((edge) => {
    if (!usedIds.has(edge.id)) {
      usedIds.add(edge.id);
      return edge;
    }
    let suffix = 2;
    while (usedIds.has(`${edge.id}-alt${suffix}`)) suffix += 1;
    const id = `${edge.id}-alt${suffix}`;
    usedIds.add(id);
    return { ...edge, id };
  });
  const spine = buildSpine(merged.screens, interactions, screenNames);
  const answeredKeys = new Set<string>();
  const unanswered: ReadingQuestion[] = [];
  for (const question of questions) {
    if (answers.some((answer) => answerMatchesQuestion(answer, question, input.namingStyle))) {
      answeredKeys.add(questionKey(question));
    } else {
      unanswered.push(question);
    }
  }
  const unreadScreens = [...new Set(chunks.flatMap((chunk) => chunk.unreadScreens))];
  const droppedScreens = [...new Set(chunks.flatMap((chunk) => chunk.droppedScreens))];
  const truncatedScreens = input.truncatedScreens ?? [];
  const screensRead = new Set(chunks.flatMap((chunk) => chunk.screenIds));
  const orphanScreens = input.screens
    .map((screen) => screen.id)
    .filter(
      (id) =>
        !screensRead.has(id) &&
        !(spine?.screenIds.includes(id) ?? false) &&
        !interactions.some((edge) => edge.fromScreenId === id || edge.toScreenId === id)
    );
  const uniqueQuestions = [...new Map(unanswered.map((entry) => [questionKey(entry), entry])).values()];
  const prioritizedQuestions = uniqueQuestions
    .sort((left, right) => {
      const priority = questionPriority(left) - questionPriority(right);
      if (priority !== 0) return priority;
      const screen = left.screenId.localeCompare(right.screenId);
      return screen !== 0 ? screen : left.question.localeCompare(right.question);
    });
  const maxQuestions = 20;
  const keptQuestions = prioritizedQuestions.slice(0, maxQuestions);
  const questionsTotal = prioritizedQuestions.length;
  const questionsOmitted = Math.max(0, questionsTotal - keptQuestions.length);
  const completeness: ReadingCompleteness = {
    screens: input.screens.length,
    observedScreens: merged.screens.length,
    screensRead: screensRead.size,
    screensTotal: input.screens.length,
    failedScreens: input.screens.length - screensRead.size,
    unreadScreens,
    droppedScreens,
    truncatedScreens,
    orphanScreens,
    unresolvedEdges: interactions.filter((edge) => edge.toScreenId === null).length,
    unconfirmedEdges: interactions.filter((edge) => edge.status === "unconfirmed").length,
    overlapConflicts: merged.overlapConflicts,
    conflicts: merged.conflicts,
    headerCoverage: merged.screens.filter((screen) => screen.headerControls.length > 0).length,
    bottomNavCoverage: merged.screens.filter((screen) => screen.persistentNav.bottomTabs.length > 0).length,
    annotationScreens: merged.screens.filter((screen) => screen.annotations.length > 0).length,
    questionsTotal,
    questionsOmitted,
    questionsAnswered: answeredKeys.size
  };
  const computedStats: ReadingStats = {
    chunksRequested: chunks.length,
    chunksProcessed: chunks.filter((chunk) => chunk.screenIds.length > 0).length,
    chunksReused: 0,
    chunksFailed: chunks.filter((chunk) => chunk.screenIds.length === 0).length,
    calls: chunks.reduce((sum, chunk) => sum + chunk.calls, 0),
    screens: input.screens.length,
    screensRead: screensRead.size,
    screensTotal: input.screens.length,
    droppedScreens,
    truncatedScreens,
    observed: interactions.filter((edge) => edge.status === "observed").length,
    inferred: interactions.filter((edge) => edge.status === "inferred").length,
    unconfirmed: interactions.filter((edge) => edge.status === "unconfirmed").length
  };
  const stats: ReadingStats = {
    ...computedStats,
    ...(input.stats ?? {}),
    observed: interactions.filter((edge) => edge.status === "observed").length,
    inferred: interactions.filter((edge) => edge.status === "inferred").length,
    unconfirmed: interactions.filter((edge) => edge.status === "unconfirmed").length
  };
  return {
    schemaVersion: 1,
    source: input.source,
    orderSource: input.orderSource ?? "unknown",
    flowsFingerprint: input.flowsFingerprint ?? "",
    screensFingerprint: input.screensFingerprint ?? "",
    generatedAt: input.generatedAt,
    model: input.model,
    chunkSize: input.chunkSize,
    overlap: input.overlap,
    screens: merged.screens,
    interactions,
    spine,
    questions: keptQuestions,
    ...(answers.length > 0 ? { answers } : {}),
    completeness,
    stats,
    warnings
  };
}
