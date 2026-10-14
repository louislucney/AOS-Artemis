import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";

import { escapeHtml } from "../util.js";

/** 产物只读服务（P2）：根＝`<projectDir>/.artemis`，GET/HEAD、浅目录索引、realpath 越界拒绝。 */
export interface RunnerArtifactServer {
  port: number;
  close(): Promise<void>;
}

export interface StartRunnerArtifactServerOptions {
  projectDir: string;
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
}

const MAX_INDEX_ENTRIES = 500;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function encodeRel(rel: string): string {
  return rel
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function sendJson(res: ServerResponse, status: number, payload: unknown, head = false): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff"
  });
  if (head) {
    res.end();
    return;
  }
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string, head: boolean): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "X-Content-Type-Options": "nosniff"
  });
  if (head) {
    res.end();
    return;
  }
  res.end(html);
}

async function sendIndex(
  res: ServerResponse,
  head: boolean,
  rootReal: string,
  targetReal: string
): Promise<void> {
  const entries = await fs.promises.readdir(targetReal, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const relDir = path.relative(rootReal, targetReal);
  const parentHref =
    targetReal === rootReal
      ? ""
      : `<p><a href="/artifact/${
          path.relative(rootReal, path.dirname(targetReal)) === ""
            ? ""
            : `${encodeRel(path.relative(rootReal, path.dirname(targetReal)))}/`
        }">← 上级</a></p>`;
  const rows = sorted.slice(0, MAX_INDEX_ENTRIES).map((entry) => {
    const rel = relDir === "" ? entry.name : path.join(relDir, entry.name);
    const suffix = entry.isDirectory() ? "/" : "";
    return `<li><a href="/artifact/${encodeRel(rel)}${suffix}">${escapeHtml(entry.name)}${suffix}</a></li>`;
  });
  const truncated =
    sorted.length > MAX_INDEX_ENTRIES
      ? `<p>共 ${sorted.length} 项，仅显示前 ${MAX_INDEX_ENTRIES} 项。</p>`
      : "";
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>产物索引 · ${escapeHtml(relDir === "" ? "/" : relDir)}</title>`,
    "<style>body{font-family:system-ui;padding:24px}li{margin:4px 0}</style>",
    "</head><body>",
    `<h1>${escapeHtml(relDir === "" ? "/" : `/${relDir}`)}</h1>`,
    parentHref,
    `<ul>${rows.join("")}</ul>`,
    truncated,
    "</body></html>"
  ].join("");
  sendHtml(res, html, head);
}

export async function startRunnerArtifactServer(
  options: StartRunnerArtifactServerOptions
): Promise<RunnerArtifactServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  let rootReal: string | null = null;
  try {
    rootReal = await fs.promises.realpath(path.join(options.projectDir, ".artemis"));
  } catch {
    rootReal = null;
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const method = req.method ?? "GET";
        const head = method === "HEAD";
        if (method !== "GET" && method !== "HEAD") {
          sendJson(res, 405, { error: "method not allowed (GET/HEAD)" });
          return;
        }
        if (url.pathname === "/healthz") {
          sendJson(res, 200, { ok: true, project: path.basename(options.projectDir) }, head);
          return;
        }
        if (url.pathname !== "/artifact" && !url.pathname.startsWith("/artifact/")) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (rootReal === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const rawRel = url.pathname === "/artifact" ? "" : url.pathname.slice("/artifact/".length);
        let rel: string;
        try {
          rel = decodeURIComponent(rawRel);
        } catch {
          sendJson(res, 400, { error: "bad path" });
          return;
        }
        if (rel.includes("\0")) {
          sendJson(res, 400, { error: "bad path" });
          return;
        }
        const resolved = path.resolve(rootReal, rel);
        if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        let targetReal: string;
        try {
          targetReal = await fs.promises.realpath(resolved);
        } catch {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const stat = await fs.promises.stat(targetReal);
        if (stat.isDirectory()) {
          await sendIndex(res, head, rootReal, targetReal);
          return;
        }
        if (!stat.isFile()) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const contentType =
          MIME_BY_EXT[path.extname(targetReal).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": stat.size,
          "X-Content-Type-Options": "nosniff"
        });
        if (head) {
          res.end();
          return;
        }
        fs.createReadStream(targetReal).pipe(res);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    port: actualPort,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
