import { createHash } from "node:crypto";

import type { ProjectStore } from "../db/types.js";
import { escapeHtml } from "../util.js";
import { cBadge, cBanner, cCard, cStat, cTable } from "./components.js";
import { renderConsoleShell, type ConsoleCapabilities, type ConsoleShellInput } from "./shell.js";

export interface DispatchDeps {
  store: ProjectStore;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface DispatchRefDetail {
  id: string;
  label: string;
  caseCount: number;
  featureKeys: string[];
}

export interface DispatchPreview {
  source: { mode: "case-set" | "keyword" | "excel"; label: string; caseCount: number };
  refs: string[];
  refDetails: DispatchRefDetail[];
  setOptions: DispatchRefDetail[];
  platforms: ("ios" | "android")[];
  devices: string[];
  baseline: "latest" | "none";
  runnerCandidates: { id: string; host: string; online: boolean }[];
  warnings: string[];
}

export interface DispatchView {
  rootPath: string;
  rootLabel: string;
  preview: DispatchPreview;
  /** 预览 ID：POST 时服务端复算比对（预览过期 → 409）。 */
  previewId: string;
  /** 表单字段签名：客户端以它判断"改了字段 → 预览已过期"。 */
  formSignature: string;
  query: Record<string, string>;
  capabilities?: ConsoleCapabilities;
  storeHealth?: ConsoleShellInput["storeHealth"];
}

/** 表单字段签名（与预览同源；客户端复算同式）。 */
export function dispatchFormSignature(params: URLSearchParams): string {
  const mode = (params.get("source") ?? "case-set").trim() === "keyword" ? "keyword" : "case-set";
  const refOrKeyword =
    mode === "keyword" ? (params.get("keyword") ?? "").trim() : (params.get("ref") ?? "").trim();
  const platforms = (params.get("platforms") ?? "android")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value === "ios" || value === "android")
    .sort()
    .join(",");
  const baseline = (params.get("baseline") ?? "latest").trim() === "none" ? "none" : "latest";
  return [mode, refOrKeyword, platforms, baseline].join("|");
}

/** 预览 ID＝表单签名＋服务端解析结果（份集合/用例数）短哈希；服务端复算不一致即视为过期。 */
export function dispatchPreviewId(preview: DispatchPreview, formSignature: string): string {
  const resolved = preview.refs.slice().sort().join(",");
  return createHash("sha256")
    .update(`${formSignature}#${resolved}#${preview.source.caseCount}`)
    .digest("hex")
    .slice(0, 16);
}

const ONLINE_WINDOW_MS = 5 * 60_000;

