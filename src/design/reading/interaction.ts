export interface InteractionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InteractionGeometry =
  | {
      kind: "exact";
      box: InteractionBox;
      space: "design-px";
      absolute: true;
    }
  | { kind: "missing"; reason: "no-bbox" | "auto-layout" | "clipped" };

export interface InteractionNode {
  id: string;
  name: string;
  text: string | null;
  geometry: InteractionGeometry;
  children: InteractionNode[];
}

export interface InteractionViewport {
  width: number;
  height: number;
}

export type InteractionFrameKind =
  | "viewport-state"
  | "full-content"
  | "overlay"
  | "component";

export interface InteractionFrame {
  id: string;
  name: string;
  boardId: string | null;
  parentId: string | null;
  rendered: { width: number; height: number };
  viewport: InteractionViewport;
  nodes: InteractionNode[];
}

export type InteractionProvenance =
  | {
      kind: "inferred";
      basis: "structural" | "visual" | "naming";
      score: number;
    }
  | { kind: "observed"; evidence: string[] }
  | { kind: "confirmed"; answerId: string; evidence: string[] }
  | { kind: "unconfirmed"; questionId: string };

export interface InteractionNodeRef {
  id: string;
  name: string;
  text: string | null;
  origin?: "persistent" | "takeover";
  region?: "header" | "content" | "footer";
}

export interface InteractionPairing {
  track: "structural";
  score: number;
  matchedTexts: number;
  support: number;
  offset: number;
  deltaMode: number | null;
  contentDiff: number;
  visualAtOffset: number | null;
}

export interface InteractionPairingBands {
  minMatchedTexts: number;
  minScrollDelta: number;
  minSupport: number;
  stateDeltaMax: number;
  contentDiffStateChange: number;
  contentDiffDuplicate: number;
  contentDiffStateMax: number;
  visualNccScroll: number;
  visualNccFamily: number;
  takeoverSimilarity: number;
}

export const DEFAULT_PAIRING_BANDS: InteractionPairingBands = {
  minMatchedTexts: 8,
  minScrollDelta: 50,
  minSupport: 0.8,
  stateDeltaMax: 8,
  contentDiffStateChange: 0.1,
  contentDiffDuplicate: 0.05,
  contentDiffStateMax: 0.3,
  visualNccScroll: 0.65,
  visualNccFamily: 0.9,
  takeoverSimilarity: 0.8
};

export interface InteractionQuestion {
  id: string;
  kind: "state-change-weak";
  frameIds: [string, string];
  message: string;
}

export type InteractionCandidate =
  | {
      kind: "scroll-collapse";
      beforeFrameId: string;
      afterFrameId: string;
      pairing: InteractionPairing;
      delta: { designPx: number; devicePoints: number | null };
      sticky: InteractionNodeRef[];
      collapsed: InteractionNodeRef[];
      titleTakeover: { bar: InteractionNodeRef; from: InteractionNodeRef } | null;
      provenance: InteractionProvenance;
      evidence: string[];
    }
  | {
      kind: "state-change";
      beforeFrameId: string;
      afterFrameId: string;
      pairing: InteractionPairing;
      changed: InteractionNodeRef[];
      provenance: InteractionProvenance;
      evidence: string[];
    };

export interface InteractionPairingStats {
  frames: number;
  viewportStates: number;
  fullContent: number;
  overlays: number;
  components: number;
  pairsEvaluated: number;
  textOverlap: number;
  crossFamily: number;
  scrollRaw: number;
  scrollCandidates: number;
  stateCandidates: number;
  duplicates: number;
  gray: number;
  questions: number;
  blocked: number;
  deduped: number;
}

export interface InteractionPairResult {
  candidates: InteractionCandidate[];
  questions: InteractionQuestion[];
  stats: InteractionPairingStats;
}

export type VisualSimilarity = (
  aFrameId: string,
  bFrameId: string,
  offset: number
) => number | null;

export interface PairContainersOptions {
  viewport?: InteractionViewport;
  visual?: VisualSimilarity;
  bands?: Partial<InteractionPairingBands>;
  maxStateCandidates?: number;
  maxQuestions?: number;
  requireVisual?: boolean;
}

const GENERIC_TEXTS = new Set([
  "返回",
  "关闭",
  "關閉",
  "确认",
  "確認",
  "取消",
  "首页",
  "首頁",
  "更多",
  "next",
  "back",
  "close",
  "cancel",
  "ok"
]);

