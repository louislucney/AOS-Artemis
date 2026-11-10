import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { computeDispatchPreview, dispatchFormSignature, dispatchPreviewId } from "../dist/console/dispatch.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { deps: { store, env: {} }, rootPath: runtime.project.rootDir, store, runtime };
}

function request(pathname, body, overrides = {}) {
  return {
    method: "POST",
    url: new URL(`http://localhost${pathname}`),
    body,
    ...overrides
  };
}

async function waitDesignJob(deps, rootPath, assetId, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await handlePanelActionRequest(
      request("/panel/api/import", {
        project: rootPath,
        assetId,
        mode: "design-source-status",
        jobId
      }),
      deps
    );
    const payload = JSON.parse(response.body);
    if (payload.job && payload.job.status !== "running") return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`design job ${jobId} timeout`);
}

test("console actions: 同源守卫（cross-site 403；自定义头放行）", async () => {
  const { deps, rootPath } = await setup();
  const blocked = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: "t" }, {
      headers: { "sec-fetch-site": "cross-site" }
    }),
    deps
  );
  assert.equal(blocked.status, 403);

  const allowed = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: "t" }, {
      headers: { "sec-fetch-site": "cross-site", "x-aos-console": "1" }
    }),
    deps
  );
  assert.equal(allowed.status, 404, "守卫通过后进入业务（未知任务 404）");
});

