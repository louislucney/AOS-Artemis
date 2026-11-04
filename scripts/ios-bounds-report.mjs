#!/usr/bin/env node
/**
 * iOS UI 树 bounds 覆盖率报告（Task 0 真机前置验证）。
 *
 * 读取 AOS iOS trace 的 run.json（可传 trace 目录或 run.json 文件），统计
 * `steps[].texts` 中带有效 x/y/width/height 的文本节点比例。只读，不连设备。
 *
 * 用法：
 *   node scripts/ios-bounds-report.mjs [--json] [trace-dir|run.json ...]
 * 缺省扫描当前项目 `.artemis/traces`。exit 0 有样本 / 2 无样本或读取失败。
 */
import fs from "node:fs";
import path from "node:path";

function usage() {
  return [
    "用法: node scripts/ios-bounds-report.mjs [--json] [trace-dir|run.json ...]",
    "",
    "扫描 iOS run.json 的 steps[].texts，报告文本节点 bbox 覆盖率；",
    "缺省目录：<cwd>/.artemis/traces。"
  ].join("\n");
}

function collectRunFiles(targets) {
  const files = [];
  for (const target of targets) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (path.basename(target) === "run.json") files.push(target);
      continue;
    }
    const direct = path.join(target, "run.json");
    if (fs.existsSync(direct)) {
      files.push(direct);
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(target, entry.name, "run.json");
      if (fs.existsSync(candidate)) files.push(candidate);
    }
  }
  return [...new Set(files)].sort();
}

function hasBounds(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const values = [item.x, item.y, item.width, item.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return false;
  }
  return item.width > 0 && item.height > 0;
}

function scan(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  let total = 0;
  let withBounds = 0;
  const missing = [];
  for (const step of steps) {
    const texts = Array.isArray(step?.texts) ? step.texts : [];
    for (const item of texts) {
      total += 1;
      if (hasBounds(item)) {
        withBounds += 1;
      } else if (missing.length < 5) {
        const text = typeof item?.text === "string" ? item.text : "(无文本)";
        missing.push(text.slice(0, 60));
      }
    }
  }
  return {
    file,
    traceId: typeof parsed?.trace_id === "string" ? parsed.trace_id : null,
    steps: steps.length,
    total,
    withBounds,
    withoutBounds: total - withBounds,
    coverage: total === 0 ? null : withBounds / total,
    missingSamples: missing
  };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const json = args.includes("--json");
  const targets = args.filter((arg) => !arg.startsWith("-"));
  const roots = targets.length > 0 ? targets : [path.join(process.cwd(), ".artemis", "traces")];
  const files = collectRunFiles(roots);
  if (files.length === 0) {
    console.error(`未找到 iOS run.json：${roots.join(", ")}`);
    return 2;
  }
  let reports;
  try {
    reports = files.map(scan);
  } catch (error) {
    console.error(`读取失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const total = reports.reduce((sum, report) => sum + report.total, 0);
  const withBounds = reports.reduce((sum, report) => sum + report.withBounds, 0);
  const overall = total === 0 ? null : withBounds / total;
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          traces: reports,
          summary: {
            traces: reports.length,
            total,
            withBounds,
            withoutBounds: total - withBounds,
            coverage: overall
          }
        },
        null,
        2
      )
    );
    return 0;
  }
  for (const report of reports) {
    console.log(
      `${report.traceId ?? path.basename(path.dirname(report.file))}: ` +
        `steps=${report.steps} texts=${report.total} bounds=${report.withBounds} ` +
        `coverage=${percent(report.coverage)}`
    );
    for (const sample of report.missingSamples) console.log(`  缺 bounds: ${sample}`);
  }
  console.log(`总计: traces=${reports.length} texts=${total} bounds=${withBounds} coverage=${percent(overall)}`);
  return 0;
}

process.exitCode = main();
