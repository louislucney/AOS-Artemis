import assert from "node:assert/strict";
import test from "node:test";

import { executeSuiteBatch } from "../dist/figma/suite-batch.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function runReport(
  uiStatus,
  { functionalFailure = false, quarantined = false, highConfidenceHeavier = null } = {}
) {
  return {
    ok: true,
    testsPath: "tests.json",
    total: 1,
    executed: 1,
    skipped: 0,
    passed: functionalFailure ? 0 : 1,
    failed: functionalFailure ? 1 : 0,
    ui:
      uiStatus === undefined
        ? { passed: 0, failed: 0, unverified: 1, notApplicable: 0 }
        : {
            passed: uiStatus === "passed" ? 1 : 0,
            failed: uiStatus === "failed" ? 1 : 0,
            unverified: uiStatus === "unverified" ? 1 : 0,
            notApplicable: uiStatus === "not-applicable" ? 1 : 0
          },
    preflight: null,
    apiErrorCatalog: null,
    cases: [
      {
        caseId: "case-1",
        name: "用例一",
        status: functionalFailure ? "failed" : "passed",
        traceId: "trace-1",
        ...(quarantined ? { quarantined: true } : {}),
        ...(uiStatus === undefined
          ? {}
          : {
              ui: {
                status: uiStatus,
                reason: "auto-diff",
                ...(highConfidenceHeavier === null
                  ? {}
                  : {
                      textStyles: {
                        textsTotal: 1,
                        checked: 1,
                        lighter: 0,
                        similar: highConfidenceHeavier > 0 ? 0 : 1,
                        heavier: highConfidenceHeavier,
                        highConfidenceHeavier,
                        unverified: 0,
                        byReason: {}
                      }
                    })
              }
            })
      }
    ]
  };
}

async function batchExit(options, report) {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir);
  const outcome = await executeSuiteBatch(
    runtime,
    {
      options: { uiDiff: true, ...options },
      source: "suite-run",
      quarantine: "skip",
      persist: false,
      execute: async () => report
    },
    { log: () => {} }
  );
  return outcome.exitCode;
}

test("suite UI gate: --fail-on-ui only blocks non-quarantined ui.status=failed", async () => {
  assert.equal(
    await batchExit({}, runReport("failed")),
    0,
    "默认 UI failed 不影响退出码"
  );
  assert.equal(
    await batchExit({ failOnUi: true }, runReport("failed")),
    2,
    "开启后 UI failed 命中窄门禁"
  );
  assert.equal(
    await batchExit({ failOnUi: true }, runReport("unverified")),
    0,
    "unverified 不阻断"
  );
  assert.equal(
    await batchExit({ failOnUi: true }, runReport("passed")),
    0
  );
  assert.equal(
    await batchExit({ failOnUi: true }, runReport("failed", { quarantined: true })),
    0,
    "隔离用例不计 UI 门禁"
  );
});

test("suite UI text-weight gate: only high-confidence heavier blocks, opt-in", async () => {
  assert.equal(
    await batchExit({}, runReport("passed", { highConfidenceHeavier: 1 })),
    0,
    "默认字重仅报告"
  );
  assert.equal(
    await batchExit({ failOnUiWeight: true }, runReport("passed", { highConfidenceHeavier: 1 })),
    2,
    "开启后高置信 heavier 命中"
  );
  assert.equal(
    await batchExit({ failOnUiWeight: true }, runReport("passed", { highConfidenceHeavier: 0 })),
    0,
    "无高置信 heavier 不阻断"
  );
  assert.equal(
    await batchExit(
      { failOnUiWeight: true },
      runReport("passed", { highConfidenceHeavier: 1, quarantined: true })
    ),
    0,
    "隔离用例不计字重门禁"
  );
  assert.equal(
    await batchExit(
      { failOnUiWeight: true },
      runReport("unverified", { highConfidenceHeavier: 1 })
    ),
    2,
    "字重证据独立于 UI 四态；UI unverified 不掩盖高置信 heavier"
  );
});

test("suite UI gate: functional failure keeps exit 1 unless the UI gate is also hit", async () => {
  assert.equal(
    await batchExit({}, runReport("failed", { functionalFailure: true })),
    1,
    "功能失败仍 exit 1"
  );
  assert.equal(
    await batchExit({ failOnUi: true }, runReport("failed", { functionalFailure: true })),
    2,
    "UI 门禁命中时按 --fail-on 语义 exit 2"
  );
});
