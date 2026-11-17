import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionPlan,
  compareExecutionParity
} from "../dist/figma/execution-plan.js";
import { parseExecutionEvidence } from "../dist/figma/execution-evidence.js";

function plan(platform, engine, env = {}) {
  return buildExecutionPlan({
    platform,
    engine,
    aliases: ["reg_email", "reg_phone"],
    env
  });
}

test("execution plan: iOS/Android 内建复位入口进入 plan", () => {
  const ios = plan("ios", "native-ios", { AOS_IOS_RESET_URL: "testapp://reset" });
  assert.equal(ios.reset.mode, "app-internal-reset");
  assert.equal(ios.reset.entryConfigured, true);
  assert.equal(ios.reset.capability, "deep-link");
  assert.equal(ios.reset.supported, true);
  assert.equal(ios.reset.degraded, false);
  assert.equal(ios.platform, "ios");
  assert.equal(ios.engine, "native-ios");
  assert.equal(ios.budget.maxSteps, null);
  assert.deepEqual(ios.data.aliases, ["reg_email", "reg_phone"]);

  const android = plan("android", "native-android", {
    AOS_ANDROID_RESET_URL: "testapp://reset"
  });
  assert.equal(android.reset.mode, "app-internal-reset");

  const reuse = plan("ios", "proxy", {});
  assert.equal(reuse.reset.mode, "reuse");
  assert.equal(reuse.reset.entryConfigured, false);
  assert.equal(reuse.budget.maxSteps, 30);
});

test("execution plan: AOS_RESET_POLICY=fresh/none 写入 plan", () => {
  const androidFresh = buildExecutionPlan({
    platform: "android",
    engine: "proxy",
    aliases: [],
    env: { AOS_RESET_POLICY: "fresh" }
  });
  assert.equal(androidFresh.reset.mode, "fresh");
  assert.equal(androidFresh.reset.capability, "full-reset");
  assert.equal(androidFresh.reset.supported, true);

  const iosFresh = buildExecutionPlan({
    platform: "ios",
    engine: "ios-llm",
    aliases: [],
    env: { AOS_RESET_POLICY: "fresh" }
  });
  assert.equal(iosFresh.reset.mode, "fresh");
  assert.equal(iosFresh.reset.supported, false);

  const none = buildExecutionPlan({
    platform: "ios",
    engine: "ios-llm",
    aliases: [],
    env: { AOS_RESET_POLICY: "none" }
  });
  assert.equal(none.reset.mode, "none");
  assert.equal(none.reset.supported, true);
});

test("execution plan: task resetPolicy 覆盖项目 env", () => {
  const planView = buildExecutionPlan({
    platform: "android",
    engine: "proxy",
    aliases: [],
    env: { AOS_RESET_POLICY: "none" },
    resetPolicy: "fresh"
  });
  assert.equal(planView.reset.mode, "fresh");
  assert.equal(planView.reset.supported, true);
});

test("execution parity: 同条件才 comparable", () => {
  const base = {
    caseId: "case-1",
    status: "failed",
    plan: plan("ios", "native-ios", {}),
    stepsAvailable: true
  };
  const android = {
    ...base,
    platform: "android",
    plan: plan("android", "native-android", {})
  };
  const same = compareExecutionParity([{ ...base, platform: "ios" }, android]);
  assert.equal(same[0].comparable, true);
  assert.deepEqual(same[0].reasons, []);
  assert.equal(same[0].platforms.ios.status, "failed");
  assert.equal(same[0].platforms.android.status, "failed");

  const missing = compareExecutionParity([{ ...base, platform: "ios" }]);
  assert.equal(missing[0].comparable, false);
  assert.ok(missing[0].reasons.includes("missing-platform:android"));

  const noSteps = compareExecutionParity([
    { ...base, platform: "ios", stepsAvailable: false },
    android
  ]);
  assert.ok(noSteps[0].reasons.includes("steps-unavailable"));

  const resetDiff = compareExecutionParity([
    { ...base, platform: "ios", plan: plan("ios", "native-ios", { AOS_IOS_RESET_URL: "x" }) },
    android
  ]);
  assert.ok(resetDiff[0].reasons.includes("plan-reset-mismatch"));
});

