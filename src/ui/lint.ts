import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 最小 ui-lint：只检查「圆角字面量是否登记在 ui-contract.json 的 token 集合」。
 * 这是 retro P2 的第一条机械规则；不改代码、不推断设计→代码映射，启发式命中靠 allowlist 收口。 */

export interface UiLintFinding {
  file: string;
  line: number;
  column: number;
  value: number;
  stack: string;
  snippet: string;
  allowed: number[];
  allowlisted: boolean;
  allowlist?: { owner: string; reason: string; expiresAt: string };
}

export interface UiLintReport {
  ok: boolean;
  contract: {
    path: string;
    screens: number;
    fingerprint: string | null;
    radii: number[];
    statusCounts: Record<string, number>;
    incomplete: Array<{ id: string; name: string; status: string }>;
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
  now?: () => number;
  maxFiles?: number;
  maxFileBytes?: number;
}

interface AllowEntry {
  file: string;
  value: number | null;
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

function roundRadius(value: number): number {
  return Number(value.toFixed(2));
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
  const statusCounts: Record<string, number> = {};
  const incomplete: Array<{ id: string; name: string; status: string }> = [];
  let screenCount = 0;
  for (const screen of screens) {
    if (!screen || typeof screen !== "object") continue;
    screenCount += 1;
    const value = screen as Record<string, unknown>;
    const status = typeof value.status === "string" && value.status.trim() !== "" ? value.status : "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status !== "extracted") {
      const id = typeof value.id === "string" ? value.id : "";
      const name = typeof value.name === "string" ? value.name : id;
      incomplete.push({ id, name, status });
    }
    const tokens = value.tokens;
    if (!tokens || typeof tokens !== "object") continue;
    const values = (tokens as { cornerRadius?: unknown }).cornerRadius;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        radii.add(roundRadius(value));
      }
    }
  }
  if (screenCount === 0) {
    incomplete.push({ id: "", name: "（契约无屏幕）", status: "missing" });
    statusCounts.missing = (statusCounts.missing ?? 0) + 1;
  }
  const source = record.source;
  const fingerprint =
    source && typeof source === "object" && typeof (source as { fingerprint?: unknown }).fingerprint === "string"
      ? ((source as { fingerprint: string }).fingerprint)
      : null;
  return {
    path: file,
    screens: screenCount,
    fingerprint,
    radii: [...radii].sort((left, right) => left - right),
    statusCounts,
    incomplete
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
    const value =
      typeof record.value === "number" && Number.isFinite(record.value) ? record.value : null;
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
    entries.push({ file: filePath, value, owner, reason, expiresAt });
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

export function runUiLint(options: UiLintOptions): UiLintReport {
  const rootDir = path.resolve(options.rootDir);
  const contractPath = path.resolve(
    options.contractPath ?? path.join(rootDir, ".artemis", "design", "ui-contract.json")
  );
  const allowlistPath = path.resolve(
    options.allowlistPath ?? path.join(rootDir, ".artemis", "design", "ui-lint-allowlist.json")
  );
  const nowMs = (options.now ?? Date.now)();
  const contract = loadContract(contractPath);
  const warnings: string[] = [];
  const allow = loadAllowlist(allowlistPath, rootDir, nowMs, warnings);
  const allowed = new Set(contract.radii);
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

  const findings: UiLintFinding[] = [];
  const seen = new Set<string>();
  for (const file of selected) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      warnings.push(`源码不可读，已跳过：${file}`);
      continue;
    }
    const relative = path.relative(rootDir, file).replace(/\\/g, "/");
    for (const [stack, pattern] of RADIUS_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of content.matchAll(regex)) {
        const raw = match[1];
        if (raw === undefined) continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) continue;
        const rounded = roundRadius(value);
        if (allowed.has(rounded)) continue;
        const index = match.index ?? 0;
        const { line, column } = lineColumn(content, index);
        const key = `${relative}|${line}|${column}|${rounded}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const snippet = content.split("\n")[line - 1]?.trim().slice(0, 160) ?? "";
        const entry = allow.entries.find(
          (item) =>
            item.file === relative && (item.value === null || roundRadius(item.value) === rounded)
        );
        findings.push({
          file: relative,
          line,
          column,
          value: rounded,
          stack,
          snippet,
          allowed: contract.radii,
          allowlisted: entry !== undefined,
          ...(entry === undefined
            ? {}
            : {
                allowlist: {
                  owner: entry.owner,
                  reason: entry.reason,
                  expiresAt: entry.expiresAt
                }
              })
        });
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
  return {
    ok: findings.every((finding) => finding.allowlisted) && contractComplete && expiryOk,
    contract,
    scanned: {
      files: selected.length,
      skipped: skipped + (files.length - selected.length) + allow.skipped
    },
    findings,
    allowlisted,
    allowlist: { entries: allow.entries.length, expiring },
    warnings
  };
}
