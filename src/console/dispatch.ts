import type { ProjectStore } from "../db/types.js";
import { escapeHtml } from "../util.js";
import { cBadge, cBanner, cCard, cStat, cTable } from "./components.js";
import { renderConsoleShell, type ConsoleCapabilities } from "./shell.js";

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
  query: Record<string, string>;
  capabilities?: ConsoleCapabilities;
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
    warnings.push("无在线 runner：派发后等待项目机领取，或改为手动指定设备（动作层接线后）");
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
        `<option value="${escapeHtml(option.id)}" data-features="${escapeHtml(JSON.stringify(option.featureKeys))}"${preview.refs.includes(option.id) ? " selected" : ""}>${escapeHtml(option.label)}（${option.caseCount} 例）</option>`
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
    `<label class="dispatch-option"><input type="radio" name="source" value="case-set"${mode === "case-set" ? " checked" : ""}> 用例库选份</label>`,
    `<label class="dispatch-option"><input type="radio" name="source" value="keyword"${mode === "keyword" ? " checked" : ""}> 功能关键词</label>`,
    `<p><label>份 <select name="ref" aria-label="用例集份"><option value="">（选择份）</option>${setOptions}</select></label></p>`,
    `<p><label>关键词 <input type="text" name="keyword" aria-label="功能关键词" value="${query("keyword")}" placeholder="例：登录"></label> <span class="muted">Excel 导入经 CLI/API（multipart 上传）。</span></p>`
  ].join("\n");

  const paramsBody = [
    `<p>目标端：${platformChecks}</p>`,
    `<p><label>基线 <select name="baseline" aria-label="基线"><option value="latest"${preview.baseline === "latest" ? " selected" : ""}>latest（与本份最近批次对比）</option><option value="none"${preview.baseline === "none" ? " selected" : ""}>none（不对比）</option></select></label> · 设备在项目机执行时确定（<code>suite run --device</code>）</p>`
  ].join("\n");

  const previewBody = [
    `<div class="c-stats-row">`,
    cStat({ label: "来源", value: preview.source.label || "—" }),
    cStat({ label: "用例数", value: String(preview.source.caseCount) }),
    cStat({ label: "目标端", value: preview.platforms.join("、") || "—" }),
    cStat({ label: "设备", value: preview.devices.length === 0 ? "runner 自动" : preview.devices.join("、") }),
    `</div>`,
    cTable({
      columns: ["份", "用例集", "用例数"],
      rows: refRows,
      empty: "无引用（待选择来源）"
    }),
    `<p>runner 候选：${runnerBadges || '<span class="muted">暂无注册执行机</span>'}</p>`,
    warnings,
    `<p><button class="c-button" type="submit">刷新预览</button></p>`
  ].join("\n");

  const actionsOff = view.capabilities?.actions === false;
  const confirmBody = actionsOff
    ? `<p><button class="c-button c-button-primary" type="button" disabled title="写动作未启用">确认派发</button> <span class="muted">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback；或使用 HTTP 模式（<code>serve --http</code>）。</span></p>`
    : [
        `<p><button class="c-button c-button-primary" type="button" id="dispatch-submit">确认派发</button> <span class="muted">派发前显示一次摘要确认；由在线 runner 自动领取，或在项目机手动执行（<code>suite run --task</code>）。</span></p>`,
        `<p id="dispatch-error" role="alert" class="c-banner c-banner-warn" hidden></p>`,
        `<p id="dispatch-confirm" class="c-banner c-banner-accent" hidden>将创建回归任务：来源「${escapeHtml(preview.source.label || "—")}」· 用例 ${preview.source.caseCount} 条 · 端 ${escapeHtml(preview.platforms.join("、") || "—")} · 基线 ${preview.baseline}。 <button class="c-button c-button-primary" type="button" id="dispatch-confirm-yes">确认创建</button> <button class="c-button" type="button" id="dispatch-confirm-no">取消</button></p>`,
        `<script>(function(){var go=document.getElementById('dispatch-submit');if(!go)return;var box=document.getElementById('dispatch-confirm');var yes=document.getElementById('dispatch-confirm-yes');var no=document.getElementById('dispatch-confirm-no');var err=document.getElementById('dispatch-error');function showErr(m){err.textContent=m;err.hidden=false;}go.addEventListener('click',function(){var form=go.closest('form');var data=new FormData(form);if(data.get('source')==='case-set'&&!(form.querySelector('select[name="ref"]')||{value:''}).value){showErr('请选择份');return;}if(data.get('source')==='keyword'&&!((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim()){showErr('请输入功能关键词');return;}err.hidden=true;box.hidden=false;go.disabled=true;});no.addEventListener('click',function(){box.hidden=true;go.disabled=false;});yes.addEventListener('click',function(){var form=go.closest('form');var data=new FormData(form);var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;});var payload={project:form.querySelector('input[name="project"]').value,source:data.get('source'),platforms:platforms,baseline:(form.querySelector('select[name="baseline"]')||{value:'latest'}).value};if(data.get('source')==='case-set'){payload.ref=(form.querySelector('select[name="ref"]')||{value:''}).value;}else{payload.keyword=((form.querySelector('input[name="keyword"]')||{value:''}).value||'').trim();}fetch('/panel/api/tasks',{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify(payload)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j.ok){location.href='/panel?project='+encodeURIComponent(payload.project)+'&task='+encodeURIComponent(res.j.task.id)+'&dispatched='+encodeURIComponent(res.j.task.id);}else{yes.disabled=false;showErr('派发失败：'+(res.j.error||res.status||'未知错误'));}}).catch(function(e){yes.disabled=false;showErr('派发失败：'+e);});});})();</script>`
      ].join("\n");

  return renderConsoleShell({
    title: "下发回归",
    active: "dispatch",
    meta: `项目 <code>${escapeHtml(view.rootLabel)}</code>`,
    project: view.rootPath,
    capabilities: view.capabilities,
    body: [
      "<h1>下发回归</h1>",
      `<p class="muted"><code>${escapeHtml(view.rootPath)}</code> · 四步：来源 → 参数 → 预览回显 → 确认派发</p>`,
      `<form method="get" action="/panel">`,
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
