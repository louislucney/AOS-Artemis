import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_MAX_EVENTS_DEFAULT,
  USAGE_RETENTION_DAYS_DEFAULT,
  usageEnabledFrom,
  usageEventInputFrom,
  usageEventSampleLimit,
  usageFamilyOf,
  usagePolicyFrom
} from "../dist/usage/capture.js";

function textPayload(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]
  };
}

function errorPayload(text) {
  return { content: [{ type: "text", text }], isError: true };
}

test("usage capture: AOS_USAGE=0 disables, everything else enables", () => {
  assert.equal(usageEnabledFrom({}), true);
  assert.equal(usageEnabledFrom({ AOS_USAGE: "1" }), true);
  assert.equal(usageEnabledFrom({ AOS_USAGE: "false" }), true);
  assert.equal(usageEnabledFrom({ AOS_USAGE: "" }), true);
  assert.equal(usageEnabledFrom({ AOS_USAGE: "0" }), false);
  assert.equal(usageEnabledFrom({ AOS_USAGE: " 0 " }), false);
});

test("usage capture: policy defaults, zero, custom and invalid values", () => {
  assert.deepEqual(usagePolicyFrom({}), {
    retentionDays: USAGE_RETENTION_DAYS_DEFAULT,
    maxEvents: USAGE_MAX_EVENTS_DEFAULT
  });
  assert.deepEqual(
    usagePolicyFrom({ AOS_USAGE_RETENTION_DAYS: "0", AOS_USAGE_MAX_EVENTS: "0" }),
    { retentionDays: 0, maxEvents: 0 }
  );
  assert.deepEqual(
    usagePolicyFrom({ AOS_USAGE_RETENTION_DAYS: "7", AOS_USAGE_MAX_EVENTS: "100" }),
    { retentionDays: 7, maxEvents: 100 }
  );
  assert.equal(usagePolicyFrom({ AOS_USAGE_RETENTION_DAYS: "30.9" }).retentionDays, 30);
  for (const bad of ["abc", "-1", "  ", "1e", "NaN", "Infinity"]) {
    assert.deepEqual(
      usagePolicyFrom({ AOS_USAGE_RETENTION_DAYS: bad, AOS_USAGE_MAX_EVENTS: bad }),
      { retentionDays: USAGE_RETENTION_DAYS_DEFAULT, maxEvents: USAGE_MAX_EVENTS_DEFAULT },
      `expected fallback for ${JSON.stringify(bad)}`
    );
  }
});

test("usage capture: family mapping incl. unknown", () => {
  assert.equal(usageFamilyOf("mobile_run_task"), "mobile");
  assert.equal(usageFamilyOf("mobile_get_device_state"), "mobile");
  assert.equal(usageFamilyOf("figma_import_tokens"), "figma");
  assert.equal(usageFamilyOf("pen_export"), "pen");
  assert.equal(usageFamilyOf("llm_switch"), "native");
  assert.equal(usageFamilyOf("aos_status"), "native");
  assert.equal(usageFamilyOf("get_current_selection"), "native");
  assert.equal(usageFamilyOf("definitely_not_a_tool"), "unknown");
  assert.equal(usageFamilyOf(""), "unknown");
});

test("usage capture: derives event fields and never leaks argument values", () => {
  const input = usageEventInputFrom(
    "llm_switch",
    { zeta: "sk-secret-123456", alpha: { nested: "value" }, name: "ghost" },
    textPayload({ ok: true }),
    42
  );
  assert.equal(input.tool, "llm_switch");
  assert.equal(input.family, "native");
  assert.equal(input.ok, true);
  assert.equal(input.durationMs, 42);
  assert.equal(input.errorClass, null);
  assert.equal(input.errorSummary, null);
  assert.deepEqual(input.argKeys, ["alpha", "name", "zeta"]);
  assert.ok(!JSON.stringify(input).includes("sk-secret-123456"));
  assert.deepEqual(usageEventInputFrom("llm_list", undefined, textPayload({ ok: true }), 1).argKeys, []);
});

test("usage capture: error classes by response text", () => {
  const validation = usageEventInputFrom(
    "llm_switch",
    {},
    errorPayload("参数校验失败: Required"),
    5
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.errorClass, "validation");

  const figma = usageEventInputFrom(
    "figma_import_tokens",
    {},
    errorPayload('Figma 工具 "figma_import_tokens" 执行失败: Figma 限流（429）'),
    5
  );
  assert.equal(figma.errorClass, "figma");

  const artemis = usageEventInputFrom(
    "mobile_run_task",
    {},
    errorPayload('工具 "mobile_run_task" 执行失败: 子进程不可用'),
    5
  );
  assert.equal(artemis.errorClass, "artemis");

  const timeout = usageEventInputFrom(
    "mobile_run_task",
    {},
    errorPayload('工具 "mobile_run_task" 执行失败: request timed out'),
    5
  );
  assert.equal(timeout.errorClass, "timeout");

  const nativeTimeout = usageEventInputFrom(
    "pen_export",
    {},
    errorPayload("pen CLI 超时（120000ms）"),
    5
  );
  assert.equal(nativeTimeout.errorClass, "timeout");

  const internal = usageEventInputFrom(
    "llm_list",
    {},
    errorPayload('工具 "llm_list" 执行失败: boom'),
    5
  );
  assert.equal(internal.errorClass, "internal");

  const unknown = usageEventInputFrom(
    "llm_switch",
    {},
    errorPayload(JSON.stringify({ ok: false, error: '未知条目 "ghost"。' })),
    5
  );
  assert.equal(unknown.errorClass, "unknown");
  assert.equal(unknown.errorSummary, '未知条目 "ghost"。');

  const mobileResult = usageEventInputFrom(
    "mobile_manage_task",
    {},
    errorPayload(JSON.stringify({ ok: false, error: "trace 不存在" })),
    5
  );
  assert.equal(mobileResult.errorClass, "artemis");

  const success = usageEventInputFrom("llm_list", {}, textPayload({ ok: true }), 5);
  assert.equal(success.ok, true);
  assert.equal(success.errorClass, null);
});

