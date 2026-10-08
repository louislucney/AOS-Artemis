import type { CoverageEdge } from "./coverage.js";

export interface TraceabilityCaseInput {
  id: string;
  name: string;
  screens: string[];
  traceId: string | null;
  hasEvidence: boolean;
}

export interface TraceabilityScreen {
  screen: string;
  caseIds: string[];
  traceIds: string[];
}

export interface TraceabilityEdge {
  edge: string;
  caseIds: string[];
}

export interface TraceabilityReport {
  screens: TraceabilityScreen[];
  edges: TraceabilityEdge[];
  uncoveredScreens: string[];
  uncoveredEdges: string[];
  casesWithoutTrace: string[];
  casesWithoutEvidence: string[];
}

/** design（屏幕/跳转）↔ case_id ↔ trace ↔ evidence 双向矩阵（纯函数）。 */
export function buildTraceability(input: {
  screenNames: string[];
  edges: CoverageEdge[];
  cases: TraceabilityCaseInput[];
}): TraceabilityReport {
  const caseByScreen = new Map<string, string[]>();
  const pairCases = new Map<string, string[]>();
  for (const testCase of input.cases) {
    for (const screen of testCase.screens) {
      const list = caseByScreen.get(screen) ?? [];
      list.push(testCase.id);
      caseByScreen.set(screen, list);
    }
    for (let index = 1; index < testCase.screens.length; index += 1) {
      const pair = `${testCase.screens[index - 1]} → ${testCase.screens[index]}`;
      const list = pairCases.get(pair) ?? [];
      list.push(testCase.id);
      pairCases.set(pair, list);
    }
  }
  const traceByCase = new Map(input.cases.map((entry) => [entry.id, entry.traceId]));

  const screens: TraceabilityScreen[] = input.screenNames.map((screen) => {
    const caseIds = caseByScreen.get(screen) ?? [];
    return {
      screen,
      caseIds,
      traceIds: caseIds
        .map((caseId) => traceByCase.get(caseId) ?? null)
        .filter((traceId): traceId is string => traceId !== null)
    };
  });

  const edgePairs = new Set<string>();
  for (const edge of input.edges) {
    if (edge.to === null || edge.from === edge.to) continue;
    edgePairs.add(`${edge.from} → ${edge.to}`);
  }
  const edges: TraceabilityEdge[] = [...edgePairs].map((edge) => ({
    edge,
    caseIds: pairCases.get(edge) ?? []
  }));

  return {
    screens,
    edges,
    uncoveredScreens: screens.filter((entry) => entry.caseIds.length === 0).map((entry) => entry.screen),
    uncoveredEdges: edges.filter((entry) => entry.caseIds.length === 0).map((entry) => entry.edge),
    casesWithoutTrace: input.cases.filter((entry) => entry.traceId === null).map((entry) => entry.id),
    casesWithoutEvidence: input.cases
      .filter((entry) => entry.traceId !== null && !entry.hasEvidence)
      .map((entry) => entry.id)
  };
}
