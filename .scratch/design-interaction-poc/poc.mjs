import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { parsePenText } from '../../dist/pen/read.js';
import { renderPenScreens } from '../../dist/pen/render.js';

const FILE = '/Users/louis/.pencil/documents/7789acea-67d5-42ed-bbda-8c0764c606b9/untitled.pen';
const OUT = path.resolve('.scratch/design-interaction-poc');
const doc = parsePenText(fs.readFileSync(FILE, 'utf-8'));

function allFrames() {
  const out = [];
  const walk = (node, parent = null, board = null) => {
    if (node && node.type === 'frame' && node.id) out.push({ node, parent, board });
    for (const child of node.children ?? []) walk(child, node, board ?? node.id);
  };
  for (const board of doc.children ?? []) walk(board, null, board.id);
  return out;
}
const all = allFrames();
const boardChildren = [];
for (const board of doc.children ?? []) {
  for (const child of board.children ?? []) {
    if (child && child.type === 'frame' && child.id) boardChildren.push({ node: child, board: board.id, parent: board.id });
  }
}
const targetIds = ['OFftq', 'pEfey', 'j6XA0', 'RVg6w'];
const targets = targetIds.map((id) => all.find((f) => f.node.id === id)).filter(Boolean);
const renderSet = new Map();
for (const f of [...boardChildren, ...targets]) renderSet.set(f.node.id, f);
const ids = [...renderSet.keys()];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-poc-'));
const t0 = Date.now();
const rendered = await renderPenScreens({ target: FILE, screenIds: ids, outDir: tmp, env: process.env });
const renderMs = Date.now() - t0;
const dims = new Map();
const gray = new Map();
for (const id of ids) {
  const file = rendered.files.get(id);
  if (!file) continue;
  const png = PNG.sync.read(fs.readFileSync(file));
  dims.set(id, { w: png.width, h: png.height });
  const g = new Float64Array(png.width * png.height);
  for (let i = 0; i < g.length; i++) {
    const j = i * 4;
    g[i] = 0.299 * png.data[j] + 0.587 * png.data[j + 1] + 0.114 * png.data[j + 2];
  }
  gray.set(id, { w: png.width, h: png.height, g });
}
function ncc(A, B, d) {
  const a = gray.get(A), b = gray.get(B);
  if (!a || !b) return null;
  let shift = d;
  let first = a, second = b;
  if (shift < 0) { first = b; second = a; shift = -shift; }
  const h = Math.min(second.h, first.h - shift);
  if (h <= 100) return null;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < Math.min(first.w, second.w); x += 2) {
      const va = first.g[(y + shift) * first.w + x];
      const vb = second.g[y * second.w + x];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
    }
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  return va <= 0 || vb <= 0 ? null : cov / Math.sqrt(va * vb);
}

function texts(node) {
  const out = [];
  const walk = (n, acc = 0) => {
    const y = typeof n.y === 'number' ? acc + n.y : acc;
    if (typeof n.content === 'string' && n.content.trim() !== '') out.push({ text: n.content.trim(), y });
    for (const c of n.children ?? []) walk(c, y);
  };
  walk(node, 0);
  return out;
}
const norm = (s) => s.normalize('NFKC').replace(/[\u3000\s]+/g, '').replace(/[，。！？、；：""''（）【】《》]/g, '').toLowerCase();
function textMap(node) {
  const map = new Map();
  for (const t of texts(node)) {
    const k = norm(t.text);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t.y);
  }
  return map;
}
function compareTexts(aNode, bNode) {
  const A = textMap(aNode), B = textMap(bNode);
  const matched = [];
  for (const [k, ys] of A) {
    const bs = B.get(k);
    if (bs && bs.length) matched.push({ k, ya: ys[0], yb: bs[0] });
  }
  const hist = new Map();
  for (const m of matched) { const d = Math.round(m.ya - m.yb); hist.set(d, (hist.get(d) ?? 0) + 1); }
  const [mode, count] = [...hist.entries()].sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
  const support = matched.length ? count / matched.length : 0;
  const inter = [...A.keys()].filter((k) => B.has(k)).length;
  const union = new Set([...A.keys(), ...B.keys()]).size;
  const contentDiff = union ? 1 - inter / union : 0;
  return { matched: matched.length, mode, support, contentDiff, A: A.size, B: B.size, inter, union };
}

