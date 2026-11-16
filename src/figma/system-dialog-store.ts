import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";

export type DialogPlatform = "ios" | "android";

export interface StoredSystemDialog {
  platform: DialogPlatform;
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

export function writeSystemDialog(rootPath: string, taskId: string, dialog: StoredSystemDialog): void {
  const existing = readSystemDialogs(rootPath, taskId).filter(
    (entry) => entry.platform !== dialog.platform
  );
  const file = systemDialogPath(rootPath, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify([...existing, dialog], null, 2)}\n`);
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

/** 两端同数据下的弹窗内容对照；只比较 title/message/buttons，不判断按钮语义。 */
export function compareSystemDialogs(records: readonly StoredSystemDialog[]): SystemDialogParity {
  const ios = records.find((entry) => entry.platform === "ios") ?? null;
  const android = records.find((entry) => entry.platform === "android") ?? null;
  if (ios === null && android === null) {
    return { comparable: true, reasons: [], ios: null, android: null };
  }
  if (ios === null) return { comparable: false, reasons: ["missing-dialog:ios"], ios, android };
  if (android === null) {
    return { comparable: false, reasons: ["missing-dialog:android"], ios, android };
  }
  return {
    comparable: sameDialog(ios, android),
    reasons: sameDialog(ios, android) ? [] : ["dialog-content-mismatch"],
    ios,
    android
  };
}
