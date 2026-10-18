import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "../artifacts/index.js";
import type { AuditEventRecord, CaseSetRecord } from "../db/types.js";
import { parseQuarantine } from "../figma/quarantine.js";
import { escapeHtml } from "../util.js";
import { cBadge, cCard, cTable } from "./components.js";
import { renderConsoleShell, type ConsoleCapabilities, type ConsoleShellInput } from "./shell.js";

export interface LibraryPageData {
  rootPath: string;
  rootLabel: string;
  sets: CaseSetRecord[];
  quarantine: { active: string[]; stale: number; invalid: number; exists: boolean };
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
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
  const actionsOff = data.capabilities?.actions === false;
  const disabledAttr = actionsOff ? " disabled" : "";
  const actionsReason = actionsOff
    ? '<p class="muted">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式。</p>'
    : "";
  const rows = data.sets.map((set) => [
    `<code>${escapeHtml(set.basename)}</code>`,
    escapeHtml(set.source),
    escapeHtml(set.createdAt),
    String(set.features.reduce((sum, feature) => sum + feature.caseCount, 0)),
    set.features.map((feature) => escapeHtml(feature.name)).join("、") || "—",
    `<a class="c-button" href="${escapeHtml(`/panel?project=${encodeURIComponent(data.rootPath)}&section=dispatch&source=case-set&ref=${encodeURIComponent(set.id)}`)}">下发该份</a>`
  ]);
  const quarantine = data.quarantine;
  const quarantineEntries =
    quarantine.active.length > 0
      ? `<ul>${quarantine.active
          .map(
            (id) =>
              `<li><code>${escapeHtml(id)}</code> <button class="c-button c-button-danger" type="button" data-quarantine="${escapeHtml(id)}"${disabledAttr}>移除</button></li>`
          )
          .join("")}</ul>`
      : `<p class="muted">${quarantine.exists ? "无隔离用例" : "尚无 quarantine.json（下方加入后生成）"}</p>`;
  const quarantineBody = [
    `<p>${cBadge({ label: `隔离中 ${quarantine.active.length}`, tone: quarantine.active.length > 0 ? "warning" : "success" })}` +
      ` ${cBadge({ label: `过期 ${quarantine.stale}`, tone: "neutral" })}` +
      ` ${cBadge({ label: `无效 ${quarantine.invalid}`, tone: quarantine.invalid > 0 ? "error" : "neutral" })}</p>`,
    quarantineEntries,
    `<form id="quarantine-form" data-project="${escapeHtml(data.rootPath)}"><p><label>用例 ID <input type="text" name="caseId" aria-label="用例 ID"${disabledAttr}></label> ` +
      `<label>签字 owner <input type="text" name="owner" aria-label="签字 owner"${disabledAttr}></label> ` +
      `<label>到期（可选 ISO） <input type="text" name="until" aria-label="到期时间（ISO）" size="22" placeholder="2026-12-31T00:00:00Z"${disabledAttr}></label> ` +
      `<button class="c-button" type="submit"${disabledAttr}>加入隔离</button> <span id="quarantine-status" role="status" class="muted"></span></p></form>`,
    actionsReason
  ].join("\n");
  const importBody = [
    `<form id="import-form" data-project="${escapeHtml(data.rootPath)}"><p><input type="file" name="file" accept=".xlsx" aria-label="Excel 文件"${disabledAttr}> ` +
      `<button class="c-button" type="submit"${disabledAttr}>上传导入</button> <span id="import-status" role="status" class="muted"></span></p>` +
      `<p class="muted">≤20MB、仅 .xlsx；导入后自动登记为最新份（需 HTTP 模式运行时；独立进程请用 CLI <code>suite task create --excel</code>）。</p></form>`,
    actionsReason
  ].join("\n");
  const script = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};function jsonPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}var qForm=document.getElementById('quarantine-form');var qStatus=document.getElementById('quarantine-status');if(qForm){qForm.addEventListener('submit',function(e){e.preventDefault();var f=new FormData(qForm);jsonPost('/panel/api/quarantine',{project:root,action:'add',caseId:(f.get('caseId')||'').trim(),owner:(f.get('owner')||'').trim(),until:(f.get('until')||'').trim()||undefined}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('已加入隔离 · 已写入审计');location.reload();}else{qStatus.textContent='加入失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){qStatus.textContent='加入失败：'+err;});});}document.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button[data-quarantine]'):null;if(!b)return;if(!confirm('确认移除该隔离条目？'))return;jsonPost('/panel/api/quarantine',{project:root,action:'remove',caseId:b.getAttribute('data-quarantine')}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('已移除隔离 · 已写入审计');location.reload();}else if(qStatus){qStatus.textContent='移除失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){if(qStatus)qStatus.textContent='移除失败：'+err;});});var iForm=document.getElementById('import-form');var iStatus=document.getElementById('import-status');if(iForm){iForm.addEventListener('submit',function(e){e.preventDefault();var fd=new FormData(iForm);if(!fd.get('file')||!(fd.get('file').name||'').toLowerCase().endsWith('.xlsx')){iStatus.textContent='请选择 .xlsx 文件';return;}iStatus.textContent='导入中…';fetch('/panel/api/import',{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('导入完成 · 已登记为最新份');location.reload();}else{iStatus.textContent='导入失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){iStatus.textContent='导入失败：'+err;});});}})();</script>`;
  return renderConsoleShell({
    title: "用例库",
    active: "library",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>用例库</h1>",
      cCard({
        title: "用例集（份）",
        subtitle: `共 ${data.sets.length} 份 · 来源与条数为登记口径`,
        body: cTable({
          columns: ["份", "来源", "登记时间", "用例数", "功能", "动作"],
          rows,
          caption: "用例集（份）列表",
          empty: "暂无用例集（下方导入或先生成）"
        }),
        actions: `<a class="c-button" href="/panel?project=${encodeURIComponent(data.rootPath)}&section=dispatch">按份下发</a>`
      }),
      cCard({ title: "导入 Excel（用例文档）", body: importBody }),
      cCard({ title: "隔离（quarantine）", body: quarantineBody }),
      script
    ].join("\n")
  });
}

export interface ArchivePageData {
  rootPath: string;
  rootLabel: string;
  artifacts: ArtifactRecord[];
  query: Record<string, string>;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderArchivePage(data: ArchivePageData): string {
  const rows = data.artifacts.map((record) => {
    const isDir = record.meta?.type === "dir";
    const location = isDir
      ? `<code>${escapeHtml(record.path)}</code>`
      : `<a href="${escapeHtml(`/panel/artifact?project=${encodeURIComponent(data.rootPath)}&path=${encodeURIComponent(record.path)}`)}"><code>${escapeHtml(record.path)}</code></a>`;
    return [
      cBadge({ label: record.kind, tone: "neutral" }),
      `<code>${escapeHtml(record.title)}</code>`,
      location,
      escapeHtml(record.at),
      isDir ? "目录" : `${record.size} B`
    ];
  });
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  return renderConsoleShell({
    title: "档案与产物",
    active: "archive",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    storeHealth: data.storeHealth,
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
          caption: "产物索引",
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
  page: { offset: number; hasNext: boolean; pageSize: number };
  storeHealth?: ConsoleShellInput["storeHealth"];
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
  const link = (patch: Record<string, string | null>): string => {
    const params = new URLSearchParams({ project: data.rootPath, section: "audit" });
    for (const key of ["domain", "result", "since"]) {
      const value = data.query[key];
      if (value !== undefined && value !== "") params.set(key, value);
    }
    params.set("offset", String(data.page.offset));
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    return escapeHtml(`/panel?${params.toString()}`);
  };
  const prevHref = data.page.offset > 0 ? link({ offset: String(Math.max(0, data.page.offset - data.page.pageSize)) }) : null;
  const nextHref = data.page.hasNext ? link({ offset: String(data.page.offset + data.page.pageSize) }) : null;
  const preset = (label: string, hours: number): string =>
    `<a class="c-button" href="${link({ since: new Date(Date.now() - hours * 3600_000).toISOString(), offset: "0" })}">${label}</a>`;
  return renderConsoleShell({
    title: "审计",
    active: "audit",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    storeHealth: data.storeHealth,
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
          `<p>时间预设：${preset("近 24 小时", 24)} ${preset("近 7 天", 168)} ${preset("近 30 天", 720)} ${data.query.since !== undefined && data.query.since !== "" ? `<a class="c-button" href="${link({ since: null, offset: "0" })}">清除</a>` : ""}</p>`,
          "</form>"
        ].join("\n")
      }),
      cCard({
        title: "事件流",
        subtitle: `第 ${Math.floor(data.page.offset / data.page.pageSize) + 1} 页 · 本页 ${data.events.length} 条（新→旧）· 保留期 90 天 / 5 万条（AOS_AUDIT_*）`,
        body: [
          cTable({
            columns: ["时间", "域", "动作", "结果", "摘要"],
            rows,
            caption: "审计事件",
            empty: "暂无审计事件（内部编排动作发生后出现）"
          }),
          `<div class="pager">${prevHref === null ? "" : `<a href="${prevHref}">← 上一页</a>`}${prevHref !== null && nextHref !== null ? " · " : ""}${nextHref === null ? "" : `<a href="${nextHref}">下一页 →</a>`}</div>`
        ].join("\n")
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
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderOpsPage(data: OpsPageData): string {
  const actionsOff = data.capabilities?.actions === false;
  const exportLink = (what: string, format: string, label: string): string => {
    const href = escapeHtml(
      `/panel/api/export?project=${encodeURIComponent(data.rootPath)}&what=${what}&format=${format}`
    );
    return actionsOff
      ? `<span class="c-button c-nav-item-disabled" aria-disabled="true" title="写动作未启用">${label}</span>`
      : `<a class="c-button" href="${href}">${label}</a>`;
  };
  return renderConsoleShell({
    title: "运维与数据",
    active: "ops",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
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
