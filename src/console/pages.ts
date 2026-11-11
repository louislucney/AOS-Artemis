import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "../artifacts/index.js";
import type {
  AuditEventRecord,
  CaseSetRecord,
  ExcelMappingRecord,
  ProjectEventRecord,
  RegressionTaskRecord,
  RunnerTools,
  WebAssetRecord
} from "../db/types.js";
import { parseQuarantine } from "../figma/quarantine.js";
import { formatBytes } from "../figma/retention.js";
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
  /** 资产 id → 被任务引用次数。 */
  usage?: Record<string, number>;
  /** true＝作为测试资产 hub 的“用例集”tab 嵌入，导航高亮测试资产。 */
  embedded?: boolean;
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
  const usage = data.usage ?? {};
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
      String(usage[set.id] ?? 0),
      `<a class="c-button" href="${escapeHtml(`/panel?project=${encodeURIComponent(data.rootPath)}&section=create&type=suite&source=case-set&ref=${encodeURIComponent(set.id)}${hostQuery}`)}">下发该用例集</a>`
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
    `<form id="quarantine-form" class="c-form" data-project="${escapeHtml(data.rootPath)}"><p><label>用例 ID <input list="quarantine-case-options" name="caseId" placeholder="输入或从最近失败用例选择" aria-label="用例 ID（可搜索最近失败用例）"${disabledAttr}></label>` +
      caseCandidateOptions +
      ` <label>签字人 <input type="text" name="owner" aria-label="签字人（owner）"${disabledAttr}></label> ` +
      `<label>到期日期（可选） <input type="date" name="until" aria-label="到期日期（可选）"${disabledAttr}></label> ` +
      `<button class="c-button" type="submit"${disabledAttr}>加入隔离</button> <span id="quarantine-status" role="status" class="muted"></span></p></form>`,
    actionsReason
  ].join("\n");
  const importBody = [
    `<form id="import-form" data-project="${escapeHtml(data.rootPath)}">` +
      `<div id="import-drop" class="c-dropzone" tabindex="0" role="button" aria-label="拖放 Excel 文件，或点击选择">` +
      `<input id="import-file" class="c-dropzone-input" type="file" name="file" accept=".xlsx" aria-label="Excel 文件"${disabledAttr}>` +
      `<span class="c-dropzone-title">拖入 Excel 文件</span>` +
      `<span class="c-dropzone-hint">或点击选择 .xlsx · ≤20MB</span>` +
      `<span id="import-file-name" class="c-dropzone-file">未选择文件</span>` +
      `</div>` +
      `<p class="c-dropzone-actions"><button class="c-button" type="submit"${disabledAttr}>上传导入</button> <span id="import-status" role="status" class="muted"></span></p>` +
      `<p class="muted">导入后自动登记为最新用例集（需 HTTP 模式运行时；独立进程请用 CLI <code>suite task create --excel</code>）。</p></form>`,
    actionsReason
  ].join("\n");
  const script = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var hostId=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};function jsonPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}var qForm=document.getElementById('quarantine-form');var qStatus=document.getElementById('quarantine-status');if(qForm){qForm.addEventListener('submit',function(e){e.preventDefault();var f=new FormData(qForm);jsonPost('/panel/api/quarantine',{project:root,host:hostId,action:'add',caseId:(f.get('caseId')||'').trim(),owner:(f.get('owner')||'').trim(),until:(f.get('until')||'').trim()||undefined}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('已加入隔离 · 已写入审计');location.reload();}else{qStatus.textContent='加入失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){qStatus.textContent='加入失败：'+err;});});}document.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button[data-quarantine]'):null;if(!b)return;var quarantineRemove=function(){jsonPost('/panel/api/quarantine',{project:root,host:hostId,action:'remove',caseId:b.getAttribute('data-quarantine')}).then(function(res){if(res.ok&&res.j.ok){window.aosFlash&&aosFlash('已移除隔离 · 已写入审计');location.reload();}else if(qStatus){qStatus.textContent='移除失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){if(qStatus)qStatus.textContent='移除失败：'+err;});};window.aosInlineConfirm(b,'确认移除该隔离条目？',quarantineRemove);});var iForm=document.getElementById('import-form');var iStatus=document.getElementById('import-status');var iFile=document.getElementById('import-file');var iDrop=document.getElementById('import-drop');var iFileName=document.getElementById('import-file-name');function updateImportName(){if(!iFileName)return;var f=iFile&&iFile.files?iFile.files[0]:null;iFileName.textContent=f?f.name:'未选择文件';}function submitImport(){var fd=new FormData(iForm);if(hostId)fd.append('host',hostId);var file=fd.get('file');if(!file||!(file.name||'').toLowerCase().endsWith('.xlsx')){iStatus.textContent='请选择 .xlsx 文件';return;}if(file.size>20*1024*1024){iStatus.textContent='文件超过 20MB';return;}iStatus.textContent='导入中…';fetch('/panel/api/import?project='+encodeURIComponent(root)+(hostId?'&host='+encodeURIComponent(hostId):''),{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j.ok){var __w=(res.j.warnings||[]).concat((res.j.design&&res.j.design.warnings)||[]).filter(function(v,i,a){return a.indexOf(v)===i;});if(__w.length){if(iStatus)iStatus.textContent='导入完成，但需注意：'+__w.join('；');window.aosFlash&&aosFlash('导入完成，但需注意：'+__w.join('；'));setTimeout(function(){location.reload();},2500);}else{window.aosFlash&&aosFlash('导入完成 · 已登记为最新用例集');location.reload();}}else{iStatus.textContent='导入失败：'+((res.j&&res.j.error)||res.status);}}).catch(function(err){iStatus.textContent='导入失败：'+err;});}if(iForm){iForm.addEventListener('submit',function(e){e.preventDefault();submitImport();});}if(iDrop&&iFile){iDrop.addEventListener('click',function(){iFile.click();});iDrop.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();iFile.click();}});['dragenter','dragover'].forEach(function(name){iDrop.addEventListener(name,function(e){e.preventDefault();iDrop.classList.add('is-dragover');});});['dragleave','drop'].forEach(function(name){iDrop.addEventListener(name,function(e){e.preventDefault();iDrop.classList.remove('is-dragover');});});iDrop.addEventListener('drop',function(e){var files=e.dataTransfer&&e.dataTransfer.files;if(!files||files.length===0)return;var file=files[0];if(!file.name.toLowerCase().endsWith('.xlsx')){iStatus.textContent='仅支持 .xlsx 文件';return;}if(file.size>20*1024*1024){iStatus.textContent='文件超过 20MB';return;}try{iFile.files=files;}catch(err){var dt=new DataTransfer();dt.items.add(file);iFile.files=dt.files;}updateImportName();submitImport();});iFile.addEventListener('click',function(e){e.stopPropagation();});iFile.addEventListener('change',updateImportName);}
})();</script>`;
  return renderConsoleShell({
    title: "测试资产 · 用例集",
    active: "assets",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>用例库</h1>",
      `<nav class="c-flow-switch" aria-label="测试资产类型"><span class="c-flow-option is-active" aria-current="page">用例集</span><a class="c-flow-option" href="${escapeHtml(
        `/panel?project=${encodeURIComponent(data.rootPath)}&section=assets${hostQuery}`
      )}">测试资产（Excel / 安装包 / 资料 / 参考图）</a></nav>`,
      `<p class="muted">安装包不随用例集保存。需要上传新安装包请去 <a href="${escapeHtml(
        `/panel?project=${encodeURIComponent(data.rootPath)}&section=assets&tab=packages&kind=package${hostQuery}#asset-upload`
      )}">测试资产 → 安装包</a>；套件回归使用设备上已安装的 App。</p>`,
      cCard({
        title: "用例集",
        subtitle: `共 ${data.sets.length} 份用例集 · 每份可打开 Excel（tests.xlsx）`,
        body: cTable({
          columns: ["用例集", "Excel 文件", "设计来源", "登记时间", "用例数", "功能", "被使用", "动作"],
          rows,
          caption: "用例集列表",
          empty: "暂无用例集（下方导入或先生成）"
        }),
        actions: `<a class="c-button" href="${escapeHtml(`/panel?project=${encodeURIComponent(data.rootPath)}&section=create&type=suite${hostQuery}`)}">按用例集下发</a>`
      }),
      `<div id="library-import">${cCard({ title: "导入 Excel（用例文档）", body: importBody })}</div>`,
      cCard({ title: "隔离（quarantine）", body: quarantineBody }),
      script
    ].join("\n")
  });
}

export type AssetsTab =
  | "overview"
  | "case-sets"
  | "excel"
  | "packages"
  | "materials"
  | "reference";

export interface WebAssetsPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  projectStatus?: "active" | "archived" | null;
  appPackage?: string | null;
  assets: WebAssetRecord[];
  packages?: WebAssetRecord[];
  materials?: WebAssetRecord[];
  references?: WebAssetRecord[];
  /** 由 `?kind=package#asset-upload` / `?kind=materials#asset-upload` 预选上传类型。 */
  uploadKind?: "excel" | "package" | "materials" | "reference";
  /** 测试资产 hub 的当前 tab；缺省＝旧版全量页（兼容旧链接）。 */
  tab?: AssetsTab;
  /** 概览的用例集数量（不渲染用例集表）。 */
  sets?: CaseSetRecord[];
  /** 资产 id → 被任务引用次数。 */
  usage?: Record<string, number>;
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

function assetPlatform(asset: WebAssetRecord): "android" | "ios" | null {
  if (asset.kind === "scripts") {
    const platform = asset.metadata?.platform;
    return platform === "android" || platform === "ios" ? platform : null;
  }
  if (asset.kind !== "package") return null;
  const extension = path.extname(asset.filename).toLowerCase();
  return extension === ".apk" ? "android" : extension === ".ipa" ? "ios" : null;
}

