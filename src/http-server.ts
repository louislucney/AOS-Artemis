import fs from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  isLoopbackHost,
  parseAuthUsers,
  resolveRequestIdentity,
  unauthorizedResponse,
  type AuthIdentity
} from "./auth.js";
import { defaultUsersFile, HttpUserDirectory } from "./auth/users.js";
import { CLI_NAME } from "./brand.js";
import { loadProject, defaultArtemisRepo, emptyConfig } from "./config/loader.js";
import { resolveDepsSource } from "./artemis/bootstrap.js";
import { startBridge } from "./figma/bridge.js";
import {
  createPanelWebCache,
  handlePanelRequest,
  panelCacheTtlFrom,
  type PanelWebDeps
} from "./panel/web.js";
import { handlePanelActionRequest, panelActionsEnabled } from "./panel/actions.js";
import { handleRunnerJobRequest, matchRunnerJobPath } from "./panel/actions.js";
import { panelRoleFrom, panelRoleScopes } from "./panel/roles.js";
import {
  MAX_PANEL_ASSET_UPLOAD_BYTES,
  MAX_PANEL_BODY_BYTES,
  MAX_PANEL_RESULT_BODY_BYTES,
  MAX_PANEL_UPLOAD_BYTES
} from "./panel/limits.js";
import { resolveHostIdentity } from "./host/identity.js";
import { handleArtifactRequest } from "./panel/artifact-route.js";
import {
  isValidProjectName,
  ProjectConfigError,
  resolveEventProject,
  resolveProjectRoot
} from "./events/project-resolver.js";
import {
  degradedReason,
  EventValidationError,
  listProjectEvents,
  pollProjectEvents,
  reportProjectEvent
} from "./events/ingress.js";
import { createPanelDeepProbe } from "./panel/deep.js";
import type { ProjectEventQuery, ProjectStore } from "./db/types.js";
import { Runtime } from "./runtime.js";
import { RuntimeHost } from "./runtime-host.js";
import { createServerForRuntime, inProcessToolCatalog } from "./server.js";
import { sweepStaleTasks, SWEEP_INTERVAL_MS } from "./tasks/sweeper.js";
import { handleUsageRequest } from "./usage/web.js";
import { AOS_MCP_VERSION, errorMessage, isBuildStale, log, maskSecret } from "./util.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  workspaceRoot?: string;
  /** 测试/嵌入：复用外部 store（缺省由 RuntimeHost.prepare 自建）。 */
  store?: ProjectStore;
}

export interface AosHttpHandle {
  httpServer: HttpServer;
  port: number;
  workspaceRoot: string;
  close(): Promise<void>;
}

const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_EVENT_BODY_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 非 loopback 且未配置静态令牌、未显式放行时拒绝启动（fail-fast，无副作用）。 */
export class InsecureBindRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureBindRefusedError";
  }
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** 静态令牌闸门豁免：仅根路径与健康检查，且只允许 GET/HEAD（不读查询参数）。 */
function isExempt(method: string | undefined, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && (pathname === "/" || pathname === "/healthz");
}

/** 请求体超限（区别于 JSON 解析失败；外层映射 413）。 */
class BodyTooLargeError extends Error {}

/** 原始字节体（multipart 上传用；调用方负责上限预检）。 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
  });
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
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
    req.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
  });
}

/** Stateless streamable-HTTP MCP endpoint: POST /mcp/<project>.
 * Each project maps to ${workspaceRoot}/<project> with its own runtime
 * (store association, artemis child process, LLM entries). */