test("execution evidence: 解析 ios-llm plan 与 resetOk；坏 plan 保留 reset", () => {
  const planView = plan("ios", "ios-llm", {});
  const parsed = parseExecutionEvidence({
    schemaVersion: 1,
    plan: planView,
    stepsAvailable: true,
    reset: { ok: false, reason: "launch-failed" }
  });
  assert.equal(parsed.plan?.engine, "ios-llm");
  assert.equal(parsed.stepsAvailable, true);
  assert.equal(parsed.resetOk, false);

  const broken = parseExecutionEvidence({
    schemaVersion: 1,
    plan: { ...planView, engine: "unknown" },
    stepsAvailable: false,
    reset: { ok: true }
  });
  assert.equal(broken.plan, null);
  assert.equal(broken.stepsAvailable, false);
  assert.equal(broken.resetOk, true);
});

test("execution parity: iOS 步数预算 vs Android 未知 → budget-unknown 受限但可比", () => {
  const ios = buildExecutionPlan({
    platform: "ios",
    engine: "proxy",
    aliases: [],
    env: { AOS_IOS_MAX_STEPS: "30" }
  });
  const android = buildExecutionPlan({
    platform: "android",
    engine: "proxy",
    aliases: [],
    env: {}
  });
  const result = compareExecutionParity([
    { caseId: "c-budget", platform: "ios", status: "failed", plan: ios, stepsAvailable: true },
    {
      caseId: "c-budget",
      platform: "android",
      status: "passed",
      plan: android,
      stepsAvailable: true
    }
  ]);
  assert.equal(result[0].comparable, true);
  assert.ok(result[0].limitations.includes("budget-unknown"));
});

test("execution parity: 两端已知步数不同 → budget-mismatch", () => {
  const ios = plan("ios", "proxy", { AOS_IOS_MAX_STEPS: "30" });
  const android = plan("android", "proxy", {});
  android.budget = {
    maxWallMs: null,
    maxSteps: 60,
    maxStepsEffective: 60,
    maxActions: null
  };
  const result = compareExecutionParity([
    { caseId: "c-budget-known", platform: "ios", status: "failed", plan: ios, stepsAvailable: true },
    {
      caseId: "c-budget-known",
      platform: "android",
      status: "passed",
      plan: android,
      stepsAvailable: true
    }
  ]);
  assert.equal(result[0].comparable, false);
  assert.ok(result[0].reasons.includes("budget-mismatch"));
});

test("execution parity: legacy budget=null → budget-unknown 但不阻断比较", () => {
  const ios = plan("ios", "proxy", {});
  const android = plan("android", "proxy", {});
  ios.budget = null;
  android.budget = null;
  const result = compareExecutionParity([
    { caseId: "c-budget-legacy", platform: "ios", status: "passed", plan: ios, stepsAvailable: true },
    {
      caseId: "c-budget-legacy",
      platform: "android",
      status: "passed",
      plan: android,
      stepsAvailable: true
    }
  ]);
  assert.equal(result[0].comparable, true);
  assert.ok(result[0].limitations.includes("budget-unknown"));
});

test("execution parity: reset 失败/不支持/degraded 不可比", () => {
  const ios = plan("ios", "proxy", {});
  const android = plan("android", "proxy", {});
  const pair = (iosPlan, resetOk) => [
    { caseId: "c-reset", platform: "ios", status: "failed", plan: iosPlan, stepsAvailable: true, resetOk },
    { caseId: "c-reset", platform: "android", status: "passed", plan: android, stepsAvailable: true, resetOk: true }
  ];

  const failed = compareExecutionParity(pair(ios, false));
  assert.equal(failed[0].comparable, false);
  assert.ok(failed[0].reasons.includes("reset-failed"));

  const unsupported = compareExecutionParity(
    pair({ ...ios, reset: { ...ios.reset, supported: false } }, true)
  );
  assert.ok(unsupported[0].reasons.includes("reset-unsupported"));

  const degraded = compareExecutionParity(
    pair({ ...ios, reset: { ...ios.reset, degraded: true } }, true)
  );
  assert.ok(degraded[0].reasons.includes("reset-degraded"));
});

test("execution parity: 数据别名不同不可比", () => {
  const ios = buildExecutionPlan({
    platform: "ios",
    engine: "proxy",
    aliases: ["a"],
    env: {}
  });
  const android = buildExecutionPlan({
    platform: "android",
    engine: "proxy",
    aliases: ["a", "b"],
    env: {}
  });
  const result = compareExecutionParity([
    { caseId: "c", platform: "ios", status: "passed", plan: ios, stepsAvailable: true },
    { caseId: "c", platform: "android", status: "passed", plan: android, stepsAvailable: true }
  ]);
  assert.equal(result[0].comparable, false);
  assert.ok(result[0].reasons.includes("data-aliases-mismatch"));
});
