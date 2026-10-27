import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AOS_MCP_VERSION, maskSecret } from "../util.js";
import { bridgeState } from "../figma/bridge.js";
import { ENV_JIRA_API_TOKEN } from "../jira/config.js";
import { childLogFilePath, logFilePath } from "../log.js";
import { PROVIDER_PRESETS, presetSummary } from "../llm/providers.js";
import { scanVisionHealth } from "../ios/vision-health.js";
import { resolveAndroidAdbSocket, resolveIosHost } from "../device/device-hosts.js";
import { entryIssues } from "../llm/registry.js";
import type { Runtime } from "../runtime.js";
import { clientTtlFrom, isClientOnline } from "../host/online.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";

export interface LlmSwitchArgs {
  name: string;
  force?: boolean;
}

export interface LlmModelsArgs {
  action: "list" | "refresh";
  entry?: string;
}

export interface AosTasksArgs {
  limit?: number;
  sync?: boolean;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

export async function llmList(runtime: Runtime): Promise<CallToolResult> {
  const entries = await runtime.entries();
  const active = await runtime.activeEntry();
  const setup = await runtime.setupInfo();
  const reports = await runtime.modelReports();
  const reportByEntry = new Map(reports.map((report) => [report.entry, report]));

  const warnings: string[] = [];
  for (const issue of runtime.project.validation.warnings) warnings.push(issue.message);
  if (setup.required) warnings.push(setup.message);

  const llms = entries.map((entry) => {
    const report = reportByEntry.get(entry.name) ?? null;
    if (report?.deprecated) {
      warnings.push(
        `条目 "${entry.name}" 的模型 "${entry.model}" 已不在厂商最新列表中` +
          (report.suggestedModel ? `（建议：${report.suggestedModel}）` : "")
      );
    }
    return {
      name: entry.name,
      provider: entry.provider,
      model: entry.model,
      baseUrl: entry.baseUrl,
      key: {
        present: entry.apiKey !== null && entry.apiKey !== "",
        preview: entry.apiKey ? maskSecret(entry.apiKey) : null,
        envVar: entry.keyEnvName
      },
      fallback: entry.fallback ?? { provider: entry.provider, model: entry.model },
      source: entry.source,
      isActive: entry.name === active?.name,
      issues: entryIssues(entry),
      models: report
        ? {
            known: report.known,
            fetchedAt: report.fetchedAt,
            stale: report.stale,
            count: report.count,
            activeModelAvailable: report.available,
            deprecated: report.deprecated,
            suggestedModel: report.suggestedModel,
            error: report.error
          }
        : null
    };
  });

  return jsonResult({
    ok: true,
    configPath: runtime.project.configPath,
    rootDir: runtime.project.rootDir,
    activeProfile: active?.name ?? null,
    llms,
    setupRequired: setup.required,
    setup: setup.required ? setup : undefined,
    modelRefresh: {
      ttlHours: runtime.modelRefreshHours(),
      autoRepair: runtime.modelAutoRepairEnabled()
    },
    warnings,
    store: {
      kind: runtime.storeKind(),
      degraded: runtime.storeKind() === "memory",
      note: runtime.storeNote
    }
  });
}

/** Model catalog: cached vendor model lists + on-demand refresh (12h background TTL). */
export async function llmModels(runtime: Runtime, args: LlmModelsArgs): Promise<CallToolResult> {
  const entryNames = args.entry ? [args.entry] : undefined;
  const reports =
    args.action === "refresh"
      ? await runtime.refreshModels({ force: true, entryNames })
      : await runtime.modelReports(entryNames);

  return jsonResult({
    ok: true,
    action: args.action,
    ttlHours: runtime.modelRefreshHours(),
    autoRepair: runtime.modelAutoRepairEnabled(),
    entries: reports.map((report) => ({
      entry: report.entry,
      model: report.model,
      baseUrl: report.baseUrl,
      known: report.known,
      fetchedAt: report.fetchedAt,
      stale: report.stale,
      count: report.count,
      activeModelAvailable: report.available,
      deprecated: report.deprecated,
      suggestedModel: report.suggestedModel,
      replacementReason: report.replacementReason,
      error: report.error,
      models: report.sampleModels,
      refreshed: "refreshed" in report ? report.refreshed : undefined,
      repaired: "repaired" in report ? report.repaired : undefined
    })),
    providers: PROVIDER_PRESETS.map(presetSummary),
    store: {
      kind: runtime.storeKind(),
      degraded: runtime.storeKind() === "memory"
    }
  });
}

export async function llmSwitch(runtime: Runtime, args: LlmSwitchArgs): Promise<CallToolResult> {
  const result = await runtime.activateEntry(args.name, { force: args.force === true });
  return jsonResult(result, !result.ok);
}

/** Task statistics: recent runs + optional status sync against artemis. */
export async function aosTasks(runtime: Runtime, args: AosTasksArgs): Promise<CallToolResult> {
  const sync = args.sync === false ? null : await runtime.syncTaskStatuses();
  const limit = args.limit ?? 20;
  const tasks = await runtime.taskList(limit);
  return jsonResult({
    ok: true,
    sync,
    count: tasks.length,
    tasks: tasks.map((task) => ({
      case_id: task.caseId,
      trace_id: task.traceId,
      status: task.status,
      model: task.model,
      profile: task.profile,
      task_desc: task.taskDesc,
      submitted_at: task.submittedAt,
      finished_at: task.finishedAt
    })),
    store: {
      kind: runtime.storeKind(),
      degraded: runtime.storeKind() === "memory"
    }
  });
}

/** 本机身份 + 接入会话/执行机/队列状态（无中心台账时全部降级为默认值，不报错）。 */
async function hostStatusView(runtime: Runtime): Promise<{
  identity: {
    id: string;
    hostname: string;
    username: string;
    osPlatform: NodeJS.Platform;
    osVersion: string;
    arch: string;
    kind: string;
    identitySource: string;
  } | null;
  clientOnline: boolean;
  runnerOnline: boolean;
  clientSessions: number;
  queue: { paused: boolean; pending: number; running: number };
}> {
  const identity = runtime.hostIdentity;
  const nowMs = Date.now();
  const clientTtl = clientTtlFrom(runtime.baseEnv);
  const runnerTtl = runnerTtlFrom(runtime.baseEnv);
  let clientOnline = false;
  let runnerOnline = false;
  let clientSessions = 0;
  let paused = false;
  let pending = 0;
  let running = 0;

  if (identity) {
    try {
      const host = await runtime.store.getHost(identity.id);
      if (host) {
        clientOnline = isClientOnline(host.clientSeenAt, nowMs, clientTtl);
        paused = host.queuePaused;
      }
      clientSessions = (
        await runtime.store.listHostSessions(identity.id, {
          onlineWithinMs: clientTtl,
          now: nowMs
        })
      ).length;
      const runners = await runtime.store.listRunners(runtime.project.rootDir, 100);
      runnerOnline = runners.some(
        (runner) =>
          runner.hostId === identity.id && isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtl)
      );
      const tasks = await runtime.store.listRegressionTasks(runtime.project.rootDir, 200);
      pending = tasks.filter((task) => task.status === "pending").length;
      running = tasks.filter(
        (task) => task.status === "claimed" || task.status === "running"
      ).length;
    } catch {
      /* 无中心台账或读取失败：全部保持默认 */
    }
  }