test("console actions: 网页测试重新下发端点已移除", async () => {
  const { deps, rootPath, store } = await setup();
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  const response = await handlePanelActionRequest(
    request("/panel/api/jobs/clone", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(response.status, 404);
});

test("console actions: 释放/停止/重新派发三动作（claimed 可释放；停止中/终态拒绝；未知 404；落审计）", async () => {
  const { deps, rootPath, store } = await setup();
  const task = await store.createRegressionTask({
    rootPath,
    refs: [{ caseSetId: "cs", featureKey: "f" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.updateRegressionTask(rootPath, task.id, {
    status: "claimed",
    claimedBy: "runner-1",
    claimedAt: "2026-10-18T00:00:00.000Z"
  });

  const released = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(released.status, 200, "claimed 可直接释放回队列");
  const releasedPayload = JSON.parse(released.body);
  assert.equal(releasedPayload.task.status, "pending");
  assert.equal(releasedPayload.task.claimedBy, null);
  assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "pending");

  await store.updateRegressionTask(rootPath, task.id, {
    status: "claimed",
    claimedBy: "runner-1",
    claimedAt: "2026-10-18T00:00:00.000Z"
  });
  const stopped = await handlePanelActionRequest(
    request("/panel/api/tasks/stop", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(stopped.status, 200);
  const afterStop = await store.getRegressionTask(rootPath, task.id);
  assert.equal(afterStop.status, "stopping", "两段停止：先请求（stopping）");
  assert.equal(afterStop.claimedBy, "runner-1", "claimant 历史保留");

  const stopAgain = await handlePanelActionRequest(
    request("/panel/api/tasks/stop", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(stopAgain.status, 200, "重复停止幂等");
  assert.equal(JSON.parse(stopAgain.body).status, "stopping");

  const blockedStopRelease = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(blockedStopRelease.status, 409, "停止中不可释放（等待执行机确认）");
  assert.match(JSON.parse(blockedStopRelease.body).error, /等待执行机确认/);

  await store.ackCancellation({ rootPath, taskId: task.id });
  const cancelled = await store.getRegressionTask(rootPath, task.id);
  assert.equal(cancelled.status, "cancelled", "执行机确认 → cancelled 终态");
  assert.equal(cancelled.cancelSource, "panel");
  assert.ok(cancelled.cancelledAt);

  const cancelledRelease = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(cancelledRelease.status, 409, "cancelled 为终态，不可释放回队列");
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.claimedBy, "runner-1", "终态不清理领取历史");

  const freshPending = await store.createRegressionTask({
    rootPath,
    refs: [{ caseSetId: "cs", featureKey: "f" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  const stopPending = await handlePanelActionRequest(
    request("/panel/api/tasks/stop", { project: rootPath, taskId: freshPending.id }),
    deps
  );
  assert.equal(stopPending.status, 400, "pending 无执行可停止");

  await store.updateRegressionTask(rootPath, task.id, { status: "completed" });
  const terminal = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(terminal.status, 400);

  const rerun = await handlePanelActionRequest(
    request("/panel/api/tasks/rerun", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(rerun.status, 200, "终态可重新派发");
  const rerunTask = JSON.parse(rerun.body).task;
  assert.notEqual(rerunTask.id, task.id);
  assert.deepEqual(rerunTask.refs, task.refs);
  assert.deepEqual(rerunTask.platforms, task.platforms);
  assert.equal(rerunTask.baseline, task.baseline);

  const unknown = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: "nope" }),
    deps
  );
  assert.equal(unknown.status, 404);

  const audit = await store.listAudit(rootPath, { domain: "panel" });
  assert.ok(audit.some((event) => event.action === "action.release"));
  assert.ok(audit.some((event) => event.action === "action.stop"));
  assert.ok(audit.some((event) => event.action === "action.rerun"));
  assert.ok(
    audit.some(
      (event) =>
        event.action === "action.release" &&
        event.summary.includes("释放回队列：失败") &&
        event.summary.includes("任务正在停止")
    ),
    "审计摘要中文化并带失败原因"
  );
});

test("console actions: 计划 CRUD（create/重复 400/enable/disable/delete）", async () => {
  const { deps, rootPath, store } = await setup();
  const created = await handlePanelActionRequest(
    request("/panel/api/schedules", {
      project: rootPath,
      action: "create",
      name: "夜间",
      featureKeys: ["f-1"],
      platforms: ["android"],
      everyMinutes: 60
    }),
    deps
  );
  assert.equal(created.status, 200);
  const schedule = JSON.parse(created.body).schedule;

  const duplicate = await handlePanelActionRequest(
    request("/panel/api/schedules", {
      project: rootPath,
      action: "create",
      name: "夜间",
      featureKeys: ["f-1"],
      platforms: ["android"],
      everyMinutes: 60
    }),
    deps
  );
  assert.equal(duplicate.status, 400);

  const disabled = await handlePanelActionRequest(
    request("/panel/api/schedules", { project: rootPath, action: "disable", id: schedule.id }),
    deps
  );
  assert.equal(disabled.status, 200);
  assert.equal((await store.getSchedule(rootPath, schedule.id)).enabled, false);

  const badMinutes = await handlePanelActionRequest(
    request("/panel/api/schedules", {
      project: rootPath,
      action: "create",
      name: "x",
      featureKeys: ["f"],
      platforms: ["android"],
      everyMinutes: 0
    }),
    deps
  );
  assert.equal(badMinutes.status, 400);

  const deleted = await handlePanelActionRequest(
    request("/panel/api/schedules", { project: rootPath, action: "delete", id: schedule.id }),
    deps
  );
  assert.equal(deleted.status, 200);
  assert.equal(await store.getSchedule(rootPath, schedule.id), null);
});

test("console actions: quarantine 增删（owner 签字；写盘可解析）", async () => {
  const { deps, rootPath } = await setup();
  const added = await handlePanelActionRequest(
    request("/panel/api/quarantine", {
      project: rootPath,
      action: "add",
      caseId: "c1",
      owner: "qa-lead",
      until: "2026-12-31T00:00:00.000Z"
    }),
    deps
  );
  assert.equal(added.status, 200);
  const file = join(rootPath, ".artemis", "design", "quarantine.json");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].owner, "qa-lead");

  const missingOwner = await handlePanelActionRequest(
    request("/panel/api/quarantine", { project: rootPath, action: "add", caseId: "c2" }),
    deps
  );
  assert.equal(missingOwner.status, 400);

  const removed = await handlePanelActionRequest(
    request("/panel/api/quarantine", { project: rootPath, action: "remove", caseId: "c1" }),
    deps
  );
  assert.equal(removed.status, 200);
  assert.equal(JSON.parse(await readFile(file, "utf8")).entries.length, 0);
});

test("console actions: 导出（POST 与 GET 下载变体）", async () => {
  const { deps, rootPath } = await setup();
  const posted = await handlePanelActionRequest(
    request("/panel/api/export", { project: rootPath, what: "process" }),
    deps
  );
  assert.equal(posted.status, 200);
  assert.equal(JSON.parse(posted.body).what, "process");

  const get = await handlePanelActionRequest(
    {
      method: "GET",
      url: new URL(
        `http://localhost/panel/api/export?project=${encodeURIComponent(rootPath)}&what=results&format=csv`
      ),
      body: undefined
    },
    deps
  );
  assert.equal(get.status, 200);
  assert.match(get.contentType, /text\/csv/);

  const badWhat = await handlePanelActionRequest(
    request("/panel/api/export", { project: rootPath, what: "nope" }),
    deps
  );
  assert.equal(badWhat.status, 400);
});

test("console actions: 导入（无运行时 → 400 指引；缺路径 → 400）", async () => {
  const { deps, rootPath } = await setup();
  const noPath = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath }),
    deps
  );
  assert.equal(noPath.status, 400);

  const noRuntime = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath, path: "/x/cases.xlsx" }),
    deps
  );
  assert.equal(noRuntime.status, 400);
  assert.match(noRuntime.body, /运行时/);
});

test("console actions: project 查询参数只用于 multipart 导入", async () => {
  const { deps, rootPath } = await setup();
  const res = await handlePanelActionRequest(
    request(`/panel/api/tasks?project=${encodeURIComponent(rootPath)}`, {}),
    deps
  );
  assert.equal(res.status, 400);
  assert.match(res.body, /缺少 project/);
});

test("console actions: 服务端重解析（case-set/keyword 不信客户端 refs；陈旧份 400）", async () => {
  const { deps, rootPath, store } = await setup();
  await store.recordCaseSet({
    rootPath,
    source: "figma:x",
    basename: "登录回归",
    features: [
      { key: "f-1", name: "登录", caseCount: 1, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  const sets = await store.listCaseSets(rootPath);

  const bySet = await handlePanelActionRequest(
    request("/panel/api/tasks", { project: rootPath, source: "case-set", ref: sets[0].id }),
    deps
  );
  assert.equal(bySet.status, 200);
  const task = JSON.parse(bySet.body).task;
  assert.deepEqual(task.refs, [{ caseSetId: sets[0].id, featureKey: "f-1" }], "refs 由服务端解析");

  const stale = await handlePanelActionRequest(
    request("/panel/api/tasks", { project: rootPath, source: "case-set", ref: "cs-gone" }),
    deps
  );
  assert.equal(stale.status, 400);

  const byKeyword = await handlePanelActionRequest(
    request("/panel/api/tasks", { project: rootPath, source: "keyword", keyword: "登录" }),
    deps
  );
  assert.equal(byKeyword.status, 200);

  const noHit = await handlePanelActionRequest(
    request("/panel/api/tasks", { project: rootPath, source: "keyword", keyword: "不存在" }),
    deps
  );
  assert.equal(noHit.status, 400);
});

test("console actions: 下发预览合同（previewId 复算；改端/范围变化 409；缺省向后兼容）", async () => {
  const { deps, rootPath, store } = await setup();
  const set = await store.recordCaseSet({
    rootPath,
    source: "figma:x",
    basename: "登录回归",
    features: [
      { key: "f-1", name: "登录", caseCount: 2, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  const params = new URLSearchParams({
    source: "case-set",
    ref: set.id,
    platforms: "android",
    baseline: "latest"
  });
  const preview = await computeDispatchPreview({ store, env: {} }, rootPath, params);
  const formSignature = dispatchFormSignature(params);
  const previewId = dispatchPreviewId(preview, formSignature, rootPath);

  const ok = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      baseline: "latest",
      previewId
    }),
    deps
  );
  assert.equal(ok.status, 200, "同源 previewId 放行");

  const tampered = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "case-set",
      ref: set.id,
      platforms: ["ios"],
      baseline: "latest",
      previewId
    }),
    deps
  );
  assert.equal(tampered.status, 409, "改端后 previewId 不匹配 → 409");
  assert.equal(JSON.parse(tampered.body).stale, true);

  const keywordParams = new URLSearchParams({ source: "keyword", keyword: "登录", platforms: "android" });
  const keywordPreview = await computeDispatchPreview({ store, env: {} }, rootPath, keywordParams);
  const keywordId = dispatchPreviewId(
    keywordPreview,
    dispatchFormSignature(keywordParams),
    rootPath
  );
  await store.recordCaseSet({
    rootPath,
    source: "figma:y",
    basename: "登录回归（v2）",
    features: [
      { key: "f-2", name: "登录二次", caseCount: 1, screens: [], jsonPath: "/x/c.json", mdPath: "/x/c.md", xlsxPath: "/x/c.xlsx" }
    ]
  });
  const keywordStale = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "keyword",
      keyword: "登录",
      platforms: ["android"],
      previewId: keywordId
    }),
    deps
  );
  assert.equal(keywordStale.status, 409, "关键词匹配范围变化 → 预览过期");

  const legacy = await handlePanelActionRequest(
    request("/panel/api/tasks", { project: rootPath, source: "case-set", ref: set.id }),
    deps
  );
  assert.equal(legacy.status, 200, "无 previewId（CLI/legacy）向后兼容");
});

test("console actions: 导入单飞（409）＋上传请求返回运行时指引", async () => {
  const { deps, rootPath } = await setup();
  const boundary = "----aos";
  const content = "XLSX";
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cases.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    "utf8"
  );
  const raw = { rawBody: body, contentType: `multipart/form-data; boundary=${boundary}` };

  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const gated = {
    ...deps,
    runtimeFor: async () => {
      await gate;
      return null;
    }
  };

  const first = handlePanelActionRequest(request("/panel/api/import", { project: rootPath }, raw), gated);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath }, raw),
    gated
  );
  assert.equal(second.status, 409, "并发导入单飞");

  release();
  const done = await first;
  assert.equal(done.status, 400, "无运行时指引");

});


