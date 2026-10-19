import type { FlowElement } from "../figma/flows.js";
import type { DesignWarning } from "./warnings.js";

type Bbox = { x: number; y: number; width: number; height: number };

/** 设计稿候选交互元素的命名词表（按 `/` 分段、大小写不敏感匹配）。 */
export const DEFAULT_CANDIDATE_TOKENS: readonly string[] = [
  "Button",
  "Tab",
  "Link",
  "Input",
  "Toggle",
  "Switch",
  "Checkbox",
  "Search",
  "Menu",
  "Cart",
  "Bag",
  "CTA",
  "Sticky button",
  "按钮",
  "标签",
  "链接",
  "输入框",
  "开关",
  "搜索",
  "菜单",
  "购物车",
  "购物袋",
  "返回",
  "关闭"
];

export interface VisionCandidate {
  id: string;
  name: string;
  type: string;
  bbox?: Bbox;
  textHints: string[];
  state: string | null;
}

export interface CandidateCoverageDetail {
  nodeId: string;
  name: string;
  status: "covered" | "uncovered" | "unverifiable" | "not-evaluated";
  reason?:
    | "no-geometry"
    | "no-text"
    | "ambiguous-text"
    | "vision-off"
    | "vision-unavailable"
    | "capped"
    | "render-missing"
    | "frame-missing"
    | "rejected"
    | "failed";
  /** 同 state 共享该归一化文本的候选数（仅 `ambiguous-text` 时给出）。 */
  matches?: number;
  bbox?: Bbox;
}

export interface FlowElementCoverage {
  state: string | null;
  designNodes: number;
  candidateNodes: number;
  recognizedElements: number;
  groundedElements: number;
  ungroundedElements: number;
  coveredCandidates: number;
  uncoveredCandidates: number;
  unverifiableCandidates: number;
  notEvaluatedCandidates: number;
  /** 整个 target 未进入 vision（`notEvaluatedReason` 传入时为 true；零候选也可据此区分「未评估」与「词表不适配」）。 */
  notEvaluated?: boolean;
  /** 未评估原因（与 `notEvaluated: true` 同时出现；产物与 flow-map 据此区分零候选的未评估 target）。 */
  notEvaluatedReason?: CandidateCoverageDetail["reason"];
  candidatesTruncated?: number;
  details: CandidateCoverageDetail[];
}

const CJK_PATTERN = /[\u3400-\u9fff]/;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const IOU_THRESHOLD = 0.2;

/** `AOS_VISION_CANDIDATE_TOKENS` 按逗号（中英文）分隔；去空、去重、归一化为小写。 */
export function parseCandidateTokens(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,，\n]/)) {
    const token = part.trim().toLowerCase();
    if (token === "" || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function normalizeWords(text: string): string[] {
  return text.toLowerCase().split(WORD_SPLIT).filter((word) => word !== "");
}

function tokenMatchesSegment(token: string, segment: string): boolean {
  const normalizedToken = token.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedSegment = segment.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalizedToken === "" || normalizedSegment === "") return false;
  if (normalizedToken === normalizedSegment) return true;
  if (CJK_PATTERN.test(normalizedToken)) return normalizedSegment.includes(normalizedToken);
  const tokenWords = normalizeWords(normalizedToken);
  const segmentWords = normalizeWords(normalizedSegment);
  if (tokenWords.length === 0 || segmentWords.length < tokenWords.length) return false;
  for (let start = 0; start + tokenWords.length <= segmentWords.length; start += 1) {
    if (tokenWords.every((word, offset) => segmentWords[start + offset] === word)) return true;
  }
  return false;
}

/** 名称任一 `/` 分段命中词表即视为候选；`extraTokens` 用于项目追加词表。 */
export function candidateNameMatches(name: string, extraTokens: readonly string[] = []): boolean {
  if (typeof name !== "string" || name.trim() === "") return false;
  const tokens = [...DEFAULT_CANDIDATE_TOKENS, ...extraTokens]
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return false;
  return name.split("/").some((segment) => tokens.some((token) => tokenMatchesSegment(token, segment)));
}

function validBbox(bbox: Bbox | undefined): Bbox | null {
  if (!bbox) return null;
  const values = [bbox.x, bbox.y, bbox.width, bbox.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (bbox.width <= 0 || bbox.height <= 0) return null;
  return bbox;
}

function overlapArea(left: Bbox, right: Bbox): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  );
  return width * height;
}

