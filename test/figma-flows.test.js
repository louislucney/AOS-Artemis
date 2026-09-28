import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeGapData,
  buildFlowGraph,
  globToRegExp,
  normalizeAssetName,
  routeFor,
  walkProjectFiles
} from "../dist/figma/flows.js";

function syntheticDocument() {
  return {
    id: "0:0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Page 1",
        type: "PAGE",
        children: [
          {
            id: "10:1",
            name: "Home",
            type: "FRAME",
            children: [
              {
                id: "10:2",
                name: "CTA Button",
                type: "INSTANCE",
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [
                      {
                        type: "NODE",
                        destinationId: "11:1",
                        navigation: "NAVIGATE",
                        transition: { type: "SMART_ANIMATE", duration: 0.3 }
                      }
                    ]
                  }
                ]
              }
            ]
          },
          {
            id: "11:1",
            name: "Checkout",
            type: "FRAME",
            children: [
              {
                id: "11:2",
                name: "Payment Loader",
                type: "FRAME",
                interactions: [
                  {
                    trigger: { type: "AFTER_TIMEOUT", timeout: 2000 },
                    actions: [
                      { type: "NODE", destinationId: "12:1", navigation: "NAVIGATE" }
                    ]
                  }
                ]
              }
            ]
          },
          {
            id: "12:1",
            name: "Success",
            type: "FRAME",
            children: [
              {
                id: "12:2",
                name: "Back Link",
                type: "VECTOR",
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", navigation: "BACK" }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

test("flow graph: consecutive interactions produce screens, edges and entry screens", () => {
  const graph = buildFlowGraph(syntheticDocument());

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

  const timeout = graph.edges.find((edge) => edge.trigger === "AFTER_TIMEOUT");
  assert.equal(timeout.triggerTimeoutMs, 2000);
  assert.equal(timeout.from.name, "Checkout");
  assert.equal(timeout.to.name, "Success");

  const back = graph.edges.find((edge) => edge.back === true);
  assert.equal(back.from.name, "Success");
  assert.equal(back.to.name, "Success");
});

test("flow graph: unresolved destinations are reported with a null target", () => {
  const document = syntheticDocument();
  document.children[0].children[0].children[0].interactions[0].actions[0].destinationId = "99:99";

  const graph = buildFlowGraph(document);
  assert.deepEqual(graph.unresolvedDestinations, ["99:99"]);
  const dangling = graph.edges.find((edge) => edge.to === null);
  assert.ok(dangling);
  assert.equal(dangling.from.name, "Home");
});

test("flow graph: nodeId scoping limits the graph and flags outside destinations", () => {
  const graph = buildFlowGraph(syntheticDocument(), { nodeId: "11:1" });
  assert.deepEqual(graph.screens, [
    { id: "11:1", name: "Checkout", suggestedRoute: "/checkout" }
  ]);
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-scan-"));
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
