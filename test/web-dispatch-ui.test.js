import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { handlePanelRequest } from "../dist/panel/web.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const SEEN = new Date(NOW - 5_000).toISOString();

function tools(overrides = {}) {
  return {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false,
    ...overrides
  };
}

function androidDevice(serial, model = "Pixel 7", osVersion = "14") {
  return {
    serial,
    name: model,
    model,
    osVersion,
    platform: "android",
    kind: "device",
    state: "device"
  };
}

async function createAsset(store, rootPath, kind, filename, sha, metadata = {}) {
  return store.createWebAsset({
    rootPath,
    kind,
    filename,
    sha256: sha.repeat(64).slice(0, 64),
    size: 1024,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", kind, `${filename}`),
    uploadedBy: "alice",
    metadata
  });
}

async function writeResultDoc(rootPath, jobId, overrides = {}) {
  const document = {
    schemaVersion: 1,
    jobId,
    resultSha256: "f".repeat(64),
    receivedAt: "2026-10-29T00:10:00.000Z",
    taskStatus: "completed",
    dbStatus: "completed",
    gate: { result: "passed", total: 1, passed: 1, failed: 0, errors: 0, skipped: 0 },
    execution: {
      status: "passed",
      cases: [
        { caseId: "TC-100", name: "完成态用例", status: "PASS", durationMs: 100, traceId: "trace-9" }
      ],
      startedAt: "2026-10-29T00:05:00.000Z",
      finishedAt: "2026-10-29T00:08:00.000Z",
      detail: null
    },
    device: { serial: "emulator-5554", model: "Pixel 7", osVersion: "14" },
    package: { name: "com.acme.app", version: "1.2.3", filename: "app-release.apk" },
    startedAt: "2026-10-29T00:05:00.000Z",
    finishedAt: "2026-10-29T00:08:00.000Z",
    evidence: [],
    tokenUsage: null,
    tokenTotals: null,
    tokenArtifacts: null,
    allowClearedRefresh: false,
    writebackStatus: "written",
    writebackError: null,
    writtenCells: [],
    warnings: [],
    ...overrides
  };
  const dir = path.join(rootPath, ".artemis", "web", "results", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "result.json"), `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

async function setup(t, options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-web-dispatch-ui-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  const project = await store.upsertProject({ rootPath, name: "acme" });
  await store.createWebProject({
    rootPath,
    name: "acme",
    normalizedName: "acme",
    platforms: ["android", "ios"],
    projectId: project.id
  });
  const excel = await createAsset(store, rootPath, "excel", "回归用例.xlsx", "a");
  const pkg = await createAsset(store, rootPath, "package", "app-release.apk", "b");
  const materials = await createAsset(store, rootPath, "materials", "账号.json", "c");
  const script = await createAsset(store, rootPath, "scripts", "flows.zip", "d", {
    sourceExcelAssetId: excel.id,
    packageAssetId: pkg.id
  });

  if (options.runners !== false) {
    await store.upsertWebRunner({
      hostId: "host-a",
      name: "runner-a",
      hostname: "host-a.local",
      platforms: ["android"],
      devices: [androidDevice("emulator-5554", "Pixel 7", "14")],
      tools: tools({ adb: true, maestro: true }),
      artifactBaseUrl: null,
      version: "0.1.0",
      instanceId: "inst-a",
      lastSeenAt: SEEN
    });
    await store.upsertWebRunner({
      hostId: "host-b",
      name: "runner-b",
      hostname: "host-b.local",
      platforms: ["android"],
      devices: [androidDevice("R58M12345", "Galaxy S23", "15")],
      tools: tools({ adb: true, maestro: true }),
      artifactBaseUrl: null,
      version: "0.1.0",
      instanceId: "inst-b",
      lastSeenAt: SEEN
    });
  }

  const deps = {
    store,
    env: {},
    workspaceRoot: workspace,
    buildStale: false,
    now: () => NOW
  };
  return { deps, store, rootPath, excel, pkg, materials, script, workspace };
}

function jobsUrl(rootPath, hostId = null) {
  const params = new URLSearchParams({ project: rootPath, section: "jobs" });
  if (hostId !== null) params.set("host", hostId);
  return new URL(`http://x/panel?${params.toString()}`);
}

