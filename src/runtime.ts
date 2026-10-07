import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadDotenvValues, type LoadedProject } from "./config/loader.js";
import { makeResolver } from "./config/validate.js";
import { StateStore } from "./state.js";
import {
  buildBareChildSpec,
  buildChildEnvForEntry,
  buildChildSpecForEntry,
  configDirAbs,
  projectTracesDir,
  renderProjectArtemisConfig,
  resolveArtemisPython,
  type ChildSpec,
  type EntryLike,
  type ResolvedPython
} from "./artemis/assembly.js";
import { mirrorDeviceScreenshots } from "./artemis/artifacts.js";
import { ArtemisProxy, type ArtemisProxyLike } from "./artemis/proxy.js";
import { resultPayload, taskStatusFromFile, taskStatusOf, type TaskStatus } from "./artemis/task-result.js";
import { maybeIosInspectTrace } from "./ios/inspect.js";
import { maybeIosManageTask, maybeIosRunTask } from "./ios/task-runner.js";
import { reconcileIosTrace, isIosTraceDir } from "./ios/trace-store.js";
import { collectIosCrashes } from "./crash/ios.js";
import { maybeIosDeviceState } from "./tools/ios-state.js";
import { appendChildLog } from "./log.js";
import { CrashIndexStore } from "./crash/store.js";
import { CrashScanner } from "./crash/scanner.js";
import type { CrashCollectorLike, CrashScanReport, CrashScanResult } from "./crash/types.js";
import { findGeneratedCaseId } from "./figma/case-index.js";
import { jiraConfigFrom, type ResolvedJiraConfig } from "./jira/config.js";
import { MemoryStore } from "./db/memory.js";
import { TERMINAL_TASK_STATUSES } from "./db/types.js";
import type {
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  RecordUsageEventInput,
  TaskStatRecord,
  UsageEventQuery,
  UsageEventRecord
} from "./db/types.js";
import { writeEnvUpdates } from "./env-file.js";
import { ModelCatalog, type FetchLike, type ModelReport, type RefreshReport } from "./llm/catalog.js";
import {
  entriesFromConfig,
  entryFromEnvScan,
  entryFromStore,
  entryIssues,
  mergeEntries,
  type LlmEntry
} from "./llm/registry.js";
import {
  ENV_FIGMA_TOKEN,
  ENV_LLM_API_KEY,
  ENV_LLM_BASE_URL,
  ENV_LLM_MODEL,
  scanProjectEnv,
  type EnvScanResult
} from "./projects/scan.js";
import { usageEnabledFrom, usageEventSampleLimit, usagePolicyFrom } from "./usage/capture.js";
import {
  errorMessage,
  isBuildStale,
  isProcessAlive,
  logWarn,
  processCmdline,
  sleep,
  terminateProcess,
  writeFileAtomic
} from "./util.js";

export interface RuntimeOptions {
  store?: ProjectStore;
  proxy?: ArtemisProxyLike;
  baseEnv?: NodeJS.ProcessEnv;
  storeNote?: string | null;
  crashCollector?: CrashCollectorLike;
  iosCrashCollector?: typeof collectIosCrashes;
  iosCrashRetry?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };
  modelFetcher?: FetchLike;
  buildModuleUrl?: string;
}

export interface ActivateResult {
  ok: boolean;
  blockedBy?: "unknown" | "incomplete" | "active_tasks";
  error?: string;
  available?: string[];
  missing?: string[];
  fix?: string;
  active?: string;
  previous?: string | null;
  effects?: {
    modelConfig: string;
    childRestarted: boolean;
    restartReason: string;
  };
  warnings: string[];
}

export interface SetupInfo {
  required: boolean;
  missing: string[];
  message: string;
  howToFix: string[];
}

export interface ModelPreflight {
  ok: boolean;
  warnings: string[];
  payload?: Record<string, unknown>;
}

export class Runtime {
  readonly project: LoadedProject;
  readonly store: ProjectStore;
  readonly proxy: ArtemisProxyLike;
  readonly storeNote: string | null;
  readonly configDirAbs: string;
  readonly state: StateStore;
  readonly crashStore: CrashIndexStore;
  readonly crashScanner: CrashScanner;
  readonly modelCatalog: ModelCatalog;

  private readonly buildModuleUrl: string;
  private readonly buildStartedAtMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private scanResult: EnvScanResult;
  private projectRecord: ProjectRecord | null = null;
  private activeCache: { name: string; entry: LlmEntry } | null = null;
  private initialized = false;
  private lastStoreError: string | null = null;
  private activationChain: Promise<unknown> = Promise.resolve();
  private crashScanChain: Promise<unknown> = Promise.resolve();
  private modelRefreshChain: Promise<unknown> = Promise.resolve();
  private readonly lockedPackages = new Map<string, string>();
  private readonly iosCrashCollector: typeof collectIosCrashes | null;
  private readonly iosCrashRetry: {
    attempts: number;
    delayMs: number;
    sleep: (ms: number) => Promise<void>;
  };

  /** Build freshness is evaluated on every read, so a rebuild that happens
   * while this process keeps running surfaces in `aos_status.build.stale`. */
  get build(): { moduleUrl: string; startedAtMs: number; stale: boolean } {
    return {
      moduleUrl: this.buildModuleUrl,
      startedAtMs: this.buildStartedAtMs,
      stale: isBuildStale(this.buildModuleUrl, this.buildStartedAtMs)
    };
  }

