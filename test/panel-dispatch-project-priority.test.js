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
  const dir = makeTempDir("aos-panel-dispatch-project-");
  const root = path.join(dir, "app");
  fs.mkdirSync(root, { recursive: true });
  return { store, dir, root };
}

async function addHost(store, spec) {
  await store.upsertHost({
    id: spec.id,
    hostname: spec.hostname,
    kind: spec.kind,
    osPlatform: spec.osPlatform,
    capabilities: spec.capabilities,
    clientSeenAt: ago(60_000)
  });
}

async function addProject(store, hostId, rootPath, name) {
  return store.scopeHost(hostId).upsertProject({ rootPath, name });
}

async function addSet(store, rootPath, hostId, basename, key, caseCount) {
  return store.scopeHost(hostId).recordCaseSet({
    rootPath,
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

test("预览 projects 只列选中主机的项目；其余主机不串", async () => {
  const { store, dir } = await makeHarness();
  const macRoot = path.join(dir, "mac-app");
  const winRoot = path.join(dir, "win-app");
  fs.mkdirSync(macRoot, { recursive: true });
  fs.mkdirSync(winRoot, { recursive: true });
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addHost(store, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  await addProject(store, "h-mac", macRoot, "mac-app");
  await addProject(store, "h-win", winRoot, "win-app");

  const preview = await computeDispatchPreview(
    makeDeps(store),
    winRoot,
    new URLSearchParams({ host: "h-win", platforms: "android" })
  );
  assert.deepEqual(preview.projects, [
    { hostId: "h-win", rootPath: winRoot, name: "win-app" }
  ]);
  assert.ok(!preview.projects.some((project) => project.rootPath === macRoot));
});

test("无主机台账时 projects 显示当前项目；优先级默认 0", async () => {
  const { store, root } = await makeHarness();
  await store.upsertProject({ rootPath: root, name: "app" });

  const preview = await computeDispatchPreview(
    makeDeps(store),
    root,
    new URLSearchParams({ platforms: "android" })
  );
  assert.equal(preview.selectedHostId, null);
  assert.deepEqual(
    preview.projects.map((project) => ({ rootPath: project.rootPath, name: project.name })),
    [{ rootPath: root, name: "app" }]
  );
  assert.equal(preview.priority, 0);
});

test("优先级参数：整数读取、越界钳制、非法告警回落 0", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addProject(store, "h-mac", root, "app");
  const deps = makeDeps(store);

  const normal = await computeDispatchPreview(
    deps,
    root,
    new URLSearchParams({ host: "h-mac", platforms: "android", priority: "7" })
  );
  assert.equal(normal.priority, 7);
  assert.ok(!normal.warnings.some((warning) => warning.includes("优先级")));

  const clamped = await computeDispatchPreview(
    deps,
    root,
    new URLSearchParams({ host: "h-mac", platforms: "android", priority: "150" })
  );
  assert.equal(clamped.priority, 100);

  const invalid = await computeDispatchPreview(
    deps,
    root,
    new URLSearchParams({ host: "h-mac", platforms: "android", priority: "abc" })
  );
  assert.equal(invalid.priority, 0);
  assert.match(invalid.warnings.join(" "), /优先级/);
});

test("下发页渲染项目下拉并选中当前路径；优先级默认只读", async () => {
  const { store, dir } = await makeHarness();
  const macRoot = path.join(dir, "mac-app");
  const winRoot = path.join(dir, "win-app");
  fs.mkdirSync(macRoot, { recursive: true });
  fs.mkdirSync(winRoot, { recursive: true });
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addHost(store, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  await addProject(store, "h-mac", macRoot, "mac-app");
  await addProject(store, "h-win", winRoot, "win-app");

  const res = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(winRoot)}&section=dispatch&host=h-win&platforms=android`
    ),
    makeDeps(store)
  );
  assert.equal(res.status, 200);
  const html = String(res.body);
  assert.match(html, /<select name="project" aria-label="项目">/);
  assert.ok(html.includes(`<option value="${winRoot}" selected>win-app</option>`));
  assert.ok(!html.includes(`value="${macRoot}"`), "不列其他主机的项目");
  assert.ok(!html.includes('name="priority"'), "默认不渲染可编辑优先级");
  assert.match(html, /优先级/);
  assert.match(html, /P0/);

  const editable = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(winRoot)}&section=dispatch&host=h-win&platforms=android`
    ),
    makeDeps(store, { env: { AOS_PANEL_PRIORITY: "1" } })
  );
  const editableHtml = String(editable.body);
  assert.match(
    editableHtml,
    /<input type="number" name="priority" aria-label="优先级"[^>]*value="0"/
  );
});

test("选中主机无项目：提示该主机尚未登记项目并禁用提交", async () => {
  const { store, root, dir } = await makeHarness();
  await addHost(store, {
    id: "h-empty",
    hostname: "EMPTY-01",
    kind: "linux",
    osPlatform: "linux",
    capabilities: ["android"]
  });

  const preview = await computeDispatchPreview(
    makeDeps(store),
    root,
    new URLSearchParams({ host: "h-empty", platforms: "android" })
  );
  assert.deepEqual(preview.projects, []);
  assert.equal(preview.hostBlocked, true);

  const res = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(root)}&section=dispatch&host=h-empty&platforms=android`
    ),
    makeDeps(store, { workspaceRoot: dir })
  );
  assert.equal(res.status, 200);
  const html = String(res.body);
  assert.match(html, /该主机尚未登记项目/);
  assert.match(html, /<select name="project" aria-label="项目">/);
  assert.ok(html.includes(`<option value="${root}" selected>app（当前项目）</option>`));
  assert.match(html, /id="dispatch-submit"[^>]*disabled/);
});

test("主机切换导航丢弃 project；缺 project 时选该主机最近项目", async () => {
  const { store, dir } = await makeHarness();
  const macRoot = path.join(dir, "mac-app");
  const winOld = path.join(dir, "win-old");
  const winNew = path.join(dir, "win-new");
  for (const dirPath of [macRoot, winOld, winNew]) fs.mkdirSync(dirPath, { recursive: true });
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addHost(store, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  await addProject(store, "h-mac", macRoot, "mac-app");
  await addProject(store, "h-win", winOld, "win-old");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await addProject(store, "h-win", winNew, "win-new");

  const res = await handlePanelRequest(
    new URL("http://x/panel?section=dispatch&host=h-win"),
    makeDeps(store)
  );
  assert.equal(res.status, 200);
  const html = String(res.body);
  assert.ok(html.includes(`<option value="${winNew}" selected>win-new</option>`));
  assert.ok(!html.includes(`value="${macRoot}"`));

  const hostNav = html.slice(html.indexOf('id="dispatch-host-nav"'));
  const hostChunk = hostNav.slice(0, hostNav.indexOf("</script>"));
  assert.match(hostChunk, /params\.set\('section','dispatch'\)/);
  assert.match(hostChunk, /params\.set\('host',select\.value\)/);
  assert.ok(!hostChunk.includes("project"), "切换主机时丢弃 project");
});

test("仅按主机进入且该主机无项目：空态而非 404", async () => {
  const { store } = await makeHarness();
  await addHost(store, {
    id: "h-empty",
    hostname: "EMPTY-01",
    kind: "linux",
    osPlatform: "linux",
    capabilities: ["android"]
  });

  const res = await handlePanelRequest(
    new URL("http://x/panel?section=dispatch&host=h-empty"),
    makeDeps(store)
  );
  assert.equal(res.status, 200);
  const html = String(res.body);
  assert.match(html, /该主机尚未登记项目/);
  assert.match(html, /<select name="project" aria-label="项目">/);
  assert.match(html, /id="dispatch-submit"[^>]*disabled/);
});

test("legacy NULL-host 项目不挂到任何主机的项目下拉", async () => {
  const { store, dir } = await makeHarness();
  const legacyRoot = path.join(dir, "legacy-app");
  fs.mkdirSync(legacyRoot, { recursive: true });
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addHost(store, {
    id: "h-win",
    hostname: "WIN-01",
    kind: "pc",
    osPlatform: "win32",
    capabilities: ["android"]
  });
  await store.upsertProject({ rootPath: legacyRoot, name: "legacy" });

  const remote = await computeDispatchPreview(
    makeDeps(store),
    legacyRoot,
    new URLSearchParams({ host: "h-win", platforms: "android" })
  );
  assert.deepEqual(remote.projects, []);

  store.bindHost("h-mac");
  const local = await computeDispatchPreview(
    makeDeps(store),
    legacyRoot,
    new URLSearchParams({ host: "h-mac", platforms: "android" })
  );
  assert.deepEqual(local.projects, []);
});

test("createTask 写 priority；任务列表与详情展示 P 徽章", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addProject(store, "h-mac", root, "app");
  const set = await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 2);
  const deps = makeDeps(store);

  const res = await handlePanelActionRequest(
    action("/panel/api/tasks", {
      project: root,
      host: "h-mac",
      source: "case-set",
      ref: set.id,
      platforms: ["android"],
      baseline: "latest",
      priority: 7
    }),
    deps
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.task.priority, 7);
  assert.equal((await store.scopeHost("h-mac").getRegressionTask(root, body.task.id)).priority, 7);

  const list = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(root)}&host=h-mac&section=tasks`),
    deps
  );
  assert.match(String(list.body), /P7/);

  const detail = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(root)}&host=h-mac&task=${encodeURIComponent(body.task.id)}`
    ),
    deps
  );
  assert.match(String(detail.body), /P7/);

  const rerun = await handlePanelActionRequest(
    action("/panel/api/tasks/rerun", { project: root, taskId: body.task.id }),
    deps
  );
  assert.equal(rerun.status, 200);
  assert.equal(JSON.parse(rerun.body).task.priority, 7, "重跑继承源任务优先级");
});

test("createTask 优先级非法 → 400 且不建任务", async () => {
  const { store, root } = await makeHarness();
  await addHost(store, {
    id: "h-mac",
    hostname: "MAC-01",
    kind: "mac",
    osPlatform: "darwin",
    capabilities: ["ios-simulator", "android"]
  });
  await addProject(store, "h-mac", root, "app");
  const set = await addSet(store, root, "h-mac", "Mac 回归", "mac-login", 1);
  const deps = makeDeps(store);
  const base = {
    project: root,
    host: "h-mac",
    source: "case-set",
    ref: set.id,
    platforms: ["android"],
    baseline: "latest"
  };

  for (const priority of [101, -1, "abc"]) {
    const res = await handlePanelActionRequest(
      action("/panel/api/tasks", { ...base, priority }),
      deps
    );
    assert.equal(res.status, 400, `priority=${priority}`);
    assert.match(JSON.parse(res.body).error, /优先级|priority/);
  }
  assert.equal((await store.scopeHost("h-mac").listRegressionTasks(root)).length, 0);

  const fallback = await handlePanelActionRequest(action("/panel/api/tasks", base), deps);
  assert.equal(fallback.status, 200);
  assert.equal(JSON.parse(fallback.body).task.priority, 0);
});
