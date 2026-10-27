import assert from "node:assert/strict";
import test from "node:test";

import { auditUiParity, normalizeUiText } from "../dist/ui/parity.js";

const screen = { id: "home", name: "Home", frameWidth: 375 };

function semantics(regions, extra = {}) {
  return {
    screenId: "home",
    screenName: "Home",
    viewport: { width: 440, height: 956, scale: 3 },
    regions,
    ...extra
  };
}

function text(value, options = {}) {
  const { x = 0, y = 0, width = 100, height = 20, source = "visual", space = "viewport", visible = true, bbox = true } = options;
  return {
    text: value,
    ...(bbox ? { bbox: { x, y, width, height } } : {}),
    source,
    space,
    visible
  };
}

function audit(region, texts, options = {}) {
  return auditUiParity({
    screen,
    semantics: semantics([region], options.semanticsExtra),
    runtime: {
      viewport: { width: 440, height: 956, scale: 3 },
      texts,
      ...(options.runtimeExtra ?? {})
    }
  });
}

test("normalizeUiText collapses whitespace and case without traditional/simplified conversion", () => {
  assert.equal(normalizeUiText("  每日 精選\t咖啡 "), "每日 精選 咖啡");
  assert.equal(normalizeUiText("ABC"), "abc");
  assert.equal(normalizeUiText("推薦"), "推薦");
});

test("visual taxonomy is layout-compatible and counts conserve", () => {
  const report = audit(
    {
      id: "category-rail",
      role: "category-list",
      taxonomy: [
        { id: "recommended", label: "推薦", kind: "virtual", allowDuplicates: true },
        {
          id: "drinks",
          label: "飲料",
          kind: "group-header",
          children: [{ id: "coffee", label: "咖啡飲品", kind: "category", aliases: ["每日精選咖啡"] }]
        }
      ]
    },
    [text("推薦"), text("飲料"), text("每日精選咖啡")]
  );
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "layout-compatible");
  assert.equal(report.counts.invariant, 3);
  assert.equal(report.counts.matched, 3);
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.truncated, 0);
  assert.equal(report.counts.unverified, 0);
  assert.equal(report.counts.offscreen, 0);
  assert.equal(report.counts.taxonomyExpected, 3);
  assert.equal(report.counts.taxonomyMatched, 3);
  assert.equal(report.counts.taxonomyMissing, 0);
  assert.equal(report.counts.taxonomyUnexpected, 0);
});

test("infix truncation from visual text produces truncated-labels, not missing", () => {
  const report = audit(
    { id: "category-rail", role: "category-list", invariantTexts: ["每日精選咖啡", "熱門飲料"] },
    [text("每...咖啡"), text("熱...飲料")]
  );
  assert.equal(report.verdict, "truncated-labels");
  assert.equal(report.ok, false);
  assert.equal(report.counts.invariant, 2);
  assert.equal(report.counts.matched, 0);
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.truncated, 2);
  assert.equal(report.counts.unverified, 0);
  assert.equal(report.counts.offscreen, 0);
  assert.equal(report.findings.filter((entry) => entry.kind === "truncated-label").length, 2);
  assert.ok(report.findings.filter((entry) => entry.kind === "truncated-label").every((entry) => entry.severity === "error"));
});

test("AX full text cannot prove no truncation and becomes insufficient-coverage", () => {
  const report = audit(
    { id: "category-rail", role: "category-list", invariantTexts: ["每日精選咖啡", "熱門飲料"] },
    [text("每日精選咖啡", { source: "ax", space: "content" }), text("熱門飲料", { source: "ax", space: "content" })]
  );
  assert.equal(report.verdict, "insufficient-coverage");
  assert.equal(report.ok, false);
  assert.equal(report.counts.truncated, 0);
  assert.equal(report.counts.unverified, 2);
  assert.equal(report.counts.matched, 0);
  assert.ok(report.warnings.some((warning) => warning.includes("visual-truncation-unverified")));
});

test("tail truncation is detected; exact ellipsis and short label are not false positives", () => {
  const report = audit(
    { id: "category-rail", role: "category-list", invariantTexts: ["每日精選咖啡", "禮盒…", "冰茶"] },
    [text("每日精…"), text("禮盒…"), text("冰茶")]
  );
  assert.equal(report.verdict, "truncated-labels");
  assert.equal(report.counts.truncated, 1);
  assert.equal(report.counts.matched, 2);
  assert.equal(report.counts.missing, 0);
});