  constructor(project: LoadedProject, options: RuntimeOptions = {}) {
    this.project = project;
    this.store = options.store ?? new MemoryStore();
    this.storeNote = options.storeNote ?? null;
    this.baseEnv = options.baseEnv ?? process.env;
    this.iosCrashCollector = options.iosCrashCollector ?? null;
    this.iosCrashRetry = {
      attempts: Math.max(1, options.iosCrashRetry?.attempts ?? 3),
      delayMs: Math.max(0, options.iosCrashRetry?.delayMs ?? 2_000),
      sleep: options.iosCrashRetry?.sleep ?? ((ms) => sleep(ms))
    };
    this.configDirAbs = configDirAbs(project.config, project.rootDir);
    this.state = new StateStore(path.join(this.configDirAbs, "state.json"));
    this.buildModuleUrl = options.buildModuleUrl ?? import.meta.url;
    this.buildStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
    if (this.build.stale) {
      logWarn(
        "检测到 dist/ 较本进程更新：当前进程仍在运行旧构建，请重启客户端 MCP 会话后生效（aos_status.build.stale）"
      );
    }
    this.scanResult = scanProjectEnv(project.resolver);
    // Model-catalog knobs read project .env first, then the process env
    // (client-config env wins so fleet-wide policy can override).
    this.modelCatalog = new ModelCatalog({
      env: { ...project.dotenvValues, ...this.baseEnv },
      fetchImpl: options.modelFetcher
    });
    this.crashStore = new CrashIndexStore(path.join(this.configDirAbs, "crashes"), {
      maxRecords: resolveCrashMaxRecords(this.baseEnv)
    });
    this.crashScanner = new CrashScanner({
      tracesDir: this.tracesDir(),
      store: this.crashStore,
      env: this.baseEnv,
      collector: options.crashCollector
    });
    this.proxy = this.withArtifactMirror(options.proxy ?? this.buildDefaultProxy());
  }

  /** Wrap any proxy so tool results from artemis still get a project-side copy
   * of live device screenshots (upstream writes them under the artemis repo).
   * Read-only mobile tools targeting an iOS simulator UDID / iOS trace id are
   * served by the in-process AOS backend instead of ARTEMIS. */
  private withArtifactMirror(inner: ArtemisProxyLike): ArtemisProxyLike {
    return {
      isRunning: () => inner.isRunning(),
      ensureStarted: () => inner.ensureStarted(),
      listTools: (force) => inner.listTools(force),
      callTool: async (name, args) => {
        const iosResult = await this.maybeIosCall(name, args);
        if (iosResult) {
          this.mirrorToolArtifacts(name, iosResult);
          return iosResult;
        }
        const result = this.normalizeRunTaskWarnings(name, await inner.callTool(name, args));
        this.mirrorToolArtifacts(name, result);
        return result;
      },
      status: () => inner.status(),
      markForRestart: () => inner.markForRestart(),
      dispose: () => inner.dispose(),
      disposeSync: () => inner.disposeSync()
    };
  }

  private async maybeIosCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult | null> {
    if (name === "mobile_run_task") return await maybeIosRunTask(this, args);
    if (name === "mobile_manage_task") return maybeIosManageTask(this, args);
    if (name === "mobile_get_device_state") return await maybeIosDeviceState(this, args);
    if (name === "mobile_inspect_trace") return maybeIosInspectTrace(this, args);
    return null;
  }

