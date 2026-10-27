import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import { preflightGeneratedTests } from "../dist/figma/preflight.js";
import { linearizeFlowsWithStats } from "../dist/figma/test-gen.js";

function makeDesignDir({ tests, flows }) {
  const root = makeTempDir("aos-preflight-");
  const designDir = path.join(root, "design");
  fs.mkdirSync(designDir, { recursive: true });
  if (tests !== undefined) fs.writeFileSync(path.join(designDir, "tests.json"), tests);
  if (flows !== undefined) fs.writeFileSync(path.join(designDir, "flows.json"), flows);
  return root;
}

test("preflightGeneratedTests: weak steps, screen/edge coverage, generation stats", () => {
  const tests = JSON.stringify({
    flows: [
      {
        id: "case-1",
        name: "Home → Checkout",
        screens: ["Home", "Checkout"],
        steps: ["点击「Buy now」，验证进入「Checkout」（页面应出现「Pay now」）"]
      },
      {
        id: "case-2",
        name: "Home → Home",
        screens: ["Home"],
        steps: ["点击「Go home」，验证进入「Home」"]
      }
    ],
    generation: { maxFlows: 10, truncated: false, droppedPaths: 0 }
  });
  const flows = JSON.stringify({
    screens: [{ name: "Home" }, { name: "Checkout" }, { name: "Success" }],
    edges: [
      { from: { name: "Home" }, to: { name: "Checkout" } },
      { from: { name: "Checkout" }, to: { name: "Success" } }
    ]
  });
  const configDir = makeDesignDir({ tests, flows });

  const report = preflightGeneratedTests(configDir);
  assert.equal(report.cases, 2);
  assert.equal(report.coverage.available, true);
  assert.deepEqual(report.weakCases, [
    { id: "case-2", name: "Home → Home", weakSteps: [{ index: 0, reason: "缺少可验证断言（目的地屏无文本提示）" }] }
  ]);
  assert.deepEqual(report.coverage.screens.sort(), ["Checkout", "Home"]);
  assert.deepEqual(report.coverage.uncoveredScreens, ["Success"]);
  assert.deepEqual(report.coverage.uncoveredEdges, ["Checkout → Success"]);
  assert.deepEqual(report.generation, { maxFlows: 10, truncated: false, droppedPaths: 0 });
});

test("preflightGeneratedTests: explore-kind steps are not counted as weak assertions", () => {
  const tests = JSON.stringify({
    flows: [
      {
        id: "case-1",
        name: "Home → Checkout",
        screens: ["Home", "Checkout"],
        steps: [
          "探索进入「Checkout」（推断跳转，未确认）：自行寻找并点击通往该页的入口，记录实际路径与页面变化；不参与断言判定"
        ],
        expectations: [
          { screen: "Checkout", hints: [], provenance: "inferred", confidence: "low", kind: "explore" }
        ]
      }
    ]
  });
  const configDir = makeDesignDir({ tests });

  const report = preflightGeneratedTests(configDir);
  assert.equal(report.cases, 1);
  assert.deepEqual(report.weakCases, [], "exploration steps are deferred, not weak");
});

test("preflightGeneratedTests: hard/explore coverage split from flows provenance", () => {
  const tests = JSON.stringify({
    flows: [
      {
        id: "case-1",
        name: "A → C",
        screens: ["A", "C"],
        steps: ["点击「x」，验证进入「C」（页面应出现「C」）"]
      }
    ]
  });
  const flows = JSON.stringify({
    screens: [
      { name: "A", provenance: "explicit" },
      { name: "B", provenance: "inferred" },
      { name: "C", provenance: "explicit" }
    ],
    edges: [
      { from: { name: "A" }, to: { name: "B" }, provenance: "inferred" },
      { from: { name: "A" }, to: { name: "C" }, provenance: "explicit" }
    ]
  });
  const configDir = makeDesignDir({ tests, flows });

  const report = preflightGeneratedTests(configDir);
  assert.equal(report.coverage.available, true);
  assert.deepEqual(report.coverage.uncoveredScreens, [], "hard screens are all covered");
  assert.deepEqual(report.coverage.uncoveredEdges, [], "hard edge is covered");
  assert.deepEqual(report.coverage.explore.uncoveredScreens, ["B"], "explore gaps are separate");
  assert.deepEqual(report.coverage.explore.uncoveredEdges, ["A → B"]);
  assert.deepEqual(report.coverage.screens.sort(), ["A", "C"]);
});