function jobDetailUrl(rootPath, jobId) {
  return new URL(
    `http://x/panel?project=${encodeURIComponent(rootPath)}&section=jobs&job=${encodeURIComponent(jobId)}`
  );
}

function previewUrl(rootPath, extra = {}) {
  const params = new URLSearchParams({ project: rootPath, assignment: "auto", platform: "android" });
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return new URL(`http://x/panel/api/jobs/preview?${params.toString()}`);
}

function autoBody(rootPath, assets, overrides = {}) {
  return {
    project: rootPath,
    assignment: "auto",
    requirements: { platform: "android", deviceKind: "any" },
    excelAssetId: assets.excel.id,
    packageAssetId: assets.pkg.id,
    executionMode: "maestro",
    ...overrides
  };
}

async function postJob(deps, body, role = "dispatcher") {
  return handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/jobs"),
      body,
      identity: { name: "alice", role, source: "user" }
    },
    deps
  );
}

function capabilities(role, options = {}) {
  return { actions: true, usage: true, mode: "http", role, ...options };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

test("jobs page: dispatch form with host, device and soft preferences", async (t) => {
  const { deps, rootPath, excel, pkg } = await setup(t);
  const response = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(response.status, 200);
  const html = response.body;

  assert.match(html, /下发测试/);
  assert.match(html, /id="web-job-form"/);
  assert.match(html, /id="web-job-assignment"[^>]*name="assignment"/);
  assert.match(html, /<option value="auto"/);
  assert.match(html, /<option value="manual"/);

  assert.match(html, /id="web-job-host"[^>]*name="targetHostId"/);
  assert.match(html, /<option value="host-a"/);
  assert.match(html, /host-a\.local/);
  assert.match(html, /id="web-job-device"[^>]*name="deviceSerial"/);
  assert.match(html, /<option value="emulator-5554"/);
  assert.match(html, /Pixel 7/);
  assert.match(html, /<option value="R58M12345"/);
  assert.match(html, /Galaxy S23/);

  // 软偏好与用例范围
  assert.match(html, /id="web-job-model"[^>]*name="deviceModel"/);
  assert.match(html, /id="web-job-os-min"[^>]*name="osMin"/);
  assert.match(html, /id="web-job-os-max"[^>]*name="osMax"/);
  assert.match(html, /id="web-job-case-modules"[^>]*name="caseModules"/);
  assert.match(html, /id="web-job-case-ids"[^>]*name="caseIds"/);

  // 资产版本选择
  assert.match(html, new RegExp(`<option value="${excel.id}"`));
  assert.match(html, new RegExp(`<option value="${pkg.id}"`));
  assert.match(html, /回归用例\.xlsx/);
  assert.match(html, /app-release\.apk/);

  // 执行方式 + 动作端点
  assert.match(html, /id="web-job-mode"[^>]*name="executionMode"/);
  assert.match(html, /<option value="maestro"/);
  assert.match(html, /<option value="llm"/);
  assert.match(html, /id="web-job-submit"[^>]*data-busy-label="下发中…"/);
  assert.match(html, /\/panel\/api\/jobs\/preview/);

  const ownScripts = inlineScripts(html).filter((code) => code.includes("/panel/api/jobs"));
  assert.equal(ownScripts.length, 1, "下发表单脚本存在");
  assert.doesNotThrow(() => new Function(ownScripts[0]), "下发表单脚本可解析");
});

test("jobs page without project: project picker instead of a broken form", async (t) => {
  const { deps } = await setup(t);
  const response = await handlePanelRequest(new URL("http://x/panel?section=jobs"), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /选择项目/);
  assert.match(response.body, /section=jobs/);
  assert.ok(!response.body.includes('id="web-job-form"'), "无项目不渲染下发写表单");
});

test("jobs page: viewer is read-only, dispatcher and above get write controls", async (t) => {
  const { deps, rootPath } = await setup(t);
  const viewer = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("viewer")
  });
  assert.equal(viewer.status, 200);
  assert.match(viewer.body, /id="web-job-submit"[^>]* disabled/);
  assert.match(viewer.body, /需要 dispatcher/);
  assert.ok(
    !viewer.body.includes("fetch('/panel/api/jobs'"),
    "viewer 不注入下发脚本"
  );
  assert.ok(!viewer.body.includes("/panel/api/jobs/preview"), "viewer 不注入预览脚本");

  for (const role of ["dispatcher", "maintainer", "admin"]) {
    const response = await handlePanelRequest(jobsUrl(rootPath), {
      ...deps,
      capabilities: capabilities(role)
    });
    assert.ok(
      !/id="web-job-submit"[^>]* disabled/.test(response.body),
      `${role} 可下发`
    );
  }
});

