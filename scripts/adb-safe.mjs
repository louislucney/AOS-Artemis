#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = { ok: 0, usage: 2, device: 3, failed: 4, timeout: 124, noAdb: 125 };
const GRACE_MS = 2000;
const DEFAULT_TIMEOUT_MS = {
  devices: 10_000,
  wait: 60_000,
  install: 300_000,
  shell: 60_000,
  push: 180_000,
  pull: 180_000,
  screencap: 30_000
};
const FLAG_NAMES = new Set(["serial", "timeout", "json", "force", "test", "streaming"]);
const PM_INSTALL_PATTERN = /\bpm\s+install\b/;
const TRANSIENT_PATTERN =
  /(device offline|device not found|no devices|closed|protocol fault|transport error|connection reset)/i;

const HELP = `adb-safe — 带硬超时与进程组清理的 adb 包装器（项目内禁止裸 adb）

用法:
  node tools/adb-safe.mjs devices [--json]
  node tools/adb-safe.mjs wait [--timeout 60]
  node tools/adb-safe.mjs install <apk> [--test] [--streaming] [--timeout 300]
  node tools/adb-safe.mjs shell <命令...> [--timeout 60]
  node tools/adb-safe.mjs screencap <out.png> [--timeout 30]
  node tools/adb-safe.mjs push <本地> <设备路径> [--timeout 180]
  node tools/adb-safe.mjs pull <设备路径> <本地> [--timeout 180]

通用选项:
  --serial <S>    指定设备；缺省 ANDROID_SERIAL → 唯一在线设备
  --timeout <秒>  单次命令硬超时（默认按子命令：install 300 / shell 60 / 其余见文档）
  --json          输出结构化 JSON（stdout 只含 JSON）
  --force         shell 中允许执行 pm install（默认拦截，改用 install 子命令）

约定:
  - install 默认使用 push 安装（--no-streaming）；部分机型（如 vivo）streamed 安装会误报
    INSTALL_FAILED_ABORTED: User rejected permissions，需要 --streaming 时才显式开启
  - 命令含 -- 开头的参数时，请写成单个引号参数或用 -- 结束选项解析
  - shell 透传远端退出码；超时返回 124（进程组已清理，可安全重试）
  - 退出码: 0 成功 / 2 用法 / 3 设备 / 4 命令失败 / 124 超时 / 125 adb 缺失
`;

function fail(message, code) {
  process.stderr.write(`[adb-safe] ${message}\n`);
  process.exit(code);
}

function printHelp() {
  process.stdout.write(HELP);
}

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "--help" || token === "-h") {
      flags.help = true;
      i += 1;
      continue;
    }
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(token);
    if (match) {
      const name = match[1];
      if (!FLAG_NAMES.has(name)) fail(`未知选项 --${name}`, EXIT.usage);
      if (name === "json" || name === "force" || name === "test" || name === "streaming") {
        flags[name] = true;
      } else {
        const inline = match[2];
        const value = inline ?? argv[i + 1];
        if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
          fail(`选项 --${name} 缺少取值`, EXIT.usage);
        }
        flags[name] = value;
        if (inline === undefined) i += 1;
      }
      i += 1;
      continue;
    }
    positionals.push(token);
    i += 1;
  }
  return { positionals, flags };
}

function readLocalPropertiesSdk() {
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const text = fs.readFileSync(path.join(projectRoot, "local.properties"), "utf-8");
    const match = /^\s*sdk\.dir\s*=\s*(.+?)\s*$/m.exec(text);
    if (match) return match[1].replace(/\\\\/g, "\\");
  } catch {
    /* ignore */
  }
  return null;
}

