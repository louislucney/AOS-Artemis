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
import { buildFlowGraph, routeFor } from "../dist/figma/flows.js";
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
  assert.ok(click.textHints.includes("Buy now"), "element text hints captured");

  const home = graph.screens.find((screen) => screen.name === "Home");
  assert.ok(home.textHints.includes("Welcome Back"), "screen text hints captured");
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

test("normalizeAssetName: strips extension and separators", () => {
  assert.equal(normalizeAssetName("Home Icon.svg"), "home-icon");
  assert.equal(normalizeAssetName("ic_cart@2x.png"), "ic-cart-2x");
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