test("console actions: 上传导入保留原文件名并追加年月日时分", async () => {
  const { deps, rootPath, store, runtime } = await setup();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["TC", "Modules", "Test Case", "Test Step", "Expected Result"]);
  sheet.addRow(["TC-1", "Login", "Login by password", "Submit credentials", "Home shown"]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  const boundary = "----aos-name";
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="login-cases.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8"
  );
  const rawBody = Buffer.concat([
    body,
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ]);
  const response = await handlePanelActionRequest(
    request(
      "/panel/api/import",
      { project: rootPath },
      { rawBody, contentType: `multipart/form-data; boundary=${boundary}` }
    ),
    { ...deps, runtimeFor: async () => runtime }
  );
  assert.equal(response.status, 200, response.body);
  const sets = await store.listCaseSets(rootPath);
  assert.equal(sets.length, 1);
  assert.match(sets[0].basename, /^login-cases_\d{12}$/);
});

test("console actions: 从 Web Excel 资产导入用例库（同一 Excel 双向通用）", async () => {
  const { deps, rootPath, store, runtime } = await setup();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["用例名", "步骤", "预期"]);
  sheet.addRow(["登录", "输入账号密码并点击登录", "进入首页"]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  const sha256 = createHash("sha256").update(content).digest("hex");
  const storageDir = join(rootPath, ".artemis", "web", "assets", "excel");
  await mkdir(storageDir, { recursive: true });
  const storagePath = join(storageDir, `${sha256}.xlsx`);
  await writeFile(storagePath, content);
  await store.createWebProject({
    rootPath,
    name: "p",
    normalizedName: "p",
    platforms: ["android"]
  });
  const asset = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    sha256,
    size: content.length,
    storagePath,
    uploadedBy: "test",
    metadata: {}
  });

  const response = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath, assetId: asset.id }),
    { ...deps, runtimeFor: async () => runtime }
  );
  assert.equal(response.status, 200, response.body);
  const sets = await store.listCaseSets(rootPath);
  assert.equal(sets.length, 1, "资产导入生成用例集");
  assert.equal(sets[0].basename, "cases", "用例集名取资产原始文件名");
  const again = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath, assetId: asset.id }),
    { ...deps, runtimeFor: async () => runtime }
  );
  assert.equal(again.status, 200, again.body);
  assert.equal((await store.listCaseSets(rootPath)).length, 1, "同一资产重复导入不新增用例集");
  const assets = await store.listWebAssets(rootPath, "excel");
  assert.equal(assets.length, 1, "同一内容不重复登记 Web 资产");
});

