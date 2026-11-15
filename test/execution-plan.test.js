import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionPlan,
  compareExecutionParity
} from "../dist/figma/execution-plan.js";

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
  assert.equal(ios.platform, "ios");
  assert.equal(ios.engine, "native-ios");
  assert.equal(ios.budget, null);
  assert.deepEqual(ios.data.aliases, ["reg_email", "reg_phone"]);

  const android = plan("android", "native-android", {
    AOS_ANDROID_RESET_URL: "testapp://reset"
  });
  assert.equal(android.reset.mode, "app-internal-reset");

  const reuse = plan("ios", "proxy", {});
  assert.equal(reuse.reset.mode, "reuse");
  assert.equal(reuse.reset.entryConfigured, false);
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