/** APK/IPA（以及带 platform 元数据的脚本集）按平台各自编号；其它资产沿用全局 version。 */
function assetVersionNumbers(assets: WebAssetRecord[]): Map<string, number> {
  const buckets = new Map<string, WebAssetRecord[]>();
  for (const asset of assets) {
    const platform = assetPlatform(asset);
    if (platform === null) continue;
    const key = `${asset.kind}\u0000${platform}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(asset);
    buckets.set(key, bucket);
  }
  const numbers = new Map<string, number>();
  for (const bucket of buckets.values()) {
    bucket
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.version - right.version)
      .forEach((asset, index) => numbers.set(asset.id, index + 1));
  }
  return numbers;
}

/** 测试资产（Excel 原件版本 + 列映射）：上传/预览/保存均走面板动作 API；
 * 写动作按 capabilities.actions 与角色（maintainer/admin）收口，UI 只做可达性提示。 */
export function renderWebAssetsPage(data: WebAssetsPageData): string {
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const role = data.capabilities?.role;
  const roleAllowed = role === undefined || role === "maintainer" || role === "admin";
  const archived = data.projectStatus === "archived";
  const actionsOff = archived || data.capabilities?.actions === false || !roleAllowed;
  const disabledAttr = actionsOff ? " disabled" : "";
  const actionsReason = archived
    ? `<p class="muted">项目已归档（archived）：禁止上传/保存映射；可继续只读查看资产与映射。需要修改请 <a href="/panel?new=1#new-project">新建项目</a>。</p>`
    : actionsOff
      ? `<p class="muted">${
          roleAllowed
            ? "写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式。"
            : `写动作需要 maintainer/admin（当前角色 ${escapeHtml(role ?? "未知")}）。`
        }</p>`
      : "";

  const usage = data.usage ?? {};
  const assetName = new Map<string, string>();
  for (const asset of data.assets) {
    assetName.set(asset.id, `${asset.filename} v${asset.version}`);
  }
  const assetOpenHref = (asset: WebAssetRecord): string | null => {
    const abs = path.isAbsolute(asset.storagePath)
      ? asset.storagePath
      : path.resolve(data.rootPath, asset.storagePath);
    const rel = path.relative(data.rootPath, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const params = new URLSearchParams({ project: data.rootPath, path: rel });
    if (data.hostId) params.set("host", data.hostId);
    return `/panel/artifact?${params.toString()}`;
  };
  const assetOpenCell = (asset: WebAssetRecord): string => {
    if (asset.metadata?.secret === true) return '<span class="muted">secret</span>';
    const href = assetOpenHref(asset);
    return href === null
      ? '<span class="muted">—</span>'
      : `<a class="c-button" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">打开</a>`;
  };
  const assetRows = data.assets.map((asset) => [
    `<code>${escapeHtml(asset.filename)}</code>`,
    `<code>v${asset.version}</code>`,
    formatBytes(asset.size),
    `<code>${escapeHtml(asset.sha256.slice(0, 12))}</code>`,
    relativeTime(asset.createdAt),
    String(usage[asset.id] ?? 0),
    `${assetOpenCell(asset)} <button class="c-button" type="button" data-import-excel="${escapeHtml(
      asset.id
    )}"${disabledAttr}>导入用例库</button>`
  ]);
  const assetOptions = data.assets
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.id)}">v${asset.version} · ${escapeHtml(asset.filename)}（${formatBytes(asset.size)}）</option>`
    )
    .join("");
  const packages = data.packages ?? [];
  const materials = data.materials ?? [];
  const packageVersionNumbers = assetVersionNumbers(packages);
  const packageRows = packages.map((asset) => [
    `<code>${escapeHtml(asset.filename)}</code>`,
    assetPlatform(asset) === "android"
      ? "Android"
      : assetPlatform(asset) === "ios"
        ? "iOS"
        : '<span class="muted">—</span>',
    `<code>v${packageVersionNumbers.get(asset.id) ?? asset.version}</code>`,
    formatBytes(asset.size),
    `<code>${escapeHtml(asset.sha256.slice(0, 12))}</code>`,
    relativeTime(asset.createdAt),
    String(usage[asset.id] ?? 0),
    assetOpenCell(asset)
  ]);
  const materialRows = materials.map((asset) => {
    const secret = asset.metadata?.secret === true;
    return [
      `<code>${escapeHtml(asset.filename)}</code>`,
      `<code>v${asset.version}</code>`,
      formatBytes(asset.size),
      secret ? cBadge({ label: "secret", tone: "warning" }) : '<span class="muted">—</span>',
      `<code>${escapeHtml(asset.sha256.slice(0, 12))}</code>`,
      relativeTime(asset.createdAt),
      String(usage[asset.id] ?? 0),
      assetOpenCell(asset)
    ];
  });
  const references = data.references ?? [];
  const referenceRows = references.map((asset) => [
    `<code>${escapeHtml(asset.filename)}</code>`,
    `<code>v${asset.version}</code>`,
    formatBytes(asset.size),
    `<code>${escapeHtml(asset.sha256.slice(0, 12))}</code>`,
    relativeTime(asset.createdAt),
    assetOpenCell(asset)
  ]);
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

  const uploadKind =
    data.uploadKind === "package"
      ? "package"
      : data.uploadKind === "materials"
        ? "materials"
        : data.uploadKind === "reference"
          ? "reference"
          : "excel";
  const uploadBody = [
    `<form id="asset-upload-form" class="c-form" data-project="${escapeHtml(data.rootPath)}">`,
    `<p><label>类型 <select id="asset-kind" aria-label="资产类型"${disabledAttr}><option value="excel"${uploadKind === "excel" ? " selected" : ""}>Excel 用例</option><option value="package"${uploadKind === "package" ? " selected" : ""}>安装包（APK/IPA）</option><option value="materials"${uploadKind === "materials" ? " selected" : ""}>测试资料（materials）</option><option value="reference"${uploadKind === "reference" ? " selected" : ""}>参考图（L2 reference）</option></select></label> <span class="muted">Excel 支持 .xlsx/.csv；安装包支持 .apk/.ipa；测试资料支持 .zip/.json/.csv/.txt；参考图支持 .png/.jpg/.jpeg/.webp/.pen。</span></p>`,
    `<div id="asset-drop" class="c-dropzone" tabindex="0" role="button" aria-label="拖放 Excel、CSV、安装包或测试资料文件，或点击选择">`,
    `<input id="asset-file" class="c-dropzone-input" type="file" name="file" tabindex="-1" accept=".xlsx,.csv,.apk,.ipa,.zip,.json,.txt,.png,.jpg,.jpeg,.webp,.pen" aria-label="Excel、CSV、安装包或测试资料文件"${disabledAttr}>`,
    `<span class="c-dropzone-title">拖入 Excel / CSV / APK / IPA / 测试资料 / 参考图</span>`,
    `<span class="c-dropzone-hint">或点击选择文件；安装包 .apk/.ipa；测试资料 .zip/.json/.csv/.txt；参考图 .png/.jpg/.jpeg/.webp/.pen</span>`,
    `<span id="asset-file-name" class="c-dropzone-file">未选择文件</span>`,
    `</div>`,
    `<p id="asset-secret-row" class="c-form-check"${uploadKind === "materials" ? "" : " hidden"}><label><input id="asset-secret" type="checkbox"${disabledAttr}> 资料含密钥/账号（secret；执行机临时 0600，不入缓存）</label></p>`,
    `<p class="c-dropzone-actions"><button id="asset-upload-submit" class="c-button" type="submit" data-busy-label="上传中…"${disabledAttr}>上传资产</button> <span id="asset-upload-status" role="status" class="muted"></span></p>`,
    `<p class="muted">Excel ≤20MB、.xlsx/.csv；安装包 .apk/.ipa；测试资料 .zip/.json/.csv/.txt（secret 仅 materials）；参考图 .png/.jpg/.jpeg/.webp/.pen；上传后登记新版本（同内容复用文件，CSV 自动识别 UTF-8/GB18030）。</p>`,
    `</form>`,
    actionsReason
  ].join("\n");

  const mappingBody = [
    `<form id="mapping-preview-form" class="c-form" data-project="${escapeHtml(data.rootPath)}"><p><label>资产 <select id="asset-select" name="assetId" aria-label="Excel 资产" data-preview-reset="1"${disabledAttr}>` +
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
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var host=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};var fields=${fieldsJson};function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}function setBusy(btn,busy){if(!btn)return;if(busy){if(!btn.dataset.idleLabel)btn.dataset.idleLabel=btn.textContent;btn.disabled=true;if(btn.dataset.busyLabel)btn.textContent=btn.dataset.busyLabel;}else{btn.disabled=false;if(btn.dataset.idleLabel)btn.textContent=btn.dataset.idleLabel;}}function jsonPost(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}var preview=null;var saveBtn=document.getElementById('mapping-save');if(saveBtn)saveBtn.disabled=true;var uForm=document.getElementById('asset-upload-form');var uStatus=document.getElementById('asset-upload-status');var uploadBtn=document.getElementById('asset-upload-submit');var input=document.getElementById('asset-file');var uDrop=document.getElementById('asset-drop');var uFileName=document.getElementById('asset-file-name');function uKind(){var kindSel=document.getElementById('asset-kind');var v=kindSel?kindSel.value:'';return v==='package'||v==='materials'||v==='reference'?v:'excel';}function uKindOf(file){var lower=file?String(file.name||'').toLowerCase():'';if(lower.endsWith('.apk')||lower.endsWith('.ipa'))return 'package';if(lower.endsWith('.png')||lower.endsWith('.jpg')||lower.endsWith('.jpeg')||lower.endsWith('.webp')||lower.endsWith('.pen'))return 'reference';if(lower.endsWith('.xlsx'))return 'excel';if(lower.endsWith('.zip')||lower.endsWith('.json')||lower.endsWith('.txt'))return 'materials';if(lower.endsWith('.csv')){var current=uKind();return current==='materials'?'materials':'excel';}return uKind();}function uSyncKind(file){var kind=uKindOf(file);var kindSel=document.getElementById('asset-kind');if(kindSel&&(kind==='package'||kind==='excel'||kind==='materials'||kind==='reference'))kindSel.value=kind;var secretRow=document.getElementById('asset-secret-row');if(secretRow)secretRow.hidden=kind!=='materials';return kind;}function uExtOk(name,kind){var lower=String(name||'').toLowerCase();if(kind==='package')return lower.endsWith('.apk')||lower.endsWith('.ipa');if(kind==='materials')return lower.endsWith('.zip')||lower.endsWith('.json')||lower.endsWith('.csv')||lower.endsWith('.txt');if(kind==='reference')return lower.endsWith('.png')||lower.endsWith('.jpg')||lower.endsWith('.jpeg')||lower.endsWith('.webp')||lower.endsWith('.pen');return lower.endsWith('.xlsx')||lower.endsWith('.csv');}var uKindSelect=document.getElementById('asset-kind');if(uKindSelect){uKindSelect.addEventListener('change',function(){var secretRow=document.getElementById('asset-secret-row');if(secretRow)secretRow.hidden=uKindSelect.value!=='materials';});}function uUpdateName(){if(!uFileName)return;var f=input&&input.files?input.files[0]:null;uFileName.textContent=f?f.name:'未选择文件';if(f)uSyncKind(f);}if(uForm){uForm.addEventListener('submit',function(e){e.preventDefault();if(uploadBtn&&uploadBtn.disabled)return;var file=input&&input.files?input.files[0]:null;var kind=uSyncKind(file);if(!file){if(uStatus)uStatus.textContent='请选择文件';return;}if(!uExtOk(file.name,kind)){if(uStatus)uStatus.textContent=kind==='package'?'安装包仅支持 .apk/.ipa':kind==='materials'?'测试资料仅支持 .zip/.json/.csv/.txt':kind==='reference'?'参考图仅支持 .png/.jpg/.jpeg/.webp/.pen':'Excel 仅支持 .xlsx/.csv';return;}var fd=new FormData();fd.append('project',root);fd.append('kind',kind);if(host)fd.append('host',host);var secret=document.getElementById('asset-secret');if(kind==='materials'&&secret&&secret.checked)fd.append('secret','true');fd.append('file',file);if(uStatus)uStatus.textContent='上传中…';setBusy(uploadBtn,true);fetch('/panel/api/projects/assets',{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j&&res.j.ok){var uploaded=res.j.assets&&res.j.assets.length?res.j.assets.length:1;window.aosFlash&&aosFlash('已上传 '+(uploaded>1?uploaded+' 个参考图':res.j.asset.filename+'（v'+res.j.asset.version+'）')+' · 已写入审计');setBusy(uploadBtn,false);var url=new URL(location.href);url.hash='';url.searchParams.set('_uploaded',String(Date.now()));location.href=url.toString();}else{setBusy(uploadBtn,false);if(uStatus)uStatus.textContent='上传失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){setBusy(uploadBtn,false);if(uStatus)uStatus.textContent='上传失败：'+err;});});}if(uDrop&&input){uDrop.addEventListener('click',function(){input.click();});uDrop.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click();}});['dragenter','dragover'].forEach(function(name){uDrop.addEventListener(name,function(e){e.preventDefault();uDrop.classList.add('is-dragover');});});['dragleave','drop'].forEach(function(name){uDrop.addEventListener(name,function(e){e.preventDefault();uDrop.classList.remove('is-dragover');});});uDrop.addEventListener('drop',function(e){var files=e.dataTransfer&&e.dataTransfer.files;if(!files||files.length===0)return;var file=files[0];var kind=uSyncKind(file);if(!uExtOk(file.name,kind)){if(uStatus)uStatus.textContent=kind==='package'?'安装包仅支持 .apk/.ipa':kind==='materials'?'测试资料仅支持 .zip/.json/.csv/.txt':kind==='reference'?'参考图仅支持 .png/.jpg/.jpeg/.webp/.pen':'Excel 仅支持 .xlsx/.csv';return;}try{input.files=files;}catch(err){var dt=new DataTransfer();dt.items.add(file);input.files=dt.files;}uUpdateName();if(uStatus)uStatus.textContent='已选择文件，点击「上传资产」';});input.addEventListener('click',function(e){e.stopPropagation();});input.addEventListener('change',uUpdateName);uUpdateName();}var pForm=document.getElementById('mapping-preview-form');var sel=document.getElementById('asset-select');var pStatus=document.getElementById('mapping-status');var previewBox=document.getElementById('mapping-preview');var previewBtn=document.getElementById('mapping-preview-submit');var rowInput=document.getElementById('asset-header-row');function resetPreview(){preview=null;if(saveBtn)saveBtn.disabled=true;if(previewBox)previewBox.innerHTML='<p class="muted">选择资产并预览表头后，可确认建议映射并保存。</p>';if(pStatus)pStatus.textContent='';}if(sel)sel.addEventListener('change',resetPreview);if(rowInput){rowInput.addEventListener('change',resetPreview);rowInput.addEventListener('input',resetPreview);}if(pForm){pForm.addEventListener('submit',function(e){e.preventDefault();if(previewBtn&&previewBtn.disabled)return;if(!sel||!sel.value){if(pStatus)pStatus.textContent='请选择资产';return;}var headerRow=parseInt(rowInput&&rowInput.value?rowInput.value:'1',10);if(!headerRow||headerRow<1)headerRow=1;var requestedAsset=sel.value;var requestedHeaderRow=headerRow;preview=null;if(saveBtn)saveBtn.disabled=true;if(pStatus)pStatus.textContent='读取中…';setBusy(previewBtn,true);jsonPost('/panel/api/projects/excel/preview',{project:root,host:host,assetId:requestedAsset,headerRow:requestedHeaderRow}).then(function(res){if(sel.value!==requestedAsset||parseInt(rowInput&&rowInput.value?rowInput.value:'1',10)!==requestedHeaderRow){setBusy(previewBtn,false);return;}if(!res.ok||!res.j||!res.j.ok){setBusy(previewBtn,false);if(pStatus)pStatus.textContent='预览失败：'+((res.j&&res.j.error)||('HTTP '+res.status));return;}var j=res.j;var suggested=j.suggested||{};preview={assetId:requestedAsset,sheetName:j.sheetName,headerRow:requestedHeaderRow,columnMap:suggested};var rows=fields.map(function(f){var header=suggested[f.field]||'';return '<tr><td>'+esc(f.label)+'</td><td>'+(header?'<code>'+esc(header)+'</code>':'<span class="muted">—</span>')+'</td></tr>';});if(previewBox)previewBox.innerHTML='<div class="c-table-wrap"><table class="c-table"><caption>映射预览</caption><thead><tr><th scope="col">规范字段</th><th scope="col">建议表头</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div><p class="muted">工作表 '+esc(j.sheetName)+' · 表头行 '+requestedHeaderRow+' · 指纹 <code>'+esc(String(j.fingerprint||'').slice(0,12))+'</code></p>';if(pStatus)pStatus.textContent='预览完成，可保存';setBusy(previewBtn,false);if(saveBtn)saveBtn.disabled=false;}).catch(function(err){setBusy(previewBtn,false);if(pStatus)pStatus.textContent='预览失败：'+err;});});}if(saveBtn){saveBtn.addEventListener('click',function(){if(!preview){if(pStatus)pStatus.textContent='请先预览映射';return;}if(pStatus)pStatus.textContent='保存中…';setBusy(saveBtn,true);jsonPost('/panel/api/projects/excel/mapping',{project:root,host:host,assetId:preview.assetId,sheetName:preview.sheetName,headerRow:preview.headerRow,columnMap:preview.columnMap}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已保存列映射 · 已写入审计');location.reload();}else{setBusy(saveBtn,false);if(pStatus)pStatus.textContent='保存失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){setBusy(saveBtn,false);if(pStatus)pStatus.textContent='保存失败：'+err;});});}document.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button[data-import-excel]'):null;if(!b)return;var id=b.getAttribute('data-import-excel');if(!id)return;if(window.aosDesignImport){return;}b.disabled=true;jsonPost('/panel/api/import',{project:root,host:host,assetId:id}).then(function(res){if(res.ok&&res.j&&res.j.ok){var __w=(res.j.warnings||[]).concat((res.j.design&&res.j.design.warnings)||[]).filter(function(v,i,a){return a.indexOf(v)===i;});if(__w.length){if(uStatus)uStatus.textContent='导入完成，但需注意：'+__w.join('；');window.aosFlash&&aosFlash('导入完成，但需注意：'+__w.join('；'));setTimeout(function(){location.reload();},2500);}else{window.aosFlash&&aosFlash('已导入用例库 · 可到用例库下发');location.reload();}}else{b.disabled=false;if(uStatus)uStatus.textContent='导入用例库失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}}).catch(function(err){b.disabled=false;if(uStatus)uStatus.textContent='导入用例库失败：'+err;});});})();</script>`;

  const designImportDialog = actionsOff
    ? ""
    : `<div id="design-import-modal" data-project="${escapeHtml(data.rootPath)}" data-host="${escapeHtml(data.hostId ?? "")}" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);align-items:center;justify-content:center;padding:16px"><div role="dialog" aria-modal="true" aria-labelledby="design-import-title" style="background:#fff;color:#111;width:min(680px,100%);max-height:85vh;overflow:auto;border-radius:12px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3)"><h2 id="design-import-title" style="margin-top:0">设计增强导入</h2><div id="design-import-body"></div><div id="design-import-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap"></div></div></div>`;
  const designImportScript = actionsOff
    ? ""
    : `<script>(function(){var modal=document.getElementById('design-import-modal');if(!modal)return;var root=modal.getAttribute('data-project')||'';var host=modal.getAttribute('data-host')||'';var title=document.getElementById('design-import-title');var body=document.getElementById('design-import-body');var actions=document.getElementById('design-import-actions');var uStatus=document.getElementById('asset-upload-status');var currentAsset='';var currentBtn=null;var lastDesign=null;function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}function setStatus(t){if(uStatus)uStatus.textContent=t;}function post(b){return fetch('/panel/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});});}function close(){modal.style.display='none';currentAsset='';if(currentBtn)currentBtn.disabled=false;currentBtn=null;}function button(label,primary,fn){var b=document.createElement('button');b.type='button';b.className='c-button'+(primary?' c-button-primary':'');b.textContent=label;b.addEventListener('click',fn);return b;}function renderActions(design){actions.innerHTML='';if(design&&design.available){actions.appendChild(button('设计增强导入',true,applyDesign));actions.appendChild(button('更换设计来源',false,renderSource));}else{actions.appendChild(button('选择设计来源',false,renderSource));}actions.appendChild(button('普通导入',false,plainImport));actions.appendChild(button('取消',false,close));}function summaryHtml(d){var s=d&&d.report?d.report.summary:null;if(!s)return '<p>'+esc((d&&d.message)||'设计预检完成')+'</p>';var sc=s.screenStatus||{};var rs=s.rowStatus||{};return '<p>设计索引：<code>'+esc(d.indexKind||'')+'</code></p><ul><li>Excel：'+s.rows+' 行，'+s.withWireframe+' 行有 Wireframe，'+s.uniqueScreens+' 个屏名</li><li>映射：exact '+(sc.exact||0)+' · ambiguous '+(sc.ambiguous||0)+' · near '+(sc.near||0)+' · unmapped '+(sc.unmapped||0)+'</li><li>行状态：matched '+(rs.matched||0)+' · review '+(rs.review||0)+' · unmapped '+(rs.unmapped||0)+' · no-wireframe '+(rs['no-wireframe']||0)+'</li></ul><p class="muted">设计增强导入只写 exact；ambiguous 需 overrides。普通导入会保留屏名但不写 nodeId。</p>';}function plainImport(){if(!currentAsset)return;setStatus('导入中…');post({project:root,host:host,assetId:currentAsset}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已导入用例库 · 可到用例库下发');location.reload();}else{setStatus('导入失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));}}).catch(function(err){setStatus('导入失败：'+err);});}function applyDesign(){if(!currentAsset)return;setStatus('设计增强导入中…');post({project:root,host:host,assetId:currentAsset,mode:'design-apply'}).then(function(res){if(res.ok&&res.j&&res.j.ok){var n=res.j.apply&&res.j.apply.sets?res.j.apply.sets.length:0;window.aosFlash&&aosFlash('设计增强导入完成'+(n?'：'+n+' 个用例集':'')+' · 已写入审计');location.reload();return;}var j=res.j||{};if(j.needs==='info'){title.textContent='需要确认';body.innerHTML='<p>'+esc(j.error||'需要人工确认')+'</p><ul>'+(j.questions||[]).map(function(q){return '<li>'+esc(q)+'</li>';}).join('')+'</ul><p class="muted">可先到 MCP 用 overrides 确认，或改为普通导入。</p>';renderActions({available:false});setStatus('');return;}setStatus('设计增强导入失败：'+((j.error)||('HTTP '+res.status)));}).catch(function(err){setStatus('设计增强导入失败：'+err);});}function open(design){lastDesign=design;if(design&&design.hasWireframe===false){plainImport();return;}title.textContent=design&&design.available?'设计增强导入':'未找到设计索引';body.innerHTML=summaryHtml(design);renderActions(design);modal.style.display='flex';}function sourceHtml(){return '<p>选择设计来源（Figma 与 .pen 等价，都会生成 flows.json）：</p><div class="c-form"><p><label><input type="radio" name="design-source" value="figma" checked> Figma</label> <input id="design-source-figma-url" placeholder="https://www.figma.com/design/..." size="48"> <input id="design-source-figma-node" placeholder="node-id（可选）" size="14"></p><p><label><input type="radio" name="design-source" value="pen"> .pen 文件</label> <input id="design-source-pen" type="file" accept=".pen"></p><p><label><input type="radio" name="design-source" value="none"> 不使用设计稿</label></p></div><p class="muted">建议 URL 带 node-id 或填写 node-id（flow board/页面）；不填会拉整份文件，大文件可能失败。也可改用 .pen 或普通导入。</p>';}function renderSource(){title.textContent='选择设计来源';body.innerHTML=sourceHtml();actions.innerHTML='';if(lastDesign&&lastDesign.available){actions.appendChild(button('返回覆盖预览',true,function(){open(lastDesign);}));}actions.appendChild(button('提取并预览',true,extractSource));actions.appendChild(button('普通导入',false,plainImport));actions.appendChild(button('取消',false,close));}function pollDesignJob(jobId){var started=Date.now();function tick(){post({project:root,host:host,assetId:currentAsset,mode:'design-source-status',jobId:jobId}).then(function(res){var job=res.j&&res.j.job;if(!res.ok||!job){setStatus('设计提取失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));return;}if(job.status==='running'){setStatus('设计提取中… '+Math.round((Date.now()-started)/1000)+'s');setTimeout(tick,2000);return;}if(job.status==='failed'){var result=job.result||{};if(result.needs==='info'){title.textContent='需要确认';body.innerHTML='<p>'+esc(result.error||'需要人工确认')+'</p><ul>'+(result.questions||[]).map(function(q){return '<li>'+esc(q)+'</li>';}).join('')+'</ul><p class="muted">可先到 MCP 用 overrides 确认，或改为普通导入。</p>';renderActions({available:false});setStatus('');return;}setStatus('设计提取失败：'+(job.error||result.error||'未知错误'));return;}setStatus('');open((job.result&&job.result.design)||{});}).catch(function(err){setStatus('设计提取失败：'+err);});}tick();}function handleSourceResult(res){if(res.j&&res.j.jobId){pollDesignJob(res.j.jobId);return;}if(!res.ok||!res.j||!res.j.ok){setStatus('设计提取失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));return;}setStatus('');open(res.j.design||{});}function handleSourceError(err){setStatus('设计提取失败：'+err);}var pendingFigmaUrl='';function runFigmaExtract(url,nodeId){setStatus('设计提取中…');post({project:root,host:host,assetId:currentAsset,mode:'design-source',source:'figma',figmaUrl:url,nodeId:nodeId||''}).then(handleSourceResult).catch(handleSourceError);}function renderFigmaInventory(inv){title.textContent='选择 Figma 范围';var pages=inv.pages||[];var options=[];for(var i=0;i<pages.length;i++){var page=pages[i];options.push('<optgroup label="'+esc(page.name+' ('+page.type+')')+'">');options.push('<option value="'+esc(page.id)+'">整页：'+esc(page.name)+'</option>');var frames=page.frames||[];for(var j=0;j<frames.length;j++){var f=frames[j];options.push('<option value="'+esc(f.id)+'">  '+esc(f.name)+' ['+esc(f.type)+']</option>');}options.push('</optgroup>');}body.innerHTML='<p>选择要提取的页面或画板（推荐选 flow board/页面，避免整文件下载）：</p><select id="design-figma-scope" size="14" style="width:100%;font-family:inherit">'+options.join('')+'</select>'+(inv.warnings&&inv.warnings.length?'<p class="muted">'+inv.warnings.map(esc).join('<br>')+'</p>':'')+'<p class="muted">选整页会提取该页下所有画板；选单个画板只提取该子树。</p>';actions.innerHTML='';actions.appendChild(button('提取选中节点',true,extractFigmaScope));actions.appendChild(button('返回',false,renderSource));actions.appendChild(button('普通导入',false,plainImport));actions.appendChild(button('取消',false,close));}function extractFigmaScope(){var sel=document.getElementById('design-figma-scope');var id=sel?sel.value:'';if(!id){setStatus('请选择页面或画板');return;}runFigmaExtract(pendingFigmaUrl,id);}function prepareFigmaSource(url,nodeId){if(nodeId!==''){runFigmaExtract(url,nodeId);return;}if(/[?&]node-id=/.test(url)){runFigmaExtract(url,'');return;}setStatus('读取 Figma 页面/画板清单…');post({project:root,host:host,assetId:currentAsset,mode:'design-figma-list',figmaUrl:url}).then(function(res){if(!res.ok||!res.j||!res.j.ok){setStatus('读取 Figma 清单失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));return;}setStatus('');pendingFigmaUrl=url;renderFigmaInventory(res.j.inventory||{});}).catch(handleSourceError);}function extractSource(){var choices=document.getElementsByName('design-source');var source='figma';for(var i=0;i<choices.length;i++){if(choices[i].checked)source=choices[i].value;}if(source==='none'){plainImport();return;}setStatus('设计提取中…');if(source==='figma'){var url=document.getElementById('design-source-figma-url');var node=document.getElementById('design-source-figma-node');if(!url||!url.value.trim()){setStatus('请填写 Figma URL');return;}prepareFigmaSource(url.value.trim(),node?node.value.trim():'');return;}var fileInput=document.getElementById('design-source-pen');var file=fileInput&&fileInput.files?fileInput.files[0]:null;if(!file){setStatus('请选择 .pen 文件');return;}var fd=new FormData();fd.append('project',root);if(host)fd.append('host',host);fd.append('kind','reference');fd.append('file',file);fetch('/panel/api/projects/assets',{method:'POST',headers:{'X-AOS-Console':'1'},body:fd}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(!res.ok||!res.j||!res.j.ok){setStatus('上传 .pen 失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));return;}post({project:root,host:host,assetId:currentAsset,mode:'design-source',source:'pen',penAssetId:res.j.asset.id}).then(handleSourceResult).catch(handleSourceError);}).catch(handleSourceError);}window.aosDesignImport=function(assetId,btn){if(!modal)return;currentAsset=assetId;currentBtn=btn;if(btn)btn.disabled=true;setStatus('检查设计索引…');post({project:root,host:host,assetId:assetId,mode:'design-preview'}).then(function(res){if(btn)btn.disabled=false;if(!res.ok||!res.j||!res.j.ok){setStatus('设计预检失败：'+((res.j&&res.j.error)||('HTTP '+res.status)));return;}setStatus('');open(res.j.design||{});}).catch(function(err){if(btn)btn.disabled=false;setStatus('设计预检失败：'+err);});};document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('button[data-import-excel]'):null;if(!b)return;var id=b.getAttribute('data-import-excel');if(!id)return;e.preventDefault();e.stopImmediatePropagation();window.aosDesignImport(id,b);},true);modal.addEventListener('click',function(e){if(e.target===modal)close();});document.addEventListener('keydown',function(e){if(e.key==='Escape'&&modal.style.display!=='none')close();});})();</script>`;

  const activeTab: AssetsTab = data.tab ?? "overview";
  const legacy = data.tab === undefined;
  const show = (tab: AssetsTab): boolean => legacy || activeTab === tab;
  const tabHref = (tab: AssetsTab): string =>
    `/panel?project=${encodeURIComponent(data.rootPath)}&section=assets&tab=${tab}${hostQuery}`;
  const tabLabels: Array<[AssetsTab, string]> = [
    ["overview", "概览"],
    ["case-sets", "用例集"],
    ["excel", "Excel"],
    ["packages", "安装包"],
    ["materials", "测试资料"],
    ["reference", "参考图"]
  ];
  const tabBar = `<nav class="c-flow-switch" aria-label="测试资产类型">${tabLabels
    .map(([tab, label]) =>
      tab === activeTab
        ? `<span class="c-flow-option is-active" aria-current="page">${escapeHtml(label)}</span>`
        : `<a class="c-flow-option" href="${escapeHtml(tabHref(tab))}">${escapeHtml(label)}</a>`
    )
    .join("")}</nav>`;
  const uploadCard = `<div id="asset-upload">${cCard({
    title: "上传测试资产",
    subtitle: "Excel / 安装包 / 测试资料 / 参考图；上传后可在新建测试里选择",
    body: uploadBody
  })}</div>`;
  const figmaReferenceBody = [
    `<form id="figma-reference-form" class="c-form" data-project="${escapeHtml(data.rootPath)}">`,
    `<p><label>Figma URL <input id="figma-reference-url" name="figmaUrl" size="48" placeholder="https://www.figma.com/design/...?...node-id=..." aria-label="Figma URL"${disabledAttr}></label> ` +
      `<label>节点 ID（可选） <input id="figma-reference-node" name="nodeId" placeholder="1:2" aria-label="Figma 节点 ID"${disabledAttr}></label> ` +
      `<button id="figma-reference-submit" class="c-button" type="submit" data-busy-label="导入中…"${disabledAttr}>导入 Figma 参考图</button> <span id="figma-reference-status" role="status" class="muted"></span></p>`,
    `<p class="muted">需要 <code>FIGMA_ACCESS_TOKEN</code>；只导入 URL 指定 node（或填节点 ID）的 PNG。导入后按参考图资产保存。</p>`,
    `</form>`,
    actionsReason
  ].join("\n");
  const figmaReferenceCard = cCard({
    title: "从 Figma 导入参考图",
    subtitle: "按 frame/node 渲染 PNG，保留 Figma URL 与 nodeId 来源",
    body: figmaReferenceBody
  });
  const figmaReferenceScript = actionsOff
    ? ""
    : `<script>(function(){var root=${JSON.stringify(data.rootPath).replace(/</g, "\\u003c")};var host=${JSON.stringify(data.hostId ?? null).replace(/</g, "\\u003c")};var form=document.getElementById('figma-reference-form');if(!form)return;var status=document.getElementById('figma-reference-status');var btn=document.getElementById('figma-reference-submit');form.addEventListener('submit',function(e){e.preventDefault();var url=document.getElementById('figma-reference-url').value.trim();var node=document.getElementById('figma-reference-node').value.trim();if(!url){if(status)status.textContent='请填写 Figma URL';return;}if(btn)btn.disabled=true;fetch('/panel/api/projects/assets/figma',{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify({project:root,host:host,figmaUrl:url,nodeId:node})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('已导入 Figma 参考图 '+res.j.asset.filename+' · 已写入审计');location.reload();return;}if(btn)btn.disabled=false;if(status)status.textContent='导入失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}).catch(function(err){if(btn)btn.disabled=false;if(status)status.textContent='导入失败：'+err;});});})();</script>`;
  const overviewCard = cCard({
    title: "资产概览",
    subtitle: "所有测试输入都在这里；用例集与测试资产统一管理",
    body: [
      '<div class="cards">',
      `<div class="card"><div class="k">用例集</div><div class="v">${data.sets?.length ?? 0}</div><div class="muted"><a href="${escapeHtml(
        tabHref("case-sets")
      )}">查看用例集</a></div></div>`,
      `<div class="card"><div class="k">Excel 文档</div><div class="v">${data.assets.length}</div><div class="muted"><a href="${escapeHtml(
        tabHref("excel")
      )}">查看 Excel</a></div></div>`,
      `<div class="card"><div class="k">安装包</div><div class="v">${packages.length}</div><div class="muted"><a href="${escapeHtml(
        tabHref("packages")
      )}">查看安装包</a></div></div>`,
      `<div class="card"><div class="k">测试资料</div><div class="v">${materials.length}</div><div class="muted"><a href="${escapeHtml(
        tabHref("materials")
      )}">查看资料</a></div></div>`,
      `<div class="card"><div class="k">参考图</div><div class="v">${references.length}</div><div class="muted"><a href="${escapeHtml(
        tabHref("reference")
      )}">查看参考图</a></div></div>`,
      "</div>",
      '<p class="muted">下一步：去 <a href="/panel?project=' +
        encodeURIComponent(data.rootPath) +
        '&amp;section=create">新建测试</a> 开始套件回归。</p>'
    ].join("")
  });
  const excelCard = `<div id="excel-assets">${cCard({
    title: "Excel 文档",
    subtitle: `共 ${data.assets.length} 个 Excel 版本`,
    body: cTable({
      columns: ["文件名", "版本", "大小", "sha256", "上传时间", "被使用", "操作"],
      rows: assetRows,
      caption: "Excel 资产版本",
      empty: "暂无 Excel 资产（上方上传）"
    })
  })}</div>`;
  const mappingCard = cCard({
    title: "列映射",
    subtitle: "预览表头并保存规范字段映射（同指纹复用，不重复登记）",
    body: mappingBody
  });
  const mappingsCard = cCard({
    title: "已保存映射",
    subtitle: `共 ${data.mappings.length} 条`,
    body: cTable({
      columns: ["资产", "工作表", "已映射字段", "指纹", "保存人", "保存时间"],
      rows: mappingRows,
      caption: "Excel 列映射",
      empty: "暂无已保存映射（预览后保存生成）"
    })
  });
  const packageCard = `<div id="package-assets">${cCard({
    title: "安装包",
    subtitle: `共 ${packages.length} 个 APK/IPA 版本（Android/iOS 各自编号）`,
    body: cTable({
      columns: ["文件名", "平台", "版本", "大小", "sha256", "上传时间", "被使用", "打开"],
      rows: packageRows,
      caption: "安装包资产版本",
      empty: "暂无安装包资产（上方上传）"
    })
  })}</div>`;
  const materialsCard = `<div id="materials-assets">${cCard({
    title: "测试资料",
    subtitle: `共 ${materials.length} 个资料版本`,
    body: cTable({
      columns: ["文件名", "版本", "大小", "secret", "sha256", "上传时间", "被使用", "打开"],
      rows: materialRows,
      caption: "测试资料资产版本",
      empty: "暂无测试资料（上方上传）"
    })
  })}</div>`;
  const referenceCard = `<div id="reference-assets">${cCard({
    title: "参考图（L2）",
    subtitle: `共 ${references.length} 个参考图版本`,
    body: cTable({
      columns: ["文件名", "版本", "大小", "sha256", "上传时间", "被使用", "打开"],
      rows: referenceRows,
      caption: "参考图资产版本",
      empty: "暂无参考图（上方上传 .png/.jpg/.jpeg/.webp）"
    })
  })}</div>`;
  const sections: string[] = [
    "<h1>测试资产</h1>",
    tabBar,
    archived
      ? `<p>${cBadge({ label: "已归档", tone: "warning", title: "status=archived" })} 归档项目只读：上传与映射保存已禁用。</p>`
      : "",
    `<p class="muted">Excel、安装包（APK/IPA）、测试资料与 L2 参考图统一管理；用例集也在同一个资产中心。</p>`
  ];
  if (show("overview")) sections.push(overviewCard);
  sections.push(uploadCard);
  if (show("excel")) sections.push(excelCard, mappingCard, mappingsCard);
  if (show("packages")) sections.push(packageCard);
  if (show("materials")) sections.push(materialsCard);
  if (show("reference")) sections.push(referenceCard, figmaReferenceCard);
  sections.push(script);
  sections.push(designImportDialog);
  sections.push(designImportScript);
  if (show("reference")) sections.push(figmaReferenceScript);

  return renderConsoleShell({
    title: "测试资产",
    active: "assets",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: sections.filter((part) => part !== "").join("\n")
  });
}

export interface CreateTestPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  projectStatus?: "active" | "archived" | null;
  caseSetCount: number;
  excelCount: number;
  packageCount: number;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderCreateTestPage(data: CreateTestPageData): string {
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const projectQuery = `project=${encodeURIComponent(data.rootPath)}`;
  const assetsHref = `/panel?${projectQuery}&section=assets${hostQuery}`;
  const suiteHref = `/panel?${projectQuery}&section=create&type=suite${hostQuery}`;
  const suiteReady = data.caseSetCount > 0;
  const suiteBody = [
    `<p>用已有用例集在设备上跑回归；可在下一步<strong>选择安装包</strong>，执行机自动安装；不选则要求设备已安装。</p>`,
    `<p class="muted">用例集 ${data.caseSetCount} 份${suiteReady ? "" : " · 还没有用例集"}</p>`,
    suiteReady
      ? `<p><a class="c-button c-button-primary" href="${escapeHtml(suiteHref)}">开始套件回归</a></p>`
      : `<p><a class="c-button c-button-primary" href="${escapeHtml(
          `/panel?${projectQuery}&section=assets&tab=case-sets${hostQuery}`
        )}">先去导入用例集</a></p>`,
    `<p class="muted">执行机与设备在下一步选择。</p>`
  ].join("");
  return renderConsoleShell({
    title: "新建测试",
    active: "create",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>新建测试</h1>",
      `<p class="muted">目前新建测试只有套件回归：用例集 + 设备。测试资产统一在 <a href="${escapeHtml(
        assetsHref
      )}">测试资产</a> 管理。</p>`,
      '<div class="c-stats-row">',
      cStat({ label: "用例集", value: String(data.caseSetCount), hint: "可引用" }),
      cStat({ label: "Excel 资产", value: String(data.excelCount), hint: "用例导入源" }),
      cStat({ label: "安装包", value: String(data.packageCount), hint: "可选自动安装" }),
      "</div>",
      '<div class="cards">',
      cCard({
        title: "套件回归",
        subtitle: "用例集 + 设备；可选安装包",
        body: suiteBody
      }),
      "</div>"
    ].join("\n")
  });
}

export interface TasksPageData {
  rootPath: string;
  rootLabel: string;
  hostId?: string | null;
  projectStatus?: "active" | "archived" | null;
  tasks: RegressionTaskRecord[];
  filter?: "all" | "active";
  query?: string;
  page?: number;
  pageSize?: number;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderTasksPage(data: TasksPageData): string {
  const hostQuery = data.hostId ? `&host=${encodeURIComponent(data.hostId)}` : "";
  const projectQuery = `project=${encodeURIComponent(data.rootPath)}`;
  const tasksUrl = (extra = ""): string => `/panel?${projectQuery}&section=tasks${extra}${hostQuery}`;
  const createHref = `/panel?${projectQuery}&section=create${hostQuery}`;
  const query = (data.query ?? "").trim().toLowerCase();
  const visible = data.tasks.filter((task) => {
    if (task.jobSpec !== null) return false;
    if (
      data.filter === "active" &&
      !["pending", "claimed", "running", "stopping"].includes(task.status)
    ) {
      return false;
    }
    if (query === "") return true;
    const haystack = [
      task.id,
      task.status,
      task.claimedHostId ?? "",
      task.targetHostId ?? "",
      task.deviceSerial ?? "",
      task.platforms.join(" "),
      ...task.refs.map((ref) => ref.caseSetId ?? "")
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
  const pageSize = Math.max(1, data.pageSize ?? 25);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(data.page ?? 1)), totalPages);
  const pageItems = visible.slice((page - 1) * pageSize, page * pageSize);
  const pageHref = (target: number): string => {
    const params = new URLSearchParams();
    params.set("project", data.rootPath);
    params.set("section", "tasks");
    if (data.hostId) params.set("host", data.hostId);
    if (data.filter === "active") params.set("filter", "active");
    if ((data.query ?? "").trim() !== "") params.set("q", data.query!.trim());
    if (target > 1) params.set("page", String(target));
    return `/panel?${params.toString()}`;
  };
  const pager =
    totalPages > 1
      ? `<nav class="c-flow-switch" aria-label="任务分页">${
          page > 1
            ? `<a class="c-flow-option" href="${escapeHtml(pageHref(page - 1))}">上一页</a>`
            : '<span class="c-flow-option is-disabled">上一页</span>'
        }<span class="c-flow-option is-active" aria-current="page">第 ${page}/${totalPages} 页</span>${
          page < totalPages
            ? `<a class="c-flow-option" href="${escapeHtml(pageHref(page + 1))}">下一页</a>`
            : '<span class="c-flow-option is-disabled">下一页</span>'
        }</nav>`
      : "";
  const rows = pageItems.map((task) => {
    const detail = `/panel?${projectQuery}&section=tasks&task=${encodeURIComponent(
      task.id
    )}${hostQuery}`;
    return [
      `<a href="${escapeHtml(detail)}"><code>${escapeHtml(task.id.slice(0, 12))}</code></a>`,
      cBadge({
        label: `P${task.priority}`,
        tone: task.priority > 0 ? "warning" : "neutral",
        title: "优先级（越大越先领取）"
      }),
      cBadge({ label: taskStatusLabel(task.status), tone: taskStatusTone(task.status) }),
      escapeHtml(data.rootLabel),
      `<span class="muted">${escapeHtml(task.claimedHostId ?? task.targetHostId ?? "—")} · ${escapeHtml(
        task.deviceSerial ?? "—"
      )}</span>`,
      escapeHtml(`${task.refs.length} 份用例集`),
      `<span title="${escapeHtml(task.createdAt)}">${relativeTime(task.createdAt)}</span>`,
      escapeHtml(`${task.runIds.length} 次运行`),
      `<a class="c-button" href="${escapeHtml(detail)}">详情</a>`
    ];
  });
  const tabs = [
    ["全部", tasksUrl(), data.filter !== "active"],
    ["进行中", tasksUrl("&filter=active"), data.filter === "active"]
  ] as const;
  const tabBar = `<nav class="c-flow-switch" aria-label="任务视图">${tabs
    .map(([label, href, active]) =>
      active
        ? `<span class="c-flow-option is-active" aria-current="page">${escapeHtml(label)}</span>`
        : `<a class="c-flow-option" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    )
    .join("")}<a class="c-flow-option" href="${escapeHtml(
    tasksUrl("&view=review")
  )}">待处理失败</a></nav>`;
  return renderConsoleShell({
    title: "任务与结果",
    active: "tasks",
    meta: `项目 <code>${escapeHtml(data.rootLabel)}</code>`,
    project: data.rootPath,
    projectHostId: data.hostId ?? null,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth,
    body: [
      "<h1>任务与结果</h1>",
      tabBar,
      `<p class="muted">套件回归任务与结果：状态、执行机、输入和结果同表。 <a class="c-button" href="${escapeHtml(
        createHref
      )}">新建测试</a></p>`,
      `<form method="get" action="/panel" class="c-form" role="search"><input type="hidden" name="project" value="${escapeHtml(
        data.rootPath
      )}"><input type="hidden" name="section" value="tasks">${
        data.hostId ? `<input type="hidden" name="host" value="${escapeHtml(data.hostId)}">` : ""
      }<p><label>搜索任务 <input name="q" value="${escapeHtml(
        data.query ?? ""
      )}" placeholder="任务 ID / 状态 / 设备" aria-label="搜索任务"></label> <button class="c-button" type="submit">搜索</button></p></form>`,
      cCard({
        title: "任务列表",
        subtitle: `共 ${visible.length} 条${data.filter === "active" ? "（进行中）" : ""}${
          totalPages > 1 ? ` · 第 ${page}/${totalPages} 页` : ""
        }`,
        body: cTable({
          columns: ["任务", "优先级", "状态", "项目", "执行机/设备", "输入", "创建", "结果", "操作"],
          rows,
          caption: "任务与结果",
          emptyHtml: `还没有任务。 <a class="c-button c-button-primary" href="${escapeHtml(
            createHref
          )}">新建测试</a>`
        })
      }),
      pager
    ].join("\n")
  });
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
  rootPath?: string | null;
  rootLabel?: string | null;
  hostId?: string | null;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

const TASK_STATUS_LABELS: Record<string, string> = {
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

function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

function taskStatusTone(status: string): "neutral" | "accent" | "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "claimed" || status === "running") return "accent";
  if (status === "pending" || status === "partial" || status === "stopping") return "warning";
  return "neutral";
}

function devicesHref(
  platform: string,
  state: string,
  rootPath?: string | null,
  hostId?: string | null
): string {
  const params = new URLSearchParams({ section: "devices" });
  if (rootPath) params.set("project", rootPath);
  if (hostId) params.set("host", hostId);
  if (platform !== "all") params.set("platform", platform);
  if (state !== "all") params.set("state", state);
  return `/panel?${params.toString()}`;
}

export function renderDevicesPage(data: DevicesPageData): string {
  const filterLink = (label: string, state: string, platform = data.platform): string => {
    const active = data.filter === state && data.platform === platform;
    return `<a class="c-button${active ? " c-button-primary" : ""}" href="${escapeHtml(
      devicesHref(platform, state, data.rootPath, data.hostId)
    )}"${active ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
  };
  const platformLink = (label: string, platform: string): string => {
    const active = data.platform === platform;
    return `<a class="c-button${active ? " c-button-primary" : ""}" href="${escapeHtml(
      devicesHref(platform, data.filter, data.rootPath, data.hostId)
    )}"${active ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
  };
  const rows = data.devices.map((device) => {
    const stateBadge =
      device.state === "idle"
        ? cBadge({ label: "空闲", tone: "success" })
        : device.state === "busy"
          ? cBadge({ label: "占用", tone: "warning" })
          : cBadge({ label: "离线", tone: "error" });
    const host = `<div class="c-device-host">${device.hostOnline ? cBadge({ label: "在线", tone: "success" }) : cBadge({ label: "离线", tone: "error" })}<code title="${escapeHtml(device.hostId)}">${escapeHtml(device.hostId)}</code></div><div class="c-device-hostname" title="${escapeHtml(device.hostname)}">${escapeHtml(device.hostname)}</div>`;
    const toolNames = Object.entries(device.tools)
      .filter(([, ok]) => ok === true)
      .map(([name]) => `<span class="chip">${escapeHtml(name)}</span>`)
      .join("");
    const tools = toolNames === "" ? '<span class="muted">—</span>' : `<div class="c-device-tools">${toolNames}</div>`;
    const deviceLabel = `<div class="c-device-kind">${escapeHtml(device.platform)} · ${escapeHtml(device.kind)}</div><code class="c-device-serial" title="${escapeHtml(device.serial)}">${escapeHtml(device.serial)}</code>`;
    const model = [device.model, device.osVersion].filter((value) => value !== null).map(String).join(" · ") || "—";
    const job =
      device.jobTaskId === null
        ? '<span class="muted">—</span>'
        : device.jobRootPath === null
          ? `<code>${escapeHtml(device.jobTaskId)}</code><br><span class="muted">${escapeHtml(device.jobStatus ?? "")}</span>`
          : `<a href="/panel?project=${encodeURIComponent(device.jobRootPath)}&amp;section=tasks&amp;task=${encodeURIComponent(device.jobTaskId)}&amp;host=${encodeURIComponent(device.hostId)}"><code>${escapeHtml(device.jobTaskId)}</code></a><br><span class="muted">${escapeHtml(device.jobProjectName ?? "")} · ${escapeHtml(device.jobStatus ?? "")}</span>`;
    const lease =
      device.leaseTaskId === null
        ? '<span class="muted">—</span>'
        : `${relativeTime(device.leaseExpiresAt ?? "")} <span class="muted">到期</span>`;
    const dispatchHref =
      data.rootPath === null || data.rootPath === undefined
        ? null
        : `/panel?project=${encodeURIComponent(
            data.rootPath
          )}&section=create&type=suite&source=case-set&host=${encodeURIComponent(
            device.hostId
          )}&platforms=${encodeURIComponent(device.platform)}`;
    const action =
      dispatchHref === null
        ? '<span class="muted">—</span>'
        : `<a class="c-button" href="${escapeHtml(
            dispatchHref
          )}" title="进入套件回归；设备由执行机自动选择">去下发</a>`;
    return [
      host,
      deviceLabel,
      escapeHtml(model),
      stateBadge,
      action,
      job,
      lease,
      relativeTime(device.lastSeenAt),
      tools || '<span class="muted">—</span>'
    ];
  });
  const total = data.counts.total;
  const filterBar = `<div class="c-filterbar" aria-label="设备筛选">
    <div class="c-filter-group"><span class="c-filter-label">状态</span>${[
      filterLink("全部", "all"),
      filterLink("空闲", "idle"),
      filterLink("占用", "busy"),
      filterLink("离线", "offline")
    ].join("")}</div>
    <div class="c-filter-group"><span class="c-filter-label">平台</span>${[
      platformLink("全部平台", "all"),
      platformLink("Android", "android"),
      platformLink("iOS", "ios")
    ].join("")}</div>
    <span class="c-filter-count">${data.devices.length} / ${total} 台</span>
  </div>`;
  const emptyState =
    total === 0
      ? `<section class="c-empty c-device-empty">
          <h2>还没有设备宿主</h2>
          <p>下载 MCP runner 到设备宿主，在宿主本机执行 <code>mobile_run_task</code> / <code>suite run</code>；或只暴露 adb（adb-host）由中心直连。</p>
          <div class="c-empty-action">
            <a class="c-button c-button-primary" href="#runner-download">下载 MCP runner / adb-host</a>
            <details class="c-device-help">
              <summary class="c-button">查看接入说明</summary>
              <div class="c-device-help-body">
                <ol>
                  <li>下载 <strong>MCP runner</strong>（Windows/macOS）并在宿主运行 <code>setup</code>；或只下载 <a href="/panel/runner-toolchain">platform-tools</a>（adb）走远程 adb。</li>
                  <li>运行 <code>adb -a -P 5037 server nodaemon</code>（防火墙只放行 MCP 服务 IP，或改用 SSH 隧道）。</li>
                  <li>在 MCP 项目配置 <code>ADB_SERVER_SOCKET=tcp:&lt;宿主IP&gt;:5037</code>。</li>
                  <li>用 <code>run_regression</code> / <code>mobile_run_task</code> 执行；无需 runner。</li>
                  <li>iOS 模拟器：在 MCP 所在 macOS 启动模拟器；iOS 真机：Mac 宿主运行 Appium/WDA + Remote XPC 隧道，然后同样用 <code>mobile_run_task</code>。</li>
                </ol>
                <pre class="c-command"><code>adb -a -P 5037 server nodaemon
# 项目 .env
ADB_SERVER_SOCKET=tcp:&lt;宿主IP&gt;:5037</code></pre>
              </div>
            </details>
          </div>
        </section>`
      : cTable({
          columns: ["执行机", "设备", "型号/系统", "状态", "操作", "当前任务", "租约", "最后心跳", "工具"],
          mobileCards: true,
          rows,
          caption: `设备列表（${data.devices.length}）`,
          emptyHtml:
            '<span class="muted">当前筛选下没有设备。</span> <a href="/panel?section=devices">清除筛选</a>'
        });
  const aside = `<aside class="c-device-aside" id="runner-guide" aria-label="设备接入说明">
    <section class="c-card" id="runner-download">
      <h2 class="c-card-title">接入执行机（Android / iOS）</h2>
      <p class="c-card-subtitle"><strong>MCP runner</strong> 在宿主本机运行 MCP 执行代码：中心下发任务，runner 用本机 adb / 模拟器执行并回传结果。Windows 跑 Android；macOS 跑 iOS（模拟器/真机）和 Android。</p>
      <p class="c-card-subtitle c-card-subtitle-tight">LLM 由中心代理提供（runner 只拿 runner token），真实 provider key 不出中心；runner 本机不需要填 LLM key。</p>
      <p class="c-card-subtitle c-card-subtitle-tight">手机直接插在 MCP 服务所在的 Mac 时，用系统 adb 即可，不需要下载包。</p>
      <p class="c-card-subtitle c-card-subtitle-tight">前置：Node 20+、uv、Python 3.12；iOS 还需要 Xcode、Appium + xcuitest、签名团队与 iOS 18+ Remote XPC 隧道。包内含 adb、MCP 代码与 Artemis 源码。</p>
      <div class="c-download-grid" aria-label="MCP runner 安装包下载">
        <a class="c-button c-button-primary" href="/panel/runner-bundle?role=mcp-runner&amp;platform=win32&amp;arch=x64" download>Windows MCP runner（Android）</a>
        <a class="c-button c-button-primary" href="/panel/runner-bundle?role=mcp-runner&amp;platform=darwin&amp;arch=arm64" download>macOS MCP runner（iOS/Android）</a>
      </div>
      <p class="c-card-subtitle c-card-subtitle-tight">公司网络无法访问 PyPI 时，用 Windows 离线版（内置依赖，约 300MB；解压后约 850MB）。</p>
      <div class="c-download-grid" aria-label="Windows 离线 runner 下载">
        <a class="c-button" href="/panel/runner-bundle?role=mcp-runner&amp;platform=win32&amp;arch=x64&amp;variant=offline" download>Windows 离线版（内置依赖，约 300MB）</a>
      </div>
      <p class="c-card-subtitle c-card-subtitle-tight">只把手机插在远端、由中心直接连 adb 时，仍可用 adb-host 小包（只含 platform-tools）。</p>
      <div class="c-download-grid" aria-label="adb-host 安装包下载">
        <a class="c-button" href="/panel/runner-bundle?role=adb-host&amp;platform=win32&amp;arch=x64" download>Windows adb-host（约 8MB）</a>
        <a class="c-button" href="/panel/runner-bundle?role=adb-host&amp;platform=darwin&amp;arch=arm64" download>macOS adb-host（约 16MB）</a>
      </div>
      <a class="c-button" href="/panel/runner-toolchain">单独下载 platform-tools / 依赖工具</a>
    </section>
    <section class="c-card" id="runner-artifacts" aria-label="执行机产物服务说明">
      <h2 class="c-card-title">产物服务（中心打开批次/证据）</h2>
      <p class="c-card-subtitle">runner 默认在 <code>0.0.0.0:8770</code> 提供只读产物服务；中心要能访问它才能打开批次清单、trace 与截图。面板显示「未广播产物基址」时按下面检查。</p>
      <ol class="c-card-subtitle">
        <li>Windows 管理员 PowerShell 放行 8770（建议只允许中心 IP）：<br><code>New-NetFirewallRule -DisplayName "mobile-testing runner artifacts" -Direction Inbound -Protocol TCP -LocalPort 8770 -RemoteAddress &lt;中心IP&gt; -Action Allow</code></li>
        <li>多网卡/NAT/VPN 时，优先用中心可解析的主机名/DNS 名（不要长期写死 IP）：<br><code>AOS_RUNNER_ADVERTISE_URL=http://&lt;中心可解析的主机名&gt;:8770</code></li>
        <li>port 被占用时改 <code>AOS_RUNNER_ARTIFACT_PORT=8771</code> 并同步 <code>AOS_RUNNER_ADVERTISE_URL</code> 与防火墙端口；设 <code>0</code> 则关闭产物服务。</li>
        <li>改完重启 <code>runner.cmd</code>，中心执行机列表的「产物基址」应显示 URL。</li>
      </ol>
    </section>
    <section class="c-card" id="ios-device-guide" aria-label="iOS 设备接入说明">
      <h2 class="c-card-title">iOS 设备</h2>
      <p class="c-card-subtitle"><strong>iOS 模拟器</strong>：在 macOS MCP runner 所在机器上（simctl/idb）；下载 macOS MCP runner，启动模拟器后把 UDID 传给 <code>mobile_run_task</code>。</p>
      <p class="c-card-subtitle"><strong>iOS 真机</strong>：iPhone 必须连接 Mac，不能插 Windows；在 macOS MCP runner 上运行 Appium/WDA，配 <code>AOS_IOS_XCODE_ORG_ID</code>（必填）与 <code>AOS_APPIUM_URL</code>（可选），iOS 18+ 保持 Remote XPC 隧道。用 <code>mobile_run_task</code> 执行。</p>
      <p class="c-card-subtitle">iOS 不使用 adb-host。签名/隧道细节见 README「iOS 真机」。</p>
    </section>
    <section class="c-card">
      <h2 class="c-card-title">状态口径</h2>
      <dl class="c-status-legend">
        <div><dt>空闲</dt><dd>执行机在线、无有效租约、无进行中的任务</dd></div>
        <div><dt>占用</dt><dd>存在未过期租约，或任务正在执行</dd></div>
        <div><dt>离线</dt><dd>执行机心跳超过 TTL 未更新</dd></div>
      </dl>
      <p class="c-card-subtitle c-card-subtitle-tight">页面加载时快照；刷新查看最新状态。</p>
    </section>
  </aside>`;
  const body = `
    <div class="c-page-head">
      <div>
        <h1>设备</h1>
        <p class="c-page-lede">Android 走 MCP runner（Windows）/ 本机 adb，iOS 走 macOS MCP runner（模拟器 simctl/idb、真机 Appium/WDA）。</p>
        ${
          data.rootPath
            ? `<p class="muted">当前项目：<a href="/panel?project=${encodeURIComponent(
                data.rootPath
              )}">${escapeHtml(data.rootLabel ?? data.rootPath)}</a> · <a href="/panel?project=${encodeURIComponent(
                data.rootPath
              )}&amp;section=create&amp;type=suite">新建测试</a></p>`
            : ""
        }
      </div>
      <div class="c-page-actions">
        <a class="c-button" href="${escapeHtml(
          devicesHref(data.platform, data.filter, data.rootPath, data.hostId)
        )}">刷新</a>
      </div>
    </div>
    <div class="c-stat-grid">${[
      cStat({ label: "设备", value: String(data.counts.total), hint: "已注册" }),
      cStat({ label: "空闲", value: String(data.counts.idle), hint: "可立即领取" }),
      cStat({ label: "占用", value: String(data.counts.busy), hint: "租约或任务执行中" }),
      cStat({ label: "离线", value: String(data.counts.offline), hint: "执行机心跳超时" })
    ].join("")}</div>
    <div class="c-device-layout">
      <div class="c-device-main">
        ${filterBar}
        ${emptyState}
      </div>
      ${aside}
    </div>`;
  return renderConsoleShell({
    title: "设备",
    active: "devices",
    body,
    capabilities: data.capabilities,
    storeHealth: data.storeHealth
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
  const caseSetBase = (title: string): string =>
    title.replace(/\.source\.xlsx$/i, "").replace(/\.(md|xlsx|json|csv)$/i, "");
  const formatRank = (title: string): number => {
    if (/\.md$/i.test(title)) return 0;
    if (/\.xlsx$/i.test(title) && !/\.source\.xlsx$/i.test(title)) return 1;
    if (/\.json$/i.test(title)) return 2;
    if (/\.source\.xlsx$/i.test(title)) return 3;
    return 4;
  };
  const formatLabel = (title: string): string => {
    if (/\.source\.xlsx$/i.test(title)) return "源 Excel";
    const ext = path.extname(title).slice(1).toUpperCase();
    return ext === "" ? "文件" : ext;
  };
  interface ArtifactGroup {
    kind: ArtifactRecord["kind"];
    name: string;
    records: ArtifactRecord[];
    at: string;
    size: number;
    isDir: boolean;
  }
  const groups = new Map<string, ArtifactGroup>();
  for (const record of data.artifacts) {
    const caseSet = record.kind === "case-set" && record.meta?.type !== "dir";
    const key = caseSet
      ? `case-set:${caseSetBase(record.title)}`
      : `${record.kind}:${record.path}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        kind: record.kind,
        name: caseSet ? caseSetBase(record.title) : record.title,
        records: [record],
        at: record.at,
        size: record.size,
        isDir: record.meta?.type === "dir"
      });
    } else {
      existing.records.push(record);
      if (record.at > existing.at) existing.at = record.at;
      existing.size += record.size;
      if (record.meta?.type === "dir") existing.isDir = true;
    }
  }
  const rows = [...groups.values()]
    .sort((left, right) => right.at.localeCompare(left.at) || left.name.localeCompare(right.name))
    .map((group) => {
      const primary =
        group.records.find((record) => /\.md$/i.test(record.title)) ?? group.records[0]!;
      const isDir = group.isDir;
      const isImage = !isDir && /\.(png|jpe?g|webp|gif)$/i.test(primary.title);
      const thumb = isImage
        ? `<img class="c-thumb" src="${escapeHtml(artifactUrl(primary))}" alt="" loading="lazy">`
        : "";
      const caseSet = group.kind === "case-set" && !isDir;
      const name = caseSet
        ? [
            `<div class="c-artifact-name">${escapeHtml(group.name)}</div>`,
            `<div class="c-file-chips">${[...group.records]
              .sort((left, right) => formatRank(left.title) - formatRank(right.title))
              .map(
                (record) =>
                  `<a class="c-file-chip${
                    /\.source\.xlsx$/i.test(record.title) ? " c-file-chip-source" : ""
                  }" href="${escapeHtml(artifactUrl(record))}" title="${escapeHtml(
                    record.path
                  )}">${escapeHtml(formatLabel(record.title))}</a>`
              )
              .join("")}</div>`
          ].join("")
        : `${thumb}${
            isDir
              ? `<code>${escapeHtml(group.name)}</code>`
              : `<a href="${escapeHtml(artifactUrl(primary))}" target="_blank" rel="noreferrer"><code>${escapeHtml(
                  group.name
                )}</code></a>`
          }`;
      const location = caseSet
        ? `<code class="c-path">${escapeHtml(path.dirname(primary.path))}</code>`
        : isDir
          ? `<code class="c-path">${escapeHtml(primary.path)}</code>`
          : `<a href="${escapeHtml(artifactUrl(primary))}" target="_blank" rel="noreferrer"><code class="c-path">${escapeHtml(
              primary.path
            )}</code></a>`;
      const size =
        isDir
          ? "目录"
          : caseSet
            ? `${group.records.length} 文件 · ${formatBytes(group.size)}`
            : formatBytes(group.size);
      return [
        cBadge({ label: artifactKindLabel(group.kind), tone: "neutral", title: group.kind }),
        name,
        location,
        relativeTime(group.at),
        size
      ];
    });
  const q = (name: string): string => escapeHtml(data.query[name] ?? "");
  const archiveLink = (patch: Record<string, string | null>): string => {
    const params = new URLSearchParams({ project: data.rootPath, section: "archive" });
    if (data.hostId) params.set("host", data.hostId);
    for (const key of ["kind", "q", "since", "task", "run", "case"]) {
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
  } 页 · 本页 ${groups.size} 组 · ${data.artifacts.length} 个文件</span> ${
    nextHref === null
      ? '<span class="muted">下一页</span>'
      : `<a class="c-button" href="${nextHref}">下一页</a>`
  }</div>`;
  const preset = (label: string, hours: number): string =>
    `<a class="c-button" href="${archiveLink({ since: new Date(Date.now() - hours * 3600_000).toISOString() })}">${label}</a>`;
  const csvParams = new URLSearchParams({ project: data.rootPath, format: "csv" });
  if (data.hostId) csvParams.set("host", data.hostId);
  for (const key of ["kind", "q", "since", "task", "run", "case"]) {
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
          ...["task", "run", "case"].flatMap((key) =>
            data.query[key]
              ? [`<input type="hidden" name="${key}" value="${escapeHtml(data.query[key])}">`]
              : []
          ),
          data.query.task || data.query.run || data.query.case
            ? `<p class="muted">关联过滤：${[
                data.query.task ? `任务 <code>${escapeHtml(data.query.task)}</code>` : "",
                data.query.run ? `运行 <code>${escapeHtml(data.query.run)}</code>` : "",
                data.query.case ? `用例 <code>${escapeHtml(data.query.case)}</code>` : ""
              ]
                .filter((part) => part !== "")
                .join(" · ")} · <a href="${archiveLink({
                task: null,
                run: null,
                case: null,
                offset: "0"
              })}">清除关联过滤</a></p>`
            : "",
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
        } 页 · 本页 ${groups.size} 组 · ${data.artifacts.length} 个文件 · 每页 ${data.page.pageSize} 项 · 与保留期同源（六类浅扫：批次/用例集/报告/差异/崩溃/轨迹）`,
        body: [
          cTable({
            columns: ["类型", "名称", "位置", "更新时间", "大小"],
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
      return `<a href="/panel?${base}&amp;section=tasks&amp;task=${encodeURIComponent(value)}" title="taskId=${escapeHtml(value)}">任务 <code>${escapeHtml(short)}</code></a>`;
    }
    if (key === "caseSetId") {
      return `<a href="/panel?${base}&amp;section=assets&amp;tab=case-sets" title="caseSetId=${escapeHtml(value)}">用例库 <code>${escapeHtml(short)}</code></a>`;
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
      return `<a href="/panel?${base}&amp;section=create&amp;type=suite">重新打开下发预览</a>`;
    }
    if (event.action === "action.jobs") {
      return `<a href="/panel?${base}&amp;section=tasks">查看任务记录</a>`;
    }
    if (event.action === "action.issues") {
      return `<a href="/panel?${base}&amp;section=tasks&amp;view=stats#issues">去建单</a>`;
    }
    if (event.action === "action.import") {
      return `<a href="/panel?${base}&amp;section=assets&amp;tab=case-sets">去用例库导入</a>`;
    }
    if (event.action === "action.verdicts") {
      return `<a href="/panel?${base}&amp;section=tasks&amp;view=review">去归因队列</a>`;
    }
    if (event.action === "action.quarantine") {
      return `<a href="/panel?${base}&amp;section=assets&amp;tab=case-sets">去隔离</a>`;
    }
    if (event.action === "action.config") {
      return `<a href="/panel?${base}&amp;section=ops">去项目配置</a>`;
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
    for (const key of ["domain", "result", "since", "q"]) {
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
            .join("")}</select> 关键词 <input type="text" name="q" aria-label="审计关键词" value="${escapeHtml(
            data.query.q ?? ""
          )}" placeholder="动作/摘要/操作人/关联对象"> 起自 <input type="datetime-local" name="since" aria-label="起自（本地时间）" value="${sinceLocalValue(data.query.since)}"> <button class="c-button" type="submit">筛选</button></p>`,
          `<p>时间预设：${preset("近 24 小时", 24)} ${preset("近 7 天", 168)} ${preset("近 30 天", 720)} ${
            data.query.since !== undefined && data.query.since !== ""
              ? `<a class="c-button" href="${link({ since: null, offset: "0" })}">清除时间</a>`
              : ""
          } ${
            data.query.q !== undefined && data.query.q !== ""
              ? `<a class="c-button" href="${link({ q: null, offset: "0" })}">清除关键词</a>`
              : ""
          }</p>`,
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
    projectName: string;
    hostId: string | null;
    id: string;
    basename: string;
    source: string;
    features: string;
  }>;
  tasks: Array<{
    project: string;
    projectName: string;
    hostId: string | null;
    id: string;
    status: string;
  }>;
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
    projectLink(entry.projectName, entry.project, entry.hostId),
    `<code>${escapeHtml(entry.basename)}</code>`,
    escapeHtml(entry.source),
    escapeHtml(entry.features),
    `<a class="c-button" href="/panel?project=${encodeURIComponent(entry.project)}&amp;section=create&amp;type=suite&amp;source=case-set&amp;ref=${encodeURIComponent(entry.id)}${hostQuery(entry.hostId).replace(/&/g, "&amp;")}">下发该用例集</a> <a class="c-button" href="/panel?project=${encodeURIComponent(entry.project)}&amp;section=assets&amp;tab=case-sets${hostQuery(entry.hostId).replace(/&/g, "&amp;")}">用例库</a>`
  ]);
  const taskRows = data.tasks.map((entry) => [
    projectLink(entry.projectName, entry.project, entry.hostId),
    `<a href="/panel?project=${encodeURIComponent(entry.project)}&amp;section=tasks&amp;task=${encodeURIComponent(entry.id)}${hostQuery(entry.hostId).replace(/&/g, "&amp;")}"><code>${escapeHtml(entry.id)}</code></a>`,
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
            `<p class="muted">关键词「${q}」· 项目 ${data.projects.length} · 用例集 ${data.caseSets.length} · 任务 ${data.tasks.length}${data.truncated ? "（结果已截断）" : ""} · <a href="/panel?section=search">清空搜索</a></p>`,
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
  llm?: { name: string; model: string; baseUrl: string | null; maskedKey: string } | null;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

export function renderOpsPage(data: OpsPageData): string {
  const actionsOff =
    data.capabilities?.actions === false || data.capabilities?.scopes?.export === false;
  const canConfig =
    data.capabilities?.role === undefined || data.capabilities.role === "admin";
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
        title: "项目配置",
        subtitle: "LLM / Figma / Jira 凭据；密钥只写项目 .env 与存储，不回显",
        body: [
          data.llm
            ? `<p class="muted">当前 LLM：<code>${escapeHtml(data.llm.name)}</code> · ${escapeHtml(
                data.llm.model
              )}${data.llm.baseUrl === null ? "" : ` · ${escapeHtml(data.llm.baseUrl)}`} · key ${
                data.llm.maskedKey
              }</p>`
            : `<p class="muted">当前项目还没有 LLM 条目；首次配置需填写 API key。</p>`,
          canConfig
            ? ""
            : `<p class="muted">项目配置需要 admin 角色；当前角色只读，请让管理员修改。</p>`,
          `<fieldset${canConfig ? "" : " disabled"}>`,
          `<form id="ops-config-form" class="c-form" data-project="${escapeHtml(data.rootPath)}">`,
          `<p><label>LLM 名称 <input name="name" value="${escapeHtml(
            data.llm?.name ?? ""
          )}" placeholder="例如 deepseek-flash" aria-label="LLM 名称"></label> <label>模型 <input name="model" value="${escapeHtml(
            data.llm?.model ?? ""
          )}" placeholder="deepseek-chat" aria-label="模型"></label></p>`,
          `<p><label>Base URL <input name="baseUrl" size="42" value="${escapeHtml(
            data.llm?.baseUrl ?? ""
          )}" placeholder="https://api.deepseek.com" aria-label="Base URL"></label> <label>API Key <input name="apiKey" type="password" placeholder="留空沿用现有 key" aria-label="API Key" autocomplete="new-password"></label></p>`,
          `<p><label>Figma token <input name="figmaToken" type="password" placeholder="留空不修改" aria-label="Figma token" autocomplete="new-password"></label> <label>Jira 站点 <input name="jiraSite" placeholder="https://x.atlassian.net" aria-label="Jira 站点"></label></p>`,
          `<p><label>Jira 邮箱 <input name="jiraEmail" placeholder="qa@example.com" aria-label="Jira 邮箱"></label> <label>Jira API token <input name="jiraApiToken" type="password" placeholder="留空不修改" aria-label="Jira API token" autocomplete="new-password"></label></p>`,
          `<p><button class="c-button c-button-primary" type="submit">保存配置</button> <span id="ops-config-status" role="status" class="muted"></span></p>`,
          `<p class="muted">Figma/Jira 可只填其中一组；LLM 首次配置必须填 API Key，后续可留空沿用。</p>`,
          `</form>`,
          `<script>(function(){var form=document.getElementById('ops-config-form');if(!form)return;var root=${JSON.stringify(
            data.rootPath
          ).replace(/</g, "\\u003c")};var status=document.getElementById('ops-config-status');form.addEventListener('submit',function(e){e.preventDefault();var f=new FormData(form);var body={project:root};['name','model','baseUrl','apiKey','figmaToken','jiraSite','jiraEmail','jiraApiToken'].forEach(function(key){var value=String(f.get(key)||'').trim();if(value!=='')body[key]=value;});if(Object.keys(body).length===1){status.textContent='没有填写任何配置';return;}status.textContent='保存中…';fetch('/panel/api/projects/config',{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j&&res.j.ok){window.aosFlash&&aosFlash('配置已保存 · 已写入审计');location.reload();return;}status.textContent='保存失败：'+((res.j&&res.j.error)||('HTTP '+res.status));}).catch(function(err){status.textContent='保存失败：'+err;});});})();</script>`,
          `</fieldset>`,
          `<p><a class="c-button" href="/panel?project=${encodeURIComponent(
            data.rootPath
          )}#integration">查看项目接入状态</a> <a class="c-button" href="/panel?project=${encodeURIComponent(
            data.rootPath
          )}&amp;section=devices">设备与执行机</a> <a class="c-button" href="/panel?project=${encodeURIComponent(
            data.rootPath
          )}&amp;section=assets">测试资产</a></p>`
        ].join("\n")
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
