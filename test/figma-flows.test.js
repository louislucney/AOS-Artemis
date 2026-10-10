import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";
import { syntheticFlowDocument } from "./fixtures/figma-flow-doc.mjs";

import {
  analyzeGapData,
  applyAssetNaming,
  globToRegExp,
  normalizeAssetName,
  walkProjectFiles
} from "../dist/figma/gaps.js";
import { buildFlowGraph, flowGraphWarnings, normalizeFlowGraph, routeFor } from "../dist/figma/flows.js";
import { STACK_PROFILES } from "../dist/projects/stack.js";

test("flow graph: consecutive interactions produce screens, edges and entry screens", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());

  assert.deepEqual(
    graph.screens.map((screen) => screen.name).sort(),
    ["Checkout", "Home", "Success"]
  );
  assert.equal(graph.edges.length, 3);
  assert.deepEqual(graph.entryScreens, ["Home"]);
  assert.deepEqual(graph.unresolvedDestinations, []);

  const click = graph.edges.find((edge) => edge.trigger === "ON_CLICK" && !edge.back);
  assert.equal(click.from.name, "Home");
  assert.equal(click.to.name, "Checkout");
  assert.equal(click.element.name, "CTA Button");
  assert.equal(click.navigation, "NAVIGATE");
  assert.ok(
    click.textHints.some((hint) => hint.text === "Buy now"),
    "element text hints captured"
  );

  const home = graph.screens.find((screen) => screen.name === "Home");
  assert.ok(
    home.textHints.some((hint) => hint.text === "Welcome Back"),
    "screen text hints captured"
  );
  assert.ok(home.childNames.includes("CTA Button"), "screen child names captured");

  const timeout = graph.edges.find((edge) => edge.trigger === "AFTER_TIMEOUT");
  assert.equal(timeout.triggerTimeoutMs, 2000);
  assert.equal(timeout.from.name, "Checkout");
  assert.equal(timeout.to.name, "Success");

  const back = graph.edges.find((edge) => edge.back === true);
  assert.equal(back.from.name, "Success");
  assert.equal(back.to.name, "Success");
});

test("flow graph: unresolved destinations are reported with a null target", () => {
  const document = syntheticFlowDocument();
  const home = document.children[0].children[0];
  const cta = home.children.find((child) => child.name === "CTA Button");
  cta.interactions[0].actions[0].destinationId = "99:99";

  const graph = buildFlowGraph(document);
  assert.deepEqual(graph.unresolvedDestinations, ["99:99"]);
  const dangling = graph.edges.find((edge) => edge.to === null);
  assert.ok(dangling);
  assert.equal(dangling.from.name, "Home");
});

test("flow graph: nodeId scoping limits the graph and flags outside destinations", () => {
  const graph = buildFlowGraph(syntheticFlowDocument(), { nodeId: "11:1" });
  assert.equal(graph.screens.length, 1);
  assert.equal(graph.screens[0].id, "11:1");
  assert.equal(graph.screens[0].name, "Checkout");
  assert.equal(graph.screens[0].suggestedRoute, "/checkout");
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.unresolvedDestinations, ["12:1"]);
});

test("routeFor: home/landing/index collapse to root", () => {
  assert.equal(routeFor("Home"), "/");
  assert.equal(routeFor("Landing"), "/");
  assert.equal(routeFor("Index"), "/");
  assert.equal(routeFor("User Profile"), "/user-profile");
});

test("globToRegExp + walkProjectFiles: matches and skips heavy dirs", () => {
  assert.ok(globToRegExp("**/*.svg").test("assets/icons/home.svg"));
  assert.ok(globToRegExp("**/*.svg").test("home.svg"));
  assert.ok(!globToRegExp("**/*.svg").test("assets/home.png"));
  assert.ok(globToRegExp("assets/**").test("assets/a/b.png"));

  const root = makeTempDir("aos-scan-");
  fs.mkdirSync(path.join(root, "assets", "icons"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "icons", "home.svg"), "<svg/>");
  fs.writeFileSync(path.join(root, "src", "logo.png"), "png");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "x.svg"), "<svg/>");

  const files = walkProjectFiles(root, ["**/*.svg", "**/*.png"]);
  assert.deepEqual(files, ["assets/icons/home.svg", "src/logo.png"]);
});

test("analyzeGapData: missing vs existing assets with icon suffix tolerance", () => {
  const result = analyzeGapData({
    designAssets: [
      { id: "1:1", name: "Home Icon", suggestedFilename: "home-icon.svg" },
      { id: "1:2", name: "Cart", suggestedFilename: "cart.svg" }
    ],
    designColors: [],
    projectAssetPaths: ["assets/cart.svg"]
  });

  assert.deepEqual(result.missingAssets.map((asset) => asset.slug), ["home-icon"]);
  assert.equal(result.existingAssets[0].matchedPath, "assets/cart.svg");
});

