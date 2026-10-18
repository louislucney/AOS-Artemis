import type { ProjectStore } from "../db/types.js";
import { escapeHtml } from "../util.js";
import { cBadge, cBanner, cCard, cStat, cTable } from "./components.js";
import { renderConsoleShell } from "./shell.js";

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
    `<label class="dispatch-option"><input type="radio" name="source" value="excel"${mode === "excel" ? " checked" : ""}> Excel 导入</label>`,
    `<p><select name="ref"><option value="">（选择份）</option>${setOptions}</select></p>`,
    `<p>关键词：<input type="text" name="keyword" value="${query("keyword")}" placeholder="例：登录"></p>`,
    `<p>Excel 路径：<input type="text" name="excel" size="48" value="${query("excel")}" placeholder="/path/to/cases.xlsx"></p>`
  ].join("\n");

  const paramsBody = [
    `<p>目标端：${platformChecks}</p>`,
    `<p>设备（逗号分隔，可留空＝由 runner 自动领取）：<input type="text" name="devices" size="32" value="${query("devices")}"></p>`,
    `<p>基线：<select name="baseline"><option value="latest"${preview.baseline === "latest" ? " selected" : ""}>latest</option><option value="none"${preview.baseline === "none" ? " selected" : ""}>none</option></select></p>`
  ].join("\n");

  const refsJson = JSON.stringify(
    preview.refDetails.map((detail) => ({ id: detail.id, featureKeys: detail.featureKeys }))
  ).replace(/</g, "\\u003c");
  const previewBody = [
    `<script id="dispatch-refs" type="application/json">${refsJson}</script>`,
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

  const confirmBody = [
    `<p><button class="c-button c-button-primary" type="button" id="dispatch-submit">确认派发</button> <span class="muted">派发将创建回归任务：由在线 runner 自动领取，或在项目机手动执行（<code>suite run --task</code>）。</span></p>`,
    `<script>(function(){var btn=document.getElementById('dispatch-submit');if(!btn)return;var refsEl=document.getElementById('dispatch-refs');var allRefs=refsEl?JSON.parse(refsEl.textContent):[];btn.addEventListener('click',function(){var form=btn.closest('form');var data=new FormData(form);var mode=data.get('source');var refs=[];if(mode==='case-set'){var sel=form.querySelector('select[name="ref"]');if(!sel||!sel.value){alert('请选择份');return;}var opt=sel.options[sel.selectedIndex];var feats=opt&&opt.dataset.features?JSON.parse(opt.dataset.features):[];feats.forEach(function(k){refs.push({caseSetId:sel.value,featureKey:k});});}else if(mode==='keyword'){allRefs.forEach(function(d){d.featureKeys.forEach(function(k){refs.push({caseSetId:d.id,featureKey:k});});});}else{alert('Excel 导入请用 CLI/API（multipart 上传，暂不在本表单提交）');return;}if(refs.length===0){alert('没有可派发的引用（先选择份或更换关键词）');return;}var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked')).map(function(i){return i.value;});var baseline=form.querySelector('select[name="baseline"]').value;var project=form.querySelector('input[name="project"]').value;fetch('/panel/api/tasks',{method:'POST',headers:{'Content-Type':'application/json','X-AOS-Console':'1'},body:JSON.stringify({project:project,refs:refs,platforms:platforms,baseline:baseline})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(res){if(res.ok&&res.j.ok){location.href='/panel?project='+encodeURIComponent(project)+'&task='+encodeURIComponent(res.j.task.id);}else{alert('派发失败：'+(res.j.error||res.status||''));}}).catch(function(e){alert('派发失败：'+e);});});})();</script>`
  ].join("\n");

  return renderConsoleShell({
    title: "下发回归",
    active: "dispatch",
    meta: `项目 <code>${escapeHtml(view.rootLabel)}</code>`,
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
