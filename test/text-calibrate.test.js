import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runTextWeightCalibration } from "../dist/ui/text-calibrate.js";
import { createImage, fillRect, makeTempDir, toPng } from "./helpers.js";

function bars({ stroke = 1, shift = 0, width = 120, height = 40 } = {}) {
  const image = createImage(width, height);
  for (let index = 0; index < 6; index += 1) {
    fillRect(image, 10 + index * 18 + shift, 8, stroke, 24, [0, 0, 0, 255]);
  }
  return toPng(image);
}

test("text weight calibration: confusion, unverified, deltas and threshold hint", async () => {
  const dir = makeTempDir("aos-text-calibrate-");
  const write = (name, buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    return name;
  };
  const regular = write("regular.png", bars({ stroke: 1 }));
  const bold = write("bold.png", bars({ stroke: 3 }));
  const shifted = write("shifted.png", bars({ stroke: 3, shift: 40 }));
  const manifest = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      pairs: [
        { name: "regular-bold", design: regular, device: bold, expected: "heavier" },
        { name: "regular-regular", design: regular, device: regular, expected: "similar" },
        { name: "shifted-content", design: regular, device: shifted, expected: "similar" }
      ]
    })
  );
  const report = await runTextWeightCalibration({ manifestPath: manifest, save: false });
  assert.equal(report.total, 3);
  assert.equal(report.labeled, 3);
  assert.equal(report.checked, 2);
  assert.equal(report.unverified, 1);
  assert.equal(report.unverifiedByReason["content-or-wrap-mismatch"], 1);
  assert.equal(report.confusion.heavier.heavier, 1);
  assert.equal(report.confusion.similar.similar, 1);
  assert.equal(report.confusion.similar.unverified, 1);
  assert.equal(report.highConfidenceMismatches.length, 0);
  assert.equal(report.highConfidenceFalseHeavier, 0);
  assert.equal(report.deltaStats.find((entry) => entry.expected === "heavier")?.count, 1);
  assert.equal(report.thresholdHint.separated, true);
  assert.ok(report.thresholdHint.suggestedHeavierDelta !== null);
  assert.equal(report.ok, true);

  const strict = await runTextWeightCalibration({
    manifestPath: manifest,
    save: false,
    strict: true
  });
  assert.equal(strict.ok, false, "strict 把 unverified 视为失败");

  const savedReport = await runTextWeightCalibration({
    manifestPath: manifest,
    outputDir: dir,
    now: () => new Date("2026-10-26T00:00:00Z")
  });
  assert.ok(savedReport.saved);
  assert.ok(fs.existsSync(savedReport.saved));
  assert.equal(JSON.parse(fs.readFileSync(savedReport.saved, "utf-8")).total, 3);
});

test("text weight calibration: high-confidence false heavier fails", async () => {
  const dir = makeTempDir("aos-text-calibrate-fp-");
  const regular = path.join(dir, "regular.png");
  const bold = path.join(dir, "bold.png");
  fs.writeFileSync(regular, bars({ stroke: 1 }));
  fs.writeFileSync(bold, bars({ stroke: 3 }));
  const manifest = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      pairs: [{ name: "expected-similar", design: regular, device: bold, expected: "similar" }]
    })
  );
  const report = await runTextWeightCalibration({ manifestPath: manifest, save: false });
  assert.equal(report.highConfidenceMismatches.length, 1);
  assert.equal(report.highConfidenceFalseHeavier, 1);
  assert.equal(report.ok, false);
});
