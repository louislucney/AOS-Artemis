import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "../artifacts/index.js";
import type { AuditEventRecord, CaseSetRecord } from "../db/types.js";
import { parseQuarantine } from "../figma/quarantine.js";
import { escapeHtml } from "../util.js";
import { cBadge, cCard, cTable } from "./components.js";
import { renderConsoleShell, type ConsoleCapabilities } from "./shell.js";

export interface LibraryPageData {
  rootPath: string;
  rootLabel: string;
  sets: CaseSetRecord[];
  quarantine: { active: string[]; stale: number; invalid: number; exists: boolean };
}

export function readQuarantineSummary(rootPath: string): Promise<LibraryPageData["quarantine"]> {
  const file = path.join(rootPath, ".artemis", "design", "quarantine.json");
  return readFile(file, "utf-8")
    .then((raw) => {
      const parsed = parseQuarantine(raw, new Date());
      return {
        active: [...parsed.active.keys()],
        stale: parsed.stale.length,
        invalid: parsed.invalid.length,
        exists: true
      };
    })
    .catch(() => ({ active: [], stale: 0, invalid: 0, exists: false }));
}

export function renderLibraryPage(data: LibraryPageData): string {
  const rows = data.sets.map((set) => [
    `<code>${escapeHtml(set.basename)}</code>`,
    escapeHtml(set.source),
    escapeHtml(set.createdAt),
    String(set.features.reduce((sum, feature) => sum + feature.caseCount, 0)),
    set.features.map((feature) => escapeHtml(feature.name)).join("、") || "—"
  ]);
  const quarantine = data.quarantine;
  const quarantineBody = [
    `<p>${cBadge({ label: `隔离中 ${quarantine.active.length}`, tone: quarantine.active.length > 0 ? "warning" : "success" })}` +
      ` ${cBadge({ label: `过期 ${quarantine.stale}`, tone: "neutral" })}` +
      ` ${cBadge({ label: `无效 ${quarantine.invalid}`, tone: quarantine.invalid > 0 ? "error" : "neutral" })}</p>`,
    quarantine.active.length > 0
      ? `<p>${quarantine.active.map((id) => `<code>${escapeHtml(id)}</code>`).join(" ")}</p>`
      : `<p class="muted">${quarantine.exists ? "无隔离用例" : "尚无 quarantine.json（动作层 add 后生成）"}</p>`
  ].join("\n");
  return renderConsoleShell({
    title: "用例库",
    active: "library",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    body: [
      "<h1>用例库</h1>",
      cCard({
        title: "用例集（份）",
        subtitle: `共 ${data.sets.length} 份 · 来源与条数为登记口径`,
        body: cTable({
          columns: ["份", "来源", "登记时间", "用例数", "功能"],
          rows,
          empty: "暂无用例集（先生成或导入）"
        }),
        actions: `<a class="c-button" href="/panel?project=${encodeURIComponent(data.rootPath)}&section=dispatch">按份下发</a>`
      }),
      cCard({ title: "隔离（quarantine）", body: quarantineBody })
    ].join("\n")
  });
}

export interface ArchivePageData {
  rootPath: string;
  rootLabel: string;
  artifacts: ArtifactRecord[];
  query: Record<string, string>;
}

export function renderArchivePage(data: ArchivePageData): string {
  const rows = data.artifacts.map((record) => [
    cBadge({ label: record.kind, tone: "neutral" }),
    `<code>${escapeHtml(record.title)}</code>`,
    escapeHtml(record.path),
    escapeHtml(record.at),
    record.size === 0 && record.meta?.type === "dir" ? "目录" : `${record.size} B`
  ]);
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  return renderConsoleShell({
    title: "档案与产物",
    active: "archive",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    body: [
      "<h1>档案与产物</h1>",
      cCard({
        title: "筛选",
        body: [
          `<form method="get" action="/panel">`,
          `<input type="hidden" name="project" value="${escapeHtml(data.rootPath)}">`,
          `<input type="hidden" name="section" value="archive">`,
          `<p>类型 <select name="kind" aria-label="产物类型"><option value="">全部</option>${["run", "case-set", "report", "diff", "crash", "trace"]
            .map(
              (kind) =>
                `<option value="${kind}"${data.query.kind === kind ? " selected" : ""}>${kind}</option>`
            )
            .join("")}</select> 关键词 <input type="text" name="q" aria-label="产物关键词" value="${q("q")}" placeholder="文件名/路径"> <button class="c-button" type="submit">筛选</button></p>`,
          "</form>"
        ].join("\n")
      }),
      cCard({
        title: "产物索引",
        subtitle: `共 ${data.artifacts.length} 项 · 与保留期同源（六族浅扫）`,
        body: cTable({
          columns: ["类型", "名称", "路径", "时间", "大小"],
          rows,
          empty: "暂无产物（产物落盘后自动出现）"
        })
      })
    ].join("\n")
  });
}