  return {
    identity: identity
      ? {
          id: identity.id,
          hostname: identity.hostname,
          username: identity.username,
          osPlatform: identity.osPlatform,
          osVersion: identity.osVersion,
          arch: identity.arch,
          kind: identity.kind,
          identitySource: identity.identitySource
        }
      : null,
    clientOnline,
    runnerOnline,
    clientSessions,
    queue: { paused, pending, running }
  };
}

export async function aosStatus(runtime: Runtime): Promise<CallToolResult> {
  const python = runtime.artemisPython();
  const active = await runtime.activeEntry();
  const entries = await runtime.entries();
  const setup = await runtime.setupInfo();
  const figma = await runtime.figmaTokenInfo();
  const project = runtime.projectSummary();
  const host = await hostStatusView(runtime);
  const stack = runtime.stackDetections();

  return jsonResult({
    ok: true,
    version: AOS_MCP_VERSION,
    configPath: runtime.project.configPath,
    rootDir: runtime.project.rootDir,
    host,
    build: {
      module: runtime.build.moduleUrl,
      startedAt: new Date(runtime.build.startedAtMs).toISOString(),
      stale: runtime.build.stale,
      ...(runtime.build.stale
        ? { note: "dist/ 较本进程新：重启客户端 MCP 会话以加载最新构建。" }
        : {})
    },
    project: project
      ? {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          lastSeenAt: project.lastSeenAt
        }
      : null,
    store: {
      kind: runtime.storeKind(),
      degraded: runtime.storeKind() === "memory",
      note: runtime.storeNote,
      lastError: runtime.storeError()
    },
    usage: {
      enabled: runtime.usageEnabled(),
      storage: runtime.storeKind()
    },
    activeProfile: active?.name ?? null,
    llmCount: entries.length,
    modelRefresh: {
      ttlHours: runtime.modelRefreshHours(),
      autoRepair: runtime.modelAutoRepairEnabled()
    },
    setupRequired: setup.required,
    validation: runtime.project.validation,
    artemis: {
      repo: runtime.project.config.artemis.repo,
      configDir: runtime.configDirAbs,
      python: {
        path: python.python,
        found: python.python !== null,
        hint: python.hint
      },
      child: runtime.proxy.status()
    },
    figma: {
      bridge: bridgeState(),
      token: {
        present: figma.value !== null,
        source: figma.source,
        envVar: runtime.figmaTokenScanVar()
      }
    },
    jira: (() => {
      const config = runtime.jiraConfig();
      return {
        configured: config.configured,
        siteUrl: config.siteUrl,
        email: config.email,
        token: {
          present: config.apiToken !== null,
          preview: config.apiToken !== null ? maskSecret(config.apiToken) : null,
          envVar: ENV_JIRA_API_TOKEN
        },
        missing: config.missing
      };
    })(),
    deviceHosts: (() => {
      const ios = resolveIosHost(runtime.project.config, runtime.project.resolver);
      const android = resolveAndroidAdbSocket(runtime.project.config, runtime.project.resolver);
      if (!ios.appiumUrl && !android) return { configured: false };
      return {
        configured: true,
        ios: ios.appiumUrl
          ? {
              appiumUrl: ios.appiumUrl,
              source: ios.source,
              signing: {
                wdaBundleId: ios.wdaBundleId,
                xcodeOrgId: ios.xcodeOrgId,
                xcodeSigningId: ios.xcodeSigningId
              }
            }
          : null,
        android: android ? { adbHost: android.socket, source: android.source } : null
      };
    })(),
    ios: await runtime.iosAppiumInfo(),
    vision: scanVisionHealth(runtime.tracesRoot(), { limit: 50, recentLimit: 5 }),
    logs: {
      file: logFilePath(),
      childFile: childLogFilePath()
    },
    stack: stack.stacks,
    stackSource: stack.source,
    stackWarnings: stack.warnings,
    state: runtime.state.read()
  });
}
