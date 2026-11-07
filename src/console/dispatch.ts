import { createHash } from "node:crypto";

import type { HostRecord, ProjectStore } from "../db/types.js";
import { clientTtlFrom, isClientOnline } from "../host/online.js";
import { LEGACY_HOST_REASON } from "../host/legacy.js";
import { projectAllowed, projectExcluded } from "../project-visibility.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";
import { errorMessage, escapeHtml } from "../util.js";
import { cBadge, cBanner, cCard, cStat, cTable } from "./components.js";
import { renderConsoleShell, type ConsoleCapabilities, type ConsoleShellInput } from "./shell.js";
import { listWebAssets } from "../web/assets.js";

export interface DispatchDeps {
  store: ProjectStore;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  /** 主机作用域存储视图；未提供时回退 `store.scopeHost(hostId)`。 */
  storeForHost?: (hostId: string) => ProjectStore | null;
}

export interface DispatchRefDetail {
  id: string;
  label: string;
  caseCount: number;
  featureKeys: string[];
}

export interface DispatchHost {
  id: string;
  label: string | null;
  hostname: string;
  kind: string;
  online: boolean;
  capabilities: string[];
  queueDepth: number;
}

export interface DispatchProject {
  hostId: string;
  rootPath: string;
  name: string;
}

export interface DispatchPreview {
  source: { mode: "case-set" | "keyword" | "excel"; label: string; caseCount: number };
  refs: string[];
  refDetails: DispatchRefDetail[];
  setOptions: DispatchRefDetail[];
  platforms: ("ios" | "android")[];
  devices: string[];
  baseline: "latest" | "none";
  runnerCandidates: {
    id: string;
    host: string;
    hostId: string | null;
    online: boolean;
    devices: Array<{
      serial: string;
      platform: string;
      model: string | null;
      osVersion: string | null;
      state: string;
    }>;
  }[];
  hosts: DispatchHost[];
  selectedHostId: string | null;
  /** 选中主机上已登记的项目（无主机台账时仅当前项目）。 */
  projects: DispatchProject[];
  /** 队列优先级：0 默认，越大越先领取（0–100）。 */
  priority: number;
  /** 可选安装包资产（package）；执行机在跑用例前下载安装。 */
  appAssetId: string | null;
  appPackages: Array<{ id: string; filename: string; label: string; platform: "android" | "ios" | null }>;
  /** 目标主机能力/项目不满足：前端禁用确认（离线只告警，不置位）。 */
  hostBlocked: boolean;
  /** 用例集来源实际读的是哪一层 store；`error` 非空时来源区必须显式示因。 */
  sourceStore: {
    tier: "target" | "owner" | "global";
    hostId: string | null;
    error: string | null;
  };
  warnings: string[];
}

export interface DispatchView {
  rootPath: string;
  rootLabel: string;
  hostId: string | null;
  /** 解析到的项目是已登记的 legacy（host_id 为空）行（工作区未登记目录不算）。 */
  legacyHostless?: boolean;
  preview: DispatchPreview;
  /** 预览 ID：POST 时服务端复算比对（预览过期 → 409）。 */
  previewId: string;
  /** 表单字段签名：客户端以它判断"改了字段 → 预览已过期"。 */
  formSignature: string;
  query: Record<string, string>;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
  /** `AOS_PANEL_PRIORITY=1` 时才放开优先级编辑（默认只读，防误操作插队）。 */
  priorityEditable?: boolean;
  /** true＝作为“新建测试”hub 的套件 tab 嵌入。 */
  embeddedCreate?: boolean;
}

function platformLabel(platform: "android" | "ios"): string {
  return platform === "android" ? "Android" : "iOS";
}

function dispatchPlatforms(params: URLSearchParams): ("ios" | "android")[] {
  const raw = params.getAll("platforms");
  const values = (raw.length === 0 ? ["android"] : raw)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is "ios" | "android" => value === "ios" || value === "android");
  return [...new Set(values)].sort();
}

/** 表单字段签名（与预览同源；客户端复算同式）。 */
export function dispatchFormSignature(params: URLSearchParams): string {
  const mode = (params.get("source") ?? "case-set").trim() === "keyword" ? "keyword" : "case-set";
  const refOrKeyword =
    mode === "keyword" ? (params.get("keyword") ?? "").trim() : (params.get("ref") ?? "").trim();
  const platforms = dispatchPlatforms(params).join(",");
  const baseline = (params.get("baseline") ?? "latest").trim() === "none" ? "none" : "latest";
  const appAssetId = (params.get("appAssetId") ?? "").trim();
  return [mode, refOrKeyword, platforms, baseline, appAssetId].join("|");
}

/** 预览 ID＝表单签名＋目标主机/项目＋服务端解析结果（用例集集合/用例数）短哈希；服务端复算不一致即视为过期。 */
export function dispatchPreviewId(
  preview: DispatchPreview,
  formSignature: string,
  rootPath = ""
): string {
  const resolved = preview.refs.slice().sort().join(",");
  return createHash("sha256")
    .update(
      `${formSignature}#${preview.selectedHostId ?? ""}#${rootPath}#${resolved}#${preview.source.caseCount}`
    )
    .digest("hex")
    .slice(0, 16);
}



export interface HostPrecheckInput {
  id: string;
  kind: string;
  osPlatform: string;
  capabilities: string[];
  online: boolean;
}

