import path from "node:path";

/** 跨项目功能对齐（回归服务 P3e）：归一化与分组均为纯函数，无 IO。 */

const FIGMA_PREFIX = "figma:";
const PEN_PREFIX = "pen:";
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

/** NFC → trim → 连续空白折叠单空格 → 小写。 */
export function normalizeFeatureName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** figma:<fileKey>[ (名)] → figma:<fileKey>；**先判 `figma:`/`pen:` 前缀**，其余**绝对路径** → path.relative(rootPath, src) posix+lower
 * （相对结果以 `..` 开头或仍为绝对路径（跨盘符）→ 原样 lower）；**非绝对但含分隔符** → 原样 posix+lower（不经 cwd 解析）；
 * pen:<rel> → 前缀后 trim 再 posix+lower（含分隔符仍走 pen 归一化）；其他 → lower。 */
export function normalizeDesignSource(source: string, rootPath: string): string {
  if (source.startsWith(FIGMA_PREFIX)) {
    const key = source.slice(FIGMA_PREFIX.length).trim().split(/\s+/)[0];
    return `${FIGMA_PREFIX}${key}`;
  }
  if (source.startsWith(PEN_PREFIX)) {
    return `${PEN_PREFIX}${toPosix(source.slice(PEN_PREFIX.length).trim()).toLowerCase()}`;
  }
  const pathApi = WINDOWS_ABSOLUTE.test(source) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(source)) {
    return source.includes("/") || source.includes("\\")
      ? toPosix(source).toLowerCase()
      : source.toLowerCase();
  }
  const relative = pathApi.relative(rootPath, source);
  if (isOutsideRoot(relative) || pathApi.isAbsolute(relative)) return source.toLowerCase();
  return toPosix(relative).toLowerCase();
}

export interface FeatureAlignmentEntry {
  project: string;
  featureKey: string;
  passRate: number | null;
  runs: number;
  flaky: number;
  pendingVerdicts: number;
  latestAt: string | null;
}

export interface FeatureAlignmentGroup {
  sourceLabel: string;
  displayName: string;
  entries: FeatureAlignmentEntry[];
}

export interface FeatureAlignmentInput {
  name: string;
  rootPath: string;
  runs: Array<{
    caseSetId: string | null;
    featureKey: string | null;
    featureName: string | null;
    passed: number;
    total: number;
    flaky: number;
    finishedAt: string;
    cases: Array<{ status: string; verdict: string | null }>;
  }>;
  sets: Array<{ id: string; source: string; features: Array<{ key: string; name: string }> }> | null;
}

export function alignFeatureRuns(projects: FeatureAlignmentInput[]): {
  groups: FeatureAlignmentGroup[];
  unmatched: number;
} {
  const byGroupKey = new Map<string, FeatureAccumulator[]>();
  for (const project of projects) {
    for (const feature of mergeProjectFeatures(project)) {
      const bucket = byGroupKey.get(feature.key);
      if (bucket === undefined) byGroupKey.set(feature.key, [feature]);
      else bucket.push(feature);
    }
  }

  const groups: FeatureAlignmentGroup[] = [];
  let unmatched = 0;
  for (const features of byGroupKey.values()) {
    if (features.length < 2) {
      unmatched += 1;
      continue;
    }
    features.sort(compareByProject);
    groups.push({
      sourceLabel: features[0].source,
      displayName: features[0].name,
      entries: features.map(toEntry)
    });
  }

  groups.sort(compareGroups);
  return { groups, unmatched };
}

interface FeatureUnit {
  featureKey: string;
  name: string;
  source: string;
  passed: number;
  total: number;
  runs: number;
  flaky: number;
  pendingVerdicts: number;
  latestAt: string;
}

interface FeatureAccumulator {
  key: string;
  project: string;
  featureKey: string;
  name: string;
  source: string;
  passed: number;
  total: number;
  runs: number;
  flaky: number;
  pendingVerdicts: number;
  latestAt: string;
}

