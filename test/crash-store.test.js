import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CrashIndexStore } from "../dist/crash/store.js";

function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-crash-"));
  return { dir, store: new CrashIndexStore(path.join(dir, "crashes"), options) };
}

function meta(traceId, taskOutcome = "failed", capturedAt = new Date().toISOString()) {
  return {
    traceId,
    taskOutcome,
    deviceSerial: "emulator-5554",
    capturedAt,
    source: "crash-buffer"
  };
}

function parsedCrash(overrides = {}) {
  const signature = overrides.signature ?? "0".repeat(16);
  return {
    kind: "java",
    package: "com.example.app",
    attribution: "process-line",
    exceptionClass: "java.lang.RuntimeException",
    message: "boom",
    rootCauseClass: "java.lang.RuntimeException",
    topFrame: "com.example.app.A.a(A.kt:1)",
    frames: ["com.example.app.A.a(A.kt:1)"],
    causedBy: [],
    signature,
    signatureBasis: "root=java.lang.RuntimeException; frame=com.example.app.A.a(A.kt:1)",
    occurredAt: "2026-05-03T11:11:11.123Z",
    occurredAtMs: Date.now(),
    excerpt: "FATAL EXCEPTION: main",
    ...overrides
  };
}

test("store: same signature increments occurrences and keeps outcomes", () => {
  const { dir, store } = makeStore();
  const crash = parsedCrash({ signature: "a".repeat(16) });
  store.upsert([crash], meta("t1", "failed"));
  store.upsert([crash], meta("t2", "completed"));

  const { total, records } = store.list();
  assert.equal(total, 1);
  assert.equal(records[0].occurrences, 2);
  assert.deepEqual(records[0].traceIds, ["t1", "t2"]);
  assert.deepEqual(records[0].outcomeCounts, { failed: 1, completed: 1 });
  assert.ok(fs.existsSync(path.join(dir, "crashes", `${"a".repeat(16)}.json`)));

  const full = store.get("a".repeat(16));
  assert.deepEqual(full.frames, crash.frames);
  assert.match(full.excerpt, /FATAL EXCEPTION/);
});

test("store: duplicate signatures within one batch count once", () => {
  const { store } = makeStore();
  const crash = parsedCrash();
  store.upsert([crash, crash], meta("t1"));
  assert.equal(store.list().records[0].occurrences, 1);
  assert.equal(store.counts().records, 1);
});

test("store: maxRecords evicts the oldest signature and its record file", () => {
  const { dir, store } = makeStore({ maxRecords: 2 });
  const base = Date.parse("2026-05-03T10:00:00.000Z");
  const ids = ["1".repeat(16), "2".repeat(16), "3".repeat(16)];
  store.upsert([parsedCrash({ signature: ids[0] })], meta("t1", "failed", new Date(base).toISOString()));
  store.upsert([parsedCrash({ signature: ids[1] })], meta("t2", "failed", new Date(base + 1000).toISOString()));
  store.upsert([parsedCrash({ signature: ids[2] })], meta("t3", "failed", new Date(base + 2000).toISOString()));

  const { total, records } = store.list();
  assert.equal(total, 2);
  assert.ok(!records.some((record) => record.id === ids[0]));
  assert.ok(!fs.existsSync(path.join(dir, "crashes", `${ids[0]}.json`)));
});

test("store: corrupt index is quarantined and rebuilt", () => {
  const { dir, store } = makeStore();
  fs.mkdirSync(path.join(dir, "crashes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "crashes", "index.json"), "{not json", "utf-8");

  assert.equal(store.list().total, 0);
  assert.ok(fs.existsSync(path.join(dir, "crashes", "index.json.corrupt")));

  store.upsert([parsedCrash()], meta("t1"));
  assert.equal(store.list().total, 1);
});

test("store: scanned traces are tracked and pruned", () => {
  const { store } = makeStore({ scannedKeep: 2 });
  store.recordScan("t1", { at: "2026-05-03T10:00:00.000Z", found: 0 });
  assert.equal(store.isScanned("t1"), true);
  store.recordScan("t2", { at: "2026-05-03T10:01:00.000Z", found: 1 });
  store.recordScan("t3", { at: "2026-05-03T10:02:00.000Z", found: 0 });

  assert.equal(store.isScanned("t1"), false, "oldest scanned entry is pruned");
  assert.equal(store.isScanned("t3"), true);
  assert.equal(store.counts().scanned, 2);
});

test("store: list filters by kind, package, since and limit", () => {
  const { store } = makeStore();
  const early = new Date("2026-05-03T10:00:00.000Z").toISOString();
  const late = new Date("2026-05-03T12:00:00.000Z").toISOString();
  store.upsert([parsedCrash({ signature: "1".repeat(16) })], meta("t1", "failed", early));
  store.upsert(
    [parsedCrash({ signature: "2".repeat(16), kind: "native", package: "com.other" })],
    meta("t2", "failed", late)
  );

  assert.equal(store.list({ kind: "native" }).total, 1);
  assert.equal(store.list({ package: "com.example.app" }).total, 1);
  assert.equal(store.list({ sinceMs: Date.parse("2026-05-03T11:00:00.000Z") }).total, 1);
  assert.equal(store.list({ limit: 1 }).records.length, 1);
});

test("store: get falls back to the index when the record file is gone", () => {
  const { dir, store } = makeStore();
  const id = "a".repeat(16);
  store.upsert([parsedCrash({ signature: id })], meta("t1"));
  fs.rmSync(path.join(dir, "crashes", `${id}.json`));

  const record = store.get(id);
  assert.ok(record);
  assert.deepEqual(record.frames, []);
  assert.equal(store.get("missing"), null);
});