/** 任务下发前的目标主机预检：能力不满足 → ok:false（离线只告警，仍可入队）。 */
export function precheckTask(
  host: HostPrecheckInput,
  platforms: string[]
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let ok = true;
  const capabilities = new Set(host.capabilities);
  const hasCapabilities = host.capabilities.length > 0;
  let warnedNoRunner = false;
  const warnNoRunner = (): void => {
    if (warnedNoRunner) return;
    warnedNoRunner = true;
    reasons.push("该主机尚无执行机上报，任务会排队等待");
  };
  if (platforms.includes("ios")) {
    const iosCapable = [...capabilities].some((capability) => capability.startsWith("ios-"));
    if (host.osPlatform !== "darwin") {
      reasons.push("iOS 需要 macOS（darwin）主机");
      ok = false;
    } else if (!hasCapabilities) {
      warnNoRunner();
    } else if (!iosCapable) {
      reasons.push("iOS 需要 macOS 或 iOS 能力");
      ok = false;
    }
  }
  if (platforms.includes("android")) {
    if (!hasCapabilities) warnNoRunner();
    else if (!capabilities.has("android")) {
      reasons.push("Android 需要目标主机具备 Android 能力");
      ok = false;
    }
  }
  if (!host.online) reasons.push("目标主机离线，任务会排队等待");
  return { ok, reasons };
}

export function isHostOnline(
  host: Pick<HostRecord, "clientSeenAt" | "runnerSeenAt">,
  nowMs: number,
  env: NodeJS.ProcessEnv
): boolean {
  if (isClientOnline(host.clientSeenAt, nowMs, clientTtlFrom(env))) return true;
  return host.runnerSeenAt !== null && isRunnerOnline(host.runnerSeenAt, nowMs, runnerTtlFrom(env));
}

/** 目标主机作用域存储：优先注入视图，其次 `scopeHost`，最后回退当前 store。 */
export function hostScopedStore(
  deps: Pick<DispatchDeps, "store" | "storeForHost">,
  hostId: string | null
): ProjectStore {
  if (hostId === null) return deps.store;
  const injected = deps.storeForHost?.(hostId);
  if (injected) return injected;
  try {
    return deps.store.scopeHost(hostId);
  } catch {
    return deps.store;
  }
}

/** 严格解析主机作用域：注入 null / scopeHost 抛错 → 明确失败，不静默回退全局。 */
function strictHostStore(
  deps: Pick<DispatchDeps, "store" | "storeForHost">,
  hostId: string
): { store: ProjectStore | null; error: string | null } {
  if (deps.storeForHost !== undefined) {
    const injected = deps.storeForHost(hostId);
    if (injected === null) {
      return { store: null, error: `无法解析主机 ${hostId} 的存储视图` };
    }
    if (injected !== undefined) return { store: injected, error: null };
  }
  try {
    return { store: deps.store.scopeHost(hostId), error: null };
  } catch (error) {
    return { store: null, error: errorMessage(error) };
  }
}

async function hostQueueDepth(store: ProjectStore, hostId: string): Promise<number> {
  let scoped: ProjectStore;
  try {
    scoped = store.scopeHost(hostId);
  } catch {
    scoped = store;
  }
  let owned: Awaited<ReturnType<ProjectStore["listProjects"]>>;
  try {
    owned = (await scoped.listProjects()).filter((project) => project.hostId === hostId);
  } catch {
    return 0;
  }
  let depth = 0;
  for (const project of owned) {
    try {
      const tasks = await scoped.listRegressionTasks(project.rootPath, 200);
      depth += tasks.filter((task) => task.status === "pending").length;
    } catch {
      /* 单项目读取失败不阻断预览 */
    }
  }
  return depth;
}