function collectUnits(project: FeatureAlignmentInput): FeatureUnit[] {
  if (project.sets === null) return [];
  const setsById = new Map(project.sets.map((set) => [set.id, set]));
  const units = new Map<string, FeatureUnit>();

  for (const run of project.runs) {
    if (run.caseSetId === null || run.featureKey === null) continue;
    const set = setsById.get(run.caseSetId);
    if (set === undefined) continue;
    const frozenName = set.features.find((feature) => feature.key === run.featureKey)?.name;
    const name = frozenName === undefined || frozenName === "" ? run.featureName : frozenName;
    if (name === null || name === "") continue;

    /** 单位键 = caseSetId|featureKey；键成分（caseSetId/featureKey/source/name）不含 `|`，拼接不产生歧义。 */
    const key = `${run.caseSetId}|${run.featureKey}`;
    let unit = units.get(key);
    if (unit === undefined) {
      unit = {
        featureKey: run.featureKey,
        name,
        source: set.source,
        passed: 0,
        total: 0,
        runs: 0,
        flaky: 0,
        pendingVerdicts: 0,
        latestAt: run.finishedAt
      };
      units.set(key, unit);
    }
    unit.passed += run.passed;
    unit.total += run.total;
    unit.runs += 1;
    unit.flaky += run.flaky;
    unit.pendingVerdicts += run.cases.filter(isPendingVerdict).length;
    unit.latestAt = maxTimestamp(unit.latestAt, run.finishedAt);
  }

  return [...units.values()];
}

function mergeProjectFeatures(project: FeatureAlignmentInput): FeatureAccumulator[] {
  const merged = new Map<string, FeatureAccumulator>();

  for (const unit of collectUnits(project)) {
    /** 组键 = 归一化设计源|归一化功能名；键成分（caseSetId/featureKey/source/name）不含 `|`，拼接不产生歧义。 */
    const key = `${normalizeDesignSource(unit.source, project.rootPath)}|${normalizeFeatureName(unit.name)}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        key,
        project: project.name,
        featureKey: unit.featureKey,
        name: unit.name,
        source: unit.source,
        passed: unit.passed,
        total: unit.total,
        runs: unit.runs,
        flaky: unit.flaky,
        pendingVerdicts: unit.pendingVerdicts,
        latestAt: unit.latestAt
      });
      continue;
    }
    existing.passed += unit.passed;
    existing.total += unit.total;
    existing.runs += unit.runs;
    existing.flaky += unit.flaky;
    existing.pendingVerdicts += unit.pendingVerdicts;
    existing.latestAt = maxTimestamp(existing.latestAt, unit.latestAt);
  }

  return [...merged.values()];
}

function toEntry(feature: FeatureAccumulator): FeatureAlignmentEntry {
  return {
    project: feature.project,
    featureKey: feature.featureKey,
    passRate: feature.total > 0 ? feature.passed / feature.total : null,
    runs: feature.runs,
    flaky: feature.flaky,
    pendingVerdicts: feature.pendingVerdicts,
    latestAt: feature.latestAt
  };
}

function compareGroups(left: FeatureAlignmentGroup, right: FeatureAlignmentGroup): number {
  if (left.entries.length !== right.entries.length) {
    return right.entries.length - left.entries.length;
  }
  const leftRange = passRateRange(left);
  const rightRange = passRateRange(right);
  if (leftRange !== rightRange) return rightRange - leftRange;
  return compareStrings(left.displayName, right.displayName);
}

/** 组内非 null passRate 的极差；参与值 <2 → 0。 */
function passRateRange(group: FeatureAlignmentGroup): number {
  const rates = group.entries
    .map((entry) => entry.passRate)
    .filter((rate): rate is number => rate !== null);
  if (rates.length < 2) return 0;
  return Math.max(...rates) - Math.min(...rates);
}

function compareByProject(left: FeatureAccumulator, right: FeatureAccumulator): number {
  return compareStrings(left.project, right.project);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPendingVerdict(entry: { status: string; verdict: string | null }): boolean {
  return entry.status !== "passed" && entry.verdict === null;
}

function maxTimestamp(left: string, right: string): string {
  return left > right ? left : right;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function isOutsideRoot(relative: string): boolean {
  return relative === ".." || relative.startsWith("../") || relative.startsWith("..\\");
}
