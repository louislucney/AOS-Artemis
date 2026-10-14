export interface VerdictExitCase {
  runId: string;
  caseId: string;
  name: string;
  featureKey: string | null;
  featureName: string | null;
  platform: string;
  device: string | null;
  traceId: string | null;
  verdictAt: string | null;
  note: string | null;
  jiraKey: string | null;
}

export interface VerdictEnvironmentGroup {
  device: string | null;
  platform: string;
  count: number;
  features: string[];
  lastAt: string | null;
  notes: string[];
}

export interface VerdictExits {
  caseDefects: VerdictExitCase[];
  environment: VerdictEnvironmentGroup[];
  appDefects: VerdictExitCase[];
}

/** 最新裁决口径（与 §13.108 统计口径逐字一致）：入参自排 createdAt 新→旧；
 * 按（caseSetId ?? "" + "|" + caseId）首见即最新；caseDefects/appDefects 按 caseId 升序
 * （tie → featureName 升序 → runId 升序）。 */
export function collectVerdictExits(runs: Array<{
  id: string;
  createdAt: string;
  caseSetId: string | null;
  featureKey: string | null;
  featureName: string | null;
  platform: string;
  device: string | null;
  cases: Array<{
    caseId: string;
    name: string;
    featureKey: string | null;
    platform: string;
    status: string;
    traceId: string | null;
    verdict: string | null;
    verdictAt: string | null;
    verdictNote: string | null;
    jiraIssueKey: string | null;
  }>;
}>): VerdictExits {
  const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = new Map<string, VerdictExitCase & { verdict: string }>();
  for (const run of sorted) {
    if (run.featureKey === null) continue;
    for (const entry of run.cases) {
      if (entry.verdict === null) continue;
      const key = `${run.caseSetId ?? ""}|${entry.caseId}`;
      if (latest.has(key)) continue;
      latest.set(key, {
        runId: run.id,
        caseId: entry.caseId,
        name: entry.name,
        featureKey: run.featureKey,
        featureName: run.featureName,
        platform: run.platform,
        device: run.device,
        traceId: entry.traceId,
        verdictAt: entry.verdictAt,
        note: entry.verdictNote,
        jiraKey: entry.jiraIssueKey,
        verdict: entry.verdict
      });
    }
  }

  const byCaseIdThenNameThenRunId = (a: VerdictExitCase, b: VerdictExitCase): number => {
    if (a.caseId !== b.caseId) return a.caseId < b.caseId ? -1 : 1;
    const aName = a.featureName ?? "";
    const bName = b.featureName ?? "";
    if (aName !== bName) return aName < bName ? -1 : 1;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  };

  const strip = (entry: VerdictExitCase & { verdict: string }): VerdictExitCase => {
    const { verdict: _verdict, ...rest } = entry;
    return rest;
  };

  const caseDefects = [...latest.values()]
    .filter((entry) => entry.verdict === "case-defect")
    .sort(byCaseIdThenNameThenRunId)
    .map(strip);
  const appDefects = [...latest.values()]
    .filter((entry) => entry.verdict === "app-defect")
    .sort(byCaseIdThenNameThenRunId)
    .map(strip);

  const groups = new Map<
    string,
    {
      device: string | null;
      platform: string;
      count: number;
      features: string[];
      lastAt: string | null;
      notes: string[];
    }
  >();
  for (const entry of latest.values()) {
    if (entry.verdict !== "execution-deviation") continue;
    const groupKey = `${entry.device ?? ""}|${entry.platform}`;
    const group =
      groups.get(groupKey) ??
      ({ device: entry.device, platform: entry.platform, count: 0, features: [], lastAt: null, notes: [] } satisfies {
        device: string | null;
        platform: string;
        count: number;
        features: string[];
        lastAt: string | null;
        notes: string[];
      });
    group.count += 1;
    const feature = entry.featureName ?? entry.featureKey ?? entry.caseId;
    if (!group.features.includes(feature)) group.features.push(feature);
    if (entry.verdictAt !== null && (group.lastAt === null || entry.verdictAt > group.lastAt)) {
      group.lastAt = entry.verdictAt;
    }
    if (entry.note !== null && !group.notes.includes(entry.note)) group.notes.push(entry.note);
    groups.set(groupKey, group);
  }

  const environment = [...groups.values()]
    .map((group) => ({ ...group, features: group.features.slice().sort() }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const aDevice = a.device ?? "";
      const bDevice = b.device ?? "";
      if (aDevice !== bDevice) return aDevice < bDevice ? -1 : 1;
      return a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0;
    });

  return { caseDefects, environment, appDefects };
}
