import fs from "node:fs";
import path from "node:path";

import { collectWindowLogs, type IosLogWindowRequest } from "../device/ios-log.js";
import type { LogcatWindowResult } from "../device/logcat.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { IosFailureLogs, IosTaskRecord } from "./types.js";

export function resolveLogFeedback(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_IOS_LOG_FEEDBACK?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function persistFailureLogs(
  runDir: string,
  source: "simctl-log" | "idevicesyslog",
  lines: string[],
  clockWarning: boolean
): IosFailureLogs {
  try {
    const rel = "logs/device.log";
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
    const header = `# iOS 设备日志（来源 ${source}${clockWarning ? "，时间窗口近似" : ""}）\n`;
    writeFileAtomic(path.join(runDir, rel), `${header}${lines.join("\n")}\n`);
    return { status: "ok", source, rel, lines: lines.length };
  } catch (error) {
    return { status: "skipped", source, reason: `write-failed: ${errorMessage(error)}` };
  }
}

export async function collectFailureLogs(
  runtime: Runtime,
  record: IosTaskRecord,
  tail: { start(): void; stop(): void; snapshot(): string[] } | null,
  logCollector?: { collect(request: IosLogWindowRequest): Promise<LogcatWindowResult> } | null
): Promise<IosFailureLogs> {
  const processName = record.lockedAppPackage
    ? record.lockedAppPackage.split(".").pop() ?? null
    : null;
  const logs = await collectWindowLogs({
    serial: record.udid,
    windowStartMs: record.startedAtMs,
    windowEndMs: Date.now(),
    processName,
    tail,
    collector: logCollector ?? null,
    env: runtime.iosEnvironment()
  });
  if (logs.status !== "ok") {
    return { status: "skipped", source: logs.source, reason: logs.reason };
  }
  return persistFailureLogs(record.runDir, logs.source, logs.lines, logs.clockWarning);
}
