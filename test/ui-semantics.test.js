import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  loadUiSemantics,
  matchesDynamicExample,
  matchesDynamicPattern,
  parseUiSemantics,
  semanticsForScreen
} from "../dist/ui/semantics.js";
import { makeTempDir } from "./helpers.js";

function baseSemantics(overrides = {}) {
  return {
    version: 1,
    draft: true,
    source: { contract: ".artemis/design/ui-contract.json", contractFingerprint: "fp-1" },
    screens: [
      {
        screenId: "home",
        screenName: "首頁",
        viewport: { width: 440, height: 956, scale: 3 },
        displayNames: { 咖啡飲品: ["每日精選咖啡"] },
        dataProfile: {
          design: "sample",
          runtime: "uat",
          allowedDynamicFields: ["name", "price", "image"]
        },
        regions: [
          {
            id: "category-rail",
            role: "category-list",
            designBbox: { x: 0, y: 1128, width: 80, height: 960 },
            isDynamic: false,
            allowedRoles: ["category-list", "group-header"],
            taxonomy: [
              {
                id: "drinks",
                label: "飲料",
                kind: "group-header",
                children: [
                  {
                    id: "coffee",
                    label: "咖啡飲品",
                    kind: "category",
                    aliases: ["每日精選咖啡", "熱濃縮咖啡飲料", "冰濃縮咖啡飲料"]
                  },
                  {
                    id: "tea",
                    label: "茶瓦納",
                    kind: "category",
                    aliases: ["冰茶", "熱茶", "冰茶那堤", "熱茶那堤"]
                  }
                ]
              },
              {
                id: "recommended",
                label: "推薦",
                kind: "virtual",
                allowDuplicates: true
              }
            ]
          },
          {
            id: "product-list",
            role: "product-list",
            isDynamic: true,
            dynamicAssets: true,
            expectedAssets: 1,
            dynamicExamples: ["冰蘋果山茶花風味美式", "$120 起"],
            dynamicPatterns: ["\\$[0-9]+(?:\\.[0-9]+)?(?:\\s*起)?"]
          }
        ]
      },
      {
        screenId: "search",
        screenName: "搜尋",
        regions: []
      }
    ],
    ...overrides
  };
}

function parseFixture(overrides = {}) {
  return parseUiSemantics(JSON.stringify(baseSemantics(overrides)));
}

function invalidCase(name, mutate, expectedPath) {
  test(`rejects ${name}`, () => {
    const fixture = baseSemantics();
    mutate(fixture);
    const result = parseUiSemantics(JSON.stringify(fixture));
    assert.equal(result.file, null);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some((entry) => entry.includes(expectedPath)),
      `expected an error containing ${expectedPath}, got ${result.errors.join(" | ")}`
    );
  });
}

test("parses valid multi-screen semantics and looks up by id/name", () => {
  const result = parseFixture();
  assert.deepEqual(result.errors, []);
  assert.ok(result.file);
  assert.equal(result.file.draft, true);
  assert.equal(result.file.source?.contractFingerprint, "fp-1");

  const home = semanticsForScreen(result.file, " HOME ");
  assert.ok(home);
  assert.equal(home.screenId, "home");
  assert.equal(home.viewport?.width, 440);
  assert.deepEqual(home.displayNames?.咖啡飲品, ["每日精選咖啡"]);

  const rail = home.regions.find((entry) => entry.id === "category-rail");
  assert.ok(rail);
  assert.deepEqual(rail.allowedRoles, ["category-list", "group-header"]);
  assert.equal(rail.taxonomy?.[0]?.kind, "group-header");
  assert.equal(rail.taxonomy?.[0]?.label, "飲料");
  assert.deepEqual(rail.taxonomy?.[0]?.children?.[0]?.aliases, [
    "每日精選咖啡",
    "熱濃縮咖啡飲料",
    "冰濃縮咖啡飲料"
  ]);
  assert.equal(rail.taxonomy?.[1]?.kind, "virtual");
  assert.equal(rail.taxonomy?.[1]?.allowDuplicates, true);

  const products = home.regions.find((entry) => entry.id === "product-list");
  assert.ok(products);
  assert.equal(products.isDynamic, true);
  assert.equal(products.dynamicAssets, true);
  assert.equal(products.expectedAssets, 1);
  assert.deepEqual(products.dynamicExamples, ["冰蘋果山茶花風味美式", "$120 起"]);
  assert.deepEqual(products.dynamicPatterns, ["\\$[0-9]+(?:\\.[0-9]+)?(?:\\s*起)?"]);

  assert.equal(semanticsForScreen(result.file, "首頁")?.screenId, "home");
  assert.equal(semanticsForScreen(result.file, "missing"), null);
  assert.equal(semanticsForScreen(null, "home"), null);
});

invalidCase(
  "duplicate screenId",
  (fixture) => {
    fixture.screens[1].screenId = "home";
  },
  "screens[1]"
);

invalidCase(
  "duplicate region id",
  (fixture) => {
    fixture.screens[0].regions[1].id = "category-rail";
  },
  "screens[0].regions[1]"
);

invalidCase(
  "invalid role",
  (fixture) => {
    fixture.screens[0].regions[0].role = "sidebar";
  },
  "screens[0].regions[0]"
);

invalidCase(
  "zero-width bbox",
  (fixture) => {
    fixture.screens[0].regions[0].designBbox = { x: 0, y: 0, width: 0, height: 10 };
  },
  "screens[0].regions[0]"
);

