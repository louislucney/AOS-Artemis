import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { splitPenScreens } from "../dist/pen/split.js";
import { makeTempDir } from "./helpers.js";

function writeSource(dir) {
  const source = path.join(dir, "design.pen");
  fs.writeFileSync(
    source,
    JSON.stringify({
      version: "2.20",
      fileToken: "token-1",
      themes: { light: [] },
      children: [
        {
          type: "frame",
          id: "board",
          name: "Board",
          children: [
            {
              type: "frame",
              id: "s1",
              name: "Screen 1",
              x: 120,
              y: 240,
              width: 375,
              height: 812,
              children: [
                {
                  type: "text",
                  id: "t1",
                  name: "Title",
                  x: 16,
                  y: 20,
                  width: 100,
                  height: 24,
                  content: "早安"
                }
              ]
            }
          ]
        }
      ]
    }),
    "utf-8"
  );
  return source;
}

test("pen split: 逐屏 .pen 保留文档级字段并把屏移到原点", () => {
  const dir = makeTempDir("aos-pen-split-");
  const source = writeSource(dir);
  const outDir = path.join(dir, "pen", "screens");

  const result = splitPenScreens({ sourceFile: source, screenIds: ["s1", "missing"], outDir });
  assert.deepEqual(result.written, ["s1"]);
  assert.deepEqual(result.skipped.map((entry) => entry.id), ["missing"]);

  const doc = JSON.parse(fs.readFileSync(path.join(outDir, "s1.pen"), "utf-8"));
  assert.equal(doc.version, "2.20");
  assert.equal(doc.fileToken, "token-1");
  assert.deepEqual(doc.themes, { light: [] });
  assert.equal(doc.children.length, 1);
  assert.equal(doc.children[0].id, "s1");
  assert.equal(doc.children[0].x, 0);
  assert.equal(doc.children[0].y, 0);
  assert.equal(doc.children[0].children[0].content, "早安");
});

test("pen split: 幂等——内容未变不重写", () => {
  const dir = makeTempDir("aos-pen-split-idem-");
  const source = writeSource(dir);
  const outDir = path.join(dir, "pen", "screens");

  splitPenScreens({ sourceFile: source, screenIds: ["s1"], outDir });
  const before = fs.statSync(path.join(outDir, "s1.pen")).mtimeMs;
  const second = splitPenScreens({ sourceFile: source, screenIds: ["s1"], outDir });
  assert.deepEqual(second.written, []);
  assert.equal(second.unchanged, 1);
  assert.equal(fs.statSync(path.join(outDir, "s1.pen")).mtimeMs, before);
});

test("pen split: 源文件损坏时抛错，不写半成品", () => {
  const dir = makeTempDir("aos-pen-split-bad-");
  const source = path.join(dir, "design.pen");
  fs.writeFileSync(source, "{ not json", "utf-8");
  const outDir = path.join(dir, "pen", "screens");
  assert.throws(() => splitPenScreens({ sourceFile: source, screenIds: ["s1"], outDir }));
  assert.equal(fs.existsSync(path.join(outDir, "s1.pen")), false);
});

test("pen split: 多屏画板选第一块手机宽屏，避免整板拼图当基线", () => {
  const dir = makeTempDir("aos-pen-split-board-");
  const source = path.join(dir, "design.pen");
  fs.writeFileSync(
    source,
    JSON.stringify({
      version: "2.20",
      children: [
        {
          type: "frame",
          id: "board2",
          name: "選擇門市",
          children: [
            { type: "frame", id: "sA", name: "Screen A", x: 50, y: 116, width: 375, height: 812, children: [{ type: "text", id: "a1", x: 16, y: 20, width: 40, height: 20, content: "A" }] },
            { type: "frame", id: "sB", name: "Screen B", x: 525, y: 116, width: 375, height: 812, children: [{ type: "text", id: "b1", x: 16, y: 20, width: 40, height: 20, content: "B" }] }
          ]
        }
      ]
    }),
    "utf-8"
  );
  const outDir = path.join(dir, "pen", "screens");
  const result = splitPenScreens({ sourceFile: source, screenIds: ["board2"], outDir });
  assert.deepEqual(result.written, ["board2"]);
  const doc = JSON.parse(fs.readFileSync(path.join(outDir, "board2.pen"), "utf-8"));
  assert.equal(doc.children.length, 1);
  assert.equal(doc.children[0].id, "sA");
  assert.equal(doc.children[0].x, 0);
  assert.equal(doc.children[0].y, 0);
});

test("pen split: compositeIds 强制把宽高正常的变体容器拆成第一屏", () => {
  const dir = makeTempDir("aos-pen-split-variants-");
  const source = path.join(dir, "design.pen");
  fs.writeFileSync(
    source,
    JSON.stringify({
      version: "2.20",
      children: [
        {
          type: "frame",
          id: "popupBoard",
          name: "變體容器",
          children: [
            {
              type: "frame",
              id: "v1",
              name: "Variant 1",
              x: 50,
              y: 50,
              width: 375,
              height: 812,
              children: [{ type: "text", id: "v1t", x: 16, y: 20, width: 40, height: 20, content: "V1" }]
            },
            {
              type: "frame",
              id: "v2",
              name: "Variant 2",
              x: 525,
              y: 50,
              width: 375,
              height: 812,
              children: [{ type: "text", id: "v2t", x: 16, y: 20, width: 40, height: 20, content: "V2" }]
            }
          ]
        }
      ]
    }),
    "utf-8"
  );
  const outDir = path.join(dir, "pen", "screens");
  splitPenScreens({
    sourceFile: source,
    screenIds: ["popupBoard"],
    outDir,
    compositeIds: ["popupBoard"]
  });
  const doc = JSON.parse(fs.readFileSync(path.join(outDir, "popupBoard.pen"), "utf-8"));
  assert.equal(doc.children[0].id, "v1");
});