test("console actions: 导入前设计预检与设计增强导入", async () => {
  const { deps, rootPath, store, runtime } = await setup();
  const designDir = join(runtime.configDirAbs, "design");
  await mkdir(designDir, { recursive: true });
  await writeFile(
    join(designDir, "flows.json"),
    JSON.stringify({ screens: [{ id: "h1", name: "Homepage" }] })
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["用例编号", "用例名称", "步骤", "期望结果", "Wireframe"]);
  sheet.addRow(["TC-1", "首页", "打开首页", "看到首页", "Homepage"]);
  const asset = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer())
  });
  const withRuntime = { ...deps, runtimeFor: async () => runtime };

  const preview = await handlePanelActionRequest(
    request("/panel/api/import", {
      project: rootPath,
      assetId: asset.id,
      mode: "design-preview"
    }),
    withRuntime
  );
  assert.equal(preview.status, 200, preview.body);
  const previewJson = JSON.parse(preview.body);
  assert.equal(previewJson.design.available, true);
  assert.equal(previewJson.design.indexKind, "flows");
  assert.equal(previewJson.design.report.summary.withWireframe, 1);
  assert.equal(previewJson.design.report.summary.screenStatus.exact, 1);
  assert.equal(previewJson.design.report.summary.rowStatus.matched, 1);

  const applied = await handlePanelActionRequest(
    request("/panel/api/import", {
      project: rootPath,
      assetId: asset.id,
      mode: "design-apply"
    }),
    withRuntime
  );
  assert.equal(applied.status, 200, applied.body);
  const sets = await store.listCaseSets(rootPath);
  assert.equal(sets.length, 1);
  const document = JSON.parse(await readFile(sets[0].features[0].jsonPath, "utf8"));
  assert.deepEqual(document.flows[0].designRefs.nodeIds, ["h1"]);

  await rm(join(designDir, "flows.json"));
  const missing = await handlePanelActionRequest(
    request("/panel/api/import", {
      project: rootPath,
      assetId: asset.id,
      mode: "design-preview"
    }),
    withRuntime
  );
  assert.equal(missing.status, 200, missing.body);
  assert.equal(JSON.parse(missing.body).design.reason, "design-index-missing");
});

