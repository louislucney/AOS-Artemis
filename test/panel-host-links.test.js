import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { makeTempDir } from "./helpers.js";

const HOST_A = "h-a";
const HOST_B = "h-b";

function makeHarness() {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-panel-host-links-");
  const root = path.join(dir, "app");
  fs.mkdirSync(root, { recursive: true });
  return { store, dir, root };
}

async function addHost(store, spec) {
  await store.upsertHost({
    id: spec.id,
    hostname: spec.hostname ?? spec.id,
    kind: spec.kind ?? "linux",
    osPlatform: spec.osPlatform ?? "linux",
    capabilities: spec.capabilities ?? ["android"],
    clientSeenAt: "2026-10-21T11:59:00.000Z"
  });
}

async function addProject(store, hostId, rootPath, name = "app") {
  return store.scopeHost(hostId).upsertProject({ rootPath, name });
}

async function addSet(store, rootPath, hostId, basename, key) {
  return store.scopeHost(hostId).recordCaseSet({
    rootPath,
    source: `pen:${hostId}.pen`,
    basename,
    features: [
      {
        key,
        name: basename,
        caseCount: 1,
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

test("总览同路径两主机各占一行且行链接带 host", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  const deps = makeDeps(store);

  const json = JSON.parse(String((await handlePanelRequest(new URL("http://x/panel.json"), deps)).body));
  assert.equal(json.projects.length, 2, "同路径两主机不去重");
  assert.deepEqual(
    json.projects.map((project) => project.hostId).sort(),
    [HOST_A, HOST_B]
  );

  const html = String((await handlePanelRequest(new URL("http://x/panel"), deps)).body);
  const enc = encodeURIComponent(root);
  assert.equal((html.match(/class="c-project-link"/g) ?? []).length, 2);
  assert.match(html, new RegExp(`${enc}&amp;host=${HOST_A}`));
  assert.match(html, new RegExp(`${enc}&amp;host=${HOST_B}`));
  assert.match(html, /<th[^>]*>主机<\/th>/, "总览显示主机列");
});

test("壳层导航 / 用例库 / 档案 / 对比 / 搜索链接均保留 host", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  const set = await addSet(store, root, HOST_B, "B 回归", "b-login");
  fs.mkdirSync(path.join(root, ".artemis", "design", "runs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".artemis", "design", "runs", "r1.json"), "{}", "utf-8");
  const deps = makeDeps(store);
  const enc = encodeURIComponent(root);

  const library = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${enc}&section=library&host=${HOST_B}`),
        deps
      )
    ).body
  );
  assert.match(
    library,
    new RegExp(`${enc}&amp;section=library&amp;host=${HOST_B}`),
    "壳层导航保留当前 host"
  );
  assert.match(
    library,
    new RegExp(
      `${enc}&amp;section=dispatch&amp;source=case-set&amp;ref=${encodeURIComponent(set.id)}&amp;host=${HOST_B}`
    ),
    "用例库下发链接带 host"
  );

  const archive = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${enc}&section=archive&host=${HOST_B}`),
        deps
      )
    ).body
  );
  assert.match(archive, /\/panel\/artifact\?project=[^"]*&amp;path=[^"]*&amp;host=h-b/);
  assert.match(archive, /\/panel\/artifact\?project=[^"]*&amp;format=csv&amp;host=h-b/);

  const compare = String(
    (await handlePanelRequest(new URL("http://x/panel?view=compare"), deps)).body
  );
  assert.match(compare, new RegExp(`${enc}&amp;host=${HOST_A}`));
  assert.match(compare, new RegExp(`${enc}&amp;host=${HOST_B}`));

  const search = String(
    (await handlePanelRequest(new URL("http://x/panel?section=search&q=app"), deps)).body
  );
  assert.match(search, new RegExp(`${enc}&amp;host=${HOST_A}`));
  assert.match(search, new RegExp(`${enc}&amp;host=${HOST_B}`));
});

test("任务动作 POST 携带 host；重跑跳转带 host 且继承 targetHostId/createdHostId", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  const deps = makeDeps(store);
  const encodedRoot = encodeURIComponent(root);
  const task = await store.scopeHost(HOST_B).createRegressionTask({
    rootPath: root,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST_B,
    createdHostId: HOST_B
  });

  const detail = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${encodedRoot}&host=${HOST_B}&task=${task.id}`),
        deps
      )
    ).body
  );
  assert.match(detail, /var hostId="h-b"/);
  assert.match(detail, /body:JSON\.stringify\(\{project:project,taskId:taskId,host:hostId\}\)/);
  assert.match(detail, /"&host=h-b"/, "重跑跳转保留 host");

  const rerun = await handlePanelActionRequest(
    action("/panel/api/tasks/rerun", { project: root, host: HOST_B, taskId: task.id }),
    deps
  );
  assert.equal(rerun.status, 200);
  const created = JSON.parse(rerun.body).task;
  assert.notEqual(created.id, task.id);
  assert.equal(created.targetHostId, HOST_B, "重跑继承 targetHostId");
  assert.equal(created.createdHostId, HOST_B, "重跑继承 createdHostId");

  await store.scopeHost(HOST_B).updateRegressionTask(root, created.id, {
    status: "claimed",
    claimedBy: "runner-b"
  });
  const stop = await handlePanelActionRequest(
    action("/panel/api/tasks/stop", { project: root, host: HOST_B, taskId: created.id }),
    deps
  );
  assert.equal(stop.status, 200);
  assert.equal(
    (await store.scopeHost(HOST_B).getRegressionTask(root, created.id)).status,
    "stopping"
  );
});

test("切换器以 (host, path) 判定当前项，只高亮当前主机", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  const deps = makeDeps(store);
  const enc = encodeURIComponent(root);

  const html = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${enc}&host=${HOST_B}`),
        deps
      )
    ).body
  );
  const option = (hostId) => {
    const match = html.match(new RegExp(`<option value="[^"]*host=${hostId}"[^>]*>`));
    assert.ok(match, `切换器包含 ${hostId}`);
    return match[0];
  };
  assert.match(option(HOST_B), / selected/);
  assert.doesNotMatch(option(HOST_A), / selected/);
});

