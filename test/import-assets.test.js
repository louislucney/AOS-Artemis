import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildAssetHashIndex,
  decideAssetWrite,
  figmaImportAssets,
  planImports,
  safeRelativePath,
  sha256Buffer,
  writeAssetFile
} from "../dist/figma/import.js";
import { STACK_PROFILES } from "../dist/projects/stack.js";
import {
  baseConfig,
  loadTestRuntime,
  makeTempDir,
  makeTempProject,
  parseToolResult,
  StubProxy,
  withFigmaToken
} from "./helpers.js";

function tmp() {
  return makeTempDir("aos-import-");
}

test("safeRelativePath: sanitizes separators and blocks escapes", () => {
  assert.equal(safeRelativePath("assets", "home.svg"), "assets/home.svg");
  assert.equal(
    safeRelativePath("app/src/main/res/drawable", "ic_home.svg"),
    "app/src/main/res/drawable/ic_home.svg"
  );
  assert.equal(safeRelativePath("../outside", "x.svg"), null);
  assert.equal(safeRelativePath("assets/../../x", "y.svg"), null);
  assert.equal(safeRelativePath("C:\\evil", "x.svg"), null);
  // Only `..` path segments escape; dotted filenames are preserved.
  assert.equal(safeRelativePath("assets", "..hidden.svg"), "assets/..hidden.svg");
});

test("planImports: stack naming, suggested dirs, overrides and filtering", () => {
  const assets = [
    {
      name: "Home Icon",
      slug: "home-icon",
      suggestedFilename: "ic_home.svg",
      suggestedDir: "app/src/main/res/drawable",
      figmaId: "1:1"
    },
    { name: "Cart", figmaId: "1:2" },
    { name: "No id asset" }
  ];

  const android = planImports(assets, STACK_PROFILES["android-native"]);
  assert.equal(android.length, 2, "assets without figmaId are skipped");
  assert.equal(android[0].relativePath, "app/src/main/res/drawable/ic_home.svg");
  assert.equal(android[1].relativePath, "app/src/main/res/drawable/ic_cart.svg");

  const overridden = planImports(assets, STACK_PROFILES.flutter, { destDir: "custom/assets" });
  assert.ok(overridden.every((entry) => entry.relativePath.startsWith("custom/assets/")));
  assert.equal(overridden[1].relativePath, "custom/assets/cart.svg");
});

test("writeAssetFile: idempotent write semantics", () => {
  const root = tmp();

  const first = writeAssetFile(root, "assets/a.svg", "<svg/>", false);
  assert.equal(first.status, "written");

  const same = writeAssetFile(root, "assets/a.svg", "<svg/>", false);
  assert.equal(same.status, "unchanged");

  const different = writeAssetFile(root, "assets/a.svg", "<svg>2</svg>", false);
  assert.equal(different.status, "skipped_exists");
  assert.equal(fs.readFileSync(path.join(root, "assets/a.svg"), "utf-8"), "<svg/>");

  const forced = writeAssetFile(root, "assets/a.svg", "<svg>2</svg>", true);
  assert.equal(forced.status, "written");
  assert.equal(fs.readFileSync(path.join(root, "assets/a.svg"), "utf-8"), "<svg>2</svg>");

  const binary = writeAssetFile(root, "assets/b.png", Buffer.from([1, 2, 3]), false);
  assert.equal(binary.status, "written");
  assert.equal(binary.bytes, 3);
  assert.deepEqual([...fs.readFileSync(path.join(root, "assets/b.png"))], [1, 2, 3]);
});

