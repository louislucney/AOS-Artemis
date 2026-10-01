import { PNG } from "pngjs";

import type { Bbox, DiffRegion, RgbaImage, Severity } from "./engine.js";

const SEVERITY_COLORS: Record<Severity, [number, number, number, number]> = {
  blocker: [220, 38, 38, 255],
  major: [234, 88, 12, 255],
  minor: [202, 138, 4, 255],
  info: [2, 132, 199, 255]
};

const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"]
};

function paintPixel(image: RgbaImage, x: number, y: number, color: [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  image.data.set(color, (y * image.width + x) * 4);
}

function drawRect(image: RgbaImage, bbox: Bbox, color: [number, number, number, number], thickness = 2): void {
  const x0 = Math.max(0, bbox.x);
  const y0 = Math.max(0, bbox.y);
  const x1 = Math.min(image.width - 1, bbox.x + bbox.width - 1);
  const y1 = Math.min(image.height - 1, bbox.y + bbox.height - 1);
  for (let t = 0; t < thickness; t += 1) {
    for (let x = x0; x <= x1; x += 1) {
      paintPixel(image, x, y0 + t, color);
      paintPixel(image, x, y1 - t, color);
    }
    for (let y = y0; y <= y1; y += 1) {
      paintPixel(image, x0 + t, y, color);
      paintPixel(image, x1 - t, y, color);
    }
  }
}

function drawLabel(image: RgbaImage, x: number, y: number, text: string, color: [number, number, number, number]): void {
  const scale = 3;
  let cursor = x;
  for (const character of text) {
    const glyph = DIGITS[character];
    if (!glyph) {
      cursor += 4 * scale;
      continue;
    }
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row]!.length; col += 1) {
        if (glyph[row]![col] !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            paintPixel(image, cursor + col * scale + dx, y + row * scale + dy, color);
          }
        }
      }
    }
    cursor += 4 * scale;
  }
}

export function renderAnnotatedPng(design: RgbaImage, regions: DiffRegion[]): Buffer {
  const annotated: RgbaImage = { width: design.width, height: design.height, data: new Uint8Array(design.data) };
  regions.forEach((region, index) => {
    const color = SEVERITY_COLORS[region.severity] ?? SEVERITY_COLORS.major;
    drawRect(annotated, region.bbox, color);
    drawLabel(annotated, region.bbox.x + 4, region.bbox.y + 4, String(index + 1), color);
  });
  const png = new PNG({ width: annotated.width, height: annotated.height });
  png.data = Buffer.from(annotated.data);
  return PNG.sync.write(png);
}
