import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { AmbiguousProjectError } from "../dist/db/types.js";
import { buildPanelCompare } from "../dist/panel/compare.js";
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

async function addFeatureRun(store, rootPath, hostId, options = {}) {
  const scoped = store.scopeHost(hostId);
  const key = options.key ?? "login";
  const source = options.source ?? "pen:shared.pen";
  const name = options.name ?? "登录";
  const set = await scoped.recordCaseSet({
    rootPath,
    source,
    basename: options.basename ?? "回归",
    features: [
      {
        key,
        name,
        caseCount: 1,
        screens: [],
        jsonPath: `/x/${hostId}-${key}.json`,
        mdPath: `/x/${hostId}-${key}.md`,
        xlsxPath: `/x/${hostId}-${key}.xlsx`
      }
    ]
  });
  await scoped.recordSuiteRun({
    rootPath,
    createdAt: options.at ?? "2026-10-21T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: set.id,
      featureKey: key,
      featureName: name,
      platform: "android",
      device: null,
      appVersion: null,
      status: "failed",
      startedAt: "2026-10-21T10:00:00.000Z",
      finishedAt: options.at ?? "2026-10-21T10:05:00.000Z",
      total: 1,
      passed: 0,
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
        caseId: options.caseId ?? `${hostId}-case`,
        name: options.caseName ?? "登录用例",
        featureKey: key,
        platform: "android",
        status: "failed",
        traceId: null,
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      }
    ]
  });
  return set;
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
  assert.match(
    detail,
    /body:JSON\.stringify\(\{project:project,taskId:taskId,host:hostId,note:/
  );
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

test("对比表显示主机标签：同路径两主机可区分", async () => {
  const { store, root } = makeHarness();
  await addHost(store, { id: HOST_A, hostname: "MAC-A", kind: "mac", osPlatform: "darwin" });
  await addHost(store, { id: HOST_B, hostname: "MAC-B", kind: "mac", osPlatform: "darwin" });
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  const deps = makeDeps(store);

  const html = String(
    (await handlePanelRequest(new URL("http://x/panel?view=compare"), deps)).body
  );
  assert.match(html, /<th scope="col">主机<\/th>/);
  assert.match(html, /MAC-A/);
  assert.match(html, /MAC-B/);
});

test("功能对齐按 (host, path) 识别项目：同路径两主机不虚报 2 个项目", async () => {
  const { store, root, dir } = makeHarness();
  await addHost(store, { id: HOST_A, hostname: "MAC-A", kind: "mac", osPlatform: "darwin" });
  await addHost(store, { id: HOST_B, hostname: "MAC-B", kind: "mac", osPlatform: "darwin" });
  await addHost(store, { id: "h-c", hostname: "MAC-C", kind: "mac", osPlatform: "darwin" });
  const otherRoot = path.join(dir, "other", "app");
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  await addProject(store, "h-c", otherRoot);
  await addFeatureRun(store, root, HOST_A);
  await addFeatureRun(store, root, HOST_B);
  await addFeatureRun(store, otherRoot, "h-c");

  const view = await buildPanelCompare(makeDeps(store));
  assert.equal(view.featureAlignment.groups.length, 1, "A 与 C 是不同项目；B 与 A 同项目不另计");
  const group = view.featureAlignment.groups[0];
  assert.equal(group.entries.length, 2);
  assert.deepEqual(
    group.entries.map((entry) => entry.project),
    ["app · MAC-A", "app · MAC-C"],
    "同路径两主机固定取 hostId 最小的代表标签"
  );
});

test("总览按行主机作用域读台账：同路径不误报缺 LLM", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  for (const hostId of [HOST_A, HOST_B]) {
    await store.scopeHost(hostId).upsertLlm(root, {
      name: `llm-${hostId}`,
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      apiKey: "sk-test",
      makeActive: true
    });
  }
  store.listLlms = async () => {
    throw new AmbiguousProjectError(root, [
      { id: "1", hostId: HOST_A, rootPath: root, name: "app" },
      { id: "2", hostId: HOST_B, rootPath: root, name: "app" }
    ]);
  };

  const json = JSON.parse(
    String((await handlePanelRequest(new URL("http://x/panel.json"), makeDeps(store))).body)
  );
  assert.equal(json.projects.length, 2);
  for (const row of json.projects) {
    assert.ok(!row.integration.missing.includes("LLM"), `${row.hostId} 读到自身 LLM`);
    assert.deepEqual(row.warnings, []);
  }
});

test("总览作用域读失败时显示告警而非静默空数据", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  const broken = store.scopeHost(HOST_A);
  broken.listLlms = async () => {
    throw new Error("scope boom");
  };

  const json = JSON.parse(
    String(
      (
        await handlePanelRequest(
          new URL("http://x/panel.json"),
          makeDeps(store, {
            storeForHost: (hostId) =>
              hostId === HOST_A ? broken : store.scopeHost(hostId)
          })
        )
      ).body
    )
  );
  const row = json.projects.find((project) => project.hostId === HOST_A);
  assert.ok(row.warnings.some((warning) => warning.includes("台账读取失败")));
  assert.ok(row.lampReasons.some((reason) => reason.includes("台账读取失败")));
});

