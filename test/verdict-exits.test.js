import assert from "node:assert/strict";
import test from "node:test";

import { collectVerdictExits } from "../dist/tasks/verdict-exits.js";

function mkCase(caseId, verdict, overrides = {}) {
  return {
    caseId,
    name: `Case ${caseId}`,
    featureKey: "f-1",
    platform: "android",
    status: "failed",
    traceId: null,
    verdict,
    verdictAt: verdict === null ? null : "2026-10-14T12:00:00.000Z",
    verdictNote: null,
    jiraIssueKey: null,
    ...overrides
  };
}

function mkRun(overrides = {}) {
  return {
    id: "run-1",
    createdAt: "2026-10-14T10:00:00.000Z",
    caseSetId: "cs-1",
    featureKey: "f-1",
    featureName: "登录流程",
    platform: "android",
    device: "emulator-5554",
    cases: [],
    ...overrides
  };
}

test("最新裁决：同（份,用例）多条 → 取最新（入参乱序亦自排）", () => {
  const newer = mkRun({ id: "r-new", createdAt: "2026-10-14T11:00:00.000Z" });
  newer.cases = [mkCase("case-1", "case-defect", { verdictAt: "2026-10-14T11:30:00.000Z" })];
  const older = mkRun({ id: "r-old", createdAt: "2026-10-14T09:00:00.000Z" });
  older.cases = [mkCase("case-1", "app-defect")];

  const exits = collectVerdictExits([newer, older]);
  assert.equal(exits.caseDefects.length, 1);
  assert.equal(exits.caseDefects[0].runId, "r-new");
  assert.equal(exits.caseDefects[0].caseId, "case-1");
  assert.equal(exits.appDefects.length, 0);
});

test("最新裁决：最新为 null 时回退到较旧非空", () => {
  const newer = mkRun({ id: "r-new", createdAt: "2026-10-14T11:00:00.000Z" });
  newer.cases = [mkCase("case-1", null)];
  const older = mkRun({ id: "r-old", createdAt: "2026-10-14T09:00:00.000Z" });
  older.cases = [mkCase("case-1", "app-defect")];

  const exits = collectVerdictExits([older, newer]);
  assert.equal(exits.caseDefects.length, 0);
  assert.equal(exits.appDefects.length, 1);
  assert.equal(exits.appDefects[0].runId, "r-old");
});

test("caseDefects/appDefects 过滤与排序（caseId 升序；tie 决出）", () => {
  const runs = [
    mkRun({
      id: "r-1",
      createdAt: "2026-10-14T12:00:00.000Z",
      featureName: "登录流程",
      cases: [
        mkCase("case-b", "case-defect"),
        mkCase("case-a", "app-defect"),
        mkCase("case-c", "case-defect"),
        mkCase("uncertain-case", "uncertain")
      ]
    }),
    mkRun({
      id: "r-2",
      createdAt: "2026-10-14T11:00:00.000Z",
      caseSetId: "cs-2",
      featureKey: "f-2",
      featureName: "下单流程",
      cases: [mkCase("case-x", "case-defect")]
    })
  ];
  const exits = collectVerdictExits(runs);
  assert.deepEqual(
    exits.caseDefects.map((c) => c.caseId),
    ["case-b", "case-c", "case-x"]
  );
  assert.deepEqual(
    exits.appDefects.map((c) => c.caseId),
    ["case-a"]
  );
  assert.equal(
    exits.caseDefects.some((c) => c.caseId === "uncertain-case"),
    false,
    "uncertain 不进清单"
  );
});

test("caseDefects 排序 tie：caseId 相同 → featureName → runId", () => {
  const runs = [
    mkRun({ id: "r-2", createdAt: "2026-10-14T12:00:00.000Z", caseSetId: "cs-2", featureName: "B功能", cases: [mkCase("case-1", "case-defect")] }),
    mkRun({ id: "r-1", createdAt: "2026-10-14T11:00:00.000Z", caseSetId: "cs-1", featureName: "A功能", cases: [mkCase("case-1", "case-defect")] }),
    mkRun({ id: "r-3", createdAt: "2026-10-14T10:00:00.000Z", caseSetId: "cs-3", featureName: "A功能", cases: [mkCase("case-1", "case-defect")] })
  ];
  const exits = collectVerdictExits(runs);
  assert.deepEqual(
    exits.caseDefects.map((c) => `${c.featureName}:${c.runId}`),
    ["A功能:r-1", "A功能:r-3", "B功能:r-2"]
  );
});

