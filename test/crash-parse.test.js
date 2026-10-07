import assert from "node:assert/strict";
import test from "node:test";

import { parseLogcatCrashes } from "../dist/crash/parse.js";

import { logcatLine as line } from "./fixtures/logcat.mjs";

function javaLine(date, message) {
  return line(date, "E", "AndroidRuntime", message);
}

const BASE = new Date(2026, 4, 3, 11, 11, 11, 123);

function windowAround(date, padMs = 10_000) {
  return {
    windowStartMs: date.getTime() - padMs,
    windowEndMs: date.getTime() + padMs,
    referenceMs: date.getTime()
  };
}

const JAVA_CRASH = [
  javaLine(BASE, "FATAL EXCEPTION: main"),
  javaLine(BASE, "Process: com.example.app, PID: 1000"),
  javaLine(BASE, "java.lang.IllegalStateException: boom at init"),
  javaLine(BASE, "\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3600)"),
  javaLine(BASE, "\tat com.example.app.MainActivity.onCreate(MainActivity.kt:42)"),
  javaLine(BASE, "Caused by: java.lang.NullPointerException: Attempt to invoke virtual method"),
  javaLine(BASE, "\tat com.example.app.data.Repo.load(Repo.kt:7)"),
  javaLine(BASE, "\tat com.example.app.MainActivity.onCreate(MainActivity.kt:40)")
].join("\n");

test("parse: java crash is attributed and signed from the root cause app frame", () => {
  const records = parseLogcatCrashes(JAVA_CRASH, windowAround(BASE));
  assert.equal(records.length, 1);
  const crash = records[0];
  assert.equal(crash.kind, "java");
  assert.equal(crash.package, "com.example.app");
  assert.equal(crash.attribution, "process-line");
  assert.equal(crash.exceptionClass, "java.lang.IllegalStateException");
  assert.equal(crash.rootCauseClass, "java.lang.NullPointerException");
  assert.equal(crash.topFrame, "com.example.app.data.Repo.load(Repo.kt:7)");
  assert.match(crash.message, /boom at init/);
  assert.equal(crash.causedBy.length, 1);
  assert.ok(crash.frames.some((frame) => frame.includes("ActivityThread")));
  assert.equal(crash.occurredAt, new Date(BASE.getTime()).toISOString());
  assert.equal(crash.signature.length, 16);
  assert.match(crash.signatureBasis, /root=java\.lang\.NullPointerException/);

  const again = parseLogcatCrashes(JAVA_CRASH, windowAround(BASE));
  assert.equal(again[0].signature, crash.signature, "signature must be stable");
});

test("parse: different root causes produce different signatures", () => {
  const other = JAVA_CRASH.replace(
    "Caused by: java.lang.NullPointerException: Attempt to invoke virtual method",
    "Caused by: java.io.IOException: disk offline"
  );
  const [a] = parseLogcatCrashes(JAVA_CRASH, windowAround(BASE));
  const [b] = parseLogcatCrashes(other, windowAround(BASE));
  assert.notEqual(a.signature, b.signature);
  assert.equal(b.rootCauseClass, "java.io.IOException");
});

test("parse: framework-top frames fall back to the first app frame", () => {
  const text = [
    javaLine(BASE, "FATAL EXCEPTION: main"),
    javaLine(BASE, "Process: com.foo, PID: 2"),
    javaLine(BASE, "java.lang.RuntimeException: handler"),
    javaLine(BASE, "\tat android.os.Handler.dispatchMessage(Handler.java:106)"),
    javaLine(BASE, "\tat android.os.Looper.loop(Looper.java:223)"),
    javaLine(BASE, "\tat com.foo.Worker$1.run(Worker.kt:9)")
  ].join("\n");
  const [crash] = parseLogcatCrashes(text, windowAround(BASE));
  assert.equal(crash.topFrame, "com.foo.Worker$1.run(Worker.kt:9)");
});

test("parse: package filter and unattributed handling", () => {
  const filtered = parseLogcatCrashes(JAVA_CRASH, {
    ...windowAround(BASE),
    packageFilter: "com.other"
  });
  assert.equal(filtered.length, 0);

  const unattributed = [
    javaLine(BASE, "FATAL EXCEPTION: main"),
    javaLine(BASE, "java.lang.RuntimeException: no process line"),
    javaLine(BASE, "\tat com.foo.A.a(A.kt:1)")
  ].join("\n");
  assert.equal(parseLogcatCrashes(unattributed, windowAround(BASE)).length, 0);
  const included = parseLogcatCrashes(unattributed, {
    ...windowAround(BASE),
    includeUnattributed: true
  });
  assert.equal(included.length, 1);
  assert.equal(included[0].attribution, "unknown");
});