test("content-hash uniqueness: index, cross-name duplicates, batch dedupe", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets/home.svg"), "<svg>home</svg>");
  fs.writeFileSync(path.join(root, "assets/cart.svg"), "<svg>cart</svg>");

  const index = buildAssetHashIndex(root, ["assets/home.svg", "assets/cart.svg"]);
  assert.equal(index.size, 2);
  assert.equal(index.get(sha256Buffer("<svg>home</svg>")), "assets/home.svg");

  const batch = new Map();

  // same content, different filename → duplicate of the existing project file
  const crossName = decideAssetWrite({
    rootDir: root,
    relativePath: "assets/icons/home.svg",
    content: Buffer.from("<svg>home</svg>"),
    projectHashes: index,
    batchHashes: batch,
    overwrite: false
  });
  assert.equal(crossName.status, "duplicate");
  assert.equal(crossName.duplicateOf, "assets/home.svg");

  // same path + same bytes → unchanged
  const samePath = decideAssetWrite({
    rootDir: root,
    relativePath: "assets/home.svg",
    content: Buffer.from("<svg>home</svg>"),
    projectHashes: index,
    batchHashes: batch,
    overwrite: false
  });
  assert.equal(samePath.status, "unchanged");

  // same path + different bytes → skipped_exists, or written with overwrite
  const conflict = decideAssetWrite({
    rootDir: root,
    relativePath: "assets/home.svg",
    content: Buffer.from("<svg>v2</svg>"),
    projectHashes: index,
    batchHashes: batch,
    overwrite: false
  });
  assert.equal(conflict.status, "skipped_exists");
  const forced = decideAssetWrite({
    rootDir: root,
    relativePath: "assets/home.svg",
    content: Buffer.from("<svg>v2</svg>"),
    projectHashes: index,
    batchHashes: batch,
    overwrite: true
  });
  assert.equal(forced.status, "written");

  // batch dedupe: identical content queued twice at different new paths
  const first = decideAssetWrite({
    rootDir: root,
    relativePath: "assets/a.svg",
    content: Buffer.from("<svg>a</svg>"),
    projectHashes: index,
    batchHashes: batch,
    overwrite: false
  });
  assert.equal(first.status, "written");
  batch.set(first.sha256, "assets/a.svg");
  const second = decideAssetWrite({
    rootDir: root,
    relativePath: "assets/b.svg",
    content: Buffer.from("<svg>a</svg>"),
    projectHashes: index,
    batchHashes: batch,
    overwrite: false
  });
  assert.equal(second.status, "duplicate");
  assert.equal(second.duplicateOf, "assets/a.svg");
});

test("planImports: raster density sets per stack; densities:false keeps @2x single", () => {
  const androidAsset = [
    {
      name: "Home Icon",
      suggestedFilename: "ic_home.png",
      suggestedDir: "app/src/main/res/drawable",
      figmaId: "1:1"
    }
  ];
  const android = planImports(androidAsset, STACK_PROFILES["android-native"], {
    format: "png",
    densities: true
  });
  assert.deepEqual(
    android.map((entry) => [entry.relativePath, entry.scale]),
    [
      ["app/src/main/res/drawable-xhdpi/ic_home.png", 2],
      ["app/src/main/res/drawable-xxhdpi/ic_home.png", 3]
    ]
  );

  const flutter = planImports([{ name: "Home Icon", figmaId: "1:2" }], STACK_PROFILES.flutter, {
    format: "png",
    densities: true
  });
  assert.deepEqual(
    flutter.map((entry) => entry.relativePath),
    ["assets/images/home_icon.png", "assets/images/2.0x/home_icon.png", "assets/images/3.0x/home_icon.png"]
  );

  const ios = planImports([{ name: "Home Icon", figmaId: "1:3" }], STACK_PROFILES["ios-native"], {
    format: "png",
    densities: true
  });
  assert.deepEqual(
    ios.map((entry) => [entry.relativePath, entry.role]),
    [
      ["Resources/Assets.xcassets/home_icon.imageset/home_icon.png", "image"],
      ["Resources/Assets.xcassets/home_icon.imageset/home_icon@2x.png", "image"],
      ["Resources/Assets.xcassets/home_icon.imageset/home_icon@3x.png", "image"],
      ["Resources/Assets.xcassets/home_icon.imageset/Contents.json", "contents"]
    ]
  );
  assert.deepEqual(ios[3].contentsFiles, [
    { filename: "home_icon.png", scale: 1 },
    { filename: "home_icon@2x.png", scale: 2 },
    { filename: "home_icon@3x.png", scale: 3 }
  ]);

  const rn = planImports([{ name: "Home Icon", figmaId: "1:4" }], STACK_PROFILES["react-native"], {
    format: "png",
    densities: true
  });
  assert.deepEqual(
    rn.map((entry) => entry.relativePath),
    ["src/assets/home-icon.png", "src/assets/home-icon@2x.png", "src/assets/home-icon@3x.png"]
  );

  const web = planImports([{ name: "Home Icon", figmaId: "1:5" }], STACK_PROFILES.web, {
    format: "png",
    densities: true
  });
  assert.deepEqual(web.map((entry) => [entry.relativePath, entry.scale]), [["public/assets/home-icon.png", 1]]);

  const legacy = planImports(androidAsset, STACK_PROFILES["android-native"], { format: "png" });
  assert.deepEqual(legacy.map((entry) => [entry.relativePath, entry.scale]), [
    ["app/src/main/res/drawable/ic_home.png", 2]
  ]);

  const svg = planImports(androidAsset, STACK_PROFILES["android-native"], {
    format: "svg",
    densities: true
  });
  assert.deepEqual(svg.map((entry) => entry.relativePath), ["app/src/main/res/drawable/ic_home.png"]);
});

