import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import {
  parseJsonObject,
  resultPayload,
  resultText,
  taskStatusFromFile,
  taskStatusOf,
  traceIdOf
} from "../dist/artemis/task-result.js";

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

test("resultPayload: structuredContent wins, text JSON parses, invalid is null", () => {
  assert.deepEqual(
    resultPayload({
      structuredContent: { status: "completed" },
      content: [{ type: "text", text: JSON.stringify({ status: "failed" }) }]
    }),
    { status: "completed" }
  );
  assert.deepEqual(resultPayload(textResult({ status: "completed" })), { status: "completed" });
  assert.equal(resultPayload({ content: [{ type: "text", text: "not json" }] }), null);
  assert.equal(resultPayload({ content: [{ type: "text", text: "[1,2]" }] }), null);
  assert.equal(resultPayload({ content: [] }), null);
});

test("parseJsonObject and resultText handle plain text and empty content", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(parseJsonObject("nope"), null);
  assert.equal(parseJsonObject("   "), null);
  assert.equal(resultText({ content: [{ type: "text", text: "hello" }] }), "hello\n");
});

test("traceIdOf: structured, text payload, regex fallback", () => {
  assert.equal(traceIdOf({ structuredContent: { trace_id: "trace-a" } }), "trace-a");
  assert.equal(traceIdOf(textResult({ trace_id: "trace-b" })), "trace-b");
  assert.equal(
    traceIdOf({ content: [{ type: "text", text: "started trace_id=abcdef123456 ok" }] }),
    "abcdef123456"
  );
  assert.equal(traceIdOf(textResult({ ok: true })), null);
  assert.equal(traceIdOf({ content: [] }), null);
});

test("taskStatusOf: typed status, summary counters and failed items", () => {
  const status = taskStatusOf({
    trace_id: "t1",
    status: "failed",
    device_serial: "emulator-5554",
    error: "boom",
    message: "detail",
    notes_dir: "/notes",
    stderr_log: "/err.log",
    stdout_log: "/out.log",
    start_time: 100,
    end_time: 160,
    test_summary: {
      task_status: "failed",
      passed: 1,
      failed: 2,
      inconclusive: 0,
      unchecked: 3,
      failed_items: [
        { item_text: "checkout", kind: "assert", evidence: "text mismatch" },
        { itemText: "camel", kind: "assert" }
      ]
    }
  });

  assert.equal(status.traceId, "t1");
  assert.equal(status.status, "failed");
  assert.equal(status.deviceSerial, "emulator-5554");
  assert.equal(status.error, "boom");
  assert.equal(status.message, "detail");
  assert.equal(status.notesDir, "/notes");
  assert.equal(status.stderrLog, "/err.log");
  assert.equal(status.stdoutLog, "/out.log");
  assert.equal(status.startTimeMs, 100000);
  assert.equal(status.endTimeMs, 160000);
  assert.equal(status.testSummary.taskStatus, "failed");
  assert.equal(status.testSummary.passed, 1);
  assert.equal(status.testSummary.failed, 2);
  assert.equal(status.testSummary.inconclusive, 0);
  assert.equal(status.testSummary.unchecked, 3);
  assert.deepEqual(status.testSummary.failedItems, [
    { itemText: "checkout", kind: "assert", evidence: "text mismatch" },
    { itemText: "camel", kind: "assert", evidence: null }
  ]);
});

test("taskStatusOf: empty payload yields nulls; null payload is null", () => {
  const status = taskStatusOf({});
  assert.equal(status.traceId, null);
  assert.equal(status.status, null);
  assert.equal(status.testSummary, null);
  assert.equal(taskStatusOf(null), null);
  assert.equal(taskStatusOf({ test_summary: [] }).testSummary, null);
  assert.equal(taskStatusOf({ test_summary: {} }).testSummary.failedItems.length, 0);
});

test("taskStatusFromFile: reads status.json, null on missing or corrupt", () => {
  const dir = makeTempDir("aos-codec-");
  const file = path.join(dir, "status.json");
  fs.writeFileSync(file, JSON.stringify({ status: "completed", start_time: 10, end_time: 20 }));

  const status = taskStatusFromFile(file);
  assert.equal(status.status, "completed");
  assert.equal(status.startTimeMs, 10000);
  assert.equal(status.endTimeMs, 20000);
  assert.equal(taskStatusFromFile(path.join(dir, "missing.json")), null);

  fs.writeFileSync(file, "{not json");
  assert.equal(taskStatusFromFile(file), null);
});