export function normalizeTextForSet(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, "")
    .replace(/\p{P}/gu, "")
    .toLowerCase();
}

export function normalizeForMatch(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, "")
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, "<date>")
    .replace(/\d{1,2}:\d{2}/g, "<time>")
    .replace(/[$＄]\s?\d+/g, "<price>")
    .replace(/\d+\s*(元|起|杯|件|點|星)/g, "<count>")
    .replace(/^(早安|午安|晚安|goodmorning|goodafternoon|goodevening).*/i, "<greeting>")
    .toLowerCase()
    .replace(/\p{P}/gu, "");
}

export function classifyFrame(
  rendered: { width: number; height: number },
  viewport: InteractionViewport
): { kind: InteractionFrameKind; overflow: number } {
  const renderedAspect = rendered.width / rendered.height;
  const viewportAspect = viewport.width / viewport.height;
  const widthDiff = Math.abs(rendered.width - viewport.width) / viewport.width;
  if (rendered.width > viewport.width * 1.1) {
    return { kind: "overlay", overflow: 0 };
  }
  if (
    widthDiff <= 0.05 &&
    rendered.height >= viewport.height * 0.9 &&
    rendered.height <= viewport.height * 1.05
  ) {
    return { kind: "viewport-state", overflow: 0 };
  }
  if (rendered.height > viewport.height * 1.05 || renderedAspect > viewportAspect * 1.05) {
    return {
      kind: "full-content",
      overflow: Math.max(0, rendered.height - viewport.height)
    };
  }
  if (rendered.width < viewport.width * 0.9 && rendered.height < viewport.height * 0.9) {
    return { kind: "overlay", overflow: 0 };
  }
  return { kind: "component", overflow: 0 };
}

function walkNodes(nodes: InteractionNode[], visit: (node: InteractionNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkNodes(node.children, visit);
  }
}

function exactBox(node: InteractionNode): InteractionBox | null {
  return node.geometry.kind === "exact" ? node.geometry.box : null;
}

function regionOf(node: InteractionNode, box: InteractionBox, viewportH: number): InteractionNodeRef["region"] {
  if (/app\s*bar|header|nav|system/i.test(node.name) || box.y <= 8) return "header";
  if (box.y + box.height >= viewportH * 0.9) return "footer";
  return "content";
}

function nodeRef(node: InteractionNode, box: InteractionBox, viewportH: number): InteractionNodeRef {
  return {
    id: node.id,
    name: node.name,
    text: node.text,
    region: regionOf(node, box, viewportH)
  };
}

interface TextAnchor {
  node: InteractionNode;
  box: InteractionBox;
  key: string;
}

function textAnchors(frame: InteractionFrame): TextAnchor[] {
  const out: TextAnchor[] = [];
  walkNodes(frame.nodes, (node) => {
    const box = exactBox(node);
    if (box === null || node.text === null || node.text.trim() === "") return;
    out.push({ node, box, key: normalizeForMatch(node.text) });
  });
  return out;
}

function textMap(frame: InteractionFrame): Map<string, TextAnchor> {
  const map = new Map<string, TextAnchor>();
  for (const anchor of textAnchors(frame)) {
    if (!map.has(anchor.key)) map.set(anchor.key, anchor);
  }
  return map;
}

function compareFrames(
  before: InteractionFrame,
  after: InteractionFrame
): {
  matched: number;
  mode: number | null;
  support: number;
  contentDiff: number;
} {
  const beforeMap = textMap(before);
  const afterMap = textMap(after);
  const deltas: number[] = [];
  for (const [key, anchor] of beforeMap) {
    const other = afterMap.get(key);
    if (other !== undefined) deltas.push(anchor.box.y - other.box.y);
  }
  const hist = new Map<number, number>();
  for (const delta of deltas) {
    const rounded = Math.round(delta);
    hist.set(rounded, (hist.get(rounded) ?? 0) + 1);
  }
  const [mode, count] = [...hist.entries()].sort((left, right) => right[1] - left[1])[0] ?? [null, 0];
  const inter = [...beforeMap.keys()].filter((key) => afterMap.has(key)).length;
  const union = new Set([...beforeMap.keys(), ...afterMap.keys()]).size;
  return {
    matched: deltas.length,
    mode,
    support: deltas.length === 0 ? 0 : count / deltas.length,
    contentDiff: union === 0 ? 1 : 1 - inter / union
  };
}