test("usage capture: errorSummary takes the first line for plain text", () => {
  const input = usageEventInputFrom(
    "figma_export_brief",
    {},
    errorPayload("Figma 渲染失败: 403 Forbidden\n提示：REST 模式需要 FIGMA_ACCESS_TOKEN。"),
    5
  );
  assert.equal(input.errorSummary, "Figma 渲染失败: 403 Forbidden");
});

test("usage capture: warnings extraction (valid, malformed, non-JSON)", () => {
  const payload = {
    warnings: [
      { code: "param_ignored", field: "model" },
      { code: "vision_degraded" },
      "legacy_warning",
      { field: "no_code" }
    ]
  };
  const input = usageEventInputFrom("mobile_run_task", {}, textPayload(payload), 3);
  assert.deepEqual(input.signals, [
    { code: "param_ignored", field: "model" },
    { code: "vision_degraded" },
    { code: "legacy_warning" }
  ]);

  const nested = usageEventInputFrom(
    "mobile_run_task",
    {},
    textPayload({ result: { warnings: [{ code: "nested_code" }] } }),
    3
  );
  assert.deepEqual(nested.signals, [{ code: "nested_code" }]);

  assert.deepEqual(
    usageEventInputFrom("mobile_run_task", {}, textPayload('{"warnings": ['), 3).signals,
    []
  );
  assert.deepEqual(
    usageEventInputFrom("mobile_run_task", {}, textPayload("工具执行成功"), 3).signals,
    []
  );
});

test("usage capture: known degradation/fallback markers are recorded and deduped", () => {
  const fallback = usageEventInputFrom(
    "design_device_diff",
    {},
    textPayload({
      device: { note: "无损 PNG 不可用（missing），已回退 live JPEG" }
    }),
    3
  );
  assert.deepEqual(fallback.signals, [{ code: "lossless_fallback" }]);

  const skipped = usageEventInputFrom(
    "figma_import_tokens",
    {},
    textPayload({ action: "skipped_unmanaged" }),
    3
  );
  assert.deepEqual(skipped.signals, [{ code: "skipped_unmanaged" }]);

  const bridge = usageEventInputFrom(
    "aos_status",
    {},
    textPayload({ figma: { bridge: { status: "skipped_occupied" } } }),
    3
  );
  assert.deepEqual(bridge.signals, [{ code: "skipped_occupied" }]);

  const simctl = usageEventInputFrom(
    "design_device_diff",
    {},
    textPayload({ note: "iOS 模拟器 PNG（simctl 兜底，udid=1）" }),
    3
  );
  assert.deepEqual(simctl.signals, [{ code: "simctl_fallback" }]);

  const iosLog = usageEventInputFrom(
    "suite_run",
    {},
    textPayload({ apiErrorsDegraded: "ios-log-unsupported" }),
    3
  );
  assert.deepEqual(iosLog.signals, [{ code: "ios-log-unsupported" }]);

  const warningWithField = usageEventInputFrom(
    "mobile_run_task",
    {},
    textPayload({ warnings: [{ code: "param_ignored", field: "model" }] }),
    3
  );
  assert.deepEqual(warningWithField.signals, [{ code: "param_ignored", field: "model" }]);
});

test("usage capture: traceId best-effort from the result payload", () => {
  assert.equal(
    usageEventInputFrom("mobile_run_task", {}, textPayload({ trace_id: "trace-abc12345" }), 1)
      .traceId,
    "trace-abc12345"
  );
  assert.equal(
    usageEventInputFrom("mobile_run_task", {}, textPayload({ trace_id: "ios-run-1" }), 1).traceId,
    "ios-run-1"
  );
  assert.equal(usageEventInputFrom("llm_list", {}, textPayload({ ok: true }), 1).traceId, null);
});

test("usage capture: event sample limit follows AOS_USAGE_MAX_EVENTS", () => {
  assert.equal(usageEventSampleLimit({}), USAGE_MAX_EVENTS_DEFAULT);
  assert.equal(usageEventSampleLimit({ AOS_USAGE_MAX_EVENTS: "120000" }), 120000);
  assert.equal(usageEventSampleLimit({ AOS_USAGE_MAX_EVENTS: "0" }), USAGE_MAX_EVENTS_DEFAULT);
  assert.equal(usageEventSampleLimit({ AOS_USAGE_MAX_EVENTS: "nope" }), USAGE_MAX_EVENTS_DEFAULT);
});
