import type { CaseVerdict } from "../db/types.js";
import { errorMessage } from "../util.js";
import { resolveProjectKey, type PanelWebDeps, type PanelWebResponse } from "./web.js";

/** 面板动作层（DESIGN：回归服务 §5.4）：仅 HTTP 模式接线；v1 内网无鉴权
 * （`AOS_PANEL_ACTIONS=0` 整体关闭）。body 为已解析 JSON（http-server readBody 语义）。 */
export interface PanelActionRequest {
  method: string;
  url: URL;
  body: unknown;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_REFS = 100;
const MAX_VERDICT_ITEMS = 500;

const CASE_VERDICTS = new Set<CaseVerdict>([
  "case-defect",
  "execution-deviation",
  "app-defect",
  "uncertain"
]);
const PLATFORMS = new Set(["ios", "android"]);

export function panelActionsEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_PANEL_ACTIONS;
  return typeof raw !== "string" || raw.trim() !== "0";
}

function json(status: number, payload: unknown): PanelWebResponse {
  return { status, contentType: JSON_CONTENT_TYPE, body: JSON.stringify(payload, null, 2) };
}

export async function handlePanelActionRequest(
  request: PanelActionRequest,
  deps: PanelWebDeps
): Promise<PanelWebResponse> {
  const env = deps.env ?? process.env;
  if (!panelActionsEnabled(env)) return json(404, { error: "not found" });
  if (!request.url.pathname.startsWith("/panel/api/")) return json(404, { error: "not found" });
  if (request.method !== "POST") return json(405, { error: "method not allowed (POST)" });
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return json(400, { error: "invalid JSON body" });
  }
  const payload = request.body as Record<string, unknown>;
  const projectKey = typeof payload.project === "string" ? payload.project.trim() : "";
  if (projectKey === "") return json(400, { error: "缺少 project" });
  const resolved = await resolveProjectKey(deps, projectKey);
  if (!resolved) return json(404, { error: `未知项目 "${projectKey}"` });

  try {
    if (request.url.pathname === "/panel/api/tasks") {
      return await createTask(deps, resolved.rootPath, payload);
    }
    if (request.url.pathname === "/panel/api/verdicts") {
      return await saveVerdicts(deps, resolved.rootPath, payload);
    }
    return json(404, { error: "not found" });
  } catch (error) {
    return json(500, { ok: false, error: errorMessage(error) });
  }
}

async function createTask(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const rawRefs = Array.isArray(payload.refs) ? payload.refs : [];
  const refs: Array<{ caseSetId: string; featureKey: string }> = [];
  for (const entry of rawRefs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { caseSetId?: unknown; featureKey?: unknown };
    if (typeof record.caseSetId !== "string" || record.caseSetId === "") continue;
    if (typeof record.featureKey !== "string" || record.featureKey === "") continue;
    refs.push({ caseSetId: record.caseSetId, featureKey: record.featureKey });
  }
  if (refs.length === 0) return json(400, { error: "refs 为空或格式非法" });
  if (refs.length > MAX_REFS) return json(400, { error: `refs 数量超过上限 ${MAX_REFS}` });

  const sets = await deps.store.listCaseSets(rootPath, 50);
  const known = new Set(
    sets.flatMap((set) => set.features.map((feature) => `${set.id}|${feature.key}`))
  );
  const unknown = refs.filter((ref) => !known.has(`${ref.caseSetId}|${ref.featureKey}`));
  if (unknown.length > 0) {
    return json(400, {
      error: `未知引用份：${unknown.map((ref) => ref.featureKey).join("、")}（先重新生成/登记用例集）`
    });
  }

  const rawPlatforms = Array.isArray(payload.platforms) ? payload.platforms : undefined;
  const platforms = rawPlatforms === undefined ? ["ios", "android"] : rawPlatforms;
  if (
    platforms.length === 0 ||
    platforms.some((platform) => typeof platform !== "string" || !PLATFORMS.has(platform))
  ) {
    return json(400, { error: "platforms 仅支持 ios/android" });
  }
  if (
    payload.baseline !== undefined &&
    payload.baseline !== "latest" &&
    payload.baseline !== "none"
  ) {
    return json(400, { error: "baseline 仅支持 latest/none" });
  }
  const baseline = payload.baseline === "none" ? "none" : "latest";

  const task = await deps.store.createRegressionTask({
    rootPath,
    refs,
    platforms: platforms as string[],
    baseline,
    createdBy: "panel"
  });
  return json(200, { ok: true, task });
}

async function saveVerdicts(
  deps: PanelWebDeps,
  rootPath: string,
  payload: Record<string, unknown>
): Promise<PanelWebResponse> {
  const verdict = payload.verdict;
  if (typeof verdict !== "string" || !CASE_VERDICTS.has(verdict as CaseVerdict)) {
    return json(400, {
      error: "verdict 仅支持 case-defect/execution-deviation/app-defect/uncertain"
    });
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: Array<{ runId: string; caseId: string }> = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { runId?: unknown; caseId?: unknown };
    if (typeof record.runId !== "string" || typeof record.caseId !== "string") continue;
    items.push({ runId: record.runId, caseId: record.caseId });
  }
  if (items.length === 0) return json(400, { error: "items 为空或格式非法" });
  if (items.length > MAX_VERDICT_ITEMS) {
    return json(400, { error: `items 数量超过上限 ${MAX_VERDICT_ITEMS}` });
  }
  const note =
    typeof payload.note === "string" && payload.note.trim() !== "" ? payload.note.trim() : null;
  const by =
    typeof payload.by === "string" && payload.by.trim() !== "" ? payload.by.trim() : "panel";

  let updated = 0;
  for (const item of items) {
    const ok = await deps.store.updateCaseVerdict({
      rootPath,
      runId: item.runId,
      caseId: item.caseId,
      verdict: verdict as CaseVerdict,
      verdictBy: by,
      verdictNote: note
    });
    if (ok) updated += 1;
  }
  if (updated === 0) {
    return json(400, {
      ok: false,
      error: "未命中任何用例（run/case 不存在）",
      updated,
      missed: items.length
    });
  }
  return json(200, { ok: true, updated, missed: items.length - updated });
}
