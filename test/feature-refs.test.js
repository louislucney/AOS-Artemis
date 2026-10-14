import assert from "node:assert/strict";
import test from "node:test";

import { latestFeatureRefs } from "../dist/tasks/feature-refs.js";

test("latestFeatureRefs: 同 key 两份取新份；不同 key 各自最新；空集 → 空 Map", () => {
  const newer = {
    id: "cs-new",
    features: [
      { key: "f-1", name: "登录流程", caseCount: 2, jsonPath: "/x/new-登录.json" },
      { key: "f-2", name: "下单流程", caseCount: 1, jsonPath: "/x/new-下单.json" }
    ]
  };
  const older = {
    id: "cs-old",
    features: [
      { key: "f-1", name: "登录流程", caseCount: 1, jsonPath: "/x/old-登录.json" },
      { key: "f-3", name: "支付流程", caseCount: 1, jsonPath: "/x/old-支付.json" }
    ]
  };

  const latest = latestFeatureRefs([newer, older]);
  assert.deepEqual([...latest.keys()].sort(), ["f-1", "f-2", "f-3"]);
  assert.deepEqual(latest.get("f-1"), {
    caseSetId: "cs-new",
    featureKey: "f-1",
    featureName: "登录流程",
    caseCount: 2,
    jsonPath: "/x/new-登录.json"
  });
  assert.equal(latest.get("f-2").caseSetId, "cs-new");
  assert.equal(latest.get("f-3").caseSetId, "cs-old", "旧份独有 key 仍可解析");
  assert.deepEqual(latestFeatureRefs([]), new Map());
});
