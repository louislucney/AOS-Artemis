// PATCH (aos-mcp): rewritten bridge server.
// Upstream: design-context-bridge src/figma-bridge/ws-server.ts (MIT).
// Changes:
//  1. CORS is no longer `*`: only `null` (Figma plugin iframe) and loopback
//     origins are allowed; other browser origins get 403.
//  2. EADDRINUSE no longer silently degrades to file sharing — the bridge
//     reports `skipped_occupied` so the caller can surface it (REST mode
//     keeps working; plugin mode is unavailable in this process).
//  3. startFigmaBridge() returns a status handle and accepts an options object
//     (tests use port 0 for an ephemeral listener).
// Requests without an Origin header (curl, plugin sandbox) are allowed; the
// loopback bind remains the hard security boundary.
import { createServer, type Server as HttpServer } from 'node:http';
import { store } from './store.js';
import type { FigmaDocumentContext } from '../core/types.js';

export const FIGMA_BRIDGE_PORT = 3055;

export interface BridgeStartOptions {
  port?: number;
  host?: string;
}

export interface BridgeHandle {
  ok: boolean;
  status: 'listening' | 'skipped_occupied' | 'error';
  port: number | null;
  message: string;
  close: () => Promise<void>;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true; // non-browser client
  if (origin === 'null') return true; // Figma plugin iframe (null origin)
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

function applyCors(res: import('node:http').ServerResponse, origin: string | undefined): boolean {
  if (!isAllowedOrigin(origin)) {
    res.writeHead(403);
    res.end('{"ok":false,"error":"origin not allowed"}');
    return false;
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

export function startFigmaBridge(options: BridgeStartOptions = {}): Promise<BridgeHandle> {
  const envPort = Number(process.env.FIGMA_BRIDGE_PORT);
  const port =
    options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : FIGMA_BRIDGE_PORT);
  const host = options.host ?? '127.0.0.1';

  const httpServer = createServer((req, res) => {
    const origin = req.headers.origin as string | undefined;
    if (!applyCors(res, origin)) return;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/update') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const ctx = JSON.parse(body) as FigmaDocumentContext;
          store.setContext(ctx);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (_e) {
          res.writeHead(400);
          res.end('{"ok":false}');
        }
      });
      return;
    }

    // Plugin polls this to pull pending on-demand requests (queue is cleared).
    if (req.method === 'GET' && req.url === '/requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(store.takeRequests()));
      return;
    }

    // Plugin posts the result of an on-demand request here.
    if (req.method === 'POST' && req.url === '/response') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, result } = JSON.parse(body) as { id: string; result: unknown };
          store.setResponse(id, result);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (_e) {
          res.writeHead(400);
          res.end('{"ok":false}');
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise<BridgeHandle>((resolve) => {
    let settled = false;
    const settle = (handle: BridgeHandle) => {
      if (settled) return;
      settled = true;
      resolve(handle);
    };

    httpServer.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        process.stderr.write(
          `[bridge] Port ${port} already in use — plugin mode disabled in this process (REST mode still available)\n`
        );
        settle({
          ok: false,
          status: 'skipped_occupied',
          port,
          message: `端口 ${port} 已被占用：本进程跳过 Figma 桥（插件模式不可用；REST 模式不受影响）。`,
          close: async () => {}
        });
      } else {
        process.stderr.write(`[bridge] HTTP error: ${err.message}\n`);
        settle({
          ok: false,
          status: 'error',
          port: null,
          message: `Figma 桥启动失败：${err.message}`,
          close: async () => {}
        });
      }
    });

    // Loopback only: the bridge relays private design context and accepts
    // state-changing POSTs; it must never be reachable from the LAN.
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      process.stderr.write(`[bridge] Listening on http://${host}:${actualPort}\n`);
      settle({
        ok: true,
        status: 'listening',
        port: actualPort,
        message: `Figma 桥监听 http://${host}:${actualPort}`,
        close: () => closeServer(httpServer)
      });
    });
  });
}

function closeServer(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
  });
}