export async function createAosHttpServer(options: HttpServerOptions = {}): Promise<AosHttpHandle> {
  const host = options.host ?? process.env.AOS_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.AOS_HTTP_PORT ?? 8765);
  const requestedWorkspace = path.resolve(
    options.workspaceRoot ?? process.env.AOS_WORKSPACE_ROOT ?? process.cwd()
  );
  let workspaceRoot = requestedWorkspace;
  try {
    workspaceRoot = fs.realpathSync.native(requestedWorkspace);
  } catch {
    workspaceRoot = requestedWorkspace;
  }
  const token = (process.env.AOS_HTTP_TOKEN ?? "").trim();
  const authUsers = parseAuthUsers(process.env.AOS_HTTP_USERS);
  if (authUsers.errors.length > 0) {
    throw new AuthConfigError(`AOS_HTTP_USERS 配置非法：${authUsers.errors.join("；")}`);
  }
  const userFile = defaultUsersFile(process.env);
  const userDirectory = new HttpUserDirectory(userFile, authUsers.users);
  const userFileErrors = userDirectory.initialize();
  if (userFileErrors.length > 0) {
    throw new AuthConfigError(`${userFile} 配置非法：${userFileErrors.join("；")}`);
  }
  const initialUserSnapshot = userDirectory.snapshot();
  const authEnabled = token !== "" || authUsers.users.length > 0 || initialUserSnapshot.hashed.length > 0;
  const allowInsecure = process.env.AOS_HTTP_ALLOW_INSECURE === "1";

  if (!isLoopbackHost(host) && !authEnabled && !allowInsecure) {
    throw new InsecureBindRefusedError(
      `拒绝在非 loopback 主机（${host}）上无鉴权启动 HTTP 服务：请设置 AOS_HTTP_TOKEN` +
        `（静态令牌）或 AOS_HTTP_USERS（命名令牌），或显式 AOS_HTTP_ALLOW_INSECURE=1` +
        `（仅限可信网络，不安全）。`
    );
  }
  if (allowInsecure && !isLoopbackHost(host) && !authEnabled) {
    log(
      `WARN：非 loopback 主机（${host}）且未设置 AOS_HTTP_TOKEN/AOS_HTTP_USERS，已按 AOS_HTTP_ALLOW_INSECURE=1` +
        ` 放行（无鉴权，仅限可信网络）。`,
      "warn"
    );
  }

  // 服务级首启/更新引导：artemis 仓库全项目共享（依赖来源见 AOS_ARTEMIS_DEPS_URL / 默认仓库）。
  const serviceRepo = path.resolve(process.env.AOS_ARTEMIS_REPO ?? defaultArtemisRepo());
  const runtimeHost = await RuntimeHost.prepare({
    logDir: process.env.AOS_LOG_DIR?.trim() || path.join(workspaceRoot, ".mobile-testing-mcp", "logs"),
    startupLine: `${CLI_NAME} ${AOS_MCP_VERSION} 启动（HTTP）workspace=${workspaceRoot}`,
    deps: { repoDir: serviceRepo, source: resolveDepsSource(emptyConfig(), process.env) }
  });
  const store = options.store ?? runtimeHost.store;
  const reason = runtimeHost.storeNote;

  log(
    !authEnabled
      ? "认证：未启用"
      : `认证：已启用（用户 ${authUsers.users.length + initialUserSnapshot.hashed.length} 个，文件 ${userFile}${token === "" ? "" : `，静态 token=${maskSecret(token)}`}）`
  );

  const runtimes = new Map<string, Runtime>();

  const getRuntime = async (project: string): Promise<Runtime | null> => {
    const existing = runtimes.get(project);
    if (existing) return existing;

    const rootDir = resolveProjectRoot(workspaceRoot, project);
    if (rootDir === null) return null;

    let runtime: Runtime;
    try {
      const projectContext = loadProject({
        env: { ...process.env, AOS_PROJECT_DIR: rootDir, AOS_CONFIG: "" }
      });
      runtime = await runtimeHost.createRuntime(projectContext, {
        registerLine: () => `项目已注册（HTTP）: ${rootDir}`
      });
    } catch (error) {
      log(`项目 "${project}" 初始化失败: ${errorMessage(error)}`);
      return null;
    }

    runtimes.set(project, runtime);
    return runtime;
  };

  // 深探层：仅限 workspace 一级子目录项目；懒建 Runtime（纯读子集、不拉起子进程）。
  const deepRuntimeFor = async (rootPath: string): Promise<Runtime | null> => {
    const relative = path.relative(workspaceRoot, rootPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const segments = relative.split(path.sep);
    if (segments.length !== 1) return null;
    const name = segments[0]!;
    if (!PROJECT_NAME_RE.test(name) || name === "." || name === "..") return null;
    return await getRuntime(name);
  };
  const panelRole = panelRoleFrom(process.env);
  const panelDeps: PanelWebDeps = {
    store,
    env: process.env,
    workspaceRoot,
    serviceRepo,
    buildStale: isBuildStale(import.meta.url, Date.now() - Math.round(process.uptime() * 1000)),
    cache: createPanelWebCache(panelCacheTtlFrom(process.env)),
    deep: createPanelDeepProbe({ createRuntime: deepRuntimeFor }),
    runtimeFor: deepRuntimeFor,
    localHostId: (await resolveHostIdentity({ env: process.env }).catch(() => null))?.id ?? null,
    storeNote: runtimeHost.storeNote,
    storeForHost: (hostId) => store.scopeHost(hostId),
    capabilities: {
      actions: panelRole !== "viewer",
      role: panelRole,
      scopes: panelRoleScopes(panelRole),
      usage: true,
      mode: "http"
    }
  };

  const panelDepsFor = (identity: AuthIdentity): PanelWebDeps => ({
    ...panelDeps,
    actor: identity.name,
    capabilities: {
      actions: panelActionsEnabled(process.env) && identity.role !== "viewer",
      usage: panelDeps.capabilities?.usage ?? true,
      mode: panelDeps.capabilities?.mode ?? "http",
      role: identity.role,
      scopes: panelRoleScopes(identity.role)
    }
  });

  let lastUserFileError: string | null = null;
  // 认证闩锁：一旦启用（启动时或运行期文件出现），清空用户/删除文件也不再放开匿名访问。
  let authRequired = authEnabled;

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

        const runnerRoute = matchRunnerJobPath(url.pathname);
        if (runnerRoute !== null) {
          let runnerRawBody: Buffer | undefined;
          let runnerContentType: string | undefined;
          if (runnerRoute.kind === "results" && req.method === "POST") {
            const headerType = req.headers["content-type"];
            runnerContentType = Array.isArray(headerType) ? headerType[0] : headerType;
            try {
              runnerRawBody = await readRawBody(req, MAX_PANEL_RESULT_BODY_BYTES);
            } catch (error) {
              if (error instanceof BodyTooLargeError) throw error;
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end('{"error":"invalid request body"}');
              return;
            }
          }
          const runnerResponse = await handleRunnerJobRequest({
            method: req.method ?? "GET",
            url,
            headers: req.headers,
            store,
            env: process.env,
            ...(runnerRawBody === undefined ? {} : { rawBody: runnerRawBody }),
            ...(runnerContentType === undefined ? {} : { contentType: runnerContentType })
          });
          res.writeHead(runnerResponse.status, {
            "Content-Type": runnerResponse.contentType,
            ...(runnerResponse.extraHeaders ?? {})
          });
          if (runnerResponse.streamPath !== undefined) {
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            await new Promise<void>((resolve) => {
              const stream = fs.createReadStream(runnerResponse.streamPath!);
              let settled = false;
              const done = (): void => {
                if (settled) return;
                settled = true;
                resolve();
              };
              stream.on("error", () => {
                if (!res.writableEnded) res.destroy();
                done();
              });
              res.on("close", done);
              stream.on("end", done);
              stream.pipe(res);
            });
            return;
          }
          res.end(req.method === "HEAD" ? undefined : runnerResponse.body);
          return;
        }

        const userSnapshot = userDirectory.snapshot();
        const userFileProblem = userSnapshot.errors[0] ?? null;
        if (userFileProblem !== null && userFileProblem !== lastUserFileError) {
          log(`WARN：${userFileProblem}`, "warn");
        }
        lastUserFileError = userFileProblem;

        const requestAuthEnabled =
          token !== "" || userSnapshot.plain.length > 0 || userSnapshot.hashed.length > 0;
        if (requestAuthEnabled) authRequired = true;
        const identity = resolveRequestIdentity({
          authorization: req.headers.authorization,
          staticToken: token,
          users: userSnapshot.plain,
          hashedUsers: userSnapshot.hashed,
          fallbackRole: panelRole,
          staticActor: process.env.AOS_ACTOR,
          authRequired
        });
        if (authRequired && !isExempt(req.method, url.pathname) && identity === null) {
          const unauthorized = unauthorizedResponse(CLI_NAME);
          const headers = { ...unauthorized.headers };
          if (req.method === "HEAD") headers["Content-Length"] = "0";
          res.writeHead(unauthorized.status, headers);
          if (req.method === "HEAD") res.end();
          else res.end(unauthorized.body);
          return;
        }
        const requestIdentity: AuthIdentity =
          identity ?? { name: "anonymous", role: panelRole, source: "anonymous" };

        if (
          (req.method === "GET" || req.method === "HEAD") &&
          (url.pathname === "/" || url.pathname === "/healthz")
        ) {
          const body = JSON.stringify({
            ok: true,
            service: CLI_NAME,
            version: AOS_MCP_VERSION,
            workspaceRoot,
            projects: [...runtimes.keys()]
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }

        if (
          req.method === "GET" &&
          (url.pathname === "/usage" || url.pathname === "/usage.json")
        ) {
          const usageResponse = await handleUsageRequest(url, {
            store,
            catalog: inProcessToolCatalog(),
            storageNote: reason,
            env: process.env,
            panelUrl: "/panel"
          });
          res.writeHead(usageResponse.status, { "Content-Type": usageResponse.contentType });
          res.end(usageResponse.body);
          return;
        }

        if (req.method === "GET" && url.pathname === "/panel/artifact") {
          const response = await handleArtifactRequest(url, panelDeps, {
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
          const panelResponse = await handlePanelRequest(url, panelDepsFor(requestIdentity));
          res.writeHead(panelResponse.status, { "Content-Type": panelResponse.contentType });
          res.end(panelResponse.body);
          return;
        }

        if (url.pathname.startsWith("/panel/api/")) {
          let body: unknown = undefined;
          let rawBody: Buffer | undefined;
          let contentType: string | undefined;
          const headerType = req.headers["content-type"];
          const contentTypeValue = Array.isArray(headerType) ? headerType[0] : headerType;
          const isMultipart =
            typeof contentTypeValue === "string" &&
            contentTypeValue.toLowerCase().includes("multipart/form-data");
          if (req.method === "POST" && isMultipart) {
            try {
              // 资产上传（安装包/材料/脚本包）单独放宽；其余面板动作保持约 20MB。
              rawBody = await readRawBody(
                req,
                url.pathname === "/panel/api/projects/assets"
                  ? MAX_PANEL_ASSET_UPLOAD_BYTES
                  : MAX_PANEL_BODY_BYTES + MAX_PANEL_UPLOAD_BYTES
              );
            } catch (error) {
              if (error instanceof BodyTooLargeError) throw error;
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end('{"error":"invalid multipart body"}');
              return;
            }
            contentType = contentTypeValue;
          } else if (req.method === "POST") {
            try {
              body = await readBody(req, MAX_PANEL_BODY_BYTES);
            } catch (error) {
              if (error instanceof BodyTooLargeError) throw error;
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end('{"error":"invalid JSON body"}');
              return;
            }
          }
          const actionResponse = await handlePanelActionRequest(
            {
              method: req.method ?? "GET",
              url,
              body,
              headers: req.headers,
              identity: requestIdentity,
              ...(rawBody === undefined ? {} : { rawBody }),
              ...(contentType === undefined ? {} : { contentType })
            },
            panelDeps
          );
          res.writeHead(actionResponse.status, { "Content-Type": actionResponse.contentType });
          res.end(actionResponse.body);
          return;
        }

        const eventSegments = url.pathname.split("/").filter((segment) => segment !== "");
        let eventHost: string | null = null;
        let eventProject: string | null = null;
        let eventPoll = false;
        if (eventSegments[0] === "events") {
          const rest = eventSegments.slice(1);
          if (rest.length >= 2 && rest[rest.length - 1] === "poll") {
            eventPoll = true;
            rest.pop();
          }
          if (rest.length === 2) {
            eventHost = rest[0]!;
            eventProject = rest[1]!;
          } else if (rest.length === 1) {
            eventProject = rest[0]!;
          }
        }
        if (eventProject !== null) {
          let projectName: string;
          let hostId: string | null = null;
          try {
            projectName = decodeURIComponent(eventProject);
            if (eventHost !== null) hostId = decodeURIComponent(eventHost);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid project name"}');
            return;
          }
          if (!isValidProjectName(projectName)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid project name"}');
            return;
          }
          if (eventPoll && req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end('{"error":"method not allowed"}');
            return;
          }
          if (req.method !== "POST" && req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end('{"error":"method not allowed"}');
            return;
          }
          try {
            const resolved = await resolveEventProject({
              workspaceRoot,
              name: projectName,
              hostId,
              store,
              write: req.method === "POST"
            });
            if (resolved === null) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end('{"error":"project not found"}');
              return;
            }
            const scopedStore =
              resolved.hostId !== null ? store.scopeHost(resolved.hostId) : store;
            if (req.method === "POST") {
              let body: unknown;
              try {
                body = await readBody(req, MAX_EVENT_BODY_BYTES);
              } catch (error) {
                if (error instanceof BodyTooLargeError) {
                  res.writeHead(413, { "Content-Type": "application/json" });
                  res.end('{"error":"event body too large"}');
                } else {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end('{"error":"invalid JSON body"}');
                }
                return;
              }
              const ack = await reportProjectEvent(
                {
                  store: scopedStore,
                  rootPath: resolved.rootPath,
                  storage: store.kind,
                  degraded: degradedReason(store, reason)
                },
                body
              );
              res.writeHead(202, { "Content-Type": "application/json" });
              res.end(JSON.stringify(ack));
              return;
            }
            if (req.method === "GET") {
              const includeRaw = url.searchParams.get("includePayload");
              const orderRaw = url.searchParams.get("order");
              const limitRaw = url.searchParams.get("limit");
              const limit = limitRaw === null ? undefined : Number(limitRaw);
              const afterSeqRaw = url.searchParams.get("afterSeq");
              const consumedRaw = url.searchParams.get("consumed");
              const context = {
                store: scopedStore,
                rootPath: resolved.rootPath,
                storage: store.kind,
                degraded: degradedReason(store, reason)
              };
              const query: ProjectEventQuery = {
                since: url.searchParams.get("since") ?? undefined,
                runId: url.searchParams.get("runId") ?? undefined,
                caseId: url.searchParams.get("caseId") ?? undefined,
                type: url.searchParams.get("type") ?? undefined,
                status: url.searchParams.get("status") ?? undefined,
                afterSeq: afterSeqRaw === null ? undefined : Number(afterSeqRaw),
                consumed:
                  consumedRaw === null
                    ? undefined
                    : consumedRaw === "true" || consumedRaw === "1"
                      ? true
                      : consumedRaw === "false" || consumedRaw === "0"
                        ? false
                        : undefined,
                order:
                  orderRaw === "asc" || orderRaw === "desc" ? orderRaw : undefined,
                limit:
                  limit !== undefined && Number.isFinite(limit) ? limit : undefined,
                includePayload: includeRaw === "true" || includeRaw === "1"
              };
              if (eventPoll) {
                const waitRaw = url.searchParams.get("waitMs") ?? url.searchParams.get("wait");
                const waitMs = waitRaw === null ? 0 : Number(waitRaw);
                if (!Number.isFinite(waitMs) || waitMs < 0) {
                  throw new EventValidationError("waitMs 必须是非负数", "waitMs");
                }
                const controller = new AbortController();
                res.on("close", () => {
                  if (!res.writableEnded) controller.abort();
                });
                const polled = await pollProjectEvents(context, {
                  ...query,
                  waitMs,
                  consume:
                    url.searchParams.get("consume") === "true" ||
                    url.searchParams.get("consume") === "1",
                  signal: controller.signal
                });
                if (controller.signal.aborted) {
                  res.end();
                  return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(polled));
                return;
              }
              const listed = await listProjectEvents(context, query);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(listed));
              return;
            }
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end('{"error":"method not allowed"}');
            return;
          } catch (error) {
            if (error instanceof EventValidationError) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: error.message, field: error.field }));
              return;
            }
            if (error instanceof ProjectConfigError) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "project-config-invalid", detail: error.message }));
              return;
            }
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"event store unavailable"}');
            return;
          }
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
          if (error instanceof BodyTooLargeError) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end('{"error":"request body too large"}');
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"internal error"}');
          }
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
  log(`${CLI_NAME} HTTP 已启动: http://${host}:${actualPort}/mcp/<project>（workspace: ${workspaceRoot}）`);

  const runCancellationSweep = (): void => {
    void sweepStaleTasks({ store, allHosts: true })
      .then((result) => {
        if (result.cancelled > 0) log(`离线取消终结：${result.cancelled} 条`);
      })
      .catch((error) => log(`离线取消清扫失败: ${errorMessage(error)}`, "warn"));
  };
  runCancellationSweep();
  const sweepTimer = setInterval(runCancellationSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  const close = async (): Promise<void> => {
    clearInterval(sweepTimer);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    runtimes.clear();
    await runtimeHost.shutdown();
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
