import fs from "node:fs";

import type { SecretEntry } from "../web/llm/secrets.js";
import { writeFileAtomic } from "../util.js";

interface SequenceState {
  [key: string]: {
    base: string;
    domain: string;
    last: number;
  };
}

interface DynamicEntry {
  entry: SecretEntry;
  index: number;
  base: string;
  domain: string;
  number: number;
  key: string;
}

const PLUS_EMAIL = /^(.*)\+(\d+)@([^@\s]+)$/;

/** 自动递增 `base+202@domain` 形式的测试邮箱：同一 base/domain/起始号分组共享一个序号，
 * 例如 reg_email 与 reg_email_confirm 都从 +202 起时，本次用例统一变成 +203。
 * 状态落在项目 `.artemis/secret-sequences.json`，下一条用例继续 +204、+205…；
 * 源 JSON/台账不修改。 */
export function allocateSequencedSecrets(input: {
  secrets: SecretEntry[];
  stateFile: string;
}): SecretEntry[] {
  const dynamic: DynamicEntry[] = [];
  for (let index = 0; index < input.secrets.length; index += 1) {
    const entry = input.secrets[index]!;
    const match = PLUS_EMAIL.exec(entry.value.trim());
    if (match === null) continue;
    const base = match[1] ?? "";
    const number = Number.parseInt(match[2] ?? "", 10);
    const domain = match[3] ?? "";
    if (!Number.isInteger(number) || base === "" || domain === "") continue;
    dynamic.push({
      entry,
      index,
      base,
      domain,
      number,
      key: `${base}@${domain}#${number}`
    });
  }
  if (dynamic.length === 0) return input.secrets;

  let state: SequenceState = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(input.stateFile, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      state = parsed as SequenceState;
    }
  } catch {
    /* first run / malformed state: start from the configured number */
  }

  const nextByKey = new Map<string, number>();
  for (const item of dynamic) {
    if (!nextByKey.has(item.key)) {
      const previous = state[item.key]?.last;
      const baseline = Math.max(
        Number.isInteger(previous) ? previous : 0,
        item.number
      );
      nextByKey.set(item.key, baseline + 1);
    }
  }

  const out = input.secrets.map((entry) => ({ ...entry }));
  for (const item of dynamic) {
    const next = nextByKey.get(item.key)!;
    out[item.index] = {
      ...item.entry,
      value: `${item.base}+${next}@${item.domain}`
    };
    state[item.key] = {
      base: item.base,
      domain: item.domain,
      last: next
    };
  }
  writeFileAtomic(input.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return out;
}