test("POST /panel/api/jobs auto binds host+device and the page shows it", async (t) => {
  const { deps, store, rootPath, excel, pkg, materials, script } = await setup(t);
  let cleared = 0;
  const cache = {
    get() {
      return undefined;
    },
    set() {},
    clear() {
      cleared += 1;
    }
  };
  const response = await postJob(
    { ...deps, cache },
    autoBody(rootPath, { excel, pkg }, { materialsAssetId: materials.id, scriptSetId: script.id })
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "bound");
  assert.equal(payload.assignment.hostId, "host-a");
  assert.equal(payload.assignment.deviceSerial, "emulator-5554");
  assert.equal(typeof payload.assignment.score, "number");
  assert.equal(payload.job.status, "pending");
  assert.equal(payload.job.deviceSerial, "emulator-5554");
  assert.equal(cleared, 1, "成功下发清空面板缓存");
  const audit = await store.listAudit(rootPath, { domain: "panel", limit: 5 });
  const jobAudit = audit.find((event) => event.action === "action.jobs");
  assert.equal(jobAudit?.refs.taskId, payload.job.id, "审计行关联任务 id");

  const leases = await store.listDeviceLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].taskId, payload.job.id);

  const page = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`job=${encodeURIComponent(payload.job.id)}`));
  assert.match(page.body, /已绑定 host\/device/);
  assert.match(page.body, /<code>host-a<\/code>/);
  assert.match(page.body, /<code>emulator-5554<\/code>/);
});

test("POST /panel/api/jobs manual: pinned device must belong to the target host", async (t) => {
  const { deps, store, rootPath, excel, pkg } = await setup(t);
  const before = await store.listRegressionTasks(rootPath);
  const conflict = await postJob(deps, {
    ...autoBody(rootPath, { excel, pkg }),
    assignment: "manual",
    targetHostId: "host-b",
    deviceSerial: "emulator-5554"
  });
  assert.equal(conflict.status, 409);
  const conflictBody = JSON.parse(conflict.body);
  assert.equal(conflictBody.code, "device-not-on-host");
  assert.match(conflictBody.error, /emulator-5554/);
  assert.equal((await store.listRegressionTasks(rootPath)).length, before.length, "冲突不建任务");
  assert.equal((await store.listDeviceLeases()).length, 0, "冲突不占租约");

  const ok = await postJob(deps, {
    ...autoBody(rootPath, { excel, pkg }),
    assignment: "manual",
    targetHostId: "host-a",
    deviceSerial: "emulator-5554"
  });
  assert.equal(ok.status, 200);
  const okBody = JSON.parse(ok.body);
  assert.equal(okBody.assignment.hostId, "host-a");
  assert.equal(okBody.assignment.deviceSerial, "emulator-5554");

  const hostConflict = await postJob(deps, {
    ...autoBody(rootPath, { excel, pkg }),
    assignment: "manual"
  });
  assert.equal(hostConflict.status, 400);
  assert.equal(JSON.parse(hostConflict.body).code, "manual-requires-host");
});

