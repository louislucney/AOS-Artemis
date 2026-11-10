import assert from "node:assert/strict";
import test from "node:test";

import { executeSuiteBatch } from "../dist/figma/suite-batch.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function runReport(unresolved, { quarantined = false } = {}) {
  return {
    ok: true,
    testsPath: "tests.json",
    total: 1,
    executed: 1,
    skipped: 0,
    passed: 1,
    failed: 0,
    ui: { passed: 0, failed: 0, unverified: 1, notApplicable: 0 },
    preflight: null,
    apiErrorCatalog: null,
    cases: [
      {
        caseId: "case-1",
        name: "用例一",
        status: "passed",
        traceId: "trace-1",
        ...(quarantined ? { quarantined: true } : {}),
        testSummary:
          unresolved === null
            ? null
            : {
                taskStatus: "completed",
                passed: 1,
                failed: 0,
                inconclusive: 0,
                unchecked: 0,
                synthesized: false,
                failedItems: [],
                adherence: {
                  unresolved,
                  deferredTotal: 0,
                  deferredReached: 0,
                  checkable: 2,
                  satisfied: unresolved === 0 ? 2 : 1,
                  unchecked: 0
                }
              }
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
      options,
      source: "suite-run",
      quarantine: "skip",
      persist: false,
      execute: async () => report
    },
    { log: () => {} }
  );
  return outcome.exitCode;
}

test("suite adherence gate: --fail-on-unresolved 只拦未命中脚本断言", async () => {
  assert.equal(await batchExit({}, runReport(1)), 0, "默认不影响退出码");
  assert.equal(
    await batchExit({ failOnUnresolved: true }, runReport(1)),
    2,
    "开启后未命中断言命中门禁"
  );
  assert.equal(await batchExit({ failOnUnresolved: true }, runReport(0)), 0);
  assert.equal(
    await batchExit({ failOnUnresolved: true }, runReport(1, { quarantined: true })),
    0,
    "隔离用例不计门禁"
  );
  assert.equal(
    await batchExit({ failOnUnresolved: true }, runReport(null)),
    0,
    "旧产物无 adherence 不阻断"
  );
});
