import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "../artifacts/index.js";
import type {
  AuditEventRecord,
  CaseSetRecord,
  DeviceLeaseRecord,
  ExcelMappingRecord,
  ProjectEventRecord,
  RegressionTaskRecord,
  RunnerTools,
  WebAssetRecord,
  WebRunnerRecord
} from "../db/types.js";
import type { WebJobSpec } from "../web/job-spec.js";
import type { WebJobResultDocument } from "../web/results.js";
import { parseQuarantine } from "../figma/quarantine.js";
import { formatBytes } from "../figma/retention.js";
import { isRunnerOnline } from "../runner/status.js";
import { escapeHtml } from "../util.js";
import { cBadge, cCard, cEmpty, cStat, cTable } from "./components.js";
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
  projectStatus?: "active" | "archived" | null;
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
  const archived = data.projectStatus === "archived";
  const actionsOff = archived || data.capabilities?.actions === false || !roleAllowed;
  const disabledAttr = actionsOff ? " disabled" : "";
  const actionsReason = archived
    ? `<p class="muted">项目已归档（archived）：禁止上传/保存映射；可继续只读查看资产与映射。需要修改请先新建项目或恢复项目状态。</p>`
    : actionsOff
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
    `<form id="asset-upload-form" data-project="${escapeHtml(data.rootPath)}"><p><input id="asset-file" type="file" name="file" accept=".xlsx,.csv" aria-label="Excel 或 CSV 文件"${disabledAttr}> ` +
      `<button id="asset-upload-submit" class="c-button" type="submit" data-busy-label="上传中…"${disabledAttr}>上传 Excel/CSV</button> <span id="asset-upload-status" role="status" class="muted"></span></p>` +
      `<p class="muted">≤20MB、.xlsx/.csv；上传后登记新版本（同内容复用文件，CSV 自动识别 UTF-8/GB18030）。</p></form>`,
    actionsReason
  ].join("\n");

  const mappingBody = [
    `<form id="mapping-preview-form" data-project="${escapeHtml(data.rootPath)}"><p><label>资产 <select id="asset-select" name="assetId" aria-label="Excel 资产" data-preview-reset="1"${disabledAttr}>` +
      (assetOptions === ""
        ? '<option value="">暂无可映射资产</option>'
        : assetOptions) +
      `</select></label> <label>表头行 <input id="asset-header-row" type="number" min="1" step="1" name="headerRow" value="1" aria-label="表头行" data-preview-reset="1"${disabledAttr}></label> ` +
      `<button id="mapping-preview-submit" class="c-button" type="submit" data-busy-label="预览中…"${disabledAttr}>预览映射</button> ` +
      `<button id="mapping-save" class="c-button c-button-primary" type="button" data-busy-label="保存中…"${disabledAttr}>保存映射</button> ` +
      `<span id="mapping-status" role="status" class="muted"></span></p></form>`,
    `<div id="mapping-preview"><p class="muted">选择资产并预览表头后，可确认建议映射并保存。</p></div>`,
    actionsReason
  ].join("\n");

  const fieldsJson = JSON.stringify(
    CANONICAL_FIELDS.map((field) => ({ field, label: CANONICAL_FIELD_LABELS[field] }))
  ).replace(/</g, "\\u003c");
  const script = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var host=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};var fields=${fieldsJson};function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}function setBusy(btn,busy){if(!btn)return;if(busy){if(!btn.dataset.idleLabel)btn.dataset.idleLabel=btn.textContent;btn.disabled=true;if(btn.dataset.busyLabel)btn.textContent=btn.dataset.busyLabel;}else{btn.disabled=false;if(btn.dataset.idleLabel)btn.textContent=btn.dataset.idleLabel;}}function jsonPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}var preview=null;var saveBtn=document.getElementById('mapping-save');if(saveBtn)saveBtn.disabled=true;var uForm=document.getElementById('asset-upload-form');var uStatus=document.getElementById('asset-upload-status');var uploadBtn=document.getElementById('asset-upload-submit');if(uForm){uForm.addEventListener('submit',function(e){e.preventDefault();if(uploadBtn&&uploadBtn.disabled)return;var input=document.getElementById('asset-file');var file=input&&input.files?input.files[0]:null;if(!file){if(uStatus)uStatus.textContent='请选择 .xlsx 或 .csv 文件';return;}if(!/\\.(xlsx|csv)$/i.test(file.name)){if(uStatus)uStatus.textContent='仅支持 .xlsx/.csv 文件';return;}var fd=new FormData();fd.append('project',root);fd.append('kind','excel');if(host)fd.append('host',host);fd.append('file',file);if(uStatus)uStatus.textContent='上传中…';setBusy(uploadBtn,true);fetch('/panel/api/projects/assets',{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已上传 '+res.j.asset.filename+'（v'+res.j.asset.version+'） · 已写入审计');location.reload();}else{setBusy(uploadBtn,false);if(uStatus)uStatus.textContent='上传失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){setBusy(uploadBtn,false);if(uStatus)uStatus.textContent='上传失败：'+err;});});}var pForm=document.getElementById('mapping-preview-form');var sel=document.getElementById('asset-select');var pStatus=document.getElementById('mapping-status');var previewBox=document.getElementById('mapping-preview');var previewBtn=document.getElementById('mapping-preview-submit');var rowInput=document.getElementById('asset-header-row');function resetPreview(){preview=null;if(saveBtn)saveBtn.disabled=true;if(previewBox)previewBox.innerHTML='<p class="muted">选择资产并预览表头后，可确认建议映射并保存。</p>';if(pStatus)pStatus.textContent='';}if(sel)sel.addEventListener('change',resetPreview);if(rowInput){rowInput.addEventListener('change',resetPreview);rowInput.addEventListener('input',resetPreview);}if(pForm){pForm.addEventListener('submit',function(e){e.preventDefault();if(previewBtn&&previewBtn.disabled)return;if(!sel||!sel.value){if(pStatus)pStatus.textContent='请选择资产';return;}var headerRow=parseInt(rowInput&&rowInput.value?rowInput.value:'1',10);if(!headerRow||headerRow<1)headerRow=1;var requestedAsset=sel.value;var requestedHeaderRow=headerRow;preview=null;if(saveBtn)saveBtn.disabled=true;if(pStatus)pStatus.textContent='读取中…';setBusy(previewBtn,true);jsonPost('/panel/api/projects/excel/preview',{project:root,host:host,assetId:requestedAsset,headerRow:requestedHeaderRow}).then(function(res){if(sel.value!==requestedAsset||parseInt(rowInput&&rowInput.value?rowInput.value:'1',10)!==requestedHeaderRow){setBusy(previewBtn,false);return;}if(!res.ok||!res.j||!res.j.ok){setBusy(previewBtn,false);if(pStatus)pStatus.textContent='预览失败：'+((res.j&&res.j.error)||('HTTP '+res.status));return;}var j=res.j;var suggested=j.suggested||{};preview={assetId:requestedAsset,sheetName:j.sheetName,headerRow:requestedHeaderRow,columnMap:suggested};var rows=fields.map(function(f){var header=suggested[f.field]||'';return '<tr><td>'+esc(f.label)+'</td><td>'+(header?'<code>'+esc(header)+'</code>':'<span class="muted">—</span>')+'</td></tr>';});if(previewBox)previewBox.innerHTML='<div class="c-table-wrap"><table class="c-table"><caption>映射预览</caption><thead><tr><th scope="col">规范字段</th><th scope="col">建议表头</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div><p class="muted">工作表 '+esc(j.sheetName)+' · 表头行 '+requestedHeaderRow+' · 指纹 <code>'+esc(String(j.fingerprint||'').slice(0,12))+'</code></p>';if(pStatus)pStatus.textContent='预览完成，可保存';setBusy(previewBtn,false);if(saveBtn)saveBtn.disabled=false;}).catch(function(err){setBusy(previewBtn,false);if(pStatus)pStatus.textContent='预览失败：'+err;});});}if(saveBtn){saveBtn.addEventListener('click',function(){if(!preview){if(pStatus)pStatus.textContent='请先预览映射';return;}if(pStatus)pStatus.textContent='保存中…';setBusy(saveBtn,true);jsonPost('/panel/api/projects/excel/mapping',{project:root,host:host,assetId:preview.assetId,sheetName:preview.sheetName,headerRow:preview.headerRow,columnMap:preview.columnMap}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已保存列映射 · 已写入审计');location.reload();}else{setBusy(saveBtn,false);if(pStatus)pStatus.textContent='保存失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){setBusy(saveBtn,false);if(pStatus)pStatus.textContent='保存失败：'+err;});});}})();</script>`;

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
      archived
        ? `<p>${cBadge({ label: "已归档", tone: "warning", title: "status=archived" })} 归档项目只读：上传与映射保存已禁用。</p>`
        : "",
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

export interface WebJobListEntry {
  task: RegressionTaskRecord;
  spec: WebJobSpec | null;
  result: WebJobResultDocument | null;
}

export interface DeviceListEntry {
  hostId: string;
  hostname: string;
  hostOnline: boolean;
  lastSeenAt: string;
  platforms: string[];
  tools: RunnerTools;
  serial: string;
  platform: "ios" | "android";
  kind: "device" | "simulator" | "emulator";
  model: string | null;
  osVersion: string | null;
  state: "idle" | "busy" | "offline";
  idle: boolean;
  leaseTaskId: string | null;
  leaseExpiresAt: string | null;
  jobTaskId: string | null;
  jobStatus: "claimed" | "running" | "pending" | null;
  jobRootPath: string | null;
  jobProjectName: string | null;
}

export interface DevicesPageData {
  devices: DeviceListEntry[];
  counts: { total: number; idle: number; busy: number; offline: number };
  filter: string;
  platform: string;
  nowMs: number;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export interface WebJobsPageData {
  /** 空串＝未选择项目（渲染项目选择器）。 */
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  projectStatus?: "active" | "archived" | null;
  jobs: WebJobListEntry[];
  assets: WebAssetRecord[];
  runners: WebRunnerRecord[];
  leases: DeviceLeaseRecord[];
  nowMs: number;
  runnerTtlMs: number;
  projectChoices: Array<{ name: string; rootPath: string; hostId: string | null }>;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export interface WebJobPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  task: RegressionTaskRecord;
  spec: WebJobSpec | null;
  result: WebJobResultDocument | null;
  device: {
    serial: string | null;
    model: string | null;
    osVersion: string | null;
    source: "result" | "inventory" | "unknown";
  };
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

const WEB_JOB_STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  claimed: "已领取",
  running: "执行中",
  stopping: "停止中",
  stopped: "已停止",
  cancelled: "已取消",
  completed: "已完成",
  partial: "部分失败",
  failed: "失败"
};

function webJobStatusLabel(status: string): string {
  return WEB_JOB_STATUS_LABELS[status] ?? status;
}

function webJobStatusTone(status: string): "neutral" | "accent" | "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "claimed" || status === "running") return "accent";
  if (status === "pending" || status === "partial" || status === "stopping") return "warning";
  return "neutral";
}

function jobsHref(
  rootPath: string,
  hostId: string | null,
  extra: Record<string, string> = {}
): string {
  const params = new URLSearchParams({ project: rootPath, section: "jobs" });
  if (hostId !== null) params.set("host", hostId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `/panel?${params.toString()}`;
}

const TERMINAL_WEB_JOB_STATUSES = new Set<string>([
  "completed",
  "failed",
  "partial",
  "cancelled",
  "stopped",
  "error"
]);

function jobBinding(task: RegressionTaskRecord, spec: WebJobSpec | null): {
  bound: boolean;
  released: boolean;
  pinned: boolean;
  hostId: string | null;
  serial: string | null;
  pending: boolean;
  reason: string | null;
} {
  const hostId = task.claimedHostId ?? task.targetHostId ?? spec?.targetHostId ?? null;
  const serial = task.deviceSerial ?? spec?.deviceSerial ?? null;
  // 活动租约只看任务行（spec.deviceLeaseId 是创建时快照，终态回写不会更新它）。
  const leaseId = task.deviceLeaseId;
  const terminal = TERMINAL_WEB_JOB_STATUSES.has(task.status);
  // 终态任务释放租约但保留设备序列号（历史绑定）：显示「已释放」而不是「未绑定」。
  const released = terminal && serial !== null;
  return {
    bound: !terminal && leaseId !== null,
    released,
    pinned: serial !== null && spec?.devicePinned === true,
    hostId,
    serial,
    pending: task.status === "pending" && leaseId === null && !spec?.binding,
    reason: spec?.assignmentError?.message ?? null
  };
}

function jobBindingCell(entry: WebJobListEntry): string {
  const binding = jobBinding(entry.task, entry.spec);
  if (binding.bound) {
    return `已绑定 host/device <code>${escapeHtml(binding.hostId ?? "—")}</code> · <code>${escapeHtml(
      binding.serial ?? "—"
    )}</code>`;
  }
  if (binding.released) {
    return `${cBadge({
      label: "已释放 host/device",
      tone: "neutral"
    })} <code>${escapeHtml(binding.hostId ?? "—")}</code> · <code>${escapeHtml(
      binding.serial ?? "—"
    )}</code>`;
  }
  const reason =
    binding.reason === null ? "" : ` <span class="muted">（${escapeHtml(binding.reason)}）</span>`;
  if (binding.pinned && binding.pending) {
    return `${cBadge({
      label: "钉住 host/设备，等待执行机",
      tone: "warning"
    })} <code>${escapeHtml(binding.hostId ?? "—")}</code> · <code>${escapeHtml(
      binding.serial ?? "—"
    )}</code>${reason}`;
  }
  if (binding.pending) {
    return `${cBadge({ label: "等待满足要求的执行机", tone: "warning" })}${reason}`;
  }
  return `<span class="muted">未绑定设备（${escapeHtml(
    webJobStatusLabel(entry.task.status)
  )}）</span>`;
}

function jobDeviceCell(entry: WebJobListEntry, runners: WebRunnerRecord[]): string {
  const binding = jobBinding(entry.task, entry.spec);
  const resultDevice = entry.result?.device;
  // 终态任务租约已释放但设备仍有效：型号/系统优先取结果上报，其次按 host+serial 查执行机心跳。
  const serial = binding.serial ?? resultDevice?.serial ?? null;
  if (serial === null) return "—";
  const runner = runners.find((record) => record.hostId === binding.hostId);
  const device = runner?.devices.find((record) => record.serial === serial);
  const model = resultDevice?.model ?? device?.model ?? null;
  const os = resultDevice?.osVersion ?? device?.osVersion ?? null;
  if (model === null && os === null) return `<code>${escapeHtml(serial)}</code>`;
  return `${escapeHtml(model ?? "未知型号")} · ${escapeHtml(os ?? "—")}`;
}

function assetOptions(assets: WebAssetRecord[], kind: WebAssetRecord["kind"], emptyLabel: string): string {
  const entries = assets.filter((asset) => asset.kind === kind);
  if (entries.length === 0) return `<option value="">${escapeHtml(emptyLabel)}</option>`;
  return entries
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.id)}">v${asset.version} · ${escapeHtml(asset.filename)}（${formatBytes(asset.size)}）</option>`
    )
    .join("");
}