test("GET /panel/api/jobs/preview is read-only and never leaks runner secrets", async (t) => {
  const { deps, store, rootPath } = await setup(t);
  const secret = "runner-job-token-should-not-leak";
  const artifactSecret = "runner-artifact-token-should-not-leak";
  const preview = await handlePanelActionRequest(
    {
      method: "GET",
      url: previewUrl(rootPath),
      body: undefined,
      identity: { name: "eve", role: "viewer", source: "user" }
    },
    { ...deps, env: { AOS_RUNNER_JOB_TOKEN: secret, AOS_RUNNER_ARTIFACT_TOKEN: artifactSecret } }
  );
  assert.equal(preview.status, 200);
  const payload = JSON.parse(preview.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.selection.hostId, "host-a");
  assert.equal(payload.selection.deviceSerial, "emulator-5554");
  assert.equal(typeof payload.selection.score, "number");
  assert.ok(Array.isArray(payload.selection.reasons));
  assert.ok(!preview.body.includes(secret), "预览不泄露 runner 令牌");
  assert.ok(!preview.body.includes(artifactSecret), "预览不泄露工件令牌");
  assert.equal((await store.listDeviceLeases()).length, 0, "预览不创建租约");
  assert.equal((await store.listRegressionTasks(rootPath)).length, 0, "预览不创建任务");

  const page = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.ok(!page.body.includes(secret), "页面不泄露 runner 令牌");
  assert.ok(!page.body.includes(artifactSecret), "页面不泄露工件令牌");
});

test("POST auto with no eligible runner stays pending with an explicit waiting state", async (t) => {
  const { deps, store, rootPath, excel, pkg } = await setup(t, { runners: false });
  const response = await postJob(deps, autoBody(rootPath, { excel, pkg }));
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "pending");
  assert.equal(payload.assignment, null);
  assert.match(payload.message, /等待满足要求的执行机/);
  assert.equal(payload.job.status, "pending");
  assert.equal(payload.job.deviceSerial, null);
  assert.equal((await store.listDeviceLeases()).length, 0);

  const page = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.match(page.body, /等待满足要求的执行机/);
  assert.ok(!page.body.includes("已绑定 host/device"), "pending 不当成成功");
});

test("POST /panel/api/jobs role gate: viewer 403, dispatcher/maintainer/admin allowed", async (t) => {
  const denied = await setup(t);
  const deniedResponse = await postJob(
    denied.deps,
    autoBody(denied.rootPath, denied),
    "viewer"
  );
  assert.equal(deniedResponse.status, 403);
  assert.equal(JSON.parse(deniedResponse.body).code, "role_forbidden");

  for (const role of ["dispatcher", "maintainer", "admin"]) {
    const fixture = await setup(t);
    const response = await postJob(fixture.deps, autoBody(fixture.rootPath, fixture), role);
    assert.equal(response.status, 200, `${role} 可下发`);
    assert.equal(JSON.parse(response.body).status, "bound");
  }
});

