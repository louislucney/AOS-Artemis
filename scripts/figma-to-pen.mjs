#!/usr/bin/env node
/**
 * Figma REST → .pen（pen.dev 开放格式）原型转换器。
 *
 *   node scripts/figma-to-pen.mjs --url "<figma-url>" [--node <id>] [--out <file.pen>] [--no-images]
 *
 * Token 来源：环境变量 FIGMA_ACCESS_TOKEN 或仓库根 .env。
 * 响应缓存到 .artemis/cache/（限流重试时避免重复打 API）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const flag = (name) => argv.includes(name);

const url = arg("--url") ?? argv.find((a) => a?.startsWith("http"));
if (!url) {
  console.error('用法: node scripts/figma-to-pen.mjs --url "<figma-url>" [--node <id>] [--out <file.pen>] [--no-images]');
  process.exit(3);
}

const outPath = path.resolve(arg("--out") ?? path.join(repoRoot, ".artemis", "design", "figma-export.pen"));
const assetsDir = path.join(path.dirname(outPath), `${path.basename(outPath, ".pen")}-assets`);
const assetsBase = path.basename(assetsDir);
const noImages = flag("--no-images");
const maxNodes = Number(arg("--max-nodes", "50000"));
const onlyNode = arg("--node");

const loadEnv = () => {
  const files = [path.join(repoRoot, ".env"), path.join(process.cwd(), ".env")];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
};
loadEnv();

const token = process.env.FIGMA_ACCESS_TOKEN;
if (!token) {
  console.error("缺少 FIGMA_ACCESS_TOKEN（项目 .env 或环境变量）");
  process.exit(2);
}

const keyMatch = /figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/.exec(url);
if (!keyMatch) {
  console.error("无法从 URL 解析 Figma file key");
  process.exit(3);
}
const fileKey = keyMatch[1];
const urlNode = /node-id=([0-9]+)[-:]([0-9]+)/.exec(url);
const targetNode = onlyNode ?? (urlNode ? `${urlNode[1]}:${urlNode[2]}` : null);

const cacheDir = path.join(repoRoot, ".artemis", "cache");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const apiJson = async (requestUrl, cacheName) => {
  const cacheFile = path.join(cacheDir, cacheName);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(requestUrl, { headers: { "X-Figma-Token": token } });
    const text = await res.text();
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 60);
      const tier = res.headers.get("x-figma-rate-limit-type") ?? "unknown";
      if (retryAfter > 900) {
        throw new Error(
          `Figma 限流（配额档位=${tier}，第 ${attempt} 次）：retry-after=${retryAfter}s（约 ${(retryAfter / 3600).toFixed(1)} 小时），不再等待。请更换 token/席位或稍后重试。`
        );
      }
      console.error(`Figma 限流（配额档位=${tier}，第 ${attempt} 次），等待 ${retryAfter}s…`);
      await sleep((retryAfter + 5) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Figma API ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, text);
    return json;
  }
  throw new Error("Figma 限流三次未恢复，请稍后重试");
};

console.log("拉取文件元数据…");
const meta = await apiJson(`https://api.figma.com/v1/files/${fileKey}?depth=1`, `meta-${fileKey}.json`);
const styles = meta.styles ?? {};

let pages;
if (targetNode) {
  console.log(`拉取节点 ${targetNode}（含 geometry）…`);
  const cacheName = `node-${fileKey}-${targetNode.replace(/[^0-9]/g, "-")}.json`;
  const nodeData = await apiJson(
    `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(targetNode)}&geometry=paths`,
    cacheName
  );
  const entry = nodeData.nodes?.[targetNode];
  if (!entry) throw new Error(`节点 ${targetNode} 不存在（检查 node-id）`);
  pages = entry.document.type === "CANVAS" ? [entry.document] : [{ type: "CANVAS", id: `virtual-${Date.now()}`, children: [entry.document] }];
} else {
  console.log("拉取整文件（含 geometry）…");
  const full = await apiJson(`https://api.figma.com/v1/files/${fileKey}?geometry=paths`, `full-${fileKey}.json`);
  pages = (full.document.children ?? []).filter((c) => c.type === "CANVAS");
}

let imagesMap = {};
if (!noImages) {
  try {
    const imgData = await apiJson(`https://api.figma.com/v1/files/${fileKey}/images`, `images-${fileKey}.json`);
    imagesMap = imgData.meta?.images ?? {};
  } catch (error) {
    console.error(`图片清单获取失败（将以占位色替代）：${error.message}`);
  }
}

const warnings = { skippedTypes: {}, lossy: {}, imagePlaceholders: 0 };
const warn = (bucket, k) => {
  warnings[bucket][k] = (warnings[bucket][k] ?? 0) + 1;
};

const idMap = new Map();
const usedIds = new Set();
const penId = (figmaId) => {
  if (idMap.has(figmaId)) return idMap.get(figmaId);
  const base = `n${String(figmaId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
  let candidate = base;
  let i = 2;
  while (usedIds.has(candidate)) candidate = `${base}-${i++}`;
  idMap.set(figmaId, candidate);
  usedIds.add(candidate);
  return candidate;
};

const preassign = (node) => {
  if (node.id) penId(node.id);
  for (const c of node.children ?? []) preassign(c);
};
for (const canvas of pages) for (const child of canvas.children ?? []) preassign(child);

const n = (v, digits = 2) => {
  const x = Math.round(Number(v) * 10 ** digits) / 10 ** digits;
  return Object.is(x, -0) ? 0 : x;
};

const toHex = (c) => {
  const h = (x) => Math.round(Math.max(0, Math.min(1, Number(x) ?? 0)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const a = Number(c.a ?? 1);
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.999 ? h(a) : ""}`;
};

const sanitizeVarName = (name) =>
  name
    .replace(/\//g, ".")
    .replace(/\s+/g, "_")
    .replace(/[:$]/g, "")
    .replace(/[^\w.\-]/g, "")
    .replace(/^\.+/, "");

const variables = {};
const varNameByStyle = new Map();
const varForStyle = (styleId, colorHex) => {
  const style = styles[styleId];
  if (!style) return null;
  if (!varNameByStyle.has(styleId)) {
    let name = sanitizeVarName(style.name);
    if (!name) return null;
    let i = 2;
    while (variables[name] && variables[name].value !== colorHex) name = `${sanitizeVarName(style.name)}_${i++}`;
    varNameByStyle.set(styleId, name);
    if (!variables[name]) variables[name] = { type: "color", value: colorHex };
  }
  return varNameByStyle.get(styleId);
};

const pendingImages = new Map();
const paintFill = (paint, node) => {
  if (!paint || paint.visible === false) return null;
  if (paint.type === "SOLID") {
    const hex = toHex({ ...paint.color, a: Number(paint.color?.a ?? 1) * Number(paint.opacity ?? 1) });
    if (node?.styles?.fill && paint === node.fills?.[0]) {
      const name = varForStyle(node.styles.fill, hex);
      if (name) return `$${name}`;
    }
    if (node?.styles?.strokes && paint === node.strokes?.[0]) {
      const name = varForStyle(node.styles.strokes, hex);
      if (name) return `$${name}`;
    }
    return hex;
  }
  if (paint.type?.startsWith("GRADIENT_")) {
    const typeMap = { GRADIENT_LINEAR: "linear", GRADIENT_RADIAL: "radial", GRADIENT_ANGULAR: "angular" };
    const gradientType = typeMap[paint.type];
    if (!gradientType) {
      warn("lossy", paint.type);
      return null;
    }
    const handles = paint.gradientHandlePositions;
    let rotation;
    if (handles?.[0] && handles?.[1]) {
      const dx = handles[1].x - handles[0].x;
      const dy = handles[1].y - handles[0].y;
      rotation = n((Math.atan2(-dx, -dy) * 180) / Math.PI, 1);
    }
    const colors = (paint.gradientStops ?? []).map((s) => ({
      color: toHex({ ...s.color, a: Number(s.color?.a ?? 1) * Number(paint.opacity ?? 1) }),
      position: n(s.position, 3)
    }));
    return { type: "gradient", gradientType, ...(rotation ? { rotation } : {}), colors };
  }
  if (paint.type === "IMAGE") {
    if (!paint.imageRef || noImages || !imagesMap[paint.imageRef]) {
      warnings.imagePlaceholders++;
      return "#D9D9D9";
    }
    const modeMap = { FILL: "fill", FIT: "fit", CROP: "fill", TILE: "fill" };
    if (paint.scaleMode && (paint.scaleMode === "CROP" || paint.scaleMode === "TILE")) warn("lossy", `image:${paint.scaleMode}`);
    const assetFile = `${String(paint.imageRef).replace(/[^A-Za-z0-9_-]/g, "_")}.png`;
    const fillObj = { type: "image", url: `./${assetsBase}/${assetFile}`, mode: modeMap[paint.scaleMode] ?? "fill" };
    if (!pendingImages.has(paint.imageRef)) {
      pendingImages.set(paint.imageRef, { url: imagesMap[paint.imageRef], file: path.join(assetsDir, assetFile), fillObjs: [] });
    }
    pendingImages.get(paint.imageRef).fillObjs.push(fillObj);
    return fillObj;
  }
  warn("lossy", paint.type);
  return null;
};

const fillsOf = (node) => {
  const list = (node.fills ?? []).map((p) => paintFill(p, node)).filter(Boolean);
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list;
};

const strokeOf = (node) => {
  const paints = (node.strokes ?? []).map((p) => paintFill(p, node)).filter(Boolean);
  if (!paints.length) return {};
  const out = {};
  out.stroke = paints.length === 1 ? paints[0] : paints;
  const top = node.strokeTopWeight;
  const right = node.strokeRightWeight;
  const bottom = node.strokeBottomWeight;
  const left = node.strokeLeftWeight;
  if ([top, right, bottom, left].every((v) => typeof v === "number") && new Set([top, right, bottom, left]).size > 1) {
    out.strokeWidth = { top: n(top), right: n(right), bottom: n(bottom), left: n(left) };
  } else if (typeof node.strokeWeight === "number" && node.strokeWeight > 0) {
    out.strokeWidth = n(node.strokeWeight);
  }
  const alignMap = { INSIDE: "inner", OUTSIDE: "outer", CENTER: "center" };
  if (node.strokeAlign && alignMap[node.strokeAlign]) out.strokeAlignment = alignMap[node.strokeAlign];
  const capMap = { ROUND: "round", SQUARE: "square", BUTT: "butt" };
  if (node.strokeCap && capMap[node.strokeCap]) out.strokeLinecap = capMap[node.strokeCap];
  const joinMap = { ROUND: "round", BEVEL: "bevel", MITER: "miter" };
  if (node.strokeJoin && joinMap[node.strokeJoin]) out.strokeLinejoin = joinMap[node.strokeJoin];
  if (node.dashPattern?.length) warn("lossy", "dashPattern");
  return out;
};

const effectOf = (node) => {
  const list = (node.effects ?? [])
    .filter((e) => e.visible !== false)
    .map((e) => {
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        return {
          type: "shadow",
          shadowType: e.type === "DROP_SHADOW" ? "outer" : "inner",
          offset: { x: n(e.offset?.x ?? 0), y: n(e.offset?.y ?? 0) },
          blur: n(e.radius ?? 0),
          color: toHex(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 })
        };
      }
      if (e.type === "LAYER_BLUR") return { type: "blur", radius: n(e.radius ?? 0) };
      if (e.type === "BACKGROUND_BLUR") return { type: "background_blur", radius: n(e.radius ?? 0) };
      warn("lossy", `effect:${e.type}`);
      return null;
    })
    .filter(Boolean);
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list;
};

const blendMap = {
  NORMAL: "normal",
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "linearBurn",
  COLOR_BURN: "colorBurn",
  LIGHTEN: "light",
  SCREEN: "screen",
  LINEAR_DODGE: "linearDodge",
  COLOR_DODGE: "colorDodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "softLight",
  HARD_LIGHT: "hardLight",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity"
};
const blendOf = (node) => {
  if (!node.blendMode || node.blendMode === "PASS_THROUGH") return undefined;
  const mapped = blendMap[node.blendMode];
  if (!mapped) warn("lossy", `blend:${node.blendMode}`);
  return mapped;
};

const baseOf = (node) => {
  const out = { id: penId(node.id), name: node.name || undefined };
  if (node.visible === false) out.enabled = false;
  if (typeof node.opacity === "number" && node.opacity < 1) out.opacity = n(node.opacity, 3);
  const blend = blendOf(node);
  if (blend && blend !== "normal") out.blendMode = blend;
  if (node.rotation) warn("lossy", "rotation");
  return out;
};

const absOf = (node) => node.absoluteBoundingBox ?? node.absoluteRenderBounds ?? null;
const posOf = (node, parentAbs, parentFlex) => {
  if (parentFlex && node.layoutPositioning !== "ABSOLUTE") return {};
  const abs = absOf(node);
  const out = {};
  if (abs && parentAbs) {
    out.x = n(abs.x - parentAbs.x);
    out.y = n(abs.y - parentAbs.y);
  } else {
    const t = node.relativeTransform;
    out.x = n(t?.[0]?.[2] ?? node.x ?? 0);
    out.y = n(t?.[1]?.[2] ?? node.y ?? 0);
  }
  if (parentFlex && node.layoutPositioning === "ABSOLUTE") out.layoutPosition = "absolute";
  return out;
};

const JUSTIFY = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space_between" };
const ALIGN = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "start" };

const frameLayoutOf = (node) => {
  if (!node.layoutMode || node.layoutMode === "NONE") return { layout: "none" };
  const out = { layout: node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical" };
  if (node.layoutWrap === "WRAP") warn("lossy", "layoutWrap");
  if (node.itemSpacing) out.gap = n(node.itemSpacing);
  const padding = [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0];
  if (padding.some((v) => v)) out.padding = padding.map((v) => n(v));
  const justify = JUSTIFY[node.primaryAxisAlignItems];
  if (justify && justify !== "start") out.justifyContent = justify;
  const align = ALIGN[node.counterAxisAlignItems];
  if (align && align !== "start") out.alignItems = align;
  return out;
};

const sizeOf = (node, parentFlex, parentLayoutMode) => {
  const out = {};
  const box = absOf(node);
  const w = box ? n(box.width) : null;
  const h = box ? n(box.height) : null;
  const map = (sizing, value) => (sizing === "HUG" ? "fit_content" : sizing === "FILL" ? "fill_container" : value);
  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.width = map(node.layoutSizingHorizontal, w ?? "fit_content");
    out.height = map(node.layoutSizingVertical, h ?? "fit_content");
  } else {
    if (w !== null) out.width = w;
    if (h !== null) out.height = h;
  }
  if (parentFlex) {
    const mainAxis = parentLayoutMode === "HORIZONTAL" ? "width" : "height";
    const crossAxis = parentLayoutMode === "HORIZONTAL" ? "height" : "width";
    if (node.layoutGrow === 1) out[mainAxis] = "fill_container";
    if (node.layoutAlign === "STRETCH") out[crossAxis] = "fill_container";
  }
  return out;
};

const textOf = (node) => {
  const style = node.style ?? {};
  const out = {};
  const textGrowth =
    node.textAutoResize === "WIDTH_AND_HEIGHT"
      ? "auto"
      : node.textAutoResize === "HEIGHT"
        ? "fixed-width"
        : node.textAutoResize
          ? "fixed-width-height"
          : null;
  if (textGrowth) out.textGrowth = textGrowth;
  if (style.fontFamily || style.fontPostScriptName) out.fontFamily = style.fontFamily ?? style.fontPostScriptName;
  if (style.fontSize) out.fontSize = n(style.fontSize);
  if (style.fontWeight) out.fontWeight = String(style.fontWeight);
  let lineHeight = null;
  if (style.lineHeightUnit === "PERCENT" && style.lineHeightPercentFontSize) lineHeight = style.lineHeightPercentFontSize / 100;
  else if (style.lineHeightPx && style.fontSize) lineHeight = style.lineHeightPx / style.fontSize;
  if (lineHeight) out.lineHeight = n(lineHeight, 3);
  if (style.letterSpacing) out.letterSpacing = n(style.letterSpacing, 2);
  if (style.textAlignHorizontal) out.textAlign = style.textAlignHorizontal.toLowerCase();
  if (style.textAlignVertical) out.textAlignVertical = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" }[style.textAlignVertical];
  if (style.textDecoration === "UNDERLINE") out.underline = true;
  if (style.textDecoration === "STRIKETHROUGH") out.strikethrough = true;
  if (style.italic) out.fontStyle = "italic";
  const box = absOf(node);
  if (box && textGrowth === "fixed-width") out.width = n(box.width);
  if (box && textGrowth === "fixed-width-height") {
    out.width = n(box.width);
    out.height = n(box.height);
  }
  return out;
};

const pathOf = (node) => {
  const geo = node.fillGeometry?.[0] ?? node.strokeGeometry?.[0];
  if (!geo?.path) {
    warn("lossy", `no-geometry:${node.type}`);
    return null;
  }
  const box = absOf(node);
  const out = { geometry: geo.path, viewBox: [0, 0, box ? n(box.width) : 100, box ? n(box.height) : 100] };
  if (geo.fillRule === "evenodd") out.fillRule = "evenodd";
  return out;
};

let convertedCount = 0;
const convert = (node, ctx) => {
  const { parentAbs = null, parentFlex = false, parentLayoutMode = null } = ctx ?? {};
  if (convertedCount >= maxNodes) throw new Error(`节点数超过上限 ${maxNodes}（--max-nodes 可调整）`);
  const base = baseOf(node);
  const common = {
    ...base,
    ...posOf(node, parentAbs, parentFlex),
    ...fillsOf(node),
    ...strokeOf(node)
  };
  const effect = effectOf(node);
  if (effect) common.effect = effect;
  const abs = absOf(node) ?? parentAbs;
  const selfFlex = Boolean(node.layoutMode && node.layoutMode !== "NONE");
  const kids = () =>
    (node.children ?? [])
      .map((c) => convert(c, { parentAbs: abs, parentFlex: selfFlex, parentLayoutMode: node.layoutMode }))
      .filter(Boolean);
  const type = node.type;
  let result = null;
  if (type === "FRAME" || type === "SECTION" || type === "COMPONENT" || type === "COMPONENT_SET") {
    const children = kids();
    result = {
      ...common,
      type: "frame",
      ...frameLayoutOf(node),
      ...sizeOf(node, parentFlex, parentLayoutMode),
      ...(node.clipsContent ? { clip: true } : {}),
      ...(type === "COMPONENT" ? { reusable: true } : {}),
      ...(children.length ? { children } : {})
    };
    if (type === "COMPONENT_SET") for (const child of result.children ?? []) if (child.type === "frame") child.reusable = true;
  } else if (type === "INSTANCE") {
    const insideScope = Boolean(node.componentId && idMap.has(node.componentId));
    if (insideScope) {
      result = { ...common, type: "ref", ref: penId(node.componentId) };
      if (node.overrides?.length) warn("lossy", "instance-overrides");
    } else {
      const children = (node.children ?? [])
        .map((c) => convert(c, { parentAbs: abs, parentFlex: false, parentLayoutMode: null }))
        .filter(Boolean);
      result = {
        ...common,
        type: "frame",
        layout: "none",
        ...sizeOf(node, parentFlex, parentLayoutMode),
        ...(node.clipsContent ? { clip: true } : {}),
        ...(children.length ? { children } : {})
      };
      warn("lossy", "instance-flattened");
    }
  } else if (type === "GROUP") {
    const children = (node.children ?? [])
      .map((c) => convert(c, { parentAbs: abs, parentFlex: false, parentLayoutMode: null }))
      .filter(Boolean);
    result = { ...common, type: "group", ...(children.length ? { children } : {}) };
  } else if (type === "RECTANGLE") {
    const corner = node.rectangleCornerRadii?.some((v) => v)
      ? node.rectangleCornerRadii.map((v) => n(v))
      : node.cornerRadius
        ? n(node.cornerRadius)
        : undefined;
    result = { ...common, type: "rectangle", ...sizeOf(node, parentFlex, parentLayoutMode), ...(corner !== undefined ? { cornerRadius: corner } : {}) };
  } else if (type === "ELLIPSE") {
    result = { ...common, type: "ellipse", ...sizeOf(node, parentFlex, parentLayoutMode) };
    if (node.arcData?.innerRadius) result.innerRadius = n(node.arcData.innerRadius, 3);
    if (node.arcData && (node.arcData.startingAngle || node.arcData.endingAngle)) warn("lossy", "arc");
  } else if (type === "REGULAR_POLYGON") {
    result = { ...common, type: "polygon", polygonCount: node.pointCount ?? 3, ...sizeOf(node, parentFlex, parentLayoutMode) };
  } else if (type === "VECTOR" || type === "LINE" || type === "STAR" || type === "BOOLEAN_OPERATION") {
    const p = pathOf(node);
    if (!p) return null;
    result = { ...common, type: "path", ...p, ...sizeOf(node, parentFlex, parentLayoutMode) };
  } else if (type === "TEXT") {
    result = { ...common, type: "text", content: node.characters ?? "", ...textOf(node) };
  } else {
    warn("skippedTypes", type);
    return null;
  }
  convertedCount++;
  return result;
};

const pageBounds = (canvas) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const child of canvas.children ?? []) {
    const b = absOf(child);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0 };
  return { minX, minY, maxX };
};

const document = { version: "2.19", children: [] };
let cursorX = 0;
for (const canvas of pages) {
  const bounds = pageBounds(canvas);
  const dx = cursorX - bounds.minX;
  const dy = -bounds.minY;
  for (const child of canvas.children ?? []) {
    const converted = convert(child, {});
    if (!converted) continue;
    if (typeof converted.x === "number") converted.x = n(converted.x + dx);
    if (typeof converted.y === "number") converted.y = n(converted.y + dy);
    document.children.push(converted);
  }
  cursorX += Math.max(bounds.maxX - bounds.minX, 0) + 400;
}
if (Object.keys(variables).length) document.variables = variables;

const collectRefs = (node, ids, refs) => {
  if (node.id) ids.add(node.id);
  if (node.type === "ref" && node.ref) refs.push(node.ref);
  for (const c of node.children ?? []) collectRefs(c, ids, refs);
};
const ids = new Set();
const refs = [];
for (const c of document.children) collectRefs(c, ids, refs);
const missing = [...new Set(refs.filter((r) => !ids.has(r)))];
if (missing.length) throw new Error(`存在悬空 ref: ${missing.slice(0, 5).join(", ")}`);

if (pendingImages.size) {
  await fsp.mkdir(assetsDir, { recursive: true });
  let downloaded = 0;
  for (const [, pending] of pendingImages) {
    try {
      const res = await fetch(pending.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fsp.writeFile(pending.file, Buffer.from(await res.arrayBuffer()));
      downloaded++;
    } catch (error) {
      for (const fillObj of pending.fillObjs) {
        fillObj.type = "color";
        fillObj.color = "#D9D9D9";
        delete fillObj.url;
        delete fillObj.mode;
      }
      warn("lossy", "image-download-failed");
      console.error(`图片下载失败（占位替代）：${error.message}`);
    }
  }
  console.log(`图片：${downloaded}/${pendingImages.size} 下载到 ${path.relative(repoRoot, assetsDir)}`);
}

await fsp.mkdir(path.dirname(outPath), { recursive: true });
await fsp.writeFile(outPath, JSON.stringify(document, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      outPath: path.relative(repoRoot, outPath),
      nodes: convertedCount,
      topLevel: document.children.length,
      variables: Object.keys(variables).length,
      images: pendingImages.size,
      warnings
    },
    null,
    2
  )
);
console.log(`提示：在 pen.dev 桌面/IDE 中打开 ${path.relative(repoRoot, outPath)} 检查效果（首次用需免费注册账号）。`);