function iou(left: Bbox, right: Bbox): number {
  const overlap = overlapArea(left, right);
  if (overlap <= 0) return 0;
  const union = left.width * left.height + right.width * right.height - overlap;
  return union > 0 ? overlap / union : 0;
}

function centerInside(inner: Bbox, outer: Bbox): boolean {
  const centerX = inner.x + inner.width / 2;
  const centerY = inner.y + inner.height / 2;
  return (
    centerX >= outer.x &&
    centerX <= outer.x + outer.width &&
    centerY >= outer.y &&
    centerY <= outer.y + outer.height
  );
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function textMatches(left: string, right: string): boolean {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (a === "" || b === "") return false;
  if (a === b) return true;
  return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
}

function elementLabels(elements: FlowElement[]): string[] {
  const labels = new Set<string>();
  for (const element of elements) {
    if (typeof element.label === "string" && element.label.trim() !== "") labels.add(element.label);
  }
  return [...labels];
}

function textFallback(
  candidate: VisionCandidate,
  elements: FlowElement[],
  candidates: VisionCandidate[]
): { matched: boolean; ambiguous: boolean; owners: number } {
  const labels = elementLabels(elements);
  for (const hint of candidate.textHints) {
    for (const label of labels) {
      if (!textMatches(hint, label)) continue;
      const owners = candidates.filter((entry) =>
        entry.textHints.some((entryHint) => textMatches(entryHint, label))
      ).length;
      return { matched: true, ambiguous: owners > 1, owners };
    }
  }
  return { matched: false, ambiguous: false, owners: 0 };
}

function detailFor(
  candidate: VisionCandidate,
  status: CandidateCoverageDetail["status"],
  reason?: CandidateCoverageDetail["reason"],
  matches?: number
): CandidateCoverageDetail {
  const bbox = validBbox(candidate.bbox);
  return {
    nodeId: candidate.id,
    name: candidate.name,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(matches !== undefined ? { matches } : {}),
    ...(bbox ? { bbox } : {})
  };
}

/** 按 state 作用域判定候选四态；元素由调用方按 target（主屏/变体）预筛。 */
export function evaluateCandidateCoverage(input: {
  state: string | null;
  designNodes: number;
  candidates: VisionCandidate[];
  elements: FlowElement[];
  notEvaluatedReason?: CandidateCoverageDetail["reason"];
  candidatesTruncated?: number;
}): FlowElementCoverage {
  const candidates = input.candidates.filter(
    (candidate) => (candidate.state ?? null) === input.state
  );
  const details: CandidateCoverageDetail[] = [];
  let covered = 0;
  let uncovered = 0;
  let unverifiable = 0;
  let notEvaluated = 0;

  for (const candidate of candidates) {
    if (input.notEvaluatedReason !== undefined) {
      notEvaluated += 1;
      details.push(detailFor(candidate, "not-evaluated", input.notEvaluatedReason));
      continue;
    }
    const nodeIdHit = input.elements.some((element) => element.nodeId === candidate.id);
    if (nodeIdHit) {
      covered += 1;
      details.push(detailFor(candidate, "covered"));
      continue;
    }
    const bbox = validBbox(candidate.bbox);
    if (bbox) {
      const geometryHit = input.elements.some((element) => {
        const elementBbox = validBbox(element.bbox);
        if (!elementBbox) return false;
        return iou(elementBbox, bbox) >= IOU_THRESHOLD || centerInside(elementBbox, bbox);
      });
      if (geometryHit) {
        covered += 1;
        details.push(detailFor(candidate, "covered"));
        continue;
      }
    }
    const text = textFallback(candidate, input.elements, candidates);
    if (text.matched && !text.ambiguous) {
      covered += 1;
      details.push(detailFor(candidate, "covered"));
      continue;
    }
    if (text.matched && text.ambiguous) {
      unverifiable += 1;
      details.push(detailFor(candidate, "unverifiable", "ambiguous-text", text.owners));
      continue;
    }
    if (bbox) {
      uncovered += 1;
      details.push(detailFor(candidate, "uncovered"));
      continue;
    }
    unverifiable += 1;
    details.push(
      detailFor(candidate, "unverifiable", candidate.textHints.length > 0 ? "no-geometry" : "no-text")
    );
  }

  const groundedElements = input.elements.filter((element) => element.nodeId).length;
  const coverage: FlowElementCoverage = {
    state: input.state,
    designNodes: input.designNodes,
    candidateNodes: candidates.length,
    recognizedElements: input.elements.length,
    groundedElements,
    ungroundedElements: input.elements.length - groundedElements,
    coveredCandidates: covered,
    uncoveredCandidates: uncovered,
    unverifiableCandidates: unverifiable,
    notEvaluatedCandidates: notEvaluated,
    details
  };
  if (input.notEvaluatedReason !== undefined) {
    coverage.notEvaluated = true;
    coverage.notEvaluatedReason = input.notEvaluatedReason;
  }
  if (input.candidatesTruncated !== undefined) coverage.candidatesTruncated = input.candidatesTruncated;
  return coverage;
}

function screenScope(screenName: string, state: string | null): string {
  return state === null ? `屏幕「${screenName}」` : `屏幕「${screenName}」·状态「${state}」`;
}

/** 屏级汇总告警：uncovered 逐候选具名；unverifiable 每屏一条；零候选提示词表不适配。 */
export function coverageWarnings(
  screenName: string,
  coverages: FlowElementCoverage[]
): DesignWarning[] {
  const warnings: DesignWarning[] = [];
  for (const coverage of coverages) {
    const uncovered = coverage.details.filter((detail) => detail.status === "uncovered");
    if (uncovered.length === 0) continue;
    warnings.push({
      code: "vision-candidate-uncovered",
      message: `${screenScope(screenName, coverage.state)}有 ${uncovered.length} 个设计候选元素未被识别`,
      details: uncovered.map((detail) => `${detail.name}（${detail.nodeId}）`)
    });
  }

  const unverifiableCoverages = coverages.filter(
    (coverage) => coverage.unverifiableCandidates > 0
  );
  if (unverifiableCoverages.length > 0) {
    const total = unverifiableCoverages.reduce(
      (sum, coverage) => sum + coverage.unverifiableCandidates,
      0
    );
    const perState = unverifiableCoverages.map((coverage) =>
      coverage.state === null
        ? `主屏 ${coverage.unverifiableCandidates}`
        : `状态「${coverage.state}」${coverage.unverifiableCandidates}`
    );
    warnings.push({
      code: "vision-candidate-unverifiable",
      message: `屏幕「${screenName}」有 ${total} 个候选元素缺几何或文本，无法核验（未计入覆盖；${perState.join(
        " / "
      )}）`,
      details: perState
    });
  }

  for (const coverage of coverages) {
    if (coverage.designNodes <= 0 || coverage.candidateNodes > 0) continue;
    if (coverage.notEvaluated === true || coverage.notEvaluatedCandidates > 0) continue;
    warnings.push({
      code: "vision-candidate-vocabulary-unmatched",
      message:
        `${screenScope(screenName, coverage.state)}有 ${coverage.designNodes} 个设计节点但未匹配到候选交互元素，` +
        "候选词表可能不适配（可用 AOS_VISION_CANDIDATE_TOKENS 追加）"
    });
  }
  return warnings;
}
