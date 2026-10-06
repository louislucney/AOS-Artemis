import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import { extractDesignSystem } from "../dist/vendor/design-context-bridge/figma-rest/analysis.js";
import {
  mergeColorTokens,
  normalizeHexColor,
  parseCanonicalTokens,
  renderStackTokenFile,
  scanHardcodedColors,
  serializeTokens,
  writeStackTokenFile
} from "../dist/figma/color.js";
import { STACK_PROFILES } from "../dist/projects/stack.js";

const CTA = [{ hex: "#3B82F6", usageCount: 3, sampleLayers: ["CTA Button"] }];

test("normalizeHexColor: expands #RGB/#RGBA/#RRGGBB and keeps alpha", () => {
  assert.equal(normalizeHexColor("#fff"), "#FFFFFFFF");
  assert.equal(normalizeHexColor("#0af8"), "#00AAFF88");
  assert.equal(normalizeHexColor("3b82f6"), "#3B82F6FF");
  assert.equal(normalizeHexColor("#3B82F680"), "#3B82F680");
  assert.equal(normalizeHexColor("#12345"), null);
  assert.equal(normalizeHexColor("nope"), null);
});

test("vendor alpha patch: translucent fills stay distinct (#RRGGBBAA)", () => {
  const document = {
    id: "0",
    name: "root",
    type: "DOCUMENT",
    children: [
      {
        id: "p",
        name: "Page",
        type: "CANVAS",
        children: [
          {
            id: "1",
            name: "Scrim",
            type: "FRAME",
            fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5 }]
          },
          {
            id: "2",
            name: "Ink",
            type: "FRAME",
            fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }]
          }
        ]
      }
    ]
  };
  const designSystem = extractDesignSystem(document);
  assert.deepEqual(designSystem.colors.map((color) => color.hex).sort(), [
    "#000000",
    "#00000080"
  ]);
});

test("merge: semantic name from samples, base+needsReview for generic layers", () => {
  const semantic = mergeColorTokens(CTA, []);
  assert.equal(semantic.tokens.length, 1);
  assert.equal(semantic.tokens[0].name, "color.brand.cta_button");
  assert.equal(semantic.tokens[0].value, "#3B82F6FF");
  assert.equal(semantic.tokens[0].needsReview, false);
  assert.equal(semantic.actions[0].action, "new");

  const generic = mergeColorTokens(
    [{ hex: "#123456", usageCount: 1, sampleLayers: ["Frame 427"] }],
    []
  );
  assert.equal(generic.tokens[0].name, "color.base.123456");
  assert.equal(generic.tokens[0].needsReview, true);
});

test("merge: multiple meaningful samples create a base token plus aliases", () => {
  const { tokens } = mergeColorTokens(
    [{ hex: "#FFFFFF", usageCount: 2, sampleLayers: ["Text Label", "Card Background"] }],
    []
  );
  const names = tokens.map((token) => token.name).sort();
  assert.deepEqual(names, ["color.base.ffffff", "color.surface.card_background", "color.text.text_label"]);
  const base = tokens.find((token) => token.name === "color.base.ffffff");
  assert.ok(base);
  assert.equal(base.needsReview, true);
  const alias = tokens.find((token) => token.name === "color.text.text_label");
  assert.equal(alias.aliasOf, "color.base.ffffff");
  assert.equal(alias.value, "{color.base.ffffff}");
});

test("merge: value-frozen naming is idempotent and re-import keeps names", () => {
  const first = mergeColorTokens(CTA, []);
  const second = mergeColorTokens(CTA, first.tokens);
  assert.deepEqual(second.tokens, first.tokens);
  assert.ok(second.actions.every((action) => action.action === "unchanged"));

  const aliased = mergeColorTokens(
    [{ hex: "#FFFFFF", usageCount: 2, sampleLayers: ["Text Label", "Card Background"] }],
    []
  );
  const again = mergeColorTokens(
    [{ hex: "#FFFFFF", usageCount: 2, sampleLayers: ["Text Label", "Card Background"] }],
    aliased.tokens
  );
  assert.deepEqual(again.tokens, aliased.tokens);
  assert.equal(again.tokens.filter((token) => token.aliasOf).length, 2);
});

test("merge: disappeared values are kept and reported unused", () => {
  const first = mergeColorTokens(CTA, []);
  const next = mergeColorTokens(
    [{ hex: "#111111", usageCount: 1, sampleLayers: ["Brand Logo"] }],
    first.tokens
  );
  assert.ok(next.tokens.some((token) => token.name === "color.brand.cta_button"));
  assert.ok(
    next.actions.some(
      (action) => action.name === "color.brand.cta_button" && action.action === "unused"
    )
  );
});

test("merge: token-names.json override wins and clears needsReview", () => {
  const { tokens } = mergeColorTokens(CTA, [], { "#3B82F6FF": "color.brand.primary" });
  assert.equal(tokens[0].name, "color.brand.primary");
  assert.equal(tokens[0].needsReview, false);
});

