import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { decodeImage, resize, encodePng } = await import(`${root}/dist/diff/engine.js`);

const src = process.argv[2] ?? `${root}/test/fixtures/diff-bench/device.jpg`;
const deviceBytes = fs.readFileSync(src);
const device = decodeImage(deviceBytes);
console.log("device", device.width, device.height);

const INSETS = { top: 96, bottom: 120 };
const cropped = { width: device.width, height: device.height - INSETS.top - INSETS.bottom, data: new Uint8Array(device.width * (device.height - INSETS.top - INSETS.bottom) * 4) };
for (let row = 0; row < cropped.height; row++) {
  const from = ((row + INSETS.top) * device.width) * 4;
  cropped.data.set(device.data.subarray(from, from + device.width * 4), row * device.width * 4);
}
const designWidth = 390;
const designHeight = Math.round(cropped.height * (designWidth / cropped.width));
const design = resize(cropped, designWidth, designHeight);
console.log("design", design.width, design.height);

function stats(img, x, y, size) {
  let min = 255, max = 0, sum = 0, n = 0;
  for (let yy = y; yy < y + size; yy++) for (let xx = x; xx < x + size; xx++) {
    const p = (yy * img.width + xx) * 4;
    const l = (img.data[p] * 0.299 + img.data[p+1] * 0.587 + img.data[p+2] * 0.114);
    min = Math.min(min, l); max = Math.max(max, l); sum += l; n++;
  }
  return { mean: sum / n, range: max - min };
}
const SIZE = 48;
function findWindow(predicate, taken, maxRange = 10) {
  for (let y = 40; y < design.height - 120; y += 6) {
    for (let x = 12; x < design.width - SIZE - 12; x += 6) {
      if (taken.some(t => Math.abs(t.x - x) < 100 && Math.abs(t.y - y) < 100)) continue;
      const s = stats(design, x, y, SIZE);
      if (s.range < maxRange && predicate(s.mean)) return { x, y };
    }
  }
  return null;
}
const taken = [];
const bright = findWindow(m => m >= 245, taken, 6); taken.push(bright);
function findDarkest(taken) {
  let best = null;
  for (let y = 40; y < design.height - 120; y += 4) {
    for (let x = 12; x < design.width - SIZE - 12; x += 4) {
      if (taken.some(t => Math.abs(t.x - x) < 100 && Math.abs(t.y - y) < 100)) continue;
      const s = stats(design, x, y, SIZE);
      if (s.mean <= 226 && (best === null || s.mean < best.mean)) best = { x, y, mean: s.mean };
    }
  }
  return best;
}
const dark = findDarkest(taken);
if (!bright || !dark) throw new Error(`window not found bright=${JSON.stringify(bright)} dark=${JSON.stringify(dark)}`);

function paint(img, x, y, size, color) {
  for (let yy = y; yy < y + size; yy++) for (let xx = x; xx < x + size; xx++) {
    img.data.set(color, (yy * img.width + xx) * 4);
  }
}
paint(design, bright.x, bright.y, SIZE, [30, 64, 175, 255]);
paint(design, dark.x, dark.y, SIZE, [220, 38, 38, 255]);

const outDir = `${root}/test/fixtures/diff-bench`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "device.jpg"), deviceBytes);
fs.writeFileSync(path.join(outDir, "design.png"), encodePng(design));
const truth = {
  source: `${path.relative(root, src)}（真实 Pixel 采集，2026-09-28 ARTEMIS 运行）`,
  note: "design = device JPEG 按 insets（top 96 / bottom 120）裁剪后双线性降采样到 390px 宽；两个低方差 48x48 窗口重绘（亮窗 #1E40AF、暗窗 #DC2626）作为已知差异；可用 scripts/make-diff-benchmark.mjs <device.jpg> 复现",
  insets: INSETS,
  design: { width: design.width, height: design.height },
  cases: [
    { id: "missing-block", bbox: { x: bright.x, y: bright.y, width: SIZE, height: SIZE }, expectedCategory: "missing", node: { id: "bench-bright", name: "Bench Bright", type: "rectangle", parentFill: "#FFFFFFFF" } },
    { id: "color-block", bbox: { x: dark.x, y: dark.y, width: SIZE, height: SIZE }, expectedCategory: "color", node: { id: "bench-dark", name: "Bench Dark", type: "rectangle", parentFill: "#FFFFFFFF" } }
  ]
};
fs.writeFileSync(path.join(outDir, "ground-truth.json"), JSON.stringify(truth, null, 2) + "\n");
console.log(JSON.stringify(truth, null, 2));
