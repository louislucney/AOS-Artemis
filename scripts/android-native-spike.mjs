#!/usr/bin/env node
/**
 * Android 原生执行层 Phase 0 Spike。
 *
 * 只验证底层能力，不接 LLM、不跑测试用例：
 *   1. ADBKeyboard 安装 / IME 切换
 *   2. ADB_INPUT_B64 中文广播输入
 *   3. UI tree dump 耗时（raw 基线）
 *   4. 可见性过滤后的文本断言
 *
 * 示例（Windows runner）：
 *   node scripts/android-native-spike.mjs ^
 *     --device 10CF6609P900059 ^
 *     --adb "C:\...\adb.exe" ^
 *     --adbkeyboard-apk C:\...\ADBKeyboard.apk ^
 *     --package com.android.settings ^
 *     --tap 540,300 ^
 *     --text "中文测试 AOS" ^
 *     --expect "中文测试" ^
 *     --rounds 5 --json
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function decodeXmlEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

export function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value ?? ""));
  if (!match) return null;
  const [, x1, y1, x2, y2] = match;
  return {
    x1: Number(x1),
    y1: Number(y1),
    x2: Number(x2),
    y2: Number(y2)
  };
}

export function parseUiXml(xml) {
  const source = String(xml);
  const nodes = [];
  const nodePattern = /<node\b([^>]*?)\/?>/g;
  for (const match of source.matchAll(nodePattern)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = decodeXmlEntities(attr[2]);
    }
    const bounds = parseBounds(attrs.bounds);
    nodes.push({
      text: attrs.text ?? "",
      contentDesc: attrs["content-desc"] ?? "",
      resourceId: attrs["resource-id"] ?? "",
      className: attrs.class ?? "",
      clickable: attrs.clickable === "true",
      enabled: attrs.enabled !== "false",
      visibleToUser: attrs["visible-to-user"] !== "false",
      bounds
    });
  }
  return nodes;
}

export function visibleTexts(nodes, screen) {
  const out = new Set();
  for (const node of nodes) {
    if (!node.visibleToUser) continue;
    if (screen && node.bounds) {
      const { x1, y1, x2, y2 } = node.bounds;
      if (x2 <= 0 || y2 <= 0 || x1 >= screen.width || y1 >= screen.height) continue;
    }
    for (const value of [node.text, node.contentDesc]) {
      const text = value.trim();
      if (text !== "") out.add(text);
    }
  }
  return out;
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function base64Text(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function parseArgs(argv) {
  const args = {
    device: "",
    adb: process.platform === "win32" ? "adb.exe" : "adb",
    adbkeyboardApk: "",
    packageName: "",
    activity: "",
    tap: "",
    text: "中文测试 AOS",
    expect: "",
    rounds: 5,
    clear: true,
    maxDumpP95Ms: 1000,
    maxStepP95Ms: 2000,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      return argv[index] ?? "";
    };
    switch (token) {
      case "--device":
        args.device = next();
        break;
      case "--adb":
        args.adb = next();
        break;
      case "--adbkeyboard-apk":
        args.adbkeyboardApk = next();
        break;
      case "--package":
        args.packageName = next();
        break;
      case "--activity":
        args.activity = next();
        break;
      case "--tap":
        args.tap = next();
        break;
      case "--text":
        args.text = next();
        break;
      case "--expect":
        args.expect = next();
        break;
      case "--rounds":
        args.rounds = Math.max(1, Number(next()) || 1);
        break;
      case "--no-clear":
        args.clear = false;
        break;
      case "--max-dump-p95-ms":
        args.maxDumpP95Ms = Math.max(1, Number(next()) || 1);
        break;
      case "--max-step-p95-ms":
        args.maxStepP95Ms = Math.max(1, Number(next()) || 1);
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${token}`);
    }
  }
  if (!args.device) throw new Error("缺少 --device <serial>");
  if (!args.expect) args.expect = args.text;
  return args;
}

function printHelp() {
  console.log(`Android 原生执行层 Phase 0 Spike

必填：
  --device <serial>           adb 设备 serial
可选：
  --adb <path>                adb 可执行文件（默认 adb / adb.exe）
  --adbkeyboard-apk <path>    需要安装时提供 ADBKeyboard.apk
  --package <pkg>             先启动的应用包名
  --activity <activity>       配合 --package 启动的 Activity
  --tap <x,y>                 启动后点击坐标（聚焦输入框）
  --text <text>               广播输入的中文文本
  --expect <text>             可见性断言的期望文本（默认同 --text）
  --rounds <n>                轮数（默认 5）
  --no-clear                  输入前不广播 ADB_CLEAR_TEXT
  --max-dump-p95-ms <n>       dump p95 门槛（默认 1000）
  --max-step-p95-ms <n>       单步 p95 门槛（默认 2000）
  --json                      JSON 输出
`);
}

function runAdb(args, adbPath, serial) {
  return execFileSync(adbPath, ["-s", serial, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenSize(adbPath, serial) {
  try {
    const output = runAdb(["shell", "wm", "size"], adbPath, serial);
    const match = /(\d+)x(\d+)/.exec(output);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    /* fall through */
  }
  return { width: 1080, height: 1920 };
}

function dumpUi(adbPath, serial) {
  const started = Date.now();
  let xml = "";
  try {
    xml = runAdb(["exec-out", "uiautomator", "dump", "/dev/tty"], adbPath, serial);
  } catch {
    runAdb(["shell", "uiautomator", "dump", "/sdcard/aos-spike.xml"], adbPath, serial);
    xml = runAdb(["exec-out", "cat", "/sdcard/aos-spike.xml"], adbPath, serial);
  }
  const start = xml.indexOf("<hierarchy");
  const end = xml.lastIndexOf("</hierarchy>");
  const body = start >= 0 && end > start ? xml.slice(start, end + "</hierarchy>".length) : xml;
  return { xml: body, ms: Date.now() - started };
}

