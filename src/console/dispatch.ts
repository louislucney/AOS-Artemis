import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { HostRecord, ProjectStore, WebAssetRecord } from "../db/types.js";
import { clientTtlFrom, isClientOnline } from "../host/online.js";
import { LEGACY_HOST_REASON } from "../host/legacy.js";
import { projectAllowed, projectExcluded } from "../project-visibility.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";
import { errorMessage, escapeHtml } from "../util.js";
import { cBadge, cBanner, cCard, cStat, cTable } from "./components.js";
import { renderConsoleShell, type ConsoleCapabilities, type ConsoleShellInput } from "./shell.js";
import { listWebAssets } from "../web/assets.js";
import { inferAppIdFromPackage } from "../web/package-inspect.js";

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
  /** 可选应用包名（Android package / iOS bundle id）；执行机锁定并启动被测应用。 */
  appPackage: string;
  appPackages: Array<{ id: string; filename: string; label: string; platform: "android" | "ios" | null }>;
  /** 是否不下发 iOS 安装包（使用设备已安装应用）。 */
  skipIosInstall: boolean;
  /** 不下发 IPA 时的期望版本；空＝不校验。 */
  appVersionExpected: string | null;
  /** iOS 安装方式（asset=下发 IPA / installed=设备已安装）；非 iOS 为 null。 */
  appInstallMode: "asset" | "installed" | null;
  /** 可选测试资料资产（materials）；secret=true 时解析为占位符。 */
  materialsAssetId: string | null;
  materials: Array<{ id: string; filename: string; version: number; secret: boolean }>;
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

export interface ResolvedDispatchForm {
  platforms?: Array<"ios" | "android">;
  appAssetId?: string | null;
  materialsAssetId?: string | null;
  skipIosInstall?: boolean;
  appVersionExpected?: string | null;
}

/** 表单字段签名（与预览同源；客户端复算同式）。`resolvedAppPackage`/`resolved` 用于把
 * 服务端从安装包/上次任务/执行机设备推导出的默认值纳入签名，避免表单首次打开就被判过期。 */
export function dispatchFormSignature(
  params: URLSearchParams,
  resolvedAppPackage?: string,
  resolved: ResolvedDispatchForm = {}
): string {
  const mode = (params.get("source") ?? "case-set").trim() === "keyword" ? "keyword" : "case-set";
  const refOrKeyword =
    mode === "keyword" ? (params.get("keyword") ?? "").trim() : (params.get("ref") ?? "").trim();
  const platforms = (resolved.platforms ?? dispatchPlatforms(params)).join(",");
  const baseline = (params.get("baseline") ?? "latest").trim() === "none" ? "none" : "latest";
  const appAssetId =
    resolved.appAssetId !== undefined
      ? (resolved.appAssetId ?? "")
      : (params.get("appAssetId") ?? "").trim();
  const materialsAssetId =
    resolved.materialsAssetId !== undefined
      ? (resolved.materialsAssetId ?? "")
      : (params.get("materialsAssetId") ?? "").trim();
  const appPackage =
    resolvedAppPackage !== undefined
      ? resolvedAppPackage.trim()
      : (params.get("appPackage") ?? "").trim();
  const skipIosInstall =
    resolved.skipIosInstall !== undefined
      ? resolved.skipIosInstall
        ? "1"
        : "0"
      : params.get("skipIosInstall") === "1"
        ? "1"
        : "0";
  const appVersionExpected =
    resolved.appVersionExpected !== undefined
      ? (resolved.appVersionExpected ?? "").trim()
      : (params.get("appVersionExpected") ?? "").trim();
  return [
    mode,
    refOrKeyword,
    platforms,
    baseline,
    appAssetId,
    materialsAssetId,
    skipIosInstall,
    appVersionExpected,
    appPackage
  ].join("|");
}