test("console actions: 设计来源 pen/figma 提取后统一预检", async () => {
  const { deps, rootPath, store, runtime } = await setup();
  const designDir = join(runtime.configDirAbs, "design");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["用例编号", "用例名称", "步骤", "期望结果", "Wireframe"]);
  sheet.addRow(["TC-1", "首页", "打开首页", "看到首页", "Homepage"]);
  const excel = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer())
  });
  const pen = await storeWebAsset({
    store,
    rootPath,
    kind: "reference",
    filename: "design.pen",
    buffer: Buffer.from("pen")
  });
  const calls = [];
  const writeFlows = async () => {
    await mkdir(designDir, { recursive: true });
    await writeFile(
      join(designDir, "flows.json"),
      JSON.stringify({ screens: [{ id: "h1", name: "Homepage" }] })
    );
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  };
  const designExtract = {
    pen: async (_runtime, args) => {
      calls.push({ name: "pen_extract_flows", args });
      return writeFlows();
    },
    figma: async (_runtime, args) => {
      calls.push({ name: "figma_extract_flows", args });
      return writeFlows();
    }
  };
  const withRuntime = { ...deps, runtimeFor: async () => runtime, designExtract };

  const originalFetch = globalThis.fetch;
  const oldToken = process.env.FIGMA_ACCESS_TOKEN;
  const oldTtl = process.env.AOS_FIGMA_CACHE_TTL_MS;
  process.env.FIGMA_ACCESS_TOKEN = "tok-list";
  process.env.AOS_FIGMA_CACHE_TTL_MS = "0";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        name: "Inventory",
        document: {
          id: "0:0",
          name: "Document",
          type: "DOCUMENT",
          children: [
            {
              id: "0:1",
              name: "Page 1",
              type: "CANVAS",
              children: [{ id: "1:1", name: "Homepage", type: "FRAME", children: [] }]
            }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const listResult = await handlePanelActionRequest(
      request("/panel/api/import", {
        project: rootPath,
        assetId: excel.id,
        mode: "design-figma-list",
        figmaUrl: "https://www.figma.com/design/InventoryKey/demo"
      }),
      withRuntime
    );
    assert.equal(listResult.status, 200, listResult.body);
    const inventory = JSON.parse(listResult.body).inventory;
    assert.equal(inventory.pages.length, 1);
    assert.equal(inventory.pages[0].frames[0].id, "1:1");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = oldToken;
    if (oldTtl === undefined) delete process.env.AOS_FIGMA_CACHE_TTL_MS;
    else process.env.AOS_FIGMA_CACHE_TTL_MS = oldTtl;
  }

  const penResult = await handlePanelActionRequest(
    request("/panel/api/import", {
      project: rootPath,
      assetId: excel.id,
      mode: "design-source",
      source: "pen",
      penAssetId: pen.id
    }),
    withRuntime
  );
  assert.equal(penResult.status, 202, penResult.body);
  const penJobId = JSON.parse(penResult.body).jobId;
  const penJob = await waitDesignJob(withRuntime, rootPath, excel.id, penJobId);
  assert.equal(penJob.status, "completed", JSON.stringify(penJob));
  assert.equal(penJob.result.design.available, true);
  assert.equal(calls[0].name, "pen_extract_flows");
  assert.equal(calls[0].args.vision, false);
  assert.equal(calls[0].args.screens, false);

  const figmaResult = await handlePanelActionRequest(
    request("/panel/api/import", {
      project: rootPath,
      assetId: excel.id,
      mode: "design-source",
      source: "figma",
      figmaUrl: "https://www.figma.com/design/abc",
      nodeId: "1:2"
    }),
    withRuntime
  );
  assert.equal(figmaResult.status, 202, figmaResult.body);
  const figmaJobId = JSON.parse(figmaResult.body).jobId;
  const figmaJob = await waitDesignJob(withRuntime, rootPath, excel.id, figmaJobId);
  assert.equal(figmaJob.status, "completed", JSON.stringify(figmaJob));
  assert.equal(calls[1].name, "figma_extract_flows");
  assert.equal(calls[1].args.url, "https://www.figma.com/design/abc");
  assert.equal(calls[1].args.nodeId, "1:2");
  assert.equal(calls[1].args.screens, false);
});

