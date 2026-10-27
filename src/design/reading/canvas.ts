import type { CanvasLayout, ReadingBBox } from "./types.js";

export interface CanvasScreen {
  order: number;
  bounds?: ReadingBBox | null;
}

function validBounds(bounds: ReadingBBox | null | undefined): bounds is ReadingBBox {
  return (
    bounds !== null &&
    bounds !== undefined &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every((value) => Number.isFinite(value))
  );
}

/** 设计画板的排布方向；网格布局不应当把画板顺序当交互链。 */
export function detectCanvasLayout(screens: CanvasScreen[]): CanvasLayout {
  const ordered = screens
    .filter((screen) => validBounds(screen.bounds))
    .sort((left, right) => left.order - right.order);
  if (ordered.length < 2) return "unknown";

  let horizontal = 0;
  let vertical = 0;
  let mixed = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.bounds!;
    const current = ordered[index]!.bounds!;
    const dx = Math.abs(current.x - previous.x);
    const dy = Math.abs(current.y - previous.y);
    if (dx < 1 && dy < 1) continue;
    if (dx >= dy * 1.5) horizontal += 1;
    else if (dy >= dx * 1.5) vertical += 1;
    else mixed += 1;
  }
  if (mixed > 0 || (horizontal > 0 && vertical > 0)) return "grid";
  if (horizontal > 0) return "horizontal";
  if (vertical > 0) return "vertical";
  return "unknown";
}
