import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";

export type DialogPlatform = "ios" | "android";

export interface StoredSystemDialog {
  platform: DialogPlatform;
  /** clear = 检查执行且未发现弹窗；缺失按旧记录内容推断。 */
  status?: "dialog" | "clear";
  title: string | null;
  message: string | null;
  buttons: string[];
  at: string;
}

export interface SystemDialogParity {
  comparable: boolean;
  reasons: string[];
  ios: StoredSystemDialog | null;
  android: StoredSystemDialog | null;
}

/** 控制面写入校验：只接受 ios/android、字符串标题/正文/按钮；超长截断。 */
export function normalizeStoredSystemDialog(value: unknown): StoredSystemDialog | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.platform !== "ios" && record.platform !== "android") return null;
  const status =
    record.status === "dialog" || record.status === "clear" ? record.status : undefined;
  const title = typeof record.title === "string" ? record.title.slice(0, 2000) : null;
  const message = typeof record.message === "string" ? record.message.slice(0, 8000) : null;
  const buttons = Array.isArray(record.buttons)
    ? record.buttons
        .filter((button): button is string => typeof button === "string")
        .slice(0, 20)
        .map((button) => button.slice(0, 200))
    : [];
  const at =
    typeof record.at === "string" && record.at !== "" ? record.at : new Date().toISOString();
  return {
    platform: record.platform,
    ...(status === undefined ? {} : { status }),
    title,
    message,
    buttons,
    at
  };
}

const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 同一任务的弹窗文件跨进程读改写互斥（iOS/mac 与 Android/win 可并发同步中心）。 */
function withDialogLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch (error) {
        void error;
      }
      if (Date.now() >= deadline) {
        throw new Error("系统弹窗文件锁等待超时");
      }
      sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      void error;
    }
    try {
      fs.rmSync(lock, { force: true });
    } catch (error) {
      void error;
    }
  }
}

export function systemDialogPath(rootPath: string, taskId: string): string {
  return path.join(rootPath, ".artemis", "design", "system-dialogs", `${taskId}.json`);
}

export function readSystemDialogs(rootPath: string, taskId: string): StoredSystemDialog[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(systemDialogPath(rootPath, taskId), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredSystemDialog =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { platform?: unknown }).platform !== undefined &&
        ((entry as { platform: unknown }).platform === "ios" ||
          (entry as { platform: unknown }).platform === "android")
    );
  } catch {
    return [];
  }
}

export function writeSystemDialog(
  rootPath: string,
  taskId: string,
  dialog: StoredSystemDialog
): boolean {
  const file = systemDialogPath(rootPath, taskId);
  return withDialogLock(file, () => {
    const all = readSystemDialogs(rootPath, taskId);
    if (
      dialog.status === "clear" &&
      all.some(
        (entry) => entry.platform === dialog.platform && dialogState(entry) === "dialog"
      )
    ) {
      return false;
    }
    const existing = all.filter((entry) => entry.platform !== dialog.platform);
    writeFileAtomic(file, `${JSON.stringify([...existing, dialog], null, 2)}\n`);
    return true;
  });
}

function normalize(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sameDialog(a: StoredSystemDialog, b: StoredSystemDialog): boolean {
  return (
    normalize(a.title) === normalize(b.title) &&
    normalize(a.message) === normalize(b.message) &&
    a.buttons.map(normalize).join("\u0000") === b.buttons.map(normalize).join("\u0000")
  );
}

function dialogState(entry: StoredSystemDialog): "dialog" | "clear" | "unknown" {
  if (entry.status === "dialog" || entry.status === "clear") return entry.status;
  if (entry.title === null && entry.message === null && entry.buttons.length === 0) {
    return "unknown";
  }
  return "dialog";
}

/** 两端同数据下的弹窗内容对照；只比较 title/message/buttons，不判断按钮语义。
 * 没有任何捕获记录时返回 not-comparable，不能把“没检查”当成“一致”。 */
export function compareSystemDialogs(records: readonly StoredSystemDialog[]): SystemDialogParity {
  const ios = records.find((entry) => entry.platform === "ios") ?? null;
  const android = records.find((entry) => entry.platform === "android") ?? null;
  if (ios === null && android === null) {
    return { comparable: false, reasons: ["no-dialog-evidence"], ios: null, android: null };
  }
  if (ios === null) return { comparable: false, reasons: ["missing-dialog:ios"], ios, android };
  if (android === null) {
    return { comparable: false, reasons: ["missing-dialog:android"], ios, android };
  }
  const iosState = dialogState(ios);
  const androidState = dialogState(android);
  if (iosState === "unknown" || androidState === "unknown") {
    return { comparable: false, reasons: ["dialog-evidence-ambiguous"], ios, android };
  }
  if (iosState === "clear" && androidState === "clear") {
    return { comparable: true, reasons: [], ios, android };
  }
  if (iosState !== androidState) {
    return { comparable: false, reasons: ["dialog-presence-mismatch"], ios, android };
  }
  return {
    comparable: sameDialog(ios, android),
    reasons: sameDialog(ios, android) ? [] : ["dialog-content-mismatch"],
    ios,
    android
  };
}
