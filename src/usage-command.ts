import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { loadProject } from "./config/loader.js";
import { resolveHostReference } from "./center/store.js";
import { createProjectStore, type CreateStoreResult } from "./db/index.js";
import { storeKindShortLabel } from "./db/labels.js";
import {
  AmbiguousProjectError,
  type ProjectRecord,
  type ProjectStore,
  type UsageEventQuery,
  type UsageEventRecord
} from "./db/types.js";
import {
  usageSignals,
  usageSummary,
  type UsageSignals,
  type UsageSummary
} from "./usage/aggregate.js";
import {
  USAGE_DISABLED_NOTE,
  usageEnabledFrom,
  usageEventSampleLimit
} from "./usage/capture.js";
import { handleUsageRequest } from "./usage/web.js";
import { errorMessage } from "./util.js";

export interface UsageWebHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface UsageCliDeps {
  store?: ProjectStore;
  createStore?: (databaseUrl: string | null) => Promise<CreateStoreResult>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  now?: () => number;
  catalog?: readonly string[];
  waitForShutdown?: (handle: UsageWebHandle) => Promise<void>;
}

export interface UsageProjectView {
  name: string;
  rootPath: string;
  /** 项目所属主机；NULL＝未归属的 legacy 行（按未绑定 store 读取）。 */
  hostId: string | null;
  summary: UsageSummary;
  signals: UsageSignals;
}

export interface UsageCliReport {
  ok: boolean;
  generatedAt: string;
  days: number;
  since: string;
  usage: { enabled: boolean; note: string | null };
  store: { kind: "postgres" | "file" | "memory"; degraded: boolean; note: string | null };
  projects: UsageProjectView[];
  totals: { summary: UsageSummary; signals: UsageSignals };
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
}

interface Io {
  log: (line: string) => void;
  errorLog: (line: string) => void;
}

interface StorageView {
  kind: "postgres" | "file" | "memory";
  degraded: boolean;
  note: string | null;
}

const DEFAULT_DAYS = 7;
const DEFAULT_WEB_PORT = 8766;
const DEFAULT_WEB_HOST = "127.0.0.1";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const CLI_MEMORY_NOTE =
  "会话内存仅当前进程可见（重启即空）；配置 MOBILE_TESTING_DATABASE_URL 或使用文件台账（.artemis/ledger）可跨进程查询。";

export function printUsageCommand(log: (line: string) => void): void {
  log(`mobile-testing-mcp usage — 使用统计（调用事件）

Usage:
  mobile-testing-mcp usage [--json] [--all] [--project <名称>] [--host <id|主机名>] [--days <n>]
                    默认当前项目文本摘要（--days 默认 7）
                    --json  机器可读 JSON（与文本同源）
                    --all   跨项目总览（每个已注册项目 + 合计）
                    --project <名称>  按名称（或根路径）指定已注册项目
                    --host <id|主机名>  只看该主机的项目（多机同路径时用于消歧；
                                        普通/JSON/--all 模式下为过滤条件，--web 模式下为监听地址）
  mobile-testing-mcp usage --web [--port 8766] [--host 127.0.0.1]
                    只读看板（复用 /usage 与 /usage.json，默认仅本机）
  mobile-testing-mcp usage help

exit codes: 0 成功；2 参数错误或端口被占用`);
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    }
  };
}

async function defaultCatalog(): Promise<string[]> {
  const { inProcessToolCatalog } = await import("./server.js");
  return inProcessToolCatalog();
}

function normalizeCatalog(catalog: readonly string[]): string[] {
  return [...new Set(catalog)].filter((name) => name !== "aos_usage").sort();
}

function storageView(kind: "postgres" | "file" | "memory", reason: string | null): StorageView {
  if (kind === "postgres") return { kind, degraded: false, note: null };
  const trimmed = reason?.trim();
  if (kind === "file") {
    return { kind, degraded: false, note: trimmed ? trimmed : null };
  }
  return {
    kind,
    degraded: true,
    note: trimmed ? `${trimmed} ${CLI_MEMORY_NOTE}` : CLI_MEMORY_NOTE
  };
}