test("analyzeGapData: colors checked only with token contents; 3-digit hex expands", () => {
  const withoutTokens = analyzeGapData({
    designAssets: [],
    designColors: ["#FF0000"],
    projectAssetPaths: []
  });
  assert.equal(withoutTokens.colorsChecked, false);
  assert.deepEqual(withoutTokens.missingColors, []);

  const withTokens = analyzeGapData({
    designAssets: [],
    designColors: ["#FF0000", "#00FF00"],
    projectAssetPaths: [],
    tokenContents: [":root { --primary: #f00; }"]
  });
  assert.equal(withTokens.colorsChecked, true);
  assert.deepEqual(withTokens.missingColors, ["#00FF00"]);
});

test("normalizeAssetName: strips extension, @2x/@3x scale and separators", () => {
  assert.equal(normalizeAssetName("Home Icon.svg"), "home-icon");
  assert.equal(normalizeAssetName("ic_cart@2x.png"), "ic-cart");
  assert.equal(normalizeAssetName("home_icon@3x.png"), "home-icon");
});

test("analyzeGapData: @2x-only imageset does not report a false gap", () => {
  const result = analyzeGapData({
    designAssets: [{ id: "1:1", name: "Home Icon", suggestedFilename: "home_icon.svg" }],
    designColors: [],
    projectAssetPaths: ["Resources/Assets.xcassets/home_icon.imageset/home_icon@2x.png"]
  });
  assert.deepEqual(result.missingAssets, []);
  assert.equal(result.existingAssets[0].matchedPath, "Resources/Assets.xcassets/home_icon.imageset/home_icon@2x.png");
});

test("analyzeGapData: iOS colorset 与 Swift Color(...) 均计入已有颜色", () => {
  const colorset = JSON.stringify({
    colors: [
      {
        color: {
          "color-space": "srgb",
          components: { red: "1.000", green: "0.000", blue: "0.000", alpha: "1.000" }
        },
        idiom: "universal"
      }
    ],
    info: { author: "x", version: 1 }
  });
  const swift = ['let c = Color(red: 0.0, green: 1.0, blue: 0.0, opacity: 1.0)'].join("\n");
  const result = analyzeGapData({
    designAssets: [],
    designColors: ["#FF0000", "#00FF00", "#0000FF"],
    projectAssetPaths: [],
    tokenContents: [colorset, swift]
  });
  assert.equal(result.colorsChecked, true);
  assert.deepEqual(result.missingColors, ["#0000FF"]);
});

test("applyAssetNaming: retargets missing-asset filenames to the detected stack", () => {
  const missing = [
    { name: "Home Icon", slug: "home-icon", suggestedFilename: "home-icon.svg", figmaId: "1:1" }
  ];

  const android = applyAssetNaming(missing, STACK_PROFILES["android-native"]);
  assert.equal(android[0].suggestedFilename, "ic_home.svg");
  assert.equal(android[0].figmaSuggestedFilename, "home-icon.svg");
  assert.match(android[0].suggestedDir, /res\/drawable/);
  assert.ok(android[0].namingNote.includes("a-z0-9_"));
  const rn = applyAssetNaming(missing, STACK_PROFILES["react-native"]);
  assert.equal(rn[0].suggestedFilename, "home-icon.svg");
  assert.equal(rn[0].suggestedDir, "src/assets");

  const none = applyAssetNaming(missing, null);
  assert.equal(none[0].suggestedFilename, "home-icon.svg");
  assert.equal(none[0].suggestedDir, null);
});

test("applyAssetNaming: generic layer names fall back to a deterministic asset hash name", () => {
  const missing = [
    { name: "Frame 427", slug: "frame-427", suggestedFilename: "frame-427.svg", figmaId: "42:7" }
  ];
  const android = applyAssetNaming(missing, STACK_PROFILES["android-native"]);
  assert.match(android[0].suggestedFilename, /^ic_asset_[0-9a-f]{8}\.svg$/);
  assert.equal(android[0].needsRename, true);
  assert.equal(android[0].figmaSuggestedFilename, "frame-427.svg");

  const again = applyAssetNaming(missing, STACK_PROFILES["android-native"]);
  assert.equal(again[0].suggestedFilename, android[0].suggestedFilename, "fallback name must be deterministic");

  const flutter = applyAssetNaming(missing, STACK_PROFILES.flutter);
  assert.match(flutter[0].suggestedFilename, /^asset_[0-9a-f]{8}\.svg$/);
});

