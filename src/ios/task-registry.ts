import type { IosTaskRecord } from "./types.js";

const tasks = new Map<string, IosTaskRecord>();

export function getIosTask(traceId: string): IosTaskRecord | null {
  return tasks.get(traceId) ?? null;
}

export function registerIosTask(traceId: string, record: IosTaskRecord): void {
  tasks.set(traceId, record);
}

export function __resetIosTasks(): void {
  tasks.clear();
}
