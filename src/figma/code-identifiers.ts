import fs from "node:fs";
import path from "node:path";

import { identifierFromLayerName } from "../design/identifiers.js";
import { normalizeElementLabel } from "../diff/screen-map.js";

/** 源码 locator 预挖：把 testID/accessibilityIdentifier/testTag/Key 等标识
 * 与其附近的可见文本关联，供首次生成输出 `a11y:` 注记。纯启发式，不保证覆盖。 */

export interface CodeIdentifierHint {
  text: string;
  identifier: string;
  file: string;
  line: number;
}

export interface CodeIdentifierScanResult {
  hints: CodeIdentifierHint[];
  scannedFiles: number;
  truncated: boolean;
}

const SOURCE_EXTENSIONS = new Set([
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".swift",
  ".kt",
  ".java",
  ".xml",
  ".dart"
]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "Pods",
  ".gradle",
  ".artemis",
  "vendor",
  "coverage",
  ".next",
  ".dart_tool"
]);

const MAX_FILES = 800;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_HINTS = 500;
const PAIR_WINDOW = 4;

interface Candidate {
  line: number;
  value: string;
}

const IDENTIFIER_PATTERNS = [
  /\btestID\s*=\s*["'`]([^"'`]+)["'`]/g,
  /\bdata-testid\s*=\s*["'`]([^"'`]+)["'`]/g,
  /\btestTag\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\.accessibilityIdentifier\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\baccessibilityIdentifier\s*[=:]\s*["'`]([^"'`]+)["'`]/g,
  /\b(?:Key|ValueKey)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /android:id\s*=\s*["']@\+id\/([^"']+)["']/g
];

const TEXT_PATTERNS = [
  /\bText\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /<Text[^>]*>\s*([^<>{}]+?)\s*<\/Text>/g,
  /\btext\s*=\s*["'`]([^"'`]+)["'`]/g,
  /\bsetTitle\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\b(?:label|title|placeholder)\s*[:=]\s*["'`]([^"'`]+)["'`]/g,
  /android:text\s*=\s*["']([^"']+)["']/g
];

function collect(source: string, patterns: RegExp[]): Candidate[] {
  const candidates: Candidate[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const value = match[1]?.trim();
        if (value) candidates.push({ line: index + 1, value });
      }
    }
  }
  return candidates;
}

function visibleText(value: string): string | null {
  const text = value.trim();
  if (text === "" || text.length > 80) return null;
  if (/[{}$<>\\\n\r]/.test(text)) return null;
  if (identifierFromLayerName(text) !== null) return null;
  return text;
}

/** 单文件解析（纯函数）：标识与可见文本相距 ≤ PAIR_WINDOW 行才配对，取最近。 */
export function extractCodeIdentifierHints(source: string, file: string): CodeIdentifierHint[] {
  const identifiers: Candidate[] = [];
  for (const candidate of collect(source, IDENTIFIER_PATTERNS)) {
    const identifier = identifierFromLayerName(candidate.value);
    if (identifier !== null) identifiers.push({ line: candidate.line, value: identifier });
  }
  const texts: Candidate[] = [];
  for (const candidate of collect(source, TEXT_PATTERNS)) {
    const text = visibleText(candidate.value);
    if (text !== null) texts.push({ line: candidate.line, value: text });
  }
  if (identifiers.length === 0 || texts.length === 0) return [];

  const hints: CodeIdentifierHint[] = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    let best: { text: Candidate; distance: number } | null = null;
    for (const text of texts) {
      const distance = Math.abs(text.line - identifier.line);
      if (distance > PAIR_WINDOW) continue;
      if (best === null || distance < best.distance) best = { text, distance };
    }
    if (best === null) continue;
    const key = `${normalizeElementLabel(best.text.value)}|${identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      text: best.text.value,
      identifier: identifier.value,
      file,
      line: identifier.line
    });
  }
  return hints;
}

export function scanCodeIdentifierHints(
  rootDir: string,
  options: { maxFiles?: number; maxHints?: number } = {}
): CodeIdentifierScanResult {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxHints = options.maxHints ?? MAX_HINTS;
  const hints: CodeIdentifierHint[] = [];
  let scannedFiles = 0;
  let truncated = false;

  const visit = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      if (scannedFiles >= maxFiles) {
        truncated = true;
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      scannedFiles += 1;
      let source: string;
      try {
        source = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      for (const hint of extractCodeIdentifierHints(source, path.relative(rootDir, full))) {
        hints.push(hint);
        if (hints.length >= maxHints) {
          truncated = true;
          return;
        }
      }
    }
  };

  visit(rootDir);
  return { hints, scannedFiles, truncated };
}