test("dynamic examples and patterns are data-diff, not missing/unexpected", () => {
  const report = audit(
    {
      id: "product-list",
      role: "product-list",
      isDynamic: true,
      invariantTexts: ["推薦"],
      dynamicExamples: ["冰蘋果山茶花風味美式", "$120 起"],
      dynamicPatterns: ["\\$[0-9]+(?:\\.[0-9]+)?(?:\\s*起)?"]
    },
    [text("推薦"), text("冰蘋果山茶花風味美式"), text("$165 起")]
  );
  assert.equal(report.verdict, "data-diff");
  assert.equal(report.ok, true);
  assert.equal(report.counts.invariant, 1);
  assert.equal(report.counts.matched, 1);
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.dynamic, 2);
  assert.equal(report.counts.unexpected, 0);
});

test("displayNames map a runtime leaf to a design label", () => {
  const report = audit(
    {
      id: "category-rail",
      role: "category-list",
      invariantTexts: ["咖啡飲品"]
    },
    [text("每日精選咖啡")],
    { semanticsExtra: { displayNames: { 咖啡飲品: ["每日精選咖啡"] } } }
  );
  assert.equal(report.verdict, "layout-compatible");
  assert.equal(report.counts.matched, 1);
});

test("missing semantics and zero invariants are loud", () => {
  const missing = auditUiParity({
    screen,
    semantics: null,
    runtime: { texts: [text("推薦")] }
  });
  assert.equal(missing.verdict, "insufficient-data");
  assert.equal(missing.ok, false);
  assert.equal(missing.findings[0].kind, "missing-semantics");

  const empty = audit({ id: "category-rail", role: "category-list" }, [text("推薦")]);
  assert.equal(empty.verdict, "no-invariants");
  assert.equal(empty.ok, false);
});

test("taxonomy 17 vs flat 27 reports alias-aware missing and unexpected", () => {
  const taxonomy = [
    { id: "recommended", label: "推薦", kind: "virtual", allowDuplicates: true },
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
          aliases: ["冰茶", "熱茶", "冰茶那堤", "熱茶那堤", "茶瓦納與飲品調味"]
        },
        {
          id: "starblends",
          label: "星冰樂",
          kind: "category",
          aliases: ["星冰樂果汁系列", "星冰樂無咖啡系列", "星冰樂咖啡系列"]
        },
        { id: "coldbrew", label: "冷萃咖啡", kind: "category" },
        { id: "refreshers", label: "星沁爽", kind: "category" },
        { id: "other-drinks", label: "其他飲料", kind: "category", aliases: ["其他飲料系列"] },
        { id: "bottled", label: "罐裝飲料", kind: "category" },
        { id: "tumbler", label: "隨行外帶盒", kind: "category" },
        { id: "brewed", label: "調理咖啡", kind: "category" }
      ]
    },
    {
      id: "food",
      label: "餐點",
      kind: "group-header",
      children: [
        { id: "light", label: "輕食", kind: "category" },
        { id: "bread", label: "麵包", kind: "category" },
        { id: "cake", label: "蛋糕點心", kind: "category" },
        { id: "packaged", label: "包裝食品", kind: "category" },
        { id: "fresh", label: "新鮮現烤", kind: "category" }
      ]
    }
  ];
  const runtime = [
    "推薦", "每日精選咖啡", "熱濃縮咖啡飲料", "冰濃縮咖啡飲料", "冰茶", "熱茶", "冰茶那堤",
    "熱茶那堤", "星冰樂果汁系列", "星冰樂無咖啡系列", "星冰樂咖啡系列", "氮氣冷萃咖啡", "冷萃咖啡",
    "星沁爽", "其他飲料系列", "罐裝飲料", "隨行外帶盒", "咖啡豆", "VIA", "掛耳式咖啡", "輕食",
    "麵包", "蛋糕點心", "茶瓦納與飲品調味", "零食點心", "禮盒", "新鮮現烤"
  ];
  const report = audit(
    {
      id: "category-rail",
      role: "category-list",
      deviceBbox: { x: 0, y: 0, width: 200, height: 1000 },
      taxonomy
    },
    runtime.map((value) => text(value)),
    { runtimeExtra: { regionId: "category-rail" } }
  );
  assert.equal(report.verdict, "ia-mismatch");
  assert.equal(report.ok, false);
  assert.equal(report.counts.taxonomyExpected, 17);
  assert.equal(report.counts.taxonomyMatched, 13);
  assert.equal(report.counts.taxonomyMissing, 4);
  assert.equal(report.counts.taxonomyUnexpected, 6);
  assert.equal(report.counts.invariant, 17);
  assert.equal(report.counts.matched, 13);
  assert.equal(report.counts.missing, 4);
  assert.equal(report.counts.unverified, 0);
  assert.equal(report.counts.offscreen, 0);
});