export async function computeDispatchPreview(
  deps: DispatchDeps,
  rootPath: string,
  params: URLSearchParams
): Promise<DispatchPreview> {
  const now = deps.now?.() ?? Date.now();
  const modeRaw = (params.get("source") ?? "case-set").trim();
  const mode: DispatchPreview["source"]["mode"] =
    modeRaw === "keyword" || modeRaw === "excel" ? modeRaw : "case-set";
  const sets = await deps.store.listCaseSets(rootPath);
  const setOptions: DispatchRefDetail[] = sets.map((set) => ({
    id: set.id,
    label: set.basename,
    caseCount: set.features.reduce((sum, feature) => sum + feature.caseCount, 0),
    featureKeys: set.features.map((feature) => feature.key)
  }));

  const warnings: string[] = [];
  let label = "";
  let caseCount = 0;
  const refDetails: DispatchRefDetail[] = [];

  if (mode === "case-set") {
    const id = (params.get("ref") ?? "").trim();
    const hit = setOptions.find((option) => option.id === id);
    if (hit) {
      label = hit.label;
      caseCount = hit.caseCount;
      refDetails.push(hit);
    } else {
      warnings.push("未选择份（或份不存在）：请在「来源」中选择");
    }
  } else if (mode === "keyword") {
    const keyword = (params.get("keyword") ?? "").trim();
    label = keyword === "" ? "关键词" : `关键词「${keyword}」`;
    if (keyword === "") {
      warnings.push("关键词为空：请输入功能关键词");
    } else {
      const hits = sets.filter(
        (set) =>
          set.basename.includes(keyword) ||
          set.features.some(
            (feature) => feature.name.includes(keyword) || feature.key.includes(keyword)
          )
      );
      for (const set of hits) {
        const detail = setOptions.find((option) => option.id === set.id)!;
        refDetails.push(detail);
        caseCount += detail.caseCount;
      }
      if (hits.length === 0) warnings.push(`关键词「${keyword}」未匹配到任何份`);
    }
  } else {
    const excelPath = (params.get("excel") ?? "").trim();
    label = excelPath === "" ? "Excel 导入" : `Excel：${excelPath}`;
    if (excelPath === "") warnings.push("未指定 Excel 路径");
    else warnings.push("Excel 导入经 CLI/API（multipart 上传）；本表单提交支持「用例库选份」与「功能关键词」");
  }

  const platforms = (params.get("platforms") ?? "android")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is "ios" | "android" => value === "ios" || value === "android");
  const devices = (params.get("devices") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const baseline: "latest" | "none" =
    (params.get("baseline") ?? "latest").trim() === "none" ? "none" : "latest";

  const runners = await deps.store.listRunners(rootPath);
  const runnerCandidates = runners.map((runner) => ({
    id: runner.id,
    host: runner.hostname,
    online: now - Date.parse(runner.lastSeenAt) < ONLINE_WINDOW_MS
  }));
  if (!runnerCandidates.some((runner) => runner.online)) {
    warnings.push("无在线执行机：派发后等待执行机领取，或改为手动指定设备（CLI：suite run --device）");
  }

  return {
    source: { mode, label, caseCount },
    refs: refDetails.map((detail) => detail.id),
    refDetails,
    setOptions,
    platforms,
    devices,
    baseline,
    runnerCandidates,
    warnings
  };
}

