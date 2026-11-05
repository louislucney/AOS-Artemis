import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecFn, ExecResult } from "../device/adb.js";
import { errorMessage } from "../util.js";
import type { WebJobSpec } from "../web/job-spec.js";

export type WebJobCaseStatus = "PASS" | "FAIL" | "SKIP" | "ERROR";

export interface WebJobExecutionCase {
  caseId: string;
  name: string;
  status: WebJobCaseStatus;
  durationMs: number;
  failureStep?: string;
  failureReason?: string;
  screenshotPaths?: string[];
  logPath?: string;
  /** 顶层 flow 中硬断言命令条数（中心判定 PASS 的证据）。 */
  assertionCount?: number;
  /** 顶层 flow 中可提取文本的 visible/notVisible 断言（用于覆盖 soft text 预期）。 */
  assertions?: FlowAssertion[];
  /** 顶层 flow 中 `# aos:manual` 标记的未映射步骤。 */
  manualSteps?: Array<{ step: number; reason: string }>;
}

export interface FlowAssertion {
  type: "visible" | "notVisible";
  text: string;
}

export interface WebJobExecutionResult {
  status: "passed" | "failed" | "partial" | "error";
  cases: WebJobExecutionCase[];
  startedAt: string;
  finishedAt: string;
  detail: string | null;
  /** 失败时抓取的设备诊断文件（logcat / window / screenshot）；路径相对 jobDir。 */
  diagnostics?: string[];
}

export interface ExecuteWebJobInput {
  jobSpec: WebJobSpec;
  jobDir: string;
  flowsDir: string;
  device: { serial: string; platform: string; kind: string };
  exec: ExecFn;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 已解析的 maestro 可执行文件；缺省 "maestro"（Windows .cmd/.bat 需显式路径）。 */
  maestroCommand?: string;
  /** 已解析的 adb 路径；失败诊断/预检用，缺省 "adb"。 */
  adbCommand?: string;
  /** 执行日志（driver 复用/缺失提示）。 */
  onLog?: (message: string) => void;
  /** 预期已安装的 Android appId（预检用）。 */
  expectedAppPackage?: string | null;
  /** 预期最低 versionCode（预检用）。 */
  expectedAppVersionCode?: number | null;
}

export const WEB_JOB_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const JUNIT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 1_000;
const MAX_WALK_DEPTH = 8;
const MAX_SCREENSHOTS_PER_CASE = 5;
const FAILURE_REASON_MAX = 2_000;
const DETAIL_MAX = 4_000;
const CASE_NAME_MAX = 200;
const DEVICE_SERIAL_RE = /^[A-Za-z0-9._:-]+$/;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

interface RawTestCase {
  name: string;
  classname: string;
  durationMs: number;
  status: WebJobCaseStatus;
  failureReason?: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function resultAt(
  startedAtMs: number,
  status: WebJobExecutionResult["status"],
  cases: WebJobExecutionCase[],
  detail: string | null,
  diagnostics?: string[]
): WebJobExecutionResult {
  return {
    status,
    cases,
    startedAt: iso(startedAtMs),
    finishedAt: iso(Date.now()),
    detail: detail === null ? null : clip(detail, DETAIL_MAX),
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics })
  };
}

