#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const root = path.resolve(valueOf("--root") ?? process.cwd());
const baselinePath = path.resolve(
  valueOf("--baseline") ?? path.join(root, "scripts", "silent-catch-baseline.json")
);
const json = has("--json");
const update = has("--update-baseline");

const patterns = [
  { name: "catch-undefined", regex: /\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/g },
  { name: "catch-null", regex: /\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/g },
  { name: "catch-empty-block", regex: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g },
  {
    name: "empty-catch",
    regex: /catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g,
    isEmpty: (body) =>
      body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .trim() === ""
  }
];

/** 去注释与字符串，避免 // catch {} / "catch {}" 误报；保留代码结构。 */
function stripCommentsAndStrings(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor") continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

function collect(file) {
  const text = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
  const snippets = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      if (pattern.isEmpty !== undefined && !pattern.isEmpty(match[1] ?? "")) continue;
      snippets.push(match[0].replace(/\s+/g, " ").trim());
    }
  }
  snippets.sort();
  return {
    count: snippets.length,
    hash: crypto.createHash("sha256").update(snippets.join("\u0000")).digest("hex")
  };
}

function loadBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.version === 2 && parsed.files !== null && typeof parsed.files === "object") {
      return parsed.files;
    }
    if (parsed.counts !== null && typeof parsed.counts === "object") {
      return Object.fromEntries(
        Object.entries(parsed.counts).map(([file, count]) => [file, { count, hash: null }])
      );
    }
  } catch {
    /* missing/invalid */
  }
  return null;
}

const srcDir = path.join(root, "src");
const files = [];
walk(srcDir, files);
const current = {};
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const result = collect(file);
  if (result.count > 0) current[relative] = result;
}
const total = Object.values(current).reduce((sum, entry) => sum + entry.count, 0);

if (update) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        version: 2,
        generatedAt: new Date().toISOString(),
        note: "存量静默 catch 基线（按文件计数 + 内容哈希）；新增或替换请改代码或显式 --update-baseline",
        files: current
      },
      null,
      2
    )}\n`
  );
  if (!json) console.log(`已更新基线：${baselinePath}（${total} 处）`);
  else console.log(JSON.stringify({ updated: true, baselinePath, total, current }, null, 2));
  process.exit(0);
}

const baseline = loadBaseline();
if (baseline === null) {
  const message = `缺少基线 ${baselinePath}；先运行 node scripts/audit-silent-catches.mjs --update-baseline`;
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(2);
}
const baselineTotal = Object.values(baseline).reduce(
  (sum, entry) => sum + (entry.count ?? 0),
  0
);
const violations = [];
for (const [file, entry] of Object.entries(current)) {
  const base = baseline[file];
  if (base === undefined) {
    violations.push({ file, count: entry.count, baseline: 0, reason: "new-file" });
    continue;
  }
  if (entry.count > base.count) {
    violations.push({
      file,
      count: entry.count,
      baseline: base.count,
      reason: "count-increased"
    });
    continue;
  }
  if (base.hash !== null && entry.count === base.count && entry.hash !== base.hash) {
    violations.push({
      file,
      count: entry.count,
      baseline: base.count,
      reason: "content-changed"
    });
  }
}

if (json) {
  console.log(
    JSON.stringify(
      { ok: violations.length === 0, total, baselineTotal, violations, current },
      null,
      2
    )
  );
} else if (violations.length === 0) {
  console.log(`静默 catch：${total} 处（基线 ${baselineTotal}），无新增/替换`);
} else {
  console.error(`静默 catch 超出基线：${total} 处（基线 ${baselineTotal}）`);
  for (const violation of violations) {
    console.error(
      `  ${violation.file}: ${violation.count} vs ${violation.baseline}（${violation.reason}）`
    );
  }
  console.error("请给关键路径加日志/审计，或显式更新基线（--update-baseline）");
}
process.exit(violations.length === 0 ? 0 : 1);