function currentIme(adbPath, serial) {
  return runAdb(["shell", "settings", "get", "secure", "default_input_method"], adbPath, serial).trim();
}

function setIme(adbPath, serial, ime) {
  runAdb(["shell", "ime", "set", ime], adbPath, serial);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = {
    ok: false,
    device: args.device,
    rounds: args.rounds,
    input: { ime: null, adbKeyboardInstalled: null, restoredIme: null },
    dump: { samplesMs: [], p50Ms: 0, p95Ms: 0 },
    step: { samplesMs: [], p50Ms: 0, p95Ms: 0 },
    passes: 0,
    failures: [],
    environmentErrors: []
  };
  let originalIme = "";
  try {
    runAdb(["get-state"], args.adb, args.device);
    const screen = screenSize(args.adb, args.device);

    if (args.adbkeyboardApk) {
      runAdb(["install", "-r", path.resolve(args.adbkeyboardApk)], args.adb, args.device);
    }
    const packages = runAdb(["shell", "pm", "list", "packages", "com.android.adbkeyboard"], args.adb, args.device);
    result.input.adbKeyboardInstalled = /package:com\.android\.adbkeyboard/.test(packages);
    if (!result.input.adbKeyboardInstalled) {
      throw Object.assign(new Error("ADBKeyboard 未安装"), { code: "environment/ime-unavailable" });
    }

    originalIme = currentIme(args.adb, args.device);
    setIme(args.adb, args.device, "com.android.adbkeyboard/.AdbIME");
    const activeIme = currentIme(args.adb, args.device);
    result.input.ime = activeIme;
    if (!activeIme.includes("com.android.adbkeyboard")) {
      throw Object.assign(new Error("IME 切换失败"), { code: "environment/ime-unavailable" });
    }

    if (args.packageName) {
      runAdb(["shell", "am", "force-stop", args.packageName], args.adb, args.device);
      if (args.activity) {
        runAdb(
          ["shell", "am", "start", "-n", `${args.packageName}/${args.activity}`],
          args.adb,
          args.device
        );
      } else {
        runAdb(
          [
            "shell",
            "monkey",
            "-p",
            args.packageName,
            "-c",
            "android.intent.category.LAUNCHER",
            "1"
          ],
          args.adb,
          args.device
        );
      }
      await sleep(1200);
    }
    if (args.tap) {
      const [x, y] = args.tap.split(",").map((value) => Number(value.trim()));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`--tap 坐标无效：${args.tap}`);
      }
      runAdb(["shell", "input", "tap", String(x), String(y)], args.adb, args.device);
      await sleep(300);
    }

    for (let round = 1; round <= args.rounds; round += 1) {
      const stepStarted = Date.now();
      try {
        if (args.clear) {
          runAdb(["shell", "am", "broadcast", "-a", "ADB_CLEAR_TEXT"], args.adb, args.device);
        }
        runAdb(
          [
            "shell",
            "am",
            "broadcast",
            "-a",
            "ADB_INPUT_B64",
            "--es",
            "msg",
            base64Text(args.text)
          ],
          args.adb,
          args.device
        );
        await sleep(400);
        const dump = dumpUi(args.adb, args.device);
        result.dump.samplesMs.push(dump.ms);
        const nodes = parseUiXml(dump.xml);
        const texts = visibleTexts(nodes, screen);
        const found = [...texts].some((text) => text.includes(args.expect));
        if (!found) {
          result.failures.push({
            round,
            reason: "visible-text-missing",
            expected: args.expect,
            samples: [...texts].slice(0, 20)
          });
        } else {
          result.passes += 1;
        }
      } catch (error) {
        result.failures.push({
          round,
          reason: error && error.code ? error.code : "round-error",
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        result.step.samplesMs.push(Date.now() - stepStarted);
      }
    }

    result.dump.p50Ms = percentile(result.dump.samplesMs, 50);
    result.dump.p95Ms = percentile(result.dump.samplesMs, 95);
    result.step.p50Ms = percentile(result.step.samplesMs, 50);
    result.step.p95Ms = percentile(result.step.samplesMs, 95);
    result.ok =
      result.passes === args.rounds &&
      result.dump.p95Ms <= args.maxDumpP95Ms &&
      result.step.p95Ms <= args.maxStepP95Ms &&
      result.environmentErrors.length === 0;
  } catch (error) {
    result.environmentErrors.push({
      code: error && error.code ? error.code : "environment/unknown",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (originalIme) {
      try {
        setIme(args.adb, args.device, originalIme);
        result.input.restoredIme = originalIme;
      } catch {
        result.input.restoredIme = null;
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`device: ${result.device}`);
    console.log(`rounds: ${result.passes}/${result.rounds}`);
    console.log(`dump: p50=${result.dump.p50Ms}ms p95=${result.dump.p95Ms}ms`);
    console.log(`step: p50=${result.step.p50Ms}ms p95=${result.step.p95Ms}ms`);
    if (result.failures.length > 0) console.log(`failures: ${JSON.stringify(result.failures)}`);
    if (result.environmentErrors.length > 0) {
      console.log(`environment: ${JSON.stringify(result.environmentErrors)}`);
    }
  }
  if (result.environmentErrors.length > 0) process.exit(2);
  process.exit(result.ok ? 0 : 1);
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