test("console actions: 已保存模板映射驱动导入 Section/Wireframe/Related TC", async () => {
  const { deps, rootPath, store, runtime } = await setup();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("APP");
  sheet.addRow([
    "TC",
    "Modules",
    "S1",
    "Test Case",
    "Test Step",
    "Expected Result",
    "WF",
    "REL"
  ]);
  sheet.addRow([
    "TC_01",
    "Login / Register",
    "Register (Smiles card)",
    "Register with Smiles card",
    "1.Open register",
    "1.See register form",
    "0.1_Login/Register\n0.3.2_Register_Card Info (Smile Classic)",
    "TC_00"
  ]);
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  const sha256 = createHash("sha256").update(content).digest("hex");
  const storageDir = join(rootPath, ".artemis", "web", "assets", "excel");
  await mkdir(storageDir, { recursive: true });
  const storagePath = join(storageDir, `${sha256}.xlsx`);
  await writeFile(storagePath, content);
  await store.createWebProject({
    rootPath,
    name: "p",
    normalizedName: "p",
    platforms: ["android"]
  });
  const asset = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "navigation-menu.xlsx",
    sha256,
    size: content.length,
    storagePath,
    uploadedBy: "test",
    metadata: {}
  });
  await store.saveExcelMapping({
    rootPath,
    assetId: asset.id,
    sheetName: "APP",
    headerFingerprint: "test-fingerprint",
    columnMap: {
      caseId: "TC",
      name: "Test Case",
      steps: "Test Step",
      expected: "Expected Result",
      module: "Modules",
      section: "S1",
      wireframe: "WF",
      relatedTc: "REL"
    },
    createdBy: "test"
  });

  const response = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath, assetId: asset.id }),
    { ...deps, runtimeFor: async () => runtime }
  );
  assert.equal(response.status, 200, response.body);
  const sets = await store.listCaseSets(rootPath);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].features[0].name, "Register (Smiles card)", "Section 拆集");
  const document = JSON.parse(await readFile(sets[0].features[0].jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.deepEqual(flow.screens, [
    "0.1_Login/Register",
    "0.3.2_Register_Card Info (Smile Classic)"
  ]);
  assert.deepEqual(flow.designRefs, {
    screens: ["0.1_Login/Register", "0.3.2_Register_Card Info (Smile Classic)"],
    nodeIds: []
  });
  assert.deepEqual(flow.relatedCases, ["TC_00"]);

  // 同一模板的新资产（表头相同）没有自己的映射：按表头兼容性复用旧映射。
  const workbook2 = new ExcelJS.Workbook();
  const sheet2 = workbook2.addWorksheet("APP");
  sheet2.addRow(["TC", "Modules", "S1", "Test Case", "Test Step", "Expected Result", "WF", "REL"]);
  sheet2.addRow([
    "TC_02",
    "Login / Register",
    "Register (Smiles card)",
    "Register again",
    "1.Open register",
    "1.See register form",
    "0.1_Login/Register",
    "TC_01"
  ]);
  const content2 = Buffer.from(await workbook2.xlsx.writeBuffer());
  const sha2 = createHash("sha256").update(content2).digest("hex");
  const storagePath2 = join(storageDir, `${sha2}.xlsx`);
  await writeFile(storagePath2, content2);
  const asset2 = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "navigation-menu-v2.xlsx",
    sha256: sha2,
    size: content2.length,
    storagePath: storagePath2,
    uploadedBy: "test",
    metadata: {}
  });
  const second = await handlePanelActionRequest(
    request("/panel/api/import", { project: rootPath, assetId: asset2.id }),
    { ...deps, runtimeFor: async () => runtime }
  );
  assert.equal(second.status, 200, second.body);
  const v2 = (await store.listCaseSets(rootPath)).find((set) =>
    set.basename.includes("navigation-menu-v2")
  );
  assert.ok(v2, "新资产生成用例集");
  assert.equal(v2.features[0].name, "Register (Smiles card)", "复用映射后仍按 Section 拆集");
  const document2 = JSON.parse(await readFile(v2.features[0].jsonPath, "utf8"));
  assert.deepEqual(document2.flows[0].screens, ["0.1_Login/Register"]);
});

