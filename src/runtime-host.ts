import type { LoadedProject } from "./config/loader.js";
import { ensureArtemisDeps, resolveDepsSource } from "./artemis/bootstrap.js";
import { createProjectStore } from "./db/index.js";
import type { ProjectStore } from "./db/types.js";
import { syncFigmaTokenEnv } from "./figma/token.js";
import { configureLogging, installCrashHandlers, log } from "./log.js";
import { Runtime } from "./runtime.js";
import { errorMessage } from "./util.js";
import { stopBridge } from "./figma/bridge.js";

/** 运行宿主（DESIGN §13.90）：stdio 与 HTTP 两个入口共享的启动/收尾骨架——
 * 日志引导、artemis 依赖检查、项目存储、Runtime 创建（figma token 同步 + 孤儿清理）
 * 与 30s 同步循环；进程级差异（stdin/HTTP 生命周期、exit 钩子）留在各自入口。 */

export type DepsSource = ReturnType<typeof resolveDepsSource>;

const SYNC_INTERVAL_MS = 30_000;

export interface RuntimeHostPrepareOptions {
  logDir: string;
  /** 启动首行日志（形如 `aos-mcp <version> 启动（stdio）项目=…`）。 */
  startupLine: string;
  deps: { repoDir: string; source: DepsSource };
}

export interface CreateRuntimeOptions {
  /** 覆盖存储（HTTP 多项目共享同一 store；缺省用宿主 store）。 */
  store?: ProjectStore;
  storeNote?: string | null;
  /** 注册成功后的日志行（缺省 `项目已注册: <rootDir>`）。 */
  registerLine?: (runtime: Runtime, project: LoadedProject) => string;
}

export class RuntimeHost {
  readonly store: ProjectStore;
  readonly storeNote: string | null;
  private readonly runtimes = new Set<Runtime>();
  private readonly syncTimer: NodeJS.Timeout;

  private constructor(store: ProjectStore, storeNote: string | null) {
    this.store = store;
    this.storeNote = storeNote;
    this.syncTimer = setInterval(() => {
      for (const runtime of this.runtimes) {
        void runtime.syncTaskStatuses();
        runtime.maybeRefreshModels();
      }
    }, SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
  }

  /** 日志引导 + artemis 依赖检查 + 项目存储 + 同步循环（两个入口共用）。 */
  static async prepare(options: RuntimeHostPrepareOptions): Promise<RuntimeHost> {
    const logFile = configureLogging({ logDir: options.logDir });
    installCrashHandlers();
    log(options.startupLine);
    if (logFile) log(`日志文件: ${logFile}`);

    const deps = await ensureArtemisDeps({
      repoDir: options.deps.repoDir,
      source: options.deps.source,
      log
    });
    if (deps.status !== "ready") {
      log(`依赖状态: ${deps.status} — ${deps.message.split("\n")[0]}`);
    }

    const { store, degraded, reason } = await createProjectStore();
    const host = new RuntimeHost(store, reason);
    if (degraded && reason) log(reason);
    return host;
  }

  /** 创建并注册一个 Runtime（initialize → figma token 同步 → 孤儿清理）。失败即抛出，不注册。 */
  async createRuntime(project: LoadedProject, options: CreateRuntimeOptions = {}): Promise<Runtime> {
    const runtime = new Runtime(project, {
      store: options.store ?? this.store,
      storeNote: options.storeNote ?? this.storeNote
    });
    await runtime.initialize();
    runtime.maybeRefreshModels();

    try {
      const token = await runtime.figmaTokenInfo();
      syncFigmaTokenEnv(token.value);
    } catch (error) {
      log(`Figma token 同步失败: ${errorMessage(error)}`);
    }
    try {
      const swept = await runtime.sweepChild();
      if (swept) log(swept);
    } catch (error) {
      log(`孤儿清理检查失败: ${errorMessage(error)}`);
    }

    this.runtimes.add(runtime);
    const line = options.registerLine
      ? options.registerLine(runtime, project)
      : `项目已注册: ${project.rootDir}`;
    log(line);
    return runtime;
  }

  /** 清同步循环 + 逐 Runtime 回收（代理 + WDA）+ 关闭存储 + 停桥。 */
  async shutdown(): Promise<void> {
    clearInterval(this.syncTimer);
    for (const runtime of this.runtimes) {
      try {
        await runtime.proxy.dispose();
      } catch {
        /* best effort */
      }
      try {
        await runtime.disposeIosWda();
      } catch {
        /* best effort */
      }
    }
    this.runtimes.clear();
    try {
      await this.store.close();
    } catch {
      /* best effort */
    }
    try {
      await stopBridge();
    } catch {
      /* best effort */
    }
  }
}