export interface AuditPageData {
  rootPath: string;
  rootLabel: string;
  events: AuditEventRecord[];
  query: Record<string, string>;
}

export function renderAuditPage(data: AuditPageData): string {
  const rows = data.events.map((event) => [
    escapeHtml(event.at),
    escapeHtml(event.domain),
    escapeHtml(event.action),
    cBadge({
      label: event.result,
      tone: event.result === "ok" ? "success" : event.result === "failed" ? "error" : "warning"
    }),
    escapeHtml(event.summary)
  ]);
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  return renderConsoleShell({
    title: "审计",
    active: "audit",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    body: [
      "<h1>审计</h1>",
      cCard({
        title: "筛选",
        body: [
          `<form method="get" action="/panel">`,
          `<input type="hidden" name="project" value="${escapeHtml(data.rootPath)}">`,
          `<input type="hidden" name="section" value="audit">`,
          `<p>域 <input type="text" name="domain" aria-label="事件域" value="${q("domain")}" size="12"> 结果 <select name="result" aria-label="结果"><option value="">全部</option>${["ok", "skipped", "failed"]
            .map(
              (result) =>
                `<option value="${result}"${data.query.result === result ? " selected" : ""}>${result}</option>`
            )
            .join("")}</select> 起自 <input type="text" name="since" aria-label="起始时间（ISO）" value="${q("since")}" size="20" placeholder="ISO 时间"> <button class="c-button" type="submit">筛选</button></p>`,
          "</form>"
        ].join("\n")
      }),
      cCard({
        title: "事件流",
        subtitle: `共 ${data.events.length} 条（新→旧，上限 200）· 保留期 90 天 / 5 万条（AOS_AUDIT_*）`,
        body: cTable({
          columns: ["时间", "域", "动作", "结果", "摘要"],
          rows,
          empty: "暂无审计事件（内部编排动作发生后出现）"
        })
      })
    ].join("\n")
  });
}

export interface OpsPageData {
  rootPath: string;
  rootLabel: string;
  storeKind: string;
  storeNote: string | null;
  storeLabel: string;
  writeError: string | null;
  artifacts: number;
  capabilities?: ConsoleCapabilities;
}

export function renderOpsPage(data: OpsPageData): string {
  const actionsOff = data.capabilities?.actions === false;
  const exportLink = (what: string, format: string, label: string): string =>
    actionsOff
      ? `<span class="c-button c-nav-item-disabled" aria-disabled="true" title="写动作未启用">${label}</span>`
      : `<a class="c-button" href="/panel/api/export?project=${encodeURIComponent(data.rootPath)}&what=${what}&format=${format}">${label}</a>`;
  return renderConsoleShell({
    title: "运维与数据",
    active: "ops",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    capabilities: data.capabilities,
    body: [
      "<h1>运维与数据</h1>",
      cCard({
        title: "存储",
        body: [
          `<p>${cBadge({ label: data.storeLabel, tone: data.storeKind === "memory" ? "warning" : data.storeKind === "file" ? "neutral" : "success" })}</p>`,
          data.storeNote ? `<p class="muted">${escapeHtml(data.storeNote)}</p>` : "",
          data.writeError ? `<p>${cBadge({ label: "写失败", tone: "error" })} ${escapeHtml(data.writeError)}</p>` : ""
        ].join("\n")
      }),
      cCard({
        title: "保留与产物",
        subtitle: `产物索引 ${data.artifacts} 项 · 保留策略由 suite retention 只读报告`,
        body: `<p><code>node dist/cli.js suite retention</code>（只读，不删除）</p>`
      }),
      cCard({
        title: "导出（测试结果 / 过程 / 数据）",
        body: [
          `<p>${exportLink("results", "json", "结果 JSON")} ${exportLink("results", "csv", "结果 CSV")}`,
          ` ${exportLink("process", "json", "过程 JSON")} ${exportLink("data", "json", "数据 JSON")}</p>`,
          `<p class="muted">等价 CLI：<code>node dist/cli.js export --what results|process|data</code></p>`
        ].join("\n")
      })
    ].join("\n")
  });
}