/** Maestro 失败时抓设备现场：logcat/窗口状态/截图，best-effort，不影响原始错误。 */
async function captureFailureDiagnostics(input: ExecuteWebJobInput): Promise<{
  files: string[];
  summary: string | null;
}> {
  const dir = path.join(input.jobDir, "diagnostics");
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return { files: [], summary: null };
  }
  const files: string[] = [];
  const run = async (
    command: string,
    args: string[],
    timeoutMs = 20_000
  ): Promise<ExecResult | null> => {
    try {
      return await input.exec(command, args, { timeoutMs, env: input.env });
    } catch {
      return null;
    }
  };
  const save = async (file: string, text: string): Promise<void> => {
    if (text.trim() === "") return;
    try {
      await writeFile(file, text);
      files.push(file);
    } catch {
      /* 诊断失败不影响主错误 */
    }
  };
  let summary: string | null = null;
  if (input.device.platform === "android") {
    const adb = input.adbCommand?.trim() || "adb";
    const base = ["-s", input.device.serial];
    const logcat = await run(adb, [...base, "logcat", "-d", "-t", "400"]);
    if (logcat !== null) {
      await save(path.join(dir, "logcat.txt"), logcat.stdout);
      if (logcat.stdout.trim() !== "") {
        summary = `logcat:\n${logcat.stdout.trim().slice(-800)}`;
      }
    }
    const window = await run(adb, [...base, "shell", "dumpsys", "window", "windows"]);
    if (window !== null) await save(path.join(dir, "window.txt"), window.stdout);
    const remote = "/sdcard/aos-diagnostic.png";
    const shot = await run(adb, [...base, "shell", "screencap", "-p", remote]);
    if (shot !== null && shot.code === 0) {
      const local = path.join(dir, "screen.png");
      const pulled = await run(adb, [...base, "pull", remote, local]);
      if (pulled !== null && pulled.code === 0) files.push(local);
    }
    await run(adb, [...base, "shell", "rm", "-f", remote]);
  } else if (input.device.platform === "ios" && input.device.kind === "simulator") {
    const shot = path.join(dir, "screen.png");
    const captured = await run("xcrun", [
      "simctl",
      "io",
      input.device.serial,
      "screenshot",
      shot
    ]);
    if (captured !== null && captured.code === 0) files.push(shot);
    const logs = await run(
      "xcrun",
      ["simctl", "spawn", input.device.serial, "log", "show", "--last", "2m", "--style", "compact"],
      30_000
    );
    if (logs !== null) await save(path.join(dir, "syslog.txt"), logs.stdout);
  }
  return { files, summary };
}

/** Maestro Android driver 由 app + server 两个包组成；都在时才跳过每次重装。 */
async function maestroDriverState(
  input: ExecuteWebJobInput
): Promise<{ ready: boolean; missing: string[] }> {
  if (input.device.platform !== "android" || input.adbCommand === undefined) {
    return { ready: false, missing: [] };
  }
  if ((input.env.AOS_MAESTRO_REINSTALL_DRIVER ?? "").trim() === "1") {
    return { ready: false, missing: [] };
  }
  const adb = input.adbCommand.trim() || "adb";
  const installed = async (packageName: string): Promise<boolean> => {
    try {
      const result = await input.exec(
        adb,
        ["-s", input.device.serial, "shell", "pm", "path", packageName],
        { timeoutMs: 15_000, env: input.env }
      );
      return result.code === 0 && /package:/.test(result.stdout);
    } catch {
      return false;
    }
  };
  const packages = ["dev.mobile.maestro", "dev.mobile.maestro.test"];
  const states = await Promise.all(packages.map((packageName) => installed(packageName)));
  const missing = packages.filter((_packageName, index) => !states[index]);
  return { ready: missing.length === 0, missing };
}

interface MaestroPreflightResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

