import fs from "node:fs";

import { writeFileAtomic } from "./util.js";

export interface PersistedChildInfo {
  ownerPid?: number;
  pid?: number;
  fingerprint?: string;
  startedAt?: string;
}

export interface PersistedState {
  activeProfile?: string;
  updatedAt?: string;
  child?: PersistedChildInfo;
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  read(): PersistedState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as unknown;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
      return data as PersistedState;
    } catch {
      return {};
    }
  }

  write(state: PersistedState): void {
    const payload: PersistedState = { ...state, updatedAt: new Date().toISOString() };
    writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2) + "\n");
  }
}
