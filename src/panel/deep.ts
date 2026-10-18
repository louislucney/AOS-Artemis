import { bridgeState } from "../figma/bridge.js";
import { childLogFilePath, logFilePath } from "../log.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";

/** 总览面板深探层（overview-panel T6，DESIGN §13.104）：显式动作触发，懒建 Runtime
 * 后仅取**纯读子集**（不拉起 artemis 子进程、不触网打外部 API）；iOS 环境检测
 * （会 spawn 本地 CLI，≤45s 预算）仅在显式请求时执行，结果带时间缓存。 */

export interface PanelIosProbeView {
  appium: { found: boolean; path: string | null; version: string | null };
  xcuitest: { installed: boolean; version: string | null };
  guidance: string[];
  error: string | null;
  probedAt: string;
}

export interface PanelDeepView {
  activeProfile: string | null;
  llmEntries: number;
  setupRequired: boolean;
  store: {
    kind: "postgres" | "file" | "memory";
    degraded: boolean;
    note: string | null;
    lastError: string | null;
  };
  usage: { enabled: boolean };
  modelRefresh: { ttlHours: number; autoRepair: boolean };
  artemis: {
    repo: string;
    configDir: string;
    python: { path: string | null; found: boolean; hint: string | null };
    child: { running: boolean; pid: number | null; restarts: number; lastError: string | null };
  };
  figma: {
    bridge: { status: string; port: number | null; message: string };
    token: { present: boolean; source: "store" | "env" | null };
  };
  jira: { configured: boolean; siteUrl: string | null; missing: string[] };
  logs: { file: string | null; childFile: string | null };
  build: { stale: boolean; startedAt: string };
  iosProbe: PanelIosProbeView | null;
}

export interface PanelDeepProbe {
  build(rootPath: string, options?: { iosProbe?: boolean }): Promise<PanelDeepView | null>;
}

export const PANEL_IOS_PROBE_TTL_MS = 60_000;
export const PANEL_IOS_PROBE_TIMEOUT_MS = 45_000;

export function createPanelDeepProbe(deps: {
  createRuntime: (rootPath: string) => Promise<Runtime | null>;
  now?: () => number;
  iosProbeTtlMs?: number;
  iosProbeTimeoutMs?: number;
}): PanelDeepProbe {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.iosProbeTtlMs ?? PANEL_IOS_PROBE_TTL_MS;
  const timeoutMs = deps.iosProbeTimeoutMs ?? PANEL_IOS_PROBE_TIMEOUT_MS;
  const probeCache = new Map<string, { at: number; value: PanelIosProbeView }>();

  const runIosProbe = async (runtime: Runtime): Promise<PanelIosProbeView> => {
    const probedAt = new Date(now()).toISOString();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`iOS 环境检测超时（${timeoutMs}ms）`)), timeoutMs);
    });
    try {
      const detected = await Promise.race([runtime.iosAppiumInfo(), timeout]);
      return {
        appium: { ...detected.appium },
        xcuitest: { ...detected.xcuitest },
        guidance: [...detected.guidance],
        error: null,
        probedAt
      };
    } catch (error) {
      return {
        appium: { found: false, path: null, version: null },
        xcuitest: { installed: false, version: null },
        guidance: [],
        error: errorMessage(error),
        probedAt
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  return {
    async build(rootPath, options = {}) {
      let runtime: Runtime | null;
      try {
        runtime = await deps.createRuntime(rootPath);
      } catch {
        return null;
      }
      if (runtime === null) return null;
      try {
        const active = await runtime.activeEntry();
        const entries = await runtime.entries();
        const setup = await runtime.setupInfo();
        const python = runtime.artemisPython();
        const figma = await runtime.figmaTokenInfo();
        const jira = runtime.jiraConfig();
        const bridge = bridgeState();
        const child = runtime.proxy.status();

        let iosProbe: PanelIosProbeView | null = null;
        if (options.iosProbe === true) {
          const cached = probeCache.get(rootPath);
          if (cached && now() - cached.at < ttl) {
            iosProbe = cached.value;
          } else {
            iosProbe = await runIosProbe(runtime);
            probeCache.set(rootPath, { at: now(), value: iosProbe });
          }
        }

        return {
          activeProfile: active?.name ?? null,
          llmEntries: entries.length,
          setupRequired: setup.required,
          store: {
            kind: runtime.storeKind(),
            degraded: runtime.storeKind() === "memory",
            note: runtime.storeNote,
            lastError: runtime.storeError()
          },
          usage: { enabled: runtime.usageEnabled() },
          modelRefresh: {
            ttlHours: runtime.modelRefreshHours(),
            autoRepair: runtime.modelAutoRepairEnabled()
          },
          artemis: {
            repo: runtime.project.config.artemis.repo,
            configDir: runtime.configDirAbs,
            python: { path: python.python, found: python.python !== null, hint: python.hint },
            child: {
              running: child.running,
              pid: child.pid ?? null,
              restarts: child.restarts,
              lastError: child.lastError ?? null
            }
          },
          figma: {
            bridge: {
              status: bridge.status,
              port: bridge.port,
              message: bridge.message
            },
            token: { present: figma.value !== null, source: figma.source }
          },
          jira: { configured: jira.configured, siteUrl: jira.siteUrl, missing: jira.missing },
          logs: { file: logFilePath(), childFile: childLogFilePath() },
          build: {
            stale: runtime.build.stale,
            startedAt: new Date(runtime.build.startedAtMs).toISOString()
          },
          iosProbe
        };
      } catch {
        return null;
      }
    }
  };
}