test("parse: native crash uses the tombstone header for attribution", () => {
  const base = new Date(2026, 4, 3, 12, 0, 0, 1);
  const text = [
    line(base, "F", "libc", "Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 in tid 2001 (RenderThread), pid 2000", 2000),
    line(base, "I", "DEBUG", "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***", 2000),
    line(base, "I", "DEBUG", "pid: 2000, tid: 2001, name: RenderThread  >>> com.example.app <<<", 2000),
    line(base, "I", "DEBUG", "    #00 pc 0000000000012345  /data/app/lib/arm64/libfoo.so (Java_com_example_app_nativeRender+16)", 2000),
    line(base, "I", "DEBUG", "    #01 pc 0000000000054321  /data/app/lib/arm64/libfoo.so (foo::bar()+32)", 2000)
  ].join("\n");
  const [crash] = parseLogcatCrashes(text, windowAround(base));
  assert.equal(crash.kind, "native");
  assert.equal(crash.package, "com.example.app");
  assert.equal(crash.attribution, "tombstone-header");
  assert.equal(crash.exceptionClass, "signal 11 (SIGSEGV)");
  assert.match(crash.topFrame, /#00 pc/);
  assert.match(crash.signatureBasis, /Java_com_example_app_nativeRender\+16/);
  assert.ok(crash.frames.length >= 2);
});

test("parse: ANR lines are recorded", () => {
  const text = line(
    BASE,
    "E",
    "ActivityManager",
    "ANR in com.example.app (com.example.app/.MainActivity)"
  );
  const [crash] = parseLogcatCrashes(text, windowAround(BASE));
  assert.equal(crash.kind, "anr");
  assert.equal(crash.package, "com.example.app");
  assert.equal(crash.topFrame, "ANR in com.example.app");
});

test("parse: time window with slack filters events outside the task", () => {
  const inside = parseLogcatCrashes(JAVA_CRASH, {
    windowStartMs: BASE.getTime() - 60_000,
    windowEndMs: BASE.getTime() + 60_000,
    referenceMs: BASE.getTime()
  });
  assert.equal(inside.length, 1);

  const outside = parseLogcatCrashes(JAVA_CRASH, {
    windowStartMs: BASE.getTime() + 60_000,
    windowEndMs: BASE.getTime() + 120_000,
    referenceMs: BASE.getTime()
  });
  assert.equal(outside.length, 0);

  const edge = parseLogcatCrashes(JAVA_CRASH, {
    windowStartMs: BASE.getTime() + 3_000,
    windowEndMs: BASE.getTime() + 30_000,
    referenceMs: BASE.getTime()
  });
  assert.equal(edge.length, 1, "slack keeps an event just before the window start");
});

test("parse: clock skew is compensated by the device offset", () => {
  const offsetMs = 3_600_000;
  const hostWindow = {
    windowStartMs: BASE.getTime() - offsetMs - 10_000,
    windowEndMs: BASE.getTime() - offsetMs + 10_000,
    referenceMs: BASE.getTime() - offsetMs
  };
  const withOffset = parseLogcatCrashes(JAVA_CRASH, { ...hostWindow, clockOffsetMs: offsetMs });
  assert.equal(withOffset.length, 1);

  const withoutOffset = parseLogcatCrashes(JAVA_CRASH, hostWindow);
  assert.equal(withoutOffset.length, 0);
});

test("parse: logs from a previous year are inferred across the boundary", () => {
  const logDate = new Date(2025, 11, 31, 23, 30, 0, 0);
  const reference = new Date(2026, 0, 1, 0, 10, 0, 0);
  const text = [
    javaLine(logDate, "FATAL EXCEPTION: main"),
    javaLine(logDate, "Process: com.example.app, PID: 1"),
    javaLine(logDate, "java.lang.RuntimeException: x"),
    javaLine(logDate, "\tat com.example.app.A.a(A.kt:1)")
  ].join("\n");
  const [crash] = parseLogcatCrashes(text, {
    windowStartMs: logDate.getTime() - 1000,
    windowEndMs: logDate.getTime() + 1000,
    referenceMs: reference.getTime()
  });
  assert.ok(crash, "crash must be inside the window after year rollback");
  assert.equal(new Date(crash.occurredAt).getFullYear(), 2025);
});

test("parse: back-to-back FATAL blocks in the crash buffer are split per crash", () => {
  const second = new Date(BASE.getTime() + 1_800_000);
  const text = [
    JAVA_CRASH,
    javaLine(second, "FATAL EXCEPTION: main"),
    javaLine(second, "Process: com.other.app, PID: 2000"),
    javaLine(second, "java.lang.ArithmeticException: / by zero"),
    javaLine(second, "\tat com.other.app.Main.run(Main.kt:3)")
  ].join("\n");
  const records = parseLogcatCrashes(text, {
    windowStartMs: BASE.getTime() - 10_000,
    windowEndMs: second.getTime() + 10_000,
    referenceMs: BASE.getTime()
  });
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.package).sort(),
    ["com.example.app", "com.other.app"]
  );
});

test("parse: multiple crashes are returned separately and noise is ignored", () => {
  const text = [
    "--------- beginning of crash",
    JAVA_CRASH,
    line(BASE, "I", "ActivityManager", "Start proc com.example.app for activity"),
    line(BASE, "E", "AndroidRuntime", "FATAL EXCEPTION: main", 2000),
    line(BASE, "E", "AndroidRuntime", "Process: com.other.app, PID: 2000", 2000),
    line(BASE, "E", "AndroidRuntime", "java.lang.ArithmeticException: / by zero", 2000),
    line(BASE, "E", "AndroidRuntime", "\tat com.other.app.Main.run(Main.kt:3)", 2000)
  ].join("\n");
  const records = parseLogcatCrashes(text, windowAround(BASE));
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.package).sort(),
    ["com.example.app", "com.other.app"]
  );
});

test("parse: empty or non-crash logs yield nothing", () => {
  assert.equal(parseLogcatCrashes("", windowAround(BASE)).length, 0);
  assert.equal(
    parseLogcatCrashes(
      [line(BASE, "I", "ActivityManager", "nothing here")].join("\n"),
      windowAround(BASE)
    ).length,
    0
  );
});