test("job detail shows device, package, cases, evidence links and writeback status", async (t) => {
  const { deps, store, rootPath, excel, pkg } = await setup(t);
  const created = JSON.parse(
    (await postJob(deps, autoBody(rootPath, { excel, pkg }))).body
  );
  const jobId = created.job.id;
  const resultDir = path.join(rootPath, ".artemis", "web", "results", jobId);
  await mkdir(resultDir, { recursive: true });
  await writeFile(
    path.join(resultDir, "result.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        jobId,
        resultSha256: "e".repeat(64),
        receivedAt: "2026-10-29T00:10:00.000Z",
        taskStatus: "partial",
        dbStatus: "partial",
        gate: { result: "partial", total: 2, passed: 1, failed: 1, errors: 0, skipped: 0 },
        execution: {
          status: "partial",
          cases: [
            {
              caseId: "TC-001",
              name: "登录成功",
              status: "PASS",
              durationMs: 1200,
              traceId: "trace-1"
            },
            {
              caseId: "TC-002",
              name: "登录失败提示",
              status: "FAIL",
              durationMs: 800,
              failureStep: "点击登录",
              failureReason: "提示文案不一致",
              traceId: "trace-2",
              screenshotPaths: ["screens/TC-002.png"]
            }
          ],
          startedAt: "2026-10-29T00:05:00.000Z",
          finishedAt: "2026-10-29T00:08:00.000Z",
          detail: null
        },
        device: { serial: "emulator-5554", model: "Pixel 7", osVersion: "14" },
        package: { name: "com.acme.app", version: "1.2.3", filename: "app-release.apk" },
        startedAt: "2026-10-29T00:05:00.000Z",
        finishedAt: "2026-10-29T00:08:00.000Z",
        evidence: ["traces/trace-1", "traces/trace-2"],
        tokenUsage: null,
        tokenTotals: null,
        tokenArtifacts: null,
        allowClearedRefresh: false,
        writebackStatus: "written",
        writebackError: null,
        writtenCells: [],
        warnings: []
      },
      null,
      2
    )}\n`
  );

  const response = await handlePanelRequest(jobDetailUrl(rootPath, jobId), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(response.status, 200);
  const html = response.body;

  assert.match(html, /下发任务详情/);
  assert.match(html, new RegExp(jobId));
  assert.match(html, /Pixel 7/);
  assert.match(html, /emulator-5554/);
  assert.match(html, /14/);
  assert.match(html, /com\.acme\.app/);
  assert.match(html, /1\.2\.3/);
  assert.match(html, /app-release\.apk/);
  assert.match(html, /TC-001/);
  assert.match(html, /TC-002/);
  assert.match(html, /提示文案不一致/);
  assert.match(html, /trace-1/);
  assert.match(html, /\/panel\/artifact\?project=/);
  assert.match(html, /已写回/);
  assert.match(html, /结果 1\/2/);
  assert.match(html, /来源：结果上报/);

  const missing = JSON.parse(
    (await postJob(deps, autoBody(rootPath, { excel, pkg }))).body
  );
  const empty = await handlePanelRequest(jobDetailUrl(rootPath, missing.job.id), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(empty.status, 200);
  assert.match(empty.body, /尚无结果/);
  assert.match(empty.body, /来源：执行机心跳/);
  assert.ok(!empty.body.includes("com.acme.app"), "不虚构包信息");
});

test("pinned pending job shows waiting, not bound (no lease yet)", async (t) => {
  const { deps, store, rootPath, excel, pkg } = await setup(t, { runners: false });
  const response = await postJob(deps, {
    ...autoBody(rootPath, { excel, pkg }),
    assignment: "manual",
    targetHostId: "host-a",
    deviceSerial: "emulator-5554"
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.status, "pending");
  assert.equal(payload.job.status, "pending");
  assert.equal(payload.job.deviceSerial, "emulator-5554", "钉住的设备留在任务意图里");
  assert.equal(payload.job.deviceLeaseId, null, "没有租约");
  assert.equal((await store.listDeviceLeases()).length, 0);

  const page = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /钉住 host\/设备，等待执行机/);
  assert.match(page.body, /emulator-5554/);
  assert.match(page.body, /未注册 Web 执行机/, "assignmentError 原因可见");
  assert.ok(!page.body.includes("已绑定 host/device"), "钉住不等于已绑定");

  const detail = await handlePanelRequest(jobDetailUrl(rootPath, payload.job.id), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(detail.status, 200);
  assert.match(detail.body, /钉住 host\/设备，等待执行机/);
  assert.ok(!detail.body.includes("已绑定 host/device"), "详情也不当作已绑定");
});

test("host scope travels with dispatch and preview for a shared rootPath", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-web-dispatch-hosts-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  const scopedA = store.scopeHost("host-a");
  const scopedB = store.scopeHost("host-b");
  await scopedA.upsertProject({ rootPath, name: "acme" });
  await scopedB.upsertProject({ rootPath, name: "acme" });
  await scopedA.createWebProject({
    rootPath,
    name: "acme",
    normalizedName: "acme",
    platforms: ["android"]
  });
  const excel = await createAsset(scopedA, rootPath, "excel", "回归用例.xlsx", "a");
  const pkg = await createAsset(scopedA, rootPath, "package", "app-release.apk", "b");
  await scopedA.upsertWebRunner({
    hostId: "host-a",
    name: "runner-a",
    hostname: "host-a.local",
    platforms: ["android"],
    devices: [androidDevice("emulator-5554", "Pixel 7", "14")],
    tools: tools({ adb: true, maestro: true }),
    artifactBaseUrl: null,
    version: "0.1.0",
    instanceId: "inst-a",
    lastSeenAt: SEEN
  });
  const deps = {
    store,
    env: {},
    workspaceRoot: workspace,
    buildStale: false,
    now: () => NOW,
    storeForHost: (hostId) => store.scopeHost(hostId)
  };

  const body = autoBody(rootPath, { excel, pkg });
  const identity = { name: "eve", role: "viewer", source: "user" };
  const previewAmbiguous = await handlePanelActionRequest(
    { method: "GET", url: previewUrl(rootPath), body: undefined, identity },
    deps
  );
  assert.equal(previewAmbiguous.status, 409);
  assert.match(previewAmbiguous.body, /跨主机重复/);

  const previewScoped = await handlePanelActionRequest(
    { method: "GET", url: previewUrl(rootPath, { host: "host-a" }), body: undefined, identity },
    deps
  );
  assert.equal(previewScoped.status, 200);
  assert.equal(JSON.parse(previewScoped.body).selection.deviceSerial, "emulator-5554");

  const ambiguous = await postJob(deps, body);
  assert.equal(ambiguous.status, 409, "无 host 时同路径跨主机必须歧义");
  assert.match(ambiguous.body, /跨主机重复/);

  const scoped = await postJob(deps, { ...body, host: "host-a" });
  assert.equal(scoped.status, 200);
  assert.equal(JSON.parse(scoped.body).assignment.hostId, "host-a");

  const page = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(rootPath)}&section=jobs&host=host-a`),
    { ...deps, capabilities: capabilities("dispatcher") }
  );
  assert.equal(page.status, 200);
  assert.match(page.body, /if\(host\)out\.host=host/, "POST body 携带 host");
  assert.match(page.body, /if\(host\)params\.set\("host",host\)/, "预览查询携带 host");
});