test("partial viewport coverage is insufficient-coverage, never layout-compatible", () => {
  const invariants = Array.from({ length: 27 }, (_, index) => `分類${index + 1}`);
  const texts = invariants.map((value, index) => text(value, { visible: index < 14 }));
  const report = audit(
    { id: "category-rail", role: "category-list", invariantTexts: invariants },
    texts
  );
  assert.equal(report.verdict, "insufficient-coverage");
  assert.equal(report.ok, false);
  assert.equal(report.counts.invariant, 27);
  assert.equal(report.counts.matched, 14);
  assert.equal(report.counts.offscreen, 13);
  assert.equal(report.counts.unverified, 0);
});

test("dynamic assets must be present and non-placeholder", () => {
  const missing = audit(
    { id: "banner", role: "banner", isDynamic: true, dynamicAssets: true, expectedAssets: 1, invariantTexts: ["推薦"] },
    [text("推薦")],
    { runtimeExtra: { assets: [] } }
  );
  assert.equal(missing.verdict, "ia-mismatch");
  assert.equal(missing.counts.assetsExpected, 1);
  assert.equal(missing.counts.assetsPresent, 0);
  assert.equal(missing.counts.assetsMissing, 1);
  assert.ok(missing.findings.some((entry) => entry.kind === "missing-asset"));

  const placeholder = audit(
    { id: "banner", role: "banner", isDynamic: true, dynamicAssets: true, expectedAssets: 1, invariantTexts: ["推薦"] },
    [text("推薦")],
    { runtimeExtra: { assets: [{ kind: "image", present: true, placeholder: true, source: "visual" }] } }
  );
  assert.equal(placeholder.counts.assetsPlaceholder, 1);
  assert.ok(placeholder.findings.some((entry) => entry.kind === "placeholder-asset"));
});

test("role mismatch is an error; allowedRoles suppresses it; content space skips geometry", () => {
  const rail = {
    id: "category-rail",
    role: "category-list",
    deviceBbox: { x: 0, y: 100, width: 100, height: 500 },
    invariantTexts: ["推薦"]
  };
  const header = { id: "header", role: "header", deviceBbox: { x: 0, y: 0, width: 440, height: 100 } };
  const make = (region, value, options = {}) =>
    auditUiParity({
      screen,
      semantics: semantics([region, header]),
      runtime: {
        viewport: { width: 440, height: 956, scale: 3 },
        texts: [text(value, options)]
      }
    });

  const wrong = make(rail, "推薦", { x: 10, y: 10, width: 80, height: 20 });
  assert.equal(wrong.verdict, "ia-mismatch");
  assert.ok(wrong.findings.some((entry) => entry.kind === "role-mismatch"));

  const right = make(rail, "推薦", { x: 10, y: 150, width: 80, height: 20 });
  assert.equal(right.verdict, "layout-compatible");

  const allowed = make({ ...rail, allowedRoles: ["header"] }, "推薦", { x: 10, y: 10, width: 80, height: 20 });
  assert.equal(allowed.verdict, "layout-compatible");

  const content = make(rail, "推薦", { source: "ax", space: "content", x: 10, y: 150, width: 80, height: 20 });
  assert.notEqual(content.verdict, "ia-mismatch");
  assert.ok(content.warnings.some((warning) => warning.includes("coordinate-space")));
});

test("expectedCount and unexpected runtime text are visible", () => {
  const report = audit(
    { id: "product-list", role: "product-list", invariantTexts: ["推薦"], expectedCount: 1 },
    [text("推薦"), text("多出來的區塊")]
  );
  assert.equal(report.counts.unexpected, 1);
  assert.ok(report.findings.some((entry) => entry.kind === "unexpected-runtime-text"));
  assert.equal(report.findings.some((entry) => entry.kind === "expected-count-mismatch"), false);

  const mismatch = audit(
    { id: "product-list", role: "product-list", invariantTexts: ["推薦"], expectedCount: 2 },
    [text("推薦")]
  );
  assert.ok(mismatch.findings.some((entry) => entry.kind === "expected-count-mismatch"));
});

test("dynamic patterns do not swallow a longer numeric value", () => {
  const report = audit(
    {
      id: "product-list",
      role: "product-list",
      invariantTexts: ["推薦"],
      dynamicExamples: ["$120"],
      dynamicPatterns: ["^\\$[0-9]{3}$"]
    },
    [text("推薦"), text("$1200")]
  );
  assert.equal(report.counts.dynamic, 0);
  assert.equal(report.counts.unexpected, 1);
});

test("alias truncation is detected via displayNames", () => {
  const report = audit(
    { id: "category-rail", role: "category-list", invariantTexts: ["咖啡飲品"] },
    [text("每...咖啡")],
    { semanticsExtra: { displayNames: { 咖啡飲品: ["每日精選咖啡"] } } }
  );
  assert.equal(report.verdict, "truncated-labels");
  assert.equal(report.counts.truncated, 1);
  assert.equal(report.counts.missing, 0);
});

