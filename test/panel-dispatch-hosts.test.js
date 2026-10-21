import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { computeDispatchPreview } from "../dist/console/dispatch.js";
import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { makeTempDir } from "./helpers.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");

function ago(ms) {
  return new Date(NOW - ms).toISOString();
}

async function makeHarness() {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-panel-dispatch-hosts-");
  const root = path.join(dir, "app");
  fs.mkdirSync(root, { recursive: true });
  return { store, dir, root };
}

async function addHost(store, root, spec) {
  await store.upsertHost({
    id: spec.id,
    hostname: spec.hostname,
    kind: spec.kind,
    osPlatform: spec.osPlatform,
    capabilities: spec.capabilities,
    ...(spec.online === false ? { clientSeenAt: null } : { clientSeenAt: ago(60_000) })
  });
  if (spec.label) {
    await store.updateHostRegistration({ id: spec.id, label: spec.label, registeredBy: "ops" });
  }
  await store.scopeHost(spec.id).upsertProject({ rootPath: root, name: `app-${spec.id}` });
}

async function addSet(store, root, hostId, basename, key, caseCount) {
  return store.scopeHost(hostId).recordCaseSet({
    rootPath: root,
    source: `pen:${hostId}.pen`,
    basename,
    features: [
      {
        key,
        name: basename,
        caseCount,
        screens: [],
        jsonPath: `/x/${hostId}-${key}.json`,
        mdPath: `/x/${hostId}-${key}.md`,
        xlsxPath: `/x/${hostId}-${key}.xlsx`
      }
    ]
  });
}

function makeDeps(store, extra = {}) {
  return {
    store,
    env: {},
    workspaceRoot: null,
    storeForHost: (hostId) => store.scopeHost(hostId),
    now: () => NOW,
    ...extra
  };
}

function action(pathname, body) {
  return {
    method: "POST",
    url: new URL(`http://localhost${pathname}`),
    body
  };
}

test("下发预览只列目标主机能力原因；份选项取目标主机作用域", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  const winSet = await addSet(store, root, "h-win", "Windows 回归", "win-login", 2);
  await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 3);
  await store.scopeHost("h-win").createRegressionTask({
    rootPath: root,
    refs: [{ caseSetId: winSet.id, featureKey: "win-login" }],
    platforms: ["android"],
    baseline: "latest"
  });

  const deps = makeDeps(store);
  const preview = await computeDispatchPreview(
    deps,
    root,
    new URLSearchParams({ host: "h-win", platforms: "ios", source: "case-set", ref: winSet.id })
  );

  assert.equal(preview.selectedHostId, "h-win");
  assert.equal(preview.hosts[0].id, "h-win");
  assert.equal(preview.hosts[0].kind, "pc");
  assert.equal(preview.hosts[0].online, true);
  assert.deepEqual(preview.hosts[0].capabilities, ["android"]);
  assert.equal(preview.hosts[0].queueDepth, 1);
  assert.deepEqual(preview.setOptions.map((option) => option.id), [winSet.id]);
  assert.match(preview.warnings.join(" "), /iOS 需要 macOS/);

  const macPreview = await computeDispatchPreview(
    deps,
    root,
    new URLSearchParams({ host: "h-mac", platforms: "ios" })
  );
  assert.equal(macPreview.hosts[0].id, "h-mac");
  assert.ok(!macPreview.warnings.some((warning) => warning.includes("iOS 需要 macOS")));
});

test("createTask 拒绝能力不满足的主机（400 + reasons，不建任务）", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  const winSet = await addSet(store, root, "h-win", "Windows 回归", "win-login", 2);

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      host: "h-win",
      source: "case-set",
      ref: winSet.id,
      platforms: ["ios"],
      baseline: "latest"
    }),
    makeDeps(store)
  );
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.match(body.reasons.join(" "), /iOS 需要 macOS/);
  assert.equal((await store.scopeHost("h-win").listRegressionTasks(root)).length, 0);
});

