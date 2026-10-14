import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildFlowGraph } from "../dist/figma/flows.js";
import { figmaGenerateTests } from "../dist/figma/test-gen.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";
import { pagedFlowDocument, syntheticFlowDocument } from "./fixtures/figma-flow-doc.mjs";

const NOW = () => new Date("2026-10-14T15:30:00.000Z");
const STAMP = "20261014T153000";

function makeFlowsProject(document = syntheticFlowDocument(), filterCrossPage = false) {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const graph = buildFlowGraph(document);
  if (filterCrossPage) {
    graph.edges = graph.edges.filter(
      (edge) => !(edge.from.name === "登录-验证" && edge.to?.name === "首页")
    );
    graph.entryScreens = ["登录-输入", "首页"];
  }
  fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(graph), "utf-8");
  return dir;
}

test("figma_generate_tests: 每份功能归档三件套同 basename（savedTo.caseSets）", async () => {
  const dir = makeFlowsProject(pagedFlowDocument(), true);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}, { now: NOW, chat: null }));

  assert.equal(payload.ok, true);
  assert.equal(payload.features.length, 2);
  const names = payload.features.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["主流程", "登录"]);

  assert.equal(payload.savedTo.caseSets.length, 2);
  for (const entry of payload.savedTo.caseSets) {
    for (const key of ["json", "md", "xlsx"]) {
      assert.ok(fs.existsSync(entry[key]), `${entry.feature} 的 ${key} 存在`);
    }
    const stem = path.basename(entry.json, ".json");
    assert.ok(stem.startsWith(`${STAMP}_`), "归档 stem 带时间戳");
    assert.equal(path.basename(entry.md), `${stem}.md`);
    assert.equal(path.basename(entry.xlsx), `${stem}.xlsx`);
    assert.ok(entry.json.includes(`${path.sep}case-sets${path.sep}`));
  }
});

test("figma_generate_tests: 用例带 feature 且 payload.features.caseIds 与归档 flows 一致", async () => {
  const dir = makeFlowsProject(pagedFlowDocument(), true);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}, { now: NOW, chat: null }));

  for (const flow of payload.flows) {
    assert.ok(typeof flow.feature === "string" && flow.feature !== "", "用例带 feature");
  }
  const login = payload.features.find((entry) => entry.name === "登录");
  assert.equal(login.caseIds.length, 1);
  assert.deepEqual(login.screens, ["登录-输入", "登录-验证"]);

  const archiveEntry = payload.savedTo.caseSets.find((entry) => entry.feature === "登录");
  const archived = JSON.parse(fs.readFileSync(archiveEntry.json, "utf-8"));
  assert.deepEqual(archived.flows.map((flow) => flow.id), login.caseIds);
  assert.equal(archived.features.length, 1);
  assert.equal(archived.features[0].name, "登录");
});

test("figma_generate_tests: save:false 不写归档", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }, { now: NOW, chat: null }));

  assert.equal(payload.ok, true);
  assert.equal(payload.savedTo, undefined);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "case-sets")), false);
});

test("figma_generate_tests: 命名走注入 chat（归档 stem 含该名）", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await figmaGenerateTests(runtime, {}, { now: NOW, chat: async () => '{"name":"下单流程"}' })
  );

  assert.equal(payload.features.length, 1);
  assert.equal(payload.features[0].name, "下单流程");
  const stem = path.basename(payload.savedTo.caseSets[0].json, ".json");
  assert.equal(stem, `${STAMP}_下单流程`);
});

test("figma_generate_tests: requireFullCoverage 不通过时不落任何文件", async () => {
  const dir = makeFlowsProject(pagedFlowDocument(), true);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await figmaGenerateTests(runtime, { requireFullCoverage: true, maxFlows: 1 }, { now: NOW, chat: null })
  );

  assert.equal(payload.ok, false);
  assert.match(payload.error, /覆盖不完整/);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "case-sets")), false);
});

test("figma_generate_tests: 重新生成（屏幕集合变化）→ 继承同一 key/name", async () => {
  const dir = makeFlowsProject(pagedFlowDocument(), true);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });

  const first = parseToolResult(await figmaGenerateTests(runtime, {}, { now: NOW, chat: null }));
  const loginKey = first.features.find((entry) => entry.name === "登录").key;

  const flowsPath = path.join(dir, ".artemis", "design", "flows.json");
  const graph = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  graph.screens.push({
    id: "20:9",
    name: "登录-完成",
    suggestedRoute: "/login-done",
    childNames: [],
    textHints: [],
    page: "登录",
    provenance: "explicit",
    confidence: "high"
  });
  graph.edges.push({
    from: { id: "20:3", name: "登录-验证" },
    to: { id: "20:9", name: "登录-完成" },
    element: { id: "20:10", name: "Done", type: "BUTTON" },
    textHints: [],
    trigger: "ON_CLICK",
    actionType: "NODE",
    provenance: "explicit",
    confidence: "high"
  });
  fs.writeFileSync(flowsPath, JSON.stringify(graph), "utf-8");

  const second = parseToolResult(
    await figmaGenerateTests(runtime, {}, { now: () => new Date("2026-10-14T16:00:00.000Z"), chat: null })
  );
  const secondLogin = second.features.find((entry) => entry.name === "登录");
  assert.equal(secondLogin.key, loginKey, "屏幕变化但重叠 ≥0.5 → 继承 key");
  assert.equal(secondLogin.screens.length, 3);

  const third = parseToolResult(
    await figmaGenerateTests(runtime, {}, { now: () => new Date("2026-10-14T17:00:00.000Z"), chat: null })
  );
  const firstKeys = new Map(first.features.map((entry) => [entry.name, entry.key]));
  for (const feature of third.features) {
    assert.equal(
      feature.key,
      firstKeys.get(feature.name),
      "第 3 代仍继承同一 key（重复登记不误判并列）"
    );
  }
  assert.ok(
    !(third.warnings ?? []).some((warning) => warning.code === "feature-identity-new"),
    "稳态代不误报身份新建"
  );
});

test("figma_generate_tests: store 不可用 → 生成成功 + 如实告警", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  runtime.store.listCaseSets = async () => {
    throw new Error("store down");
  };
  runtime.store.recordCaseSet = async () => {
    throw new Error("store down");
  };

  const payload = parseToolResult(await figmaGenerateTests(runtime, {}, { now: NOW, chat: null }));
  assert.equal(payload.ok, true);
  assert.ok(payload.warnings.some((warning) => warning.code === "case-set-registry-unavailable"));
  assert.ok(payload.warnings.some((warning) => warning.code === "case-set-registration-failed"));
});

test("figma_generate_tests: 登记行与归档一致（memory store）", async () => {
  const dir = makeFlowsProject(pagedFlowDocument(), true);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}, { now: NOW, chat: null }));

  const registered = await runtime.store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(registered.length, 1);
  const record = registered[0];
  assert.equal(record.basename, "tests");
  assert.equal(record.features.length, 2);
  const byName = new Map(record.features.map((feature) => [feature.name, feature]));
  assert.equal(byName.get("登录").caseCount, 1);
  assert.deepEqual(byName.get("登录").screens, ["登录-输入", "登录-验证"]);
  assert.equal(
    byName.get("登录").jsonPath,
    payload.savedTo.caseSets.find((entry) => entry.feature === "登录").json
  );
});
