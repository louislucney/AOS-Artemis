import type { Bbox, RgbaImage } from "./engine.js";

export interface RegionShift {
  /** 设计坐标像素；正数表示实际内容相对设计向右/向下偏移。 */
  dx: number;
  dy: number;
  /** 位移后 SAD 改善比例；越高越可信。 */
  gain: number;
}

export interface GlobalShift {
  axis: "x" | "y";
  /** 同向偏移的中位值（设计坐标像素）。 */
  delta: number;
  regionCount: number;
  bbox: Bbox;
}

export interface EstimateShiftOptions {
  /** 搜索半径（工作图像像素），默认 32。 */
  range?: number;
  /** 小于该位移视为 0，默认 4。 */
  minShift?: number;
  /** 低于该改善比例视为不可信，默认 0.55。 */
  minGain?: number;
}

function luminance(image: RgbaImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4;
  return 0.299 * image.data[index]! + 0.587 * image.data[index + 1]! + 0.114 * image.data[index + 2]!;
}

function sad(
  design: RgbaImage,
  device: RgbaImage,
  box: Bbox,
  dx: number,
  dy: number
): number {
  const height = Math.min(design.height, device.height);
  let sum = 0;
  let count = 0;
  for (let y = box.y; y < Math.min(box.y + box.height, height); y += 2) {
    const yb = y + dy;
    if (yb < 0 || yb >= height) continue;
    for (let x = box.x; x < Math.min(box.x + box.width, design.width); x += 2) {
      const xb = x + dx;
      if (xb < 0 || xb >= device.width) continue;
      sum += Math.abs(luminance(design, x, y) - luminance(device, xb, yb));
      count += 1;
    }
  }
  return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
}

/**
 * 在 ±range 内用 SAD 寻找让区域最匹配的位移。与 SmartEye 的 bestShift 同思路：
 * 先搜 dy，再在最佳 dy 上搜 dx；撞到搜索边界视为重复纹理误匹配，gain=0。
 * 返回工作图像坐标；调用方按自己的缩放因子换算。
 */
export function estimateRegionShift(
  design: RgbaImage,
  device: RgbaImage,
  box: Bbox,
  options: EstimateShiftOptions = {}
): (RegionShift & { atEdge: boolean }) | null {
  if (box.width < 4 || box.height < 4) return null;
  const range = Math.max(2, Math.trunc(options.range ?? 32));
  const minShift = Math.max(0, options.minShift ?? 4);
  const minGain = options.minGain ?? 0.55;
  const base = sad(design, device, box, 0, 0);
  if (!Number.isFinite(base)) return null;
  if (base === 0) return null;

  let best = { dx: 0, dy: 0, err: base };
  for (let dy = -range; dy <= range; dy += 2) {
    const err = sad(design, device, box, 0, dy);
    if (err < best.err) best = { dx: 0, dy, err };
  }
  for (let dx = -range; dx <= range; dx += 2) {
    const err = sad(design, device, box, dx, best.dy);
    if (err < best.err) best = { dx, dy: best.dy, err };
  }
  const atEdge = Math.abs(best.dx) >= range - 2 || Math.abs(best.dy) >= range - 2;
  const gain = atEdge ? 0 : 1 - best.err / base;
  if (!Number.isFinite(gain) || gain < minGain) return null;
  if (Math.abs(best.dx) < minShift && Math.abs(best.dy) < minShift) return null;
  const dx = Math.abs(best.dx) < minShift ? 0 : best.dx;
  const dy = Math.abs(best.dy) < minShift ? 0 : best.dy;
  if (dx === 0 && dy === 0) return null;
  return { dx, dy, gain, atEdge };
}

/**
 * 把同向、幅度接近（±2px）的位移合并为整块偏移。只报告 ≥3 个区域的分组，
 * 避免把独立控件的微小位移误报成整页问题。
 */
export function groupRegionShifts(
  regions: Array<{ bbox: Bbox; shift?: RegionShift }>,
  options: { minRegions?: number; tolerance?: number } = {}
): GlobalShift[] {
  const minRegions = Math.max(2, options.minRegions ?? 3);
  const tolerance = Math.max(0, options.tolerance ?? 2);
  const out: GlobalShift[] = [];
  for (const axis of ["x", "y"] as const) {
    const entries = regions
      .filter((region) => region.shift !== undefined)
      .map((region) => ({
        bbox: region.bbox,
        delta: region.shift![axis === "x" ? "dx" : "dy"]
      }))
      .filter((entry) => entry.delta !== 0)
      .sort((left, right) => left.delta - right.delta);
    let cluster: typeof entries = [];
    const flush = (): void => {
      if (cluster.length < minRegions) return;
      const sorted = cluster.map((entry) => entry.delta).sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const delta =
        sorted.length % 2 === 1
          ? sorted[middle]!
          : (sorted[middle - 1]! + sorted[middle]!) / 2;
      const x0 = Math.min(...cluster.map((entry) => entry.bbox.x));
      const y0 = Math.min(...cluster.map((entry) => entry.bbox.y));
      const x1 = Math.max(...cluster.map((entry) => entry.bbox.x + entry.bbox.width));
      const y1 = Math.max(...cluster.map((entry) => entry.bbox.y + entry.bbox.height));
      out.push({
        axis,
        delta,
        regionCount: cluster.length,
        bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      });
    };
    for (const entry of entries) {
      if (cluster.length > 0 && Math.abs(entry.delta - cluster[0]!.delta) > tolerance) {
        flush();
        cluster = [];
      }
      cluster.push(entry);
    }
    flush();
  }
  return out.sort((left, right) => right.regionCount - left.regionCount || Math.abs(right.delta) - Math.abs(left.delta));
}