/** Android 执行前门禁：设备在线、driver 两包、屏幕状态、app 版本。 */
async function preflightAndroid(
  input: ExecuteWebJobInput,
  driver: { ready: boolean; missing: string[] }
): Promise<MaestroPreflightResult> {
  if (input.device.platform !== "android" || input.adbCommand === undefined) return { ok: true };
  if ((input.env.AOS_PREFLIGHT ?? "").trim() === "0") return { ok: true };

  const adb = input.adbCommand.trim() || "adb";
  const run = async (args: string[]): Promise<ExecResult | null> => {
    try {
      return await input.exec(adb, args, { timeoutMs: 15_000, env: input.env });
    } catch {
      return null;
    }
  };
  const detail = (result: ExecResult | null): string =>
    result === null ? "adb exec failed" : `${result.stdout} ${result.stderr}`.trim().slice(0, 400);

  const devices = await run(["devices"]);
  if (devices === null || devices.code !== 0) {
    return { ok: false, reason: "adb-offline", detail: detail(devices) };
  }
  const line = devices.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${input.device.serial}\t`) || entry.startsWith(`${input.device.serial} `));
  if (line === undefined || !/\sdevice$/.test(line)) {
    return { ok: false, reason: "adb-offline", detail: line ?? `serial ${input.device.serial} not found` };
  }

  if (!driver.ready && driver.missing.length > 0) {
    if ((input.env.AOS_MAESTRO_INSTALL_DRIVER ?? "").trim() !== "1") {
      return {
        ok: false,
        reason: "maestro-driver-missing",
        detail: driver.missing.join(", ")
      };
    }
  }

  const power = await run(["-s", input.device.serial, "shell", "dumpsys", "power"]);
  if (power !== null && /mWakefulness=(Asleep|Dozing)/.test(power.stdout)) {
    return { ok: false, reason: "device-asleep", detail: "screen is asleep" };
  }
  const window = await run(["-s", input.device.serial, "shell", "dumpsys", "window"]);
  if (
    window !== null &&
    /(mDreamingLockscreen=true|mShowingLockscreen=true|isStatusBarKeyguard=true)/.test(window.stdout)
  ) {
    return { ok: false, reason: "device-locked", detail: "keyguard is showing" };
  }

  if (input.expectedAppPackage !== null && input.expectedAppPackage !== undefined) {
    const app = await run(["-s", input.device.serial, "shell", "pm", "path", input.expectedAppPackage]);
    if (app === null || app.code !== 0 || !/package:/.test(app.stdout)) {
      return {
        ok: false,
        reason: "app-not-installed",
        detail: `${input.expectedAppPackage}: ${detail(app)}`
      };
    }
    if (input.expectedAppVersionCode !== null && input.expectedAppVersionCode !== undefined) {
      const dump = await run([
        "-s",
        input.device.serial,
        "shell",
        "dumpsys",
        "package",
        input.expectedAppPackage
      ]);
      const match = dump === null ? null : /versionCode=(\d+)/.exec(dump.stdout);
      if (match !== null) {
        const installed = Number(match[1]);
        if (installed < input.expectedAppVersionCode) {
          return {
            ok: false,
            reason: "app-version-mismatch",
            detail: `installed ${installed} < expected ${input.expectedAppVersionCode}`
          };
        }
      }
    }
  }

  return { ok: true };
}

function tail(text: string): string {
  const value = text.trim();
  if (value === "") return "";
  if (value.length <= DETAIL_MAX) return value;
  // 首尾都保留：根因通常在 stderr 开头，JVM/Kotlin 堆栈尾部用于定位崩溃点。
  // 预留前缀（`maestro-no-junit: exit=...:`）预算，避免 resultAt 截断掉尾部标记。
  const half = Math.floor((DETAIL_MAX - 200) / 2);
  return `${value.slice(0, half)}\n…\n${value.slice(-half)}`;
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

function resolveTimeout(explicit: number | undefined, env: NodeJS.ProcessEnv): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const fromEnv = Number.parseInt(env.AOS_WEB_JOB_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return WEB_JOB_DEFAULT_TIMEOUT_MS;
}

async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_WALK_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
        continue;
      }
      if (entry.isFile()) files.push(full);
    }
  };
  await visit(dir, 0);
  return files;
}

/** 用例只认 flowsDir 顶层 yaml；`subflows/` 等子目录是 Maestro 子流程，不作为用例。 */
async function listTopLevelFlows(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(yaml|yml)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

interface ManifestCase {
  caseId: string;
  module: string | null;
  flowPath: string | null;
}

/** Plan 2 manifest 与 flows/ 同级；缺失/损坏时回退旧行为（按文件名 stem 匹配）。 */
async function readScriptManifest(flowsDir: string): Promise<ManifestCase[] | null> {
  const manifestPath = path.join(path.dirname(flowsDir), "manifest.json");
  let raw: string;
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return null;
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const cases = (parsed as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) return null;
  const root = path.dirname(flowsDir);
  const out: ManifestCase[] = [];
  let hasModuleField = false;
  for (const entry of cases) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if ("module" in record) hasModuleField = true;
    const caseId = typeof record.caseId === "string" ? record.caseId.trim() : "";
    if (caseId === "") continue;
    const module =
      typeof record.module === "string" && record.module.trim() !== ""
        ? record.module.trim()
        : null;
    const flowRaw = typeof record.flow === "string" ? record.flow.trim() : "";
    const resolved = flowRaw === "" ? null : path.resolve(root, flowRaw);
    const flowPath =
      resolved !== null && isInside(flowsDir, resolved) ? resolved : null;
    out.push({ caseId, module, flowPath });
  }
  // 旧 manifest（R11 之前）没有 module 字段：整体回退旧行为，模块过滤显式报不支持。
  return out.length === 0 || !hasModuleField ? null : out;
}

const HARD_ASSERTION_LINE = /^\s*-\s*assert(?:Visible|NotVisible|True|Condition)\b/gm;
const ASSERTION_TEXT_LINE = /^\s*-\s*(assertVisible|assertNotVisible)\s*:\s*(.+?)\s*$/gm;

/** 统计 flow 内容里的硬断言命令条数（含后续 runFlow 引用的子流程）。 */
function countHardAssertions(content: string): number {
  return content.match(HARD_ASSERTION_LINE)?.length ?? 0;
}

/** 提取 assertVisible/assertNotVisible 的文本；对象写法只认 `text:`，id/变量不参与覆盖。 */
export function parseFlowAssertions(content: string): FlowAssertion[] {
  const out: FlowAssertion[] = [];
  for (const match of content.matchAll(ASSERTION_TEXT_LINE)) {
    let raw = (match[2] ?? "").trim();
    if (raw === "" || out.length >= 100) continue;
    if (raw.startsWith("{")) {
      const text = /\btext\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/.exec(raw);
      raw = (text?.[1] ?? text?.[2] ?? text?.[3] ?? "").trim();
    }
    raw = raw.replace(/^["']|["']$/g, "").trim();
    if (raw === "" || raw.includes("${") || [...raw].length > 200) continue;
    out.push({
      type: match[1] === "assertNotVisible" ? "notVisible" : "visible",
      text: raw
    });
  }
  return out;
}

const MANUAL_LINE = /^\s*#\s*aos:manual\s+step=(\d+)\s+reason=([^\n]*)$/gm;

export function parseFlowManualSteps(content: string): Array<{ step: number; reason: string }> {
  const out: Array<{ step: number; reason: string }> = [];
  for (const match of content.matchAll(MANUAL_LINE)) {
    const step = Number(match[1]);
    if (!Number.isInteger(step) || step < 1 || out.length >= 200) continue;
    out.push({ step, reason: (match[2] ?? "").trim().slice(0, 200) });
  }
  return out;
}

const RUN_FLOW_LINE = /^\s*-\s*runFlow\s*:\s*(.+?)\s*$/gm;
const MAX_RUN_FLOW_DEPTH = 4;

function runFlowPath(raw: string): string | null {
  let value = raw.trim();
  if (value === "" || value.includes("${")) return null;
  if (value.startsWith("{")) {
    const file = /\b(?:file|path)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/.exec(value);
    value = (file?.[1] ?? file?.[2] ?? file?.[3] ?? "").trim();
  }
  value = value.replace(/^["']|["']$/g, "").trim();
  return value === "" ? null : value;
}

/** 顶层 flow + 被 runFlow 引用的子流程（有界深度/路径越界/循环保护）。 */
async function collectFlowAssertions(
  file: string,
  flowsDir: string,
  seen: Set<string>,
  depth: number
): Promise<{
  count: number;
  assertions: FlowAssertion[];
  manualSteps: Array<{ step: number; reason: string }>;
}> {
  const resolved = path.resolve(file);
  if (depth > MAX_RUN_FLOW_DEPTH || seen.has(resolved) || !isInside(flowsDir, resolved)) {
    return { count: 0, assertions: [], manualSteps: [] };
  }
  seen.add(resolved);
  let content: string;
  try {
    content = await readFile(resolved, "utf-8");
  } catch {
    return { count: 0, assertions: [], manualSteps: [] };
  }
  let count = countHardAssertions(content);
  const assertions = parseFlowAssertions(content);
  const manualSteps = parseFlowManualSteps(content);
  for (const match of content.matchAll(RUN_FLOW_LINE)) {
    const relative = runFlowPath(match[1] ?? "");
    if (relative === null) continue;
    const next = path.resolve(path.dirname(resolved), relative);
    if (!/\.(?:ya?ml)$/i.test(next) || !isInside(flowsDir, next)) continue;
    const child = await collectFlowAssertions(next, flowsDir, seen, depth + 1);
    count += child.count;
    for (const assertion of child.assertions) {
      if (assertions.length >= 100) break;
      if (!assertions.some((entry) => entry.type === assertion.type && entry.text === assertion.text)) {
        assertions.push(assertion);
      }
    }
    for (const manual of child.manualSteps) {
      if (manualSteps.length >= 200) break;
      if (!manualSteps.some((entry) => entry.step === manual.step && entry.reason === manual.reason)) {
        manualSteps.push(manual);
      }
    }
  }
  return { count, assertions, manualSteps };
}

function decodeCharacterEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    const code = Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function plainText(source: string): string {
  const withoutCdata = source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeCharacterEntities(withoutCdata.replace(/<[^>]*>/g, " "));
}

function normalizeReason(source: string): string {
  const value = plainText(source).replace(/\s+/g, " ").trim();
  return value.length <= FAILURE_REASON_MAX ? value : value.slice(0, FAILURE_REASON_MAX);
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (name === undefined) continue;
    attributes[name] = decodeCharacterEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

interface ElementBody {
  attributes: Record<string, string>;
  text: string;
}

function elementBody(body: string, tag: string): ElementBody | null {
  const pattern = new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`);
  const open = pattern.exec(body);
  if (open === null) return null;
  const attributes = parseAttributes(open[1] ?? "");
  if (/\/\s*$/.test(open[1] ?? "")) return { attributes, text: "" };
  const close = body.indexOf(`</${tag}>`, open.index + open[0].length);
  if (close < 0) return { attributes, text: "" };
  return {
    attributes,
    text: normalizeReason(body.slice(open.index + open[0].length, close))
  };
}

