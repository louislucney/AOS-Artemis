import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { loadProject } from "./config/loader.js";
import { createProjectStore, type CreateStoreResult } from "./db/index.js";
import { storeKindShortLabel } from "./db/labels.js";
import { resolveHostIdentity, type HostIdentity } from "./host/identity.js";
import { handlePanelActionRequest } from "./panel/actions.js";
import { panelRoleFrom, panelRoleScopes, type PanelRole } from "./panel/roles.js";
import { handleArtifactRequest } from "./panel/artifact-route.js";
import { loopbackHostAllowed } from "./panel/http-guard.js";
import {
  MAX_PANEL_ASSET_UPLOAD_BYTES,
  MAX_PANEL_BODY_BYTES,
  MAX_PANEL_IMPORT_BYTES,
  PanelBodyTooLargeError
} from "./panel/limits.js";
import type { ProjectStore } from "./db/types.js";
import { Runtime } from "./runtime.js";
import {
  createPanelWebCache,
  handlePanelRequest,
  panelCacheTtlFrom,
  type PanelWebDeps
} from "./panel/web.js";
import { sweepStaleTasks, SWEEP_INTERVAL_MS } from "./tasks/sweeper.js";
import { errorMessage, isBuildStale } from "./util.js";

/** mobile-testing-mcp panel 子命令（overview-panel T6，DESIGN §13.105）：`panel --web` 复用
 * `/panel` handler 的独立只读看板（默认 loopback、独立端口）；独立进程无跨项目
 * Runtime，故深探层不可用（可用 `--workspace` 并入未注册的工作区目录）。 */

export const PANEL_WEB_DEFAULT_PORT = 8767;
const DEFAULT_WEB_HOST = "127.0.0.1";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export interface PanelCliDeps {
  store?: ProjectStore;
  createStore?: (databaseUrl: string | null) => Promise<CreateStoreResult>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  waitForShutdown?: (handle: PanelWebHandle) => Promise<void>;
  /** 独立面板的导入运行时（缺省按项目根懒建并复用本进程 store）。 */
  runtimeFor?: (rootPath: string) => Promise<Runtime | null>;
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
}

export interface PanelWebHandle {
  url: string;
  port: number;
  close(): Promise<void>;
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

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

function readStandaloneJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_PANEL_BODY_BYTES
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        reject(new PanelBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) return;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", (error) => {
      if (!oversized) reject(error);
    });
  });
}

function readStandaloneRawBody(
  req: IncomingMessage,
  maxBytes = MAX_PANEL_IMPORT_BYTES
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        reject(new PanelBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!oversized) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!oversized) reject(error);
    });
  });
}

