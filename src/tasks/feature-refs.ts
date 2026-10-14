export interface ResolvedTaskRef {
  caseSetId: string;
  featureKey: string;
  featureName: string;
  caseCount: number;
  jsonPath: string;
}

/** 引用解析：每个 feature key 取最新一份（listCaseSets 新→旧首次出现）。 */
export function latestFeatureRefs(
  sets: Array<{
    id: string;
    features: Array<{ key: string; name: string; caseCount: number; jsonPath: string }>;
  }>
): Map<string, ResolvedTaskRef> {
  const latest = new Map<string, ResolvedTaskRef>();
  for (const set of sets) {
    for (const feature of set.features) {
      if (latest.has(feature.key)) continue;
      latest.set(feature.key, {
        caseSetId: set.id,
        featureKey: feature.key,
        featureName: feature.name,
        caseCount: feature.caseCount,
        jsonPath: feature.jsonPath
      });
    }
  }
  return latest;
}
