import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
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
}

export interface WebJobExecutionResult {
  status: "passed" | "failed" | "partial" | "error";
  cases: WebJobExecutionCase[];
  startedAt: string;
  finishedAt: string;
  detail: string | null;
}

export interface ExecuteWebJobInput {
  jobSpec: WebJobSpec;
  jobDir: string;
  flowsDir: string;
  device: { serial: string; platform: string; kind: string };
  exec: ExecFn;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export const WEB_JOB_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const JUNIT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 1_000;
const MAX_WALK_DEPTH = 8;
const MAX_SCREENSHOTS_PER_CASE = 5;
const FAILURE_REASON_MAX = 2_000;
const DETAIL_TAIL_MAX = 400;
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
  detail: string | null
): WebJobExecutionResult {
  return {
    status,
    cases,
    startedAt: iso(startedAtMs),
    finishedAt: iso(Date.now()),
    detail: detail === null ? null : clip(detail, DETAIL_MAX)
  };
}

function tail(text: string): string {
  const value = text.trim();
  if (value === "") return "";
  return value.length <= DETAIL_TAIL_MAX ? value : `…${value.slice(-DETAIL_TAIL_MAX)}`;
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

const HARD_ASSERTION_LINE = /^\s*-\s*assert(?:Visible|NotVisible|True|Condition)\b/gm;

/** 只扫顶层 flow 文件本身：Maestro 子流程（subflows/）不展开、不计数。 */
function countHardAssertions(content: string): number {
  return content.match(HARD_ASSERTION_LINE)?.length ?? 0;
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
  cases: WebJobExecutionCase[]
): void {
  const assigned = new Set<string>();
  for (const entry of cases) {
    const needle = entry.caseId.toLowerCase();
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= MAX_SCREENSHOTS_PER_CASE) break;
      if (assigned.has(file)) continue;
      if (!IMAGE_RE.test(file)) continue;
      const relative = path.relative(root, file).toLowerCase();
      if (!relative.includes(needle)) continue;
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
  if (caseFilter.modules.length > 0) {
    return resultAt(startedAtMs, "error", [], "case-filter-modules-unsupported");
  }
  const allFlowFiles = await listTopLevelFlows(flowsDir);
  if (allFlowFiles.length === 0) {
    return resultAt(startedAtMs, "error", [], "no-flow-files");
  }
  const wantedCaseIds = new Set(
    caseFilter.caseIds.map((caseId) => caseId.trim()).filter((caseId) => caseId !== "")
  );
  const flowFiles =
    wantedCaseIds.size === 0
      ? allFlowFiles
      : allFlowFiles.filter((file) => wantedCaseIds.has(path.basename(file, path.extname(file))));
  if (flowFiles.length === 0) {
    return resultAt(startedAtMs, "error", [], "case-filter-no-match");
  }

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
  const stems = [...flowByStem.keys()].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
  const assertionCounts = new Map<string, number>();
  for (const [stem, file] of flowByStem) {
    try {
      assertionCounts.set(stem, countHardAssertions(await readFile(file, "utf-8")));
    } catch {
      assertionCounts.set(stem, 0);
    }
  }

  const junitPath = path.join(jobDir, "junit.xml");
  const debugDir = path.join(jobDir, "maestro");
  await mkdir(jobDir, { recursive: true });
  await rm(junitPath, { force: true });
  await rm(debugDir, { recursive: true, force: true });

  const timeoutMs = resolveTimeout(input.timeoutMs, input.env);
  let execResult: ExecResult;
  try {
    execResult = await input.exec(
      "maestro",
      [
        "test",
        "--udid",
        input.device.serial,
        "--format",
        "JUNIT",
        "--output",
        junitPath,
        "--debug-output",
        debugDir,
        `${flowsDir}${path.sep}`
      ],
      { timeoutMs, env: input.env }
    );
  } catch (error) {
    return resultAt(startedAtMs, "error", [], `maestro-exec-failed: ${errorMessage(error)}`);
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
    return resultAt(startedAtMs, "error", [], stderr === "" ? reason : `${reason}: ${stderr}`);
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
        caseId: `duplicate:${matched}#${index + 1}`,
        name,
        status: "ERROR",
        durationMs: raw.durationMs,
        failureReason: raw.failureReason ?? "duplicate-case-id"
      });
      return;
    }
    usedStems.add(matched);
    const entry: WebJobExecutionCase = {
      caseId: matched,
      name,
      status: raw.status,
      durationMs: raw.durationMs,
      assertionCount: assertionCounts.get(matched) ?? 0
    };
    if (raw.failureReason !== undefined) entry.failureReason = raw.failureReason;
    cases.push(entry);
  });

  for (const stem of duplicateFlows) {
    warnings.push(`duplicate-flow:${stem}`);
    cases.push({
      caseId: `duplicate:${stem}#flow`,
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
      caseId: stem,
      name: stem,
      status: "ERROR",
      durationMs: 0,
      failureReason: "flow-not-in-junit"
    });
  }

  const debugFiles = await walkFiles(debugDir);
  gatherScreenshots(debugFiles, jobDir, cases);
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

  return resultAt(
    startedAtMs,
    execFailed ? "error" : aggregate(cases),
    cases,
    warnings.length === 0 ? null : warnings.join("; ")
  );
}