test("verdicts / schedules / quarantine / import 动作体携带 host", async () => {
  const { store, root } = makeHarness();
  await addProject(store, HOST_A, root);
  await addProject(store, HOST_B, root);
  await addFeatureRun(store, root, HOST_B, { caseId: "case-b" });
  const failedRun = (await store.scopeHost(HOST_B).listSuiteRuns(root, { limit: 1 }))[0];
  const deps = makeDeps(store);
  const enc = encodeURIComponent(root);

  const review = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${enc}&host=${HOST_B}&view=review`),
        deps
      )
    ).body
  );
  assert.match(review, /host:"h-b"/);
  const verdict = await handlePanelActionRequest(
    action("/panel/api/verdicts", {
      project: root,
      host: HOST_B,
      verdict: "case-defect",
      items: [{ runId: failedRun.id, caseId: "case-b" }]
    }),
    deps
  );
  assert.notEqual(verdict.status, 409, "裁决带 host 不再歧义");

  const schedules = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${enc}&host=${HOST_B}&section=schedules`),
        deps
      )
    ).body
  );
  assert.match(schedules, /var hostId="h-b"/);
  assert.match(schedules, /host:hostId,action:'create'/);
  const schedule = await handlePanelActionRequest(
    action("/panel/api/schedules", {
      project: root,
      host: HOST_B,
      action: "create",
      name: "夜间回归",
      featureKeys: ["login"],
      platforms: ["android"],
      everyMinutes: 60
    }),
    deps
  );
  assert.equal(schedule.status, 200);

  const library = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${enc}&section=library&host=${HOST_B}`),
        deps
      )
    ).body
  );
  assert.match(library, /host:hostId,action:'add'/);
  assert.ok(library.includes("fd.append('host',hostId)"));
  assert.ok(library.includes("'/panel/api/import'+(hostId?'?host='+encodeURIComponent(hostId):'')"));
  const quarantine = await handlePanelActionRequest(
    action("/panel/api/quarantine", {
      project: root,
      host: HOST_B,
      action: "add",
      caseId: "case-b",
      owner: "qa"
    }),
    deps
  );
  assert.equal(quarantine.status, 200);

  const missingHostQuarantine = await handlePanelActionRequest(
    action("/panel/api/quarantine", { project: root, action: "add", caseId: "case-b", owner: "qa" }),
    deps
  );
  assert.equal(missingHostQuarantine.status, 409, "无 host 的同路径动作仍 409");
});

test("未登记工作区目录不误报 legacy 指引", async () => {
  const { store, dir } = makeHarness();
  await addHost(store, { id: "h-mac", hostname: "MAC-01", kind: "mac", osPlatform: "darwin" });
  const workspaceRoot = path.join(dir, "workspace");
  const root = path.join(workspaceRoot, "draft");
  fs.mkdirSync(root, { recursive: true });
  const deps = makeDeps(store, { workspaceRoot });

  const html = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?project=${encodeURIComponent(root)}&section=dispatch`),
        deps
      )
    ).body
  );
  assert.doesNotMatch(html, /<p class="note">该项目是未归属主机/);
  assert.match(html, /"legacyHostless":false/);
  assert.match(html, /id="dispatch-submit"[^>]*disabled/);
});