test("createTask 写 targetHostId/createdHostId；任务行落在目标主机项目", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addHost(store, root, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  const macSet = await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 2);

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      host: "h-mac",
      source: "case-set",
      ref: macSet.id,
      platforms: ["ios"],
      baseline: "latest"
    }),
    makeDeps(store)
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.task.targetHostId, "h-mac");
  assert.equal(body.task.createdHostId, "h-mac");
  assert.equal(body.task.createdBy, "panel");

  const macStore = store.scopeHost("h-mac");
  const macProject = await macStore.getProjectByPath(root);
  const macTasks = await macStore.listRegressionTasks(root);
  assert.equal(macTasks.length, 1);
  assert.equal(macTasks[0].id, body.task.id);
  assert.equal(macTasks[0].projectId, macProject.id);
  assert.equal((await store.scopeHost("h-win").listRegressionTasks(root)).length, 0);
});

test("目标主机离线只告警仍入队；targetHostId 照写", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-linux",
    hostname: "LINUX-01",
    kind: "linux",
    osPlatform: "linux",
    capabilities: ["android"],
    online: false
  });
  const set = await addSet(store, root, "h-linux", "Linux 回归", "linux-login", 1);
  const deps = makeDeps(store);

  const preview = await computeDispatchPreview(
    deps,
    root,
    new URLSearchParams({ host: "h-linux", platforms: "android" })
  );
  assert.equal(preview.hosts[0].online, false);
  assert.match(preview.warnings.join(" "), /目标主机离线，任务会排队等待/);

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      host: "h-linux",
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      baseline: "none"
    }),
    deps
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.task.targetHostId, "h-linux");
  assert.ok(body.warnings.some((warning) => warning.includes("目标主机离线")));
  assert.equal((await store.scopeHost("h-linux").listRegressionTasks(root)).length, 1);
});

test("POST /panel/api/hosts/register 写 label/owner/expected 并审计", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator"]
  });
  const deps = makeDeps(store);

  const res = await handlePanelActionRequest(
    action("/panel/api/hosts/register", {
      host: "h-mac",
      label: "Mac mini",
      owner: "ops",
      expectedOs: "darwin",
      expectedHostname: "MAC-01"
    }),
    deps
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.host.label, "Mac mini");
  assert.equal(body.host.owner, "ops");
  assert.equal(body.host.expectedOs, "darwin");
  assert.equal(body.host.expectedHostname, "MAC-01");
  assert.equal(body.host.registeredBy, "panel");
  assert.ok(body.host.registeredAt);

  const audit = await store.listAudit(root, { domain: "panel" });
  assert.ok(
    audit.some((event) => event.action === "action.hosts.register" && event.result === "ok")
  );

  const badOs = await handlePanelActionRequest(
    action("/panel/api/hosts/register", { host: "h-mac", expectedOs: "freebsd" }),
    deps
  );
  assert.equal(badOs.status, 400);

  const unknown = await handlePanelActionRequest(
    action("/panel/api/hosts/register", { host: "h-nope", label: "x" }),
    deps
  );
  assert.equal(unknown.status, 404);
});

test("未知主机下发 → 400/404 且不建任务", async () => {
  const { store, root, dir } = await makeHarness();
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  const set = await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 1);

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      host: "h-nope",
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      baseline: "latest"
    }),
    makeDeps(store, { workspaceRoot: dir })
  );
  assert.ok(res.status === 400 || res.status === 404, `status=${res.status}`);
  const body = JSON.parse(res.body);
  assert.match(body.error, /未知主机/);
  assert.equal((await store.scopeHost("h-nope").listRegressionTasks(root)).length, 0);
  assert.equal((await store.scopeHost("h-mac").listRegressionTasks(root)).length, 0);
});

test("未知主机预览：告警、不选中且禁用派发", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });

  const preview = await computeDispatchPreview(
    makeDeps(store),
    root,
    new URLSearchParams({ host: "h-nope", platforms: "android" })
  );
  assert.equal(preview.selectedHostId, null);
  assert.equal(preview.hostBlocked, true);
  assert.match(preview.warnings.join(" "), /未知主机/);
  assert.equal(preview.hosts.length, 1);
});