function textSimilarity(left: string, right: string): number {
  const a = normalizeForMatch(left);
  const b = normalizeForMatch(right);
  if (a === "" || b === "") return 0;
  if (a === b) return 1;
  if (GENERIC_TEXTS.has(a) || GENERIC_TEXTS.has(b)) return 0;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp: number[] = Array.from({ length: cols }, (_, index) => index);
  for (let row = 1; row < rows; row++) {
    let previous = dp[0]!;
    dp[0] = row;
    for (let col = 1; col < cols; col++) {
      const current = dp[col]!;
      dp[col] = Math.min(
        dp[col]! + 1,
        dp[col - 1]! + 1,
        previous + (left[row - 1] === right[col - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return dp[cols - 1]!;
}

export function inferScrollCollapse(
  before: InteractionFrame,
  after: InteractionFrame,
  bands: InteractionPairingBands = DEFAULT_PAIRING_BANDS,
  context?: InteractionFrame
): {
  sticky: InteractionNodeRef[];
  collapsed: InteractionNodeRef[];
  titleTakeover: { bar: InteractionNodeRef; from: InteractionNodeRef } | null;
  evidence: string[];
} {
  const afterMap = textMap(after);
  const beforeAnchors = textAnchors(before);
  const takeoverSources = new Set<string>();
  let titleTakeover: { bar: InteractionNodeRef; from: InteractionNodeRef } | null = null;

  const takeoverFrames = [after, ...(context === undefined || context.id === after.id ? [] : [context])];
  for (const takeoverFrame of takeoverFrames) {
    for (const anchor of textAnchors(takeoverFrame)) {
      if (anchor.box.y > 8) continue;
      let best: { anchor: TextAnchor; score: number } | null = null;
      for (const candidate of beforeAnchors) {
        const score = textSimilarity(anchor.node.text ?? "", candidate.node.text ?? "");
        if (score >= bands.takeoverSimilarity && (best === null || score > best.score)) {
          best = { anchor: candidate, score };
        }
      }
      if (best !== null) {
        takeoverSources.add(best.anchor.node.id);
        if (titleTakeover === null && anchor.node.text !== null) {
          titleTakeover = {
            bar: nodeRef(anchor.node, anchor.box, takeoverFrame.viewport.height),
            from: { ...nodeRef(best.anchor.node, best.anchor.box, before.viewport.height), origin: "takeover" }
          };
        }
      }
    }
  }

  const sticky: InteractionNodeRef[] = [];
  const collapsed: InteractionNodeRef[] = [];
  for (const anchor of beforeAnchors) {
    const other = afterMap.get(anchor.key);
    if (other !== undefined && Math.abs(anchor.box.y - other.box.y) <= 8 && other.box.y >= 0) {
      sticky.push({
        ...nodeRef(anchor.node, anchor.box, before.viewport.height),
        origin: "persistent"
      });
      continue;
    }
    if (anchor.box.y >= 0 && anchor.box.y < before.viewport.height) {
      if (other === undefined || other.box.y < 0) {
        collapsed.push(nodeRef(anchor.node, anchor.box, before.viewport.height));
      }
    }
  }

  return {
    sticky,
    collapsed,
    titleTakeover,
    evidence: [
      `matched ${beforeAnchors.length} text anchors`,
      `sticky ${sticky.length}`,
      `collapsed ${collapsed.length}`,
      ...(titleTakeover !== null ? [`takeover ${titleTakeover.bar.text}`] : [])
    ]
  };
}

function sameFamily(
  before: InteractionFrame,
  after: InteractionFrame,
  visual: VisualSimilarity | undefined,
  bands: InteractionPairingBands
): boolean {
  if (before.boardId !== null && before.boardId === after.boardId) return true;
  if (visual === undefined) return false;
  const score = visual(before.id, after.id, 0);
  return score !== null && score >= bands.visualNccFamily;
}

function isAncestor(frames: Map<string, InteractionFrame>, ancestorId: string, childId: string): boolean {
  let current = frames.get(childId)?.parentId ?? null;
  while (current !== null) {
    if (current === ancestorId) return true;
    current = frames.get(current)?.parentId ?? null;
  }
  return false;
}

function dedupe(
  candidates: InteractionCandidate[],
  frames: Map<string, InteractionFrame>
): { candidates: InteractionCandidate[]; deduped: number } {
  const seen = new Set<string>();
  const output: InteractionCandidate[] = [];
  let deduped = 0;
  for (const candidate of [...candidates].sort((left, right) => {
    const leftPair = left.pairing;
    const rightPair = right.pairing;
    return rightPair.matchedTexts - leftPair.matchedTexts || rightPair.support - leftPair.support;
  })) {
    const key = [candidate.beforeFrameId, candidate.afterFrameId].sort().join("|");
    if (seen.has(key)) {
      deduped += 1;
      continue;
    }
    seen.add(key);
    const duplicate = output.find(
      (existing) =>
        Math.abs((existing.pairing.deltaMode ?? 0) - (candidate.pairing.deltaMode ?? 0)) <= 8 &&
        ((isAncestor(frames, existing.beforeFrameId, candidate.beforeFrameId) &&
          isAncestor(frames, existing.afterFrameId, candidate.afterFrameId)) ||
          (isAncestor(frames, candidate.beforeFrameId, existing.beforeFrameId) &&
            isAncestor(frames, candidate.afterFrameId, existing.afterFrameId)))
    );
    if (duplicate !== undefined) {
      deduped += 1;
      continue;
    }
    output.push(candidate);
  }
  return { candidates: output, deduped };
}

export function pairContainers(
  inputFrames: InteractionFrame[],
  options: PairContainersOptions = {}
): InteractionPairResult {
  const bands = { ...DEFAULT_PAIRING_BANDS, ...options.bands };
  const frames = new Map(inputFrames.map((frame) => [frame.id, frame]));
  const classes = new Map(
    inputFrames.map((frame) => [
      frame.id,
      classifyFrame(frame.rendered, options.viewport ?? frame.viewport)
    ])
  );
  const stats: InteractionPairingStats = {
    frames: inputFrames.length,
    viewportStates: 0,
    fullContent: 0,
    overlays: 0,
    components: 0,
    pairsEvaluated: 0,
    textOverlap: 0,
    crossFamily: 0,
    scrollRaw: 0,
    scrollCandidates: 0,
    stateCandidates: 0,
    duplicates: 0,
    gray: 0,
    questions: 0,
    blocked: 0,
    deduped: 0
  };
  for (const entry of classes.values()) {
    if (entry.kind === "viewport-state") stats.viewportStates += 1;
    else if (entry.kind === "full-content") stats.fullContent += 1;
    else if (entry.kind === "overlay") stats.overlays += 1;
    else stats.components += 1;
  }

  const scroll: InteractionCandidate[] = [];
  const states: InteractionCandidate[] = [];
  const questions: InteractionQuestion[] = [];
  const stateByFamily = new Map<string, InteractionCandidate[]>();

  for (const before of inputFrames) {
    for (const after of inputFrames) {
      if (before.id === after.id) continue;
      stats.pairsEvaluated += 1;
      const beforeClass = classes.get(before.id)!;
      const afterClass = classes.get(after.id)!;
      if (
        beforeClass.kind === "overlay" ||
        afterClass.kind === "overlay" ||
        beforeClass.kind === "component" ||
        afterClass.kind === "component"
      ) {
        stats.blocked += 1;
        continue;
      }
      const compared = compareFrames(before, after);
      if (compared.matched < bands.minMatchedTexts) continue;
      stats.textOverlap += 1;
      if (!sameFamily(before, after, options.visual, bands)) {
        stats.crossFamily += 1;
        continue;
      }

      const pairing: InteractionPairing = {
        track: "structural",
        score: compared.support,
        matchedTexts: compared.matched,
        support: compared.support,
        offset: compared.mode ?? 0,
        deltaMode: compared.mode,
        contentDiff: compared.contentDiff,
        visualAtOffset: null
      };

      if (beforeClass.kind === "full-content" && afterClass.kind === "full-content") {
        if (
          compared.mode !== null &&
          Math.abs(compared.mode) <= bands.stateDeltaMax &&
          compared.support >= bands.minSupport &&
          compared.contentDiff >= bands.contentDiffStateChange &&
          compared.contentDiff <= bands.contentDiffStateMax
        ) {
          stats.stateCandidates += 1;
          const candidate: InteractionCandidate = {
            kind: "state-change",
            beforeFrameId: before.id,
            afterFrameId: after.id,
            pairing,
            changed: textAnchors(before)
              .filter((anchor) => !textMap(after).has(anchor.key))
              .map((anchor) => nodeRef(anchor.node, anchor.box, before.viewport.height)),
            provenance: { kind: "inferred", basis: "structural", score: compared.support },
            evidence: [
              `contentDiff ${compared.contentDiff.toFixed(3)}`,
              `matched ${compared.matched}`
            ]
          };
          const family = `${before.boardId ?? before.id}|${after.boardId ?? after.id}`;
          if (!stateByFamily.has(family)) stateByFamily.set(family, []);
          stateByFamily.get(family)!.push(candidate);
        } else {
          stats.blocked += 1;
        }
        continue;
      }

      if (
        compared.mode !== null &&
        Math.abs(compared.mode) <= bands.stateDeltaMax &&
        compared.support >= bands.minSupport
      ) {
        if (
          compared.contentDiff >= bands.contentDiffStateChange &&
          compared.contentDiff <= bands.contentDiffStateMax
        ) {
          stats.stateCandidates += 1;
          const candidate: InteractionCandidate = {
            kind: "state-change",
            beforeFrameId: before.id,
            afterFrameId: after.id,
            pairing,
            changed: textAnchors(before)
              .filter((anchor) => !textMap(after).has(anchor.key))
              .map((anchor) => nodeRef(anchor.node, anchor.box, before.viewport.height)),
            provenance: { kind: "inferred", basis: "structural", score: compared.support },
            evidence: [
              `contentDiff ${compared.contentDiff.toFixed(3)}`,
              `matched ${compared.matched}`
            ]
          };
          const family = `${before.boardId ?? before.id}|${after.boardId ?? after.id}`;
          if (!stateByFamily.has(family)) stateByFamily.set(family, []);
          stateByFamily.get(family)!.push(candidate);
        } else if (compared.contentDiff < bands.contentDiffDuplicate) {
          stats.duplicates += 1;
        } else {
          stats.gray += 1;
          if (questions.length < (options.maxQuestions ?? 20)) {
            questions.push({
              id: `state-question-${before.id}-${after.id}`,
              kind: "state-change-weak",
              frameIds: [before.id, after.id],
              message: `「${before.name}」与「${after.name}」内容差异处于灰区（${compared.contentDiff.toFixed(3)}）`
            });
          }
        }
        continue;
      }

      if (
        compared.mode !== null &&
        Math.abs(compared.mode) >= bands.minScrollDelta &&
        compared.support >= bands.minSupport
      ) {
        stats.scrollRaw += 1;
        const visual = options.visual?.(before.id, after.id, compared.mode) ?? null;
        pairing.visualAtOffset = visual;
        if (visual === null && options.requireVisual === true) {
          stats.blocked += 1;
          continue;
        }
        if (visual !== null && visual < bands.visualNccScroll) {
          stats.blocked += 1;
          continue;
        }
        const context = after.parentId === null ? undefined : frames.get(after.parentId);
        const collapse = inferScrollCollapse(before, after, bands, context);
        stats.scrollCandidates += 1;
        scroll.push({
          kind: "scroll-collapse",
          beforeFrameId: before.id,
          afterFrameId: after.id,
          pairing,
          delta: { designPx: Math.abs(compared.mode), devicePoints: null },
          sticky: collapse.sticky,
          collapsed: collapse.collapsed,
          titleTakeover: collapse.titleTakeover,
          provenance: {
            kind: "inferred",
            basis: visual === null ? "structural" : "visual",
            score: visual === null ? compared.support : visual
          },
          evidence: [
            ...collapse.evidence,
            `deltaMode ${compared.mode}`,
            `support ${compared.support.toFixed(3)}`,
            ...(visual === null ? [] : [`ncc ${visual.toFixed(3)}`])
          ]
        });
        continue;
      }

      stats.gray += 1;
    }
  }

  const scrollDeduped = dedupe(scroll, frames);
  const stateDeduped = dedupe(states, frames);
  const scrollRepresentatives = new Map<string, InteractionCandidate>();
  for (const candidate of scrollDeduped.candidates) {
    const family = `${frames.get(candidate.beforeFrameId)?.boardId ?? candidate.beforeFrameId}|${
      frames.get(candidate.afterFrameId)?.boardId ?? candidate.afterFrameId
    }`;
    const current = scrollRepresentatives.get(family);
    if (
      current === undefined ||
      candidate.pairing.matchedTexts > current.pairing.matchedTexts ||
      (candidate.pairing.matchedTexts === current.pairing.matchedTexts &&
        candidate.pairing.support > current.pairing.support)
    ) {
      scrollRepresentatives.set(family, candidate);
    }
  }
  const stateCandidates: InteractionCandidate[] = [];
  for (const list of stateByFamily.values()) {
    stateCandidates.push(
      ...list
        .sort(
          (left, right) =>
            left.pairing.contentDiff - right.pairing.contentDiff ||
            right.pairing.support - left.pairing.support
        )
        .slice(0, 3)
    );
  }
  const cappedStates = stateCandidates.slice(0, options.maxStateCandidates ?? 20);
  const candidates = [...scrollRepresentatives.values(), ...cappedStates];

  stats.scrollCandidates = scrollRepresentatives.size;
  stats.stateCandidates = cappedStates.length;
  stats.questions = questions.length;
  stats.deduped = scrollDeduped.deduped + stateDeduped.deduped;
  return { candidates, questions, stats };
}

export interface ObservedInteraction {
  kind: "scroll-collapse";
  provenance: Extract<InteractionProvenance, { kind: "observed" }>;
  screenId: string;
  unit: "device-points";
  thresholdSignal: "structural";
  firstChangePoints: number;
  fullEffectPoints: number;
  sticky: InteractionNodeRef[];
  collapsed: InteractionNodeRef[];
  restored: boolean;
  evidence: { before: string; after: string };
}

export interface ConfirmedInteraction {
  kind: "scroll-collapse";
  provenance: Extract<InteractionProvenance, { kind: "confirmed" }>;
  screenId: string;
  sticky: InteractionNodeRef[];
  collapsed: InteractionNodeRef[];
}

export type DeviceQuery =
  | {
      kind: "absentText";
      text: string;
      region?: "header" | "content" | "footer";
      role?: string;
      ordinal?: number;
    }
  | {
      kind: "presentText";
      text: string;
      region?: "header" | "content" | "footer";
      role?: string;
      ordinal?: number;
    }
  | { kind: "headerTitle"; text: string };

export interface Assertion {
  kind: "scroll-collapse";
  source: "observed" | "confirmed";
  afterScroll: DeviceQuery[];
  afterRestore: DeviceQuery[];
}

export function toScrollAssertion(
  interaction: ObservedInteraction | ConfirmedInteraction
): Assertion {
  const persistent = interaction.sticky.filter((node) => node.origin !== "takeover");
  const takeover = interaction.sticky.filter((node) => node.origin === "takeover");
  const collapsed = interaction.collapsed.filter((node) => node.text !== null);
  return {
    kind: "scroll-collapse",
    source: interaction.provenance.kind,
    afterScroll: [
      ...collapsed.map((node) => ({
        kind: "absentText" as const,
        text: node.text!,
        region: node.region ?? "content"
      })),
      ...persistent.flatMap((node) =>
        node.text
          ? [
              {
                kind: "presentText" as const,
                text: node.text,
                region: node.region ?? "content"
              }
            ]
          : []
      ),
      ...takeover.flatMap((node) =>
        node.text
          ? [{ kind: "presentText" as const, text: node.text, region: "header" as const }]
          : []
      )
    ],
    afterRestore: [
      ...persistent.flatMap((node) =>
        node.text
          ? [
              {
                kind: "presentText" as const,
                text: node.text,
                region: node.region ?? "content"
              }
            ]
          : []
      ),
      ...collapsed.map((node) => ({
        kind: "presentText" as const,
        text: node.text!,
        region: node.region ?? "content"
      })),
      ...takeover.flatMap((node) =>
        node.text
          ? [{ kind: "absentText" as const, text: node.text, region: "header" as const }]
          : []
      )
    ]
  };
}

export function interactionCandidatesFromReading(value: unknown): InteractionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is InteractionCandidate => {
    if (entry === null || typeof entry !== "object") return false;
    const kind = (entry as { kind?: unknown }).kind;
    return kind === "scroll-collapse" || kind === "state-change";
  });
}
