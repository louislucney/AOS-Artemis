import assert from "node:assert/strict";
import test from "node:test";

import { httpTokenFrom, runnerJobTokenFrom } from "../dist/env-tokens.js";

test("token env：MOBILE_TESTING_* 优先，AOS_* 兼容回退", () => {
  assert.equal(
    httpTokenFrom({
      MOBILE_TESTING_HTTP_TOKEN: "mobile-token-1234567890",
      AOS_HTTP_TOKEN: "legacy-token-1234567890"
    }),
    "mobile-token-1234567890"
  );
  assert.equal(httpTokenFrom({ AOS_HTTP_TOKEN: "legacy-token-1234567890" }), "legacy-token-1234567890");
  assert.equal(
    runnerJobTokenFrom({
      MOBILE_TESTING_RUNNER_JOB_TOKEN: "mobile-runner-1234567890",
      AOS_RUNNER_JOB_TOKEN: "legacy-runner-1234567890"
    }),
    "mobile-runner-1234567890"
  );
  assert.equal(
    runnerJobTokenFrom({ AOS_RUNNER_JOB_TOKEN: "legacy-runner-1234567890" }),
    "legacy-runner-1234567890"
  );
});