export async function computeDispatchPreview(
  deps: DispatchDeps,
  rootPath: string,
  params: URLSearchParams
): Promise<DispatchPreview> {
  const now = deps.now?.() ?? Date.now();
  const runnerTtlMs = runnerTtlFrom(deps.env);
  const modeRaw = (params.get("source") ?? "case-set").trim();
  const mode: DispatchPreview["source"]["mode"] =
    modeRaw === "keyword" || modeRaw === "excel" ? modeRaw : "case-set";
  const platforms = dispatchPlatforms(params);

  const warnings: string[] = [];
  const priorityRaw = (params.get("priority") ?? "").trim();
  let priority = 0;
  if (priorityRaw !== "") {
    if (!/^[+-]?\d+$/.test(priorityRaw)) {
      warnings.push("优先级须为 0–100 的整数：已按 0 处理");
    } else {
      priority = Math.min(100, Math.max(0, Number.parseInt(priorityRaw, 10)));
    }
  }
  const hostParam = (params.get("host") ?? "").trim();
  const targetRef = hostParam !== "" ? hostParam : (deps.store.localHostId ?? "");
  let hostRecords: HostRecord[] = [];
  try {
    hostRecords = await deps.store.listHosts();
  } catch {
    hostRecords = [];
  }
  const targetHost =
    targetRef === "" ? null : (hostRecords.find((host) => host.id === targetRef) ?? null);
  if (hostParam !== "" && targetHost === null) {
    warnings.push(`未知主机「${hostParam}」：请重新选择（可能已下线或未登记）`);
  }
  const targetStore = hostScopedStore(deps, targetHost?.id ?? null);
  const ownerProject =
    rootPath === "" ? null : await deps.store.getProjectByPath(rootPath).catch(() => null);
  let executionRunnerForHost = false;
  if (targetHost !== null && rootPath !== "") {
    try {
      executionRunnerForHost = (await deps.store.listRunners(rootPath)).some(
        (runner) => (runner.hostId ?? runner.name) === targetHost.id
      );
    } catch {
      executionRunnerForHost = false;
    }
  }
  let targetProjectFound = false;
  let crossRootRunner = false;
  let hostBlocked = hostParam !== "" && targetHost === null;
  if (targetHost !== null) {
    if (rootPath !== "") {
      let targetProject: Awaited<ReturnType<ProjectStore["getProjectByPath"]>> = null;
      let targetReadError: string | null = null;
      try {
        targetProject = await targetStore.getProjectByPath(rootPath);
      } catch (error) {
        targetReadError = errorMessage(error);
      }
      targetProjectFound = targetProject !== null;
      if (targetReadError !== null) {
        warnings.push(
          `目标主机来源读取失败（host=${targetHost.id}）：${targetReadError}`
        );
        hostBlocked = true;
      } else if (targetProject === null) {
        if (ownerProject !== null && executionRunnerForHost) {
          crossRootRunner = true;
          warnings.push(
            `执行机「${targetHost.id}」使用中心项目目录执行（跨机 runner），无需在该主机重复登记项目`
          );
        } else {
          warnings.push(
            `主机「${targetHost.id}」未登记项目「${rootPath}」：套件回归需要项目目录；请先在目标机接入项目`
          );
          hostBlocked = true;
        }
      }
    }
    const precheck = precheckTask(
      {
        id: targetHost.id,
        kind: targetHost.kind,
        osPlatform: targetHost.osPlatform,
        capabilities: targetHost.capabilities,
        online: isHostOnline(targetHost, now, deps.env)
      },
      platforms
    );
    warnings.push(...precheck.reasons);
    if (!precheck.ok) hostBlocked = true;
  }

  let projects: DispatchProject[] = [];
  if (targetHost !== null) {
    try {
      projects = (await targetStore.listProjects())
        .filter((project) => project.hostId === targetHost.id)
        .filter(
          (project) =>
            !projectExcluded(project, deps.env.AOS_PANEL_EXCLUDE_PROJECTS) &&
            projectAllowed(project, deps.env.AOS_PANEL_PROJECTS)
        )
        .map((project) => ({
          hostId: targetHost.id,
          rootPath: project.rootPath,
          name: project.name
        }));
    } catch {
      projects = [];
    }
    if (crossRootRunner && ownerProject !== null) {
      projects = [
        {
          hostId: ownerProject.hostId ?? "",
          rootPath: ownerProject.rootPath,
          name: ownerProject.name
        }
      ];
    }
    if (projects.length === 0) hostBlocked = true;
    if (rootPath === "" && projects.length > 0) {
      warnings.push("请先选择项目：只给主机时列出该主机上的项目，不自动猜项目");
    }
  } else {
    const current = await targetStore.getProjectByPath(rootPath).catch(() => null);
    const fallbackName = rootPath.split(/[\\/]/).filter((part) => part !== "").pop() ?? rootPath;
    projects = [
      {
        hostId: current?.hostId ?? deps.store.localHostId ?? "",
        rootPath,
        name: current?.name ?? fallbackName
      }
    ];
  }

  const hosts: DispatchHost[] = [];
  for (const host of hostRecords) {
    hosts.push({
      id: host.id,
      label: host.label,
      hostname: host.hostname,
      kind: host.kind,
      online: isHostOnline(host, now, deps.env),
      capabilities: [...host.capabilities],
      queueDepth: await hostQueueDepth(deps.store, host.id)
    });
  }
  if (rootPath !== "") {
    try {
      const suiteRunnerHosts = new Set(
        (await deps.store.listRunners(rootPath)).map((runner) => runner.hostId ?? runner.name)
      );
      if (suiteRunnerHosts.size > 0) {
        const filtered = hosts.filter(
          (host) =>
            suiteRunnerHosts.has(host.id) ||
            host.id === targetHost?.id ||
            host.id === ownerProject?.hostId
        );
        hosts.length = 0;
        hosts.push(...filtered);
      }
    } catch {
      /* keep all hosts when runner inventory is unreadable */
    }
  }
  if (targetHost !== null) {
    const index = hosts.findIndex((host) => host.id === targetHost.id);
    if (index > 0) {
      const [selected] = hosts.splice(index, 1);
      if (selected) hosts.unshift(selected);
    }
  }

  let sourceStore: ProjectStore | null = targetStore;
  let sourceTier: "target" | "owner" | "global" =
    targetHost === null ? "global" : "target";
  let sourceHostId: string | null = targetHost?.id ?? null;
  let sourceError: string | null = null;
  if (rootPath !== "" && targetHost !== null && !targetProjectFound) {
    const owner = await deps.store.getProjectByPath(rootPath).catch(() => null);
    if (owner?.hostId) {
      const resolved = strictHostStore(deps, owner.hostId);
      sourceStore = resolved.store;
      sourceTier = "owner";
      sourceHostId = owner.hostId;
      if (resolved.store === null) {
        sourceError = "source-store-unavailable";
        warnings.push(
          `来源读取失败（owner host=${owner.hostId}）：${resolved.error ?? "无法解析存储视图"}`
        );
      } else {
        const ownerProject = await resolved.store
          .getProjectByPath(rootPath)
          .catch(() => null);
        if (ownerProject === null) {
          sourceError = "owner-project-missing";
          warnings.push(
            `来源读取失败（owner host=${owner.hostId}）：该项目不在该主机的存储中`
          );
        }
      }
    } else {
      sourceTier = "global";
      sourceHostId = null;
      sourceStore = deps.store;
    }
  }
  let sets: Awaited<ReturnType<ProjectStore["listCaseSets"]>> = [];
  if (sourceStore !== null) {
    try {
      sets = await sourceStore.listCaseSets(rootPath);
    } catch (error) {
      sourceError = "source-read-failed";
      warnings.push(
        `来源读取失败（${sourceTier}${sourceHostId === null ? "" : ` host=${sourceHostId}`}）：${errorMessage(error)}`
      );
    }
  }
  if (
    rootPath !== "" &&
    sourceError === null &&
    sets.length === 0 &&
    sourceStore !== null
  ) {
    warnings.push("该项目还没有用例集：先在用例库导入 Excel");
  }
  const setOptions: DispatchRefDetail[] = sets.map((set) => ({
    id: set.id,
    label: set.basename,
    caseCount: set.features.reduce((sum, feature) => sum + feature.caseCount, 0),
    featureKeys: set.features.map((feature) => feature.key)
  }));

  const packageAssets =
    sourceStore === null || rootPath === ""
      ? []
      : await listWebAssets(sourceStore, rootPath, "package").catch(() => []);
  const appPackages = packageAssets
    .map((asset) => ({
      id: asset.id,
      filename: asset.filename,
      label: `v${asset.version} · ${asset.filename}`,
      platform: asset.filename.toLowerCase().endsWith(".ipa")
        ? ("ios" as const)
        : asset.filename.toLowerCase().endsWith(".apk")
          ? ("android" as const)
          : null
    }))
    .filter((asset) => asset.platform === null || platforms.includes(asset.platform));
  const requestedAppAssetId = (params.get("appAssetId") ?? "").trim();
  const appAssetId =
    requestedAppAssetId !== "" && appPackages.some((asset) => asset.id === requestedAppAssetId)
      ? requestedAppAssetId
      : null;
  if (requestedAppAssetId !== "" && appAssetId === null) {
    warnings.push("所选安装包不存在或已删除：请重新选择（本次不会安装）");
  }

  let label = "";
  let caseCount = 0;
  const refDetails: DispatchRefDetail[] = [];

  if (mode === "case-set") {
    const id = (params.get("ref") ?? "").trim();
    const hit = setOptions.find((option) => option.id === id);
    if (hit) {
      label = hit.label;
      caseCount = hit.caseCount;
      refDetails.push(hit);
    } else if (id !== "") {
      warnings.push(`未知用例集「${id}」：请重新选择（可能已被保留期清理）`);
    }
  } else if (mode === "keyword") {
    const keyword = (params.get("keyword") ?? "").trim();
    label = keyword === "" ? "关键词" : `关键词「${keyword}」`;
    if (keyword !== "") {
      const hits = sets.filter(
        (set) =>
          set.basename.includes(keyword) ||
          set.features.some(
            (feature) => feature.name.includes(keyword) || feature.key.includes(keyword)
          )
      );
      for (const set of hits) {
        const detail = setOptions.find((option) => option.id === set.id)!;
        refDetails.push(detail);
        caseCount += detail.caseCount;
      }
      if (hits.length === 0) warnings.push(`关键词「${keyword}」未匹配到任何用例集`);
    }
  } else {
    const excelPath = (params.get("excel") ?? "").trim();
    label = excelPath === "" ? "Excel 导入" : `Excel：${excelPath}`;
    if (excelPath === "") warnings.push("未指定 Excel 路径");
    else warnings.push("Excel 导入经 CLI/API（multipart 上传）；本表单提交支持「用例库选用例集」与「功能关键词」");
  }

  const devices = (params.get("devices") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const baseline: "latest" | "none" =
    (params.get("baseline") ?? "latest").trim() === "none" ? "none" : "latest";

  const runnerStore = crossRootRunner ? deps.store : targetStore;
  const runners = await runnerStore.listRunners(rootPath).catch(() => []);
  const runnerCandidates = runners.map((runner) => ({
    id: runner.id,
    host: runner.hostname,
    hostId: runner.hostId ?? null,
    online: isRunnerOnline(runner.lastSeenAt, now, runnerTtlMs),
    devices: runner.devices.map((device) => ({
      serial: device.serial,
      platform: device.platform,
      model: device.model ?? null,
      osVersion: device.osVersion ?? null,
      state: device.state
    }))
  }));

  return {
    source: { mode, label, caseCount },
    refs: refDetails.map((detail) => detail.id),
    refDetails,
    setOptions,
    platforms,
    devices,
    baseline,
    runnerCandidates,
    hosts,
    selectedHostId: targetHost?.id ?? null,
    projects,
    priority,
    appAssetId,
    appPackages,
    hostBlocked,
    sourceStore: { tier: sourceTier, hostId: sourceHostId, error: sourceError },
    warnings
  };
}

export function renderDispatchPage(view: DispatchView): string {
  const preview = view.preview;
  const dispatchHostQuery =
    preview.selectedHostId === null ? "" : `&host=${encodeURIComponent(preview.selectedHostId)}`;
  const legacyHostless = view.legacyHostless === true && preview.hosts.length > 0;
  const legacyNoteHtml = legacyHostless
    ? `<p class="note">${escapeHtml(LEGACY_HOST_REASON).replace(
        "host adopt-legacy --local --apply",
        "<code>host adopt-legacy --local --apply</code>"
      )}。</p>`
    : "";
  const query = (name: string, fallback = ""): string => escapeHtml(view.query[name] ?? fallback);
  const mode = preview.source.mode;
  const platformChecks = (["android", "ios"] as const)
    .map(
      (platform) =>
        `<label class="dispatch-option"><input type="checkbox" name="platforms" value="${platform}"${
          preview.platforms.includes(platform) ? " checked" : ""
        }> ${platformLabel(platform)}</label>`
    )
    .join(" ");
  const setOptions = preview.setOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.id)}" data-features="${escapeHtml(JSON.stringify(option.featureKeys))}" data-count="${option.caseCount}"${preview.refs.includes(option.id) ? " selected" : ""}>${escapeHtml(option.label)}（${option.caseCount} 例）</option>`
    )
    .join("");
  const refRows = preview.refDetails.map((detail) => [
    escapeHtml(detail.label),
    `<code>${escapeHtml(detail.id)}</code>`,
    String(detail.caseCount)
  ]);
  const runnerBadges = preview.runnerCandidates
    .map(
      (runner) =>
        `${cBadge({ label: runner.online ? "在线" : "失联", tone: runner.online ? "success" : "warning" })} <code>${escapeHtml(
          runner.hostId === null ? runner.host : `${runner.hostId}（${runner.host}）`
        )}</code>`
    )
    .join(" · ");
  const warnings = preview.warnings
    .map((warning) => cBanner({ tone: "warn", title: warning }))
    .join("");
  const hostOptions = preview.hosts
    .map((host) => {
      const title =
        host.label === null
          ? `${host.id}（${host.hostname}）`
          : `${host.id}（${host.hostname} · ${host.label}）`;
      const meta = [
        host.kind,
        host.online ? "在线" : "离线",
        host.queueDepth > 0 ? `队列 ${host.queueDepth}` : ""
      ]
        .filter((part) => part !== "")
        .join(" · ");
      return `<option value="${escapeHtml(host.id)}"${host.id === preview.selectedHostId ? " selected" : ""}>${escapeHtml(title)} · ${escapeHtml(meta)}</option>`;
    })
    .join("");
  const hostSelect =
    preview.hosts.length === 0
      ? `<p class="muted">单机模式（未登记中心主机）：任务将在本机执行。</p>`
      : [
          `<p><label>主机 <select name="host" aria-label="目标主机">`,
          preview.hosts.some((host) => host.id === preview.selectedHostId)
            ? ""
            : '<option value="">（选择主机）</option>',
          hostOptions,
          `</select></label> <span class="muted">先选目标主机，用例集选项按该主机作用域展示。</span></p>`
        ].join("");

  const projectOptions = (() => {
    const labels = preview.projects.map((project) => {
      const tail = project.rootPath.split(/[\\/]/).filter((part) => part !== "").pop() ?? "";
      return tail === "" || tail === project.name ? project.name : `${project.name}（${tail}）`;
    });
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return preview.projects
      .map((project, index) => {
        const base = labels[index]!;
        const label = (counts.get(base) ?? 0) > 1 ? `${project.name}（${project.rootPath}）` : base;
        return `<option value="${escapeHtml(project.rootPath)}"${
          project.rootPath === view.rootPath ? " selected" : ""
        }>${escapeHtml(label)}</option>`;
      })
      .join("");
  })();
  const currentListed = preview.projects.some((project) => project.rootPath === view.rootPath);
  const projectMissing = view.rootPath === "";
  const currentLabel = projectMissing ? "（选择项目）" : `${view.rootLabel}（当前项目）`;
  const currentOption = currentListed
    ? ""
    : `<option value="${escapeHtml(view.rootPath)}" selected>${escapeHtml(currentLabel)}</option>`;
  const projectOptionsHtml = currentOption + projectOptions;
  const noProjects = preview.selectedHostId !== null && preview.projects.length === 0;
  // 目标主机没登记项目，但 owner store 仍可能有用例集：此时只禁用执行（hostBlocked），
  // 不要把来源下拉一起禁用/说成“没有用例集”。
  const noSources = noProjects && preview.setOptions.length === 0;
  const projectSelect = [
    `<p><label>项目 <select name="project" aria-label="项目">${projectOptionsHtml}</select></label> <span class="muted">先选主机，再选该主机上的项目。</span></p>`,
    noProjects
      ? `<p class="muted">该主机尚未登记项目：套件回归需要项目目录，请先在该主机接入项目。手机是否连接请查看 <a href="/panel?section=devices">设备页</a>。</p>`
      : ""
  ]
    .filter((part) => part !== "")
    .join("\n");
  const hostCardBody = [hostSelect, legacyNoteHtml, projectSelect].filter((part) => part !== "").join("\n");

  const priorityField =
    view.priorityEditable === true
      ? `<p><label>优先级 <input type="number" name="priority" aria-label="优先级" min="0" max="100" step="1" value="${preview.priority}"></label> <span class="muted">0 为默认；数值越大越先领取（0–100）。</span></p>`
      : `<p>优先级 <span class="c-badge" title="优先级（越大越先领取）">P${preview.priority}</span> <span class="muted">只读（防误操作插队）：设置 <code>AOS_PANEL_PRIORITY=1</code> 后可编辑。</span></p>`;

  const webJobsHref = "/panel?section=devices#runner-guide";
  const hostProjectCallout = noProjects
    ? `<div class="c-flow-callout"><div><strong>${
        noSources
          ? "该主机未登记项目，套件回归没有可用用例集。"
          : "该主机未登记项目，套件回归不能在该主机执行；来源仍可查看。"
      }</strong><p>Android 真机请用 MCP 原生 <code>run_regression</code>（可用 appPath 安装 APK），不要求项目登记到执行机；如果要在该主机跑套件回归，请先在该主机接入项目。</p></div><a class="c-button c-button-primary" href="${escapeHtml(webJobsHref)}">MCP 原生接入 →</a></div>`
    : "";
  const sourceEmpty = noSources
    ? `<p class="muted">该主机未登记项目，套件回归没有可用用例集。MCP 原生不要求项目登记到执行机：<a href="${escapeHtml(webJobsHref)}">MCP 原生接入</a>；或先在该主机接入项目。</p>`
    : "";
  const sourceBody = [
    '<fieldset class="c-fieldset"><legend>来源</legend>',
    `<label class="dispatch-option"><input type="radio" name="source" value="case-set"${mode === "case-set" ? " checked" : ""}> 用例库选用例集</label>`,
    `<label class="dispatch-option"><input type="radio" name="source" value="keyword"${mode === "keyword" ? " checked" : ""}> 功能关键词</label>`,
    "</fieldset>",
    `<div id="dispatch-field-ref"><p><label>用例集 <select name="ref" aria-label="用例集"${noSources ? " disabled" : ""}><option value="">（选择用例集）</option>${setOptions}</select></label></p></div>`,
    `<div id="dispatch-field-keyword"><p><label>关键词 <input type="text" name="keyword" aria-label="功能关键词" value="${query("keyword")}" placeholder="例：登录"></label></p></div>`,
    sourceEmpty,
    view.rootPath === ""
      ? `<p class="muted">先选择项目。</p>`
      : `<p class="muted">Excel 用例还没进用例库？<a href="/panel?project=${encodeURIComponent(view.rootPath)}&amp;section=assets&amp;tab=case-sets#library-import">去用例库导入 Excel</a>；安装包在下一步「参数」里选，执行机会自动安装。</p>`
  ].join("\n");

  const appPackageOptions = preview.appPackages
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.id)}"${
          asset.id === preview.appAssetId ? " selected" : ""
        }>${escapeHtml(asset.label)}${asset.platform === null ? "" : `（${asset.platform}）`}</option>`
    )
    .join("");
  const appPackageField =
    preview.appPackages.length === 0
      ? `<p class="muted">安装包：项目还没有上传 APK/IPA。可在 <a href="/panel?project=${encodeURIComponent(view.rootPath)}&amp;section=assets&amp;tab=packages#asset-upload">测试资产 → 安装包</a> 上传；也可以先手动装到设备上。</p>`
      : `<p><label>安装包（可选） <select name="appAssetId" aria-label="安装包"><option value="">不安装（设备需已安装）</option>${appPackageOptions}</select></label> <span class="muted">选择后执行机在跑用例前安装；不选则要求设备已安装。</span></p>`;

  const paramsBody = [
    `<fieldset class="c-fieldset"><legend>目标端</legend>${platformChecks}</fieldset>`,
    `<p><label>基线 <select name="baseline" aria-label="基线"><option value="latest"${preview.baseline === "latest" ? " selected" : ""}>latest（与本用例集最近批次对比）</option><option value="none"${preview.baseline === "none" ? " selected" : ""}>none（不对比）</option></select></label> · 设备在执行机执行时确定（<code>suite run --device</code>）</p>`,
    appPackageField,
    priorityField
  ].join("\n");

  const runnerOnline = preview.runnerCandidates.some((runner) => runner.online);
  const runnerOnlineCount = preview.runnerCandidates.filter((runner) => runner.online).length;
  const hostRunner =
    preview.runnerCandidates.find((runner) => runner.hostId === preview.selectedHostId) ??
    (preview.runnerCandidates.length === 1 ? preview.runnerCandidates[0] : null);
  const eligibleDevices = (hostRunner?.devices ?? []).filter((device) =>
    preview.platforms.includes(device.platform as "android" | "ios")
  );
  const deviceSummary =
    eligibleDevices.length === 0
      ? "执行机将自动选择设备"
      : eligibleDevices
          .map(
            (device) =>
              `${device.serial}（${device.platform}${device.model === null ? "" : ` · ${device.model}`}）`
          )
          .join("、");
  const previewBody = [
    `<p id="dispatch-stale" role="status" class="c-banner c-banner-warn" hidden>表单已变更：预览已过期。请点「刷新预览」后重新核对，再确认派发。</p>`,
    `<p id="dispatch-empty" role="status" class="c-banner c-banner-warn" hidden>预览为空：尚未引用任何用例集。请选择用例集或输入关键词后点「刷新预览」。</p>`,
    `<div class="c-stats-row">`,
    cStat({ label: "来源", value: preview.source.label || "—" }),
    cStat({ label: "用例数", value: String(preview.source.caseCount) }),
    cStat({ label: "优先级", value: `P${preview.priority}` }),
    cStat({
      label: "目标端",
      value: preview.platforms.map((platform) => platformLabel(platform)).join("、") || "—"
    }),
    cStat({
      label: "安装包",
      value:
        preview.appAssetId === null
          ? "不安装"
          : (preview.appPackages.find((asset) => asset.id === preview.appAssetId)?.filename ??
            "已选择")
    }),
    cStat({
      label: "设备",
      value: preview.devices.length > 0 ? preview.devices.join("、") : deviceSummary
    }),
    `</div>`,
    cTable({
      columns: ["用例集", "用例集 ID", "用例数"],
      rows: refRows,
      caption: "引用用例集明细",
      empty: "无引用（待选择来源）"
    }),
    `<p>执行机候选：${runnerBadges || '<span class="muted">暂无注册执行机</span>'}</p>`,
    runnerOnline
      ? ""
      : `<p class="muted">执行机：无在线（派发后任务将排队，等待执行机上线后领取；可手动执行）。</p>`,
    `<p class="muted">设备：${
      eligibleDevices.length === 0
        ? "执行机未上报匹配设备；领取时将自动选择，最终设备见任务页。"
        : `执行机当前可用 ${eligibleDevices
            .map((device) => `<code>${escapeHtml(device.serial)}</code>`)
            .join("、")}；任务按端自动选择。`
    }</p>`,
    warnings,
    `<p><button class="c-button" type="submit">刷新预览</button></p>`
  ].join("\n");

  const priorityReadScript =
    view.priorityEditable === true
      ? `function readPriority(){var el=form.querySelector('input[name="priority"]');var value=el?Number(el.value||'0'):(island.priority||0);if(!isFinite(value)||Math.floor(value)!==value||value<0||value>100){showErr('优先级须为 0–100 的整数');return null;}return value;}`
      : `function readPriority(){return island.priority||0;}`;
  const dispatchConfirmScript = `<script>(function(){
var form=document.getElementById('dispatch-form');if(!form)return;
var go=document.getElementById('dispatch-submit');if(!go)return;
var status=document.getElementById('dispatch-status');
var err=document.getElementById('dispatch-error');
var stale=document.getElementById('dispatch-stale');
var island=null;try{island=JSON.parse(document.getElementById('dispatch-preview-data').textContent);}catch(e){island=null;}
if(!island){return;}
function showErr(m){err.textContent=m;err.hidden=false;}
${priorityReadScript}
function formSignature(){
  var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
  var refOrKeyword=mode==='keyword'?((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim():((form.querySelector('select[name="ref"]')||{value:''}).value||'');
  var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;}).sort().join(',');
  var baseline=(form.querySelector('select[name="baseline"]')||{value:'latest'}).value;
  var appAssetId=(form.querySelector('select[name="appAssetId"]')||{value:''}).value;
  return [mode,refOrKeyword,platforms,baseline,appAssetId].join('|');
}
function refreshStale(){
  var host=(form.querySelector('select[name="host"]')||{value:''}).value;
  var staleNow=formSignature()!==island.formSignature||host!==(island.hostId||'');
  var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
  var refField=document.getElementById('dispatch-field-ref');
  var keywordField=document.getElementById('dispatch-field-keyword');
  if(refField)refField.hidden=mode==='keyword';
  if(keywordField)keywordField.hidden=mode!=='keyword';
  var empty=!island.ready;
  var emptyEl=document.getElementById('dispatch-empty');
  if(emptyEl)emptyEl.hidden=!empty;
  if(stale)stale.hidden=!staleNow;
  var missingHost=island.hostRequired&&!host;
  var legacy=island.legacyHostless;
  var blocked=staleNow||empty||missingHost||island.hostBlocked||legacy;
  go.disabled=blocked;
  return blocked;
}
form.addEventListener('input',refreshStale);
form.addEventListener('change',refreshStale);
refreshStale();
go.addEventListener('click',function(){
  var pickedHost=(form.querySelector('select[name="host"]')||{value:''}).value;
  if(refreshStale()){
    if(island.legacyHostless&&!island.hostId){showErr(${JSON.stringify(LEGACY_HOST_REASON)});return;}
    if(island.hostRequired&&!pickedHost){showErr('请先选择目标主机');return;}
    if(island.hostBlocked){showErr('目标主机无法满足所选平台：请调整目标端或更换主机后刷新预览');return;}
    showErr(island.ready?'预览已过期：请先点「刷新预览」':'预览为空：先选择用例集或输入关键词，再点「刷新预览」');return;
  }
  if(form.querySelectorAll('input[name="platforms"]:checked').length===0){showErr('请至少选择目标端（iOS/Android）');return;}
  var priority=readPriority();
  if(priority===null){return;}
  var s=island.summary||{};
  var refs=island.refsDetail||[];
  var refText=refs.length===0?'':(' · 用例集：'+refs.map(function(r){return r.label+'×'+r.caseCount;}).join('、'));
  var runner=island.runnerOnline?('在线候选 '+island.runnerOnlineCount+' 台'):'无在线执行机（任务将排队）';
  var hostName=(island.hostLabel||island.hostId||'本机');
  var appSel=form.querySelector('select[name="appAssetId"]');
  var appAssetId=appSel?appSel.value:'';
  var appLabel=appSel&&appSel.selectedIndex>=0?appSel.options[appSel.selectedIndex].text:'';
  var appText=appAssetId===''?'不安装（设备需已安装）':('安装 '+appLabel);
  var text='将创建回归任务：目标主机「'+hostName+'」 · 来源「'+(s.label||'—')+'」 · 用例 '+(s.caseCount==null?'—':s.caseCount)+' 条'+refText+' · 端 '+((s.platforms||[]).join('、')||'—')+' · 基线 '+(s.baseline||'latest')+' · '+appText+' · 优先级 P'+priority+' · 执行机：'+runner;
  window.aosInlineConfirm(go,text,function(){
    var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
    var payload={project:island.project,previewId:island.previewId,source:mode};
    var hostSel=form.querySelector('select[name="host"]');
    if(hostSel&&hostSel.value){payload.host=hostSel.value;}
    if(mode==='keyword'){payload.keyword=((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim();}
    else{payload.ref=(form.querySelector('select[name="ref"]')||{value:''}).value||'';}
    payload.platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;});
    payload.baseline=(form.querySelector('select[name="baseline"]')||{value:'latest'}).value;
    payload.appAssetId=appAssetId;
    payload.priority=priority;
    go.disabled=true;if(status)status.textContent='提交中…';
    fetch('/panel/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(response){return response.json().then(function(p){
        if(!response.ok){
          var message=p.error||('HTTP '+response.status);
          if(p.reasons&&p.reasons.length){message+='：'+p.reasons.join('；');}
          throw new Error(message);
        }
        var flash='已派发任务 '+p.task.id+' · 已写入审计';
        if(p.warnings&&p.warnings.length){flash+=' · '+p.warnings.join('；');}
        window.aosFlash&&aosFlash(flash);
        var host=payload.host||'';
        location.href='/panel?project='+encodeURIComponent(island.project)+'&section=tasks&task='+encodeURIComponent(p.task.id)+(host?'&host='+encodeURIComponent(host):'');
      });})
      .catch(function(error){go.disabled=false;if(status)status.textContent='';showErr('创建失败：'+error.message);});
  });
});
})();</script>`;
  const actionsOff =
    view.capabilities?.actions === false || view.capabilities?.scopes?.dispatch === false;
  const needsHostPick = preview.hosts.length > 0 && preview.selectedHostId === null;
  const submitBlocked =
    legacyHostless || preview.hostBlocked || needsHostPick || noProjects || projectMissing;
  const blockedReason = legacyHostless
    ? LEGACY_HOST_REASON
    : noProjects
      ? "该主机尚未登记项目"
      : projectMissing
        ? "请先选择项目"
        : needsHostPick
          ? "请先选择目标主机"
          : "目标主机无法满足所选平台";
  const confirmBody = actionsOff
    ? `<p><button class="c-button c-button-primary" type="button" disabled title="写动作未启用">确认派发</button> <span class="muted">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式（<code>serve --http</code>）。</span></p>`
    : [
        `<p><button class="c-button c-button-primary" type="button" id="dispatch-submit"${submitBlocked ? ` disabled title="${escapeHtml(blockedReason)}"` : ""}>确认派发</button> <span class="muted">点击后显示完整摘要（用例集明细 / 端 / 基线 / 优先级 / 执行机），再创建任务。</span></p>`,
        submitBlocked
          ? `<p class="note" role="status">当前无法派发：${escapeHtml(blockedReason)}。请按下方提示处理后刷新预览。</p>`
          : "",
        noProjects
          ? `<p class="note">该主机尚未登记项目：套件回归需要项目目录；请先在该主机接入项目并刷新本页。设备连接状态见 <a href="/panel?section=devices">设备页</a>。</p>`
          : projectMissing
            ? `<p class="note">请先选择该主机上的项目，再刷新预览。</p>`
            : needsHostPick && !legacyHostless
              ? `<p class="note">请先选择目标主机：已登记主机时不再隐式回退本机。</p>`
              : preview.hostBlocked
                ? `<p class="note">目标主机无法满足所选平台：请调整目标端或更换主机，刷新预览后再试。</p>`
                : "",
        `<p class="note">安装包在「② 参数」选择；执行机领取后先安装再跑用例。Excel 用例先在用例库导入。</p>`,
        `<p id="dispatch-status" role="status" class="muted"></p>`,
        `<p id="dispatch-error" role="alert" class="c-banner c-banner-warn" hidden></p>`,
        `<script type="application/json" id="dispatch-preview-data">${JSON.stringify({ previewId: view.previewId, formSignature: view.formSignature, project: view.rootPath, hostId: preview.selectedHostId, hostLabel:
          preview.hosts.find((host) => host.id === preview.selectedHostId)?.label ??
          preview.hosts.find((host) => host.id === preview.selectedHostId)?.hostname ??
          null, hostRequired: preview.hosts.length > 0, hostBlocked: preview.hostBlocked, legacyHostless, priority: preview.priority, ready: preview.refs.length > 0, runnerOnline, runnerOnlineCount, refsDetail: preview.refDetails.map((detail) => ({ label: detail.label, caseCount: detail.caseCount })), summary: { label: preview.source.label, caseCount: preview.source.caseCount, platforms: preview.platforms, baseline: preview.baseline } }).replace(/</g, "\\u003c")}</script>`,
        dispatchConfirmScript,
      ].filter((part) => part !== "").join("\n");

  const createHref =
    view.rootPath === ""
      ? "/panel?section=create"
      : `/panel?project=${encodeURIComponent(view.rootPath)}&section=create${dispatchHostQuery}`;
  const flowSwitch = view.embeddedCreate
    ? `<nav class="c-flow-switch" aria-label="新建测试类型"><a class="c-flow-option" href="${escapeHtml(
        createHref
      )}">新建测试</a><span class="c-flow-option is-active" aria-current="page">套件回归</span><a class="c-flow-option" href="${escapeHtml(
        webJobsHref
      )}">MCP 原生接入</a></nav>`
    : `<nav class="c-flow-switch" aria-label="下发类型"><span class="c-flow-option is-active" aria-current="page">套件回归</span><a class="c-flow-option" href="${escapeHtml(webJobsHref)}">MCP 原生接入</a></nav>`;
  const installCallout = `<div class="c-flow-callout"><div><strong>要下发安装包（APK/IPA）？</strong><p>在「② 参数」选择安装包即可：执行机领取任务后先安装再跑用例，不要求设备预装；不选时仍按设备已安装处理。</p></div></div>`;
  const hostNavScript = `<script id="dispatch-host-nav">(function(){var form=document.getElementById('dispatch-form');if(!form)return;var select=form.querySelector('select[name="host"]');if(!select)return;select.addEventListener('change',function(){var project=form.querySelector('select[name="project"]');var params=new URLSearchParams(new FormData(form));params.set('section','create');params.set('type','suite');if(select.value)params.set('host',select.value);else params.delete('host');if(project&&project.value)params.set('project',project.value);location.href='/panel?'+params.toString();});})();</script>`;
  const projectNavScript = `<script id="dispatch-project-nav">(function(){var form=document.getElementById('dispatch-form');if(!form)return;var select=form.querySelector('select[name="project"]');if(!select)return;select.addEventListener('change',function(){var host=form.querySelector('select[name="host"]');var params=new URLSearchParams(new FormData(form));params.set('section','create');params.set('type','suite');if(select.value)params.set('project',select.value);if(host&&host.value)params.set('host',host.value);else params.delete('host');location.href='/panel?'+params.toString();});})();</script>`;

  return renderConsoleShell({
    title: view.embeddedCreate ? "新建测试 · 套件回归" : "套件回归",
    active: "create",
    meta: `项目 <code>${escapeHtml(view.rootLabel)}</code>`,
    project: view.rootPath,
    projectHostId: view.hostId,
    capabilities: view.capabilities,
    storeHealth: view.storeHealth,
    body: [
      "<h1>套件回归</h1>",
      flowSwitch,
      hostProjectCallout === "" ? installCallout : hostProjectCallout,
      `<p class="muted"><code>${escapeHtml(view.rootPath === "" ? "未选择项目" : view.rootPath)}</code> · 套件回归：来源 → 参数 → 预览回显 → 确认派发。</p>`,
      `<form id="dispatch-form" method="get" action="/panel">`,
      `<input type="hidden" name="section" value="dispatch">`,
      cCard({ title: "⓪ 主机与项目", body: hostCardBody }),
      cCard({ title: "① 来源", body: sourceBody }),
      cCard({ title: "② 参数", body: paramsBody }),
      cCard({ title: "③ 预览回显", tone: "accent", body: previewBody }),
      cCard({ title: "④ 确认", body: confirmBody }),
      "</form>",
      hostNavScript,
      projectNavScript
    ].join("\n")
  });
}