function runnerDeviceOptions(
  runners: WebRunnerRecord[],
  leases: DeviceLeaseRecord[],
  nowMs: number,
  runnerTtlMs: number
): string {
  const options: string[] = ['<option value="">不指定设备（由执行机或自动选机决定）</option>'];
  for (const runner of runners) {
    const online = isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtlMs);
    for (const device of runner.devices) {
      const busy = leases.some(
        (lease) =>
          lease.hostId === runner.hostId &&
          lease.serial === device.serial &&
          Number.isFinite(Date.parse(lease.expiresAt)) &&
          Date.parse(lease.expiresAt) > nowMs
      );
      const state = busy ? "占用" : online ? "在线" : "离线";
      const label = `${runner.hostId} · ${device.serial} · ${device.model ?? "未知型号"} · ${
        device.osVersion ?? "未知系统"
      } · ${state} · ${device.state}`;
      options.push(
        `<option value="${escapeHtml(device.serial)}" data-host="${escapeHtml(runner.hostId)}">${escapeHtml(label)}</option>`
      );
    }
  }
  return options.join("");
}

/** 下发测试（web job）：项目级列表 + 表单；无项目时只给项目选择器。 */
function devicesHref(platform: string, state: string): string {
  const params = new URLSearchParams({ section: "devices" });
  if (platform !== "all") params.set("platform", platform);
  if (state !== "all") params.set("state", state);
  return `/panel?${params.toString()}`;
}

