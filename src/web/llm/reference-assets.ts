import type { WebAssetRecord } from "../../db/types.js";

export interface ResolvedCaseReference {
  referencePath: string | null;
  referenceAssetId: string | null;
  /** 显式参考图未匹配时写入（不回退到 job 级，避免用错图）。 */
  missingReason?: string;
}

function stemOf(filename: string): string {
  return filename.trim().toLowerCase().replace(/\.[a-z0-9]+$/, "");
}

function latest(assets: WebAssetRecord[]): WebAssetRecord | null {
  if (assets.length === 0) return null;
  return [...assets].sort(
    (a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt)
  )[0]!;
}

/**
 * 逐例参考图解析：显式值优先（`asset:<id>` / 资产 ID / 文件名 / 去扩展名），
 * 空值回退 job 级 reference；显式值匹配不到时返回 missingReason，不静默换图。
 */
export function resolveCaseReference(input: {
  requested: string | null | undefined;
  assets: WebAssetRecord[];
  fallbackPath: string | null;
  fallbackAssetId: string | null;
}): ResolvedCaseReference {
  const raw = (input.requested ?? "").trim();
  if (raw === "") {
    return {
      referencePath: input.fallbackPath,
      referenceAssetId: input.fallbackAssetId
    };
  }
  const explicitId = raw.startsWith("asset:") ? raw.slice("asset:".length).trim() : raw;
  const byId = input.assets.find((asset) => asset.id === explicitId);
  if (byId !== undefined) {
    return { referencePath: byId.storagePath, referenceAssetId: byId.id };
  }
  if (!raw.startsWith("asset:")) {
    const lower = raw.toLowerCase();
    const byName = latest(
      input.assets.filter((asset) => asset.filename.trim().toLowerCase() === lower)
    );
    if (byName !== null) {
      return { referencePath: byName.storagePath, referenceAssetId: byName.id };
    }
    const stem = stemOf(raw);
    const byStem = latest(input.assets.filter((asset) => stemOf(asset.filename) === stem));
    if (byStem !== null) {
      return { referencePath: byStem.storagePath, referenceAssetId: byStem.id };
    }
  }
  return {
    referencePath: null,
    referenceAssetId: null,
    missingReason: `reference-asset-not-found:${raw}`
  };
}