function defaultWaitForShutdown(): Promise<void> {  return new Promise((resolve) => {
    const done = (): void => {
      process.removeListener("SIGINT", done);
      process.removeListener("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

export function printPanelCommand(log: (line: string) => void): void {
  log(`mobile-testing-mcp panel — 多项目总览面板（只读）

Usage:
  mobile-testing-mcp panel --web [--port 8767] [--host 127.0.0.1] [--workspace <dir>]
                    只读面板（复用 /panel 与 /panel.json；默认仅本机）
                    --workspace <dir>  并入该目录下的项目（未注册的工作区目录）
  mobile-testing-mcp panel help

说明：独立 CLI 进程无跨项目深探 Runtime；导入/建单/证据动作按项目根懒建并复用本进程 store
（失败不缓存、退出释放）；跨项目数据来自 MOBILE_TESTING_DATABASE_URL（未配置时使用项目文件台账，
跨项目以工作区扫描为准）；跨主机导入请在该项目机上执行，或使用 HTTP 模式。

exit codes: 0 成功；2 参数错误或端口被占用`);
}

async function runPanelWeb(options: {
  flags: ParsedFlags;
  store: ProjectStore;
  storageNote: string | null;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  errorLog: (line: string) => void;
  waitForShutdown: (handle: PanelWebHandle) => Promise<void>;
  runtimeFor?: (rootPath: string) => Promise<Runtime | null>;
}): Promise<number> {
  const { flags, store, env } = options;
  const host = flags.get("host") ?? DEFAULT_WEB_HOST;
  const portRaw = flags.get("port");
  const port = portRaw === null ? PANEL_WEB_DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    options.errorLog("--port 需要 0-65535 之间的整数");
    return 2;
  }
  const workspaceRaw = flags.get("workspace");
  const workspaceRoot = workspaceRaw === null ? null : path.resolve(workspaceRaw);

  let actualPort = port;
  const localHostIdentity: HostIdentity | null = await resolveHostIdentity({ env }).catch(
    () => null
  );
  const runtimes = new Map<string, Promise<Runtime | null>>();
  const runtimeFor =
    options.runtimeFor ??
    ((rootPath: string): Promise<Runtime | null> => {
      const cached = runtimes.get(rootPath);
      if (cached) return cached;
      const created = (async (): Promise<Runtime | null> => {
        try {
          const project = loadProject({
            env: { ...env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" }
          });
          const runtime = new Runtime(project, {
            store,
            storeNote: options.storageNote,
            baseEnv: env,
            ...(localHostIdentity === null ? {} : { hostIdentity: localHostIdentity })
          });
          await runtime.initialize();
          return runtime;
        } catch (error) {
          options.errorLog(`面板运行时初始化失败（${rootPath}）: ${errorMessage(error)}`);
          return null;
        }
      })();
      runtimes.set(rootPath, created);
      void created.then((runtime) => {
        if (runtime === null && runtimes.get(rootPath) === created) runtimes.delete(rootPath);
      });
      return created;
    });
  const panelRole: PanelRole =
    (env.AOS_PANEL_ACTIONS ?? "").trim() === "1" ? panelRoleFrom(env) : "viewer";
  const deps: PanelWebDeps = {
    store,
    env,
    workspaceRoot,
    buildStale: isBuildStale(import.meta.url, Date.now() - Math.round(process.uptime() * 1000)),
    cache: createPanelWebCache(panelCacheTtlFrom(env)),
    runtimeFor,
    localHostId: localHostIdentity?.id ?? null,
    storeNote: options.storageNote,
    storeForHost: (hostId) => store.scopeHost(hostId),
    capabilities: {
      actions: panelRole !== "viewer",
      role: panelRole,
      scopes: panelRoleScopes(panelRole),
      usage: false,
      mode: "standalone"
    }
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(
          req.url ?? "/",
          `http://${req.headers.host ?? `${host}:${actualPort}`}`
        );
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(302, { Location: "/panel" });
          res.end();
          return;
        }
        if (req.method === "GET" && url.pathname === "/panel/artifact") {
          const response = await handleArtifactRequest(url, deps, {
            accept: req.headers.accept ?? null
          });
          res.writeHead(response.status, { "Content-Type": response.contentType });
          res.end(response.body);
          return;
        }
        if (
          req.method === "GET" &&
          (url.pathname === "/panel" ||
            url.pathname === "/panel.json" ||
            url.pathname === "/panel/api/hosts")
        ) {
          const response = await handlePanelRequest(url, deps);
          res.writeHead(response.status, { "Content-Type": response.contentType });
          res.end(response.body);
          return;
        }
        if (
          url.pathname.startsWith("/panel/api/") &&
          (env.AOS_PANEL_ACTIONS ?? "").trim() === "1" &&
          loopbackHostAllowed(req.headers.host) &&
          (req.method === "POST" || req.method === "GET")
        ) {
          let body: unknown;
          let rawBody: Buffer | undefined;
          let requestContentType: string | undefined;
          const headerType = req.headers["content-type"];
          const contentTypeValue = Array.isArray(headerType) ? headerType[0] : headerType;
          const isMultipart =
            req.method === "POST" &&
            typeof contentTypeValue === "string" &&
            contentTypeValue.toLowerCase().includes("multipart/form-data");
          if (isMultipart) {
            try {
              rawBody = await readStandaloneRawBody(
                req,
                url.pathname === "/panel/api/projects/assets"
                  ? MAX_PANEL_ASSET_UPLOAD_BYTES
                  : MAX_PANEL_IMPORT_BYTES
              );
            } catch (error) {
              const oversized = error instanceof PanelBodyTooLargeError;
              res.writeHead(oversized ? 413 : 400, { "Content-Type": JSON_CONTENT_TYPE });
              res.end(
                oversized
                  ? '{"error":"request body too large"}'
                  : '{"error":"invalid multipart body"}'
              );
              return;
            }
            requestContentType = contentTypeValue;
          } else if (req.method === "POST") {
            try {
              body = await readStandaloneJsonBody(req);
            } catch (error) {
              const oversized = error instanceof PanelBodyTooLargeError;
              res.writeHead(oversized ? 413 : 400, { "Content-Type": JSON_CONTENT_TYPE });
              res.end(
                oversized
                  ? '{"error":"request body too large"}'
                  : '{"error":"invalid JSON body"}'
              );
              return;
            }
          }
          const response = await handlePanelActionRequest(
            {
              method: req.method ?? "GET",
              url,
              body,
              headers: req.headers,
              ...(rawBody === undefined ? {} : { rawBody }),
              ...(requestContentType === undefined ? {} : { contentType: requestContentType })
            },
            deps
          );
          res.writeHead(response.status, { "Content-Type": response.contentType });
          res.end(response.body);
          return;
        }
        res.writeHead(404, { "Content-Type": JSON_CONTENT_TYPE });
        res.end('{"error":"not found"}');
      } catch (error) {
        options.errorLog(`面板请求处理失败: ${errorMessage(error)}`);
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
      options.errorLog(
        `端口 ${port} 已被占用（EADDRINUSE）：请用 --port 指定其他端口，或停止占用该端口的进程。`
      );
    } else {
      options.errorLog(`面板启动失败: ${errorMessage(error)}`);
    }
    return 2;
  }

  const address = server.address();
  if (address !== null && typeof address === "object") actualPort = address.port;
  const url = `http://${host}:${actualPort}/panel`;

  const runCancellationSweep = (): void => {
    void sweepStaleTasks({ store, allHosts: true })
      .then((result) => {
        if (result.cancelled > 0) options.log(`离线取消终结：${result.cancelled} 条`);
      })
      .catch((error) => options.errorLog(`离线取消清扫失败: ${errorMessage(error)}`));
  };
  runCancellationSweep();
  const sweepTimer = setInterval(runCancellationSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    for (const pending of runtimes.values()) {
      const runtime = await pending.catch(() => null);
      if (runtime === null) continue;
      try {
        runtime.proxy.disposeSync();
      } catch {
        /* best effort */
      }
    }
    runtimes.clear();
  };

  options.log(`总览面板已启动: ${url}`);
  options.log(`JSON: http://${host}:${actualPort}/panel.json`);
  options.log(
    `存储: ${storeKindShortLabel(store.kind)}${
      options.storageNote ? ` — ${options.storageNote}` : ""
    }`
  );
  options.log(`工作区: ${workspaceRoot ?? "未指定（仅 PG 注册项目）"}`);
  options.log("按 Ctrl-C 停止。");

  try {
    await options.waitForShutdown({ url, port: actualPort, close });
  } finally {
    await close();
  }
  return 0;
}

export async function runPanelCommand(argv: string[], deps: PanelCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const flags = parseFlags(argv);

  const sub = flags.positional[0];
  if (sub === "help" || sub === "-h" || flags.bool("help") || flags.bool("h")) {
    printPanelCommand(log);
    return 0;
  }
  if (sub !== undefined) {
    errorLog(`未知参数 "${sub}"`);
    printPanelCommand(log);
    return 2;
  }
  if (!flags.bool("web")) {
    printPanelCommand(log);
    return 2;
  }
  for (const key of ["port", "host", "workspace"]) {
    if (flags.bool(key) && flags.get(key) === null) {
      errorLog(`--${key} 需要一个值`);
      return 2;
    }
  }

  let store: ProjectStore | null = null;
  let storageNote: string | null = null;
  try {
    if (deps.store) {
      store = deps.store;
    } else {
      const create = deps.createStore ?? ((url: string | null) => createProjectStore(url));
      const created = await create(env.MOBILE_TESTING_DATABASE_URL ?? null);
      store = created.store;
      storageNote = created.reason;
    }
  } catch (error) {
    errorLog(`存储初始化失败: ${errorMessage(error)}`);
    return 2;
  }

  try {
    return await runPanelWeb({
      flags,
      store,
      storageNote,
      env,
      log,
      errorLog,
      waitForShutdown: deps.waitForShutdown ?? defaultWaitForShutdown,
      ...(deps.runtimeFor === undefined ? {} : { runtimeFor: deps.runtimeFor })
    });
  } catch (error) {
    errorLog(`panel 失败: ${errorMessage(error)}`);
    return 2;
  }
}
