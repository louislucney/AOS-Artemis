import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { errorMessage, log } from "../util.js";
import type { AuditEventInput, CaseSetFeatureRecord, ProjectStore } from "./types.js";

export const HYDRATE_MAX_CASE_SETS = 200;

/** 用例集自愈（DESIGN §13.125）：`.artemis/design/case-sets/*.json` → 台账登记。
 * 按 jsonPath 幂等（部分完成可继续重试）；超过上限的剩余份交由 `suite backfill`。 */
export async function hydrateProjectLedger(store: ProjectStore, rootPath: string): Promise<number> {
  const setsDir = path.join(rootPath, ".artemis", "design", "case-sets");
  let names: string[];
  try {
    names = (await readdir(setsDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;

  if ((await store.getProjectByPath(rootPath)) === null) {
    await store.upsertProject({ rootPath, name: path.basename(rootPath) });
  }

  const existing = await store.listCaseSets(rootPath);
  const known = new Set(existing.flatMap((record) => record.features.map((feature) => feature.jsonPath)));

  if (names.length > HYDRATE_MAX_CASE_SETS) {
    await safeAudit(store, rootPath, {
      domain: "registry",
      action: "hydrate.capped",
      result: "skipped",
      summary: `归档用例集 ${names.length} 份超出自动自愈上限 ${HYDRATE_MAX_CASE_SETS}，剩余请运行 suite backfill`
    });
  }

  let registered = 0;
  for (const name of names.slice(0, HYDRATE_MAX_CASE_SETS)) {
    const jsonPath = path.join(setsDir, name);
    if (known.has(jsonPath)) continue;
    try {
      const buffer = await readFile(jsonPath);
      const parsed = JSON.parse(buffer.toString("utf-8")) as Record<string, unknown>;
      const features = Array.isArray(parsed.features)
        ? (parsed.features as Array<Record<string, unknown>>)
        : [];
      const first = features[0];
      const key = typeof first?.key === "string" ? first.key : "";
      const featureName = typeof first?.name === "string" ? first.name : "";
      if (key === "" || featureName === "") continue;
      const flows = Array.isArray(parsed.flows) ? (parsed.flows as Array<Record<string, unknown>>) : [];
      const declared = declaredScreens(first);
      const info = await stat(jsonPath);
      const feature: CaseSetFeatureRecord = {
        key,
        name: featureName,
        caseCount: flows.length,
        screens: declared.length > 0 ? declared : collectScreens(flows),
        jsonPath,
        mdPath: jsonPath.replace(/\.json$/, ".md"),
        xlsxPath: jsonPath.replace(/\.json$/, ".xlsx")
      };
      await store.recordCaseSet({
        rootPath,
        source: typeof parsed.source === "string" ? parsed.source : "hydrate",
        designName: null,
        fingerprint: createHash("sha256").update(buffer).digest("hex"),
        basename: name.slice(0, -".json".length),
        createdAt: info.mtime.toISOString(),
        features: [feature]
      });
      registered += 1;
    } catch (error) {
      log(`用例集自愈跳过（${jsonPath}）：${errorMessage(error)}`);
    }
  }

  if (registered > 0) {
    await safeAudit(store, rootPath, {
      domain: "registry",
      action: "hydrate.registered",
      result: "ok",
      summary: `自愈登记 ${registered} 份用例集`,
      refs: { count: String(registered) }
    });
  }
  return registered;
}

/** 归档 features[0].screens（功能组屏集）优先；缺省回退用例覆盖屏并集。 */
function declaredScreens(first: Record<string, unknown> | undefined): string[] {
  const raw = first?.screens;
  if (!Array.isArray(raw)) return [];
  const screens = new Set<string>();
  for (const screen of raw) {
    if (typeof screen === "string" && screen !== "") screens.add(screen);
  }
  return [...screens];
}

function collectScreens(flows: Array<Record<string, unknown>>): string[] {
  const screens = new Set<string>();
  for (const flow of flows) {
    const value = flow.screen ?? flow.screens;
    if (typeof value === "string") {
      screens.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") screens.add(item);
      }
    }
  }
  return [...screens];
}

async function safeAudit(store: ProjectStore, rootPath: string, input: AuditEventInput): Promise<void> {
  try {
    await store.recordAudit(rootPath, input);
  } catch (error) {
    log(`用例集自愈审计写入失败（忽略）：${errorMessage(error)}`);
  }
}
