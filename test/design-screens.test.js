import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  figmaScreensDir,
  importScreenFile,
  isPngBuffer,
  penScreensDir,
  relativeScreenPath,
  sanitizeScreenId,
  SCREENSHOT_MAPPING_MISSING,
  SCREENSHOT_RENDER_UNAVAILABLE,
  SCREENSHOT_SKIPPED,
  screenFileName,
  screensEnabledFrom,
  screensRoot,
  sha256Hex,
  storeScreenPng
} from "../dist/design/screens.js";
import { RETENTION_CATEGORIES } from "../dist/figma/retention.js";
import { makeTempDir } from "./helpers.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(payload) {
  return Buffer.concat([PNG_MAGIC, Buffer.from(payload, "utf-8")]);
}

test("sanitizeScreenId: 转义、边界与回退", () => {
  assert.equal(sanitizeScreenId("1:2"), "1-2");
  assert.equal(sanitizeScreenId("a/b?c"), "a-b-c");
  assert.equal(sanitizeScreenId("weird..id_1"), "weird..id_1");
  assert.equal(sanitizeScreenId("--x--"), "x");
  assert.equal(sanitizeScreenId("  "), "screen");
  assert.equal(sanitizeScreenId("中文名"), "screen");
  assert.equal(screenFileName("12:345"), "12-345.png");
});

test("isPngBuffer: 魔术头校验", () => {
  assert.equal(isPngBuffer(png("x")), true);
  assert.equal(isPngBuffer(PNG_MAGIC), true);
  assert.equal(isPngBuffer(Buffer.from([0xff, 0xd8, 0xff])), false);
  assert.equal(isPngBuffer(Buffer.from([0x89, 0x50])), false);
  assert.equal(isPngBuffer(Buffer.alloc(0)), false);
});

test("storeScreenPng: 写入 → 幂等跳过 → 变更覆盖 → 损坏替换 → 非法不落盘", () => {
  const dir = makeTempDir("aos-screens-");
  const target = path.join(dir, "figma-abc");

  const first = storeScreenPng(target, "1:2", png("one"));
  assert.equal(first.status, "written");
  assert.equal(first.path, path.join(target, "1-2.png"));
  assert.equal(first.sha256, sha256Hex(png("one")));
  assert.equal(fs.readFileSync(first.path, "utf-8"), png("one").toString("utf-8"));

  const again = storeScreenPng(target, "1:2", png("one"));
  assert.equal(again.status, "skipped");

  const changed = storeScreenPng(target, "1:2", png("two"));
  assert.equal(changed.status, "written");
  assert.equal(changed.sha256, sha256Hex(png("two")));
  assert.equal(fs.readFileSync(first.path, "utf-8"), png("two").toString("utf-8"));

  fs.writeFileSync(first.path, "half-written garbage", "utf-8");
  const repaired = storeScreenPng(target, "1:2", png("three"));
  assert.equal(repaired.status, "written");
  assert.equal(isPngBuffer(fs.readFileSync(first.path)), true);

  const beforeInvalid = fs.readFileSync(first.path);
  const invalid = storeScreenPng(target, "1:2", Buffer.from("not a png"));
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.sha256, null);
  assert.deepEqual(fs.readFileSync(first.path), beforeInvalid, "非法 buffer 不动既有文件");

  const listing = fs.readdirSync(target);
  assert.deepEqual(listing, ["1-2.png"], "不留临时文件");
});

test("importScreenFile: 校验后入库、临时文件清理、幂等", () => {
  const dir = makeTempDir("aos-screens-import-");
  const tempDir = path.join(dir, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const target = path.join(dir, "pen-demo");

  const tempFile = path.join(tempDir, "1-2.png");
  fs.writeFileSync(tempFile, png("sheet"));
  const imported = importScreenFile(tempFile, target, "1:2");
  assert.equal(imported.status, "written");
  assert.equal(fs.existsSync(tempFile), false, "临时文件已清理");
  assert.equal(isPngBuffer(fs.readFileSync(imported.path)), true);

  const tempFile2 = path.join(tempDir, "again.png");
  fs.writeFileSync(tempFile2, png("sheet"));
  const skipped = importScreenFile(tempFile2, target, "1:2");
  assert.equal(skipped.status, "skipped");
  assert.equal(fs.existsSync(tempFile2), false);

  const tempFile3 = path.join(tempDir, "broken.png");
  fs.writeFileSync(tempFile3, "broken", "utf-8");
  const invalid = importScreenFile(tempFile3, target, "3:4");
  assert.equal(invalid.status, "invalid");
  assert.equal(fs.existsSync(path.join(target, "3-4.png")), false);
  assert.equal(fs.existsSync(tempFile3), false);

  const missing = importScreenFile(path.join(tempDir, "nope.png"), target, "5:6");
  assert.equal(missing.status, "invalid");
});

test("目录与相对路径助手: figma/pen 分目录、md 引用 POSIX 分隔", () => {
  const configDir = makeTempDir("aos-screens-cfg-");
  assert.equal(figmaScreensDir(configDir, "AbC123"), path.join(screensRoot(configDir), "figma-AbC123"));
  assert.equal(penScreensDir(configDir, "/x/我的设计.pen"), path.join(screensRoot(configDir), "pen-screen"));
  assert.equal(penScreensDir(configDir, "/x/my-design.pen"), path.join(screensRoot(configDir), "pen-my-design"));

  const designDirAbs = path.join(configDir, "design");
  const file = path.join(designDirAbs, "screens", "figma-AbC123", "1-2.png");
  assert.equal(relativeScreenPath(designDirAbs, file), "screens/figma-AbC123/1-2.png");
});

test("screensEnabledFrom: arg 优先、AOS_SCREENS=0 关闭", () => {
  assert.equal(screensEnabledFrom({}), true);
  assert.equal(screensEnabledFrom({ AOS_SCREENS: "0" }), false);
  assert.equal(screensEnabledFrom({ AOS_SCREENS: "1" }), true);
  assert.equal(screensEnabledFrom({}, false), false);
  assert.equal(screensEnabledFrom({ AOS_SCREENS: "0" }, true), true, "显式 screens:true 覆盖 env");
});

test("warning 词汇与 retention 分类", () => {
  assert.equal(SCREENSHOT_SKIPPED, "screenshot-skipped");
  assert.equal(SCREENSHOT_RENDER_UNAVAILABLE, "screenshot-render-unavailable");
  assert.equal(SCREENSHOT_MAPPING_MISSING, "screenshot-mapping-missing");
  const screens = RETENTION_CATEGORIES.find((category) => category.id === "screens");
  assert.deepEqual(screens?.segments, [".artemis", "design", "screens"]);
});
