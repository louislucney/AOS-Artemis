#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2).filter((arg) => arg !== "--json");
const asJson = process.argv.includes("--json");
if (roots.length === 0) {
  roots.push(path.join(process.cwd(), ".artemis"));
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name === "status.json" || entry.name === "run.json") {
      out.push(full);
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const byTrace = new Map();
for (const root of roots) {
  const absolute = path.resolve(root);
  const files = walk(fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? path.dirname(absolute) : absolute);
  for (const file of files) {
    const payload = readJson(file);
    if (payload === null || typeof payload !== "object") continue;
    const traceId = typeof payload.trace_id === "string" ? payload.trace_id : typeof payload.traceId === "string" ? payload.traceId : null;
    if (traceId === null || !traceId.startsWith("ios-")) continue;
    const platform = payload.platform;
    if (platform !== undefined && platform !== "ios") continue;
    const usage = Array.isArray(payload.token_usage) ? payload.token_usage : Array.isArray(payload.tokenUsage) ? payload.tokenUsage : [];
    const previous = byTrace.get(traceId);
    if (previous !== undefined && previous.usage.length >= usage.length && usage.length === 0) continue;
    byTrace.set(traceId, {
      traceId,
      status: typeof payload.status === "string" ? payload.status : null,
      start: typeof payload.start_time === "number" ? payload.start_time : typeof payload.started_at === "string" ? Date.parse(payload.started_at) / 1000 : null,
      end: typeof payload.end_time === "number" ? payload.end_time : typeof payload.finished_at === "string" ? Date.parse(payload.finished_at) / 1000 : null,
      usage,
      source: file
    });
  }
}

const rows = [...byTrace.values()].map((row) => {
  const prompts = row.usage.map((entry) => number(entry.promptTokens));
  const completions = row.usage.map((entry) => number(entry.completionTokens));
  const prompt = prompts.reduce((sum, value) => sum + value, 0);
  const completion = completions.reduce((sum, value) => sum + value, 0);
  const cacheCreate = row.usage.reduce((sum, entry) => sum + number(entry.cacheCreateTokens), 0);
  const cacheRead = row.usage.reduce((sum, entry) => sum + number(entry.cacheReadTokens), 0);
  return {
    traceId: row.traceId,
    status: row.status,
    start: row.start,
    end: row.end,
    calls: row.usage.length,
    prompt,
    completion,
    cacheCreate,
    cacheRead,
    ratio: completion === 0 ? null : Number((prompt / completion).toFixed(1)),
    maxPrompt: prompts.length === 0 ? null : Math.max(...prompts),
    p50Prompt: percentile(prompts, 50),
    p95Prompt: percentile(prompts, 95)
  };
}).sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.traceId.localeCompare(b.traceId));

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length === 0) {
  console.log("未找到带 token_usage 的 iOS trace。");
} else {
  console.log("traceId\tstatus\tcalls\tprompt\tcompletion\tprompt/completion\tmaxPrompt\tp50Prompt\tp95Prompt\tcacheRead");
  for (const row of rows) {
    console.log([
      row.traceId,
      row.status ?? "-",
      String(row.calls),
      String(row.prompt),
      String(row.completion),
      row.ratio === null ? "-" : String(row.ratio),
      row.maxPrompt === null ? "-" : String(row.maxPrompt),
      row.p50Prompt === null ? "-" : String(row.p50Prompt),
      row.p95Prompt === null ? "-" : String(row.p95Prompt),
      String(row.cacheRead)
    ].join("\t"));
  }
  const totalPrompt = rows.reduce((sum, row) => sum + row.prompt, 0);
  const totalCompletion = rows.reduce((sum, row) => sum + row.completion, 0);
  console.log(`\n合计: traces=${rows.length} prompt=${totalPrompt} completion=${totalCompletion} ratio=${totalCompletion === 0 ? "-" : (totalPrompt / totalCompletion).toFixed(1)}`);
}
