import fs from "node:fs";
import path from "node:path";

export interface PreflightWeakStep {
  index: number;
  reason: string;
}

export interface PreflightWeakCase {
  id: string;
  name: string;
  weakSteps: PreflightWeakStep[];
}

export interface PreflightReport {
  cases: number;
  weakCases: PreflightWeakCase[];
  coverage: {
    screens: string[];
    uncoveredScreens: string[];
    uncoveredEdges: string[];
  };
  generation: unknown;
}

export function preflightGeneratedTests(configDirAbs: string): PreflightReport | null {
  const designDir = path.join(configDirAbs, "design");
  let tests: { flows?: unknown; generation?: unknown };
  try {
    tests = JSON.parse(fs.readFileSync(path.join(designDir, "tests.json"), "utf-8")) as {
      flows?: unknown;
      generation?: unknown;
    };
  } catch {
    return null;
  }

  const rawCases = Array.isArray(tests.flows) ? tests.flows : [];
  const cases = rawCases.filter(
    (entry): entry is { id: string; name?: unknown; screens?: unknown; steps?: unknown } =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
  );

  const weakCases: PreflightWeakCase[] = [];
  const covered = new Set<string>();
  const coveredPairs = new Set<string>();
  for (const entry of cases) {
    const screens = Array.isArray(entry.screens)
      ? entry.screens.filter((screen): screen is string => typeof screen === "string")
      : [];
    for (const screen of screens) covered.add(screen);
    for (let index = 1; index < screens.length; index += 1) {
      coveredPairs.add(`${screens[index - 1]} → ${screens[index]}`);
    }

    const steps = Array.isArray(entry.steps)
      ? entry.steps.filter((step): step is string => typeof step === "string")
      : [];
    const weakSteps = steps
      .map((step, index) => ({ index, weak: !step.includes("应") }))
      .filter((item) => item.weak)
      .map((item) => ({ index: item.index, reason: "缺少可验证断言（目的地屏无文本提示）" }));
    if (weakSteps.length > 0) {
      weakCases.push({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        weakSteps
      });
    }
  }

  const coverage = {
    screens: [...covered],
    uncoveredScreens: [] as string[],
    uncoveredEdges: [] as string[]
  };
  try {
    const flows = JSON.parse(fs.readFileSync(path.join(designDir, "flows.json"), "utf-8")) as {
      screens?: Array<{ name?: unknown }>;
      edges?: Array<{ from?: { name?: unknown }; to?: { name?: unknown } | null }>;
    };
    const allScreens = (flows.screens ?? [])
      .map((screen) => screen.name)
      .filter((name): name is string => typeof name === "string");
    coverage.uncoveredScreens = allScreens.filter((name) => !covered.has(name));

    const uncoveredEdges = new Set<string>();
    for (const edge of flows.edges ?? []) {
      const from = edge.from?.name;
      const to = edge.to?.name;
      if (typeof from !== "string" || typeof to !== "string") continue;
      if (!coveredPairs.has(`${from} → ${to}`)) uncoveredEdges.add(`${from} → ${to}`);
    }
    coverage.uncoveredEdges = [...uncoveredEdges];
  } catch {
    /* no flows.json: coverage limited to generated screens */
  }

  return { cases: cases.length, weakCases, coverage, generation: tests.generation ?? null };
}