const viewport = { w: 375, h: 855 };
const viewportAspect = viewport.w / viewport.h;
function frameClass(id) {
  const d = dims.get(id);
  if (!d) return 'component';
  const widthDiff = Math.abs(d.w - viewport.w) / viewport.w;
  const heightDiff = Math.abs(d.h - viewport.h) / viewport.h;
  const aspect = d.w / d.h;
  const aspectDiff = Math.abs(aspect - viewportAspect) / viewportAspect;
  if (d.w > viewport.w * 1.1 || d.h > viewport.h * 1.2) return 'overlay';
  if (aspect > viewportAspect * 1.05 || d.h > viewport.h * 1.1) return 'full-content';
  if (widthDiff <= 0.05 && (heightDiff <= 0.06 || aspectDiff <= 0.06)) return 'viewport-state';
  if (d.w < viewport.w * 0.9 && d.h < viewport.h * 0.9) return 'overlay';
  return 'component';
}
const boardClasses = boardChildren.map((f) => ({ id: f.node.id, name: f.node.name, ...dims.get(f.node.id), cls: frameClass(f.node.id) }));
const classCounts = {};
for (const f of boardClasses) classCounts[f.cls] = (classCounts[f.cls] ?? 0) + 1;

function target(id) { return renderSet.get(id)?.node ?? null; }
const mop = compareTexts(target('OFftq'), target('pEfey'));
const search = compareTexts(target('j6XA0'), target('RVg6w'));
const state1 = compareTexts(target('w8OHy'), target('CSMVD'));
const state2 = compareTexts(target('w8OHy'), target('uorYu'));

// App Bar takeover evidence: n6dGB App Bar text vs collapsed tabs in OFftq
const n6 = boardChildren.find((f) => f.node.id === 'n6dGB')?.node;
const n6Texts = n6 ? texts(n6).filter((t) => t.y >= 0 && t.y <= viewport.h) : [];
const appBarTexts = n6Texts.filter((t) => t.y <= 8).map((t) => t.text);
const mainTabs = texts(target('OFftq')).filter((t) => /到店自取|內用點餐|店外取餐|車道取餐/.test(t.text));

// Generic pair counts under new rules (board children only)
const pairs = [];
for (let i = 0; i < boardClasses.length; i++) {
  for (let j = 0; j < boardClasses.length; j++) {
    if (i === j) continue;
    const A = boardClasses[i], B = boardClasses[j];
    const aNode = boardChildren.find((f) => f.node.id === A.id)?.node;
    const bNode = boardChildren.find((f) => f.node.id === B.id)?.node;
    if (!aNode || !bNode) continue;
    const c = compareTexts(aNode, bNode);
    if (c.matched < 8) continue;
    let kind = 'different/other';
    if (A.cls === 'overlay' || B.cls === 'overlay' || A.cls === 'component' || B.cls === 'component') kind = 'excluded-overlay-component';
    else if (A.cls === 'full-content' && B.cls === 'full-content') kind = Math.abs(c.mode) <= 8 && c.contentDiff >= 0.2 ? 'state-change' : 'full-full-blocked';
    else if (Math.abs(c.mode) >= 50 && c.support >= 0.8) kind = 'scroll-candidate';
    else if (Math.abs(c.mode) <= 8 && c.contentDiff >= 0.2) kind = 'state-change';
    else if (Math.abs(c.mode) <= 8) kind = 'duplicate';
    else kind = 'gray';
    pairs.push({ kind, A: A.id, B: B.id, Acls: A.cls, Bcls: B.cls, ...c, ncc: kind === 'scroll-candidate' ? ncc(A.id, B.id, c.mode) : null });
  }
}
const pairCounts = {};
for (const p of pairs) pairCounts[p.kind] = (pairCounts[p.kind] ?? 0) + 1;

const report = {
  generatedAt: new Date().toISOString(),
  source: FILE,
  render: { frames: ids.length, ok: rendered.ok, missing: rendered.missing.length, ms: renderMs },
  viewport,
  classCounts,
  boardClasses,
  targetPairs: {
    mop: { ids: ['OFftq', 'pEfey'], ...mop, expected: 'scroll-collapse delta≈360' },
    search: { ids: ['j6XA0', 'RVg6w'], ...search, expected: 'state-change contentDiff≈0.298' },
    state1: { ids: ['w8OHy', 'CSMVD'], ...state1, expected: 'state-change delta≈0' },
    state2: { ids: ['w8OHy', 'uorYu'], ...state2, expected: 'state-change delta≈0' }
  },
  takeoverEvidence: { appBarTexts, mainTabs: mainTabs.map((t) => ({ text: t.text, y: t.y })) },
  pairCounts,
  pairs: pairs.filter((p) => p.kind === 'scroll-candidate' || p.kind === 'state-change').slice(0, 80)
};
fs.writeFileSync(path.join(OUT, 'poc-result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  render: report.render,
  viewport,
  classCounts,
  targetPairs: report.targetPairs,
  takeoverEvidence: report.takeoverEvidence,
  pairCounts
}, null, 2));
console.log('out', path.join(OUT, 'poc-result.json'));