function storageLabel(kind: "postgres" | "file" | "memory"): string {
  return storeKindShortLabel(kind);
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

function overviewLine(label: string, summary: UsageSummary): string {
  return `${label}: ${summary.total} · 成功 ${summary.ok} · 失败 ${summary.error} · 成功率 ${formatPercent(summary.successRate)} · p50 ${formatMs(summary.p50)} · p95 ${formatMs(summary.p95)}`;
}

function renderSignalLines(signals: UsageSignals): string[] {
  const lines: string[] = [];
  const errorClasses = signals.errorClasses.filter((entry) => entry.errorClass !== null);
  if (errorClasses.length > 0) {
    lines.push(
      `  错误类: ${errorClasses.map((entry) => `${entry.errorClass} ${entry.count}`).join(" · ")}`
    );
  }
  if (signals.unclassified.length > 0) {
    lines.push(
      `  未分类错误: ${signals.unclassified
        .slice(0, 5)
        .map((entry) => `${entry.template} ×${entry.count}（${entry.tools.join("、")}）`)
        .join(" · ")}`
    );
  }
  if (signals.signalCodes.length > 0) {
    lines.push(
      `  警告码: ${signals.signalCodes
        .slice(0, 5)
        .map((entry) => `${entry.code}${entry.field ? `:${entry.field}` : ""} ×${entry.count}`)
        .join(" · ")}`
    );
  }
  if (signals.degradations.length > 0) {
    lines.push(
      `  降级: ${signals.degradations
        .slice(0, 5)
        .map((entry) => `${entry.code} ×${entry.count}`)
        .join(" · ")}`
    );
  }
  if (signals.argKeys.length > 0) {
    lines.push(
      `  参数键: ${signals.argKeys
        .slice(0, 5)
        .map((entry) => `${entry.tool}=[${entry.keys.map((key) => key.key).join(", ")}]`)
        .join(" · ")}`
    );
  }
  return lines;
}

function renderSignalBlock(signals: UsageSignals): string[] {
  const lines = renderSignalLines(signals);
  return lines.length === 0 ? ["信号: 无"] : ["信号:", ...lines];
}

function renderToolLines(summary: UsageSummary): string[] {
  if (summary.byTool.length === 0) return ["工具: 无"];
  const lines = ["工具:"];
  for (const row of summary.byTool.slice(0, 10)) {
    lines.push(
      `  ${row.tool} ${row.count} 次 · 成功率 ${formatPercent(row.successRate)} · p50 ${formatMs(row.p50)} · p95 ${formatMs(row.p95)}`
    );
  }
  if (summary.byTool.length > 10) {
    lines.push(`  …共 ${summary.byTool.length} 个工具有调用`);
  }
  return lines;
}

function projectLineLabel(view: UsageProjectView): string {
  return `${view.name} (${view.rootPath})${view.hostId === null ? "" : ` · 主机 ${view.hostId}`}`;
}

function renderReport(report: UsageCliReport, all: boolean): string[] {
  const lines: string[] = [];
  const label = all ? "全部项目" : (report.projects[0]?.name ?? "未注册项目");
  lines.push(`使用统计 · ${label}（最近 ${report.days} 天）`);
  lines.push(
    `存储: ${storageLabel(report.store.kind)}${report.store.note ? ` — ${report.store.note}` : ""}`
  );
  if (!report.usage.enabled) lines.push(USAGE_DISABLED_NOTE);
  if (all) {
    lines.push(overviewLine("事件合计", report.totals.summary));
    lines.push("项目:");
    if (report.projects.length === 0) lines.push("  暂无已注册项目");
    for (const view of report.projects) {
      lines.push(
        `  ${projectLineLabel(view)}  ${view.summary.total} 次 · 成功率 ${formatPercent(view.summary.successRate)} · p50 ${formatMs(view.summary.p50)} · p95 ${formatMs(view.summary.p95)}`
      );
    }
    lines.push(...renderSignalBlock(report.totals.signals));
    return lines;
  }
  const view = report.projects[0];
  const summary = view?.summary ?? report.totals.summary;
  const signals = view?.signals ?? report.totals.signals;
  lines.push(overviewLine("事件", summary));
  lines.push(...renderToolLines(summary));
  lines.push(
    summary.zeroCallTools.length > 0 ? `零调用: ${summary.zeroCallTools.join("、")}` : "零调用: 无"
  );
  lines.push(...renderSignalBlock(signals));
  return lines;
}

function resolveRegisteredProjectCandidates(
  projects: readonly ProjectRecord[],
  key: string
): ProjectRecord[] {
  const byRoot = projects.filter((project) => project.rootPath === key);
  if (byRoot.length > 0) return byRoot;
  return projects.filter((project) => project.name === key);
}

function hostLabel(hostId: string | null): string {
  return hostId ?? "（未归属）";
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function defaultWaitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.removeListener("SIGINT", done);
      process.removeListener("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function runUsageWeb(options: {
  flags: ParsedFlags;
  store: ProjectStore;
  storage: StorageView;
  io: Io;
  env: NodeJS.ProcessEnv;
  catalog: readonly string[];
  nowMs: number;
  waitForShutdown: (handle: UsageWebHandle) => Promise<void>;
}): Promise<number> {
  const { flags, store, storage, io, env, catalog, nowMs, waitForShutdown } = options;
  const host = flags.get("host") ?? DEFAULT_WEB_HOST;
  const portRaw = flags.get("port");
  const port = portRaw === null ? DEFAULT_WEB_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.errorLog("--port 需要 0-65535 之间的整数");
    return 2;
  }
  let actualPort = port;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(
          req.url ?? "/",
          `http://${req.headers.host ?? `${host}:${actualPort}`}`
        );
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(302, { Location: "/usage" });
          res.end();
          return;
        }
        if (req.method === "GET" && (url.pathname === "/usage" || url.pathname === "/usage.json")) {
          const response = await handleUsageRequest(url, {
            store,
            catalog,
            storageNote: storage.note,
            env,
            now: nowMs
          });
          res.writeHead(response.status, { "Content-Type": response.contentType });
          res.end(response.body);
          return;
        }
        res.writeHead(404, { "Content-Type": JSON_CONTENT_TYPE });
        res.end('{"error":"not found"}');
      } catch (error) {
        io.errorLog(`看板请求处理失败: ${errorMessage(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": JSON_CONTENT_TYPE });
          res.end('{"error":"internal error"}');
        }
      }
    })();
  });

  try {
    await listen(server, port, host);
  } catch (error) {
    if (isAddrInUse(error)) {
      io.errorLog(`端口 ${port} 已被占用（EADDRINUSE）：请用 --port 指定其他端口，或停止占用该端口的进程。`);
    } else {
      io.errorLog(`看板启动失败: ${errorMessage(error)}`);
    }
    return 2;
  }

  const address = server.address();
  if (address !== null && typeof address === "object") actualPort = address.port;
  const url = `http://${host}:${actualPort}/usage`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  io.log(`使用统计看板已启动: ${url}`);
  io.log(`JSON: http://${host}:${actualPort}/usage.json`);
  io.log(
    `存储: ${storageLabel(storage.kind)}${storage.note ? ` — ${storage.note}` : ""}`
  );
  if (!usageEnabledFrom(env)) io.log(USAGE_DISABLED_NOTE);
  io.log("按 Ctrl-C 停止。");

  try {
    await waitForShutdown({ url, port: actualPort, close });
  } finally {
    await close();
  }
  return 0;
}

export async function runUsageCommand(argv: string[], deps: UsageCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const nowMs = deps.now ? deps.now() : Date.now();
  const flags = parseFlags(argv);

  const sub = flags.positional[0];
  if (sub === "help" || sub === "-h" || flags.bool("help") || flags.bool("h")) {
    printUsageCommand(log);
    return 0;
  }
  if (sub !== undefined) {
    errorLog(`未知参数 "${sub}"`);
    printUsageCommand(log);
    return 2;
  }
  for (const key of ["project", "days", "port", "host"]) {
    if (flags.bool(key) && flags.get(key) === null) {
      errorLog(`--${key} 需要一个值`);
      return 2;
    }
  }
  if (flags.bool("all") && flags.get("project") !== null) {
    errorLog("--all 与 --project 不能同时使用");
    return 2;
  }

  const daysRaw = flags.get("days");
  const days = daysRaw === null ? DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1) {
    errorLog("--days 需要 ≥1 的整数");
    return 2;
  }

  let store: ProjectStore | null = null;
  try {
    let reason: string | null = null;
    if (deps.store) {
      store = deps.store;
    } else {
      const create = deps.createStore ?? ((url: string | null) => createProjectStore(url));
      const created = await create(env.MOBILE_TESTING_DATABASE_URL ?? null);
      store = created.store;
      reason = created.reason;
    }
    const storage = storageView(store.kind, reason);
    const io: Io = { log, errorLog };
    const enabled = usageEnabledFrom(env);
    const catalog = normalizeCatalog(deps.catalog ?? (await defaultCatalog()));

    if (flags.bool("web")) {
      return await runUsageWeb({
        flags,
        store,
        storage,
        io,
        env,
        catalog,
        nowMs,
        waitForShutdown: deps.waitForShutdown ?? defaultWaitForShutdown
      });
    }

    let hostFilter: string | null = null;
    const hostRef = flags.bool("web") ? null : flags.get("host");
    if (hostRef !== null) {
      const lookup = await resolveHostReference(store, hostRef);
      if (!lookup.ok) {
        if (lookup.reason === "ambiguous") {
          errorLog(
            `主机名不唯一 "${hostRef}"，请改用主机 id：${lookup.candidates
              .map((host) => host.id)
              .join("、")}`
          );
        } else {
          errorLog(
            `未知主机 "${hostRef}"（当前存储没有该主机记录；跨主机过滤需要中心 PostgreSQL，或先 host register）`
          );
        }
        return 2;
      }
      hostFilter = lookup.host.id;
    }

    const records = (await store.listProjects()).filter(
      (project) => hostFilter === null || project.hostId === hostFilter
    );
    const since = new Date(nowMs - days * 86_400_000).toISOString();
    const query: UsageEventQuery = { since, limit: usageEventSampleLimit(env) };
    let selected: Array<{ name: string; rootPath: string; hostId: string | null }>;
    if (flags.bool("all")) {
      selected = records.map((project) => ({
        name: project.name,
        rootPath: project.rootPath,
        hostId: project.hostId
      }));
    } else if (flags.get("project") !== null) {
      const key = flags.get("project")!;
      const candidates = resolveRegisteredProjectCandidates(records, key);
      if (candidates.length === 0) {
        const known = records.map((project) => project.name).join("、");
        errorLog(
          `未知项目 "${key}"${known ? `；已注册项目: ${known}` : "；当前存储中没有已注册项目"}`
        );
        return 2;
      }
      if (candidates.length > 1) {
        errorLog(
          `项目 "${key}" 在多台主机下都有登记：${candidates
            .map((project) => hostLabel(project.hostId))
            .join("、")}；请用 --host <id> 指定`
        );
        return 2;
      }
      const record = candidates[0]!;
      selected = [{ name: record.name, rootPath: record.rootPath, hostId: record.hostId }];
    } else {
      const loaded = loadProject({ cwd: deps.cwd, env });
      const matches = records.filter((project) => project.rootPath === loaded.rootDir);
      if (matches.length > 1) {
        errorLog(
          `当前项目路径在多台主机下都有登记：${matches
            .map((project) => hostLabel(project.hostId))
            .join("、")}；请用 --host <id> 指定`
        );
        return 2;
      }
      const record = matches[0] ?? null;
      selected = [
        {
          name: record?.name ?? path.basename(loaded.rootDir),
          rootPath: loaded.rootDir,
          hostId: record?.hostId ?? hostFilter
        }
      ];
    }

    const views: UsageProjectView[] = [];
    const allEvents: UsageEventRecord[] = [];
    for (const entry of selected) {
      const scoped = entry.hostId === null ? store : store.scopeHost(entry.hostId);
      let events: UsageEventRecord[];
      try {
        events = await scoped.listUsageEvents(entry.rootPath, query);
      } catch (error) {
        if (error instanceof AmbiguousProjectError) {
          const hosts = error.candidates.map((candidate) => hostLabel(candidate.hostId)).join("、");
          errorLog(
            `项目 "${entry.rootPath}" 未绑定主机，但同一路径已登记在：${hosts}；` +
              `请用 --host <id> 指定（或先在该主机执行 host adopt-legacy 认领历史行）`
          );
          return 2;
        }
        throw error;
      }
      allEvents.push(...events);
      views.push({
        name: entry.name,
        rootPath: entry.rootPath,
        hostId: entry.hostId,
        summary: usageSummary(events, catalog),
        signals: usageSignals(events)
      });
    }

    const report: UsageCliReport = {
      ok: true,
      generatedAt: new Date(nowMs).toISOString(),
      days,
      since,
      usage: enabled ? { enabled, note: null } : { enabled, note: USAGE_DISABLED_NOTE },
      store: storage,
      projects: views,
      totals: {
        summary: usageSummary(allEvents, catalog),
        signals: usageSignals(allEvents)
      }
    };

    if (flags.bool("json")) {
      log(JSON.stringify(report, null, 2));
    } else {
      for (const line of renderReport(report, flags.bool("all"))) log(line);
    }
    return 0;
  } catch (error) {
    errorLog(`usage 执行失败: ${errorMessage(error)}`);
    return 2;
  } finally {
    if (store) await store.close().catch(() => undefined);
  }
}
