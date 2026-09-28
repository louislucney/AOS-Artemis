import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAssetHashIndex,
  decideAssetWrite,
  planImports,
  safeRelativePath,
  sha256Buffer,
  writeAssetFile
} from "../dist/figma/import.js";
import { STACK_PROFILES } from "../dist/projects/stack.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aos-import-"));
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
