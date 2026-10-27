import type { FlowEdge, FlowElement } from "../../figma/flows.js";
import type { ReadingChunkPlan, ReadingScreenRef } from "./types.js";

export interface ReadingChunkOptions {
  chunkSize?: number;
  overlap?: number;
  maxScreens?: number;
  concurrency?: number;
  timeoutMs?: number;
  includeStates?: boolean;
  edges?: FlowEdge[];
  elementsByScreen?: Map<string, FlowElement[]>;
}

export interface ReadingChunkPlanResult {
  plans: ReadingChunkPlan[];
  truncated: number;
  truncatedScreens: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function uniqueById<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function edgesForScreens(edges: FlowEdge[], ids: Set<string>): FlowEdge[] {
  return edges.filter(
    (edge) => ids.has(edge.from.id) && (edge.to === null || ids.has(edge.to.id))
  );
}

function elementsForScreens(
  elementsByScreen: Map<string, FlowElement[]>,
  ids: Set<string>
): Array<FlowElement & { screenId?: string }> {
  const out: Array<FlowElement & { screenId?: string }> = [];
  for (const id of ids) {
    for (const element of elementsByScreen.get(id) ?? []) {
      out.push({ ...element, screenId: id });
    }
  }
  return out;
}

/** 相邻屏幕分块：默认 3 屏一块、1 屏重叠；最后不足 2 屏并入前一块。 */
export function chunkReadingScreens(
  screens: ReadingScreenRef[],
  options: ReadingChunkOptions = {}
): ReadingChunkPlanResult {
  const chunkSize = clamp(options.chunkSize ?? 3, 2, 5);
  const overlap = clamp(options.overlap ?? 1, 0, chunkSize - 1);
  const maxScreens = clamp(options.maxScreens ?? 50, 1, 200);
  const ordered = [...screens].sort((left, right) => left.order - right.order);
  const kept = ordered.slice(0, maxScreens);
  const truncatedScreens = ordered.slice(maxScreens).map((screen) => screen.id);
  const step = Math.max(1, chunkSize - overlap);
  const plans: ReadingChunkPlan[] = [];
  const allEdges = options.edges ?? [];
  const elementsByScreen = options.elementsByScreen ?? new Map<string, FlowElement[]>();

  const pushPlan = (chunkScreens: ReadingScreenRef[]): void => {
    if (chunkScreens.length === 0) return;
    const firstIndex = ordered.findIndex((entry) => entry.id === chunkScreens[0]!.id);
    const lastIndex = ordered.findIndex(
      (entry) => entry.id === chunkScreens[chunkScreens.length - 1]!.id
    );
    const ids = new Set(chunkScreens.map((screen) => screen.id));
    plans.push({
      chunkId: `chunk-${String(plans.length + 1).padStart(3, "0")}`,
      screens: chunkScreens,
      boundaryBefore: firstIndex > 0 ? ordered[firstIndex - 1]!.name : null,
      boundaryAfter:
        lastIndex >= 0 && lastIndex + 1 < ordered.length ? ordered[lastIndex + 1]!.name : null,
      knownEdges: edgesForScreens(allEdges, ids),
      knownElements: elementsForScreens(elementsByScreen, ids)
    });
  };

  let start = 0;
  while (start < kept.length) {
    const slice = kept.slice(start, start + chunkSize);
    if (slice.length === 0) break;
    if (slice.length < 2 && plans.length > 0) {
      const previous = plans[plans.length - 1]!;
      previous.screens = uniqueById([...previous.screens, ...slice]).sort(
        (left, right) => left.order - right.order
      );
      const ids = new Set(previous.screens.map((screen) => screen.id));
      previous.knownEdges = edgesForScreens(allEdges, ids);
      previous.knownElements = elementsForScreens(elementsByScreen, ids);
      break;
    }
    pushPlan(slice);
    start += step;
  }

  return { plans, truncated: truncatedScreens.length, truncatedScreens };
}