test("legacy NULL-host 项目在已登记主机时给出迁移指引并禁用提交", async () => {
  const { store, root } = makeHarness();
  await addHost(store, { id: "h-mac", hostname: "MAC-01", kind: "mac", osPlatform: "darwin" });
  await store.upsertProject({ rootPath: root, name: "legacy" });
  await store.recordCaseSet({
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
  const deps = makeDeps(store);

  const html = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${encodeURIComponent(root)}&section=dispatch`),
        deps
      )
    ).body
  );
  assert.match(html, /该项目是未归属主机的历史数据/);
  assert.match(html, /host adopt-legacy --local --apply/);
  assert.match(html, /id="dispatch-submit"[^>]*disabled/);
  assert.match(html, /title="该项目是未归属主机的历史数据/);
  assert.doesNotMatch(html, /目标主机无法满足所选平台，请调整目标端或更换主机后刷新预览。<\/p>/);
});

test("同一主机同名项目在选项里追加完整路径消歧", async () => {
  const { store, dir } = makeHarness();
  await addHost(store, { id: HOST_A, hostname: "A-01" });
  const rootA = path.join(dir, "a", "app");
  const rootB = path.join(dir, "b", "app");
  await addProject(store, HOST_A, rootA, "app");
  await addProject(store, HOST_A, rootB, "app");
  const deps = makeDeps(store);

  const html = String(
    (
      await handlePanelRequest(
        new URL(
          `http://x/panel?project=${encodeURIComponent(rootA)}&section=dispatch&host=${HOST_A}`
        ),
        deps
      )
    ).body
  );
  assert.match(html, new RegExp(`app（${rootA}）`));
  assert.match(html, new RegExp(`app（${rootB}）`));

  const switcher = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${encodeURIComponent(rootA)}&host=${HOST_A}`),
        deps
      )
    ).body
  );
  assert.match(switcher, new RegExp(`app · A-01（${rootA}）`));
  assert.match(switcher, new RegExp(`app · A-01（${rootB}）`));
});