function toRawCase(attributes: Record<string, string>, body: string): RawTestCase {
  const rawTime = Number.parseFloat(attributes.time ?? "");
  const durationMs = Number.isFinite(rawTime) && rawTime >= 0 ? Math.round(rawTime * 1000) : 0;
  const base = {
    name: attributes.name ?? "",
    classname: attributes.classname ?? "",
    durationMs
  };

  const error = elementBody(body, "error");
  if (error !== null) {
    const reason = error.text || normalizeReason(error.attributes.message ?? "") || "error";
    return { ...base, status: "ERROR", failureReason: reason };
  }
  const failure = elementBody(body, "failure");
  if (failure !== null) {
    const reason = failure.text || normalizeReason(failure.attributes.message ?? "") || "failure";
    return { ...base, status: "FAIL", failureReason: reason };
  }
  if (elementBody(body, "skipped") !== null) {
    return { ...base, status: "SKIP" };
  }
  return { ...base, status: "PASS" };
}

function parseJUnit(content: string): RawTestCase[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error("junit-dtd-rejected");
  const cases: RawTestCase[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<testcase", cursor);
    if (start < 0) break;
    const next = content.charAt(start + 9);
    if (next !== "" && !/[\s/>]/.test(next)) {
      cursor = start + 9;
      continue;
    }
    const tagEnd = content.indexOf(">", start);
    if (tagEnd < 0) throw new Error("junit-malformed");
    const rawTag = content.slice(start, tagEnd + 1);
    const selfClosing = /\/\s*>$/.test(rawTag);
    const openLength = "<testcase".length;
    const attributes = parseAttributes(rawTag.slice(openLength, selfClosing ? rawTag.length - 2 : -1));
    if (selfClosing) {
      cases.push(toRawCase(attributes, ""));
      cursor = tagEnd + 1;
      continue;
    }
    const close = content.indexOf("</testcase>", tagEnd + 1);
    if (close < 0) throw new Error("junit-malformed");
    cases.push(toRawCase(attributes, content.slice(tagEnd + 1, close)));
    cursor = close + "</testcase>".length;
  }
  return cases;
}

