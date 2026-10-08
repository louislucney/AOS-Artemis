export interface CoverageEdge {
  from: string;
  to: string | null;
}

export interface ScreenCoverage {
  /** Screens visited by at least one case. */
  coveredScreens: string[];
  /** Design screens no case visits. */
  uncoveredScreens: string[];
  /** Effective transitions (`From → To`) no case walks. */
  uncoveredEdges: string[];
}

/** Single source of truth for screen/transition coverage (生成闸与执行预检共用).
 * Rules (DESIGN §6.10 口径): edges without a destination and self transitions
 * (BACK/self loops) add no new screen step, so they are not coverage targets. */
export function computeScreenCoverage(
  screenNames: string[],
  edges: CoverageEdge[],
  cases: Array<{ screens: string[] }>
): ScreenCoverage {
  const coveredScreens = new Set<string>();
  const coveredPairs = new Set<string>();
  for (const testCase of cases) {
    for (const screen of testCase.screens) coveredScreens.add(screen);
    for (let index = 1; index < testCase.screens.length; index += 1) {
      coveredPairs.add(`${testCase.screens[index - 1]} → ${testCase.screens[index]}`);
    }
  }
  const edgePairs = new Set<string>();
  for (const edge of edges) {
    if (edge.to === null || edge.from === edge.to) continue;
    edgePairs.add(`${edge.from} → ${edge.to}`);
  }
  return {
    coveredScreens: [...coveredScreens],
    uncoveredScreens: screenNames.filter((name) => !coveredScreens.has(name)),
    uncoveredEdges: [...edgePairs].filter((pair) => !coveredPairs.has(pair))
  };
}