export function renderDevicesPage(data: DevicesPageData): string {
  const filterLink = (label: string, state: string, platform = data.platform): string => {
    const active = data.filter === state && data.platform === platform;
    return `<a class="c-button${active ? " c-button-primary" : ""}" href="${escapeHtml(
      devicesHref(platform, state)
    )}">${escapeHtml(label)}</a>`;
  };
  const platformLink = (label: string, platform: string): string => {
    const active = data.platform === platform;
    return `<a class="c-button${active ? " c-button-primary" : ""}" href="${escapeHtml(
      devicesHref(platform, data.filter)
    )}">${escapeHtml(label)}</a>`;
  };
  const rows = data.devices.map((device) => {
    const stateBadge =
      device.state === "idle"
        ? cBadge({ label: "空闲", tone: "success" })
        : device.state === "busy"
          ? cBadge({ label: "占用", tone: "warning" })
          : cBadge({ label: "离线", tone: "error" });
    const host = `${device.hostOnline ? cBadge({ label: "在线", tone: "success" }) : cBadge({ label: "离线", tone: "error" })} <code>${escapeHtml(device.hostId)}</code><br><span class="muted">${escapeHtml(device.hostname)}</span>`;
    const tools = Object.entries(device.tools)
      .filter(([, ok]) => ok === true)
      .map(([name]) => `<span class="chip">${escapeHtml(name)}</span>`)
      .join(" ");
    const deviceLabel = `${escapeHtml(device.platform)} · ${escapeHtml(device.kind)}<br><code>${escapeHtml(device.serial)}</code>`;
    const model = [device.model, device.osVersion].filter((value) => value !== null).map(String).join(" · ") || "—";
    const job =
      device.jobTaskId === null
        ? '<span class="muted">—</span>'
        : device.jobRootPath === null
          ? `<code>${escapeHtml(device.jobTaskId)}</code><br><span class="muted">${escapeHtml(device.jobStatus ?? "")}</span>`
          : `<a href="/panel?project=${encodeURIComponent(device.jobRootPath)}&amp;section=jobs&amp;job=${encodeURIComponent(device.jobTaskId)}"><code>${escapeHtml(device.jobTaskId)}</code></a><br><span class="muted">${escapeHtml(device.jobProjectName ?? "")} · ${escapeHtml(device.jobStatus ?? "")}</span>`;
    const lease =
      device.leaseTaskId === null
        ? '<span class="muted">—</span>'
        : `${escapeHtml(relativeTime(device.leaseExpiresAt ?? ""))} <span class="muted">到期</span>`;
    return [
      host,
      deviceLabel,
      escapeHtml(model),
      stateBadge,
      job,
      lease,
      escapeHtml(relativeTime(device.lastSeenAt)),
      tools || '<span class="muted">—</span>'
    ];
  });
  const body = [
    "<h1>设备</h1>",
    `<div class="c-stat-grid">${[
      cStat({ label: "设备", value: String(data.counts.total), hint: "已注册" }),
      cStat({ label: "空闲", value: String(data.counts.idle), hint: "可立即领取" }),
      cStat({ label: "占用", value: String(data.counts.busy), hint: "租约或任务执行中" }),
      cStat({ label: "离线", value: String(data.counts.offline), hint: "执行机心跳超时" })
    ].join("")}</div>`,
    `<p class="muted">空闲＝执行机在线、设备无有效租约、无进行中的 Web job。页面加载时快照，刷新查看最新状态。</p>`,
    `<p>${filterLink("全部", "all")} ${filterLink("空闲", "idle")} ${filterLink("占用", "busy")} ${filterLink("离线", "offline")}</p>`,
    `<p>${platformLink("全部平台", "all")} ${platformLink("Android", "android")} ${platformLink("iOS", "ios")}</p>`,
    cTable({
      columns: ["执行机", "设备", "型号/系统", "状态", "当前任务", "租约", "最后心跳", "工具"],
      rows,
      caption: `设备列表（${data.devices.length}）`,
      empty:
        data.counts.total === 0
          ? "还没有执行机注册。在目标机器运行 node dist/cli.js web-runner --name <名称>，配置中心 PG、AOS_PANEL_BASE_URL 与 AOS_RUNNER_JOB_TOKEN 后自动出现。"
          : "当前筛选下没有设备。"
    })
  ].join("\n");
  return renderConsoleShell({
    title: "设备",
    active: "devices",
    body,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth
  });
}