function resolveAdbPath(env = process.env) {
  const binary = process.platform === "win32" ? "adb.exe" : "adb";
  const explicit = (env.AOS_ADB_PATH ?? env.ARTEMIS_ADB_PATH ?? "").trim();
  if (explicit !== "") return explicit;
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, readLocalPropertiesSdk()];
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  roots.push(
    process.platform === "win32" && localAppData !== "" ? path.join(localAppData, "Android", "Sdk") : null,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk")
  );
  for (const root of roots) {
    const trimmed = (root ?? "").trim();
    if (trimmed === "") continue;
    const candidate = path.join(trimmed, "platform-tools", binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return binary;
}

function killTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

function runAdb(adbPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(adbPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    let bailTimer = null;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (bailTimer) clearTimeout(bailTimer);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        timedOut,
        elapsedMs: Date.now() - startedAt,
        error
      });
    };
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), GRACE_MS);
      bailTimer = setTimeout(() => finish(null, "timeout"), GRACE_MS + 1000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => finish(null, error instanceof Error ? error.message : String(error)));
    child.on("close", (code) => finish(code));
  });
}

function parseDevices(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(\S+)\s+(device|offline|unauthorized|bootloader|recovery|sideload)$/.exec(line);
    if (match) entries.push({ serial: match[1], state: match[2] });
  }
  return entries;
}

async function listDevices(adbPath, timeoutMs) {
  const result = await runAdb(adbPath, ["devices"], timeoutMs);
  if (result.error && /ENOENT/i.test(result.error)) return { entries: [], result, adbMissing: true };
  return { entries: parseDevices(result.stdout.toString("utf-8")), result, adbMissing: false };
}

async function resolveSerial(adbPath, flags, timeoutMs) {
  const explicit = typeof flags.serial === "string" ? flags.serial.trim() : "";
  if (explicit !== "") return explicit;
  const envSerial = (process.env.ANDROID_SERIAL ?? "").trim();
  if (envSerial !== "") return envSerial;
  const { entries, result, adbMissing } = await listDevices(adbPath, DEFAULT_TIMEOUT_MS.devices);
  if (adbMissing) fail(`未找到 adb（可用 AOS_ADB_PATH / ARTEMIS_ADB_PATH / ANDROID_HOME 指定）: ${result.error}`, EXIT.noAdb);
  if (result.timedOut) fail("adb devices 超时，无法确认设备状态", EXIT.timeout);
  const online = entries.filter((entry) => entry.state === "device").map((entry) => entry.serial);
  if (online.length === 1) return online[0];
  if (online.length === 0) {
    const detail = entries.length > 0 ? entries.map((entry) => `${entry.serial}(${entry.state})`).join(", ") : "无设备";
    fail(`没有在线设备（${detail}）；请检查连接或运行 mobile_diagnose`, EXIT.device);
  }
  fail(`检测到多台在线设备，请用 --serial 指定：${online.join(", ")}`, EXIT.device);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitResult(flags, payload) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (payload.stdout) process.stdout.write(payload.stdout);
  if (payload.stderrText) process.stderr.write(payload.stderrText);
  const state = payload.timedOut ? "TIMEOUT" : payload.ok ? "ok" : "failed";
  process.stderr.write(
    `[adb-safe] ${state} cmd="${payload.cmd}"${payload.serial ? ` serial=${payload.serial}` : ""} ` +
      `code=${payload.code ?? "-"} elapsed=${(payload.elapsedMs / 1000).toFixed(1)}s\n`
  );
}

function timeoutExit(result) {
  if (result.timedOut) {
    process.stderr.write(`[adb-safe] 超时 ${(result.elapsedMs / 1000).toFixed(1)}s，已终止进程组\n`);
    return EXIT.timeout;
  }
  return null;
}