test("terminal task with released lease keeps device identity (released, not unbound)", async (t) => {
  const { deps, store, rootPath, excel, pkg } = await setup(t);
  const created = JSON.parse((await postJob(deps, autoBody(rootPath, { excel, pkg }))).body);
  const jobId = created.job.id;
  await store.releaseDeviceLeases({ hostId: "host-a", taskId: jobId });
  await store.updateRegressionTask(rootPath, jobId, {
    status: "completed",
    deviceLeaseId: null
  });
  const task = await store.getRegressionTask(rootPath, jobId);
  assert.equal(task.status, "completed");
  assert.equal(task.deviceSerial, "emulator-5554", "终态保留设备序列号");
  assert.equal(task.deviceLeaseId, null, "租约已释放");
  assert.equal((await store.listDeviceLeases()).length, 0);
  await writeResultDoc(rootPath, jobId);

  const page = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /已释放 host\/device/);
  assert.match(page.body, /<code>host-a<\/code>/);
  assert.match(page.body, /<code>emulator-5554<\/code>/);
  assert.match(page.body, /Pixel 7/);
  assert.ok(!page.body.includes("未绑定设备（已完成）"), "终态不当作未绑定");
  assert.ok(!page.body.includes("已绑定 host/device"), "已释放不是仍占用");

  const detail = await handlePanelRequest(jobDetailUrl(rootPath, jobId), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(detail.status, 200);
  assert.match(detail.body, /已释放 host\/device/);
  assert.match(detail.body, /Pixel 7/);
  assert.match(detail.body, /14/);
  assert.match(detail.body, /来源：结果上报/);
  assert.match(detail.body, /结果 1\/1/);
});

test("running task without binding stays explicitly unbound (not released/bound)", async (t) => {
  const { deps, store, rootPath, excel, pkg } = await setup(t, { runners: false });
  const created = JSON.parse((await postJob(deps, autoBody(rootPath, { excel, pkg }))).body);
  await store.updateRegressionTask(rootPath, created.job.id, { status: "running" });
  const page = await handlePanelRequest(jobsUrl(rootPath), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /未绑定设备（执行中）/);
  assert.ok(!page.body.includes("已释放 host/device"));
  assert.ok(!page.body.includes("已绑定 host/device"));
});

test("job detail: unknown job is 404 and project page links to jobs", async (t) => {
  const { deps, rootPath } = await setup(t);
  const missing = await handlePanelRequest(jobDetailUrl(rootPath, "no-such-job"), {
    ...deps,
    capabilities: capabilities("dispatcher")
  });
  assert.equal(missing.status, 404);

  const projectPage = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(rootPath)}`),
    { ...deps, capabilities: capabilities("dispatcher") }
  );
  assert.equal(projectPage.status, 200);
  assert.match(projectPage.body, /section=jobs[^"]*"[^>]*>下发测试</);
});
