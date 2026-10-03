import assert from "node:assert/strict";
import test from "node:test";

import { classifyFailure } from "../dist/artemis/failure-taxonomy.js";

function status(overrides = {}) {
  return {
    traceId: "trace-1",
    status: "failed",
    deviceSerial: null,
    error: null,
    message: null,
    testSummary: null,
    notesDir: null,
    stderrLog: null,
    stdoutLog: null,
    startTimeMs: null,
    endTimeMs: null,
    ...overrides
  };
}

function failedItem(itemText, evidence) {
  return { itemText, kind: "assert", evidence };
}

test("failure taxonomy: linked crash signature wins as app defect", () => {
  const result = classifyFailure({
    status: status(),
    crashes: [
      {
        id: "crash-abc",
        kind: "java",
        package: "com.example.app",
        exceptionClass: "java.lang.NullPointerException"
      }
    ]
  });
  assert.equal(result.domain, "app-defect");
  assert.equal(result.confidence, "high");
  assert.match(result.reason, /NullPointerException/);
  assert.deepEqual(result.evidence, ["crash-abc"]);
});

test("failure taxonomy: reset and submit errors classify as environment", () => {
  const reset = classifyFailure({
    status: null,
    reset: {
      ok: false,
      reason: "device-offline",
      message: "device offline",
      serial: null,
      adb: { path: "adb", source: "path" },
      commands: []
    }
  });
  assert.equal(reset.domain, "environment");
  assert.equal(reset.confidence, "high");
  assert.deepEqual(reset.evidence, ["reset:device-offline"]);

  const submit = classifyFailure({ submitError: "device not found: no devices connected" });
  assert.equal(submit.domain, "environment");
  assert.equal(submit.confidence, "high");
});

test("failure taxonomy: precondition match raises data-environment confidence", () => {
  const input = {
    status: status({
      testSummary: {
        taskStatus: "failed",
        passed: 0,
        failed: 1,
        inconclusive: null,
        unchecked: null,
        failedItems: [failedItem("进入购物车", "请先登录后重试")]
      }
    }),
    preconditions: ["应用已安装且可正常启动", "「我的」需要已登录账号"]
  };
  const matched = classifyFailure(input);
  assert.equal(matched.domain, "data-environment");
  assert.equal(matched.confidence, "high");
  assert.ok(matched.evidence.some((entry) => entry.startsWith("precondition:")));

  const unmatched = classifyFailure({ ...input, preconditions: [] });
  assert.equal(unmatched.domain, "data-environment");
  assert.equal(unmatched.confidence, "medium");
});

test("failure taxonomy: assertion failures without other signals are behavior-or-design", () => {
  const result = classifyFailure({
    status: status({
      testSummary: {
        taskStatus: "failed",
        passed: 0,
        failed: 1,
        inconclusive: null,
        unchecked: null,
        failedItems: [failedItem("校验金额", "expected 42 got 41")]
      }
    })
  });
  assert.equal(result.domain, "behavior-or-design");
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.evidence, ["校验金额 / expected 42 got 41"]);
});

test("failure taxonomy: timeout and rejected submissions are case defects", () => {
  const timeout = classifyFailure({
    status: status({ status: "running" }),
    timedOut: true
  });
  assert.equal(timeout.domain, "case-defect");
  assert.equal(timeout.confidence, "medium");

  const rejected = classifyFailure({ submitError: "task_desc 参数格式 invalid" });
  assert.equal(rejected.domain, "case-defect");
  assert.equal(rejected.confidence, "medium");
});

test("failure taxonomy: weak signals stay unclassified with a reason", () => {
  const failed = classifyFailure({ status: status({ error: "boom" }) });
  assert.equal(failed.domain, "unclassified");
  assert.equal(failed.confidence, "low");
  assert.match(failed.reason, /无 failed_items/);

  const empty = classifyFailure({});
  assert.equal(empty.domain, "unclassified");
  assert.equal(empty.confidence, "low");
  assert.match(empty.reason, /缺少任务状态/);
});

test("failure taxonomy: classification is deterministic for a fixed sample", () => {
  const input = {
    status: status({
      error: "assert mismatch",
      testSummary: {
        taskStatus: "failed",
        passed: 1,
        failed: 1,
        inconclusive: 0,
        unchecked: 0,
        failedItems: [failedItem("结算", "text mismatch")]
      }
    }),
    preconditions: ["应用已安装且可正常启动", "「商品列表」需要已有可操作数据（列表非空）"]
  };
  const first = classifyFailure(input);
  const second = classifyFailure(input);
  assert.deepEqual(first, second);
  assert.equal(first.domain, "behavior-or-design");
});

test("failure taxonomy: unhandled API errors rank below environment and above behavior", () => {
  const api = classifyFailure({
    status: status({
      testSummary: {
        taskStatus: "failed",
        passed: 0,
        failed: 1,
        inconclusive: null,
        unchecked: null,
        failedItems: [failedItem("校验", "text mismatch")]
      }
    }),
    apiErrors: [
      { code: "AUTH_401", handled: false },
      { code: "ORDER_500", handled: true }
    ]
  });
  assert.equal(api.domain, "api-error");
  assert.equal(api.confidence, "high");
  assert.deepEqual(api.evidence, ["AUTH_401"]);

  const handledOnly = classifyFailure({
    status: status({
      testSummary: {
        taskStatus: "failed",
        passed: 0,
        failed: 1,
        inconclusive: null,
        unchecked: null,
        failedItems: [failedItem("校验", "text mismatch")]
      }
    }),
    apiErrors: [
      { code: "AUTH_401", handled: true },
      { code: "ORDER_500", handled: null }
    ]
  });
  assert.equal(handledOnly.domain, "behavior-or-design");

  const crashWins = classifyFailure({
    status: status(),
    crashes: [{ id: "c1", kind: "java", package: "com.x", exceptionClass: "E" }],
    apiErrors: [{ code: "AUTH_401", handled: false }]
  });
  assert.equal(crashWins.domain, "app-defect");
});
