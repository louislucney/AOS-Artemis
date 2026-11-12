import assert from "node:assert/strict";
import test from "node:test";

import { authenticateRunner } from "../dist/runner/control/auth.js";

const TOKEN = "host-token-0123456789abcdef";

test("runner auth: host token identifies host without X-AOS-Host-Id", () => {
  const result = authenticateRunner(
    { authorization: `Bearer ${TOKEN}` },
    { AOS_RUNNER_HOST_TOKENS: JSON.stringify([{ hostId: "win-runner-01", token: TOKEN }]) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.hostId, "win-runner-01");
});

test("runner auth: global token allows hostless proxy only with opt-in", () => {
  const env = { MOBILE_TESTING_RUNNER_JOB_TOKEN: TOKEN, AOS_RUNNER_SHARED_LLM: "1" };
  const denied = authenticateRunner({ authorization: `Bearer ${TOKEN}` }, env);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "host-required");

  const allowed = authenticateRunner(
    { authorization: `Bearer ${TOKEN}` },
    env,
    { allowHostless: true }
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.hostId, "");
  assert.equal(allowed.source, "global-token");

  const withHost = authenticateRunner(
    { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "mac-mini-01" },
    env,
    { allowHostless: true }
  );
  assert.equal(withHost.ok, true);
  assert.equal(withHost.hostId, "mac-mini-01");
});

test("runner auth: host token rejects a conflicting host header", () => {
  const result = authenticateRunner(
    { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "other-host" },
    { AOS_RUNNER_HOST_TOKENS: JSON.stringify([{ hostId: "win-runner-01", token: TOKEN }]) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});
