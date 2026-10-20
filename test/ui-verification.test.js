import assert from "node:assert/strict";
import test from "node:test";

import { isUiPass, summarizeUi, unverifiedUi } from "../dist/ui/verification.js";

test("ui verification: unverified is not a pass", () => {
  assert.equal(isUiPass(unverifiedUi("no-ui-contract")), false);
});

test("ui verification: pass requires lossless PNG source", () => {
  assert.equal(isUiPass({ status: "passed", sourceFormat: "jpeg", lossless: false }), false);
  assert.equal(isUiPass({ status: "passed", sourceFormat: "png", lossless: false }), false);
  assert.equal(isUiPass({ status: "passed", sourceFormat: "png", lossless: true }), true);
});

test("ui verification: summary keeps functional and UI counts separate", () => {
  assert.deepEqual(
    summarizeUi([
      { ui: { status: "passed" } },
      { ui: { status: "failed" } },
      { ui: { status: "unverified" } },
      { ui: { status: "not-applicable" } },
      {}
    ]),
    { passed: 1, failed: 1, unverified: 2, notApplicable: 1 }
  );
});
