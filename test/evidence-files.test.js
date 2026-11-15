import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectEvidenceScreenshots } from "../dist/figma/evidence-files.js";

test("evidence screenshots: 默认收集最近 N 张图片并规范命名", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-evidence-shots-"));
  try {
    fs.mkdirSync(path.join(dir, "shots"));
    fs.writeFileSync(path.join(dir, "shots", "a.png"), Buffer.from("a"));
    fs.writeFileSync(path.join(dir, "shots", "b.txt"), "not an image");
    fs.writeFileSync(path.join(dir, "shots", "c.jpg"), Buffer.from("c"));
    const shots = collectEvidenceScreenshots(dir, { AOS_RUNNER_EVIDENCE_MAX_SHOTS: "1" });
    assert.equal(shots.length, 1);
    assert.match(shots[0].name, /^evidence-shot-1\.(png|jpg)$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence screenshots: 关闭开关不收集；大文件跳过", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-evidence-shots-"));
  try {
    fs.mkdirSync(path.join(dir, "shots"));
    fs.writeFileSync(path.join(dir, "shots", "big.png"), Buffer.alloc(201 * 1024));
    const off = collectEvidenceScreenshots(dir, { AOS_RUNNER_EVIDENCE_SCREENSHOTS: "0" });
    assert.deepEqual(off, []);
    const enabled = collectEvidenceScreenshots(dir, { AOS_RUNNER_EVIDENCE_SCREENSHOTS: "1" });
    assert.deepEqual(enabled, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
