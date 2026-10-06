import { PNG } from "pngjs";

interface Point {
  x: number;
  y: number;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function markerPoints(action: string, params: Record<string, unknown>): Point[] {
  if (action === "tap") {
    const x = numeric(params.x);
    const y = numeric(params.y);
    return x !== null && y !== null ? [{ x, y }] : [];
  }
  if (action === "swipe") {
    const x1 = numeric(params.x1);
    const y1 = numeric(params.y1);
    const x2 = numeric(params.x2);
    const y2 = numeric(params.y2);
    return x1 !== null && y1 !== null && x2 !== null && y2 !== null
      ? [
          { x: x1, y: y1 },
          { x: x2, y: y2 }
        ]
      : [];
  }
  if (action === "text") {
    const x = numeric(params.x);
    const y = numeric(params.y);
    return x !== null && y !== null ? [{ x, y }] : [];
  }
  return [];
}

function drawRing(png: PNG, cx: number, cy: number, radius: number): void {
  const inner = Math.max(1, radius - Math.max(2, Math.round(radius / 6)));
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius || dist < inner) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const index = (png.width * y + x) << 2;
      png.data[index] = 255;
      png.data[index + 1] = 0;
      png.data[index + 2] = 0;
      png.data[index + 3] = 255;
    }
  }
}

export function renderActionOverlay(
  bytes: Buffer,
  action: string,
  params: Record<string, unknown>,
  scale: number | null
): Buffer | null {
  if (scale === null || !Number.isFinite(scale) || scale <= 0) return null;
  const points = markerPoints(action, params);
  if (points.length === 0) return null;
  let png: PNG;
  try {
    png = PNG.sync.read(bytes);
  } catch {
    return null;
  }
  const radius = Math.max(8, Math.round(16 * scale));
  for (const point of points) {
    drawRing(png, Math.round(point.x * scale), Math.round(point.y * scale), radius);
  }
  return PNG.sync.write(png);
}
