import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  loadDesignFlowGraph,
  loadGeneratedCases,
  readTestsDocument
} from "../dist/figma/design-store.js";
import { baseConfig, makeTempProject } from "./helpers.js";

function makeDesignDir() {
  const dir = makeTempProject({ config: baseConfig() });
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  return { dir, design };
}

test("readTestsDocument：缺失/坏 JSON → null；记录投影与 generation 透传", async () => {
  const { design } = makeDesignDir();
  assert.equal(readTestsDocument(path.join(design, "..", "..")), null);

  fs.writeFileSync(
    path.join(design, "tests.json"),
    JSON.stringify({
      generation: { source: "figma:abc" },
      flows: [
        "bad-entry",
        {
          id: "case-1",
          name: "流程一",
          taskDesc: "任务一",
          screens: ["首页", 42],
          preconditions: ["已登录", 7],
          steps: ["点击 A", 3],
          expectations: [{ index: 1, kind: "explore", screen: "详情" }]
        }
      ]
    })
  );
  const configDirAbs = path.join(design, "..");
  const document = readTestsDocument(configDirAbs);
  assert.equal(document.records.length, 1);
  assert.deepEqual(
    { id: document.records[0].id, name: document.records[0].name, screens: document.records[0].screens },
    { id: "case-1", name: "流程一", screens: ["首页"] }
  );
  assert.deepEqual(document.records[0].preconditions, ["已登录"]);
  assert.deepEqual(document.records[0].steps, ["点击 A"]);
  assert.deepEqual(document.generation, { source: "figma:abc" });

  fs.writeFileSync(path.join(design, "tests.json"), "{not json");
  assert.equal(readTestsDocument(configDirAbs), null);
});

test("loadDesignFlowGraph：缺失 → null；读取必归一（legacy 补默认证据字段）", async () => {
  const { design } = makeDesignDir();
  const configDirAbs = path.join(design, "..");
  assert.equal(loadDesignFlowGraph(configDirAbs), null);

  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      screens: [{ id: "s1", name: "首页" }],
      edges: [{ from: { id: "s1", name: "首页" }, to: { id: "s2", name: "详情" } }],
      entryScreens: ["首页"]
    })
  );
  const graph = loadDesignFlowGraph(configDirAbs);
  assert.ok(graph);
  assert.equal(graph.screens[0].name, "首页");
  assert.ok(graph.screens[0].provenance, "legacy 屏应补 provenance 默认");
  assert.equal(graph.edges[0].from.name, "首页");
  assert.equal(graph.edges[0].to.name, "详情");
});

test("loadGeneratedCases：无 taskDesc 条目跳过、maxCases 截断、exploreSteps 解析", async () => {
  const { design } = makeDesignDir();
  fs.writeFileSync(
    path.join(design, "tests.json"),
    JSON.stringify({
      flows: [
        { id: "case-1", taskDesc: "任务一", expectations: [] },
        { id: "case-2", expectations: [] },
        {
          id: "case-3",
          name: "流程三",
          taskDesc: "任务三",
          expectations: [
            { index: 2, kind: "explore", screen: "门店", provenance: "inferred" },
            { index: 3, kind: "assert", screen: "结账" }
          ]
        }
      ]
    })
  );
  const configDirAbs = path.join(design, "..");
  const all = loadGeneratedCases(configDirAbs);
  assert.deepEqual(
    all.map((item) => item.id),
    ["case-1", "case-3"]
  );
  assert.equal(all[1].exploreSteps.length, 1);
  assert.equal(all[1].exploreSteps[0].screen, "门店");
  assert.equal(all[1].name, "流程三");
  const limited = loadGeneratedCases(configDirAbs, { maxCases: 1 });
  assert.deepEqual(
    limited.map((item) => item.id),
    ["case-1"]
  );
});
