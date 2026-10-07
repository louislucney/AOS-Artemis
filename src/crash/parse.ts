import { createHash } from "node:crypto";

import type { CrashAttribution, ParsedCrash } from "./types.js";

const LOGCAT_LINE_RE =
  /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*)$/;
const PROCESS_RE = /^Process:\s*([^\s,]+)/;
const CAUSED_BY_RE = /^Caused by:\s*(.+)$/;
const FRAME_RE = /^\s*at\s+(.+)$/;
const CLASS_LIKE_RE = /^([A-Za-z_$][\w$.]*)(?::\s*(.*))?$/;
const TOMBSTONE_PACKAGE_RE = />>>\s*([^\s]+)\s*<</;
const BACKTRACE_RE = /^\s*#\d{2}\s+pc\s+/;
const FATAL_SIGNAL_RE = /^Fatal signal (\d+)\s*\(([^)]+)\)/;
const ANR_RE = /^ANR in (\S+)/;

// crash buffer 条目首尾相接（同 tag 连续行），块收集必须在下一个崩溃头处截断，避免多崩溃合并成一条
const startsCrashHeader = (message: string): boolean =>
  message.startsWith("FATAL EXCEPTION:") || FATAL_SIGNAL_RE.test(message) || ANR_RE.test(message);

const SLACK_MS = 5000;
const MAX_FRAMES = 60;
const MAX_CAUSED_BY = 8;
const MAX_EXCERPT_LINES = 200;
const MAX_EXCERPT_CHARS = 16 * 1024;
const MAX_MESSAGE_CHARS = 400;
const MAX_FRAME_CHARS = 300;
const NATIVE_LOOKAHEAD = 120;
const YEAR_ROLLOVER_TOLERANCE_MS = 3600_000;

export interface ParseLogcatOptions {
  windowStartMs: number;
  windowEndMs: number;
  clockOffsetMs?: number;
  referenceMs?: number;
  packageFilter?: string | null;
  includeUnattributed?: boolean;
  slackMs?: number;
}

interface LogLine {
  tsDeviceMs: number | null;
  tsHostMs: number | null;
  tag: string;
  message: string;
  raw: string;
}

function epochFromParts(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  referenceDeviceMs: number
): number {
  const reference = new Date(referenceDeviceMs);
  const year = reference.getFullYear();
  let candidate = new Date(year, month - 1, day, hour, minute, second, ms).getTime();
  if (!Number.isFinite(candidate)) return Number.NaN;
  if (candidate > referenceDeviceMs + YEAR_ROLLOVER_TOLERANCE_MS) {
    candidate = new Date(year - 1, month - 1, day, hour, minute, second, ms).getTime();
  }
  return candidate;
}

function parseLine(raw: string, referenceDeviceMs: number, clockOffsetMs: number): LogLine {
  const match = LOGCAT_LINE_RE.exec(raw);
  if (!match) return { tsDeviceMs: null, tsHostMs: null, tag: "", message: "", raw };
  const tsDeviceMs = epochFromParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    referenceDeviceMs
  );
  const rest = match[10];
  const separator = rest.indexOf(": ");
  const tag = separator >= 0 ? rest.slice(0, separator).trim() : rest.trim();
  const message = separator >= 0 ? rest.slice(separator + 2) : "";
  return {
    tsDeviceMs: Number.isFinite(tsDeviceMs) ? tsDeviceMs : null,
    tsHostMs: Number.isFinite(tsDeviceMs) ? tsDeviceMs - clockOffsetMs : null,
    tag,
    message,
    raw
  };
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function boundExcerpt(block: LogLine[]): string {
  const lines = block.length > MAX_EXCERPT_LINES ? block.slice(0, MAX_EXCERPT_LINES) : block;
  const text = lines.map((line) => line.raw).join("\n");
  return text.length > MAX_EXCERPT_CHARS ? text.slice(0, MAX_EXCERPT_CHARS) : text;
}

