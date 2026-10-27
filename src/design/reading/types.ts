import type { FlowEdge, FlowElement, FlowWarning } from "../../figma/flows.js";

export type CanvasLayout = "vertical" | "horizontal" | "grid" | "unknown";

export type ReadingStatus = "observed" | "inferred" | "unconfirmed";

export interface ReadingBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReadingControl {
  /** back/title/search/cart/menu-entry/tab/other/chrome… */
  kind: string;
  label: string | null;
  bbox: ReadingBBox | null;
  confidence: number | null;
}

export interface ReadingPersistentNav {
  sideNav: string[];
  bottomTabs: string[];
  activeTab: string | null;
}

export interface ReadingAnnotation {
  text: string;
  source: string;
  target: string | null;
  bbox: ReadingBBox | null;
}

export interface ReadingContentGroup {
  label: string;
  items: string[];
}

export interface ReadingScreenObservation {
  screenId: string;
  name: string;
  /** 手机外框上方的画板/状态文字（如「行動預點-下滑」），不是 App 标题。 */
  boardLabel?: string | null;
  /** 从画板标签提取的状态（如「下滑」）；没有则 null。 */
  stateLabel?: string | null;
  /** flows 中已知的状态变体标签（只做元数据，不额外读图）。 */
  knownStates?: string[];
  /** 该观察来自主屏还是状态变体。 */
  kind?: "screen" | "state";
  /** 状态变体所属主屏。 */
  parentScreenId?: string;
  title: string | null;
  headerControls: ReadingControl[];
  persistentNav: ReadingPersistentNav;
  contentGroups: ReadingContentGroup[];
  floatingActions: ReadingControl[];
  annotations: ReadingAnnotation[];
  /** MVP reserves state variants; always empty for now. */
  states?: string[];
  /** Overlap conflicts keep the other reading for review (never silently chosen). */
  alternatives?: ReadingScreenObservation[];
}

export interface ReadingInteraction {
  id: string;
  fromScreenId: string;
  fromElement: string;
  action: string;
  toScreenId: string | null;
  toLabel: string | null;
  status: ReadingStatus;
  basis: string;
  confidence: number | null;
  why: string | null;
}

export interface ReadingAnswerMatch {
  screenId?: string;
  screenNameIncludes?: string;
  elementIncludes?: string;
  questionIncludes?: string;
}

export interface ReadingAnswerResolution {
  /** `"self"` = 当前来源屏（页内切换/底部弹层）；null = 不指向页面。 */
  toScreenId?: string | "self" | null;
  toLabel?: string | null;
  action?: string;
  dropInteraction?: boolean;
  screenTitle?: string | null;
}

export interface ReadingAnswer {
  id: string;
  match: ReadingAnswerMatch;
  answer: string;
  resolution?: ReadingAnswerResolution;
}

export interface ReadingQuestion {
  id: string;
  screenId: string;
  screenName: string;
  element: string | null;
  question: string;
  why: string;
  options?: string[];
}

export interface ReadingChunk {
  chunkId: string;
  cacheKey: string;
  plannedScreenIds: string[];
  screenIds: string[];
  screens: ReadingScreenObservation[];
  interactions: ReadingInteraction[];
  questions: ReadingQuestion[];
  droppedScreens: string[];
  unreadScreens: string[];
  calls: number;
  warnings: FlowWarning[];
}

export interface ReadingScreenRef {
  id: string;
  name: string;
  order: number;
  imagePath: string | null;
  /** flows 中该屏的状态变体标签（如「行動預點-下滑」）。 */
  states?: string[];
  /** 主屏或状态变体。 */
  kind?: "screen" | "state";
  /** 状态变体所属主屏。 */
  parentScreenId?: string;
  /** 状态变体从画板标签提取的状态（如「下滑」）。 */
  stateLabel?: string;
  /** 设计器/画板原始 frame 名（可能是通用 Frame N，仅作 fallback）。 */
  sourceFrameName?: string;
}

export interface ReadingChunkPlan {
  chunkId: string;
  screens: ReadingScreenRef[];
  boundaryBefore: string | null;
  boundaryAfter: string | null;
  knownEdges: FlowEdge[];
  knownElements: Array<FlowElement & { screenId?: string }>;
}

export interface ReadingSpine {
  title: string;
  summary: string;
  screenIds: string[];
  edgeIds: string[];
  statusSummary: Record<ReadingStatus, number>;
  status: ReadingStatus;
  basis: string[];
  confidence: number | null;
}

export interface ReadingCompleteness {
  screens: number;
  observedScreens: number;
  screensRead: number;
  screensTotal: number;
  failedScreens: number;
  unreadScreens: string[];
  droppedScreens: string[];
  truncatedScreens: string[];
  orphanScreens: string[];
  unresolvedEdges: number;
  unconfirmedEdges: number;
  overlapConflicts: number;
  conflicts: number;
  headerCoverage: number;
  bottomNavCoverage: number;
  annotationScreens: number;
  questionsTotal: number;
  questionsOmitted: number;
  questionsAnswered: number;
}

export interface ReadingStats {
  chunksRequested: number;
  chunksProcessed: number;
  chunksReused: number;
  chunksFailed: number;
  calls: number;
  screens: number;
  screensRead: number;
  screensTotal: number;
  droppedScreens: string[];
  truncatedScreens: string[];
  observed: number;
  inferred: number;
  unconfirmed: number;
}

export interface ReadingFile {
  schemaVersion: 1;
  source: string;
  orderSource?: "flows" | "canvas" | "unknown";
  flowsFingerprint: string;
  screensFingerprint: string;
  generatedAt: string;
  model: string;
  chunkSize: number;
  overlap: number;
  screens: ReadingScreenObservation[];
  interactions: ReadingInteraction[];
  spine: ReadingSpine | null;
  questions: ReadingQuestion[];
  answers?: ReadingAnswer[];
  canvasLayout?: CanvasLayout;
  completeness: ReadingCompleteness;
  stats: ReadingStats;
  warnings: FlowWarning[];
}

export interface ReadingOptions {
  chunkSize?: number;
  overlap?: number;
  maxScreens?: number;
  concurrency?: number;
  timeoutMs?: number;
}

export interface DesignReadingResult {
  ok: boolean;
  status: "read" | "skipped" | "partial";
  reason: string | null;
  reading: ReadingFile | null;
  artifacts: { json: string; markdown: string; chunksDir: string } | null;
  warnings: FlowWarning[];
  stats: ReadingStats;
}

export function emptyReadingStats(): ReadingStats {
  return {
    chunksRequested: 0,
    chunksProcessed: 0,
    chunksReused: 0,
    chunksFailed: 0,
    calls: 0,
    screens: 0,
    screensRead: 0,
    screensTotal: 0,
    droppedScreens: [],
    truncatedScreens: [],
    observed: 0,
    inferred: 0,
    unconfirmed: 0
  };
}