function stubExportFetch(fileKey) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes(`/images/${fileKey}`)) {
      const scale = new URL(href).searchParams.get("scale") ?? "1";
      return new Response(
        JSON.stringify({ err: null, images: { "1:1": `https://render.example/1-1-s${scale}.png` } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (href.includes(`/files/${fileKey}/nodes`)) {
      return new Response(
        JSON.stringify({ nodes: { "1:1": { document: { id: "1:1", name: "Home Icon", type: "FRAME" } } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (href.startsWith("https://render.example/")) {
      const scale = /-s(\d+)\.png$/.exec(href)?.[1] ?? "1";
      return new Response(Buffer.from(`png-bytes-scale-${scale}`), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function writeGaps(runtime, fileKey) {
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "gaps.json"),
    JSON.stringify({
      sourceUrl: `https://www.figma.com/design/${fileKey}/Demo?node-id=1-1`,
      missingAssets: [
        {
          name: "Home Icon",
          suggestedFilename: "ic_home.png",
          suggestedDir: "app/src/main/res/drawable",
          figmaId: "1:1"
        }
      ]
    })
  );
}

test("figma_import_assets: png expands to Android density dirs and stays idempotent", async () => {
  await withFigmaToken(async () => {
    const fileKey = "DensityAndroid1";
    const dir = makeTempProject({ config: baseConfig() });
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "build.gradle"), "android {}\n");
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    writeGaps(runtime, fileKey);
    const restore = stubExportFetch(fileKey);
    try {
      const first = parseToolResult(await figmaImportAssets(runtime, { format: "png" }));
      assert.equal(first.ok, true);
      assert.equal(first.densities, true);
      assert.deepEqual(
        first.results.map((entry) => entry.relativePath),
        [
          "app/src/main/res/drawable-xhdpi/ic_home.png",
          "app/src/main/res/drawable-xxhdpi/ic_home.png"
        ]
      );
      const xhdpi = fs.readFileSync(path.join(dir, "app/src/main/res/drawable-xhdpi/ic_home.png"));
      const xxhdpi = fs.readFileSync(path.join(dir, "app/src/main/res/drawable-xxhdpi/ic_home.png"));
      assert.notDeepEqual(xhdpi, xxhdpi, "each density gets its own render");

      const second = parseToolResult(await figmaImportAssets(runtime, { format: "png" }));
      assert.ok(second.results.every((entry) => entry.status === "unchanged"));
    } finally {
      restore();
    }
  });
});

test("figma_import_assets: iOS writes imageset files plus Contents.json", async () => {
  await withFigmaToken(async () => {
    const fileKey = "DensityIos1";
    const dir = makeTempProject({ config: baseConfig() });
    fs.mkdirSync(path.join(dir, "ios", "Demo.xcodeproj"), { recursive: true });
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    const designDir = path.join(runtime.configDirAbs, "design");
    fs.mkdirSync(designDir, { recursive: true });
    fs.writeFileSync(
      path.join(designDir, "gaps.json"),
      JSON.stringify({
        sourceUrl: `https://www.figma.com/design/${fileKey}/Demo?node-id=1-1`,
        missingAssets: [{ name: "Home Icon", figmaId: "1:1" }]
      })
    );
    const restore = stubExportFetch(fileKey);
    try {
      const payload = parseToolResult(await figmaImportAssets(runtime, { format: "png" }));
      const base = "Resources/Assets.xcassets/home_icon.imageset";
      assert.deepEqual(payload.results.map((entry) => entry.relativePath), [
        `${base}/home_icon.png`,
        `${base}/home_icon@2x.png`,
        `${base}/home_icon@3x.png`,
        `${base}/Contents.json`
      ]);
      const contents = JSON.parse(fs.readFileSync(path.join(dir, base, "Contents.json"), "utf-8"));
      assert.deepEqual(contents.images, [
        { filename: "home_icon.png", idiom: "universal", scale: "1x" },
        { filename: "home_icon@2x.png", idiom: "universal", scale: "2x" },
        { filename: "home_icon@3x.png", idiom: "universal", scale: "3x" }
      ]);
      assert.deepEqual(contents.info, { author: "xcode", version: 1 });
    } finally {
      restore();
    }
  });
});