test("preflightGeneratedTests: 三件套/真实数据约束字段（suite check 硬门禁输入）", () => {
  const tests = JSON.stringify({
    flows: [
      { id: "case-1", name: "A", screens: ["Home"], steps: [], taskDesc: "【真实数据】须经真实请求链路" },
      { id: "case-2", name: "B", screens: ["Home"], steps: [], taskDesc: "手写用例" }
    ]
  });
  const configDir = makeDesignDir({ tests });

  const report = preflightGeneratedTests(configDir);
  assert.equal(report.artifacts.excelPresent, false, "缺 tests.xlsx 可被检出");
  assert.equal(report.artifacts.excelFile.endsWith("tests.xlsx"), true);
  assert.deepEqual(report.dataPolicy.missing, [{ id: "case-2", name: "B" }]);

  fs.writeFileSync(path.join(configDir, "design", "tests.xlsx"), "fake-xlsx");
  const withXlsx = preflightGeneratedTests(configDir);
  assert.equal(withXlsx.artifacts.excelPresent, true);
  assert.equal(withXlsx.artifacts.excelStale, false, "xlsx 晚于 json 不算过期");

  fs.writeFileSync(path.join(configDir, "design", "tests.json"), tests);
  const stale = preflightGeneratedTests(configDir);
  assert.equal(stale.artifacts.excelStale, true, "json 更新后 xlsx 过期");
});

test("preflightGeneratedTests: missing or corrupt tests.json returns null; flows optional", () => {
  const missing = makeDesignDir({});
  assert.equal(preflightGeneratedTests(missing), null);

  const corrupt = makeDesignDir({ tests: "{not json" });
  assert.equal(preflightGeneratedTests(corrupt), null);

  const testsOnly = makeDesignDir({
    tests: JSON.stringify({ flows: [{ id: "case-1", name: "A", screens: ["Home"], steps: [] }] })
  });
  const report = preflightGeneratedTests(testsOnly);
  assert.equal(report.cases, 1);
  assert.equal(report.coverage.available, false);
  assert.deepEqual(report.coverage.uncoveredScreens, []);
  assert.deepEqual(report.coverage.uncoveredEdges, []);
  assert.equal(report.generation, null);
});

test("preflightGeneratedTests: self transitions are excluded; custom tests path is honored", () => {
  const flows = JSON.stringify({
    screens: [{ name: "Home" }, { name: "Checkout" }],
    edges: [
      { from: { name: "Home" }, to: { name: "Checkout" } },
      { from: { name: "Checkout" }, to: { name: "Checkout" } }
    ]
  });
  const configDir = makeDesignDir({ flows });
  const customDir = makeTempDir("aos-preflight-custom-");
  const customTests = path.join(customDir, "cases.json");
  fs.writeFileSync(
    customTests,
    JSON.stringify({
      flows: [
        {
          id: "case-1",
          name: "Home → Checkout",
          screens: ["Home", "Checkout"],
          steps: ["点击「Buy now」，验证进入「Checkout」（页面应出现「Pay now」）"]
        }
      ]
    })
  );

  const report = preflightGeneratedTests(configDir, { testsPath: customTests });
  assert.equal(report.cases, 1);
  assert.equal(report.coverage.available, true);
  assert.deepEqual(report.coverage.uncoveredScreens, []);
  assert.deepEqual(report.coverage.uncoveredEdges, []);
  assert.deepEqual(report.coverage.screens.sort(), ["Checkout", "Home"]);
});