function signatureOf(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function matchesPackage(pkg: string, filter: string): boolean {
  return pkg === filter || pkg.startsWith(`${filter}:`);
}

function firstAppFrame(frames: string[], pkg: string): string | null {
  if (!pkg) return null;
  for (const frame of frames) {
    if (frame.startsWith(`${pkg}.`) || frame.startsWith(`${pkg}$`) || frame.startsWith(`${pkg}:`)) {
      return frame;
    }
  }
  return null;
}

function isClassLike(message: string): boolean {
  const match = CLASS_LIKE_RE.exec(message.trim());
  if (!match) return false;
  const name = match[1];
  if (!name) return false;
  return name.includes(".") || /(Exception|Error|Throwable|Failure|Terror)$/.test(name);
}

interface JavaParseResult {
  attribution: CrashAttribution;
  pkg: string;
  exceptionClass: string;
  message: string;
  frames: string[];
  causedBy: string[];
  rootCauseClass: string;
  rootFrames: string[];
}

function parseJavaBlock(block: LogLine[]): JavaParseResult | null {
  if (block.length === 0) return null;
  const first = block[0]!;
  if (!first.message.startsWith("FATAL EXCEPTION:")) return null;

  let pkg = "";
  let attribution: CrashAttribution = "unknown";
  let exceptionClass = "unknown";
  let message = "";
  const frames: string[] = [];
  const causedBy: string[] = [];
  const causedByFrames: string[][] = [];
  let sawException = false;

  for (let i = 1; i < block.length; i += 1) {
    const text = block[i]!.message;
    const process = PROCESS_RE.exec(text);
    if (process?.[1]) {
      pkg = process[1];
      attribution = "process-line";
      continue;
    }
    const caused = CAUSED_BY_RE.exec(text);
    if (caused) {
      const payload = caused[1]!.trim();
      causedBy.push(payload.length > MAX_MESSAGE_CHARS ? payload.slice(0, MAX_MESSAGE_CHARS) : payload);
      causedByFrames.push([]);
      continue;
    }
    const frame = FRAME_RE.exec(text);
    if (frame?.[1]) {
      const normalized = truncate(frame[1], MAX_FRAME_CHARS);
      frames.push(normalized);
      const current = causedByFrames.length > 0 ? causedByFrames[causedByFrames.length - 1]! : null;
      if (current) current.push(normalized);
      continue;
    }
    if (!sawException && isClassLike(text)) {
      const match = CLASS_LIKE_RE.exec(text.trim())!;
      exceptionClass = match[1]!;
      message = truncate(match[2] ?? "", MAX_MESSAGE_CHARS);
      sawException = true;
    }
  }

  if (frames.length === 0 && !sawException) return null;
  const rootSegmentFrames =
    causedByFrames.length > 0 ? causedByFrames[causedByFrames.length - 1]! : frames;
  const rootCauseClass = causedBy.length > 0 ? classNameOf(causedBy[causedBy.length - 1]!) : exceptionClass;

  return {
    attribution,
    pkg,
    exceptionClass,
    message,
    frames: frames.slice(0, MAX_FRAMES),
    causedBy: causedBy.slice(0, MAX_CAUSED_BY),
    rootCauseClass,
    rootFrames: rootSegmentFrames.slice(0, MAX_FRAMES)
  };
}

function classNameOf(exceptionLine: string): string {
  const match = CLASS_LIKE_RE.exec(exceptionLine.trim());
  return match?.[1] ?? exceptionLine.trim();
}

interface NativeParseResult {
  attribution: CrashAttribution;
  pkg: string;
  exceptionClass: string;
  topFrame: string;
  frames: string[];
  excerptLines: LogLine[];
}

function parseNativeCandidate(
  lines: LogLine[],
  startIndex: number,
  signalNumber: string,
  signalName: string
): NativeParseResult {
  const start = lines[startIndex]!;
  let pkg = "";
  let attribution: CrashAttribution = "unknown";
  const frames: string[] = [];
  const excerptLines: LogLine[] = [start];

  for (let i = startIndex + 1; i < Math.min(lines.length, startIndex + 1 + NATIVE_LOOKAHEAD); i += 1) {
    const line = lines[i]!;
    excerptLines.push(line);
    const marker = TOMBSTONE_PACKAGE_RE.exec(line.message);
    if (!pkg && marker?.[1]) {
      pkg = marker[1];
      attribution = "tombstone-header";
    }
    if (BACKTRACE_RE.test(line.message)) {
      frames.push(truncate(line.message, MAX_FRAME_CHARS));
    }
  }

  const topFrame = frames[0] ?? "";
  return {
    attribution,
    pkg,
    exceptionClass: `signal ${signalNumber} (${signalName})`,
    topFrame,
    frames: frames.slice(0, MAX_FRAMES),
    excerptLines
  };
}

function nativeSignatureFrame(frame: string): string {
  const matches = frame.match(/\(([^()]*)\)\s*$/);
  if (matches?.[1]) return matches[1].trim();
  return frame.trim();
}

export function parseLogcatCrashes(text: string, options: ParseLogcatOptions): ParsedCrash[] {
  const clockOffsetMs = options.clockOffsetMs ?? 0;
  const referenceDeviceMs = (options.referenceMs ?? Date.now()) + clockOffsetMs;
  const slack = options.slackMs ?? SLACK_MS;
  const includeUnattributed = options.includeUnattributed === true;
  const packageFilter = options.packageFilter ?? null;

  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((raw) => parseLine(raw, referenceDeviceMs, clockOffsetMs));
  const results: ParsedCrash[] = [];

  const inWindow = (ms: number | null): boolean =>
    ms !== null && ms >= options.windowStartMs - slack && ms <= options.windowEndMs + slack;

  const allowed = (pkg: string, attribution: CrashAttribution): boolean => {
    if (attribution === "unknown" && !includeUnattributed) return false;
    if (packageFilter && !matchesPackage(pkg, packageFilter)) return false;
    return true;
  };

  const pushJava = (block: LogLine[]): void => {
    const parsed = parseJavaBlock(block);
    if (!parsed) return;
    if (!allowed(parsed.pkg, parsed.attribution)) return;
    const occurredAtMs = block[0]!.tsHostMs;
    if (!inWindow(occurredAtMs)) return;

    const rootFrames = parsed.rootFrames;
    const appFrame = firstAppFrame(rootFrames, parsed.pkg) ?? firstAppFrame(parsed.frames, parsed.pkg);
    const topFrame = appFrame ?? rootFrames[0] ?? parsed.frames[0] ?? "";
    const signature = signatureOf([
      parsed.pkg,
      "java",
      parsed.rootCauseClass,
      topFrame
    ]);

    results.push({
      kind: "java",
      package: parsed.pkg,
      attribution: parsed.attribution,
      exceptionClass: parsed.exceptionClass,
      message: parsed.message,
      rootCauseClass: parsed.rootCauseClass,
      topFrame,
      frames: parsed.frames,
      causedBy: parsed.causedBy,
      signature,
      signatureBasis: `root=${parsed.rootCauseClass}; frame=${topFrame || "none"}`,
      occurredAt: occurredAtMs !== null ? new Date(occurredAtMs).toISOString() : null,
      occurredAtMs,
      excerpt: boundExcerpt(block)
    });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;

    if (line.tsDeviceMs === null) {
      index += 1;
      continue;
    }

    if (line.tag === "AndroidRuntime" && line.message.startsWith("FATAL EXCEPTION:")) {
      const tag = line.tag;
      let end = index + 1;
      while (
        end < lines.length &&
        lines[end]!.tsDeviceMs !== null &&
        lines[end]!.tag === tag &&
        !startsCrashHeader(lines[end]!.message)
      ) {
        end += 1;
      }
      pushJava(lines.slice(index, end));
      index = end;
      continue;
    }

    const signal = FATAL_SIGNAL_RE.exec(line.message);
    if (signal) {
      const parsed = parseNativeCandidate(lines, index, signal[1]!, signal[2]!);
      if (allowed(parsed.pkg, parsed.attribution)) {
        const occurredAtMs = line.tsHostMs;
        if (inWindow(occurredAtMs)) {
          const frame = nativeSignatureFrame(parsed.topFrame);
          results.push({
            kind: "native",
            package: parsed.pkg,
            attribution: parsed.attribution,
            exceptionClass: parsed.exceptionClass,
            message: truncate(line.message, MAX_MESSAGE_CHARS),
            rootCauseClass: parsed.exceptionClass,
            topFrame: parsed.topFrame,
            frames: parsed.frames,
            causedBy: [],
            signature: signatureOf([parsed.pkg, "native", parsed.exceptionClass, frame]),
            signatureBasis: `signal=${parsed.exceptionClass}; frame=${frame || "none"}`,
            occurredAt: occurredAtMs !== null ? new Date(occurredAtMs).toISOString() : null,
            occurredAtMs,
            excerpt: boundExcerpt(parsed.excerptLines)
          });
        }
      }
      index += 1;
      continue;
    }

    const anr = ANR_RE.exec(line.message);
    if (anr?.[1]) {
      const pkg = anr[1];
      if (allowed(pkg, "anr-line")) {
        const occurredAtMs = line.tsHostMs;
        if (inWindow(occurredAtMs)) {
          const topFrame = `ANR in ${pkg}`;
          results.push({
            kind: "anr",
            package: pkg,
            attribution: "anr-line",
            exceptionClass: "ANR",
            message: truncate(line.message, MAX_MESSAGE_CHARS),
            rootCauseClass: "ANR",
            topFrame,
            frames: [],
            causedBy: [],
            signature: signatureOf([pkg, "anr", "ANR"]),
            signatureBasis: `root=ANR; frame=${topFrame}`,
            occurredAt: occurredAtMs !== null ? new Date(occurredAtMs).toISOString() : null,
            occurredAtMs,
            excerpt: boundExcerpt([line])
          });
        }
      }
      index += 1;
      continue;
    }

    index += 1;
  }

  return results;
}
