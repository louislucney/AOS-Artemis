import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSince,
  payloadHash,
  stableStringify,
  validateEventInput
} from "../dist/events/protocol.js";

test("stableStringify: 键排序、数组保序、缺省归一", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(stableStringify({ a: [2, 1] }), '{"a":[2,1]}');
  assert.equal(stableStringify(undefined), "null");
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
});

test("payloadHash: 键顺序不同同哈希，数组顺序不同不同哈希", () => {
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }));
  assert.notEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [2, 1] }));
  assert.equal(payloadHash(undefined), payloadHash(null));
});

test("normalizeSince: 秒级输入规范化为毫秒 ISO", () => {
  assert.equal(normalizeSince("2026-10-20T07:00:03Z"), "2026-10-20T07:00:03.000Z");
  assert.equal(normalizeSince("bad"), null);
});

test("validateEventInput: per-type 必填与 allowlist", () => {
  const ok = validateEventInput(
    {
      eventId: "e1",
      type: "case.result",
      caseId: "TC_1",
      status: "failed",
      at: "2026-10-20T07:00:03Z",
      payload: { message: "x" }
    },
    new Date("2026-10-20T07:00:04Z")
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.at, "2026-10-20T07:00:03.000Z");
  assert.equal(ok.value.source, "project");

  assert.equal(validateEventInput({ eventId: "e", type: "case.result" }).ok, false);
  assert.equal(validateEventInput({ eventId: "e", type: "nope" }).ok, false);
  assert.equal(validateEventInput({ eventId: "e", type: "run.step", runId: "r" }).ok, false);
  assert.equal(
    validateEventInput({ eventId: "e", type: "run.finished", runId: "r", status: "started" }).ok,
    false
  );
  assert.equal(validateEventInput({ eventId: "e", type: "log.entry" }).ok, false);
});
