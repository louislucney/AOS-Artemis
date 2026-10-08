import assert from "node:assert/strict";
import test from "node:test";

import { parseQuarantine } from "../dist/figma/quarantine.js";

test("parseQuarantine: active entries need owner+signature; expired become stale", () => {
  const now = new Date("2026-10-08T00:00:00.000Z");
  const raw = JSON.stringify({
    entries: [
      { caseId: "case-a", owner: "alice", signedAt: "2026-10-01T00:00:00.000Z", reason: "staging crash" },
      { caseId: "case-b", owner: "bob", signedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-07T00:00:00.000Z" },
      { caseId: "case-c", owner: "carol", signedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z" },
      { caseId: "case-d", signedAt: "2026-10-01T00:00:00.000Z" },
      { caseId: "case-e" }
    ]
  });
  const parsed = parseQuarantine(raw, now);
  assert.deepEqual([...parsed.active.keys()].sort(), ["case-a", "case-c"]);
  assert.deepEqual(
    parsed.stale.map((entry) => entry.caseId),
    ["case-b"]
  );
  assert.ok(parsed.invalid.some((message) => message.includes("case-d")));
  assert.ok(parsed.invalid.some((message) => message.includes("case-e")));
});

test("parseQuarantine: malformed input is rejected without throwing", () => {
  assert.deepEqual(parseQuarantine("{not json", new Date()).invalid, ["quarantine.json 不是合法 JSON"]);
  assert.deepEqual(parseQuarantine("{}", new Date()).invalid, ["quarantine.json 缺少 entries 数组"]);
});
