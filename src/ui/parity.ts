import type { Bbox } from "../diff/engine.js";
import type { UiScreenContract } from "./contract.js";
import {
  normalizeUiText,
  type UiDataProfile,
  type UiRegionRole,
  type UiRegionSemantics,
  type UiScreenSemantics,
  type UiTaxonomyNode,
  type UiViewport
} from "./semantics.js";
import { matchesDynamicExample, matchesDynamicPattern } from "./semantics.js";

export { normalizeUiText };

export interface UiRuntimeText {
  text: string;
  bbox?: Bbox;
  space?: "content" | "viewport";
  visible?: boolean;
  source?: "ax" | "visual" | "manual";
}

export interface UiRuntimeAsset {
  kind: "image" | "banner" | "icon";
  bbox?: Bbox;
  space?: "content" | "viewport";
  present: boolean;
  placeholder?: boolean;
  source?: "ax" | "visual" | "manual";
}

export interface UiParityInput {
  screen: UiScreenContract;
  semantics: UiScreenSemantics | null;
  /** 文件级 draft；true 时不得给 layout-compatible。 */
  draft?: boolean;
  runtime: {
    screen?: string;
    viewport?: UiViewport;
    texts: UiRuntimeText[];
    assets?: UiRuntimeAsset[];
    /** 运行时文本空间；trace AX 树通常为 content。 */
    space?: "content" | "viewport";
    /** 调用方声明这次文本覆盖是完整的（region-scoped/全量内容树）。 */
    coverageComplete?: boolean;
    /** 只审计该 region（taxonomy/expectedCount 用）；缺省审计全部。 */
    regionId?: string;
  };
}

export type UiParityVerdict =
  | "layout-compatible"
  | "data-diff"
  | "truncated-labels"
  | "ia-mismatch"
  | "no-invariants"
  | "insufficient-data"
  | "insufficient-coverage";

export interface UiParityFinding {
  kind:
    | "missing-invariant"
    | "truncated-label"
    | "dynamic-diff"
    | "role-mismatch"
    | "role-ambiguous"
    | "unexpected-runtime-text"
    | "expected-count-mismatch"
    | "viewport-mismatch"
    | "missing-semantics"
    | "coverage-gap"
    | "taxonomy-mismatch"
    | "missing-asset"
    | "placeholder-asset";
  severity: "info" | "warning" | "error";
  text: string;
  designText?: string;
  runtimeText?: string;
  role?: UiRegionRole;
  baselined?: boolean;
}

export interface UiParityReport {
  ok: boolean;
  verdict: UiParityVerdict;
  screenId: string;
  dataProfile?: UiDataProfile;
  counts: {
    invariant: number;
    matched: number;
    missing: number;
    truncated: number;
    dynamic: number;
    unexpected: number;
    visible: number;
    unverified: number;
    offscreen: number;
    taxonomyExpected: number;
    taxonomyMatched: number;
    taxonomyMissing: number;
    taxonomyUnexpected: number;
    assetsExpected: number;
    assetsPresent: number;
    assetsMissing: number;
    assetsPlaceholder: number;
  };
  findings: UiParityFinding[];
  warnings: string[];
}

interface FlatInvariant {
  label: string;
  aliases: string[];
  region: UiRegionSemantics;
  taxonomy: boolean;
}

interface TaxonomyEntry {
  node: UiTaxonomyNode;
  region: UiRegionSemantics;
}

type InvariantStatus = "matched" | "missing" | "truncated" | "unverified" | "offscreen";

function compact(value: string): string {
  return normalizeUiText(value).replace(/\s+/g, "");
}

function isVisualSource(text: UiRuntimeText): boolean {
  return (text.source ?? "manual") !== "ax";
}

function isVisible(text: UiRuntimeText, viewport: UiViewport | undefined): boolean {
  if (text.visible === false) return false;
  if (text.visible === true) return true;
  if (text.space === "content") return true;
  if (text.bbox === undefined || viewport === undefined) return true;
  return (
    text.bbox.x < viewport.width &&
    text.bbox.y < viewport.height &&
    text.bbox.x + text.bbox.width > 0 &&
    text.bbox.y + text.bbox.height > 0
  );
}

