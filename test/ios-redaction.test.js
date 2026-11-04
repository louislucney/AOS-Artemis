import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PNG } from "pngjs";

import {
  loadIosSecrets,
  maskIosScreenshot,
  redactIosNodes,
  redactIosShot
} from "../dist/ios/redaction.js";

function makePng(width = 4, height = 4) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 255;
    image.data[index + 1] = 255;
    image.data[index + 2] = 255;
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image);
}

function pixelAt(bytes, width, x, y) {
  const image = PNG.sync.read(bytes);
  const index = (width * y + x) << 2;
  return [...image.data.subarray(index, index + 4)];
}

const secrets = [{ alias: "PASSWORD", value: "hunter2", kind: "password" }];

test("redactIosNodes：文本/值/id 脱敏，坐标不变", () => {
  const nodes = [
    {
      type: "TextField",
      label: "密码 hunter2",
      value: "hunter2",
      id: "field-hunter2",
      rect: { x: 1, y: 2, width: 30, height: 10 }
    }
  ];
  const result = redactIosNodes(nodes, secrets);
  assert.equal(result.sensitive, true);
  assert.equal(result.missingBounds, false);
  assert.equal(result.nodes[0].label, "密码 <secret:PASSWORD>");
  assert.equal(result.nodes[0].value, "<secret:PASSWORD>");
  assert.deepEqual(result.nodes[0].rect, { x: 1, y: 2, width: 30, height: 10 });
});

test("maskIosScreenshot：敏感节点 bbox 涂黑，其余像素保留", () => {
  const nodes = [
    {
      type: "StaticText",
      label: "hunter2",
      value: "",
      id: "",
      rect: { x: 1, y: 1, width: 2, height: 2 }
    }
  ];
  const masked = maskIosScreenshot(makePng(), nodes, secrets);
  assert.equal(masked.sensitive, true);
  assert.ok(masked.bytes);
  assert.deepEqual(pixelAt(masked.bytes, 4, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(masked.bytes, 4, 0, 0), [255, 255, 255, 255]);
});

test("maskIosScreenshot：按截图/逻辑点 scale 换算（3x 屏）", () => {
  const nodes = [
    {
      type: "StaticText",
      label: "hunter2",
      value: "",
      id: "",
      rect: { x: 1, y: 1, width: 1, height: 1 }
    }
  ];
  const masked = maskIosScreenshot(makePng(8, 8), nodes, secrets, 3);
  assert.ok(masked.bytes);
  assert.deepEqual(pixelAt(masked.bytes, 8, 3, 3), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(masked.bytes, 8, 1, 1), [255, 255, 255, 255]);
});

test("maskIosScreenshot：敏感节点无 bbox → null（不得发原图）", () => {
  const nodes = [
    {
      type: "StaticText",
      label: "hunter2",
      value: "",
      id: "",
      rect: { x: 0, y: 0, width: 0, height: 0 }
    }
  ];
  const masked = maskIosScreenshot(makePng(), nodes, secrets);
  assert.equal(masked.sensitive, true);
  assert.equal(masked.missingBounds, true);
  assert.equal(masked.bytes, null);
});

test("redactIosShot：strict 删除不可遮罩证据，非 strict 保留但不给模型", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-ios-redaction-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "shots"), { recursive: true });
  const file = path.join(dir, "shots", "step-1.png");
  const shot = { rel: "shots/step-1.png", bytes: makePng() };
  const nodes = [
    {
      type: "StaticText",
      label: "hunter2",
      value: "",
      id: "",
      rect: { x: 0, y: 0, width: 0, height: 0 }
    }
  ];

  await writeFile(file, shot.bytes);
  const strict = redactIosShot({
    runDir: dir,
    shot,
    nodes,
    config: { secrets, strict: true }
  });
  assert.equal(strict.shot, null);
  assert.equal(strict.promptBytes, null);
  assert.equal(existsSync(file), false);

  await writeFile(file, shot.bytes);
  const lenient = redactIosShot({
    runDir: dir,
    shot,
    nodes,
    config: { secrets, strict: false }
  });
  assert.equal(lenient.shot?.rel, "shots/step-1.png");
  assert.equal(lenient.promptBytes, null);
  assert.equal(existsSync(file), true);
});

test("redactIosShot：可遮罩时覆盖证据文件", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-ios-redaction-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "shots"), { recursive: true });
  const file = path.join(dir, "shots", "step-1.png");
  const shot = { rel: "shots/step-1.png", bytes: makePng() };
  await writeFile(file, shot.bytes);
  const out = redactIosShot({
    runDir: dir,
    shot,
    nodes: [
      {
        type: "StaticText",
        label: "hunter2",
        value: "",
        id: "",
        rect: { x: 0, y: 0, width: 2, height: 2 }
      }
    ],
    config: { secrets, strict: true }
  });
  assert.ok(out.shot);
  assert.ok(out.promptBytes);
  assert.deepEqual(pixelAt(await readFile(file), 4, 0, 0), [0, 0, 0, 255]);
});

test("loadIosSecrets：读取 worker 写入的 alias→value 映射", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-ios-secrets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".artemis", "web"), { recursive: true });
  await writeFile(
    path.join(dir, ".artemis", "web", "llm-secrets.json"),
    JSON.stringify({ ACCOUNT: "user@example.com", PASSWORD: "hunter2" })
  );
  const loaded = loadIosSecrets(dir);
  assert.equal(loaded.length, 2);
  assert.equal(loaded.find((entry) => entry.alias === "PASSWORD")?.value, "hunter2");
});
