import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../util.js";
import { normalizeFontWeight, uiContractFingerprint } from "./contract.js";
import {
  buildUiMapping,
  type UiFileMapping,
  type UiMappingReport,
  type UiMappingScreen
} from "./mapping.js";

/** 最小 ui-lint：检查「圆角/颜色/字号/字重/字体族字面量是否登记在 ui-contract.json 的 token 集合」。
 * 机械规则，不改代码、不推断设计→代码映射；启发式命中靠 allowlist 收口。
 * 逐屏映射（screen-map.json）只收窄显式、高置信且屏幕已提取的文件；其余回退全局 token。 */

export type UiLintRule = "radius" | "color" | "font-size" | "font-weight" | "font-family";
export type UiLintScope = "screen" | "global";

export interface UiLintFinding {
  rule: UiLintRule;
  file: string;
  line: number;
  column: number;
  value: number | string;
  /** 规范化值（颜色 #rrggbbaa / 字体族小写归一等）。 */
  normalized?: string;
  stack: string;
  snippet: string;
  allowed: Array<number | string>;
  allowlisted: boolean;
  allowlist?: { owner: string; reason: string; expiresAt: string };
  /** per-screen 收窄生效时为 screen；未映射/回退时为 global（缺省不写）。 */
  scope?: UiLintScope;
  /** 该文件命中的契约屏幕（scope=screen 时）。 */
  screens?: string[];
}

export interface UiLintReport {
  ok: boolean;
  contract: {
    path: string;
    screens: number;
    fingerprint: string | null;
    /** 当前 flows + 逐屏 .pen 重新计算的指纹（缺源/不可读时为 null）。 */
    fingerprintNow: string | null;
    /** current=未漂移；stale=设计源已变；unverifiable=缺源/读失败；missing=契约无指纹。 */
    fingerprintStatus: "current" | "stale" | "unverifiable" | "missing";
    source: { flows: string | null; designRoot: string | null };
    radii: number[];
    colors: string[];
    fontSizes: number[];
    fontWeights: number[];
    fontFamilies: string[];
    statusCounts: Record<string, number>;
    incomplete: Array<{ id: string; name: string; status: string }>;
    /** 逐屏 token（per-screen 收窄用；与全局并集同源）。 */
    screenTokens: UiMappingScreen[];
  };
  scanned: { files: number; skipped: number };
  findings: UiLintFinding[];
  allowlisted: number;
  allowlist: {
    entries: number;
    expiring: Array<{
      file: string;
      owner: string;
      reason: string;
      expiresAt: string;
      daysLeft: number;
    }>;
  };
  mapping: UiMappingReport;
  warnings: string[];
}

export class UiLintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiLintError";
  }
}

export interface UiLintOptions {
  rootDir: string;
  contractPath?: string;
  allowlistPath?: string;
  /** 只扫工作区变更文件（git diff HEAD + untracked）；非 git 仓库报错。 */
  changed?: boolean;
  /** 契约必须全部 screen status=extracted；否则 ok=false（exit 1）。 */
  requireComplete?: boolean;
  /** allowlist 到期前提醒天数（默认 7）。 */
  expiryWarnDays?: number;
  /** allowlist 有即将到期条目时 ok=false（exit 1）。 */
  failOnExpiring?: boolean;
  /** 按 screen-map 逐屏收窄 token（未映射/低置信/未提取屏回退全局）。 */
  perScreen?: boolean;
  /** 每个 status=extracted 的契约屏都必须有显式、高置信映射；否则 ok=false。 */
  requireMapping?: boolean;
  /** screen-map.json 路径（默认 <root>/.artemis/design/screen-map.json）。 */
  screenMapPath?: string;
  /** 契约指纹与当前 flows/.pen 不一致（或不可校验）时 ok=false。 */
  failOnStaleContract?: boolean;
  now?: () => number;
  maxFiles?: number;
  maxFileBytes?: number;
  /** 全部选中源码的内存上限（默认 256 MB）；超出后跳过并告警。 */
  maxTotalBytes?: number;
}

interface AllowEntry {
  file: string;
  rule: UiLintRule;
  value: number | string | null;
  owner: string;
  reason: string;
  expiresAt: string;
}

const SKIP_DIRS = new Set([
  ".git",
  ".artemis",
  ".gradle",
  ".next",
  ".venv",
  "Pods",
  "DerivedData",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
  "vendor"
]);

const SOURCE_EXTENSIONS = new Set([
  ".kt",
  ".kts",
  ".swift",
  ".m",
  ".mm",
  ".java",
  ".dart",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
  ".xml"
]);