function flattenTaxonomy(nodes: readonly UiTaxonomyNode[] | undefined, region: UiRegionSemantics): TaxonomyEntry[] {
  const out: TaxonomyEntry[] = [];
  const walk = (entries: readonly UiTaxonomyNode[] | undefined): void => {
    for (const node of entries ?? []) {
      out.push({ node, region });
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function taxonomyAliases(node: UiTaxonomyNode): string[] {
  return [node.label, ...(node.aliases ?? [])].map(compact).filter(Boolean);
}

function matchesLabel(text: UiRuntimeText, label: string, aliases: readonly string[] = []): boolean {
  const value = compact(text.text);
  if (value === "") return false;
  const labelKey = compact(label);
  if (value === labelKey) return true;
  return aliases.some((alias) => compact(alias) === value);
}

function isTruncatedOf(text: string, label: string): boolean {
  const runtime = compact(text);
  const design = compact(label);
  if (runtime === "" || design === "") return false;

  const tail = runtime.endsWith("…") ? runtime.slice(0, -1) : runtime.endsWith("...") ? runtime.slice(0, -3) : "";
  if (tail.length >= 3 && design.startsWith(tail)) return true;

  const segments = runtime.split(/…|\.\.\./u).filter((segment) => segment !== "");
  if (segments.length < 2) return false;
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  return first.length >= 1 && last.length >= 2 && design.startsWith(first) && design.endsWith(last);
}

function centerInsideBox(inner: Bbox, outer: Bbox): boolean {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
}

function centerInside(text: UiRuntimeText, box: Bbox): boolean {
  return text.bbox !== undefined && centerInsideBox(text.bbox, box);
}

function boxesIntersect(left: Bbox, right: Bbox): boolean {
  return (
    left.x < right.x + right.width &&
    left.y < right.y + right.height &&
    left.x + left.width > right.x &&
    left.y + left.height > right.y
  );
}

function area(box: Bbox): number {
  return box.width * box.height;
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

export function auditUiParity(input: UiParityInput): UiParityReport {
  const screenId = input.semantics?.screenId ?? input.screen.id;
  const emptyCounts: UiParityReport["counts"] = {
    invariant: 0,
    matched: 0,
    missing: 0,
    truncated: 0,
    dynamic: 0,
    unexpected: 0,
    visible: 0,
    unverified: 0,
    offscreen: 0,
    taxonomyExpected: 0,
    taxonomyMatched: 0,
    taxonomyMissing: 0,
    taxonomyUnexpected: 0,
    assetsExpected: 0,
    assetsPresent: 0,
    assetsMissing: 0,
    assetsPlaceholder: 0
  };

  if (input.semantics === null) {
    return {
      ok: false,
      verdict: "insufficient-data",
      screenId,
      counts: emptyCounts,
      findings: [
        {
          kind: "missing-semantics",
          severity: "error",
          text: "该屏没有 ui-semantics；结构未校验"
        }
      ],
      warnings: []
    };
  }
  if (input.draft === true) {
    return {
      ok: false,
      verdict: "no-invariants",
      screenId,
      counts: emptyCounts,
      findings: [],
      warnings: ["semantics 仍是 draft（owner 未确认）；结构未实际验证，不能假绿"]
    };
  }

  const semantics = input.semantics;
  const allRegions = semantics.regions;
  const regions =
    input.runtime.regionId === undefined
      ? allRegions
      : allRegions.filter((region) => region.id === input.runtime.regionId);
  const warnings: string[] = [];
  if (input.runtime.regionId !== undefined && regions.length === 0) {
    warnings.push(`region-not-found: ${input.runtime.regionId}`);
  }

  const taxonomyEntries = regions.flatMap((region) => flattenTaxonomy(region.taxonomy, region));
  const taxonomyKeys = new Set(
    taxonomyEntries.flatMap((entry) =>
      taxonomyAliases(entry.node).map((alias) => `${entry.region.id}:${alias}`)
    )
  );
  const flatInvariants: FlatInvariant[] = [];
  for (const region of regions) {
    const seenLabels = new Set<string>();
    for (const label of region.invariantTexts ?? []) {
      const labelKey = compact(label);
      if (seenLabels.has(labelKey)) continue;
      seenLabels.add(labelKey);
      if (taxonomyKeys.has(`${region.id}:${labelKey}`)) continue;
      const aliases = semantics.displayNames?.[label] ?? [];
      flatInvariants.push({ label, aliases, region, taxonomy: false });
    }
  }
  const invariants: FlatInvariant[] = [
    ...taxonomyEntries.map((entry) => ({
      label: entry.node.label,
      aliases: entry.node.aliases ?? [],
      region: entry.region,
      taxonomy: true
    })),
    ...flatInvariants
  ];

  if (invariants.length === 0) {
    return {
      ok: false,
      verdict: "no-invariants",
      screenId,
      ...(semantics.dataProfile !== undefined ? { dataProfile: semantics.dataProfile } : {}),
      counts: emptyCounts,
      findings: [],
      warnings: ["该屏未定义任何 invariant，结构未实际验证"]
    };
  }

  const texts = input.runtime.texts;
  const viewport = input.runtime.viewport ?? semantics.viewport;
  const visibleFlags = texts.map((text) => isVisible(text, viewport));
  const consumed = new Set<number>();
  const dynamicIndices = new Set<number>();
  let taxonomyMatched = 0;

  for (const entry of taxonomyEntries) {
    const aliases = taxonomyAliases(entry.node);
    let matched = false;
    for (const [index, text] of texts.entries()) {
      if (aliases.includes(compact(text.text))) {
        matched = true;
        consumed.add(index);
      }
    }
    if (matched) taxonomyMatched += 1;
  }

  for (const [index, text] of texts.entries()) {
    if (dynamicIndices.has(index)) continue;
    for (const region of regions) {
      const examples = region.dynamicExamples ?? [];
      const patternHit = matchesDynamicPattern(text.text, region.dynamicPatterns ?? []);
      const exampleHit = examples.some((example) => matchesDynamicExample(text.text, example));
      if (patternHit || exampleHit) {
        dynamicIndices.add(index);
        consumed.add(index);
        break;
      }
    }
  }

  const findings: UiParityFinding[] = [];
  let matched = 0;
  let missing = 0;
  let truncated = 0;
  let unverified = 0;
  let offscreen = 0;
  let roleErrors = 0;
  const matchedByRegion = new Map<string, number>();
  const visibleOccurrencesByRegion = new Map<string, number>();

  const containingRegions = (text: UiRuntimeText): UiRegionSemantics[] => {
    if (text.space === "content" || text.bbox === undefined) return [];
    return regions
      .filter((region) => region.deviceBbox !== undefined && centerInside(text, region.deviceBbox))
      .sort((a, b) => area(a.deviceBbox!) - area(b.deviceBbox!));
  };
  const viewportMismatch =
    semantics.viewport !== undefined &&
    viewport !== undefined &&
    (Math.abs(semantics.viewport.width - viewport.width) > 1 ||
      Math.abs(semantics.viewport.height - viewport.height) > 1);
  if (viewportMismatch) {
    warnings.push("viewport-mismatch: semantics.viewport 与运行时视口不一致，role 检查降级为 warning");
    findings.push({
      kind: "viewport-mismatch",
      severity: "warning",
      text: `视口不一致：semantics ${semantics.viewport!.width}×${semantics.viewport!.height} vs runtime ${viewport!.width}×${viewport!.height}`
    });
  }

  for (const invariant of invariants) {
    const matching = texts
      .map((text, index) => ({ text, index, visible: visibleFlags[index] === true }))
      .filter((entry) => matchesLabel(entry.text, invariant.label, invariant.aliases));
    const visibleMatches = matching.filter((entry) => entry.visible);
    const requiresVisual = invariant.region.role === "category-list" || invariant.region.taxonomy !== undefined;
    let status: InvariantStatus;

    if (visibleMatches.length > 0) {
      const allAx = visibleMatches.every((entry) => !isVisualSource(entry.text));
      if (requiresVisual && allAx) {
        status = "unverified";
        warnings.push("visual-truncation-unverified: AX 文本无法证明未截断，请提供 source:\"visual\" 文本");
      } else {
        status = "matched";
      }
    } else if (matching.length > 0) {
      status = "offscreen";
    } else {
      const truncationLabels = [invariant.label, ...invariant.aliases];
      const truncatedIndex = texts.findIndex(
        (text, index) =>
          visibleFlags[index] === true &&
          (isVisualSource(text) || /…|\.\.\./u.test(text.text)) &&
          truncationLabels.some((label) => isTruncatedOf(text.text, label))
      );
      const truncatedText = truncatedIndex >= 0 ? texts[truncatedIndex] : undefined;
      if (truncatedText !== undefined) {
        status = "truncated";
        consumed.add(truncatedIndex);
        findings.push({
          kind: "truncated-label",
          severity: "error",
          text: `分类/标签被截断：${invariant.label}`,
          designText: invariant.label,
          runtimeText: truncatedText.text,
          role: invariant.region.role
        });
      } else if (
        input.runtime.regionId === invariant.region.id ||
        input.runtime.space === "content" ||
        input.runtime.coverageComplete === true
      ) {
        status = "missing";
      } else {
        status = "unverified";
        warnings.push("coverage-incomplete: 视口快照缺少该 invariant，不能判定缺失或屏外");
      }
    }

    if (status === "matched") {
      matched += 1;
      matchedByRegion.set(invariant.region.id, (matchedByRegion.get(invariant.region.id) ?? 0) + 1);
      visibleOccurrencesByRegion.set(
        invariant.region.id,
        (visibleOccurrencesByRegion.get(invariant.region.id) ?? 0) + visibleMatches.length
      );
    } else if (status === "missing") {
      missing += 1;
      findings.push({
        kind: "missing-invariant",
        severity: "error",
        text: `缺少设计元素：${invariant.label}`,
        designText: invariant.label,
        role: invariant.region.role
      });
    } else if (status === "truncated") truncated += 1;
    else if (status === "unverified") unverified += 1;
    else offscreen += 1;

    if (status === "matched" && visibleMatches.length > 0) {
      for (const entry of visibleMatches) {
        consumed.add(entry.index);
        if (invariant.region.deviceBbox === undefined) continue;
        const containing = containingRegions(entry.text);
        const inExpected = containing.find((region) => region.id === invariant.region.id);
        if (inExpected !== undefined) {
          if (containing.length > 1) {
            findings.push({
              kind: "role-ambiguous",
              severity: "info",
              text: `同一文本跨多个 region：${invariant.label}`,
              designText: invariant.label,
              runtimeText: entry.text.text
            });
          }
          continue;
        }
        if (containing.length === 0) {
          const intersecting = regions.filter(
            (region) =>
              region.deviceBbox !== undefined &&
              entry.text.bbox !== undefined &&
              boxesIntersect(entry.text.bbox, region.deviceBbox)
          );
          if (intersecting.length === 0) {
            if (!viewportMismatch) roleErrors += 1;
            findings.push({
              kind: "role-mismatch",
              severity: viewportMismatch ? "warning" : "error",
              text: `角色无法归属：${invariant.label} 不在任何 region 内`,
              designText: invariant.label,
              runtimeText: entry.text.text,
              role: invariant.region.role
            });
          }
          continue;
        }
        const allowed = containing.some(
          (assigned) =>
            (invariant.region.allowedRoles ?? []).includes(assigned.role) ||
            (assigned.allowedRoles ?? []).includes(invariant.region.role) ||
            invariant.region.allowDuplicates === true ||
            assigned.allowDuplicates === true
        );
        if (!allowed) {
          if (!viewportMismatch) roleErrors += 1;
          findings.push({
            kind: "role-mismatch",
            severity: viewportMismatch ? "warning" : "error",
            text: `角色不匹配：${invariant.label} 落在 ${containing[0]!.role}`,
            designText: invariant.label,
            runtimeText: entry.text.text,
            role: containing[0]!.role
          });
        }
      }
    } else {
      for (const entry of matching) consumed.add(entry.index);
    }
  }

  for (const region of regions) {
    if (region.expectedOccurrences === undefined) continue;
    const actualOccurrences = visibleOccurrencesByRegion.get(region.id) ?? 0;
    if (actualOccurrences !== region.expectedOccurrences) {
      findings.push({
        kind: "expected-count-mismatch",
        severity: "warning",
        text: `期望出现 ${region.expectedOccurrences} 次，实际 ${actualOccurrences} 次`,
        role: region.role
      });
    }
  }

  if (texts.some((text) => text.space === "content")) {
    warnings.push("coordinate-space-mismatch: content-space text 只做文本级校验，role 几何跳过");
  }
  if (regions.some((region) => region.deviceBbox === undefined) && texts.some((text) => text.space !== "content")) {
    warnings.push("coordinate-coverage-missing: 部分 region 没有 deviceBbox，role 检查降级");
  }

  const scopeRegion =
    input.runtime.regionId !== undefined
      ? regions.find((region) => region.id === input.runtime.regionId) ?? null
      : regions.find((region) => region.taxonomy !== undefined) ?? null;
  const unexpectedTexts: UiRuntimeText[] = [];
  for (const [index, text] of texts.entries()) {
    if (consumed.has(index) || dynamicIndices.has(index)) continue;
    if (!visibleFlags[index]) continue;
    const inDynamicRegion = regions.some(
      (region) =>
        (region.isDynamic === true || region.dynamicAssets === true) &&
        ((region.deviceBbox !== undefined &&
          text.space !== "content" &&
          text.bbox !== undefined &&
          centerInside(text, region.deviceBbox)) ||
          (input.runtime.regionId === region.id && region.deviceBbox === undefined))
    );
    if (inDynamicRegion) {
      dynamicIndices.add(index);
      continue;
    }
    if (scopeRegion !== null) {
      if (scopeRegion.deviceBbox === undefined) {
        // 无 bbox 时不能判断文本是否属于该 region；不臆造 unexpected。
        continue;
      }
      if (text.space === "content" || text.bbox === undefined || !centerInside(text, scopeRegion.deviceBbox)) {
        continue;
      }
    }
    unexpectedTexts.push(text);
    findings.push({
      kind: "unexpected-runtime-text",
      severity: "warning",
      text: `运行时多出未注册文本：${text.text}`,
      runtimeText: text.text
    });
  }

  const taxonomyMissing = Math.max(0, taxonomyEntries.length - taxonomyMatched);
  const taxonomyUnexpected = taxonomyEntries.length > 0 ? unexpectedTexts.length : 0;
  if (taxonomyEntries.length > 0 && (taxonomyMissing > 0 || taxonomyUnexpected > 0)) {
    findings.push({
      kind: "taxonomy-mismatch",
      severity: taxonomyMissing > 0 ? "error" : "warning",
      text: `分类树不一致：设计 ${taxonomyEntries.length} 项，匹配 ${taxonomyMatched}，缺失 ${taxonomyMissing}，多出 ${taxonomyUnexpected}`
    });
  }

  for (const region of regions) {
    if (region.expectedCount === undefined) continue;
    const actual = matchedByRegion.get(region.id) ?? 0;
    if (region.expectedCount !== actual) {
      findings.push({
        kind: "expected-count-mismatch",
        severity: "warning",
        text: `期望 ${region.expectedCount} 项，实际匹配 ${actual} 项`,
        role: region.role
      });
    }
  }

  let assetsExpected = 0;
  let assetsPresent = 0;
  let assetsMissing = 0;
  let assetsPlaceholder = 0;
  if (input.runtime.assets === undefined) {
    for (const region of regions) {
      const expected = region.expectedAssets ?? 0;
      if (expected > 0) {
        assetsExpected += expected;
        assetsMissing += expected;
        findings.push({
          kind: "missing-asset",
          severity: "error",
          text: `动态资产未提供：期望 ${expected}，runtime.assets 缺失`,
          role: region.role
        });
      }
    }
  } else {
    for (const region of regions) {
      const expected = region.expectedAssets ?? 0;
      if (expected <= 0) continue;
      assetsExpected += expected;
      const assets = input.runtime.assets.filter(
        (asset) =>
          asset.present &&
          (region.deviceBbox === undefined ||
            asset.bbox === undefined ||
            centerInsideBox(asset.bbox, region.deviceBbox))
      );
      const present = assets.length;
      const placeholder = assets.filter((asset) => asset.placeholder === true).length;
      assetsPresent += present;
      assetsPlaceholder += placeholder;
      const missingAssets = Math.max(0, expected - present);
      assetsMissing += missingAssets;
      if (missingAssets > 0) {
        findings.push({
          kind: "missing-asset",
          severity: "error",
          text: `动态资产缺失：期望 ${expected}，实际 ${present}`,
          role: region.role
        });
      }
      if (placeholder > 0) {
        findings.push({
          kind: "placeholder-asset",
          severity: "error",
          text: `动态资产是 placeholder：${placeholder}`,
          role: region.role
        });
      }
    }
  }

  const visible = matched + missing + truncated;
  const counts: UiParityReport["counts"] = {
    invariant: invariants.length,
    matched,
    missing,
    truncated,
    dynamic: dynamicIndices.size,
    unexpected: unexpectedTexts.length,
    visible,
    unverified,
    offscreen,
    taxonomyExpected: taxonomyEntries.length,
    taxonomyMatched,
    taxonomyMissing,
    taxonomyUnexpected,
    assetsExpected,
    assetsPresent,
    assetsMissing,
    assetsPlaceholder
  };

  let verdict: UiParityVerdict;
  if (
    missing > 0 ||
    roleErrors > 0 ||
    taxonomyMissing > 0 ||
    taxonomyUnexpected > 0 ||
    assetsMissing > 0 ||
    assetsPlaceholder > 0
  ) {
    verdict = "ia-mismatch";
  } else if (truncated > 0) {
    verdict = "truncated-labels";
  } else if (unverified > 0 || offscreen > 0) {
    verdict = "insufficient-coverage";
  } else if (dynamicIndices.size > 0) {
    verdict = "data-diff";
  } else {
    verdict = "layout-compatible";
  }
  const ok = (verdict === "layout-compatible" || verdict === "data-diff") && unverified === 0 && offscreen === 0;

  return {
    ok,
    verdict,
    screenId,
    ...(semantics.dataProfile !== undefined ? { dataProfile: semantics.dataProfile } : {}),
    counts,
    findings,
    warnings: uniqueWarnings(warnings)
  };
}
