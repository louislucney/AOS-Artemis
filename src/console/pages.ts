import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "../artifacts/index.js";
import type {
  AuditEventRecord,
  CaseSetRecord,
  ExcelMappingRecord,
  ProjectEventRecord,
  WebAssetRecord
} from "../db/types.js";
import { parseQuarantine } from "../figma/quarantine.js";
import { formatBytes } from "../figma/retention.js";
import { escapeHtml } from "../util.js";
import { cBadge, cCard, cEmpty, cTable } from "./components.js";
import { relativeTime } from "./time.js";
import {
  artifactKindLabel,
  auditActionHtml,
  auditDomainHtml,
  runStatusLabel,
  sourceHtml,
  AUDIT_DOMAIN_KEYS
} from "./vocab.js";
import { renderConsoleShell, renderGroupTabs, type ConsoleCapabilities, type ConsoleShellInput } from "./shell.js";
import { CANONICAL_FIELD_LABELS, CANONICAL_FIELDS } from "../web/excel-columns.js";

export interface LibraryPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  sets: CaseSetRecord[];
  quarantine: { active: string[]; stale: number; invalid: number; exists: boolean };
  /** 最近失败用例候选（隔离点选；去重取最近）。 */
  caseCandidates: Array<{ caseId: string; name: string; runId: string; at: string | null }>;
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
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const actionsOff =
    data.capabilities?.actions === false || data.capabilities?.scopes?.library === false;
  const disabledAttr = actionsOff ? " disabled" : "";
  const actionsReason = actionsOff
    ? '<p class="muted">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式。</p>'
    : "";
  const rows = data.sets.map((set, index) => {
    const excel = set.features
      .map((feature) => {
        const rel = path.relative(data.rootPath, feature.xlsxPath);
        const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
        const label = escapeHtml(path.basename(feature.xlsxPath));
        if (!inside) return label;
        const href = `/panel/artifact?project=${encodeURIComponent(data.rootPath)}&path=${encodeURIComponent(rel)}${hostQuery}`;
        return `<a href="${escapeHtml(href)}" title="打开/下载 Excel">${label}</a>`;
      })
      .join("<br>");
    return [
      `<code>${escapeHtml(set.basename)}</code>${index === 0 ? ` ${cBadge({ label: "最新", tone: "success" })}` : ""}`,
      excel || "—",
      sourceHtml(set.source),
      relativeTime(set.createdAt),
      String(set.features.reduce((sum, feature) => sum + feature.caseCount, 0)),
      set.features.map((feature) => escapeHtml(feature.name)).join("、") || "—",
      `<a class="c-button" href="${escapeHtml(`/panel?project=${encodeURIComponent(data.rootPath)}&section=dispatch&source=case-set&ref=${encodeURIComponent(set.id)}${hostQuery}`)}">下发该用例集</a>`
    ];
  });
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
  const caseCandidateOptions =
    data.caseCandidates.length === 0
      ? ""
      : `<datalist id="quarantine-case-options">${data.caseCandidates
          .map(
            (candidate) =>
              `<option value="${escapeHtml(candidate.caseId)}">${escapeHtml(candidate.name)}${
                candidate.at === null ? "" : `（最近失败 ${escapeHtml(candidate.at.slice(0, 10))}）`
              }</option>`
          )
          .join("")}</datalist>`;
  const quarantineBody = [
    `<p>${cBadge({ label: `隔离中 ${quarantine.active.length}`, tone: quarantine.active.length > 0 ? "warning" : "success" })}` +
      ` ${cBadge({ label: `过期 ${quarantine.stale}`, tone: "neutral" })}` +
      ` ${cBadge({ label: `无效 ${quarantine.invalid}`, tone: quarantine.invalid > 0 ? "error" : "neutral" })}</p>`,
    quarantineEntries,
    `<form id="quarantine-form" data-project="${escapeHtml(data.rootPath)}"><p><label>用例 ID <input list="quarantine-case-options" name="caseId" placeholder="输入或从最近失败用例选择" aria-label="用例 ID（可搜索最近失败用例）"${disabledAttr}></label>` +
      caseCandidateOptions +
      ` <label>签字人 <input type="text" name="owner" aria-label="签字人（owner）"${disabledAttr}></label> ` +
      `<label>到期日期（可选） <input type="date" name="until" aria-label="到期日期（可选）"${disabledAttr}></label> ` +
      `<button class="c-button" type="submit"${disabledAttr}>加入隔离</button> <span id="quarantine-status" role="status" class="muted"></span></p></form>`,
    actionsReason
  ].join("\n");
  const importBody = [
    `<form id="import-form" data-project="${escapeHtml(data.rootPath)}"><p><input type="file" name="file" accept=".xlsx" aria-label="Excel 文件"${disabledAttr}> ` +
      `<button class="c-button" type="submit"${disabledAttr}>上传导入</button> <span id="import-status" role="status" class="muted"></span></p>` +
      `<p class="muted">≤20MB、仅 .xlsx；导入后自动登记为最新用例集（需 HTTP 模式运行时；独立进程请用 CLI <code>suite task create --excel</code>）。</p></form>`,
    actionsReason
  ].join("\n");
  const script = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var hostId=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};function jsonPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}var qForm=document.getElementById('quarantine-form');var qStatus=document.getElementById('quarantine-status');if(qForm){qForm.addEventListener('submit',function(e){e.preventDefault();var f=new FormData(qForm);jsonPost('/panel/api/quarantine',{project:root,host:hostId,action:'add',caseId:(f.get('caseId')||'').trim(),owner:(f.get('owner')||'').trim(),until:(f.get('until')||'').trim()||undefined}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('已加入隔离 · 已写入审计');location.reload();}else{qStatus.textContent='加入失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){qStatus.textContent='加入失败：'+err;});});}document.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button[data-quarantine]'):null;if(!b)return;var quarantineRemove=function(){jsonPost('/panel/api/quarantine',{project:root,host:hostId,action:'remove',caseId:b.getAttribute('data-quarantine')}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('已移除隔离 · 已写入审计');location.reload();}else if(qStatus){qStatus.textContent='移除失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){if(qStatus)qStatus.textContent='移除失败：'+err;});};window.aosInlineConfirm(b,'确认移除该隔离条目？',quarantineRemove);});var iForm=document.getElementById('import-form');var iStatus=document.getElementById('import-status');if(iForm){iForm.addEventListener('submit',function(e){e.preventDefault();var fd=new FormData(iForm);if(hostId)fd.append('host',hostId);if(!fd.get('file')||!(fd.get('file').name||'').toLowerCase().endsWith('.xlsx')){iStatus.textContent='请选择 .xlsx 文件';return;}iStatus.textContent='导入中…';fetch('/panel/api/import?project='+encodeURIComponent(root)+(hostId?'&host='+encodeURIComponent(hostId):''),{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('导入完成 · 已登记为最新用例集');location.reload();}else{iStatus.textContent='导入失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){iStatus.textContent='导入失败：'+err;});});}})();</script>`;
  return renderConsoleShell({
    title: "用例库",
    active: "library",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>用例库</h1>",
      cCard({
        title: "用例集",
        subtitle: `共 ${data.sets.length} 份用例集 · 每份可打开 Excel（tests.xlsx）`,
        body: cTable({
          columns: ["用例集", "Excel 文件", "设计来源", "登记时间", "用例数", "功能", "动作"],
          rows,
          caption: "用例集列表",
          empty: "暂无用例集（下方导入或先生成）"
        }),
        actions: `<a class="c-button" href="${escapeHtml(`/panel?project=${encodeURIComponent(data.rootPath)}&section=dispatch${hostQuery}`)}">按用例集下发</a>`
      }),
      cCard({ title: "导入 Excel（用例文档）", body: importBody }),
      cCard({ title: "隔离（quarantine）", body: quarantineBody }),
      script
    ].join("\n")
  });
}

export interface WebAssetsPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  assets: WebAssetRecord[];
  mappings: ExcelMappingRecord[];
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

function excelFieldLabel(field: string): string {
  return (CANONICAL_FIELD_LABELS as Record<string, string>)[field] ?? field;
}

function mappingSummary(columnMap: Record<string, string>): string {
  const entries = Object.entries(columnMap).filter(
    ([, header]) => typeof header === "string" && header.trim() !== ""
  );
  if (entries.length === 0) return '<span class="muted">—</span>';
  return entries
    .map(
      ([field, header]) =>
        `${escapeHtml(excelFieldLabel(field))}→${escapeHtml(header)}`
    )
    .join("<br>");
}

/** 测试资产（Excel 原件版本 + 列映射）：上传/预览/保存均走面板动作 API；
 * 写动作按 capabilities.actions 与角色（maintainer/admin）收口，UI 只做可达性提示。 */
export function renderWebAssetsPage(data: WebAssetsPageData): string {
  const role = data.capabilities?.role;
  const roleAllowed = role === undefined || role === "maintainer" || role === "admin";
  const actionsOff = data.capabilities?.actions === false || !roleAllowed;
  const disabledAttr = actionsOff ? " disabled" : "";
  const actionsReason = actionsOff
    ? `<p class="muted">${
        roleAllowed
          ? "写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式。"
          : `写动作需要 maintainer/admin（当前角色 ${escapeHtml(role ?? "未知")}）。`
      }</p>`
    : "";

  const assetName = new Map<string, string>();
  for (const asset of data.assets) {
    assetName.set(asset.id, `${asset.filename} v${asset.version}`);
  }
  const assetRows = data.assets.map((asset) => [
    `<code>${escapeHtml(asset.filename)}</code>`,
    `<code>v${asset.version}</code>`,
    formatBytes(asset.size),
    `<code>${escapeHtml(asset.sha256.slice(0, 12))}</code>`,
    relativeTime(asset.createdAt)
  ]);
  const assetOptions = data.assets
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.id)}">v${asset.version} · ${escapeHtml(asset.filename)}（${formatBytes(asset.size)}）</option>`
    )
    .join("");
  const mappingRows = data.mappings.map((mapping) => [
    `<code>${escapeHtml(
      (assetName.get(mapping.assetId) ?? mapping.assetId).slice(0, 60)
    )}</code>`,
    `<code>${escapeHtml(mapping.sheetName)}</code>`,
    mappingSummary(mapping.columnMap),
    `<code>${escapeHtml(mapping.headerFingerprint.slice(0, 12))}</code>`,
    mapping.createdBy === null ? '<span class="muted">—</span>' : escapeHtml(mapping.createdBy),
    relativeTime(mapping.createdAt)
  ]);

  const uploadBody = [
    `<form id="asset-upload-form" data-project="${escapeHtml(data.rootPath)}"><p><input id="asset-file" type="file" name="file" accept=".xlsx" aria-label="Excel 文件"${disabledAttr}> ` +
      `<button id="asset-upload-submit" class="c-button" type="submit"${disabledAttr}>上传 Excel</button> <span id="asset-upload-status" role="status" class="muted"></span></p>` +
      `<p class="muted">≤20MB、仅 .xlsx；上传后登记新版本（同内容复用文件）。</p></form>`,
    actionsReason
  ].join("\n");

  const mappingBody = [
    `<form id="mapping-preview-form" data-project="${escapeHtml(data.rootPath)}"><p><label>资产 <select id="asset-select" name="assetId" aria-label="Excel 资产"${disabledAttr}>` +
      (assetOptions === ""
        ? '<option value="">暂无可映射资产</option>'
        : assetOptions) +
      `</select></label> <label>表头行 <input id="asset-header-row" type="number" min="1" step="1" name="headerRow" value="1" aria-label="表头行"${disabledAttr}></label> ` +
      `<button id="mapping-preview-submit" class="c-button" type="submit"${disabledAttr}>预览映射</button> ` +
      `<button id="mapping-save" class="c-button c-button-primary" type="button"${disabledAttr}>保存映射</button> ` +
      `<span id="mapping-status" role="status" class="muted"></span></p></form>`,
    `<div id="mapping-preview"><p class="muted">选择资产并预览表头后，可确认建议映射并保存。</p></div>`,
    actionsReason
  ].join("\n");

  const fieldsJson = JSON.stringify(
    CANONICAL_FIELDS.map((field) => ({ field, label: CANONICAL_FIELD_LABELS[field] }))
  ).replace(/</g, "\\u003c");
  const script = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var host=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};var fields=${fieldsJson};function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}function jsonPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}var preview=null;var saveBtn=document.getElementById('mapping-save');if(saveBtn)saveBtn.disabled=true;var uForm=document.getElementById('asset-upload-form');var uStatus=document.getElementById('asset-upload-status');if(uForm){uForm.addEventListener('submit',function(e){e.preventDefault();var input=document.getElementById('asset-file');var file=input&&input.files?input.files[0]:null;if(!file){if(uStatus)uStatus.textContent='请选择 .xlsx 文件';return;}if(!/\\.xlsx$/i.test(file.name)){if(uStatus)uStatus.textContent='仅支持 .xlsx 文件';return;}var fd=new FormData();fd.append('project',root);fd.append('kind','excel');if(host)fd.append('host',host);fd.append('file',file);if(uStatus)uStatus.textContent='上传中…';fetch('/panel/api/projects/assets',{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已上传 '+res.j.asset.filename+'（v'+res.j.asset.version+'） · 已写入审计');location.reload();}else if(uStatus){uStatus.textContent='上传失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){if(uStatus)uStatus.textContent='上传失败：'+err;});});}var pForm=document.getElementById('mapping-preview-form');var sel=document.getElementById('asset-select');var pStatus=document.getElementById('mapping-status');var previewBox=document.getElementById('mapping-preview');if(pForm){pForm.addEventListener('submit',function(e){e.preventDefault();if(!sel||!sel.value){if(pStatus)pStatus.textContent='请选择资产';return;}var rowInput=document.getElementById('asset-header-row');var headerRow=parseInt(rowInput&&rowInput.value?rowInput.value:'1',10);if(!headerRow||headerRow<1)headerRow=1;preview=null;if(saveBtn)saveBtn.disabled=true;if(pStatus)pStatus.textContent='读取中…';jsonPost('/panel/api/projects/excel/preview',{project:root,host:host,assetId:sel.value,headerRow:headerRow}).then(function(res){if(!res.ok||!res.j||!res.j.ok){if(pStatus)pStatus.textContent='预览失败：'+((res.j&&res.j.error)||('HTTP '+res.status));return;}var j=res.j;var suggested=j.suggested||{};preview={assetId:sel.value,sheetName:j.sheetName,headerRow:headerRow,columnMap:suggested};var rows=fields.map(function(f){var header=suggested[f.field]||'';return '<tr><td>'+esc(f.label)+'</td><td>'+(header?'<code>'+esc(header)+'</code>':'<span class="muted">—</span>')+'</td></tr>';});if(previewBox)previewBox.innerHTML='<div class="c-table-wrap"><table class="c-table"><caption>映射预览</caption><thead><tr><th scope="col">规范字段</th><th scope="col">建议表头</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div><p class="muted">工作表 '+esc(j.sheetName)+' · 表头行 '+headerRow+' · 指纹 <code>'+esc(String(j.fingerprint||'').slice(0,12))+'</code></p>';if(pStatus)pStatus.textContent='预览完成，可保存';if(saveBtn)saveBtn.disabled=false;}).catch(function(err){if(pStatus)pStatus.textContent='预览失败：'+err;});});}if(saveBtn){saveBtn.addEventListener('click',function(){if(!preview){if(pStatus)pStatus.textContent='请先预览映射';return;}if(pStatus)pStatus.textContent='保存中…';jsonPost('/panel/api/projects/excel/mapping',{project:root,host:host,assetId:preview.assetId,sheetName:preview.sheetName,headerRow:preview.headerRow,columnMap:preview.columnMap}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已保存列映射 · 已写入审计');location.reload();}else if(pStatus){pStatus.textContent='保存失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){if(pStatus)pStatus.textContent='保存失败：'+err;});});}})();</script>`;

  return renderConsoleShell({
    title: "测试资产",
    active: "library",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>测试资产</h1>",
      `<p class="muted">Excel 原件按内容寻址保存；版本行只追加，解析结果由「用例库」侧引用。映射保存后按表头指纹复用。</p>`,
      cCard({
        title: "资产版本",
        subtitle: `共 ${data.assets.length} 个 Excel 版本`,
        body: cTable({
          columns: ["文件名", "版本", "大小", "sha256", "上传时间"],
          rows: assetRows,
          caption: "Excel 资产版本",
          empty: "暂无 Excel 资产（下方上传）"
        })
      }),
      cCard({ title: "上传 Excel", body: uploadBody }),
      cCard({
        title: "列映射",
        subtitle: "预览表头并保存规范字段映射（同指纹复用，不重复登记）",
        body: mappingBody
      }),
      cCard({
        title: "已保存映射",
        subtitle: `共 ${data.mappings.length} 条`,
        body: cTable({
          columns: ["资产", "工作表", "已映射字段", "指纹", "保存人", "保存时间"],
          rows: mappingRows,
          caption: "Excel 列映射",
          empty: "暂无已保存映射（预览后保存生成）"
        })
      }),
      script
    ].join("\n")
  });
}

function sinceLocalValue(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export interface ArchivePageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  artifacts: ArtifactRecord[];
  query: Record<string, string>;
  page: { offset: number; hasNext: boolean; pageSize: number };
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderArchivePage(data: ArchivePageData): string {
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const artifactUrl = (record: ArtifactRecord): string =>
    `/panel/artifact?project=${encodeURIComponent(data.rootPath)}&path=${encodeURIComponent(record.path)}${hostQuery}`;
  const rows = data.artifacts.map((record) => {
    const isDir = record.meta?.type === "dir";
    const isImage = !isDir && /\.(png|jpe?g|webp|gif)$/i.test(record.title);
    const thumb = isImage
      ? `<img class="c-thumb" src="${escapeHtml(artifactUrl(record))}" alt="" loading="lazy">`
      : "";
    const location = isDir
      ? `<code>${escapeHtml(record.path)}</code>`
      : `<a href="${escapeHtml(artifactUrl(record))}" target="_blank" rel="noreferrer"><code>${escapeHtml(record.path)}</code></a>`;
    return [
      cBadge({ label: artifactKindLabel(record.kind), tone: "neutral", title: record.kind }),
      `${thumb}<code>${escapeHtml(record.title)}</code>`,
      location,
      relativeTime(record.at),
      isDir ? "目录" : `${record.size} B`
    ];
  });
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  const archiveLink = (patch: Record<string, string | null>): string => {
    const params = new URLSearchParams({ project: data.rootPath, section: "archive" });
    if (data.hostId) params.set("host", data.hostId);
    for (const key of ["kind", "q", "since"]) {
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
  const prevHref =
    data.page.offset > 0
      ? archiveLink({ offset: String(Math.max(0, data.page.offset - data.page.pageSize)) })
      : null;
  const nextHref = data.page.hasNext
    ? archiveLink({ offset: String(data.page.offset + data.page.pageSize) })
    : null;
  const pager = `<div class="pager">${
    prevHref === null
      ? '<span class="muted">上一页</span>'
      : `<a class="c-button" href="${prevHref}">上一页</a>`
  } <span class="muted">第 ${
    Math.floor(data.page.offset / data.page.pageSize) + 1
  } 页 · 本页 ${data.artifacts.length} 项</span> ${
    nextHref === null
      ? '<span class="muted">下一页</span>'
      : `<a class="c-button" href="${nextHref}">下一页</a>`
  }</div>`;
  const preset = (label: string, hours: number): string =>
    `<a class="c-button" href="${archiveLink({ since: new Date(Date.now() - hours * 3600_000).toISOString() })}">${label}</a>`;
  const csvParams = new URLSearchParams({ project: data.rootPath, format: "csv" });
  if (data.hostId) csvParams.set("host", data.hostId);
  for (const key of ["kind", "q", "since"]) {
    const value = data.query[key];
    if (value !== undefined && value !== "") csvParams.set(key, value);
  }
  const csvHref = escapeHtml(`/panel/artifact?${csvParams.toString()}`);
  return renderConsoleShell({
    title: "档案与产物",
    active: "archive",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    storeHealth: data.storeHealth,
    body: [
      "<h1>档案与产物</h1>",
      cCard({
        title: "筛选",
        body: [
          `<form method="get" action="/panel">`,
          `<input type="hidden" name="project" value="${escapeHtml(data.rootPath)}">`,
          `<input type="hidden" name="section" value="archive">`,
          ...(data.hostId ? [`<input type="hidden" name="host" value="${escapeHtml(data.hostId)}">`] : []),
          `<p>类型 <select name="kind" aria-label="产物类型"><option value="">全部</option>${["run", "case-set", "report", "diff", "crash", "trace"]
            .map(
              (kind) =>
                `<option value="${kind}"${data.query.kind === kind ? " selected" : ""}>${artifactKindLabel(kind)}</option>`
            )
            .join("")}</select> 关键词 <input type="text" name="q" aria-label="产物关键词" value="${q("q")}" placeholder="文件名/路径"> 起自 <input type="datetime-local" name="since" aria-label="起自（本地时间）" value="${sinceLocalValue(data.query.since)}"> <button class="c-button" type="submit">筛选</button></p>`,
          `<p>时间预设：${preset("近 24 小时", 24)} ${preset("近 7 天", 168)} ${preset("近 30 天", 720)} <a class="c-button" href="${csvHref}">导出索引 CSV</a></p>`,
          "</form>"
        ].join("\n")
      }),
      cCard({
        title: "产物索引",
        subtitle: `第 ${
          Math.floor(data.page.offset / data.page.pageSize) + 1
        } 页 · 本页 ${data.artifacts.length} 项 · 每页 ${data.page.pageSize} 项 · 与保留期同源（六类浅扫：批次/用例集/报告/差异/崩溃/轨迹）`,
        body: [
          cTable({
            columns: ["类型", "名称", "路径", "时间", "大小"],
            rows,
            caption: "产物索引",
            empty: "暂无产物（产物落盘后自动出现）"
          }),
          pager
        ].join("\n")
      })
    ].join("\n")
  });
}

export interface AuditPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  events: AuditEventRecord[];
  query: Record<string, string>;
  page: { offset: number; hasNext: boolean; pageSize: number };
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderAuditPage(data: AuditPageData): string {
  const auditResultLabel = (result: string): string =>
    result === "ok" ? "成功" : result === "failed" ? "失败" : result === "skipped" ? "跳过" : result;
  const base = `project=${encodeURIComponent(data.rootPath)}${
    data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : ""
  }`;
  const refLink = (key: string, value: string): string => {
    const short = value.length > 12 ? `${value.slice(0, 12)}…` : value;
    if (key === "taskId") {
      return `<a href="/panel?${base}&amp;task=${encodeURIComponent(value)}" title="taskId=${escapeHtml(value)}">任务 <code>${escapeHtml(short)}</code></a>`;
    }
    if (key === "caseSetId") {
      return `<a href="/panel?${base}&amp;section=library" title="caseSetId=${escapeHtml(value)}">用例库 <code>${escapeHtml(short)}</code></a>`;
    }
    if (key === "scheduleId") {
      return `<a href="/panel?${base}#schedules" title="scheduleId=${escapeHtml(value)}">计划 <code>${escapeHtml(short)}</code></a>`;
    }
    return `<span title="${escapeHtml(key)}=${escapeHtml(value)}"><code>${escapeHtml(key)}=${escapeHtml(short)}</code></span>`;
  };
  const refsCell = (refs: Record<string, string | undefined> | undefined): string => {
    const entries = Object.entries(refs ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""
    );
    if (entries.length === 0) return '<span class="muted">—</span>';
    return entries.map(([key, value]) => refLink(key, value)).join(" · ");
  };
  const recoveryLink = (event: AuditEventRecord): string => {
    if (event.result !== "failed") return '<span class="muted">—</span>';
    if (event.action === "action.tasks") {
      return `<a href="/panel?${base}&amp;section=dispatch">重新打开下发预览</a>`;
    }
    if (event.action === "action.issues") {
      return `<a href="/panel?${base}&amp;view=stats#issues">去建单</a>`;
    }
    if (event.action === "action.import") {
      return `<a href="/panel?${base}&amp;section=library">去用例库导入</a>`;
    }
    if (event.action === "action.verdicts") {
      return `<a href="/panel?${base}&amp;view=review">去归因队列</a>`;
    }
    if (event.action === "action.quarantine") {
      return `<a href="/panel?${base}&amp;section=library">去隔离</a>`;
    }
    return '<span class="muted">—</span>';
  };
  const rows = data.events.map((event) => [
    relativeTime(event.at),
    auditDomainHtml(event.domain),
    auditActionHtml(event.action),
    cBadge({
      label: auditResultLabel(event.result),
      tone: event.result === "ok" ? "success" : event.result === "failed" ? "error" : "warning"
    }),
    escapeHtml(event.summary),
    refsCell(event.refs),
    recoveryLink(event)
  ]);
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  const link = (patch: Record<string, string | null>): string => {
    const params = new URLSearchParams({ project: data.rootPath, section: "audit" });
    if (data.hostId) params.set("host", data.hostId);
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
    active: "ops",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    storeHealth: data.storeHealth,
    body: [
      "<h1>审计</h1>",
      renderGroupTabs({
        group: "ops",
        active: "audit",
        project: data.rootPath,
        hostId: data.hostId ?? null
      }),
      cCard({
        title: "筛选",
        body: [
          `<form method="get" action="/panel">`,
          `<input type="hidden" name="project" value="${escapeHtml(data.rootPath)}">`,
          `<input type="hidden" name="section" value="audit">`,
          ...(data.hostId ? [`<input type="hidden" name="host" value="${escapeHtml(data.hostId)}">`] : []),
          `<p>域 <select name="domain" aria-label="事件域"><option value="">全部</option>${AUDIT_DOMAIN_KEYS.map(
            ({ key, label }) =>
              `<option value="${key}"${data.query.domain === key ? " selected" : ""}>${escapeHtml(label)}</option>`
          ).join("")}</select> 结果 <select name="result" aria-label="结果"><option value="">全部</option>${[["ok", "成功"], ["skipped", "跳过"], ["failed", "失败"]]
            .map(
              ([value, label]) =>
                `<option value="${value}"${data.query.result === value ? " selected" : ""}>${label}</option>`
            )
            .join("")}</select> 起自 <input type="datetime-local" name="since" aria-label="起自（本地时间）" value="${sinceLocalValue(data.query.since)}"> <button class="c-button" type="submit">筛选</button></p>`,
          `<p>时间预设：${preset("近 24 小时", 24)} ${preset("近 7 天", 168)} ${preset("近 30 天", 720)} ${data.query.since !== undefined && data.query.since !== "" ? `<a class="c-button" href="${link({ since: null, offset: "0" })}">清除</a>` : ""}</p>`,
          "</form>"
        ].join("\n")
      }),
      cCard({
        title: "事件流",
        subtitle: `第 ${Math.floor(data.page.offset / data.page.pageSize) + 1} 页 · 本页 ${data.events.length} 条（新→旧）· 保留期 90 天 / 5 万条（AOS_AUDIT_*）`,
        body: [
          cTable({
            columns: ["时间", "域", "动作", "结果", "摘要", "关联对象", "恢复"],
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

export interface EventsPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  events: ProjectEventRecord[];
  query: Record<string, string>;
  includePayload: boolean;
  error?: string | null;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

function eventPayloadText(payload: unknown): string {
  if (payload === undefined || payload === null) return "—";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "summary", "note", "text", "reason", "title", "comment"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function renderEventsPage(data: EventsPageData): string {
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  const link = (patch: Record<string, string | null>): string => {
    const params = new URLSearchParams({ project: data.rootPath, section: "events" });
    if (data.hostId) params.set("host", data.hostId);
    for (const key of ["type", "status", "consumed", "since", "payload"]) {
      const value = data.query[key];
      if (value !== undefined && value !== "") params.set(key, value);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    return escapeHtml(`/panel?${params.toString()}`);
  };
  const preset = (label: string, hours: number): string =>
    `<a class="c-button" href="${link({ since: new Date(Date.now() - hours * 3600_000).toISOString() })}">${label}</a>`;
  const rows = data.events.map((event) => {
    const refs = [
      event.runId === null ? "" : `run <code>${escapeHtml(event.runId)}</code>`,
      event.caseId === null ? "" : `case <code>${escapeHtml(event.caseId)}</code>`
    ]
      .filter((part) => part !== "")
      .join(" · ");
    const row = [
      String(event.seq),
      `<span title="${escapeHtml(event.receivedAt)}">${relativeTime(event.receivedAt)}</span>`,
      `<code>${escapeHtml(event.type)}</code>${
        event.type === "feedback.request" ? ` ${cBadge({ label: "反馈", tone: "warning" })}` : ""
      }`,
      event.status === null ? "—" : escapeHtml(event.status),
      refs === "" ? "—" : refs
    ];
    if (data.includePayload) {
      const text = eventPayloadText(event.payload);
      const short = text.length > 220 ? `${text.slice(0, 220)}…` : text;
      row.push(
        text === "—"
          ? '<span class="muted">—</span>'
          : `<code title="${escapeHtml(text.slice(0, 500))}">${escapeHtml(short)}</code>`
      );
    }
    row.push(
      cBadge({
        label: event.consumedAt === null ? "未消费" : "已消费",
        tone: event.consumedAt === null ? "warning" : "success",
        ...(event.consumedAt === null ? {} : { title: event.consumedAt })
      }),
      `${event.payloadBytes} B`
    );
    return row;
  });
  return renderConsoleShell({
    title: "项目事件",
    active: "ops",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    storeHealth: data.storeHealth,
    body: [
      "<h1>项目事件</h1>",
      renderGroupTabs({
        group: "ops",
        active: "events",
        project: data.rootPath,
        hostId: data.hostId ?? null
      }),
      cCard({
        title: "筛选",
        body: [
          `<form method="get" action="/panel">`,
          `<input type="hidden" name="project" value="${escapeHtml(data.rootPath)}">`,
          `<input type="hidden" name="section" value="events">`,
          ...(data.hostId ? [`<input type="hidden" name="host" value="${escapeHtml(data.hostId)}">`] : []),
          `<p>类型 <input name="type" value="${q("type")}" placeholder="feedback.request" aria-label="事件类型"> 状态 <input name="status" value="${q("status")}" placeholder="passed" aria-label="事件状态"> 消费 <select name="consumed" aria-label="消费状态"><option value="">全部</option><option value="0"${data.query.consumed === "0" ? " selected" : ""}>未消费</option><option value="1"${data.query.consumed === "1" ? " selected" : ""}>已消费</option></select> 起自 <input type="datetime-local" name="since" aria-label="起自（本地时间）" value="${sinceLocalValue(data.query.since)}"> <label><input type="checkbox" name="payload" value="1"${data.includePayload ? " checked" : ""}> 显示 payload（最多 50 条）</label> <button class="c-button" type="submit">筛选</button></p>`,
          `<p>快捷：<a class="c-button" href="${link({ type: null, status: null, consumed: null, since: null, payload: null })}">全部</a> <a class="c-button" href="${link({ consumed: "0" })}">未消费</a> <a class="c-button" href="${link({ type: "feedback.request", consumed: null, payload: "1" })}">反馈请求</a> ${preset("近 24 小时", 24)} ${preset("近 7 天", 168)}</p>`,
          "</form>"
        ].join("\n")
      }),
      ...(data.error
        ? [
            cCard({
              title: "读取失败",
              tone: "accent",
              body: `<p>${escapeHtml(data.error)}</p>`
            })
          ]
        : []),
      cCard({
        title: "事件流",
        subtitle: `最近 ${data.events.length} 条（新→旧，最多 ${data.includePayload ? 50 : 200}）· ${
          data.includePayload ? "含 payload" : "payload 默认不回显"
        }`,
        body: cTable({
          columns: data.includePayload
            ? ["seq", "时间", "类型", "状态", "关联", "内容", "消费", "大小"]
            : ["seq", "时间", "类型", "状态", "关联", "消费", "大小"],
          rows,
          caption: "项目事件",
          empty: "暂无项目事件（执行器上报 run/case/artifact/feedback 事件后出现）"
        })
      }),
      cCard({
        title: "上报与消费",
        body: [
          `<p>上报：<code>POST /events/&lt;project&gt;</code> 或 <code>aos_event_report</code>；轮询/消费：<code>aos_event_poll</code> / <code>GET /events/&lt;project&gt;/poll?consume=true</code>。</p>`,
          `<p class="muted">反馈请求（<code>feedback.request</code>）可按类型筛选；勾选「显示 payload」或加 <code>payload=1</code> 查看内容（最多 50 条）。页签入口与审计、数据并列。</p>`
        ].join("\n")
      })
    ].join("\n")
  });
}

export interface SearchPageData {
  q: string;
  projects: Array<{ name: string; rootPath: string; hostId: string | null }>;
  caseSets: Array<{
    project: string;
    hostId: string | null;
    id: string;
    basename: string;
    source: string;
    features: string;
  }>;
  tasks: Array<{ project: string; hostId: string | null; id: string; status: string }>;
  truncated: boolean;
}

export function renderSearchPage(data: SearchPageData): string {
  const q = escapeHtml(data.q);
  const hostQuery = (hostId: string | null): string =>
    hostId ? `&host=${encodeURIComponent(hostId)}` : "";
  const projectLink = (name: string, rootPath: string, hostId: string | null): string =>
    `<a href="/panel?project=${encodeURIComponent(rootPath)}${hostQuery(hostId)}"><code>${escapeHtml(name)}</code></a>`;
  const projectRows = data.projects.map((project) => [
    projectLink(project.name, project.rootPath, project.hostId),
    `<code>${escapeHtml(project.rootPath)}</code>`
  ]);
  const caseSetRows = data.caseSets.map((entry) => [
    projectLink(entry.project, entry.project, entry.hostId),
    `<code>${escapeHtml(entry.basename)}</code>`,
    escapeHtml(entry.source),
    escapeHtml(entry.features),
    `<a class="c-button" href="/panel?project=${encodeURIComponent(entry.project)}&section=dispatch&source=case-set&ref=${encodeURIComponent(entry.id)}${hostQuery(entry.hostId)}">下发该用例集</a>`
  ]);
  const taskRows = data.tasks.map((entry) => [
    projectLink(entry.project, entry.project, entry.hostId),
    `<a href="/panel?project=${encodeURIComponent(entry.project)}&task=${encodeURIComponent(entry.id)}${hostQuery(entry.hostId)}"><code>${escapeHtml(entry.id)}</code></a>`,
    escapeHtml(runStatusLabel(entry.status))
  ]);
  const empty = `<h1>搜索</h1>`;
  return renderConsoleShell({
    title: data.q === "" ? "搜索" : `搜索：${data.q}`,
    active: null,
    searchQuery: data.q,
    body:
      data.q === ""
        ? [empty, cEmpty({ title: "输入关键词开始搜索", body: "按名称/路径搜项目，按用例集名/来源/功能搜用例集，按任务 id 搜任务；顶栏搜索框或 `/` 键直达。", action: '<span class="muted">示例：登录 / starbuckstw / regression</span>' })].join("\n")
        : [
            empty,
            `<p class="muted">关键词「${q}」· 项目 ${data.projects.length} · 用例集 ${data.caseSets.length} · 任务 ${data.tasks.length}${data.truncated ? "（结果已截断）" : ""}</p>`,
            cCard({
              title: "项目",
              body: cTable({ columns: ["项目", "路径"], rows: projectRows, caption: "匹配项目", empty: "无匹配项目" })
            }),
            cCard({
              title: "用例集",
              body: cTable({
                columns: ["项目", "用例集", "来源", "功能", "动作"],
                rows: caseSetRows,
                caption: "匹配用例集",
                empty: "无匹配用例集"
              })
            }),
            cCard({
              title: "任务",
              body: cTable({
                columns: ["项目", "任务", "状态"],
                rows: taskRows,
                caption: "匹配任务",
                empty: "无匹配任务"
              })
            })
          ].join("\n")
  });
}

export interface OpsPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  storeKind: string;
  storeNote: string | null;
  storeLabel: string;
  writeError: string | null;
  artifacts: number;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderOpsPage(data: OpsPageData): string {
  const actionsOff =
    data.capabilities?.actions === false || data.capabilities?.scopes?.export === false;
  const exportLink = (what: string, format: string, label: string): string => {
    const href = escapeHtml(
      `/panel/api/export?project=${encodeURIComponent(data.rootPath)}&what=${what}&format=${format}${
        data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : ""
      }`
    );
    return actionsOff
      ? `<span class="c-button c-nav-item-disabled" aria-disabled="true" title="写动作未启用">${label}</span>`
      : `<a class="c-button" href="${href}">${label}</a>`;
  };
  return renderConsoleShell({
    title: "运维",
    active: "ops",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>运维</h1>",
      renderGroupTabs({
        group: "ops",
        active: "ops",
        project: data.rootPath,
        hostId: data.hostId ?? null
      }),
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
