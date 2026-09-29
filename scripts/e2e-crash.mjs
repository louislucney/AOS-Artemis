#!/usr/bin/env node
/**
 * Crash-triage manual acceptance script (real device, manual run).
 *
 *   node scripts/e2e-crash.mjs --package com.example.app [--serial emulator-5554] [--project <dir>] [--collect-only] [--wait 3]
 *
 * Prerequisites:
 *   - npm run build (the script imports dist/crash/*)
 *   - adb available with an authorized device attached
 *
 * What it does: triggers a real crash via `adb shell am crash <pkg>` (unless
 * --collect-only), collects the device crash buffer with the production
 * collector, parses signatures with the production parser, and optionally
 * writes them into <project>/.artemis/crashes so `aos_crashes list` shows them.
 *
 * Exits: 0 = crash captured and parsed, 1 = no crash found, 2 = usage/infra error.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(message) {
  console.error(message);
  console.error(
    'Usage: node scripts/e2e-crash.mjs --package <pkg> [--serial <serial>] [--project <dir>] [--collect-only] [--wait <seconds>]'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { package: null, serial: null, project: null, collectOnly: false, waitSeconds: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--package") args.package = argv[++i] ?? null;
    else if (token === "--serial") args.serial = argv[++i] ?? null;
    else if (token === "--project") args.project = argv[++i] ?? null;
    else if (token === "--collect-only") args.collectOnly = true;
    else if (token === "--wait") args.waitSeconds = Number(argv[++i] ?? "3");
    else usage(`未知参数: ${token}`);
  }
  if (!args.package) usage("缺少 --package <应用包名>");
  if (!Number.isFinite(args.waitSeconds) || args.waitSeconds < 0) usage("--wait 需要是秒数");
  args.project = path.resolve(args.project ?? process.env.AOS_PROJECT_DIR ?? process.cwd());
  return args;
}

const args = parseArgs(process.argv.slice(2));

const distDir = path.join(repoRoot, "dist");
for (const modulePath of ["crash/collect.js", "crash/parse.js", "crash/store.js"]) {
  if (!fs.existsSync(path.join(distDir, modulePath))) {
    usage(`缺少 ${path.join("dist", modulePath)}：请先运行 npm run build`);
  }
}

const { AdbCrashCollector, resolveAdbPath } = await import(
  pathToFileURL(path.join(distDir, "crash", "collect.js")).href
);
const { parseLogcatCrashes } = await import(
  pathToFileURL(path.join(distDir, "crash", "parse.js")).href
);
const { CrashIndexStore } = await import(
  pathToFileURL(path.join(distDir, "crash", "store.js")).href
);

const adb = resolveAdbPath(process.env, process.platform);
const collector = new AdbCrashCollector({ env: process.env });
const devices = await collector.listDevices(adb.path);
if (!devices.ok) usage(`adb devices 失败: ${devices.error ?? "unknown"}`);
console.log(`[1/5] adb=${adb.path} devices=[${devices.devices.join(", ")}]`);

const serial = args.serial ?? (devices.devices.length === 1 ? devices.devices[0] : null);
if (!serial) usage("设备不唯一，请用 --serial <serial> 指定");
if (!devices.devices.includes(serial)) usage(`设备 ${serial} 未授权/不在线`);
console.log(`[1/5] serial=${serial} package=${args.package}`);

const startedAt = Date.now();
if (args.collectOnly) {
  console.log("[2/5] 跳过触发（--collect-only）");
} else {
  const crash = spawnSync(
    adb.path,
    ["-s", serial, "shell", "am", "crash", args.package],
    { encoding: "utf-8", timeout: 15_000 }
  );
  const detail = `${crash.stdout ?? ""}${crash.stderr ?? ""}`.trim();
  if (crash.status !== 0) {
    console.error(`[2/5] am crash 失败（部分 OEM 不支持）: ${detail || crash.error?.message || "unknown"}`);
    console.error(`      可手动触发崩溃后重跑：node scripts/e2e-crash.mjs --package ${args.package} --serial ${serial} --collect-only`);
    console.error(`      例如: adb -s ${serial} shell monkey -p ${args.package} --pct-syskeys 0 500`);
    process.exit(2);
  }
  console.log(`[2/5] 已触发崩溃: ${detail || args.package}`);
}

await sleep(args.waitSeconds * 1000);

const windowStartMs = startedAt - 60_000;
const windowEndMs = Date.now();
const collected = await collector.collect({
  serial,
  windowStartMs,
  windowEndMs,
  targetPackage: args.package
});
if (collected.status !== "ok") {
  console.error(`[3/5] 采集失败: ${collected.reason}`);
  process.exit(2);
}
console.log(
  `[3/5] source=${collected.source} logs=${(collected.text ?? "").length}B ` +
    `clockOffsetMs=${collected.clockOffsetMs ?? 0}${collected.clockWarning ? " (时钟探测失败)" : ""}`
);

const crashes = parseLogcatCrashes(collected.text ?? "", {
  windowStartMs,
  windowEndMs,
  clockOffsetMs: collected.clockOffsetMs ?? 0,
  packageFilter: args.package
});
if (crashes.length === 0) {
  console.error("[4/5] 未解析到该包在窗口内的崩溃签名。日志片段（供排查）:");
  console.error((collected.text ?? "").split(/\r?\n/).slice(-30).join("\n"));
  process.exit(1);
}

console.log(`[4/5] 解析到 ${crashes.length} 条崩溃:`);
for (const crash of crashes) {
  console.log(
    `  - id=${crash.signature} kind=${crash.kind} pkg=${crash.package}\n` +
      `    ${crash.exceptionClass}: ${crash.message}\n` +
      `    top=${crash.topFrame}`
  );
}

const store = new CrashIndexStore(path.join(args.project, ".artemis", "crashes"));
const upsert = store.upsert(crashes, {
  traceId: `manual-e2e-${startedAt}`,
  taskOutcome: "manual",
  deviceSerial: serial,
  capturedAt: new Date().toISOString(),
  source: collected.source ?? "crash-buffer"
});
console.log(
  `[5/5] 已写入 ${store.dirPath}（new=${upsert.newIds.length} updated=${upsert.updatedIds.length}）`
);
console.log("在 IDE 中调用 aos_crashes(action=list) 可查看签名。");
process.exit(0);