export function dispatchFormSignatureForPreview(
  params: URLSearchParams,
  preview: Pick<
    DispatchPreview,
    | "platforms"
    | "appAssetId"
    | "materialsAssetId"
    | "appPackage"
    | "skipIosInstall"
    | "appVersionExpected"
  >
): string {
  return dispatchFormSignature(params, preview.appPackage, {
    platforms: preview.platforms,
    appAssetId: preview.appAssetId,
    materialsAssetId: preview.materialsAssetId,
    skipIosInstall: preview.skipIosInstall,
    appVersionExpected: preview.appVersionExpected
  });
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

const APP_ID_CACHE = new Map<string, string | null>();

/** 从安装包资产推断应用包名；优先用上传时写入的 metadata，避免每次预览重解开 APK。 */
async function appIdForAsset(asset: WebAssetRecord): Promise<string | null> {
  const stored = asset.metadata?.appId;
  if (typeof stored === "string" && stored.trim() !== "") return stored.trim();
  if (APP_ID_CACHE.has(asset.sha256)) return APP_ID_CACHE.get(asset.sha256) ?? null;
  let appId: string | null = null;
  try {
    appId = await inferAppIdFromPackage(await readFile(asset.storagePath), asset.filename);
  } catch {
    appId = null;
  }
  APP_ID_CACHE.set(asset.sha256, appId);
  return appId;
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
  const recentTaskStore = ownerProject !== null ? deps.store : targetStore;
  const recentTask =
    rootPath === ""
      ? null
      : await recentTaskStore
          .listRegressionTasks(rootPath, 10)
          .then((tasks) => tasks.find((task) => task.jobSpec === null) ?? null)
          .catch(() => null);
  const explicitPlatforms = params.getAll("platforms").some((value) => value.trim() !== "");
  const recentPlatforms = (recentTask?.platforms ?? []).filter(
    (platform): platform is "ios" | "android" => platform === "ios" || platform === "android"
  );
  let platforms: Array<"ios" | "android"> = explicitPlatforms
    ? dispatchPlatforms(params)
    : recentPlatforms.length > 0
      ? [...new Set(recentPlatforms)].sort()
      : dispatchPlatforms(params);
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
    if (!explicitPlatforms && recentPlatforms.length === 0 && rootPath !== "") {
      try {
        const deviceRunners = await (crossRootRunner ? deps.store : targetStore).listRunners(
          rootPath
        );
        const devicePlatforms = deviceRunners
          .filter((runner) => (runner.hostId ?? runner.name) === targetHost.id)
          .flatMap((runner) => runner.devices.map((device) => device.platform))
          .filter(
            (platform): platform is "ios" | "android" =>
              platform === "ios" || platform === "android"
          );
        if (devicePlatforms.length > 0) {
          platforms = [...new Set(devicePlatforms)].sort();
        }
      } catch {
        /* keep fallback */
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
    }));
  const appPackage = params.has("appPackage")
    ? (params.get("appPackage") ?? "").trim()
    : (recentTask?.appPackage ?? "").trim();
  const skipIosInstall = params.has("skipIosInstall")
    ? params.get("skipIosInstall") === "1"
    : platforms.includes("ios") && recentTask?.appInstallMode === "installed";
  const appVersionExpected = params.has("appVersionExpected")
    ? (params.get("appVersionExpected") ?? "").trim() || null
    : skipIosInstall
      ? (recentTask?.appVersionExpected ?? null)
      : null;
  const requestedAppAssetId = (params.get("appAssetId") ?? "").trim();
  let appAssetId =
    requestedAppAssetId !== "" && appPackages.some((asset) => asset.id === requestedAppAssetId)
      ? requestedAppAssetId
      : null;
  if (requestedAppAssetId !== "" && appAssetId === null) {
    warnings.push("所选安装包不存在或已删除：请重新选择（本次不会安装）");
  }
  if (appAssetId !== null) {
    const selected = packageAssets.find((asset) => asset.id === appAssetId);
    if (skipIosInstall && selected?.filename.toLowerCase().endsWith(".ipa")) {
      appAssetId = null;
      warnings.push("已选择不下发 iOS 安装包：忽略所选 IPA（执行机使用设备已安装应用）");
    }
  }
  if (skipIosInstall && platforms.includes("ios") && appPackage === "") {
    warnings.push("不下发 iOS 安装包时必须填写应用包名（bundle ID）");
  }
  if (!skipIosInstall && platforms.includes("ios") && appAssetId === null) {
    warnings.push(
      platforms.length === 1
        ? "已勾选下发 iOS 安装包：请选择 IPA；如果设备已安装请取消勾选并确认"
        : "混合端任务未选择 IPA：iOS 将使用设备已安装应用"
    );
  }
  if (appVersionExpected !== null && (appVersionExpected.length > 64 || /[\r\n\t]/.test(appVersionExpected))) {
    warnings.push("期望版本过长或包含换行/制表符（最多 64 字符）");
  }
  const materialAssets =
    sourceStore === null || rootPath === ""
      ? []
      : await listWebAssets(sourceStore, rootPath, "materials").catch(() => []);
  const materials = materialAssets.map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    version: asset.version,
    secret: asset.metadata?.secret === true
  }));
  const requestedMaterialsAssetId = (params.get("materialsAssetId") ?? "").trim();
  let materialsAssetId =
    requestedMaterialsAssetId !== "" &&
    materials.some((asset) => asset.id === requestedMaterialsAssetId && asset.secret)
      ? requestedMaterialsAssetId
      : null;
  if (!params.has("materialsAssetId") && recentTask?.materialsAssetId != null) {
    const recentMaterial = materials.find(
      (asset) => asset.id === recentTask.materialsAssetId && asset.secret
    );
    if (recentMaterial !== undefined) materialsAssetId = recentMaterial.id;
  }
  if (requestedMaterialsAssetId !== "") {
    const picked = materials.find((asset) => asset.id === requestedMaterialsAssetId);
    if (picked === undefined) {
      warnings.push("所选测试资料不存在或已删除：请重新选择（本次不使用）");
    } else if (!picked.secret) {
      warnings.push("所选测试资料未标记 secret：仅 secret 资料支持占位符替换（本次不使用）");
    }
  }
  let resolvedAppPackage = appPackage;
  if (appAssetId !== null) {
    const asset = packageAssets.find((entry) => entry.id === appAssetId);
    if (asset) {
      const derived = await appIdForAsset(asset);
      if (derived !== null) resolvedAppPackage = derived;
      else if (resolvedAppPackage === "") {
        warnings.push("未能从安装包自动识别应用包名：执行机将沿用设备当前应用");
      }
    }
  }

  const selectedAppAsset =
    appAssetId === null ? null : (packageAssets.find((asset) => asset.id === appAssetId) ?? null);
  const appInstallMode =
    platforms.includes("ios")
      ? selectedAppAsset?.filename.toLowerCase().endsWith(".ipa")
        ? ("asset" as const)
        : ("installed" as const)
      : null;

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
    appPackage: resolvedAppPackage,
    appPackages,
    skipIosInstall,
    appVersionExpected,
    appInstallMode,
    materialsAssetId,
    materials,
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
  const libraryHref = `/panel?project=${encodeURIComponent(view.rootPath)}&section=assets&tab=case-sets${dispatchHostQuery}#library-import`;
  const packageHref = `/panel?project=${encodeURIComponent(view.rootPath)}&section=assets&tab=packages&kind=package${dispatchHostQuery}#asset-upload`;
  const devicesHref = "/panel?section=devices";
  const runnerHref = "/panel?section=devices#runner-download";
  const warningAction = (warning: string): string => {
    if (warning.includes("还没有用例集")) {
      return `<a class="c-button" href="${escapeHtml(libraryHref)}">去用例库导入 Excel</a>`;
    }
    if (warning.includes("未匹配到任何用例集")) {
      return `<a class="c-button" href="${escapeHtml(libraryHref)}">查看用例库</a>`;
    }
    if (warning.includes("安装包不存在") || (warning.includes("安装包") && warning.includes("已删除"))) {
      return `<a class="c-button" href="${escapeHtml(packageHref)}">重新上传安装包</a>`;
    }
    if (warning.includes("离线") || warning.includes("不在线")) {
      return `<a class="c-button" href="${runnerHref}">查看执行机</a>`;
    }
    return "";
  };
  const warnings = preview.warnings
    .map((warning) => {
      const actions = warningAction(warning);
      return cBanner({
        tone: "warn",
        title: warning,
        ...(actions === "" ? {} : { actions })
      });
    })
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
      ? `<p class="muted">该主机尚未登记项目：套件回归需要项目目录。请在目标机项目根运行 <code>node dist/cli.js suite runner</code>，按 <a href="/panel?section=devices#runner-guide">执行机接入说明</a> 下载/配置；手机是否连接见 <a href="/panel?section=devices">设备页</a>。</p>`
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

  const materialsHref = `/panel?project=${encodeURIComponent(view.rootPath)}&section=assets&tab=materials&kind=materials${dispatchHostQuery}#asset-upload`;
  const appPackageOptions = preview.appPackages
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.id)}" data-platform="${
          asset.platform ?? ""
        }"${asset.id === preview.appAssetId ? " selected" : ""}>${escapeHtml(asset.label)}${
          asset.platform === null ? "" : `（${asset.platform}）`
        }</option>`
    )
    .join("");
  const appAssetField =
    preview.appPackages.length === 0
      ? `<p><label>安装包（可选） <select name="appAssetId" aria-label="安装包" disabled><option>暂无安装包</option></select></label> <a class="c-button" href="${escapeHtml(packageHref)}" target="_blank" rel="noopener">上传 APK/IPA</a> <span class="muted">上传后回到本页点「刷新预览」；设备已安装可跳过。</span></p>`
      : `<p><label>安装包（可选） <select name="appAssetId" aria-label="安装包"><option value="">不安装（设备需已安装）</option>${appPackageOptions}</select></label> <span class="muted">选择后执行机在跑用例前安装；不选则要求设备已安装。</span></p>`;
  const appPackageField =
    preview.appPackage !== "" && !preview.skipIosInstall
      ? `<p class="muted">应用包名：<code>${escapeHtml(preview.appPackage)}</code>${
          preview.appAssetId === null ? "" : "（从安装包自动识别）"
        }</p><input type="hidden" name="appPackage" value="${escapeHtml(preview.appPackage)}">`
      : `<p><label>应用包名（bundle ID） <input type="text" name="appPackage" value="${escapeHtml(
          preview.appPackage
        )}" placeholder="com.example.app" aria-label="应用包名"></label>${
          preview.appAssetId === null ? "" : ' <span class="muted">（从安装包自动识别）</span>'
        }</p>`;
  const iosInstallField = `<div id="dispatch-ios-install"${
    preview.platforms.includes("ios") ? "" : " hidden"
  }>
    <p><label><input type="checkbox" name="skipIosInstall" value="1"${
      preview.skipIosInstall ? " checked" : ""
    }><input type="hidden" name="skipIosInstall" value="0"> 不下发 iOS 安装包（使用设备已安装应用）</label></p>
    <div id="dispatch-ios-installed"${preview.skipIosInstall ? "" : " hidden"}>
      <p class="note">请先在设备上通过 TestFlight 安装目标 App；未安装将无法锁定/启动。</p>
      <p><label><input type="checkbox" name="iosInstalledConfirmed" value="1"${
        view.query.iosInstalledConfirmed === "1" ? " checked" : ""
      }> 我已确认设备已通过 TestFlight 安装该 App</label></p>
      <p><label>期望版本（可选） <input type="text" name="appVersionExpected" value="${escapeHtml(
        preview.appVersionExpected ?? ""
      )}" placeholder="例如 2.0.0 或 2" aria-label="期望版本"></label> <span class="muted">不填则跳过版本校验；填了执行机会在真机运行前比对设备实际版本（模拟器不校验）。</span></p>
    </div>
  </div>`;
  const materialsOptions = preview.materials
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.id)}"${
          asset.id === preview.materialsAssetId ? " selected" : ""
        }${asset.secret ? "" : " disabled"}>v${asset.version} · ${escapeHtml(asset.filename)}${asset.secret ? "（secret）" : "（未标记 secret）"}</option>`
    )
    .join("");
  const materialsField =
    preview.materials.length === 0
      ? `<p><label>测试资料（可选） <select name="materialsAssetId" aria-label="测试资料" disabled><option>暂无测试资料</option></select></label> <a class="c-button" href="${escapeHtml(materialsHref)}" target="_blank" rel="noopener">上传测试资料</a> <span class="muted">仅 secret 资料会解析 <code>&lt;secret:alias&gt;</code> 占位符。</span></p>`
      : `<p><label>测试资料（可选） <select name="materialsAssetId" aria-label="测试资料"><option value="">不使用</option>${materialsOptions}</select></label> <span class="muted">secret 资料按 <code>alias=value</code> 或 JSON 解析；用例里写 <code>&lt;secret:alias&gt;</code>，执行前替换。</span></p>`;

  const paramsBody = [
    `<fieldset class="c-fieldset"><legend>目标端</legend>${platformChecks}</fieldset>`,
    `<p><label>基线 <select name="baseline" aria-label="基线"><option value="latest"${preview.baseline === "latest" ? " selected" : ""}>latest（与本用例集最近批次对比）</option><option value="none"${preview.baseline === "none" ? " selected" : ""}>none（不对比）</option></select></label> · 设备在执行机执行时确定（<code>suite run --device</code>）</p>`,
    iosInstallField,
    appAssetField,
    appPackageField,
    materialsField,
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
  const deviceStat =
    eligibleDevices.length === 0
      ? cStat({
          label: "设备",
          value: preview.devices.length > 0 ? preview.devices.join("、") : deviceSummary
        })
      : eligibleDevices.length === 1
        ? cStat({
            label: "设备",
            value: eligibleDevices[0]!.serial,
            hint: `${eligibleDevices[0]!.platform}${
              eligibleDevices[0]!.model === null ? "" : ` · ${eligibleDevices[0]!.model}`
            }`
          })
        : cStat({
            label: "设备",
            value: `${eligibleDevices.length} 台`,
            hint: eligibleDevices.map((device) => device.serial).join("、")
          });
  const previewBody = [
    `<p id="dispatch-stale" role="status" class="c-banner c-banner-warn" hidden>表单已变更：预览已过期，请重新核对后再派发。 <button class="c-button" type="submit">刷新预览</button></p>`,
    `<p id="dispatch-empty" role="status" class="c-banner c-banner-warn" hidden>预览为空：所选来源尚未应用到预览。 <button class="c-button" type="submit">刷新预览</button> 还没有用例集可 <a href="${escapeHtml(libraryHref)}">先去用例库导入 Excel</a>。</p>`,
    `<div class="c-stats-row">`,
    cStat({ label: "来源", value: preview.source.label || "—" }),
    cStat({ label: "用例数", value: String(preview.source.caseCount) }),
    cStat({ label: "优先级", value: `P${preview.priority}` }),
    cStat({
      label: "目标端",
      value: preview.platforms.map((platform) => platformLabel(platform)).join("、") || "—"
    }),
    ...(preview.platforms.includes("ios")
      ? [
          cStat({
            label: "iOS 安装",
            value:
              preview.appInstallMode === "installed"
                ? "设备已安装（TestFlight）"
                : preview.appInstallMode === "asset"
                  ? "下发 IPA"
                  : "—"
          }),
          cStat({
            label: "期望版本",
            value: preview.appVersionExpected ?? "-"
          })
        ]
      : []),
    cStat({
      label: "安装包",
      value:
        preview.appAssetId === null
          ? "不安装"
          : (preview.appPackages.find((asset) => asset.id === preview.appAssetId)?.filename ??
            "已选择")
    }),
    cStat({
      label: "测试资料",
      value:
        preview.materialsAssetId === null
          ? "不使用"
          : (preview.materials.find((asset) => asset.id === preview.materialsAssetId)?.filename ??
            "已选择")
    }),
    cStat({ label: "应用", value: preview.appPackage || "未指定" }),
    deviceStat,
    `</div>`,
    cTable({
      columns: ["用例集", "用例集 ID", "用例数"],
      rows: refRows,
      caption: "引用用例集明细",
      emptyHtml: `无引用（待选择来源）· <a href="${escapeHtml(libraryHref)}">去用例库</a>`
    }),
    `<p>执行机候选：${
      runnerBadges ||
      `<span class="muted">暂无注册执行机 · <a href="${runnerHref}">下载/接入执行机 →</a></span>`
    }</p>`,
    runnerOnline
      ? ""
      : `<p class="muted">执行机：无在线（派发后任务将排队，等待执行机上线后领取；可手动执行）。<a href="${runnerHref}">下载/接入执行机 →</a></p>`,
    `<p class="muted">设备：${
      eligibleDevices.length === 0
        ? `执行机未上报匹配设备；领取时将自动选择，最终设备见任务页。 <a href="${devicesHref}">查看设备</a>`
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
function syncAppAssets(){
  var sel=form.querySelector('select[name="appAssetId"]');if(!sel)return;
  var picked=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;});
  var skip=!!(form.querySelector('input[name="skipIosInstall"]')||{}).checked;
  Array.prototype.forEach.call(sel.options,function(opt){
    var p=opt.getAttribute('data-platform');
    var ok=!p||picked.indexOf(p)>=0;
    if(skip&&p==='ios')ok=false;
    opt.hidden=!ok;opt.disabled=!ok;
  });
  var current=sel.selectedIndex>=0?sel.options[sel.selectedIndex]:null;
  if(current&&current.disabled){sel.value='';current=null;}
  if(current&&sel.value){
    var selectedPlatform=current.getAttribute('data-platform');
    if(selectedPlatform==='ios'||selectedPlatform==='android'){
      var platformInput=form.querySelector('input[name="platforms"][value="'+selectedPlatform+'"]');
      if(platformInput&&!platformInput.checked){
        platformInput.checked=true;
        syncIosInstall();
        refreshStale();
      }
    }
  }
}
function syncIosInstall(){
  var skip=!!(form.querySelector('input[name="skipIosInstall"]')||{}).checked;
  var ios=Array.prototype.some.call(form.querySelectorAll('input[name="platforms"]:checked'),function(i){return i.value==='ios';});
  var wrap=document.getElementById('dispatch-ios-install');
  var installed=document.getElementById('dispatch-ios-installed');
  if(wrap)wrap.hidden=!ios;
  if(installed)installed.hidden=!skip;
  var confirm=form.querySelector('input[name="iosInstalledConfirmed"]');
  if(confirm)confirm.disabled=!skip;
  var version=form.querySelector('input[name="appVersionExpected"]');
  if(version)version.disabled=!skip;
}
${priorityReadScript}
function formSignature(){
  var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
  var refOrKeyword=mode==='keyword'?((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim():((form.querySelector('select[name="ref"]')||{value:''}).value||'');
  var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;}).sort().join(',');
  var baseline=(form.querySelector('select[name="baseline"]')||{value:'latest'}).value;
  var appAssetId=(form.querySelector('select[name="appAssetId"]')||{value:''}).value;
  var materialsAssetId=(form.querySelector('select[name="materialsAssetId"]')||{value:''}).value;
  var appPackage=((form.querySelector('input[name="appPackage"]')||{value:''}).value||'').trim();
  var skipIosInstall=(form.querySelector('input[name="skipIosInstall"]')||{checked:false}).checked?'1':'0';
  var appVersionExpected=((form.querySelector('input[name="appVersionExpected"]')||{value:''}).value||'').trim();
  return [mode,refOrKeyword,platforms,baseline,appAssetId,materialsAssetId,skipIosInstall,appVersionExpected,appPackage].join('|');
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
form.addEventListener('change',function(){syncIosInstall();syncAppAssets();});
syncIosInstall();
syncAppAssets();
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
  var selectedPlatforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;});
  var iosSelected=selectedPlatforms.indexOf('ios')>=0;
  var skipIos=iosSelected&&!!(form.querySelector('input[name="skipIosInstall"]')||{}).checked;
  var confirmed=!!(form.querySelector('input[name="iosInstalledConfirmed"]')||{}).checked;
  if(skipIos&&!confirmed){showErr('请先勾选确认：设备已通过 TestFlight 安装该 App');return;}
  var appVersionExpected=skipIos?(((form.querySelector('input[name="appVersionExpected"]')||{value:''}).value||'').trim()):'';
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
  var appText=skipIos
    ? ('iOS 设备已安装（TestFlight）'+(appVersionExpected===''?'':(' · 期望版本 '+appVersionExpected)))
    : (appAssetId===''?'不安装（设备需已安装）':('安装 '+appLabel));
  var matSel=form.querySelector('select[name="materialsAssetId"]');
  var materialsAssetId=matSel?matSel.value:'';
  var matLabel=matSel&&matSel.selectedIndex>=0?matSel.options[matSel.selectedIndex].text:'';
  var matText=materialsAssetId===''?'不使用测试资料':('测试资料 '+matLabel);
  var appPackage=((form.querySelector('input[name="appPackage"]')||{value:''}).value||'').trim();
  var appPackageText=appPackage===''?'应用未指定':('应用 '+appPackage);
  var text='将创建回归任务：目标主机「'+hostName+'」 · 来源「'+(s.label||'—')+'」 · 用例 '+(s.caseCount==null?'—':s.caseCount)+' 条'+refText+' · 端 '+((s.platforms||[]).join('、')||'—')+' · 基线 '+(s.baseline||'latest')+' · '+appText+' · '+matText+' · '+appPackageText+' · 优先级 P'+priority+' · 执行机：'+runner;
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
    payload.materialsAssetId=materialsAssetId;
    payload.appPackage=appPackage;
    payload.skipIosInstall=skipIos;
    payload.iosInstalledConfirmed=skipIos?confirmed:false;
    payload.appVersionExpected=appVersionExpected;
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
          ? `<p class="note">该主机尚未登记项目：请在目标机项目根运行 <code>node dist/cli.js suite runner</code>（按 <a href="/panel?section=devices#runner-guide">执行机接入说明</a> 配置）后刷新本页。设备连接状态见 <a href="/panel?section=devices">设备页</a>。</p>`
          : projectMissing
            ? `<p class="note">请先选择该主机上的项目，再刷新预览。</p>`
            : needsHostPick && !legacyHostless
              ? `<p class="note">请先选择目标主机：已登记主机时不再隐式回退本机。</p>`
              : preview.hostBlocked
                ? `<p class="note">目标主机无法满足所选平台：请调整目标端或更换主机，刷新预览后再试。</p>`
                : "",
        `<p class="note">安装包在「② 参数」选择；执行机领取后先安装再跑用例。iOS 不下发 IPA 时，请先通过 TestFlight 安装并勾选确认，执行机会跳过安装、只锁定并启动已安装应用。Excel 用例先在用例库导入。</p>`,
        `<p id="dispatch-status" role="status" class="muted"></p>`,
        `<p id="dispatch-error" role="alert" class="c-banner c-banner-warn" hidden></p>`,
        `<script type="application/json" id="dispatch-preview-data">${JSON.stringify({ previewId: view.previewId, formSignature: view.formSignature, project: view.rootPath, hostId: preview.selectedHostId, hostLabel:
          preview.hosts.find((host) => host.id === preview.selectedHostId)?.label ??
          preview.hosts.find((host) => host.id === preview.selectedHostId)?.hostname ??
          null, hostRequired: preview.hosts.length > 0, hostBlocked: preview.hostBlocked, legacyHostless, priority: preview.priority, ready: preview.refs.length > 0, runnerOnline, runnerOnlineCount, refsDetail: preview.refDetails.map((detail) => ({ label: detail.label, caseCount: detail.caseCount })), summary: { label: preview.source.label, caseCount: preview.source.caseCount, platforms: preview.platforms, baseline: preview.baseline, skipIosInstall: preview.skipIosInstall, appVersionExpected: preview.appVersionExpected, appInstallMode: preview.appInstallMode } }).replace(/</g, "\\u003c")}</script>`,
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
  const installCallout = `<div class="c-flow-callout"><div><strong>要下发安装包（APK/IPA）？</strong><p>在「② 参数」选择安装包即可：执行机领取任务后先安装再跑用例，不要求设备预装。iOS 也可以勾选「不下发 iOS 安装包」，改用设备上通过 TestFlight 安装的版本，并在确认后下发；此时可填期望版本做运行前校验。</p></div></div>`;
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
