import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareReference,
  referenceDiffOptions
} from "../dist/web/llm/reference.js";
import { runReferenceCalibration } from "../dist/web/reference-calibrate.js";
import { createImage, fillRect, toPng } from "./helpers.js";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-reference-calibrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function whiteImage() {
  return createImage(120, 240, [255, 255, 255, 255]);
}

function changedImage() {
  const image = createImage(120, 240, [255, 255, 255, 255]);
  fillRect(image, 20, 60, 80, 100, [0, 0, 0, 255]);
  return image;
}

test("reference calibration：同图/差异图 → 推荐阈值零漏报零误报", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "same.png"), toPng(whiteImage()));
  await writeFile(path.join(dir, "changed.png"), toPng(changedImage()));
  const manifest = path.join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      pairs: [
        { name: "clean", reference: "same.png", device: "same.png", expected: "passed" },
        { name: "changed", reference: "same.png", device: "changed.png", expected: "failed" }
      ]
    })
  );

  const report = await runReferenceCalibration({ manifestPath: manifest, save: false });
  assert.equal(report.ok, true);
  assert.equal(report.total, 2);
  assert.equal(report.checked, 2);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.expected, { passed: 1, failed: 1 });
  assert.ok(report.current !== null);
  assert.ok(report.best !== null);
  assert.equal(report.best.missed, 0);
  assert.equal(report.best.falseAlarm, 0);
  assert.equal(report.best.balancedAccuracy, 1);
  assert.equal(report.thresholds[0].pixelThreshold, report.best.pixelThreshold);
  assert.ok(report.recommendedEnv?.AOS_L2_PIXEL_THRESHOLD);
  assert.ok(report.recommendedEnv?.AOS_L2_MIN_AREA_RATIO);
  assert.ok(report.recommendedEnv?.AOS_L2_SYSTEM_BAND_RATIO);

  const strict = await runReferenceCalibration({
    manifestPath: manifest,
    save: false,
    strict: true
  });
  assert.equal(strict.ok, true);
});

test("reference calibration：不可区分的 failed 样本被标为漏报（strict 失败）", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "same.png"), toPng(whiteImage()));
  const manifest = path.join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      pairs: [
        { name: "clean", reference: "same.png", device: "same.png", expected: "passed" },
        { name: "impossible", reference: "same.png", device: "same.png", expected: "failed" }
      ]
    })
  );
  const normal = await runReferenceCalibration({ manifestPath: manifest, save: false });
  assert.equal(normal.ok, true);
  assert.ok(normal.best !== null);
  assert.equal(normal.best.missed, 1);

  const strict = await runReferenceCalibration({
    manifestPath: manifest,
    save: false,
    strict: true
  });
  assert.equal(strict.ok, false);
});

test("reference calibration：坏图/非法 expected 跳过并报告错误", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "same.png"), toPng(whiteImage()));
  const manifest = path.join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      pairs: [
        { reference: "same.png", device: "same.png", expected: "passed" },
        { reference: "missing.png", device: "same.png", expected: "failed" },
        { reference: "same.png", device: "same.png", expected: "maybe" }
      ]
    })
  );
  const report = await runReferenceCalibration({ manifestPath: manifest, save: false });
  assert.equal(report.total, 3);
  assert.equal(report.checked, 1);
  assert.equal(report.skipped, 2);
  assert.equal(report.best, null);
  assert.equal(report.recommendedEnv, null);
  assert.ok(report.errors.some((entry) => entry.includes("不可读")));
  assert.ok(report.errors.some((entry) => entry.includes("expected")));

  const missing = await runReferenceCalibration({
    manifestPath: path.join(dir, "nope.json"),
    save: false
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.checked, 0);
  assert.ok(missing.errors.length > 0);
});

test("referenceDiffOptions：项目级 env 覆盖与非法值回退", () => {
  assert.deepEqual(
    referenceDiffOptions({
      AOS_L2_PIXEL_THRESHOLD: "0.2",
      AOS_L2_MIN_AREA_RATIO: "0.004",
      AOS_L2_SYSTEM_BAND_RATIO: "0.03"
    }),
    {
      pixelThreshold: 0.2,
      minAreaRatio: 0.004,
      maxEdge: 1440,
      systemBandRatio: 0.03
    }
  );
  assert.deepEqual(referenceDiffOptions({ AOS_L2_PIXEL_THRESHOLD: "9" }), {
    pixelThreshold: 0.12,
    minAreaRatio: 0.01,
    maxEdge: 1440,
    systemBandRatio: 0.05
  });
});

test("compareReference：env 阈值参与判定但不升级状态", async (t) => {
  const dir = await tempDir(t);
  const reference = path.join(dir, "reference.png");
  const device = path.join(dir, "device.png");
  await writeFile(reference, toPng(whiteImage()));
  await writeFile(device, toPng(changedImage()));

  assert.equal(
    compareReference({ referencePath: reference, screenshotPath: device }).status,
    "failed"
  );
  assert.equal(
    compareReference({
      referencePath: reference,
      screenshotPath: device,
      env: { AOS_L2_MIN_AREA_RATIO: "1" }
    }).status,
    "passed"
  );
});
