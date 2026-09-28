import fs from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadProject, defaultArtemisRepo, emptyConfig } from "./config/loader.js";
import { ensureArtemisDeps, resolveDepsSource } from "./artemis/bootstrap.js";
import { createProjectStore } from "./db/index.js";
import { startBridge, stopBridge } from "./figma/bridge.js";
import { syncFigmaTokenEnv } from "./figma/token.js";
import { Runtime, sweepStaleChild } from "./runtime.js";
import { createServerForRuntime } from "./server.js";
import { AOS_MCP_VERSION, errorMessage, log } from "./util.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  workspaceRoot?: string;
}

export interface AosHttpHandle {
  httpServer: HttpServer;
  port: number;
  workspaceRoot: string;
  close(): Promise<void>;
}

const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SYNC_INTERVAL_MS = 30_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Stateless streamable-HTTP MCP endpoint: POST /mcp/<project>.
 * Each project maps to ${workspaceRoot}/<project> with its own runtime
 * (store association, artemis child process, LLM entries). */
export async function createAosHttpServer(options: HttpServerOptions = {}): Promise<AosHttpHandle> {
  const host = options.host ?? process.env.AOS_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.AOS_HTTP_PORT ?? 8765);
  const workspaceRoot = path.resolve(
    options.workspaceRoot ?? process.env.AOS_WORKSPACE_ROOT ?? process.cwd()
  );

  // Service-level first-run/update bootstrap: the artemis repo is shared by all
  // projects; deps come from env (AOS_ARTEMIS_DEPS_URL) or the default repo.
  const serviceRepo = path.resolve(process.env.AOS_ARTEMIS_REPO ?? defaultArtemisRepo());
  const depsSource = resolveDepsSource(emptyConfig(), process.env);
  const deps = await ensureArtemisDeps({ repoDir: serviceRepo, source: depsSource, log });
  if (deps.status !== "ready") {
    log(`依赖状态: ${deps.status} — ${deps.message.split("\n")[0]}`);
  }

  const { store, degraded, reason } = await createProjectStore();
  if (degraded && reason) log(reason);

  const runtimes = new Map<string, Runtime>();
  const syncTimer = setInterval(() => {
    for (const runtime of runtimes.values()) void runtime.syncTaskStatuses();
  }, SYNC_INTERVAL_MS);
  syncTimer.unref?.();

  const getRuntime = async (project: string): Promise<Runtime | null> => {
    const existing = runtimes.get(project);
    if (existing) return existing;

    const rootDir = path.join(workspaceRoot, project);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return null;

    let runtime: Runtime;
    try {
      const projectContext = loadProject({
        env: { ...process.env, AOS_PROJECT_DIR: rootDir, AOS_CONFIG: "" }
      });
      runtime = new Runtime(projectContext, { store, storeNote: reason });
      await runtime.initialize();
    } catch (error) {
      log(`项目 "${project}" 初始化失败: ${errorMessage(error)}`);
      return null;
    }

    try {
      const token = await runtime.figmaTokenInfo();
      syncFigmaTokenEnv(token.value);
    } catch {
      /* best effort */
    }
    try {
      const swept = await sweepStaleChild(runtime);
      if (swept) log(swept);
    } catch {
      /* best effort */
    }

    runtimes.set(project, runtime);
    log(`项目已注册（HTTP）: ${rootDir}`);
    return runtime;
  };

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              service: "aos-mcp",
              version: AOS_MCP_VERSION,
              workspaceRoot,
              projects: [...runtimes.keys()]
            })
          );
          return;
        }

        const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
        if (!match) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"not found; use /mcp/<project>"}');
          return;
        }

        const project = decodeURIComponent(match[1]!);
        if (!PROJECT_NAME_RE.test(project) || project === "." || project === "..") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"invalid project name"}');
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end('{"error":"method not allowed (stateless streamable HTTP; use POST)"}');
          return;
        }

        const runtime = await getRuntime(project);
        if (!runtime) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: `unknown project "${project}" under ${workspaceRoot}` })
          );
          return;
        }

        const body = await readBody(req);
        const server = createServerForRuntime(runtime, null);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        log(`HTTP 请求处理失败: ${errorMessage(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end('{"error":"internal error"}');
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", (error) => reject(error));
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  log(`aos-mcp HTTP 已启动: http://${host}:${actualPort}/mcp/<project>（workspace: ${workspaceRoot}）`);

  const close = async (): Promise<void> => {
    clearInterval(syncTimer);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const runtime of runtimes.values()) {
      try {
        await runtime.proxy.dispose();
      } catch {
        /* best effort */
      }
    }
    runtimes.clear();
    try {
      await store.close();
    } catch {
      /* best effort */
    }
    try {
      await stopBridge();
    } catch {
      /* best effort */
    }
  };

  return { httpServer, port: actualPort, workspaceRoot, close };
}

export async function runHttpServer(options: HttpServerOptions = {}): Promise<void> {
  const handle = await createAosHttpServer(options);

  try {
    const bridge = await startBridge();
    log(bridge.message || `Figma bridge: ${bridge.status}`);
  } catch (error) {
    log(`Figma 桥启动失败: ${errorMessage(error)}`);
  }

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await handle.close();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
}