test("flow graph: screens without prototype interactions get a no-interactions warning", () => {
  const document = syntheticFlowDocument();
  const strip = (node) => {
    delete node.interactions;
    for (const child of node.children ?? []) strip(child);
  };
  strip(document);

  const graph = buildFlowGraph(document);
  assert.equal(graph.interactionNodes, 0);
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.screens.length > 1);
  const warnings = flowGraphWarnings(graph);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["no-interactions"]
  );
  assert.match(warnings[0].message, /原型交互/);
  assert.deepEqual(warnings[0].details, ["Home", "Checkout", "Success"]);

  const rich = buildFlowGraph(syntheticFlowDocument());
  assert.equal(rich.interactionNodes, 3);
  assert.deepEqual(flowGraphWarnings(rich), [], "interactions present: no missing-interaction warning");
});

test("flow graph: interactions without executable actions still warn as an island", () => {
  const document = syntheticFlowDocument();
  const strip = (node) => {
    delete node.interactions;
    for (const child of node.children ?? []) strip(child);
  };
  strip(document);
  let cta = null;
  const find = (node) => {
    if (node.id === "10:2") cta = node;
    for (const child of node.children ?? []) find(child);
  };
  find(document);
  cta.interactions = [{ trigger: { type: "ON_CLICK" }, actions: [] }];

  const graph = buildFlowGraph(document);
  assert.equal(graph.interactionNodes, 1);
  assert.equal(graph.edges.length, 0);
  const warnings = flowGraphWarnings(graph);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["no-interactions"]
  );
  assert.match(warnings[0].message, /未提取到任何可执行跳转/);
});

test("flow graph: a single screen without interactions does not warn", () => {
  const single = {
    id: "0:0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Page",
        type: "PAGE",
        children: [{ id: "2:0", name: "Only", type: "FRAME", children: [] }]
      }
    ]
  };
  const graph = buildFlowGraph(single);
  assert.equal(graph.screens.length, 1);
  assert.deepEqual(flowGraphWarnings(graph), []);
});

test("flow graph: explicit provenance, high confidence and text classes are attached", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  assert.ok(
    graph.edges.every((edge) => edge.provenance === "explicit" && edge.confidence === "high"),
    "interaction edges are explicit/high"
  );
  assert.ok(
    graph.screens.every((screen) => screen.provenance === "explicit" && screen.confidence === "high"),
    "design screens are explicit/high"
  );

  const home = graph.screens.find((screen) => screen.name === "Home");
  const welcome = home.textHints.find((hint) => hint.text === "Welcome Back");
  assert.equal(welcome.textClass, "runtime-text");
  const click = graph.edges.find((edge) => edge.element.name === "CTA Button");
  assert.equal(click.textHints.find((hint) => hint.text === "Buy now").textClass, "runtime-text");
});

test("flow graph: annotation flood does not crowd out runtime texts", () => {
  const document = syntheticFlowDocument();
  const home = document.children[0].children.find((node) => node.name === "Home");
  home.children.unshift(
    ...[1, 2, 3].map((index) => ({
      id: `fn${index}`,
      name: "Flow/Note",
      type: "FRAME",
      children: [{ id: `fn${index}t`, type: "TEXT", characters: `批注${index}` }]
    }))
  );
  const cta = home.children.find((node) => node.name === "CTA Button");
  cta.children.unshift(
    ...[1, 2, 3].map((index) => ({
      id: `cf${index}`,
      name: "Flow/Note",
      type: "FRAME",
      children: [{ id: `cf${index}t`, type: "TEXT", characters: `按钮批注${index}` }]
    }))
  );

  const graph = buildFlowGraph(document);
  const screen = graph.screens.find((candidate) => candidate.name === "Home");
  assert.ok(
    screen.textHints.some((hint) => hint.text === "Welcome Back" && hint.textClass === "runtime-text"),
    "runtime screen text survives an annotation flood"
  );
  assert.ok(
    screen.textHints.some((hint) => hint.text === "批注1" && hint.textClass === "annotation"),
    "annotations are still kept under their own class cap"
  );
  const click = graph.edges.find((edge) => edge.element.name === "CTA Button");
  assert.ok(
    click.textHints.some((hint) => hint.text === "Buy now" && hint.textClass === "runtime-text"),
    "runtime element text survives an annotation flood"
  );
});

test("flow graph: texts under Flow/* layers are classified as annotations", () => {
  const document = syntheticFlowDocument();
  const home = document.children[0].children.find((node) => node.name === "Home");
  home.children.push({
    id: "10:9",
    name: "Flow/Note",
    type: "FRAME",
    children: [{ id: "10:10", name: "Note text", type: "TEXT", characters: "设计批注：跳转 A→B" }]
  });

  const graph = buildFlowGraph(document);
  const screen = graph.screens.find((candidate) => candidate.name === "Home");
  const note = screen.textHints.find((hint) => hint.text === "设计批注：跳转 A→B");
  assert.equal(note.textClass, "annotation");
  assert.equal(
    screen.textHints.find((hint) => hint.text === "Welcome Back").textClass,
    "runtime-text"
  );
});

