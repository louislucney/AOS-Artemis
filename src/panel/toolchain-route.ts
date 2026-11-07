import fs from "node:fs";
import path from "node:path";

import { cCard, cTable } from "../console/components.js";
import { renderConsoleShell } from "../console/shell.js";
import { escapeHtml } from "../util.js";
import { formatBytes } from "../figma/retention.js";

interface ToolchainEntry {
  platform: string;
  tool: string;
  name: string;
  filename: string;
  size: number;
  sha256: string;
  sourceUrl: string;
  downloadUrl: string;
}

export interface ToolchainResponse {
  status: number;
  contentType: string;
  body?: string;
  streamPath?: string;
  extraHeaders?: Record<string, string>;
}

const PLATFORM_LABEL: Record<string, string> = {
  "darwin-arm64": "macOS Apple Silicon",
  "win32-x64": "Windows x64"
};
const TOOL_LABEL: Record<string, string> = {
  adb: "Android platform-tools / adb"
};

function loadManifest(dir: string): ToolchainEntry[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      entries?: unknown;
    };
    if (!Array.isArray(parsed.entries)) return null;
    return parsed.entries.filter((entry): entry is ToolchainEntry => {
      if (typeof entry !== "object" || entry === null) return false;
      const value = entry as Partial<ToolchainEntry>;
      return (
        typeof value.platform === "string" &&
        typeof value.tool === "string" &&
        typeof value.name === "string" &&
        typeof value.filename === "string" &&
        typeof value.size === "number" &&
        typeof value.sha256 === "string" &&
        value.tool === "adb" &&
        path.basename(value.filename) === value.filename
      );
    });
  } catch {
    return null;
  }
}

function renderPage(entries: ToolchainEntry[]): string {
  const platforms = [...new Set(entries.map((entry) => entry.platform))];
  const cards = platforms
    .map((platform) => {
      const rows = entries
        .filter((entry) => entry.platform === platform)
        .map((entry) => [
          `<strong>${escapeHtml(TOOL_LABEL[entry.tool] ?? entry.name)}</strong>`,
          escapeHtml(entry.filename),
          formatBytes(entry.size),
          `<code title="${escapeHtml(entry.sha256)}">${escapeHtml(entry.sha256.slice(0, 12))}…</code>`,
          `<a class="c-button" href="${escapeHtml(entry.downloadUrl)}" download>下载</a>`
        ]);
      return cCard({
        title: PLATFORM_LABEL[platform] ?? platform,
        subtitle: "官方安装包由中心镜像，下载需要面板鉴权。",
        body: cTable({
          columns: ["工具", "文件", "大小", "SHA-256", ""],
          rows
        })
      });
    })
    .join("\n");
  return renderConsoleShell({
    title: "执行机依赖",
    active: "devices",
    body: [
      "<h1>执行机依赖</h1>",
      "<p class=\"muted\">这里只镜像 adb（platform-tools）。MCP runner 双端包（Windows Android / macOS iOS+Android）请到「设备 → 接入执行机」下载。</p>",
      cards,
      cCard({
        title: "安装顺序",
        body: [
          "<ol>",
          "<li>下载对应平台的 Android platform-tools，解压后把 <code>platform-tools</code> 加入 PATH，确认 <code>adb devices</code>。</li>",
          "<li>运行 <code>adb -a -P 5037 server nodaemon</code>，防火墙只放行 MCP 服务 IP（或改用 SSH 隧道）。</li>",
          "<li>在 MCP 项目配置 <code>ADB_SERVER_SOCKET=tcp:&lt;宿主IP&gt;:5037</code>，用 <code>run_regression</code> / <code>mobile_run_task</code> 执行。</li>",
          "</ol>",
          "<p class=\"muted\">也可以直接下载面板「设备 → 接入执行机」的 Windows adb-host 小包（约 8MB）。macOS 本机可直接使用系统 adb。</p>"
        ].join("")
      })
    ].join("\n")
  });
}

export async function handleRunnerToolchainRequest(
  url: URL,
  dir: string,
  accept: string | null
): Promise<ToolchainResponse> {
  const entries = loadManifest(dir);
  if (entries === null || entries.length === 0) {
    return {
      status: 404,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        ok: false,
        error: "runner toolchain 尚未构建：请在中心运行 npm run toolchain:fetch"
      })
    };
  }
  const file = (url.searchParams.get("file") ?? "").trim();
  if (file !== "") {
    const entry = entries.find((candidate) => candidate.filename === file);
    if (entry === undefined) {
      return { status: 404, contentType: "application/json", body: '{"ok":false,"error":"unknown file"}' };
    }
    const streamPath = path.join(dir, "files", entry.filename);
    if (!fs.existsSync(streamPath)) {
      return { status: 404, contentType: "application/json", body: '{"ok":false,"error":"file missing"}' };
    }
    return {
      status: 200,
      contentType: entry.filename.endsWith(".zip") ? "application/zip" : "application/gzip",
      streamPath,
      extraHeaders: {
        "Content-Length": String(fs.statSync(streamPath).size),
        "Content-Disposition": `attachment; filename="${entry.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    };
  }
  if ((accept ?? "").includes("text/html")) {
    return { status: 200, contentType: "text/html; charset=utf-8", body: renderPage(entries) };
  }
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ ok: true, entries }, null, 2)
  };
}