invalidCase(
  "overlapping invariant and dynamic example",
  (fixture) => {
    fixture.screens[0].regions[1].invariantTexts = ["冰蘋果山茶花風味美式"];
  },
  "screens[0].regions[1]"
);

invalidCase(
  "unsupported version",
  (fixture) => {
    fixture.version = 2;
  },
  "version"
);

invalidCase(
  "uncompilable dynamic pattern",
  (fixture) => {
    fixture.screens[0].regions[1].dynamicPatterns = ["["];
  },
  "screens[0].regions[1].dynamicPatterns[0]"
);

invalidCase(
  "overlong dynamic pattern",
  (fixture) => {
    fixture.screens[0].regions[1].dynamicPatterns = ["a".repeat(201)];
  },
  "screens[0].regions[1].dynamicPatterns[0]"
);

invalidCase(
  "duplicate taxonomy id",
  (fixture) => {
    fixture.screens[0].regions[0].taxonomy[1].id = "coffee";
  },
  "taxonomy"
);

invalidCase(
  "duplicate taxonomy label",
  (fixture) => {
    fixture.screens[0].regions[0].taxonomy[1].label = "咖啡飲品";
  },
  "taxonomy"
);

invalidCase(
  "group-header without children",
  (fixture) => {
    delete fixture.screens[0].regions[0].taxonomy[0].children;
  },
  "taxonomy[0]"
);

invalidCase(
  "negative expectedAssets",
  (fixture) => {
    fixture.screens[0].regions[1].expectedAssets = -1;
  },
  "screens[0].regions[1]"
);

test("missing file is neutral; invalid JSON is an error", () => {
  const root = makeTempDir("aos-ui-semantics-");
  const missing = loadUiSemantics(root);
  assert.equal(missing.file, null);
  assert.deepEqual(missing.errors, []);
  assert.equal(missing.path, path.join(root, "design", "ui-semantics.json"));

  const design = path.join(root, "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(path.join(design, "ui-semantics.json"), "{not json");
  const broken = loadUiSemantics(root);
  assert.equal(broken.file, null);
  assert.ok(broken.errors.length > 0);
});

test("loads an explicit relative path under configDir", () => {
  const root = makeTempDir("aos-ui-semantics-");
  fs.mkdirSync(path.join(root, "custom"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "custom", "semantics.json"),
    JSON.stringify({ version: 1, screens: [{ screenId: "home", regions: [] }] })
  );
  const loaded = loadUiSemantics(root, { path: "custom/semantics.json" });
  assert.ok(loaded.file);
  assert.equal(loaded.path, path.join(root, "custom", "semantics.json"));
});

test("legacy file without regions parses and keeps draft", () => {
  const result = parseUiSemantics(
    JSON.stringify({ version: 1, draft: true, screens: [{ screenId: "home" }] })
  );
  assert.ok(result.file);
  assert.equal(result.file.draft, true);
  assert.deepEqual(result.file.screens[0].regions, []);
});

test("unknown fields are ignored and dynamic flags can coexist", () => {
  const result = parseFixture();
  assert.ok(result.file);
  const fixture = baseSemantics();
  fixture.screens[0].unknownTopLevel = { nested: true };
  fixture.screens[0].regions[1].unknownRegionField = "ignored";
  const parsed = parseUiSemantics(JSON.stringify(fixture));
  assert.ok(parsed.file);
  const region = parsed.file.screens[0].regions[1];
  assert.equal(region.isDynamic, true);
  assert.equal(region.dynamicAssets, true);
  assert.equal("unknownRegionField" in region, false);
});

test("matchesDynamicPattern compiles safely and rejects invalid patterns", () => {
  assert.equal(matchesDynamicPattern("價格 $150", ["\\$[0-9]+"]), true);
  assert.equal(matchesDynamicPattern("$1200", ["\\$[0-9]{3}$"]), false);
  assert.equal(matchesDynamicPattern("$1200", ["^\\$[0-9]{3}$"]), false);
  assert.equal(matchesDynamicPattern("$120", ["\\$[0-9]{3}$"]), true);
  assert.equal(matchesDynamicPattern("anything", []), false);
  assert.equal(matchesDynamicPattern("anything", ["["]), false);
  assert.equal(matchesDynamicPattern("價格 $150", ["\\$[0-9]+", "["]), true);
});

test("matchesDynamicExample is bidirectional, length-bounded and numeric-token safe", () => {
  assert.equal(matchesDynamicExample("推薦飲料：冰蘋果山茶花風味美式", "冰蘋果山茶花風味美式"), true);
  assert.equal(matchesDynamicExample("冰蘋果山茶花風味美式", "推薦飲料：冰蘋果山茶花風味美式"), true);
  assert.equal(matchesDynamicExample("冰茶", "冰"), false);
  assert.equal(matchesDynamicExample("價格 $120", "$120 起"), true);
  assert.equal(matchesDynamicExample("價格 $1200", "$120 起"), false);
  assert.equal(matchesDynamicExample("價格 1200", "120"), false);
  assert.equal(matchesDynamicExample("價格 120", "120"), true);
  assert.equal(matchesDynamicExample("120", "120"), true);
  assert.equal(matchesDynamicExample("2026/10/26", "2026/10/26"), true);
  assert.equal(matchesDynamicExample("庫存 3", "3 件"), true);
  assert.equal(matchesDynamicExample("咖啡飲品", "咖啡飲品"), true);
});