test("目标主机未登记项目 → 404（不建任务）", async () => {
  const { store, root, dir } = await makeHarness();
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  const set = await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 1);
  await store.upsertHost({
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      host: "h-win",
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      baseline: "latest"
    }),
    makeDeps(store, { workspaceRoot: dir })
  );
  assert.equal(res.status, 404);
  assert.match(JSON.parse(res.body).error, /未登记项目/);
  assert.equal((await store.scopeHost("h-win").listRegressionTasks(root)).length, 0);
});

test("历史 NULL-host 项目 → 409＋adopt-legacy 指引（不隐式认领）", async () => {
  const { store, root } = await makeHarness();
  await store.upsertHost({
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await store.upsertProject({ rootPath: root, name: "legacy" });
  const legacySet = await store.recordCaseSet({
    rootPath: root,
    source: "pen:legacy.pen",
    basename: "旧项目",
    features: [
      {
        key: "legacy-login",
        name: "旧项目",
        caseCount: 1,
        screens: [],
        jsonPath: "/x/legacy.json",
        mdPath: "/x/legacy.md",
        xlsxPath: "/x/legacy.xlsx"
      }
    ]
  });

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      source: "case-set",
      ref: legacySet.id,
      platforms: ["android"],
      baseline: "latest"
    }),
    makeDeps(store)
  );
  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.match(body.reasons.join(" "), /host adopt-legacy --local --apply/);
  assert.equal((await store.listRegressionTasks(root)).length, 0);
});

test("已登记主机时缺 host → 400（不再隐式回退本机）", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  const set = await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 1);

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      baseline: "latest"
    }),
    makeDeps(store)
  );
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /缺少 host（已登记主机时必选）/);
  assert.equal((await store.scopeHost("h-mac").listRegressionTasks(root)).length, 0);
});

test("下发页渲染主机下拉与空态", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, root, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"],
    label: "Windows 机"
  });
  await addHost(store, root, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"],
    label: "Mac 机"
  });
  const deps = makeDeps(store);

  const res = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(root)}&section=dispatch&host=h-win&platforms=ios`
    ),
    deps
  );
  assert.equal(res.status, 200);
  const html = String(res.body);
  assert.match(html, /name="host"/);
  assert.match(html, /aria-label="目标主机"/);
  assert.match(html, /<option value="h-win"[^>]*selected/);
  assert.match(html, /Windows 机/);
  assert.match(html, /iOS 需要 macOS/);
  assert.match(html, /目标主机无法满足所选平台/);
  assert.match(html, /id="dispatch-submit"[^>]*disabled/, "能力不满足时确认按钮禁用");
  assert.match(html, /"hostRequired":true/);
  assert.match(html, /"hostBlocked":true/);
  assert.match(html, /p\.reasons/, "错误原因回显");
  assert.match(html, /p\.warnings/, "成功告警回显");
  assert.ok(
    html.includes("(host?'&host='+encodeURIComponent(host):'')"),
    "派发成功跳转携带 host"
  );
  assert.ok(html.includes('"&host="+encodeURIComponent(host)'), "审计 flash 链接携带 host");

  const pickStore = new MemoryStore();
  await pickStore.upsertHost({
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  const pick = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(root)}&section=dispatch`),
    makeDeps(pickStore, { workspaceRoot: path.dirname(root) })
  );
  const pickHtml = String(pick.body);
  assert.match(pickHtml, /"hostRequired":true/);
  assert.match(pickHtml, /"hostId":null/);
  assert.match(pickHtml, /id="dispatch-submit"[^>]*disabled/, "未选主机时确认按钮禁用");
  assert.match(pickHtml, /请先选择目标主机/);

  const emptyStore = new MemoryStore();
  await emptyStore.upsertProject({ rootPath: root, name: "app" });
  const empty = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(root)}&section=dispatch`),
    makeDeps(emptyStore)
  );
  assert.match(String(empty.body), /单机模式/);
});
