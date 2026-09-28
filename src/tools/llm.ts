import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AOS_MCP_VERSION, maskSecret } from "../util.js";
import { bridgeState } from "../figma/bridge.js";
import { entryIssues } from "../llm/registry.js";
import type { Runtime } from "../runtime.js";

export interface LlmSwitchArgs {
  name: string;
  force?: boolean;
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

  const warnings: string[] = [];
  for (const issue of runtime.project.validation.warnings) warnings.push(issue.message);
  if (setup.required) warnings.push(setup.message);

  const llms = entries.map((entry) => ({
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
    issues: entryIssues(entry)
  }));

  return jsonResult({
    ok: true,
    configPath: runtime.project.configPath,
    rootDir: runtime.project.rootDir,
    activeProfile: active?.name ?? null,
    llms,
    setupRequired: setup.required,
    setup: setup.required ? setup : undefined,
    warnings,
    store: {
      kind: runtime.storeKind(),
      degraded: runtime.storeKind() === "memory",
      note: runtime.storeNote
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

export async function aosStatus(runtime: Runtime): Promise<CallToolResult> {
  const python = runtime.artemisPython();
  const active = await runtime.activeEntry();
  const entries = await runtime.entries();
  const setup = await runtime.setupInfo();
  const figma = await runtime.figmaTokenInfo();
  const project = runtime.projectSummary();

  return jsonResult({
    ok: true,
    version: AOS_MCP_VERSION,
    configPath: runtime.project.configPath,
    rootDir: runtime.project.rootDir,
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
    activeProfile: active?.name ?? null,
    llmCount: entries.length,
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
    state: runtime.state.read()
  });
}