test("console actions: 安装包 appAssetId 写入任务；非法/平台不匹配拒绝", async () => {
  const { deps, rootPath, store } = await setup();
  const set = await store.recordCaseSet({
    rootPath,
    source: "figma:x",
    basename: "登录回归",
    features: [
      { key: "f-1", name: "登录", caseCount: 1, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  const pkg = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "app-release.apk",
    buffer: Buffer.from("apk-bytes")
  });
  const params = new URLSearchParams({
    source: "case-set",
    ref: set.id,
    platforms: "android",
    appAssetId: pkg.id,
    appPackage: "com.example.app"
  });
  const preview = await computeDispatchPreview({ store, env: {} }, rootPath, params);
  const ok = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      appAssetId: pkg.id,
      appPackage: "com.example.app",
      caseIds: ["case-1"],
      previewId: dispatchPreviewId(preview, dispatchFormSignature(params), rootPath)
    }),
    deps
  );
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).task.appAssetId, pkg.id);
  assert.equal(JSON.parse(ok.body).task.appPackage, "com.example.app");
  assert.deepEqual(JSON.parse(ok.body).task.caseIds, ["case-1"]);

  const missing = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      appAssetId: "missing"
    }),
    deps
  );
  assert.equal(missing.status, 400);

  const wrongPlatform = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "case-set",
      ref: set.id,
      platforms: ["ios"],
      appAssetId: pkg.id
    }),
    deps
  );
  assert.equal(wrongPlatform.status, 400);
  assert.match(JSON.parse(wrongPlatform.body).error, /Android/);
});