test("normalizeFlowGraph: legacy artifacts default to legacy-unknown and string hints", () => {
  const legacy = {
    screens: [
      {
        id: "s1",
        name: "Home",
        suggestedRoute: "/",
        childNames: ["X"],
        textHints: ["Welcome"]
      }
    ],
    edges: [
      {
        from: { id: "s1", name: "Home" },
        to: null,
        element: { id: "e", name: "E", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE"
      }
    ],
    entryScreens: ["Home"],
    unresolvedDestinations: []
  };

  const graph = normalizeFlowGraph(legacy);
  assert.equal(graph.screens[0].provenance, "legacy-unknown");
  assert.equal(graph.screens[0].confidence, "low");
  assert.deepEqual(graph.screens[0].textHints, [{ text: "Welcome", textClass: "runtime-text" }]);
  assert.equal(graph.edges[0].provenance, "legacy-unknown");
  assert.equal(graph.edges[0].confidence, "low");

  const kept = normalizeFlowGraph({
    screens: [
      {
        id: "s1",
        name: "Home",
        suggestedRoute: "/",
        childNames: [],
        textHints: [{ text: "Welcome", textClass: "annotation" }],
        provenance: "human-confirmed",
        confidence: "high"
      }
    ],
    edges: [],
    entryScreens: [],
    unresolvedDestinations: []
  });
  assert.equal(kept.screens[0].provenance, "human-confirmed");
  assert.equal(kept.screens[0].confidence, "high");
  assert.deepEqual(kept.screens[0].textHints, [{ text: "Welcome", textClass: "annotation" }]);

  const unknownClass = normalizeFlowGraph({
    screens: [
      {
        id: "s1",
        name: "Home",
        suggestedRoute: "/",
        childNames: [],
        textHints: [{ text: "  Padded text  ", textClass: "made-up" }]
      }
    ],
    edges: [
      {
        from: { id: "s1", name: "Home" },
        to: { bogus: true },
        element: null,
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE"
      }
    ],
    entryScreens: [],
    unresolvedDestinations: []
  });
  assert.deepEqual(
    unknownClass.screens[0].textHints,
    [{ text: "Padded text", textClass: "annotation" }],
    "unknown classes downgrade to annotation (never promoted into assertions)"
  );
  assert.equal(unknownClass.edges[0].to, null, "malformed destination resolves to null");
});

test("flow graph: acceptance criteria come from Flow/AC groups and AC: annotations", () => {
  const document = syntheticFlowDocument();
  const home = document.children[0].children.find((node) => node.name === "Home");
  home.children.push(
    {
      id: "10:20",
      name: "Flow/AC",
      type: "FRAME",
      children: [{ id: "10:21", name: "A1", type: "TEXT", characters: "金额正确" }]
    },
    {
      id: "10:22",
      name: "Flow/Note",
      type: "FRAME",
      children: [
        { id: "10:23", name: "N1", type: "TEXT", characters: "AC: 显示订单号" },
        { id: "10:24", name: "N2", type: "TEXT", characters: "AC:" },
        { id: "10:25", name: "N3", type: "TEXT", characters: "普通批注" },
        { id: "10:26", name: "N4", type: "TEXT", characters: "ac: 小写口径" },
        { id: "10:27", name: "N5", type: "TEXT", characters: "验收要求：多行\n第二行" }
      ]
    }
  );

  const graph = buildFlowGraph(document);
  const screen = graph.screens.find((candidate) => candidate.name === "Home");
  assert.deepEqual(
    screen.acceptance,
    ["金额正确", "显示订单号", "小写口径", "多行\n第二行"],
    "Flow/AC group items and annotated AC: lines (case-insensitive, multiline); empty AC: bodies are ignored"
  );
  const checkout = graph.screens.find((candidate) => candidate.name === "Checkout");
  assert.equal(checkout.acceptance, undefined, "screens without criteria keep the field absent");

  const normalized = normalizeFlowGraph({
    screens: [
      {
        id: "s1",
        name: "Home",
        suggestedRoute: "/",
        childNames: [],
        textHints: [],
        acceptance: ["  人工口径  ", "", 42]
      }
    ],
    edges: [],
    entryScreens: [],
    unresolvedDestinations: []
  });
  assert.deepEqual(normalized.screens[0].acceptance, ["人工口径"]);
});