  private normalizeRunTaskWarnings(name: string, result: CallToolResult): CallToolResult {
    if (name !== "mobile_run_task") return result;
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) return result;
    const first = content[0];
    if (first.type !== "text") return result;
    try {
      const payload = JSON.parse(first.text) as unknown;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return result;
      const record = payload as Record<string, unknown>;
      if (Array.isArray(record.warnings)) return result;
      record.warnings = [];
      return {
        ...result,
        content: [{ ...first, text: JSON.stringify(record, null, 2) }, ...content.slice(1)]
      };
    } catch {
      return result;
    }
  }

  private mirrorToolArtifacts(name: string, result: CallToolResult): void {
    if (name !== "mobile_get_device_state") return;
    try {
      const { errors } = mirrorDeviceScreenshots(this.project.config, this.project.rootDir, result);
      for (const error of errors) logWarn(`真机截图镜像失败: ${error}`);
    } catch (error) {
      logWarn(`真机截图镜像失败: ${errorMessage(error)}`);
    }
  }

  private buildDefaultProxy(): ArtemisProxyLike {
    return new ArtemisProxy({
      prepare: () => this.prepareChildSpec(),
      onSpawned: ({ pid, fingerprint }) => {
        const state = this.state.read();
        this.state.write({
          ...state,
          child: {
            ownerPid: process.pid,
            pid: pid ?? undefined,
            fingerprint,
            startedAt: new Date().toISOString()
          }
        });
      },
      onStderrLine: (line) => appendChildLog(line)
    });
  }

  // ------------------------------------------------------------------
  // Initialization: register project, import .env LLM on first enable.
  // ------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.projectRecord = await this.safeStore(
      () =>
        this.store.upsertProject({
          rootPath: this.project.rootDir,
          name: path.basename(this.project.rootDir)
        }),
      null
    );

    if (this.scanResult.figmaToken && this.projectRecord && !this.projectRecord.figmaToken) {
      await this.safeStore<void>(async () => {
        await this.store.setFigmaToken(this.project.rootDir, this.scanResult.figmaToken);
        this.projectRecord = await this.store.getProjectByPath(this.project.rootDir);
      }, undefined);
    }

    const scan = this.scanResult.llm;
    if (scan?.complete) {
      const existing = await this.safeStore(
        () => this.store.listLlms(this.project.rootDir),
        [] as ProjectLlmRecord[]
      );
      if (existing.length === 0) {
        await this.safeStore(
          () =>
            this.store.upsertLlm(this.project.rootDir, {
              name: scan.name,
              provider: "custom",
              model: scan.model!,
              baseUrl: scan.baseUrl,
              apiKey: scan.apiKey,
              makeActive: true
            }),
          null
        );
      }
    }

    const active = await this.activeEntry();
    this.activeCache = active ? { name: active.name, entry: active } : null;
    // Materialize the active entry as the project artemis config: task_runner
    // reads it through ARTEMIS_ARTEMIS_JSONC, so the first-enable import must
    // persist it even before any llm_switch/aos_configure call.
    if (active) {
      this.writeActiveConfig(active);
    }
  }

  /** Write <configDir>/artemis.jsonc (unified format, merged over the artemis
   * base config) and drop the legacy llm-config.override.jsonc, whose format
   * artemis' loader silently ignores. */
  private writeActiveConfig(entry: LlmEntry): void {
    const basePath = path.join(this.project.config.artemis.repo, "config", "artemis.jsonc");
    let baseConfigText: string | null = null;
    try {
      baseConfigText = fs.existsSync(basePath) ? fs.readFileSync(basePath, "utf-8") : null;
    } catch {
      baseConfigText = null;
    }
    const configPath = path.join(this.configDirAbs, "artemis.jsonc");
    writeFileAtomic(configPath, renderProjectArtemisConfig({ baseConfigText, entry }));
    try {
      fs.rmSync(path.join(this.configDirAbs, "llm-config.override.jsonc"), { force: true });
    } catch {
      /* best effort */
    }
  }

  // ------------------------------------------------------------------
  // Entries / active resolution
  // ------------------------------------------------------------------

  async entries(): Promise<LlmEntry[]> {
    const records = await this.safeStore(
      () => this.store.listLlms(this.project.rootDir),
      [] as ProjectLlmRecord[]
    );
    const configEntries = entriesFromConfig(this.project.config, this.project.resolver);
    const envEntry = entryFromEnvScan(this.scanResult);
    return mergeEntries(records.map(entryFromStore), configEntries, envEntry ? [envEntry] : []);
  }

  async activeEntry(): Promise<LlmEntry | null> {
    const entries = await this.entries();
    if (entries.length === 0) return null;

    const storeActive = entries.find((entry) => entry.source === "store" && entry.isActive);
    if (storeActive) return storeActive;

    const stateName = this.state.read().activeProfile;
    if (stateName) {
      const hit = entries.find((entry) => entry.name === stateName);
      if (hit) return hit;
    }

    // Active .env-declared LLM wins over the optional config file's default.
    const envEntry = entries.find(
      (entry) => entry.source === "env" && entryIssues(entry).length === 0
    );
    if (envEntry) return envEntry;

    const configDefault = this.project.config.llm.defaultProfile;
    if (configDefault) {
      const hit = entries.find((entry) => entry.name === configDefault);
      if (hit) return hit;
    }

    return entries[0] ?? null;
  }

  async setupInfo(): Promise<SetupInfo> {
    const entries = await this.entries();
    const usable = entries.filter((entry) => entryIssues(entry).length === 0);
    if (usable.length > 0) {
      return { required: false, missing: [], message: "", howToFix: [] };
    }

    const missing: string[] = [];
    if (this.scanResult.llm?.missing?.length) {
      missing.push(...this.scanResult.llm.missing);
    }
    for (const entry of entries) {
      for (const issue of entryIssues(entry)) {
        if (!missing.includes(issue)) missing.push(issue);
      }
    }
    if (missing.length === 0) {
      missing.push(`${ENV_LLM_MODEL} / ${ENV_LLM_BASE_URL} / ${ENV_LLM_API_KEY}（OpenAI 兼容三元组）`);
    }

    return {
      required: true,
      missing,
      message: "项目尚未配置可用的 LLM：扫描项目 .env 未找到完整条目，且无可激活的配置档案。",
      howToFix: [
        "方式 A（推荐）：调用 aos_configure 工具提供 model / base_url / api_key（将写入项目 .env 与数据库）",
        `方式 B：在 ${path.join(this.project.rootDir, ".env")} 中添加上述变量后重试`
      ]
    };
  }

  /** Re-read the project .env (after aos_configure writes it) and rebuild derived state. */
  refreshProjectEnv(): void {
    this.project.dotenvValues = loadDotenvValues(this.project.rootDir);
    this.project.resolver = makeResolver(this.project.dotenvValues, this.baseEnv);
    this.scanResult = scanProjectEnv(this.project.resolver);
  }

  // ------------------------------------------------------------------
  // Activation (llm_switch / aos_configure core)
  // ------------------------------------------------------------------

  activateEntry(name: string, options: { force?: boolean } = {}): Promise<ActivateResult> {
    const run = this.activationChain.then(
      () => this.doActivate(name, options),
      () => this.doActivate(name, options)
    );
    this.activationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async doActivate(name: string, options: { force?: boolean }): Promise<ActivateResult> {
    const warnings: string[] = [];
    const entries = await this.entries();
    const target = entries.find((entry) => entry.name === name);
    if (!target) {
      return {
        ok: false,
        blockedBy: "unknown",
        error: `未知条目 "${name}"。`,
        available: entries.map((entry) => entry.name),
        warnings
      };
    }

    const issues = entryIssues(target);
    if (issues.length > 0) {
      return {
        ok: false,
        blockedBy: "incomplete",
        error: `条目 "${name}" 不完整：${issues.join("；")}。`,
        missing: issues,
        fix: "调用 aos_configure 补全（或编辑项目 .env）后重试。",
        warnings
      };
    }

    const current = await this.activeEntry();
    const targetFingerprint = this.envFingerprintForEntry(target);
    const running = this.proxy.isRunning();
    // Compare against the env the live child actually runs with (falls back to
    // the current entry when the proxy cannot report it, e.g. test stubs).
    const runningFingerprint = running ? this.proxy.status().fingerprint : null;
    const baseline =
      runningFingerprint ?? (current ? this.envFingerprintForEntry(current) : null);
    // A bare child (no LLM yet) must be restarted once a real entry activates.
    const needsRestart = running && baseline !== targetFingerprint;

    if (needsRestart && !options.force) {
      const counts = await this.queryTaskCounts();
      if (counts && counts.active + counts.queued > 0) {
        return {
          ok: false,
          blockedBy: "active_tasks",
          error:
            `检测到 ${counts.active} 个运行中 / ${counts.queued} 个排队中的 artemis 任务。` +
            `切换 provider/key/base_url 需要重启 artemis 网关子进程（任务本身为 detached 进程不会中断，` +
            `但重启瞬间的在途工具调用会失败）。`,
          fix: "等待任务完成后重试，或使用 force: true 强制切换。",
          warnings
        };
      }
      if (!counts) {
        warnings.push("未能通过 mobile_diagnose 确认运行中任务（子进程可能异常）；已继续切换。");
      }
    }

    // Persist the active pointer (store first, local state always as fallback).
    if (target.source === "store") {
      const ok = await this.safeStore(
        () => this.store.setActiveLlm(this.project.rootDir, name),
        false
      );
      if (!ok) {
        warnings.push(
          `活跃指针写入存储失败${this.lastStoreError ? `（${this.lastStoreError}）` : ""}：已写入本地 state 兜底。`
        );
      }
    } else {
      const stored = await this.safeStore(
        () =>
          this.store.upsertLlm(this.project.rootDir, {
            name,
            provider: target.provider,
            baseUrl: target.baseUrl,
            model: target.model,
            apiKey: target.apiKey,
            makeActive: true
          }),
        null
      );
      if (!stored) {
        warnings.push("条目导入存储失败（降级）：active 仅写入本地 state。");
      }
    }

    const state = this.state.read();
    state.activeProfile = name;
    if (needsRestart) {
      await this.proxy.markForRestart();
      delete state.child;
    }
    this.state.write(state);

    const configPath = path.join(this.configDirAbs, "artemis.jsonc");
    this.writeActiveConfig(target);

    this.activeCache = { name, entry: { ...target, isActive: true } };

    const hasExplicitNodes =
      target.nodeOverrides !== null && Object.keys(target.nodeOverrides).length > 0;
    if (target.provider !== "google" && !hasExplicitNodes) {
      warnings.push(
        "非 Google provider：object_detector/hopper 已自动重指到当前模型（失去 Gemini ER 亚像素定位精度）。"
      );
    }
    if (target.provider !== "google") {
      warnings.push(
        "Flash 步骤摘要器已禁用（其后端硬绑定 Google 轻量模型）；记忆 chunk 压缩与 Pro 轻量裁判在触发时可能降级，需 Google key 才能完全启用。"
      );
    }

    return {
      ok: true,
      active: name,
      previous: current?.name ?? null,
      effects: {
        modelConfig: `已写入 ${path.relative(this.project.rootDir, configPath)}（下一个 mobile_run_task 生效）`,
        childRestarted: needsRestart,
        restartReason: needsRestart
          ? "provider/key/base_url 变化"
          : running
            ? "仅模型配置变化，无需重启"
            : "artemis 子进程未运行"
      },
      warnings
    };
  }

  // ------------------------------------------------------------------
  // Task stats / figma
  // ------------------------------------------------------------------

  async recordTaskSubmission(input: {
    traceId?: string | null;
    model?: string | null;
    profile?: string | null;
    status?: string;
    taskDesc?: string | null;
    caseId?: string | null;
    lockedAppPackage?: string | null;
  }): Promise<void> {
    const providedTrace = input.traceId?.trim() ?? "";
    const traceId = providedTrace !== "" ? providedTrace : `local-${randomUUID()}`;
    const status = providedTrace === "" ? "failed" : input.status ?? "submitted";
    if (input.lockedAppPackage && status === "submitted") {
      this.lockedPackages.set(traceId, input.lockedAppPackage);
      if (this.lockedPackages.size > 200) {
        const oldest = this.lockedPackages.keys().next().value;
        if (oldest !== undefined) this.lockedPackages.delete(oldest);
      }
    }
    await this.safeStore<void>(async () => {
      await this.store.recordTask({
        rootPath: this.project.rootDir,
        traceId,
        model: input.model ?? null,
        profile: input.profile ?? null,
        status,
        taskDesc: input.taskDesc ?? null,
        caseId: input.caseId ?? null,
        finishedAt: status === "submitted" ? null : new Date().toISOString()
      });
    }, undefined);
  }

  async recordTaskResult(input: {
    isError: boolean;
    traceId?: string | null;
    model?: string | null;
    taskDesc?: string | null;
    lockedAppPackage?: string | null;
  }): Promise<void> {
    const traceId = input.isError ? null : input.traceId?.trim() || null;
    await this.recordTaskSubmission({
      traceId,
      model: input.model ?? null,
      profile: null,
      status: input.isError || !traceId ? "failed" : "submitted",
      taskDesc: input.taskDesc ?? null,
      caseId: findGeneratedCaseId(this.configDirAbs, input.taskDesc),
      lockedAppPackage: input.lockedAppPackage ?? null
    });
  }

  /** Poll artemis for pending task_statuses and mark terminal ones finished.
   * Prefers reading the trace store's status.json directly (works across
   * sessions, no child process needed); falls back to the live proxy. */
  traceDir(traceId: string): string {
    return path.join(this.tracesDir(), traceId);
  }

  async traceStatus(traceId: string): Promise<TaskStatus | null> {
    const statusPath = path.join(this.traceDir(traceId), "status.json");
    let fromFile = taskStatusFromFile(statusPath);
    if (fromFile?.status === "running" || fromFile === null) {
      const reconciled = reconcileIosTrace(this.traceDir(traceId), traceId);
      if (reconciled?.status === "orphaned") fromFile = taskStatusFromFile(statusPath) ?? fromFile;
    }
    if (fromFile?.status) return fromFile;
    if (!this.proxy.isRunning()) return fromFile;
    try {
      const result = await this.proxy.callTool("mobile_manage_task", {
        action: "status",
        trace_id: traceId
      });
      return taskStatusOf(resultPayload(result)) ?? fromFile;
    } catch {
      return fromFile;
    }
  }

  async syncTaskStatuses(): Promise<{ checked: number; updated: number }> {
    const pending = await this.safeStore(
      () => this.store.listPendingTasks(this.project.rootDir, 20),
      [] as TaskStatRecord[]
    );
    let updated = 0;
    for (const task of pending) {
      let status = this.readTraceStatus(task.traceId);
      if (status === null) status = await this.queryTaskStatusViaProxy(task.traceId);
      if (status && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
        const done = await this.safeStore(
          () => this.store.markTaskFinished(this.project.rootDir, task.traceId, status!),
          false
        );
        if (done) {
          updated += 1;
          void this.scanTraceByPlatform(
            { ...task, status: status ?? task.status },
            task.traceId,
            false
          ).catch((error) => {
            logWarn(`崩溃取证失败（trace=${task.traceId}）: ${errorMessage(error)}`);
          });
        }
      }
    }
    return { checked: pending.length, updated };
  }

  // ------------------------------------------------------------------
  // Crash forensics: terminal tasks are scanned for device-side crashes.
  // ------------------------------------------------------------------

  crashCaptureEnabled(): boolean {
    return this.crashScanner.enabled();
  }

  /** iOS crash capture: scan host DiagnosticReports `.ips` files written inside
   * the task window and upsert them into the same crash index as Android. */
  async captureIosCrashes(
    input: { traceId: string; udid: string; processName: string | null; startMs: number; endMs: number },
    deps: { collect?: typeof collectIosCrashes } = {}
  ): Promise<CrashScanResult> {
    const collect = deps.collect ?? this.iosCrashCollector ?? collectIosCrashes;
    try {
      const collected = collect({
        startMs: input.startMs,
        endMs: input.endMs,
        processName: input.processName
      });
      if (collected.skipped) {
        return { traceId: input.traceId, status: "skipped", reason: collected.skipped, found: 0 };
      }
      if (collected.records.length === 0) {
        return { traceId: input.traceId, status: "empty", found: 0 };
      }
      const result = this.crashStore.upsert(collected.records, {
        traceId: input.traceId,
        taskOutcome: "failed",
        deviceSerial: input.udid,
        capturedAt: new Date().toISOString(),
        source: "diagnostic-reports"
      });
      return {
        traceId: input.traceId,
        status: "captured",
        found: collected.records.length,
        newIds: result.newIds,
        updatedIds: result.updatedIds,
        source: "diagnostic-reports"
      };
    } catch (error) {
      return { traceId: input.traceId, status: "skipped", reason: errorMessage(error), found: 0 };
    }
  }

  /** Serializes every crash scan (sync-triggered and manual) per runtime. */
  private enqueueCrashTask<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.crashScanChain.then(fn, fn);
    this.crashScanChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Await all crash scans enqueued so far (used by tests and the scan tool). */
  async flushCrashScans(): Promise<void> {
    await this.crashScanChain;
  }

  private async scanTraceWithFallbacks(task: TaskStatRecord | null, traceId: string, force: boolean): Promise<CrashScanResult> {
    return await this.enqueueCrashTask(() =>
      this.crashScanner.scanTrace({
        traceId,
        taskOutcome: task?.status ?? null,
        targetPackage: this.lockedPackages.get(traceId) ?? null,
        fallbackStartMs: task ? parseIsoMs(task.submittedAt) : null,
        fallbackEndMs: task ? parseIsoMs(task.finishedAt) : null,
        force
      })
    );
  }

  /** Scan one explicit trace (force), all un-scanned terminal tasks, and (no traceId) proactively the device. */
  async scanTraceForCrashes(
    input: { traceId?: string; force?: boolean; since?: string; packageFilter?: string } = {}
  ): Promise<CrashScanReport> {
    const enabled = this.crashScanner.enabled();
    const tasks = await this.taskList(200);
    if (input.traceId) {
      const task = tasks.find((item) => item.traceId === input.traceId) ?? null;
      const result = await this.scanTraceByPlatform(task, input.traceId, input.force !== false);
      return { enabled, results: [result] };
    }
    const pending = tasks
      .filter(
        (task) =>
          (TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status) &&
          !this.crashStore.isScanned(task.traceId)
      )
      .slice(0, CRASH_SCAN_BATCH);
    const results: CrashScanResult[] = [];
    for (const task of pending) {
      results.push(await this.scanTraceByPlatform(task, task.traceId, false));
    }
    // 无 traceId：主动收集当前设备的 crash buffer（不依赖任务/trace）
    const sinceMs = input.since ? parseIsoMs(input.since) : null;
    results.push(
      await this.enqueueCrashTask(() =>
        this.crashScanner.scanDevice({
          sinceMs,
          targetPackage: input.packageFilter ?? null
        })
      )
    );
    return { enabled, results };
  }

  private async scanTraceByPlatform(
    task: TaskStatRecord | null,
    traceId: string,
    force: boolean
  ): Promise<CrashScanResult> {
    if (isIosTraceDir(this.traceDir(traceId), traceId)) {
      return await this.enqueueCrashTask(() => this.scanIosTraceForCrashes(traceId, task));
    }
    return await this.scanTraceWithFallbacks(task, traceId, force);
  }

  private async scanIosTraceForCrashes(
    traceId: string,
    task: TaskStatRecord | null
  ): Promise<CrashScanResult> {
    if (!this.crashScanner.enabled()) {
      return { traceId, status: "skipped", reason: "disabled", found: 0 };
    }
    const status = await this.traceStatus(traceId);
    const startMs = status?.startTimeMs ?? (task ? parseIsoMs(task.submittedAt) : null);
    if (startMs === null) {
      this.crashStore.recordScan(traceId, {
        at: new Date().toISOString(),
        found: 0,
        skipped: "no-window"
      });
      return { traceId, status: "skipped", reason: "no-window", found: 0 };
    }
    const endMs =
      status?.endTimeMs ?? (task?.finishedAt ? parseIsoMs(task.finishedAt) : null) ?? Date.now();
    const processName = this.lockedPackages.get(traceId)?.split(".").pop() ?? null;
    const udid = status?.deviceSerial ?? "";
    let result: CrashScanResult = { traceId, status: "skipped", reason: "unknown", found: 0 };
    for (let attempt = 1; attempt <= this.iosCrashRetry.attempts; attempt += 1) {
      result = await this.captureIosCrashes({ traceId, udid, processName, startMs, endMs });
      if (result.status !== "empty") break;
      if (attempt < this.iosCrashRetry.attempts) {
        await this.iosCrashRetry.sleep(this.iosCrashRetry.delayMs);
      }
    }
    const skipped = result.status === "skipped" ? result.reason ?? "collector-skipped" : null;
    this.crashStore.recordScan(traceId, {
      at: new Date().toISOString(),
      found: result.found,
      ...(skipped ? { skipped } : {})
    });
    return result;
  }

  private tracesDir(): string {
    return projectTracesDir(this.project.config, this.project.rootDir, this.baseEnv);
  }

  private readTraceStatus(traceId: string): string | null {
    const statusPath = path.join(this.tracesDir(), traceId, "status.json");
    return taskStatusFromFile(statusPath)?.status ?? null;
  }

  private async queryTaskStatusViaProxy(traceId: string): Promise<string | null> {
    if (!this.proxy.isRunning()) return null;
    try {
      const result = await this.proxy.callTool("mobile_manage_task", {
        action: "status",
        trace_id: traceId
      });
      return taskStatusOf(resultPayload(result))?.status ?? null;
    } catch {
      /* fall through */
    }
    return null;
  }

  async taskList(limit = 20): Promise<TaskStatRecord[]> {
    return await this.safeStore(
      () => this.store.listTasks(this.project.rootDir, limit),
      [] as TaskStatRecord[]
    );
  }

  async figmaTokenInfo(): Promise<{ value: string | null; source: "store" | "env" | null }> {
    const record = await this.safeStore(
      () => this.store.getProjectByPath(this.project.rootDir),
      this.projectRecord
    );
    if (record?.figmaToken) return { value: record.figmaToken, source: "store" };
    if (this.scanResult.figmaToken) return { value: this.scanResult.figmaToken, source: "env" };
    return { value: null, source: null };
  }

  figmaTokenScanVar(): string | null {
    return this.scanResult.figmaTokenVar ?? ENV_FIGMA_TOKEN;
  }

  jiraConfig(): ResolvedJiraConfig {
    return jiraConfigFrom(this.project.resolver);
  }

  projectSummary(): ProjectRecord | null {
    return this.projectRecord;
  }

  storeKind(): "postgres" | "memory" {
    return this.store.kind;
  }

  storeError(): string | null {
    return this.lastStoreError;
  }

  private lastUsageAtMs = 0;

  usageEnabled(): boolean {
    return usageEnabledFrom(this.baseEnv);
  }

  usageSampleLimit(): number {
    return usageEventSampleLimit(this.baseEnv);
  }

  async recordUsage(input: RecordUsageEventInput): Promise<UsageEventRecord | null> {
    if (!this.usageEnabled()) return null;
    let at = input.at;
    if (!at) {
      const atMs = Math.max(Date.now(), this.lastUsageAtMs + 1);
      this.lastUsageAtMs = atMs;
      at = new Date(atMs).toISOString();
    }
    try {
      return await this.store.recordUsageEvent(
        this.project.rootDir,
        { ...input, at },
        usagePolicyFrom(this.baseEnv)
      );
    } catch (error) {
      logWarn(`使用统计记录失败: ${errorMessage(error)}`);
      return null;
    }
  }

  async listUsageEvents(query: UsageEventQuery = {}): Promise<UsageEventRecord[]> {
    return await this.safeStore(
      () => this.store.listUsageEvents(this.project.rootDir, query),
      [] as UsageEventRecord[]
    );
  }

  // ------------------------------------------------------------------
  // Model catalog: periodic refresh of vendor model lists + auto repair
  // ------------------------------------------------------------------

  modelRefreshHours(): number {
    return this.modelCatalog.ttlHours();
  }

  modelAutoRepairEnabled(): boolean {
    return this.modelCatalog.autoRepair();
  }

  private async catalogEntries(entryNames?: string[]): Promise<LlmEntry[]> {
    const entries = await this.entries();
    const wanted = entryNames && entryNames.length > 0 ? new Set(entryNames) : null;
    return entries.filter(
      (entry) => this.modelCatalog.appliesTo(entry) && (!wanted || wanted.has(entry.name))
    );
  }

  /** Cached-only view (no network); used by llm_list / aos_status annotations. */
  async modelReports(entryNames?: string[]): Promise<ModelReport[]> {
    const entries = await this.catalogEntries(entryNames);
    const reports: ModelReport[] = [];
    for (const entry of entries) {
      reports.push(await this.modelCatalog.report(this.store, this.project.rootDir, entry));
    }
    return reports;
  }

  /** Refresh due (or forced) entries and auto-repair retired active models. */
  async refreshModels(
    options: { force?: boolean; entryNames?: string[] } = {}
  ): Promise<RefreshReport[]> {
    const run = this.modelRefreshChain.then(
      () => this.doRefreshModels(options),
      () => this.doRefreshModels(options)
    );
    this.modelRefreshChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async doRefreshModels(options: {
    force?: boolean;
    entryNames?: string[];
  }): Promise<RefreshReport[]> {
    const entries = await this.catalogEntries(options.entryNames);
    const reports: RefreshReport[] = [];
    for (const entry of entries) {
      let report = await this.modelCatalog.refresh(this.store, this.project.rootDir, entry, {
        force: options.force === true
      });
      if (report.deprecated && report.refreshed && this.modelAutoRepairEnabled()) {
        const repaired = await this.tryAutoRepair(entry, report);
        if (repaired) report = { ...report, repaired };
      }
      reports.push(report);
    }
    return reports;
  }

  /** Non-blocking check for the serve loops (stdio + HTTP). */
  maybeRefreshModels(): void {
    if (this.modelRefreshHours() <= 0) return;
    void this.refreshModels({ force: false }).catch((error) => {
      logWarn(`模型列表刷新失败: ${errorMessage(error)}`);
    });
  }

  /** mobile_run_task gate: stop a retired active model before artemis runs it. */
  async ensureActiveModelUsable(): Promise<ModelPreflight> {
    const active = await this.activeEntry();
    if (!active || !this.modelCatalog.appliesTo(active)) return { ok: true, warnings: [] };
    const report = await this.modelCatalog.report(this.store, this.project.rootDir, active);
    if (!report.deprecated) {
      return {
        ok: true,
        warnings: report.error ? [`厂商模型列表刷新失败：${report.error}`] : []
      };
    }
    if (this.modelAutoRepairEnabled() && report.suggestedModel) {
      const repaired = await this.tryAutoRepair(active, report);
      if (repaired) {
        return {
          ok: true,
          warnings: [
            `active 模型 "${repaired.from}" 已下线，已自动修复为 "${repaired.to}"（${repaired.sources.join(" + ")}）。`
          ]
        };
      }
    }
    return {
      ok: false,
      warnings: [],
      payload: {
        ok: false,
        model_deprecated: true,
        profile: active.name,
        model: active.model,
        baseUrl: active.baseUrl,
        fetchedAt: report.fetchedAt,
        availableCount: report.count,
        availableModels: report.sampleModels,
        suggestedModel: report.suggestedModel,
        fix:
          '调用 llm_models(action="refresh") 查看厂商最新列表，然后用 aos_configure（提供新 model）或编辑项目 .env 修复。'
      }
    };
  }

  private async tryAutoRepair(
    entry: LlmEntry,
    report: ModelReport
  ): Promise<{ from: string; to: string; reason: "alias" | "equivalent"; sources: string[] } | null> {
    const suggestedModel = report.suggestedModel;
    if (!suggestedModel || suggestedModel === entry.model) return null;
    const reason = report.replacementReason ?? "equivalent";
    const sources: string[] = [];

    const stored = await this.safeStore(
      () =>
        this.store.upsertLlm(this.project.rootDir, {
          name: entry.name,
          provider: entry.provider,
          baseUrl: entry.baseUrl,
          model: suggestedModel,
          apiKey: entry.apiKey,
          makeActive: entry.isActive
        }),
      null
    );
    if (stored) sources.push(this.store.kind === "postgres" ? "PostgreSQL" : "内存存储");

    const dotenv = this.project.resolver.getDotenv();
    if (this.scanResult.llm?.model === entry.model && dotenv[ENV_LLM_MODEL] !== undefined) {
      try {
        writeEnvUpdates(this.project.rootDir, { [ENV_LLM_MODEL]: suggestedModel });
        sources.push("项目 .env");
      } catch (error) {
        logWarn(`模型自动修复写 .env 失败: ${errorMessage(error)}`);
      }
      this.refreshProjectEnv();
    }

    if (this.activeCache?.name === entry.name && this.activeCache.entry.model === entry.model) {
      this.activeCache = {
        name: entry.name,
        entry: { ...entry, model: suggestedModel, isActive: true }
      };
      this.writeActiveConfig(this.activeCache.entry);
      sources.push(".artemis/artemis.jsonc");
    }

    if (sources.length === 0) return null;
    const repaired = { from: entry.model, to: suggestedModel, reason, sources };
    logWarn(
      `模型 "${entry.model}" 已不在 ${entry.baseUrl} 的最新列表中：已自动修复为 "${suggestedModel}"（` +
        `${reason === "alias" ? "厂商稳定别名" : "同族等价模型"}；${sources.join(" + ")}）。`
    );
    return repaired;
  }

  // ------------------------------------------------------------------
  // Child process plumbing
  // ------------------------------------------------------------------

  envFingerprintForEntry(entry: EntryLike): string {
    return buildChildEnvForEntry({
      config: this.project.config,
      rootDir: this.project.rootDir,
      entry,
      baseEnv: this.baseEnv
    }).fingerprint;
  }

  prepareChildSpec(): ChildSpec {
    const args = {
      config: this.project.config,
      rootDir: this.project.rootDir,
      baseEnv: this.baseEnv
    };
    const entry = this.activeCache?.entry;
    // No LLM configured yet: spawn a bare child so read-only mobile tools
    // (diagnose / device state) still work; mobile_run_task is gated upstream.
    return entry ? buildChildSpecForEntry({ ...args, entry }) : buildBareChildSpec(args);
  }

  activeEntryCached(): LlmEntry | null {
    return this.activeCache?.entry ?? null;
  }

  async queryTaskCounts(): Promise<{ active: number; queued: number } | null> {
    try {
      const result = await this.proxy.callTool("mobile_diagnose", {});
      const payload = resultPayload(result);
      if (!payload) return null;
      const tasks = (payload as { tasks?: unknown }).tasks;
      if (!tasks || typeof tasks !== "object") return null;
      const active = (tasks as { active?: unknown }).active;
      const queued = (tasks as { queued?: unknown }).queued;
      return {
        active: Array.isArray(active) ? active.length : 0,
        queued: Array.isArray(queued) ? queued.length : 0
      };
    } catch {
      return null;
    }
  }

  artemisPython(): ResolvedPython {
    return resolveArtemisPython(this.project.config.artemis);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async safeStore<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await op();
    } catch (error) {
      this.lastStoreError = errorMessage(error);
      return fallback;
    }
  }
}