export function renderDispatchPage(view: DispatchView): string {
  const preview = view.preview;
  const query = (name: string, fallback = ""): string => escapeHtml(view.query[name] ?? fallback);
  const mode = preview.source.mode;
  const platformChecks = (["android", "ios"] as const)
    .map(
      (platform) =>
        `<label class="dispatch-option"><input type="checkbox" name="platforms" value="${platform}"${
          preview.platforms.includes(platform) ? " checked" : ""
        }> ${platform}</label>`
    )
    .join(" ");
  const setOptions = preview.setOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.id)}" data-features="${escapeHtml(JSON.stringify(option.featureKeys))}" data-count="${option.caseCount}"${preview.refs.includes(option.id) ? " selected" : ""}>${escapeHtml(option.label)}（${option.caseCount} 例）</option>`
    )
    .join("");
  const refRows = preview.refDetails.map((detail) => [
    escapeHtml(detail.label),
    `<code>${escapeHtml(detail.id)}</code>`,
    String(detail.caseCount)
  ]);
  const runnerBadges = preview.runnerCandidates
    .map(
      (runner) =>
        `${cBadge({ label: runner.online ? "在线" : "失联", tone: runner.online ? "success" : "warning" })} <code>${escapeHtml(runner.host)}</code>`
    )
    .join(" · ");
  const warnings = preview.warnings
    .map((warning) => cBanner({ tone: "warn", title: warning }))
    .join("");

  const sourceBody = [
    '<fieldset class="c-fieldset"><legend>来源</legend>',
    `<label class="dispatch-option"><input type="radio" name="source" value="case-set"${mode === "case-set" ? " checked" : ""}> 用例库选份</label>`,
    `<label class="dispatch-option"><input type="radio" name="source" value="keyword"${mode === "keyword" ? " checked" : ""}> 功能关键词</label>`,
    "</fieldset>",
    `<div id="dispatch-field-ref"><p><label>份 <select name="ref" aria-label="用例集份"><option value="">（选择份）</option>${setOptions}</select></label></p></div>`,
    `<div id="dispatch-field-keyword"><p><label>关键词 <input type="text" name="keyword" aria-label="功能关键词" value="${query("keyword")}" placeholder="例：登录"></label> <span class="muted">Excel 导入经 CLI/API（multipart 上传）。</span></p></div>`
  ].join("\n");

  const paramsBody = [
    `<fieldset class="c-fieldset"><legend>目标端</legend>${platformChecks}</fieldset>`,
    `<p><label>基线 <select name="baseline" aria-label="基线"><option value="latest"${preview.baseline === "latest" ? " selected" : ""}>latest（与本份最近批次对比）</option><option value="none"${preview.baseline === "none" ? " selected" : ""}>none（不对比）</option></select></label> · 设备在执行机执行时确定（<code>suite run --device</code>）</p>`
  ].join("\n");

  const previewBody = [
    `<p id="dispatch-stale" role="status" class="c-banner c-banner-warn" hidden>表单已变更：预览已过期。请点「刷新预览」后重新核对，再确认派发。</p>`,
    `<p id="dispatch-empty" role="status" class="c-banner c-banner-warn" hidden>预览为空：尚未引用任何份。请选择份或输入关键词后点「刷新预览」。</p>`,
    `<div class="c-stats-row">`,
    cStat({ label: "来源", value: preview.source.label || "—" }),
    cStat({ label: "用例数", value: String(preview.source.caseCount) }),
    cStat({ label: "目标端", value: preview.platforms.join("、") || "—" }),
    cStat({ label: "设备", value: preview.devices.length === 0 ? "runner 自动" : preview.devices.join("、") }),
    `</div>`,
    cTable({
      columns: ["份", "用例集", "用例数"],
      rows: refRows,
      caption: "引用份明细",
      empty: "无引用（待选择来源）"
    }),
    `<p>runner 候选：${runnerBadges || '<span class="muted">暂无注册执行机</span>'}</p>`,
    preview.devices.length === 0
      ? `<p class="muted">设备：由在线执行机在领取时确定；最终设备见任务页。</p>`
      : "",
    warnings,
    `<p><button class="c-button" type="submit">刷新预览</button></p>`
  ].join("\n");

  const dispatchConfirmScript = `<script>(function(){
var form=document.getElementById('dispatch-form');if(!form)return;
var go=document.getElementById('dispatch-submit');if(!go)return;
var box=document.getElementById('dispatch-confirm');
var yes=document.getElementById('dispatch-confirm-yes');
var no=document.getElementById('dispatch-confirm-no');
var err=document.getElementById('dispatch-error');
var stale=document.getElementById('dispatch-stale');
var island=null;try{island=JSON.parse(document.getElementById('dispatch-preview-data').textContent);}catch(e){island=null;}
if(!island){return;}
function showErr(m){err.textContent=m;err.hidden=false;}
function formSignature(){
  var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
  var refOrKeyword=mode==='keyword'?((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim():((form.querySelector('select[name="ref"]')||{value:''}).value||'');
  var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;}).sort().join(',');
  var baseline=(form.querySelector('select[name="baseline"]')||{value:'latest'}).value;
  return [mode,refOrKeyword,platforms,baseline].join('|');
}
function refreshStale(){
  var staleNow=formSignature()!==island.formSignature;
  var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
  var refField=document.getElementById('dispatch-field-ref');
  var keywordField=document.getElementById('dispatch-field-keyword');
  if(refField)refField.hidden=mode==='keyword';
  if(keywordField)keywordField.hidden=mode!=='keyword';
  var empty=!island.ready;
  var emptyEl=document.getElementById('dispatch-empty');
  if(emptyEl)emptyEl.hidden=!empty;
  if(stale)stale.hidden=!staleNow;
  var blocked=staleNow||empty;
  go.disabled=blocked;
  if(blocked)box.hidden=true;
  return blocked;
}
form.addEventListener('input',refreshStale);
form.addEventListener('change',refreshStale);
refreshStale();
go.addEventListener('click',function(){
  if(refreshStale()){showErr(island.ready?'预览已过期：请先点「刷新预览」':'预览为空：先选择份或输入关键词，再点「刷新预览」');return;}
  if(form.querySelectorAll('input[name="platforms"]:checked').length===0){showErr('请至少选择目标端（iOS/Android）');return;}
  var s=island.summary||{};
  var text='将创建回归任务：来源「'+(s.label||'—')+'」· 用例 '+(s.caseCount==null?'—':s.caseCount)+' 条 · 端 '+((s.platforms||[]).join('、')||'—')+' · 基线 '+(s.baseline||'latest')+'。';
  var textEl=document.getElementById('dispatch-confirm-text');if(textEl)textEl.textContent=text;
  err.hidden=true;box.hidden=false;go.disabled=true;if(yes&&yes.focus)yes.focus();
});
no.addEventListener('click',function(){box.hidden=true;go.disabled=false;});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!box.hidden){box.hidden=true;go.disabled=false;}});
yes.addEventListener('click',function(){
  var mode=(form.querySelector('input[name="source"]:checked')||{value:'case-set'}).value;
  var payload={project:island.project,previewId:island.previewId,source:mode};
  if(mode==='keyword'){payload.keyword=((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim();}
  else{payload.ref=(form.querySelector('select[name="ref"]')||{value:''}).value||'';}
  payload.platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;});
  payload.baseline=(form.querySelector('select[name="baseline"]')||{value:'latest'}).value;
  yes.disabled=true;
  fetch('/panel/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(response){return response.json().then(function(p){if(!response.ok){throw new Error(p.error||('HTTP '+response.status));}window.aosFlash&&aosFlash('已派发任务 '+p.task.id+' · 已写入审计');location.href='/panel?project='+encodeURIComponent(island.project)+'&task='+encodeURIComponent(p.task.id);});})
    .catch(function(error){yes.disabled=false;showErr('创建失败：'+error.message);});
});
})();</script>`;
  const actionsOff = view.capabilities?.actions === false;
  const confirmBody = actionsOff
    ? `<p><button class="c-button c-button-primary" type="button" disabled title="写动作未启用">确认派发</button> <span class="muted">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式（<code>serve --http</code>）。</span></p>`
    : [
        `<p><button class="c-button c-button-primary" type="button" id="dispatch-submit">确认派发</button> <span class="muted">派发前显示一次摘要确认；由在线执行机自动领取，或在执行机手动执行（<code>suite run --task</code>）。</span></p>`,
        `<p id="dispatch-error" role="alert" class="c-banner c-banner-warn" hidden></p>`,
        `<p id="dispatch-confirm" class="c-banner c-banner-accent" hidden><span id="dispatch-confirm-text"></span> <button class="c-button c-button-primary" type="button" id="dispatch-confirm-yes">确认创建</button> <button class="c-button" type="button" id="dispatch-confirm-no">取消</button></p>`,
        `<script type="application/json" id="dispatch-preview-data">${JSON.stringify({ previewId: view.previewId, formSignature: view.formSignature, project: view.rootPath, ready: preview.refs.length > 0, summary: { label: preview.source.label, caseCount: preview.source.caseCount, platforms: preview.platforms, baseline: preview.baseline } }).replace(/</g, "\\u003c")}</script>`,
        dispatchConfirmScript,
      ].join("\n");

  return renderConsoleShell({
    title: "下发回归",
    active: "dispatch",
    meta: `项目 <code>${escapeHtml(view.rootLabel)}</code>`,
    project: view.rootPath,
    capabilities: view.capabilities,
    storeHealth: view.storeHealth,
    body: [
      "<h1>下发回归</h1>",
      `<p class="muted"><code>${escapeHtml(view.rootPath)}</code> · 四步：来源 → 参数 → 预览回显 → 确认派发</p>`,
      `<form id="dispatch-form" method="get" action="/panel">`,
      `<input type="hidden" name="project" value="${escapeHtml(view.rootPath)}">`,
      `<input type="hidden" name="section" value="dispatch">`,
      cCard({ title: "① 来源", body: sourceBody }),
      cCard({ title: "② 参数", body: paramsBody }),
      cCard({ title: "③ 预览回显", tone: "accent", body: previewBody }),
      cCard({ title: "④ 确认", body: confirmBody }),
      "</form>"
    ].join("\n")
  });
}