function matchesStem(raw: RawTestCase, stems: string[]): string | null {
  const candidates = [raw.name, raw.classname].filter((value) => value !== "");
  for (const stem of stems) {
    for (const candidate of candidates) {
      if (candidate === stem || candidate.includes(stem)) return stem;
    }
  }
  return null;
}

function aggregate(cases: WebJobExecutionCase[]): WebJobExecutionResult["status"] {
  if (cases.length === 0) return "error";
  if (cases.some((entry) => entry.status === "FAIL" || entry.status === "ERROR")) return "failed";
  if (cases.some((entry) => entry.status === "SKIP")) return "partial";
  return "passed";
}

function gatherScreenshots(
  files: string[],
  root: string,
  cases: WebJobExecutionCase[],
  stemByCaseId: Map<string, string> = new Map()
): void {
  const assigned = new Set<string>();
  for (const entry of cases) {
    const needles = [entry.caseId, stemByCaseId.get(entry.caseId)]
      .filter((value): value is string => typeof value === "string" && value !== "")
      .map((value) => value.toLowerCase());
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= MAX_SCREENSHOTS_PER_CASE) break;
      if (assigned.has(file)) continue;
      if (!IMAGE_RE.test(file)) continue;
      const relative = path.relative(root, file).toLowerCase();
      if (!needles.some((needle) => relative.includes(needle))) continue;
      assigned.add(file);
      matches.push(file);
    }
    if (matches.length > 0) entry.screenshotPaths = matches;
  }
}