export function renderWebJobsPage(data: WebJobsPageData): string {
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const role = data.capabilities?.role;
  const roleAllowed =
    role === undefined || role === "dispatcher" || role === "maintainer" || role === "admin";
  const archived = data.projectStatus === "archived";
  const actionsOff = archived || data.capabilities?.actions === false || !roleAllowed;
  const disabledAttr = actionsOff ? " disabled" : "";
  const actionsReason = archived
    ? '<p class="muted">项目已归档（archived）：禁止下发；可继续查看历史任务。</p>'
    : actionsOff
      ? `<p class="muted">写动作需要 dispatcher 及以上角色（当前角色 ${escapeHtml(
          role ?? "未知"
        )}）；viewer 只读。</p>`
      : "";

  if (data.rootPath === "") {
    const choices = data.projectChoices;
    return renderConsoleShell({
      title: "下发测试",
      active: "dispatch",
      body: [
        "<h1>下发测试</h1>",
        cEmpty({
          title: "选择项目",
          body:
            choices.length === 0
              ? "还没有可选项目：先在运维页创建/接入项目后回到这里下发。"
              : "下发测试按项目隔离（Excel/安装包/执行机配置都属于项目）：先选择一个项目。",
          action:
            choices.length === 0
              ? '<a class="c-button" href="/panel">← 多项目总览</a>'
              : cTable({
                  columns: ["项目", "路径", "主机"],
                  rows: choices.map((choice) => [
                    `<a href="${escapeHtml(jobsHref(choice.rootPath, choice.hostId))}"><code>${escapeHtml(
                      choice.name
                    )}</code></a>`,
                    `<code>${escapeHtml(choice.rootPath)}</code>`,
                    choice.hostId === null ? "—" : `<code>${escapeHtml(choice.hostId)}</code>`
                  ]),
                  caption: "可选项目",
                  empty: "暂无可下发项目"
                })
        })
      ].join("\n")
    });
  }

  const rows = data.jobs.map((entry) => {
    const detailHref = jobsHref(data.rootPath, data.hostId ?? null, { job: entry.task.id });
    const gate = entry.result?.gate;
    const resultCell =
      gate === undefined
        ? '<span class="muted">尚无结果</span>'
        : cBadge({
            label: `${gate.passed}/${gate.total} 通过${
              (gate.unverified ?? 0) > 0 ? ` / 未验证 ${gate.unverified}` : ""
            }`,
            tone: gate.result === "passed" ? "success" : gate.result === "partial" ? "warning" : "error"
          });
    const binding = jobBinding(entry.task, entry.spec);
    const host = binding.hostId ?? "—";
    return [
      `<a href="${escapeHtml(detailHref)}"><code>${escapeHtml(entry.task.id)}</code></a>`,
      cBadge({
        label: webJobStatusLabel(entry.task.status),
        tone: webJobStatusTone(entry.task.status),
        title: entry.task.status
      }),
      jobBindingCell(entry),
      jobDeviceCell(entry, data.runners),
      entry.spec === null
        ? '<span class="muted">规格损坏</span>'
        : escapeHtml(entry.spec.executionMode === "llm" ? "LLM" : "Maestro"),
      entry.spec === null
        ? "—"
        : escapeHtml(
            entry.spec.assetSnapshot.find((asset) => asset.kind === "package")?.filename ??
              entry.spec.packageAssetId
          ),
      `<span title="${escapeHtml(entry.task.createdAt)}">${relativeTime(entry.task.createdAt)}</span>`,
      resultCell,
      `<span class="muted">${escapeHtml(host)}</span>`
    ];
  });

  const hostOptions = data.runners
    .map(
      (runner) =>
        `<option value="${escapeHtml(runner.hostId)}">${escapeHtml(runner.hostId)} · ${escapeHtml(
          runner.hostname
        )}（${runner.devices.length} 台设备 · ${
          isRunnerOnline(runner.lastSeenAt, data.nowMs, data.runnerTtlMs) ? "在线" : "离线"
        }）</option>`
    )
    .join("");
  const form = [
    `<form id="web-job-form" data-project="${escapeHtml(data.rootPath)}">`,
    `<fieldset${disabledAttr}>`,
    "<legend>下发参数</legend>",
    `<p><label>执行方式 <select id="web-job-mode" name="executionMode" aria-label="执行方式"${disabledAttr}>`,
    '<option value="maestro">Maestro 脚本</option>',
    '<option value="llm">LLM 执行（预留）</option>',
    "</select></label> ",
    `<label>平台 <select id="web-job-platform" name="platform" aria-label="平台"${disabledAttr}>`,
    '<option value="android">Android</option>',
    '<option value="ios">iOS</option>',
    "</select></label> ",
    `<label>设备类型 <select id="web-job-kind" name="deviceKind" aria-label="设备类型"${disabledAttr}>`,
    '<option value="any">不限</option>',
    '<option value="device">真机</option>',
    '<option value="simulator">模拟器</option>',
    "</select></label></p>",
    `<p><label>Excel 用例 <select id="web-job-excel" name="excelAssetId" aria-label="Excel 用例资产"${disabledAttr}>${assetOptions(
      data.assets,
      "excel",
      "暂无 Excel 资产（先到测试资产上传）"
    )}</select></label> ` +
      `<label>安装包 <select id="web-job-package" name="packageAssetId" aria-label="安装包资产"${disabledAttr}>${assetOptions(
        data.assets,
        "package",
        "暂无安装包资产"
      )}</select></label></p>`,
    `<p><label>测试资料 <select id="web-job-materials" name="materialsAssetId" aria-label="测试资料资产"${disabledAttr}><option value="">不指定</option>${assetOptions(
      data.assets,
      "materials",
      "不指定"
    )}</select></label> ` +
      `<label>脚本集 <select id="web-job-scripts" name="scriptSetId" aria-label="脚本集资产"${disabledAttr}><option value="">不指定</option>${assetOptions(
        data.assets,
        "scripts",
        "不指定"
      )}</select></label></p>`,
    `<p><label>用例范围（模块，逗号分隔） <input id="web-job-case-modules" name="caseModules" aria-label="用例范围（模块）" placeholder="登录、支付"${disabledAttr}></label> ` +
      `<label>用例 ID（逗号分隔） <input id="web-job-case-ids" name="caseIds" aria-label="用例范围（用例 ID）" placeholder="TC-001,TC-002"${disabledAttr}></label></p>`,
    `<p><label>执行机 <select id="web-job-assignment" name="assignment" aria-label="执行机分配方式"${disabledAttr}>`,
    '<option value="auto">自动（任意在线执行机）</option>',
    '<option value="manual">指定执行机</option>',
    "</select></label> ",
    `<label>指定主机 <select id="web-job-host" name="targetHostId" aria-label="指定主机"${disabledAttr}><option value="">自动选择</option>${hostOptions}</select></label></p>`,
    `<p><label>指定设备（可选） <select id="web-job-device" name="deviceSerial" aria-label="指定设备"${disabledAttr}>${runnerDeviceOptions(
      data.runners,
      data.leases,
      data.nowMs,
      data.runnerTtlMs
    )}</select></label></p>`,
    `<p><label>型号偏好 <input id="web-job-model" name="deviceModel" aria-label="型号偏好（逗号分隔）" placeholder="Pixel 7,Galaxy S23"${disabledAttr}></label> ` +
      `<label>系统版本下限 <input id="web-job-os-min" name="osMin" aria-label="系统版本下限" placeholder="14"${disabledAttr}></label> ` +
      `<label>系统版本上限 <input id="web-job-os-max" name="osMax" aria-label="系统版本上限" placeholder="15"${disabledAttr}></label></p>`,
    `<p><label>重试次数 <input id="web-job-retry" name="retry" type="number" min="0" step="1" value="0" aria-label="重试次数"${disabledAttr}></label> ` +
      `<label>优先级 <input id="web-job-priority" name="priority" type="number" min="0" max="100" step="1" value="0" aria-label="优先级"${disabledAttr}></label></p>`,
    `<p><button id="web-job-submit" class="c-button c-button-primary" type="submit" data-busy-label="下发中…"${disabledAttr}>下发测试</button> ` +
      `<button id="web-job-preview-submit" class="c-button" type="button"${disabledAttr}>预览选机</button> ` +
      `<span id="web-job-status" role="status" class="muted"></span></p>`,
    "</fieldset>",
    `<p class="muted">同一台设备同一时刻只允许一个任务（预占租约）；自动选机失败会进入「等待满足要求的执行机」，不是成功。</p>`,
    `<div id="web-job-preview-result" class="muted" role="status">尚未预览：可先「预览选机」查看候选主机/设备与打分。</div>`,
    "</form>",
    actionsReason
  ].join("\n");

  const script = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var host=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};function byId(id){return document.getElementById(id);}function value(id){var node=byId(id);return node&&typeof node.value==="string"?node.value.trim():"";}function list(id){var raw=value(id);return raw===""?[]:raw.split(",").map(function(part){return part.trim();}).filter(function(part){return part!=="";});}var form=byId("web-job-form");var status=byId("web-job-status");var busy=byId("web-job-submit");function setBusy(on){if(!busy)return;if(on){if(!busy.dataset.idleLabel)busy.dataset.idleLabel=busy.textContent;busy.disabled=true;busy.textContent=busy.dataset.busyLabel||"下发中…";}else{busy.disabled=false;busy.textContent=busy.dataset.idleLabel||"下发测试";}}function request(url,options){return fetch(url,options).then(function(r){return r.json().then(function(body){return {ok:r.ok,status:r.status,body:body};});});}function payload(){var assignment=value("web-job-assignment")==="manual"?"manual":"auto";var out={project:root,assignment:assignment,executionMode:value("web-job-mode")||"maestro",excelAssetId:value("web-job-excel"),packageAssetId:value("web-job-package"),requirements:{platform:value("web-job-platform")||"android",deviceKind:value("web-job-kind")||"any"},caseFilter:{modules:list("web-job-case-modules"),caseIds:list("web-job-case-ids")}};if(host)out.host=host;var materials=value("web-job-materials");if(materials!=="")out.materialsAssetId=materials;var scripts=value("web-job-scripts");if(scripts!=="")out.scriptSetId=scripts;var models=list("web-job-model");if(models.length>0)out.requirements.deviceModel=models;var min=value("web-job-os-min");var max=value("web-job-os-max");if(min!==""||max!==""){out.requirements.osVersion={};if(min!=="")out.requirements.osVersion.min=min;if(max!=="")out.requirements.osVersion.max=max;}if(assignment==="manual"){out.targetHostId=value("web-job-host");var serial=value("web-job-device");if(serial!=="")out.deviceSerial=serial;}var retry=value("web-job-retry");if(retry!=="")out.retry=Number(retry);var priority=value("web-job-priority");if(priority!=="")out.priority=Number(priority);return out;}function preview(){var target=byId("web-job-preview-result");if(!target)return;var params=new URLSearchParams({project:root,assignment:value("web-job-assignment")==="manual"?"manual":"auto",platform:value("web-job-platform")||"android",deviceKind:value("web-job-kind")||"any"});if(host)params.set("host",host);var models=value("web-job-model");if(models!=="")params.set("deviceModel",models);var min=value("web-job-os-min");if(min!=="")params.set("osMin",min);var max=value("web-job-os-max");if(max!=="")params.set("osMax",max);if(value("web-job-assignment")==="manual"){var targetHost=value("web-job-host");if(targetHost!=="")params.set("targetHostId",targetHost);var serial=value("web-job-device");if(serial!=="")params.set("deviceSerial",serial);}target.textContent="预览中…";request("/panel/api/jobs/preview?"+params.toString(),{headers:{"X-AOS-Console":"1"}}).then(function(res){if(res.ok&&res.body&&res.body.selection){var pick=res.body.selection;target.textContent="可选："+pick.hostId+" / "+pick.deviceSerial+"（分数 "+pick.score+"）";}else{target.textContent="无可用执行机："+((res.body&&res.body.message)||res.status);}}).catch(function(err){target.textContent="预览失败："+err;});}var previewBtn=byId("web-job-preview-submit");if(previewBtn)previewBtn.addEventListener("click",preview);["web-job-assignment","web-job-host","web-job-device","web-job-platform","web-job-kind","web-job-model","web-job-os-min","web-job-os-max"].forEach(function(id){var node=byId(id);if(node)node.addEventListener("change",preview);});if(form){form.addEventListener("submit",function(event){event.preventDefault();setBusy(true);request("/panel/api/jobs",{method:"POST",headers:{"Content-Type":"application/json","X-AOS-Console":"1"},body:JSON.stringify(payload())}).then(function(res){if(res.ok&&res.body&&res.body.ok){window.aosFlash&&window.aosFlash("已下发："+((res.body&&res.body.message)||res.body.status));location.href="/panel?project="+encodeURIComponent(root)+"&section=jobs"+(host?"&host="+encodeURIComponent(host):"")+"&job="+encodeURIComponent(res.body.job.id);return;}setBusy(false);if(status)status.textContent="下发失败："+((res.body&&res.body.error)||res.status);}).catch(function(err){setBusy(false);if(status)status.textContent="下发失败："+err;});});}})();</script>`;

  return renderConsoleShell({
    title: "下发测试",
    active: "dispatch",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>下发测试</h1>",
      archived ? `<p>${cBadge({ label: "已归档", tone: "warning" })} 归档项目只读。</p>` : "",
      `<p class="muted">Web 任务下发到远端执行机的具体设备：按硬要求过滤、按型号/系统版本打分；<a href="${escapeHtml(
        `/panel?project=${encodeURIComponent(data.rootPath)}&section=assets${hostQuery}`
      )}">测试资产</a> 管理 Excel/安装包/资料/脚本版本。</p>`,
      cCard({ title: "下发参数", subtitle: "执行机可自动选机或手动指定；设备与主机必须匹配", body: form }),
      cCard({
        title: "任务列表",
        subtitle: `共 ${data.jobs.length} 条（新→旧；仅列 Web 任务）`,
        body: cTable({
          columns: ["任务", "状态", "执行机与设备", "设备型号/系统", "执行方式", "安装包", "创建", "结果", "主机"],
          rows,
          caption: "Web 任务列表",
          empty: "尚无 Web 任务（上方下发）"
        })
      }),
      script
    ].join("\n")
  });
}

