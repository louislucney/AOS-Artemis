export interface VisionElement {
  text: string;
  boundsPx: [number, number, number, number];
}

export interface ParsedVisionResponse {
  elements: VisionElement[];
  dropped: number;
}

const CODE_FENCE = /```(?:json)?/gi;
const DEFAULT_MAX_LINES = 30;

export function buildPerceptionPrompt(widthPx: number, heightPx: number): string {
  return [
    "你是 iOS 屏幕视觉解析器。截图尺寸为 " + `${widthPx}x${heightPx} px。`,
    "请找出截图中所有可见的文字与图标按钮，输出 JSON 数组（不要 markdown 代码块，不要多余文字）：",
    '[{"text":"元素文字或图标含义","bounds_px":[left,top,right,bottom]}]',
    "规则：",
    "1. bounds_px 使用截图像素坐标（无需换算，执行器会处理）。",
    "2. 只输出确实可见、可与背景区分的元素；不确定的不要输出。",
    "3. 图标无文字时，用简短中文描述其功能（如「返回」「搜索」「更多」）。",
    "4. 最多 30 个元素，按重要性排序。只输出 JSON 数组。"
  ].join("\n");
}

export function parseVisionElements(raw: string): ParsedVisionResponse | null {
  const text = raw.replace(CODE_FENCE, " ").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const elements: VisionElement[] = [];
  let dropped = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as { text?: unknown; bounds_px?: unknown };
    const label = typeof record.text === "string" ? record.text.trim() : "";
    const bounds = record.bounds_px;
    const valid =
      label !== "" &&
      Array.isArray(bounds) &&
      bounds.length === 4 &&
      bounds.every((value) => typeof value === "number" && Number.isFinite(value));
    if (!valid) {
      dropped += 1;
      continue;
    }
    elements.push({
      text: label,
      boundsPx: [bounds[0], bounds[1], bounds[2], bounds[3]] as [number, number, number, number]
    });
  }
  return { elements, dropped };
}

export interface FuseVisionOptions {
  elements: VisionElement[];
  scale: number | null;
  width: number;
  height: number;
  existing: Array<{ label: string; value: string }>;
  maxLines?: number;
}

export interface FusedVision {
  lines: string[];
  droppedInvalid: number;
  droppedNoScale: number;
  droppedDuplicate: number;
  droppedOverflow: number;
}

function normalize(text: string): string {
  return text.trim();
}

function duplicateOfExisting(text: string, existing: Array<{ label: string; value: string }>): boolean {
  for (const node of existing) {
    for (const candidate of [node.label, node.value]) {
      const normalized = normalize(candidate);
      if (!normalized) continue;
      if (normalized === text || normalized.includes(text) || text.includes(normalized)) return true;
    }
  }
  return false;
}

/** Convert the perception model's pixel-space boxes into accessibility-style
 * lines (logical points, deterministic center) so the text-only decision model
 * never has to do geometry. */
export function fuseVisionElements(options: FuseVisionOptions): FusedVision {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const result: FusedVision = {
    lines: [],
    droppedInvalid: 0,
    droppedNoScale: 0,
    droppedDuplicate: 0,
    droppedOverflow: 0
  };
  if (options.scale === null) {
    result.droppedNoScale = options.elements.length;
    return result;
  }
  const seen = new Set<string>();
  for (const element of options.elements) {
    const text = normalize(element.text);
    if (!text || seen.has(text)) {
      result.droppedDuplicate += 1;
      continue;
    }
    if (duplicateOfExisting(text, options.existing)) {
      result.droppedDuplicate += 1;
      continue;
    }
    const [pxLeft, pxTop, pxRight, pxBottom] = element.boundsPx;
    let left = Math.round(pxLeft / options.scale);
    let top = Math.round(pxTop / options.scale);
    let right = Math.round(pxRight / options.scale);
    let bottom = Math.round(pxBottom / options.scale);
    if (right < left) [left, right] = [right, left];
    if (bottom < top) [top, bottom] = [bottom, top];
    const invalid =
      right <= left ||
      bottom <= top ||
      right < 0 ||
      bottom < 0 ||
      left > options.width + 1 ||
      top > options.height + 1;
    if (invalid) {
      result.droppedInvalid += 1;
      continue;
    }
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(options.width, right);
    bottom = Math.min(options.height, bottom);
    if (result.lines.length >= maxLines) {
      result.droppedOverflow += 1;
      continue;
    }
    seen.add(text);
    const centerX = Math.round((left + right) / 2);
    const centerY = Math.round((top + bottom) / 2);
    const index = result.lines.length + 1;
    result.lines.push(
      `[V${index}] (模型视觉，可能有误) OCR Text: '${text}' | Center: (${centerX},${centerY}) | Bounds: [${left},${top}][${right},${bottom}]`
    );
  }
  return result;
}