test("environment 分组：device+platform、count、features 去重字典序、lastAt 取最大、notes 去重保序", () => {
  const runs = [
    mkRun({
      id: "r-1",
      createdAt: "2026-10-14T12:00:00.000Z",
      device: "emulator-5554",
      cases: [
        mkCase("case-1", "execution-deviation", {
          verdictAt: "2026-10-14T12:05:00.000Z",
          verdictNote: "设备离线"
        }),
        mkCase("case-2", "execution-deviation", {
          verdictAt: "2026-10-14T12:10:00.000Z",
          verdictNote: "网络超时"
        })
      ]
    }),
    mkRun({
      id: "r-2",
      createdAt: "2026-10-14T11:00:00.000Z",
      device: "emulator-5554",
      featureName: "下单流程",
      cases: [
        mkCase("case-3", "execution-deviation", {
          verdictAt: "2026-10-14T11:30:00.000Z",
          verdictNote: "设备离线"
        })
      ]
    }),
    mkRun({
      id: "r-3",
      createdAt: "2026-10-14T10:00:00.000Z",
      device: "R58M",
      platform: "ios",
      cases: [mkCase("case-4", "execution-deviation", { verdictAt: "2026-10-14T10:00:00.000Z", verdictNote: null })]
    })
  ];
  const exits = collectVerdictExits(runs);
  assert.equal(exits.environment.length, 2);

  // count 降序 → emulator-5554(3) 在前
  const android = exits.environment[0];
  assert.equal(android.platform, "android");
  assert.equal(android.device, "emulator-5554");
  assert.equal(android.count, 3);
  assert.deepEqual(android.features, ["下单流程", "登录流程"]);
  assert.equal(android.lastAt, "2026-10-14T12:10:00.000Z");
  // notes 去重保序（新→旧）：设备离线（r-1）先于 网络超时（r-1）… 按入参自排后出现序
  assert.deepEqual(android.notes, ["设备离线", "网络超时"]);

  const ios = exits.environment[1];
  assert.equal(ios.platform, "ios");
  assert.equal(ios.device, "R58M");
  assert.equal(ios.count, 1);
  assert.deepEqual(ios.features, ["登录流程"]);
  assert.equal(ios.lastAt, "2026-10-14T10:00:00.000Z");
  assert.deepEqual(ios.notes, []);
});

test("空 runs → 三清单为空数组；verdict 为 null 跳过；jiraKey 透传", () => {
  const empty = collectVerdictExits([]);
  assert.deepEqual(empty.caseDefects, []);
  assert.deepEqual(empty.environment, []);
  assert.deepEqual(empty.appDefects, []);

  const runs = [
    mkRun({
      cases: [
        mkCase("case-null", null),
        mkCase("case-defect", "case-defect", { jiraIssueKey: "AOS-42" })
      ]
    })
  ];
  const exits = collectVerdictExits(runs);
  assert.equal(exits.caseDefects.length, 1);
  assert.equal(exits.caseDefects[0].caseId, "case-defect");
  assert.equal(exits.caseDefects[0].jiraKey, "AOS-42");
  assert.equal(
    exits.caseDefects.some((c) => c.caseId === "case-null"),
    false,
    "verdict null 跳过"
  );
});

test("份血统口径：featureKey 为 null 的 run 跳过", () => {
  const runs = [
    mkRun({
      featureKey: null,
      featureName: null,
      cases: [mkCase("case-standalone", "case-defect")]
    })
  ];
  const exits = collectVerdictExits(runs);
  assert.deepEqual(exits.caseDefects, []);
  assert.deepEqual(exits.environment, []);
  assert.deepEqual(exits.appDefects, []);
});