test("canonical serialization: DTCG shape, modes reserved, deterministic round-trip", () => {
  const { tokens } = mergeColorTokens(CTA, []);
  const text = serializeTokens(tokens);
  const parsed = JSON.parse(text);
  const leaf = parsed.color.brand.cta_button;
  assert.equal(leaf.$type, "color");
  assert.equal(leaf.$value, "#3B82F6FF");
  assert.deepEqual(leaf.$extensions.aos.modes, { default: "#3B82F6FF" });

  const reparsed = parseCanonicalTokens(text);
  assert.deepEqual(reparsed, tokens);
  assert.equal(serializeTokens(reparsed), text, "serialization must be byte-stable");
});

test("stack writers: per-stack formats, alias resolution and marker", () => {
  const { tokens } = mergeColorTokens(
    [{ hex: "#FFFFFF", usageCount: 2, sampleLayers: ["Text Label", "Card Background"] }],
    []
  );

  const android = renderStackTokenFile(STACK_PROFILES["android-native"], tokens);
  assert.ok(android);
  assert.equal(android.relativePath, "app/src/main/res/values/aos_tokens.xml");
  assert.match(android.content, /<color name="color_text_text_label">#FFFFFFFF<\/color>/);
  assert.match(android.content, /AUTO-GENERATED by aos-mcp/);

  const flutter = renderStackTokenFile(STACK_PROFILES.flutter, tokens);
  assert.ok(flutter);
  assert.equal(flutter.relativePath, "lib/theme/aos_tokens.dart");
  assert.match(flutter.content, /static const Color colorTextTextLabel = Color\(0xFFFFFFFF\);/);

  const web = renderStackTokenFile(STACK_PROFILES.web, tokens);
  assert.ok(web);
  assert.match(web.content, /--color-text-text-label: #FFFFFF;/);

  const reactNative = renderStackTokenFile(STACK_PROFILES["react-native"], tokens);
  assert.ok(reactNative);
  assert.match(reactNative.content, /"color.text.text_label": "#FFFFFF",/);

  const ios = renderStackTokenFile(STACK_PROFILES["ios-native"], tokens);
  assert.ok(ios);
  assert.equal(ios.relativePath, "ios/AosTokens.swift");
  assert.match(ios.content, /import SwiftUI/);
  assert.match(ios.content, /static let colorTextTextLabel = Color\("color.text.text_label"\)/);
  assert.ok(ios.extraFiles);
  assert.equal(ios.extraFiles.length, tokens.length);
  const colorset = ios.extraFiles.find((file) =>
    file.relativePath.includes("color.text.text_label.colorset")
  );
  assert.ok(colorset);
  const colorsetJson = JSON.parse(colorset.content);
  assert.equal(colorsetJson.colors[0].color.components.red, "1.000");
  assert.equal(colorsetJson.info.author.includes("AUTO-GENERATED by aos-mcp"), true);
});

test("writeStackTokenFile: iOS 主文件 + colorsets 一起落盘且幂等", () => {
  const dir = makeTempDir("aos-colors-");
  const { tokens } = mergeColorTokens(
    [{ hex: "#FFFFFF", usageCount: 2, sampleLayers: ["Text Label"] }],
    []
  );
  const write = renderStackTokenFile(STACK_PROFILES["ios-native"], tokens);
  assert.ok(write);
  const first = writeStackTokenFile(dir, write, {});
  assert.equal(first.action, "written");
  assert.equal(first.files.length, 1 + tokens.length);
  assert.ok(fs.existsSync(path.join(dir, "ios", "AosTokens.swift")));
  assert.ok(
    first.files.some((file) => file.relativePath.endsWith("color.text.text_label.colorset/Contents.json"))
  );
  const second = writeStackTokenFile(dir, write, {});
  assert.equal(second.action, "unchanged");
  assert.ok(second.files.every((file) => file.action === "unchanged"));
});

test("scanHardcodedColors: finds #hex and 0xAARRGGBB, skips generated/token files", () => {
  const dir = makeTempDir("aos-colors-");
  fs.mkdirSync(path.join(dir, "lib", "theme"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "lib", "theme", "aos_tokens.dart"),
    "// AUTO-GENERATED by aos-mcp from .artemis/design/tokens.json — do not edit.\nconst c = Color(0xFF123456);\n"
  );
  fs.writeFileSync(
    path.join(dir, "lib", "main.dart"),
    "const a = Color(0xFF123456);\nconst b = '#abc';\nfinal ok = scheme.primary;\n"
  );

  const hits = scanHardcodedColors(dir, { excludeGlobs: ["lib/theme/aos_tokens.dart"] });
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line}:${hit.value}`),
    ["lib/main.dart:1:#123456FF", "lib/main.dart:2:#AABBCCFF"]
  );
});
