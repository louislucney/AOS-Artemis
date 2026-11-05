import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareReference, lastIosScreenshot } from "../dist/web/llm/reference.js";
import { createImage, fillRect, toPng } from "./helpers.js";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-l2-reference-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("compareReference：同图 passed，明显差异 failed，证据缺失不伪造", async (t) => {
  const dir = await tempDir(t);
  const white = createImage(120, 240, [255, 255, 255, 255]);
  const reference = path.join(dir, "reference.png");
  const same = path.join(dir, "same.png");
  const changed = path.join(dir, "changed.png");
  const dark = createImage(120, 240, [20, 20, 20, 255]);
  fillRect(dark, 20, 80, 80, 80, [0, 0, 0, 255]);
  await writeFile(reference, toPng(white));
  await writeFile(same, toPng(white));
  await writeFile(changed, toPng(dark));

  assert.equal(
    compareReference({ referencePath: reference, screenshotPath: same }).status,
    "passed"
  );
  const failed = compareReference({ referencePath: reference, screenshotPath: changed });
  assert.equal(failed.status, "failed");
  assert.ok((failed.regions ?? 0) > 0);

  assert.equal(compareReference({ referencePath: null, screenshotPath: same }).status, "missing");
  assert.equal(
    compareReference({ referencePath: reference, screenshotPath: null }).status,
    "unverified"
  );
});

test("lastIosScreenshot：优先 postShot，其次 shot", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, "shots"), { recursive: true });
  await writeFile(path.join(dir, "shots", "step-1.png"), toPng(createImage(10, 10)));
  await writeFile(path.join(dir, "shots", "step-1-post.png"), toPng(createImage(10, 10)));
  await writeFile(
    path.join(dir, "run.json"),
    JSON.stringify({ steps: [{ shot: "shots/step-1.png", postShot: "shots/step-1-post.png" }] })
  );
  assert.equal(lastIosScreenshot(dir), path.join(dir, "shots", "step-1-post.png"));
});