export async function executeWebJob(
  input: ExecuteWebJobInput
): Promise<WebJobExecutionResult> {
  const startedAtMs = Date.now();

  if (input.jobSpec.executionMode === "llm") {
    return resultAt(startedAtMs, "error", [], "llm-execution-not-wired");
  }
  if (!DEVICE_SERIAL_RE.test(input.device.serial) || input.device.serial.startsWith("-")) {
    return resultAt(startedAtMs, "error", [], "invalid-device-serial");
  }

  const scriptSetId = input.jobSpec.scriptSetId;
  if (scriptSetId === null || scriptSetId.trim() === "") {
    return resultAt(startedAtMs, "error", [], "script-set-missing");
  }

  const jobDir = path.resolve(input.jobDir);
  const flowsDir = path.resolve(input.flowsDir);
  if (!isInside(jobDir, flowsDir)) {
    return resultAt(startedAtMs, "error", [], "flows-outside-job");
  }

  const caseFilter = input.jobSpec.caseFilter;
  const allFlowFiles = await listTopLevelFlows(flowsDir);
  if (allFlowFiles.length === 0) {
    return resultAt(startedAtMs, "error", [], "no-flow-files");
  }
  const manifestCases = await readScriptManifest(flowsDir);
  const wantedCaseIds = new Set(
    caseFilter.caseIds.map((caseId) => caseId.trim()).filter((caseId) => caseId !== "")
  );
  const wantedModules = new Set(
    caseFilter.modules.map((module) => module.trim()).filter((module) => module !== "")
  );
  const hasFilters = wantedCaseIds.size > 0 || wantedModules.size > 0;
  let flowFiles: string[];
  if (manifestCases !== null) {
    const wantedFlows = new Set<string>();
    for (const entry of manifestCases) {
      if (wantedCaseIds.size > 0 && !wantedCaseIds.has(entry.caseId)) continue;
      if (
        wantedModules.size > 0 &&
        (entry.module === null || !wantedModules.has(entry.module))
      ) {
        continue;
      }
      if (entry.flowPath !== null) wantedFlows.add(entry.flowPath);
    }
    flowFiles = hasFilters
      ? allFlowFiles.filter((file) => wantedFlows.has(path.resolve(file)))
      : allFlowFiles;
  } else {
    if (wantedModules.size > 0) {
      return resultAt(startedAtMs, "error", [], "case-filter-modules-unsupported");
    }
    flowFiles =
      wantedCaseIds.size === 0
        ? allFlowFiles
        : allFlowFiles.filter((file) =>
            wantedCaseIds.has(path.basename(file, path.extname(file)))
          );
  }
  if (flowFiles.length === 0) {
    return resultAt(startedAtMs, "error", [], "case-filter-no-match");
  }
  const execTargets = hasFilters
    ? flowFiles.map((file) => path.resolve(file))
    : [`${flowsDir}${path.sep}`];

  const flowByStem = new Map<string, string>();
  const duplicateFlows: string[] = [];
  for (const file of flowFiles) {
    const stem = path.basename(file, path.extname(file));
    if (stem === "") continue;
    if (flowByStem.has(stem)) {
      duplicateFlows.push(stem);
      continue;
    }
    flowByStem.set(stem, file);
  }
  if (flowByStem.size === 0) {
    return resultAt(startedAtMs, "error", [], "no-flow-files");
  }
  const manifestByFlow = new Map<string, ManifestCase>();
  for (const entry of manifestCases ?? []) {
    if (entry.flowPath !== null) manifestByFlow.set(entry.flowPath, entry);
  }
  const caseIdByStem = new Map<string, string>();
  for (const [stem, file] of flowByStem) {
    const entry = manifestByFlow.get(path.resolve(file));
    if (entry !== undefined) caseIdByStem.set(stem, entry.caseId);
  }
  const publicCaseId = (stem: string): string => caseIdByStem.get(stem) ?? stem;
  const stems = [...flowByStem.keys()].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
  const assertionCounts = new Map<string, number>();
  const flowAssertions = new Map<string, FlowAssertion[]>();
  const flowManualSteps = new Map<string, Array<{ step: number; reason: string }>>();
  for (const [stem, file] of flowByStem) {
    const collected = await collectFlowAssertions(file, flowsDir, new Set(), 0);
    assertionCounts.set(stem, collected.count);
    flowAssertions.set(stem, collected.assertions);
    flowManualSteps.set(stem, collected.manualSteps);
  }

  const junitPath = path.join(jobDir, "junit.xml");
  const debugDir = path.join(jobDir, "maestro");
  await mkdir(jobDir, { recursive: true });
  await rm(junitPath, { force: true });
  await rm(debugDir, { recursive: true, force: true });

  const timeoutMs = resolveTimeout(input.timeoutMs, input.env);
  const maestroArgs = [
    "test",
    "--udid",
    input.device.serial,
    "--format",
    "JUNIT",
    "--output",
    junitPath,
    "--debug-output",
    debugDir,
    ...execTargets
  ];
  const driver = await maestroDriverState(input);
  const preflight = await preflightAndroid(input, driver);
  if (!preflight.ok) {
    return resultAt(
      startedAtMs,
      "error",
      [],
      `maestro-preflight:${preflight.reason ?? "unknown"}${preflight.detail === undefined ? "" : `: ${preflight.detail}`}`
    );
  }
  if (driver.ready) {
    maestroArgs.push("--no-reinstall-driver");
    input.onLog?.("Maestro driver 已安装，跳过重装");
  } else if (driver.missing.length > 0) {
    input.onLog?.(`Maestro driver 缺失：${driver.missing.join(", ")}（交给 Maestro 安装）`);
  } else if ((input.env.AOS_MAESTRO_REINSTALL_DRIVER ?? "").trim() === "1") {
    input.onLog?.("AOS_MAESTRO_REINSTALL_DRIVER=1：强制重装 Maestro driver");
  }

  let execResult: ExecResult;
  try {
    execResult = await input.exec(input.maestroCommand?.trim() || "maestro", maestroArgs, {
      timeoutMs,
      env: input.env
    });
  } catch (error) {
    const diagnostics = await captureFailureDiagnostics(input);
    return resultAt(
      startedAtMs,
      "error",
      [],
      `maestro-exec-failed: ${errorMessage(error)}`,
      diagnostics.files
    );
  }

  let junitContent: string | null = null;
  try {
    const info = await lstat(junitPath);
    if (info.isFile() && !info.isSymbolicLink()) {
      if (info.size > JUNIT_MAX_BYTES) {
        return resultAt(startedAtMs, "error", [], "junit-too-large");
      }
      junitContent = await readFile(junitPath, "utf-8");
    }
  } catch {
    junitContent = null;
  }
  if (junitContent === null) {
    const stderr = tail(execResult.stderr || execResult.stdout);
    const exit = execResult.code === null ? "null" : String(execResult.code);
    const reason =
      execResult.error === "timeout"
        ? "maestro-timeout"
        : `maestro-no-junit: exit=${exit}${execResult.error === undefined ? "" : `: ${execResult.error}`}`;
    const diagnostics = await captureFailureDiagnostics(input);
    const withLogcat =
      diagnostics.summary === null ? reason : `${reason}\n--- ${diagnostics.summary}`;
    return resultAt(
      startedAtMs,
      "error",
      [],
      stderr === "" ? withLogcat : `${withLogcat}: ${stderr}`,
      diagnostics.files
    );
  }
  if (junitContent.trim() === "") {
    return resultAt(startedAtMs, "error", [], "junit-empty");
  }

  let rawCases: RawTestCase[];
  try {
    rawCases = parseJUnit(junitContent);
  } catch (error) {
    return resultAt(startedAtMs, "error", [], `junit-invalid: ${errorMessage(error)}`);
  }
  if (rawCases.length === 0) {
    return resultAt(startedAtMs, "error", [], "junit-empty");
  }

  const cases: WebJobExecutionCase[] = [];
  const warnings: string[] = [];
  const usedStems = new Set<string>();
  const stemByCaseId = new Map<string, string>();

  rawCases.forEach((raw, index) => {
    const matched = matchesStem(raw, stems);
    const name = clip(
      raw.name || raw.classname || matched || `testcase-${index + 1}`,
      CASE_NAME_MAX
    );
    if (matched === null) {
      warnings.push(`unmatched-testcase:${name}`);
      cases.push({
        caseId: `unmatched:${clip(name, 120)}#${index + 1}`,
        name,
        status: "ERROR",
        durationMs: raw.durationMs,
        failureReason: raw.failureReason ?? "testcase-not-mapped"
      });
      return;
    }
    if (usedStems.has(matched)) {
      warnings.push(`duplicate-testcase:${matched}`);
      cases.push({
        caseId: `duplicate:${publicCaseId(matched)}#${index + 1}`,
        name,
        status: "ERROR",
        durationMs: raw.durationMs,
        failureReason: raw.failureReason ?? "duplicate-case-id"
      });
      return;
    }
    usedStems.add(matched);
    const outputCaseId = publicCaseId(matched);
    stemByCaseId.set(outputCaseId, matched);
    const entry: WebJobExecutionCase = {
      caseId: outputCaseId,
      name,
      status: raw.status,
      durationMs: raw.durationMs,
      assertionCount: assertionCounts.get(matched) ?? 0
    };
    const extractedAssertions = flowAssertions.get(matched);
    if (extractedAssertions !== undefined && extractedAssertions.length > 0) {
      entry.assertions = extractedAssertions;
    }
    const extractedManualSteps = flowManualSteps.get(matched);
    if (extractedManualSteps !== undefined && extractedManualSteps.length > 0) {
      entry.manualSteps = extractedManualSteps;
    }
    if (raw.failureReason !== undefined) entry.failureReason = raw.failureReason;
    cases.push(entry);
  });

  for (const stem of duplicateFlows) {
    warnings.push(`duplicate-flow:${stem}`);
    cases.push({
      caseId: `duplicate:${publicCaseId(stem)}#flow`,
      name: stem,
      status: "ERROR",
      durationMs: 0,
      failureReason: "duplicate-flow-file"
    });
  }

  for (const stem of flowByStem.keys()) {
    if (usedStems.has(stem)) continue;
    warnings.push(`flow-not-in-junit:${stem}`);
    cases.push({
      caseId: publicCaseId(stem),
      name: stem,
      status: "ERROR",
      durationMs: 0,
      failureReason: "flow-not-in-junit"
    });
  }

  const debugFiles = await walkFiles(debugDir);
  gatherScreenshots(debugFiles, jobDir, cases, stemByCaseId);
  const logPath =
    debugFiles.find((file) => /maestro\.log$/i.test(file)) ??
    debugFiles.find((file) => /\.log$/i.test(file));
  if (logPath !== undefined && isInside(jobDir, logPath)) {
    for (const entry of cases) entry.logPath = logPath;
  }

  const execFailed =
    execResult.error !== undefined || execResult.code === null || execResult.code !== 0;
  if (execFailed) {
    warnings.push(`maestro-exit:${execResult.error ?? (execResult.code === null ? "null" : String(execResult.code))}`);
  }

  const failedCase = cases.some(
    (entry) => entry.status === "FAIL" || entry.status === "ERROR"
  );
  const diagnostics = execFailed || failedCase ? await captureFailureDiagnostics(input) : null;
  const detail = warnings.length === 0 ? null : warnings.join("; ");
  const withDiagnostics =
    diagnostics?.summary === undefined || diagnostics.summary === null
      ? detail
      : `${detail === null ? "" : `${detail}\n`}--- ${diagnostics.summary}`;
  return resultAt(
    startedAtMs,
    execFailed ? "error" : aggregate(cases),
    cases,
    withDiagnostics,
    diagnostics?.files
  );
}
