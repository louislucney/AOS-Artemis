import fs from "node:fs";
import path from "node:path";

import { CrashIndexStore } from "../crash/store.js";
import {
  resolveDesignWarnings,
  type WarningSummary
} from "../design/warnings.js";
import { collectVisualHotspots } from "../figma/generation-feedback.js";
import { scanVisionHealth, type VisionHealth } from "../ios/vision-health.js";
import { loadReconciliation, reconciliationFilePath } from "../figma/reconciliation.js";
import {
  buildRetentionReport,
  collectRetentionEntries,
  type RetentionCategorySummary
} from "../figma/retention.js";
import { errorMessage } from "../util.js";

/** 总览面板磁盘资产聚合（overview-panel T6，DESIGN §13.103）：崩溃签名 / 对账 /
 * 设备基线热点 / 保留期摘要——全部只读、无副作用；单项失败如实降级（warnings）。 */

export interface PanelCrashSignatureView {
  id: string;
  kind: string;
  package: string;
  exceptionClass: string;
  occurrences: number;
  lastSeenAt: string;
}

export interface PanelCrashSummaryView {
  total: number;
  recent: PanelCrashSignatureView[];
}

export interface PanelReconciliationView {
  present: boolean;
  updatedAt: string | null;
  edges: number;
  byStatus: { pending: number; upgraded: number; confirmed: number; rejected: number };
  runtimeOnly: number;
}

export interface PanelBaselineHotspotView {
  serial: string;
  caseId: string;
  step: number;
  regions: number;
  categories: string[];
}

export interface PanelBaselineView {
  count: number;
  hotspots: PanelBaselineHotspotView[];
}

export interface PanelRetentionView {
  days: number;
  overdue: { count: number; totalBytes: number };
  categories: Array<Pick<RetentionCategorySummary, "id" | "total" | "overdue" | "overdueBytes">>;
}

export interface PanelDesignWarningsView extends WarningSummary {
  source: "tests" | "flows";
}

export interface PanelDiskAssets {
  crashes: PanelCrashSummaryView | null;
  reconciliation: PanelReconciliationView | null;
  baselines: PanelBaselineView | null;
  retention: PanelRetentionView | null;
  /** 当前设计源警告快照（tests 优先、flows 回退）；无快照 → null（不折算成 0 条）。 */
  designWarnings: PanelDesignWarningsView | null;
  /** iOS 多模态降级（只读 trace 扫描；无 trace → 0/0，不是错误）。 */
  vision: VisionHealth | null;
  warnings: string[];
}

export const PANEL_RETENTION_DAYS_DEFAULT = 90;
export const PANEL_CRASH_LIMIT = 20;
export const PANEL_BASELINE_HOTSPOT_LIMIT = 10;

export async function collectDiskAssets(input: {
  configDirAbs: string;
  projectRoot: string;
  nowMs: number;
  retentionDays?: number;
}): Promise<PanelDiskAssets> {
  const warnings: string[] = [];

  let crashes: PanelCrashSummaryView | null = null;
  try {
    const store = new CrashIndexStore(path.join(input.configDirAbs, "crashes"));
    const listed = store.list({ limit: PANEL_CRASH_LIMIT });
    crashes = {
      total: listed.total,
      recent: listed.records.map((record) => ({
        id: record.id,
        kind: record.kind,
        package: record.package,
        exceptionClass: record.exceptionClass,
        occurrences: record.occurrences,
        lastSeenAt: record.lastSeenAt
      }))
    };
  } catch (error) {
    warnings.push(`崩溃索引读取失败：${errorMessage(error)}`);
  }

  let reconciliation: PanelReconciliationView | null = null;
  try {
    const present = fs.existsSync(reconciliationFilePath(input.configDirAbs));
    const asset = loadReconciliation(input.configDirAbs);
    const byStatus = { pending: 0, upgraded: 0, confirmed: 0, rejected: 0 };
    let runtimeOnly = 0;
    for (const edge of asset.edges) {
      byStatus[edge.status] += 1;
      if (edge.direction === "runtime-only") runtimeOnly += 1;
    }
    reconciliation = {
      present,
      updatedAt: asset.updatedAt,
      edges: asset.edges.length,
      byStatus,
      runtimeOnly
    };
  } catch (error) {
    warnings.push(`对账信息读取失败：${errorMessage(error)}`);
  }

  let baselines: PanelBaselineView | null = null;
  try {
    const hotspots = collectVisualHotspots(input.configDirAbs);
    baselines = {
      count: hotspots.length,
      hotspots: hotspots.slice(0, PANEL_BASELINE_HOTSPOT_LIMIT).map((hotspot) => ({
        serial: hotspot.serial,
        caseId: hotspot.caseId,
        step: hotspot.stepNumber,
        regions: hotspot.regions,
        categories: hotspot.categories
      }))
    };
  } catch (error) {
    warnings.push(`基线热点扫描失败：${errorMessage(error)}`);
  }

  let retention: PanelRetentionView | null = null;
  try {
    const days = input.retentionDays ?? PANEL_RETENTION_DAYS_DEFAULT;
    const entries = collectRetentionEntries(input.projectRoot);
    const report = buildRetentionReport(entries, {
      days,
      nowMs: input.nowMs,
      limit: 5,
      projectRoot: input.projectRoot
    });
    retention = {
      days,
      overdue: { count: report.overdue.count, totalBytes: report.overdue.totalBytes },
      categories: report.categories.map((category) => ({
        id: category.id,
        total: category.total,
        overdue: category.overdue,
        overdueBytes: category.overdueBytes
      }))
    };
  } catch (error) {
    warnings.push(`保留期扫描失败：${errorMessage(error)}`);
  }

  let designWarnings: PanelDesignWarningsView | null = null;
  try {
    const resolved = resolveDesignWarnings(input.configDirAbs);
    if (resolved.source !== "none") {
      designWarnings = { ...resolved.summary, source: resolved.source };
    }
  } catch (error) {
    warnings.push(`设计源警告读取失败：${errorMessage(error)}`);
  }

  let vision: VisionHealth | null = null;
  try {
    vision = scanVisionHealth(path.join(input.configDirAbs, "traces"), { limit: 50, recentLimit: 5 });
  } catch (error) {
    warnings.push(`视觉降级扫描失败：${errorMessage(error)}`);
  }

  return { crashes, reconciliation, baselines, retention, designWarnings, vision, warnings };
}
