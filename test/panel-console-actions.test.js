import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { computeDispatchPreview, dispatchFormSignature, dispatchPreviewId } from "../dist/console/dispatch.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { deps: { store, env: {} }, rootPath: runtime.project.rootDir, store };
}

function request(pathname, body, overrides = {}) {
  return {
    method: "POST",
    url: new URL(`http://localhost${pathname}`),
    body,
    ...overrides
  };
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

test("console actions: 释放/停止/重新派发三动作（运行中先停止；终态 400；未知 404；落审计）", async () => {
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

  const blockedRelease = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(blockedRelease.status, 409, "运行中不可直接释放");
  assert.match(JSON.parse(blockedRelease.body).error, /停止执行/);

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

  await store.updateRegressionTask(rootPath, task.id, { status: "stopped" });

  const released = await handlePanelActionRequest(
    request("/panel/api/tasks/release", { project: rootPath, taskId: task.id }),
    deps
  );
  assert.equal(released.status, 200, "ack（stopped）→ pending");
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "pending");
  assert.equal(after.claimedBy, null);

  const stopPending = await handlePanelActionRequest(
    request("/panel/api/tasks/stop", { project: rootPath, taskId: task.id }),
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
  const previewId = dispatchPreviewId(preview, formSignature);

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
  const keywordId = dispatchPreviewId(keywordPreview, dispatchFormSignature(keywordParams));
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

test("console actions: 导入单飞（409）＋上传临时文件必清理", async () => {
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

  const expected = `aos-upload-${createHash("sha256").update(Buffer.from(content)).digest("hex").slice(0, 12)}.xlsx`;
  const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("aos-upload-"));
  assert.ok(!leftovers.includes(expected), "上传临时文件已清理");
});