/** 单条 Web 任务详情：只展示已持久化的事实（result.json 不存在时明确「尚无结果」）。 */
/** 单例人工状态选择器；保存动作由页面底部脚本统一绑定。 */
function manualStatusCell(
  entry: WebJobResultDocument["execution"]["cases"][number],
  editable: boolean
): string {
  if (!editable) return '<span class="muted">—</span>';
  const current = entry.manualStatus?.status ?? "";
  const options = [
    ["", "自动"],
    ["NOT_IMPL", "未实现"],
    ["BLOCKED", "阻塞"]
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`
    )
    .join("");
  return `<select data-manual-status="${escapeHtml(entry.caseId)}" aria-label="人工状态">${options}</select>`;
}

export function renderWebJobPage(data: WebJobPageData): string {
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const result = data.result;
  const gate = result?.gate;
  const cases = Array.isArray(result?.execution?.cases) ? result.execution.cases : [];
  const canManualStatus =
    data.capabilities?.actions !== false && data.capabilities?.scopes?.verdicts !== false;
  const caseRows = cases.map((entry) => {
    const effective = entry.manualStatus?.status ?? entry.status;
    const effectiveLabel =
      effective === "NOT_IMPL" ? "未实现" : effective === "BLOCKED" ? "阻塞" : effective;
    return [
      `<code>${escapeHtml(entry.caseId)}</code>`,
      escapeHtml(entry.name),
      cBadge({
        label: effectiveLabel,
        tone:
          effective === "PASS"
            ? "success"
            : effective === "SKIP" || effective === "UNVERIFIED"
              ? "warning"
              : effective === "NOT_IMPL" || effective === "BLOCKED"
                ? "warning"
                : "error",
        title: entry.manualStatus?.reason === undefined ? undefined : entry.manualStatus.reason
      }),
      entry.durationMs === undefined ? "—" : `${entry.durationMs} ms`,
      entry.failureReason === undefined
        ? entry.failureStep === undefined
          ? "—"
          : escapeHtml(entry.failureStep)
        : `${escapeHtml(entry.failureStep ?? "")}${
            entry.failureStep === undefined ? "" : "："
          }${escapeHtml(entry.failureReason)}`,
      entry.traceId === undefined ? "—" : `<code>${escapeHtml(entry.traceId)}</code>`,
      manualStatusCell(entry, canManualStatus)
    ];
  });
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  const evidenceHtml =
    evidence.length === 0
      ? '<span class="muted">—</span>'
      : `<ul>${evidence
          .map((entry) => {
            const label = escapeHtml(entry);
            if (/^[a-z]+:\/\//i.test(entry)) return `<li><code>${label}</code></li>`;
            const href = `/panel/artifact?project=${encodeURIComponent(data.rootPath)}&path=${encodeURIComponent(
              entry
            )}${hostQuery}`;
            return `<li><a href="${escapeHtml(href)}"><code>${label}</code></a></li>`;
          })
          .join("")}</ul>`;
  const writebackError =
    typeof result?.writebackError === "string" ? result.writebackError : null;
  const writeback =
    result === null
      ? '<span class="muted">尚无结果（未写回）</span>'
      : result.writebackStatus === "written"
        ? `${cBadge({ label: "已写回", tone: "success" })} ${
            writebackError === null
              ? `<span class="muted">${escapeHtml(String(result.writtenCells?.length ?? 0))} 个单元格</span>`
              : escapeHtml(writebackError)
          }`
        : result.writebackStatus === "writeback-failed"
          ? `${cBadge({ label: "写回失败", tone: "error" })} ${
              writebackError === null ? "" : escapeHtml(writebackError)
            }`
          : cBadge({ label: "待写回", tone: "warning" });
  const provenance =
    data.device.source === "result"
      ? "结果上报"
      : data.device.source === "inventory"
        ? "执行机心跳"
        : "未知";
  const deviceText =
    data.device.model === null && data.device.osVersion === null
      ? `<span class="muted">未知（执行机未上报 · 来源：${provenance}）</span>`
      : `${escapeHtml(data.device.model ?? "未知型号")} · ${escapeHtml(
          data.device.osVersion ?? "未知系统"
        )} <span class="muted">（来源：${provenance}）</span>`;
  const resultPackage = result?.package;
  const packageText =
    resultPackage !== undefined && resultPackage !== null
      ? `${escapeHtml(String(resultPackage.name ?? "—"))} ${escapeHtml(
          String(resultPackage.version ?? "")
        )} · <code>${escapeHtml(String(resultPackage.filename ?? "—"))}</code>`
      : data.spec === null
        ? '<span class="muted">—</span>'
        : (() => {
            const snapshot = data.spec.assetSnapshot.find((asset) => asset.kind === "package");
            return `<code>${escapeHtml(snapshot?.filename ?? data.spec.packageAssetId)}</code>`;
          })();
  const startedAt = data.task.startedAt ?? result?.startedAt ?? null;
  const finishedAt = result?.finishedAt ?? null;
  const warningList = Array.isArray(result?.warnings) ? result.warnings : [];
  const warnings =
    warningList.length === 0
      ? ""
      : `<ul>${warningList.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;

  return renderConsoleShell({
    title: "下发任务详情",
    active: "dispatch",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>下发任务详情</h1>",
      `<p><a href="${escapeHtml(
        jobsHref(data.rootPath, data.hostId ?? null)
      )}">← 返回下发列表</a> · 任务 <code>${escapeHtml(data.task.id)}</code> · <a href="/panel?project=${encodeURIComponent(
        data.rootPath
      )}&amp;task=${encodeURIComponent(data.task.id)}${hostQuery}">打开回归任务</a></p>`,
      cCard({
        title: "概况",
        body: cTable({
          columns: ["状态", "执行机与设备", "设备型号/系统", "安装包", "开始", "结束", "结果门禁", "写回"],
          rows: [
            [
              `${cBadge({
                label: webJobStatusLabel(data.task.status),
                tone: webJobStatusTone(data.task.status),
                title: data.task.status
              })}${
                gate === undefined
                  ? ""
                  : ` ${cBadge({
                      label: `结果 ${gate.passed}/${gate.total}`,
                      tone: gate.result === "passed" ? "success" : gate.result === "partial" ? "warning" : "error"
                    })}`
              }`,
              jobBindingCell({ task: data.task, spec: data.spec, result }),
              `${deviceText}${
                data.device.serial === null ? "" : ` · <code>${escapeHtml(data.device.serial)}</code>`
              }`,
              packageText,
              startedAt === null
                ? '<span class="muted">—</span>'
                : `<span title="${escapeHtml(startedAt)}">${relativeTime(startedAt)}</span>`,
              finishedAt === null
                ? '<span class="muted">—</span>'
                : `<span title="${escapeHtml(finishedAt)}">${relativeTime(finishedAt)}</span>`,
              gate === undefined
                ? '<span class="muted">尚无结果</span>'
                : `${escapeHtml(gate.result)}（通过 ${gate.passed} / 失败 ${gate.failed} / 错误 ${gate.errors} / 跳过 ${gate.skipped}${
                    (gate.unverified ?? 0) > 0 ? ` / 未验证 ${gate.unverified}` : ""
                  }${(gate.notImplemented ?? 0) > 0 ? ` / 未实现 ${gate.notImplemented}` : ""}${
                    (gate.blocked ?? 0) > 0 ? ` / 阻塞 ${gate.blocked}` : ""
                  }）`,
              writeback
            ]
          ],
          caption: "任务概况",
          empty: "—"
        })
      }),
      cCard({
        title: "逐用例结果",
        subtitle:
          result === null
            ? "尚无结果（等执行机上传 result.json）"
            : `结果接收于 ${result.receivedAt} · 共 ${cases.length} 条`,
        body:
          result === null
            ? '<p id="job-result-empty" class="muted">尚无结果：执行机上传前不展示逐用例结果，也不虚构设备/包信息。</p>'
            : cTable({
                columns: canManualStatus
                  ? ["用例", "名称", "结果", "耗时", "失败信息", "trace", "人工状态"]
                  : ["用例", "名称", "结果", "耗时", "失败信息", "trace"],
                rows: caseRows,
                caption: "逐用例结果",
                empty: "结果中没有用例"
              })
      }),
      cCard({
        title: "证据与写回",
        body: [
          `<p><strong>证据</strong>：${evidenceHtml}</p>`,
          `<p><strong>写回</strong>：${writeback}</p>`,
          warnings === "" ? "" : `<p><strong>告警</strong>：</p>${warnings}`
        ].join("\n")
      }),
      `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var host=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};var job=${JSON.stringify(data.task.id).replace(/</g, "\\u003c")};document.querySelectorAll("select[data-manual-status]").forEach(function(node){node.addEventListener("change",function(){var status=node.value;var reason=status===""?"":(window.prompt("原因（可选）","")||"");var body={project:root,status:status,reason:reason};if(host)body.host=host;fetch("/panel/api/jobs/"+encodeURIComponent(job)+"/cases/"+encodeURIComponent(node.getAttribute("data-manual-status"))+"/status",{method:"POST",headers:{"Content-Type":"application/json","X-AOS-Console":"1"},body:JSON.stringify(body)}).then(function(response){return response.json().then(function(payload){if(!response.ok)throw new Error((payload&&payload.error)||response.status);location.reload();});}).catch(function(error){window.alert("人工状态保存失败："+error);node.value=node.getAttribute("data-current")||"";});});node.setAttribute("data-current",node.value);});})();</script>`
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
    if (event.action === "action.jobs") {
      return `<a href="/panel?${base}&amp;section=jobs">重新打开下发表单</a>`;
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