const RADIUS_PATTERNS: Array<[string, RegExp]> = [
  ["Compose RoundedCornerShape", /\bRoundedCornerShape\s*\(\s*(\d+(?:\.\d+)?)(?:\.dp)?/g],
  ["Compose CornerRadius", /\bCornerRadius\s*\(\s*(\d+(?:\.\d+)?)(?:\.dp)?/g],
  ["SwiftUI cornerRadius", /\.cornerRadius\s*\(\s*(\d+(?:\.\d+)?)/g],
  ["SwiftUI RoundedRectangle", /\bRoundedRectangle\s*\(\s*cornerRadius\s*:\s*(\d+(?:\.\d+)?)/g],
  ["Flutter BorderRadius.circular", /\bBorderRadius\.circular\s*\(\s*(\d+(?:\.\d+)?)/g],
  ["CSS border-radius", /border-radius\s*:\s*(\d+(?:\.\d+)?)px/g],
  ["JS borderRadius", /\bborderRadius\s*[:=]\s*(\d+(?:\.\d+)?)/g],
  ["cornerRadius literal", /\bcornerRadius\s*[:=]\s*(\d+(?:\.\d+)?)/g],
  ["Android radius", /android:radius\s*=\s*"(\d+(?:\.\d+)?)dp"/g]
];

const FONT_SIZE_PATTERNS: Array<[string, RegExp]> = [
  [
    "fontSize literal",
    /\bfontSize\s*[:=]\s*(\d+(?:\.\d+)?)(?![\d.])(?:\s*(?:sp|px|pt))?(?!\s*(?:rem|em|%|vw|vh))/g
  ],
  ["CSS font-size", /\bfont-size\s*:\s*(\d+(?:\.\d+)?)(?:px|pt)\b/g],
  ["SwiftUI system size", /\.system\s*\(\s*size\s*:\s*(\d+(?:\.\d+)?)/g],
  ["UIKit systemFont", /\bsystemFont\s*\(\s*ofSize\s*:\s*(\d+(?:\.\d+)?)/g],
  ["Android textSize", /android:textSize\s*=\s*"(\d+(?:\.\d+)?)(?:sp|dp|pt|px)?"/g]
];

const FONT_FAMILY_PATTERNS: Array<[string, RegExp]> = [
  ["CSS font-family", /\bfont-family\s*:\s*["']?([^"',;}\n]+)["']?/g],
  ["fontFamily literal", /(?<!:)\bfontFamily\s*[:=]\s*["']([^"']+)["']/g],
  ["SwiftUI custom font", /\.custom\s*\(\s*["']([^"']+)["']/g],
  ["UIKit font name", /\bUIFont\s*\(\s*name\s*:\s*["']([^"']+)["']/g],
  ["Android fontFamily", /android:fontFamily\s*=\s*"([^"]+)"/g]
];

const GENERIC_FONT_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "default"
]);

const FONT_WEIGHT_PATTERNS: Array<[string, RegExp]> = [
  ["fontWeight literal", /\bfontWeight\s*[:=]\s*["']?([A-Za-z0-9_.-]+)["']?/g],
  ["CSS font-weight", /\bfont-weight\s*:\s*([A-Za-z0-9_-]+)/g],
  ["SwiftUI fontWeight", /\.fontWeight\s*\(\s*\.?([A-Za-z0-9_-]+)\s*\)/g],
  ["SwiftUI weight", /\.weight\s*:\s*\.?([A-Za-z0-9_-]+)/g],
  ["Flutter FontWeight", /\bFontWeight\.([A-Za-z0-9_]+)/g]
];

type AlphaOrder = "leading" | "trailing";

const COLOR_PATTERNS: Array<{
  stack: string;
  pattern: RegExp;
  order: AlphaOrder | "auto";
}> = [
  { stack: "hex color", pattern: /(?<![0-9a-zA-Z])#([0-9a-fA-F]{3,8})\b/g, order: "auto" },
  { stack: "0x color", pattern: /\b0x([0-9a-fA-F]{8})\b/g, order: "leading" }
];

const UI_LINT_RULES: UiLintRule[] = [
  "radius",
  "color",
  "font-size",
  "font-weight",
  "font-family"
];

function roundNumber(value: number): number {
  return Number(value.toFixed(2));
}

function expandHex(hex: string): string {
  return hex
    .split("")
    .map((char) => char + char)
    .join("");
}

/** 统一成 #rrggbbaa 便于跨端比较；#RGB/#RRGGBB 视作不透明，
 * #RGBA/#RRGGBBAA 与 Android #ARGB/#AARRGGBB 由 order 决定 alpha 位置。 */
function canonicalColor(raw: string, order: AlphaOrder): string | null {
  let hex = raw.trim().toLowerCase();
  if (hex.startsWith("#")) hex = hex.slice(1);
  else if (hex.startsWith("0x")) hex = hex.slice(2);
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 3) return `#${expandHex(hex)}ff`;
  if (hex.length === 6) return `#${hex}ff`;
  if (hex.length === 4) hex = expandHex(hex);
  else if (hex.length !== 8) return null;
  const rgb = order === "leading" ? hex.slice(2) : hex.slice(0, 6);
  const alpha = order === "leading" ? hex.slice(0, 2) : hex.slice(6);
  return `#${rgb}${alpha}`;
}

function colorOrderForFile(file: string, order: AlphaOrder | "auto"): AlphaOrder {
  if (order !== "auto") return order;
  return path.extname(file).toLowerCase() === ".xml" ? "leading" : "trailing";
}

function normalizeWeightToken(raw: string): number | null {
  let value = raw.trim().replace(/^["']|["']$/g, "");
  value = value.replace(/^FontWeight\./, "").replace(/^\./, "");
  if (/^w\d+$/i.test(value)) value = value.slice(1);
  const normalized = normalizeFontWeight(value);
  return normalized !== null && normalized > 0 && normalized <= 1_000 ? normalized : null;
}

function normalizeFontFamily(raw: string): string | null {
  let value = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (value === "") return null;
  if (value.startsWith("@") || value.startsWith("?") || value.startsWith("$")) return null;
  if (/^(var|theme|attr)\s*\(/i.test(value)) return null;
  value = value.replace(/\s+/g, " ").toLowerCase();
  if (GENERIC_FONT_FAMILIES.has(value)) return null;
  return value;
}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    throw new UiLintError(`文件不可读：${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new UiLintError(`JSON 解析失败：${file}`);
  }
}

interface ScreenTokenSets {
  radii: number[];
  colors: string[];
  fontSizes: number[];
  fontWeights: number[];
  fontFamilies: string[];
}

function readScreenTokenSets(tokens: unknown): ScreenTokenSets {
  const radii = new Set<number>([0]);
  const colors = new Set<string>();
  const fontSizes = new Set<number>();
  const fontWeights = new Set<number>();
  const fontFamilies = new Set<string>();
  if (!tokens || typeof tokens !== "object") {
    return { radii: [0], colors: [], fontSizes: [], fontWeights: [], fontFamilies: [] };
  }
  const tokenRecord = tokens as {
    cornerRadius?: unknown;
    colors?: unknown;
    fontSizes?: unknown;
    fontWeights?: unknown;
    fontFamilies?: unknown;
  };
  if (Array.isArray(tokenRecord.cornerRadius)) {
    for (const entry of tokenRecord.cornerRadius) {
      if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
        radii.add(roundNumber(entry));
      }
    }
  }
  if (Array.isArray(tokenRecord.colors)) {
    for (const entry of tokenRecord.colors) {
      if (typeof entry !== "string") continue;
      const normalized = canonicalColor(entry, "trailing");
      if (normalized !== null) colors.add(normalized);
    }
  }
  if (Array.isArray(tokenRecord.fontSizes)) {
    for (const entry of tokenRecord.fontSizes) {
      if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
        fontSizes.add(roundNumber(entry));
      }
    }
  }
  if (Array.isArray(tokenRecord.fontWeights)) {
    for (const entry of tokenRecord.fontWeights) {
      const normalized = normalizeWeightToken(
        typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry : ""
      );
      if (normalized !== null) fontWeights.add(normalized);
    }
  }
  if (Array.isArray(tokenRecord.fontFamilies)) {
    for (const entry of tokenRecord.fontFamilies) {
      if (typeof entry !== "string") continue;
      const normalized = normalizeFontFamily(entry);
      if (normalized !== null) fontFamilies.add(normalized);
    }
  }
  return {
    radii: [...radii].sort((left, right) => left - right),
    colors: [...colors].sort(),
    fontSizes: [...fontSizes].sort((left, right) => left - right),
    fontWeights: [...fontWeights].sort((left, right) => left - right),
    fontFamilies: [...fontFamilies].sort()
  };
}

function loadContract(file: string): UiLintReport["contract"] {
  if (!fs.existsSync(file)) {
    throw new UiLintError(`未找到 UI 契约：${file}（先运行 suite ui-contract）`);
  }
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UiLintError(`UI 契约不是对象：${file}`);
  }
  const record = parsed as Record<string, unknown>;
  const screens = Array.isArray(record.screens) ? record.screens : [];
  const radii = new Set<number>([0]);
  const colors = new Set<string>();
  const fontSizes = new Set<number>();
  const fontWeights = new Set<number>();
  const fontFamilies = new Set<string>();
  const statusCounts: Record<string, number> = {};
  const incomplete: Array<{ id: string; name: string; status: string }> = [];
  const screenTokens: UiMappingScreen[] = [];
  let screenCount = 0;
  for (const screen of screens) {
    if (!screen || typeof screen !== "object") continue;
    screenCount += 1;
    const value = screen as Record<string, unknown>;
    const status = typeof value.status === "string" && value.status.trim() !== "" ? value.status : "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const id = typeof value.id === "string" ? value.id : "";
    const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name : id;
    if (status !== "extracted") incomplete.push({ id, name, status });
    const sets = readScreenTokenSets(value.tokens);
    screenTokens.push({
      id,
      name,
      sourceFrameName: typeof value.sourceFrameName === "string" ? value.sourceFrameName : null,
      status,
      ...sets
    });
    for (const entry of sets.radii) radii.add(entry);
    for (const entry of sets.colors) colors.add(entry);
    for (const entry of sets.fontSizes) fontSizes.add(entry);
    for (const entry of sets.fontWeights) fontWeights.add(entry);
    for (const entry of sets.fontFamilies) fontFamilies.add(entry);
  }
  if (screenCount === 0) {
    incomplete.push({ id: "", name: "（契约无屏幕）", status: "missing" });
    statusCounts.missing = (statusCounts.missing ?? 0) + 1;
  }
  const source = record.source;
  const sourceRecord =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : null;
  const fingerprint =
    typeof sourceRecord?.fingerprint === "string" ? sourceRecord.fingerprint : null;
  const flowsSource = typeof sourceRecord?.flows === "string" ? sourceRecord.flows : null;
  const designRootSource =
    typeof sourceRecord?.designRoot === "string" ? sourceRecord.designRoot : null;
  return {
    path: file,
    screens: screenCount,
    fingerprint,
    fingerprintNow: null,
    fingerprintStatus: fingerprint === null ? "missing" : "unverifiable",
    source: { flows: flowsSource, designRoot: designRootSource },
    radii: [...radii].sort((left, right) => left - right),
    colors: [...colors].sort(),
    fontSizes: [...fontSizes].sort((left, right) => left - right),
    fontWeights: [...fontWeights].sort((left, right) => left - right),
    fontFamilies: [...fontFamilies].sort(),
    statusCounts,
    incomplete,
    screenTokens
  };
}

function normalizeAllowFile(rootDir: string, file: string): string {
  const normalized = path.isAbsolute(file) ? path.relative(rootDir, file) : file;
  return normalized.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function loadAllowlist(
  file: string,
  rootDir: string,
  nowMs: number,
  warnings: string[]
): { entries: AllowEntry[]; skipped: number } {
  if (!fs.existsSync(file)) return { entries: [], skipped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    warnings.push(`allowlist 不是合法 JSON，已忽略：${file}`);
    return { entries: [], skipped: 1 };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : null;
  if (list === null) {
    warnings.push(`allowlist 缺少 entries 数组，已忽略：${file}`);
    return { entries: [], skipped: 1 };
  }
  const entries: AllowEntry[] = [];
  let skipped = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      skipped += 1;
      continue;
    }
    const record = raw as Record<string, unknown>;
    const filePath = typeof record.file === "string" ? normalizeAllowFile(rootDir, record.file) : "";
    const owner = typeof record.owner === "string" ? record.owner.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt.trim() : "";
    if (filePath === "" || owner === "" || reason === "" || expiresAt === "") {
      warnings.push(`allowlist 条目缺 file/owner/reason/expiresAt，已忽略：${JSON.stringify(record)}`);
      skipped += 1;
      continue;
    }
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiryMs)) {
      warnings.push(`allowlist expiresAt 非法，已忽略：${filePath} (${expiresAt})`);
      skipped += 1;
      continue;
    }
    if (expiryMs <= nowMs) {
      warnings.push(`allowlist 已过期，已忽略：${filePath} (${expiresAt})`);
      skipped += 1;
      continue;
    }
    const ruleRaw = typeof record.rule === "string" ? record.rule.trim() : "";
    let rule: UiLintRule = "radius";
    if (ruleRaw !== "") {
      if (!UI_LINT_RULES.includes(ruleRaw as UiLintRule)) {
        warnings.push(`allowlist rule 非法，已忽略：${JSON.stringify(record)}`);
        skipped += 1;
        continue;
      }
      rule = ruleRaw as UiLintRule;
    }
    const rawValue = record.value;
    let value: number | string | null = null;
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      value = rawValue;
    } else if (typeof rawValue === "string" && rawValue.trim() !== "") {
      value = rawValue.trim();
    } else if (rawValue !== undefined && rawValue !== null) {
      warnings.push(`allowlist value 非法，已忽略：${JSON.stringify(record)}`);
      skipped += 1;
      continue;
    }
    if (rule === "color" || rule === "font-family") {
      if (value !== null) {
        if (typeof value !== "string") {
          warnings.push(`allowlist ${rule} value 必须是字符串，已忽略：${JSON.stringify(record)}`);
          skipped += 1;
          continue;
        }
        const normalized =
          rule === "color"
            ? canonicalColor(value, value.toLowerCase().startsWith("0x") ? "leading" : "trailing")
            : normalizeFontFamily(value);
        if (normalized === null) {
          warnings.push(`allowlist ${rule} value 非法，已忽略：${JSON.stringify(record)}`);
          skipped += 1;
          continue;
        }
        value = normalized;
      }
    } else if (value !== null) {
      if (typeof value !== "number") {
        warnings.push(`allowlist ${rule} value 必须是数字，已忽略：${JSON.stringify(record)}`);
        skipped += 1;
        continue;
      }
      value = roundNumber(value);
    }
    entries.push({ file: filePath, rule, value, owner, reason, expiresAt });
  }
  return { entries, skipped };
}

function walkSourceFiles(
  rootDir: string,
  maxFiles: number,
  maxFileBytes: number
): { files: string[]; skipped: number } {
  const files: string[] = [];
  let skipped = 0;
  const visit = (dirAbs: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      skipped += 1;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped += 1;
          continue;
        }
        visit(abs);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      try {
        if (fs.statSync(abs).size > maxFileBytes) {
          skipped += 1;
          continue;
        }
      } catch {
        skipped += 1;
        continue;
      }
      files.push(abs);
    }
  };
  visit(rootDir);
  return { files, skipped };
}

function gitChangedFiles(rootDir: string): Set<string> {
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new UiLintError("--changed 需要可用的 git 仓库（且 git 已安装）");
    }
  };
  let tracked = "";
  try {
    tracked = git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
  } catch {
    // 空仓库没有 HEAD：仍可用 untracked 列表扫描。
    if (!fs.existsSync(path.join(rootDir, ".git"))) {
      throw new UiLintError("--changed 需要可用的 git 仓库（且 git 已安装）");
    }
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const files = new Set<string>();
  for (const line of `${tracked}\n${untracked}`.split("\n")) {
    const normalized = line.trim().replace(/\\/g, "/");
    if (normalized !== "") files.add(normalized);
  }
  return files;
}

function lineColumn(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  return { line, column };
}

function allowEntryMatches(entry: AllowEntry, finding: UiLintFinding): boolean {
  if (entry.file !== finding.file || entry.rule !== finding.rule) return false;
  if (entry.value === null) return true;
  if (finding.rule === "color" || finding.rule === "font-family") {
    return entry.value === finding.normalized;
  }
  return entry.value === finding.value;
}

function collectFinding(
  finding: UiLintFinding,
  entries: AllowEntry[],
  findings: UiLintFinding[]
): void {
  const entry = entries.find((item) => allowEntryMatches(item, finding));
  if (entry !== undefined) {
    finding.allowlisted = true;
    finding.allowlist = {
      owner: entry.owner,
      reason: entry.reason,
      expiresAt: entry.expiresAt
    };
  }
  findings.push(finding);
}

interface ScopeConfig {
  scope: UiLintScope;
  screens: string[];
  radii: number[];
  colors: string[] | null;
  fontSizes: number[] | null;
  fontWeights: number[] | null;
  fontFamilies: string[] | null;
}

function unionNumbers(lists: number[][]): number[] {
  return [...new Set(lists.flat())].sort((left, right) => left - right);
}

function unionStrings(lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

export function runUiLint(options: UiLintOptions): UiLintReport {
  const rootDir = path.resolve(options.rootDir);
  const contractPath = path.resolve(
    options.contractPath ?? path.join(rootDir, ".artemis", "design", "ui-contract.json")
  );
  const allowlistPath = path.resolve(
    options.allowlistPath ?? path.join(rootDir, ".artemis", "design", "ui-lint-allowlist.json")
  );
  const screenMapPath = path.resolve(
    options.screenMapPath ?? path.join(rootDir, ".artemis", "design", "screen-map.json")
  );
  const nowMs = (options.now ?? Date.now)();
  const contract = loadContract(contractPath);
  const warnings: string[] = [];
  {
    const flowsSource = contract.source.flows;
    const designRootSource = contract.source.designRoot;
    if (contract.fingerprint === null) {
      warnings.push("契约缺少 source.fingerprint，无法校验设计源漂移");
    } else if (flowsSource === null || designRootSource === null) {
      contract.fingerprintStatus = "unverifiable";
      warnings.push("契约指纹无法校验：缺少 source.flows / source.designRoot");
    } else {
      try {
        const computed = uiContractFingerprint(
          path.resolve(rootDir, flowsSource),
          path.resolve(rootDir, designRootSource)
        );
        contract.fingerprintNow = computed;
        contract.fingerprintStatus = computed === contract.fingerprint ? "current" : "stale";
      } catch (error) {
        contract.fingerprintStatus = "unverifiable";
        warnings.push(`契约指纹无法校验：${errorMessage(error)}`);
      }
    }
    if (contract.fingerprintStatus === "stale") {
      warnings.push(
        `契约指纹过期：设计源（flows/.pen）已变化，请重新运行 suite ui-contract（契约 ${contract.fingerprint?.slice(0, 12) ?? "—"}…，当前 ${contract.fingerprintNow?.slice(0, 12) ?? "—"}…）`
      );
    }
  }
  const allow = loadAllowlist(allowlistPath, rootDir, nowMs, warnings);
  const colorRuleEnabled = contract.colors.length > 0;
  const fontSizeRuleEnabled = contract.fontSizes.length > 0;
  const fontWeightRuleEnabled = contract.fontWeights.length > 0;
  const fontFamilyRuleEnabled = contract.fontFamilies.length > 0;
  if (!colorRuleEnabled) warnings.push("契约无颜色 token，已跳过颜色规则");
  if (!fontSizeRuleEnabled) warnings.push("契约无字号 token，已跳过字号规则");
  if (!fontWeightRuleEnabled) warnings.push("契约无字重 token，已跳过字重规则");
  if (!fontFamilyRuleEnabled) warnings.push("契约无字体族 token，已跳过字体族规则");
  const { files, skipped } = walkSourceFiles(
    rootDir,
    Math.max(1, Math.trunc(options.maxFiles ?? 5_000)),
    Math.max(1, Math.trunc(options.maxFileBytes ?? 1_048_576))
  );
  const changed = options.changed === true ? gitChangedFiles(rootDir) : null;
  const selected =
    changed === null
      ? files
      : files.filter((file) =>
          changed.has(path.relative(rootDir, file).replace(/\\/g, "/"))
        );

  const fileContents = new Map<string, string>();
  const maxTotalBytes = Math.max(1, Math.trunc(options.maxTotalBytes ?? 268_435_456));
  let totalBytes = 0;
  let budgetSkipped = 0;
  for (const file of selected) {
    const relative = path.relative(rootDir, file).replace(/\\/g, "/");
    try {
      const content = fs.readFileSync(file, "utf-8");
      const bytes = Buffer.byteLength(content, "utf8");
      if (totalBytes + bytes > maxTotalBytes) {
        budgetSkipped += 1;
        continue;
      }
      totalBytes += bytes;
      fileContents.set(relative, content);
    } catch {
      warnings.push(`源码不可读，已跳过：${relative}`);
    }
  }
  if (budgetSkipped > 0) {
    warnings.push(
      `源码总量超过 ${maxTotalBytes} 字节，已跳过 ${budgetSkipped} 个文件（可用 --max-total-bytes 调整）`
    );
  }
  const mapping = buildUiMapping({
    rootDir,
    screens: contract.screenTokens,
    fileContents,
    screenMapPath
  });
  warnings.push(...mapping.report.warnings);
  const screenById = new Map(contract.screenTokens.map((screen) => [screen.id, screen]));
  const globalScope: ScopeConfig = {
    scope: "global",
    screens: [],
    radii: contract.radii,
    colors: colorRuleEnabled ? contract.colors : null,
    fontSizes: fontSizeRuleEnabled ? contract.fontSizes : null,
    fontWeights: fontWeightRuleEnabled ? contract.fontWeights : null,
    fontFamilies: fontFamilyRuleEnabled ? contract.fontFamilies : null
  };
  const scopeForFile = (file: string): ScopeConfig => {
    const fileMapping: UiFileMapping | undefined = mapping.byFile.get(file);
    if (options.perScreen !== true || fileMapping === undefined) return globalScope;
    const screens = fileMapping.scopedScreenIds
      .map((id) => screenById.get(id))
      .filter(
        (screen): screen is UiMappingScreen =>
          screen !== undefined && screen.status === "extracted"
      );
    if (screens.length === 0) return globalScope;
    const colors = unionStrings(screens.map((screen) => screen.colors));
    const fontSizes = unionNumbers(screens.map((screen) => screen.fontSizes));
    const fontWeights = unionNumbers(screens.map((screen) => screen.fontWeights));
    const fontFamilies = unionStrings(screens.map((screen) => screen.fontFamilies));
    return {
      scope: "screen",
      screens: screens.map((screen) => screen.name || screen.id),
      radii: unionNumbers([[0], ...screens.map((screen) => screen.radii)]),
      // 屏幕已提取但该维度无 token：不把该规则扩成全量报错，逐屏时跳过并靠映射报告提示。
      colors: colors.length > 0 ? colors : null,
      fontSizes: fontSizes.length > 0 ? fontSizes : null,
      fontWeights: fontWeights.length > 0 ? fontWeights : null,
      fontFamilies: fontFamilies.length > 0 ? fontFamilies : null
    };
  };

  if (options.perScreen === true) {
    const scopedScreens = new Set(
      mapping.report.mappings
        .filter((entry) => entry.usedForScoping)
        .map((entry) => entry.screenId)
    );
    const scopedFindings = contract.screenTokens.filter(
      (screen) => screen.status === "extracted" && !scopedScreens.has(screen.id)
    );
    if (scopedFindings.length > 0) {
      warnings.push(
        `逐屏映射：${scopedFindings.length} 个 extracted 屏无高置信显式映射，已回退全局 token（${scopedFindings
          .map((screen) => screen.name || screen.id)
          .join("、")}）`
      );
    }
    if (mapping.report.files.globalFallback > 0) {
      warnings.push(
        `逐屏映射：${mapping.report.files.globalFallback} 个文件无显式映射，已回退全局 token`
      );
    }
    const heuristic = mapping.report.mappings.filter((entry) => entry.source === "heuristic");
    if (heuristic.length > 0) {
      warnings.push(
        `逐屏映射：${heuristic.length} 条启发式候选（confidence 0.5）仅报告，未用于 per-screen`
      );
    }
  }

  const findings: UiLintFinding[] = [];
  const seen = new Set<string>();
  for (const [relative, content] of fileContents) {
    const scope = scopeForFile(relative);
    const scopeFields =
      scope.scope === "screen" ? { scope: scope.scope, screens: scope.screens } : {};
    const numericRules: Array<{
      rule: "radius" | "font-size" | "font-weight";
      allowed: number[];
      patterns: Array<[string, RegExp]>;
      parse: (raw: string) => number | null;
    }> = [
      {
        rule: "radius",
        allowed: scope.radii,
        patterns: RADIUS_PATTERNS,
        parse: (raw) => {
          const value = Number(raw);
          return Number.isFinite(value) && value >= 0 ? roundNumber(value) : null;
        }
      }
    ];
    if (scope.fontSizes !== null) {
      numericRules.push({
        rule: "font-size",
        allowed: scope.fontSizes,
        patterns: FONT_SIZE_PATTERNS,
        parse: (raw) => {
          const value = Number(raw);
          return Number.isFinite(value) && value >= 0 ? roundNumber(value) : null;
        }
      });
    }
    if (scope.fontWeights !== null) {
      numericRules.push({
        rule: "font-weight",
        allowed: scope.fontWeights,
        patterns: FONT_WEIGHT_PATTERNS,
        parse: normalizeWeightToken
      });
    }
    for (const { rule, allowed, patterns, parse } of numericRules) {
      const allowedSet = new Set(allowed);
      for (const [stack, pattern] of patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        for (const match of content.matchAll(regex)) {
          const raw = match[1];
          if (raw === undefined) continue;
          const value = parse(raw);
          if (value === null) continue;
          if (allowedSet.has(value)) continue;
          const index = match.index ?? 0;
          const { line, column } = lineColumn(content, index);
          const key = `${rule}|${relative}|${line}|${column}|${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const snippet = content.split("\n")[line - 1]?.trim().slice(0, 160) ?? "";
          collectFinding(
            {
              rule,
              file: relative,
              line,
              column,
              value,
              stack,
              snippet,
              allowed,
              allowlisted: false,
              ...scopeFields
            },
            allow.entries,
            findings
          );
        }
      }
    }
    if (scope.fontFamilies !== null) {
      for (const [stack, pattern] of FONT_FAMILY_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        for (const match of content.matchAll(regex)) {
          const raw = match[1];
          if (raw === undefined) continue;
          const normalized = normalizeFontFamily(raw);
          if (normalized === null) continue;
          if (scope.fontFamilies.includes(normalized)) continue;
          const index = match.index ?? 0;
          const { line, column } = lineColumn(content, index);
          const key = `font-family|${relative}|${line}|${column}|${normalized}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const snippet = content.split("\n")[line - 1]?.trim().slice(0, 160) ?? "";
          collectFinding(
            {
              rule: "font-family",
              file: relative,
              line,
              column,
              value: raw.trim(),
              normalized,
              stack,
              snippet,
              allowed: scope.fontFamilies,
              allowlisted: false,
              ...scopeFields
            },
            allow.entries,
            findings
          );
        }
      }
    }
    if (scope.colors !== null) {
      for (const { stack, pattern, order } of COLOR_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        const filePath = path.join(rootDir, relative);
        for (const match of content.matchAll(regex)) {
          const hex = match[1];
          if (hex === undefined) continue;
          const normalized = canonicalColor(hex, colorOrderForFile(filePath, order));
          if (normalized === null) continue;
          if (scope.colors.includes(normalized)) continue;
          const index = match.index ?? 0;
          const { line, column } = lineColumn(content, index);
          const key = `color|${relative}|${line}|${column}|${normalized}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const snippet = content.split("\n")[line - 1]?.trim().slice(0, 160) ?? "";
          collectFinding(
            {
              rule: "color",
              file: relative,
              line,
              column,
              value: match[0].toLowerCase(),
              normalized,
              stack,
              snippet,
              allowed: scope.colors,
              allowlisted: false,
              ...scopeFields
            },
            allow.entries,
            findings
          );
        }
      }
    }
  }

  const allowlisted = findings.filter((finding) => finding.allowlisted).length;
  const expiryWarnDays = Math.max(0, Math.trunc(options.expiryWarnDays ?? 7));
  const expiring = allow.entries
    .map((entry) => ({
      file: entry.file,
      owner: entry.owner,
      reason: entry.reason,
      expiresAt: entry.expiresAt,
      daysLeft: Math.ceil((Date.parse(entry.expiresAt) - nowMs) / 86_400_000)
    }))
    .filter((entry) => entry.daysLeft <= expiryWarnDays)
    .sort((left, right) => left.daysLeft - right.daysLeft || left.file.localeCompare(right.file));
  for (const entry of expiring) {
    warnings.push(
      `allowlist 即将过期：${entry.file} · ${entry.owner} · ${entry.expiresAt}（${entry.daysLeft} 天）`
    );
  }
  const contractComplete = options.requireComplete !== true || contract.incomplete.length === 0;
  const expiryOk = options.failOnExpiring !== true || expiring.length === 0;
  const fingerprintOk =
    options.failOnStaleContract !== true || contract.fingerprintStatus === "current";
  const scopedScreens = new Set(
    mapping.report.mappings
      .filter((entry) => entry.usedForScoping)
      .map((entry) => entry.screenId)
  );
  const requiredUnmapped =
    options.requireMapping === true
      ? contract.screenTokens.filter(
          (screen) => screen.status === "extracted" && !scopedScreens.has(screen.id)
        )
      : [];
  if (requiredUnmapped.length > 0) {
    warnings.push(
      `--require-mapping：${requiredUnmapped.length} 个 extracted 屏缺少高置信显式映射（${requiredUnmapped
        .map((screen) => screen.name || screen.id)
        .join("、")}）`
    );
  }
  const mappingOk = requiredUnmapped.length === 0;
  return {
    ok:
      findings.every((finding) => finding.allowlisted) &&
      contractComplete &&
      expiryOk &&
      mappingOk &&
      fingerprintOk,
    contract,
    scanned: {
      files: selected.length,
      skipped: skipped + (files.length - selected.length) + allow.skipped + budgetSkipped
    },
    findings,
    allowlisted,
    allowlist: { entries: allow.entries.length, expiring },
    mapping: mapping.report,
    warnings
  };
}