test("truncated text is consumed and does not become unexpected/taxonomy error", () => {
  const report = audit(
    {
      id: "category-rail",
      role: "category-list",
      deviceBbox: { x: 0, y: 0, width: 200, height: 500 },
      taxonomy: [{ id: "coffee", label: "咖啡飲品", kind: "category" }],
      invariantTexts: ["每日精選咖啡"]
    },
    [text("咖啡飲品"), text("每...咖啡")],
    { runtimeExtra: { regionId: "category-rail" } }
  );
  assert.equal(report.verdict, "truncated-labels");
  assert.equal(report.counts.truncated, 1);
  assert.equal(report.counts.unexpected, 0);
  assert.equal(report.counts.taxonomyUnexpected, 0);
  assert.equal(report.findings.some((entry) => entry.kind === "unexpected-runtime-text"), false);
});

test("role overlap is ambiguous, not a mismatch", () => {
  const rail = {
    id: "category-rail",
    role: "category-list",
    deviceBbox: { x: 0, y: 0, width: 100, height: 300 },
    invariantTexts: ["推薦"]
  };
  const header = { id: "header", role: "header", deviceBbox: { x: 0, y: 0, width: 100, height: 100 } };
  const report = auditUiParity({
    screen,
    semantics: semantics([rail, header]),
    runtime: {
      viewport: { width: 440, height: 956, scale: 3 },
      texts: [text("推薦", { x: 10, y: 10, width: 80, height: 20 })]
    }
  });
  assert.equal(report.verdict, "layout-compatible");
  assert.equal(report.findings.some((entry) => entry.kind === "role-mismatch"), false);
  assert.equal(report.findings.some((entry) => entry.kind === "role-ambiguous"), true);
});

test("expectedAssets without assets is a missing-asset error", () => {
  const report = audit(
    { id: "banner", role: "banner", expectedAssets: 1, invariantTexts: ["推薦"] },
    [text("推薦")]
  );
  assert.equal(report.verdict, "ia-mismatch");
  assert.equal(report.counts.assetsExpected, 1);
  assert.equal(report.counts.assetsMissing, 1);
  assert.ok(report.findings.some((entry) => entry.kind === "missing-asset"));
});

test("draft semantics is never layout-compatible", () => {
  const report = auditUiParity({
    screen,
    semantics: semantics([{ id: "category-rail", role: "category-list", invariantTexts: ["推薦"] }]),
    draft: true,
    runtime: { texts: [text("推薦")] }
  });
  assert.equal(report.verdict, "no-invariants");
  assert.equal(report.ok, false);
  assert.ok(report.warnings.some((warning) => warning.includes("draft")));
});

test("taxonomy unexpected is scoped to the taxonomy region bbox", () => {
  const report = audit(
    {
      id: "category-rail",
      role: "category-list",
      deviceBbox: { x: 0, y: 0, width: 200, height: 300 },
      taxonomy: [{ id: "coffee", label: "咖啡飲品", kind: "category" }]
    },
    [text("咖啡飲品", { x: 10, y: 10 }), text("商品名", { x: 300, y: 10 })]
  );
  assert.equal(report.counts.taxonomyUnexpected, 0);
  assert.equal(report.counts.unexpected, 0);
});

test("role checks skip when the expected region has no deviceBbox", () => {
  const rail = { id: "category-rail", role: "category-list", invariantTexts: ["推薦"] };
  const header = { id: "header", role: "header", deviceBbox: { x: 0, y: 0, width: 440, height: 100 } };
  const report = auditUiParity({
    screen,
    semantics: semantics([rail, header]),
    runtime: {
      viewport: { width: 440, height: 956, scale: 3 },
      texts: [text("推薦", { x: 10, y: 10, width: 80, height: 20 })]
    }
  });
  assert.equal(report.verdict, "layout-compatible");
  assert.equal(report.findings.some((entry) => entry.kind === "role-mismatch"), false);
});

test("viewport mismatch degrades role errors to warnings", () => {
  const rail = {
    id: "category-rail",
    role: "category-list",
    deviceBbox: { x: 0, y: 100, width: 100, height: 300 },
    invariantTexts: ["推薦"]
  };
  const report = auditUiParity({
    screen,
    semantics: semantics([rail]),
    runtime: {
      viewport: { width: 300, height: 600, scale: 2 },
      texts: [text("推薦", { x: 10, y: 10, width: 80, height: 20 })]
    }
  });
  assert.ok(report.findings.some((entry) => entry.kind === "viewport-mismatch"));
  assert.ok(report.findings.some((entry) => entry.kind === "role-mismatch" && entry.severity === "warning"));
});

test("expectedOccurrences mismatch is visible", () => {
  const report = audit(
    { id: "product-list", role: "product-list", invariantTexts: ["推薦"], expectedOccurrences: 2 },
    [text("推薦")]
  );
  assert.ok(report.findings.some((entry) => entry.kind === "expected-count-mismatch"));
});