test("linearizeFlowsWithStats: reports truncation, dropped paths and entry fallback", () => {
  const graph = {
    screens: [
      { id: "s1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
      { id: "s2", name: "A", suggestedRoute: "/a", childNames: [], textHints: [] },
      { id: "s3", name: "B", suggestedRoute: "/b", childNames: [], textHints: [] }
    ],
    edges: [
      {
        from: { id: "s1", name: "Home" },
        to: { id: "s2", name: "A" },
        element: { id: "e1", name: "To A", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE"
      },
      {
        from: { id: "s1", name: "Home" },
        to: { id: "s3", name: "B" },
        element: { id: "e2", name: "To B", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE"
      }
    ],
    entryScreens: ["Home"],
    unresolvedDestinations: []
  };

  const limited = linearizeFlowsWithStats(graph, { maxFlows: 1 });
  assert.equal(limited.paths.length, 1);
  assert.equal(limited.stats.entryFallback, false);
  assert.equal(limited.stats.truncated, true);
  assert.equal(limited.stats.droppedPaths, 1);
  assert.equal(limited.stats.keptPaths, 1);

  const fallback = linearizeFlowsWithStats({ ...graph, entryScreens: [] });
  assert.equal(fallback.stats.entryFallback, true);
  assert.equal(fallback.stats.truncated, false);
});

test("preflightGeneratedTests: dynamicContent flags design sample values in taskDesc/steps", () => {
  const tests = JSON.stringify({
    flows: [
      {
        id: "case-1",
        name: "推薦飲料",
        screens: ["Home"],
        taskDesc: "點擊「冰蘋果山茶花風味美式」並確認價格 $120 起",
        steps: ["點擊「冰蘋果山茶花風味美式」，驗證進入「單品頁」"]
      },
      {
        id: "case-2",
        name: "穩定結構",
        screens: ["Home"],
        taskDesc: "驗證「推薦」「咖啡飲品」仍可見",
        steps: ["驗證「推薦」可見"]
      }
    ]
  });
  const configDir = makeDesignDir({ tests });
  fs.writeFileSync(
    path.join(configDir, "design", "ui-semantics.json"),
    JSON.stringify({
      version: 1,
      screens: [
        {
          screenId: "home",
          regions: [
            {
              id: "list",
              role: "product-list",
              dynamicExamples: ["冰蘋果山茶花風味美式", "$120 起"],
              dynamicPatterns: ["\\$[0-9]+"]
            }
          ]
        }
      ]
    })
  );
  const report = preflightGeneratedTests(configDir);
  assert.ok(report);
  assert.equal(report.dynamicContent.total, 1);
  assert.equal(report.dynamicContent.fresh, 1);
  assert.equal(report.dynamicContent.baselined, 0);
  assert.equal(report.dynamicContent.cases[0].caseId, "case-1");
  assert.deepEqual(report.dynamicContent.cases[0].texts.sort(), ["$120 起", "冰蘋果山茶花風味美式"].sort());
  assert.ok(report.dynamicContent.semanticsPath?.endsWith("ui-semantics.json"));
});

test("preflightGeneratedTests: missing semantics/dynamicExamples is neutral", () => {
  const tests = JSON.stringify({
    flows: [{ id: "case-1", name: "Home", screens: ["Home"], taskDesc: "驗證「推薦」", steps: [] }]
  });
  const configDir = makeDesignDir({ tests });
  const missing = preflightGeneratedTests(configDir);
  assert.equal(missing.dynamicContent.total, 0);
  assert.equal(missing.dynamicContent.semanticsPath, null);

  fs.writeFileSync(
    path.join(configDir, "design", "ui-semantics.json"),
    JSON.stringify({ version: 1, screens: [{ screenId: "home", regions: [] }] })
  );
  const noExamples = preflightGeneratedTests(configDir);
  assert.equal(noExamples.dynamicContent.total, 0);
  assert.equal(noExamples.dynamicContent.semanticsPath, null);
});

test("preflightGeneratedTests: dynamic baseline marks cases baselined", () => {
  const tests = JSON.stringify({
    flows: [
      {
        id: "case-1",
        name: "推薦飲料",
        screens: ["Home"],
        taskDesc: "點擊「冰蘋果山茶花風味美式」",
        steps: []
      }
    ]
  });
  const configDir = makeDesignDir({ tests });
  fs.writeFileSync(
    path.join(configDir, "design", "ui-semantics.json"),
    JSON.stringify({
      version: 1,
      screens: [
        {
          screenId: "home",
          regions: [{ id: "list", role: "product-list", dynamicExamples: ["冰蘋果山茶花風味美式"] }]
        }
      ]
    })
  );
  const report = preflightGeneratedTests(configDir, {
    dynamicBaseline: {
      version: 1,
      entries: [
        {
          tool: "check-dynamic",
          caseId: "case-1",
          kind: "dynamic-content",
          text: "冰蘋果山茶花風味美式"
        }
      ]
    }
  });
  assert.equal(report.dynamicContent.total, 1);
  assert.equal(report.dynamicContent.baselined, 1);
  assert.equal(report.dynamicContent.fresh, 0);
  assert.equal(report.dynamicContent.cases[0].baselined, true);
});