test("console actions: 跨机 runner 主机可在中心项目上下发", async () => {
  const { deps, rootPath, store } = await setup();
  await store.upsertHost({
    id: "win-runner-01",
    hostname: "CN2368578W1",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"],
    runnerSeenAt: new Date().toISOString(),
    clientSeenAt: new Date().toISOString()
  });
  await store.upsertRunner({
    rootPath,
    name: "win-runner-01",
    hostname: "CN2368578W1",
    platforms: ["android"],
    devices: [
      {
        serial: "10CF6609P900059",
        name: "V2453A",
        model: "V2453A",
        osVersion: "16",
        platform: "android",
        kind: "device",
        state: "device"
      }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false, maestro: false, devicectl: false },
    hostId: "win-runner-01",
    instanceId: "inst-win",
    lastSeenAt: new Date().toISOString()
  });
  const set = await store.recordCaseSet({
    rootPath,
    source: "figma:x",
    basename: "登录回归",
    features: [
      { key: "f-1", name: "登录", caseCount: 1, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  const params = new URLSearchParams({
    source: "case-set",
    ref: set.id,
    platforms: "android",
    host: "win-runner-01"
  });
  const preview = await computeDispatchPreview({ store, env: {} }, rootPath, params);
  assert.equal(preview.hostBlocked, false);
  assert.match(preview.warnings.join(" "), /跨机 runner/);
  assert.equal(preview.projects[0]?.rootPath, rootPath);
  assert.deepEqual(preview.runnerCandidates[0]?.devices.map((d) => d.serial), ["10CF6609P900059"]);

  const response = await handlePanelActionRequest(
    request("/panel/api/tasks", {
      project: rootPath,
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      host: "win-runner-01",
      previewId: dispatchPreviewId(preview, dispatchFormSignature(params), rootPath)
    }),
    deps
  );
  assert.equal(response.status, 200);
  const task = JSON.parse(response.body).task;
  assert.equal(task.targetHostId, "win-runner-01");
  assert.equal((await store.getRegressionTask(rootPath, task.id))?.id, task.id);
});

test("console actions: 只重跑失败用例创建带 caseIds 的新任务", async () => {
  const { deps, rootPath, store } = await setup();
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.recordSuiteRun({
    rootPath,
    createdAt: "2026-10-18T00:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: task.id,
      caseSetId: null,
      featureKey: "f-1",
      featureName: "登录",
      platform: "android",
      device: "emulator-5554",
      appVersion: null,
      status: "failed",
      startedAt: "2026-10-18T00:00:00.000Z",
      finishedAt: "2026-10-18T00:01:00.000Z",
      total: 2,
      passed: 1,
      failed: 1,
      flaky: 0,
      quarantined: 0,
      failureDomains: { 用例缺陷: 1 },
      gateResult: "fail",
      exitCode: 1,
      manifestPath: null,
      comparison: null
    },
    cases: [
      {
        caseId: "case-ok",
        name: "通过",
        featureKey: "f-1",
        platform: "android",
        status: "passed",
        traceId: null,
        failureDomain: null,
        failureConfidence: null,
        failureReason: null,
        durationMs: 100,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      },
      {
        caseId: "case-failed",
        name: "失败",
        featureKey: "f-1",
        platform: "android",
        status: "failed",
        traceId: null,
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中",
        durationMs: 120,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      }
    ]
  });
  const response = await handlePanelActionRequest(
    request("/panel/api/tasks/rerun", {
      project: rootPath,
      taskId: task.id,
      failedOnly: true
    }),
    deps
  );
  assert.equal(response.status, 200);
  const created = JSON.parse(response.body).task;
  assert.deepEqual(created.caseIds, ["case-failed"]);
  assert.equal(created.targetHostId, task.targetHostId);

  const noFailures = await handlePanelActionRequest(
    request("/panel/api/tasks/rerun", {
      project: rootPath,
      taskId: task.id,
      failedOnly: true
    }),
    deps
  );
  assert.equal(noFailures.status, 200, "同一任务可重复创建");
  assert.deepEqual(JSON.parse(noFailures.body).task.caseIds, ["case-failed"]);
});

test("console actions: 项目配置写入 Figma token，缺 key/半组 Jira 拒绝", async () => {
  const { deps, rootPath, runtime } = await setup();
  const withRuntime = { ...deps, runtimeFor: async () => runtime };
  const figma = await handlePanelActionRequest(
    request("/panel/api/projects/config", { project: rootPath, figmaToken: "figd_test_token" }),
    withRuntime
  );
  assert.equal(figma.status, 200);
  const env = await readFile(join(rootPath, ".env"), "utf8");
  assert.match(env, /FIGMA_ACCESS_TOKEN=figd_test_token/);

  const noKey = await handlePanelActionRequest(
    request("/panel/api/projects/config", {
      project: rootPath,
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com"
    }),
    withRuntime
  );
  assert.equal(noKey.status, 400);
  assert.match(JSON.parse(noKey.body).error, /apiKey/);

  const jira = await handlePanelActionRequest(
    request("/panel/api/projects/config", {
      project: rootPath,
      jiraSite: "https://x.atlassian.net"
    }),
    withRuntime
  );
  assert.equal(jira.status, 400);
  assert.match(JSON.parse(jira.body).error, /Jira/);
});
