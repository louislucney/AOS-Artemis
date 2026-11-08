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

test("runner auth: host token rejects a conflicting host header", () => {
  const result = authenticateRunner(
    { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "other-host" },
    { AOS_RUNNER_HOST_TOKENS: JSON.stringify([{ hostId: "win-runner-01", token: TOKEN }]) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});
