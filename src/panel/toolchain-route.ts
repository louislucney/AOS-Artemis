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
  node: "Node.js",
  adb: "Android platform-tools / adb",
  jdk: "Temurin JDK",
  maestro: "Maestro CLI"
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
      "<p class=\"muted\">Node.js、adb、JDK、Maestro 均为中心托管的官方安装包；不会在 runner 上自动联网下载。</p>",
      cards,
      cCard({
        title: "安装顺序",
        body: [
          "<ol>",
          "<li>下载对应平台的 Node.js，解压后把 <code>bin</code>（Windows 为安装目录）加入 PATH。</li>",
          "<li>解压 Android platform-tools，把 <code>platform-tools</code> 加入 PATH，确认 <code>adb devices</code>。</li>",
          "<li>解压 JDK，把 <code>bin</code> 加入 PATH，确认 <code>java -version</code>。</li>",
          "<li>解压 Maestro，把 <code>maestro/bin</code> 加入 PATH，确认 <code>maestro --version</code>。</li>",
          "<li>再下载并解压对应平台的 runner 安装包。</li>",
          "</ol>",
          "<p class=\"muted\">macOS iOS 模拟器仍需 Xcode；Windows 的 Maestro 需要可用的 Java 环境，若 CLI 不支持原生 Windows，请在 WSL 中使用 Linux 工具链。</p>"
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