const CRASH_SCAN_BATCH = 10;
const CRASH_MAX_RECORDS_DEFAULT = 200;

function resolveCrashMaxRecords(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AOS_CRASH_MAX_RECORDS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return CRASH_MAX_RECORDS_DEFAULT;
  return Math.min(Math.max(Math.trunc(raw), 10), 10_000);
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Kill a recorded mcp_server child left behind by a dead ao-mcp instance. */
export async function sweepStaleChild(runtime: Runtime): Promise<string | null> {
  const state = runtime.state.read();
  const child = state.child;
  if (!child?.pid) return null;

  const ownerAlive =
    typeof child.ownerPid === "number" && child.ownerPid !== process.pid && isProcessAlive(child.ownerPid);
  if (ownerAlive) return null;

  if (!isProcessAlive(child.pid)) {
    const current = runtime.state.read();
    delete current.child;
    runtime.state.write(current);
    return null;
  }

  const cmdline = processCmdline(child.pid);
  if (!cmdline || !/-m\s+mcp_server/.test(cmdline)) return null;

  await terminateProcess(child.pid, 2000);
  const current = runtime.state.read();
  delete current.child;
  runtime.state.write(current);
  return `已清理孤儿 artemis mcp_server 进程（pid=${child.pid}，owner ${child.ownerPid ?? "未知"} 已退出）`;
}
