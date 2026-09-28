import fs from "node:fs";
import path from "node:path";

import { loadDotenvValues, type LoadedProject } from "./config/loader.js";
import { makeResolver } from "./config/validate.js";
import { StateStore } from "./state.js";
import {
  buildBareChildSpec,
  buildChildEnvForEntry,
  buildChildSpecForEntry,
  configDirAbs,
  renderProjectArtemisConfig,
  resolveArtemisPython,
  type ChildSpec,
  type EntryLike,
  type ResolvedPython
} from "./artemis/assembly.js";
import { ArtemisProxy, type ArtemisProxyLike } from "./artemis/proxy.js";
import { appendChildLog } from "./log.js";
import { MemoryStore } from "./db/memory.js";
import { TERMINAL_TASK_STATUSES } from "./db/types.js";
import type { ProjectLlmRecord, ProjectRecord, ProjectStore, TaskStatRecord } from "./db/types.js";
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
import {
  errorMessage,
  isProcessAlive,
  processCmdline,
  terminateProcess,
  writeFileAtomic
} from "./util.js";

export interface RuntimeOptions {
  store?: ProjectStore;
  proxy?: ArtemisProxyLike;
  baseEnv?: NodeJS.ProcessEnv;
  storeNote?: string | null;
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

export class Runtime {
  readonly project: LoadedProject;
  readonly store: ProjectStore;
  readonly proxy: ArtemisProxyLike;
  readonly storeNote: string | null;
  readonly configDirAbs: string;
  readonly state: StateStore;

  private readonly baseEnv: NodeJS.ProcessEnv;
  private scanResult: EnvScanResult;
  private projectRecord: ProjectRecord | null = null;
  private activeCache: { name: string; entry: LlmEntry } | null = null;
  private initialized = false;
  private lastStoreError: string | null = null;
  private activationChain: Promise<unknown> = Promise.resolve();

  constructor(project: LoadedProject, options: RuntimeOptions = {}) {
    this.project = project;
    this.store = options.store ?? new MemoryStore();
    this.storeNote = options.storeNote ?? null;
    this.baseEnv = options.baseEnv ?? process.env;
    this.configDirAbs = configDirAbs(project.config, project.rootDir);
    this.state = new StateStore(path.join(this.configDirAbs, "state.json"));
    this.scanResult = scanProjectEnv(project.resolver);
    this.proxy = options.proxy ?? this.buildDefaultProxy();
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
    traceId: string;
    model?: string | null;
    profile?: string | null;
    taskDesc?: string | null;
  }): Promise<void> {
    await this.safeStore<void>(async () => {
      await this.store.recordTask({
        rootPath: this.project.rootDir,
        traceId: input.traceId,
        model: input.model ?? null,
        profile: input.profile ?? null,
        taskDesc: input.taskDesc ?? null,
        status: "submitted"
      });
    }, undefined);
  }

  /** Poll artemis for pending task_statuses and mark terminal ones finished.
   * Running detached tasks survive gateway restarts; this only reads status. */
  async syncTaskStatuses(): Promise<{ checked: number; updated: number }> {
    if (!this.proxy.isRunning()) return { checked: 0, updated: 0 };
    const pending = await this.safeStore(
      () => this.store.listPendingTasks(this.project.rootDir, 20),
      [] as TaskStatRecord[]
    );
    let updated = 0;
    for (const task of pending) {
      let status: string | null = null;
      try {
        const result = await this.proxy.callTool("mobile_manage_task", {
          action: "status",
          trace_id: task.traceId
        });
        const payload = extractJson(result);
        if (payload && typeof payload === "object") {
          const value = (payload as { status?: unknown }).status;
          if (typeof value === "string") status = value;
        }
      } catch {
        break; // child unavailable — abort this pass; next tick retries
      }
      if (status && (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
        const done = await this.safeStore(
          () => this.store.markTaskFinished(this.project.rootDir, task.traceId, status!),
          false
        );
        if (done) updated += 1;
      }
    }
    return { checked: pending.length, updated };
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

  projectSummary(): ProjectRecord | null {
    return this.projectRecord;
  }

  storeKind(): "postgres" | "memory" {
    return this.store.kind;
  }

  storeError(): string | null {
    return this.lastStoreError;
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
      const payload = extractJson(result);
      if (!payload || typeof payload !== "object") return null;
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

function extractJson(result: unknown): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  for (const item of content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      try {
        return JSON.parse(item.text);
      } catch {
        return null;
      }
    }
  }
  return null;
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
