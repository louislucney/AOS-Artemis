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