async function cmdDevices(adbPath, flags) {
  const timeoutMs = 10_000;
  const result = await runAdb(adbPath, ["devices"], timeoutMs);
  if (result.error && /ENOENT/i.test(result.error)) {
    emitResult(flags, { ok: false, cmd: "adb devices", code: null, timedOut: false, elapsedMs: result.elapsedMs, error: result.error });
    return EXIT.noAdb;
  }
  const entries = parseDevices(result.stdout.toString("utf-8"));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: !result.timedOut && result.code === 0, entries, code: result.code, timedOut: result.timedOut, elapsedMs: result.elapsedMs })}\n`);
    return result.timedOut ? EXIT.timeout : result.code === 0 ? EXIT.ok : EXIT.failed;
  }
  process.stdout.write(result.stdout);
  return timeoutExit(result) ?? (result.code === 0 ? EXIT.ok : EXIT.failed);
}

async function cmdWait(adbPath, flags) {
  const serial = typeof flags.serial === "string" ? flags.serial.trim() : "";
  const args = serial !== "" ? ["-s", serial, "wait-for-device"] : ["wait-for-device"];
  const timeoutMs = resolveTimeoutMs(flags, "wait");
  const result = await runAdb(adbPath, args, timeoutMs);
  if (result.error && /ENOENT/i.test(result.error)) return EXIT.noAdb;
  const timedOut = timeoutExit(result);
  if (timedOut !== null) return timedOut;
  return result.code === 0 ? EXIT.ok : EXIT.failed;
}

function resolveTimeoutMs(flags, sub) {
  const raw = flags.timeout;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS[sub];
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) fail(`--timeout 需为正数秒：${raw}`, EXIT.usage);
  return Math.trunc(seconds * 1000);
}

async function cmdInstall(adbPath, flags, positionals) {
  const apk = positionals[0];
  if (!apk || positionals.length > 1) fail("用法: install <apk> [--test] [--streaming]", EXIT.usage);
  if (!fs.existsSync(apk)) fail(`APK 不存在: ${apk}`, EXIT.usage);
  const serial = await resolveSerial(adbPath, flags, DEFAULT_TIMEOUT_MS.devices);
  const timeoutMs = resolveTimeoutMs(flags, "install");
  const args = ["-s", serial, "install", "-r", "-d"];
  if (flags.test) args.push("-t");
  if (!flags.streaming) args.push("--no-streaming");
  args.push(apk);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const result = await runAdb(adbPath, args, timeoutMs);
    const stdout = result.stdout.toString("utf-8").trim();
    const stderr = result.stderr.toString("utf-8").trim();
    const ok = !result.timedOut && result.code === 0 && /Success/i.test(stdout);
    const payload = {
      ok,
      cmd: `adb install -r -d ${apk}`,
      serial,
      code: result.code,
      timedOut: result.timedOut,
      elapsedMs: result.elapsedMs,
      stdout,
      stderrText: stderr
    };
    if (result.timedOut) {
      emitResult(flags, payload);
      process.stderr.write("[adb-safe] 设备侧可能已完成安装；请用 `shell pm path <包名>` 或重新运行本命令核对\n");
      return EXIT.timeout;
    }
    if (ok) {
      emitResult(flags, payload);
      return EXIT.ok;
    }
    const transient = TRANSIENT_PATTERN.test(`${stdout}\n${stderr}`);
    if (attempt === 1 && transient) {
      process.stderr.write(`[adb-safe] 瞬时失败（${stdout || stderr}），3s 后重试一次\n`);
      await sleep(3000);
      continue;
    }
    emitResult(flags, payload);
    return EXIT.failed;
  }
}

async function cmdShell(adbPath, flags, positionals) {
  if (positionals.length === 0) fail("用法: shell <命令...>", EXIT.usage);
  const remote = positionals.join(" ");
  if (!flags.force && PM_INSTALL_PATTERN.test(remote)) {
    fail("禁止 `adb shell pm install`（会 FD 假死）；请改用 `adb-safe install <apk>`", EXIT.usage);
  }
  const serial = await resolveSerial(adbPath, flags, DEFAULT_TIMEOUT_MS.devices);
  const timeoutMs = resolveTimeoutMs(flags, "shell");
  const result = await runAdb(adbPath, ["-s", serial, "shell", remote], timeoutMs);
  if (result.error && /ENOENT/i.test(result.error)) fail(`未找到 adb: ${result.error}`, EXIT.noAdb);
  const payload = {
    ok: !result.timedOut && result.code === 0,
    cmd: `adb -s ${serial} shell ${remote}`,
    serial,
    code: result.code,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    stdout: result.stdout.toString("utf-8"),
    stderrText: result.stderr.toString("utf-8")
  };
  if (flags.json) {
    emitResult(flags, payload);
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  if (result.timedOut) return timeoutExit(result);
  if (result.code === null) return EXIT.failed;
  return result.code;
}

async function cmdScreencap(adbPath, flags, positionals) {
  const outPath = positionals[0];
  if (!outPath || positionals.length > 1) fail("用法: screencap <out.png>", EXIT.usage);
  const serial = await resolveSerial(adbPath, flags, DEFAULT_TIMEOUT_MS.devices);
  const timeoutMs = resolveTimeoutMs(flags, "screencap");
  const result = await runAdb(adbPath, ["-s", serial, "exec-out", "screencap", "-p"], timeoutMs);
  if (result.timedOut) {
    emitResult(flags, { ok: false, cmd: `adb -s ${serial} exec-out screencap -p`, serial, code: null, timedOut: true, elapsedMs: result.elapsedMs, stdout: "", stderrText: "" });
    return timeoutExit(result);
  }
  const png = result.stdout;
  if (result.code !== 0 || png.length < 8 || png[0] !== 0x89 || png.toString("latin1", 1, 4) !== "PNG") {
    emitResult(flags, {
      ok: false,
      cmd: `adb -s ${serial} exec-out screencap -p`,
      serial,
      code: result.code,
      timedOut: false,
      elapsedMs: result.elapsedMs,
      stdout: "",
      stderrText: result.stderr.toString("utf-8")
    });
    process.stderr.write("[adb-safe] 截图失败：输出不是 PNG\n");
    return EXIT.failed;
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, png);
  emitResult(flags, {
    ok: true,
    cmd: `adb -s ${serial} exec-out screencap -p`,
    serial,
    code: 0,
    timedOut: false,
    elapsedMs: result.elapsedMs,
    stdout: `${outPath} (${png.length} bytes)\n`,
    stderrText: ""
  });
  return EXIT.ok;
}

async function cmdTransfer(adbPath, flags, positionals, sub) {
  if (positionals.length !== 2) fail(`用法: ${sub} <源> <目标>`, EXIT.usage);
  const serial = await resolveSerial(adbPath, flags, DEFAULT_TIMEOUT_MS.devices);
  const timeoutMs = resolveTimeoutMs(flags, sub);
  const result = await runAdb(adbPath, ["-s", serial, sub, positionals[0], positionals[1]], timeoutMs);
  if (result.error && /ENOENT/i.test(result.error)) fail(`未找到 adb: ${result.error}`, EXIT.noAdb);
  const stdout = result.stdout.toString("utf-8").trim();
  const stderr = result.stderr.toString("utf-8").trim();
  emitResult(flags, {
    ok: !result.timedOut && result.code === 0,
    cmd: `adb -s ${serial} ${sub} ${positionals[0]} ${positionals[1]}`,
    serial,
    code: result.code,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    stdout: `${stdout}\n`,
    stderrText: stderr
  });
  if (result.timedOut) return timeoutExit(result);
  return result.code === 0 ? EXIT.ok : EXIT.failed;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp();
    return EXIT.ok;
  }
  const sub = argv[0];
  if (sub.startsWith("-")) fail(`缺少子命令；可用: devices|wait|install|shell|screencap|push|pull`, EXIT.usage);
  const { positionals, flags } = parseArgv(argv.slice(1));
  if (flags.help) {
    printHelp();
    return EXIT.ok;
  }
  if (!(sub in DEFAULT_TIMEOUT_MS)) fail(`未知子命令: ${sub}`, EXIT.usage);
  const adbPath = resolveAdbPath(process.env);
  switch (sub) {
    case "devices":
      return cmdDevices(adbPath, flags);
    case "wait":
      return cmdWait(adbPath, flags);
    case "install":
      return cmdInstall(adbPath, flags, positionals);
    case "shell":
      return cmdShell(adbPath, flags, positionals);
    case "screencap":
      return cmdScreencap(adbPath, flags, positionals);
    case "push":
    case "pull":
      return cmdTransfer(adbPath, flags, positionals, sub);
    default:
      fail(`未知子命令: ${sub}`, EXIT.usage);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[adb-safe] 内部错误: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = EXIT.failed;
  });
