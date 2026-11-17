#!/usr/bin/env node
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
  {
    name: "catch-undefined",
    regex: /\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/g
  },
  {
    name: "catch-empty-block",
    regex: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g
  },
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

function countFile(file) {
  const text = fs.readFileSync(file, "utf8");
  let total = 0;
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      if (pattern.isEmpty !== undefined && !pattern.isEmpty(match[1] ?? "")) continue;
      total += 1;
    }
  }
  return total;
}

function loadBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed.counts !== null && typeof parsed.counts === "object" && !Array.isArray(parsed.counts)
        ? parsed.counts
        : {};
    }
  } catch {
    /* missing/invalid */
  }
  return null;
}

const srcDir = path.join(root, "src");
const files = [];
walk(srcDir, files);
const counts = {};
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const count = countFile(file);
  if (count > 0) counts[relative] = count;
}
const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

if (update) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        note: "存量静默 catch 基线；新增超基线请改代码或显式更新（--update-baseline）",
        counts
      },
      null,
      2
    )}\n`
  );
  if (!json) console.log(`已更新基线：${baselinePath}（${total} 处）`);
  else console.log(JSON.stringify({ updated: true, baselinePath, total, counts }, null, 2));
  process.exit(0);
}

const baseline = loadBaseline();
if (baseline === null) {
  const message = `缺少基线 ${baselinePath}；先运行 node scripts/audit-silent-catches.mjs --update-baseline`;
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(2);
}
const baselineTotal = Object.values(baseline).reduce((sum, value) => sum + value, 0);
const violations = Object.entries(counts)
  .filter(([file, count]) => count > (baseline[file] ?? 0))
  .map(([file, count]) => ({ file, count, baseline: baseline[file] ?? 0 }));

if (json) {
  console.log(
    JSON.stringify(
      { ok: violations.length === 0, total, baselineTotal, violations, counts },
      null,
      2
    )
  );
} else if (violations.length === 0) {
  console.log(`静默 catch：${total} 处（基线 ${baselineTotal}），无新增`);
} else {
  console.error(`静默 catch 超出基线：${total} 处（基线 ${baselineTotal}）`);
  for (const violation of violations) {
    console.error(
      `  ${violation.file}: ${violation.count} > ${violation.baseline}`
    );
  }
  console.error("请给关键路径加日志/审计，或显式更新基线（--update-baseline）");
}
process.exit(violations.length === 0 ? 0 : 1);
