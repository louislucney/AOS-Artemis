import assert from "node:assert/strict";
import test from "node:test";

import { parseRunnerConfig } from "../dist/runner/config.js";

const VALID = {
  MOBILE_TESTING_RUNNER_CONTROL_URL: "http://192.168.3.91:8765",
  MOBILE_TESTING_RUNNER_JOB_TOKEN: "0123456789abcdef",
  MOBILE_TESTING_HOST_ID: "win-runner-01"
};

test("runner config: parses center URL, token and host id", () => {
  const result = parseRunnerConfig(VALID);
  assert.equal(result.ok, true);
  assert.equal(result.config.centerUrl.href, "http://192.168.3.91:8765/");
  assert.equal(result.config.token, "0123456789abcdef");
  assert.equal(result.config.hostId, "win-runner-01");
  assert.equal("centerProjectRoot" in result.config, false);
});

test("runner config: accepts legacy AOS_* names", () => {
  const result = parseRunnerConfig({
    AOS_RUNNER_CONTROL_URL: "https://center.example:8765/",
    AOS_RUNNER_JOB_TOKEN: "legacy-token-0123456789",
    AOS_HOST_ID: "legacy-host"
  });
  assert.equal(result.ok, true);
  assert.equal(result.config.centerUrl.href, "https://center.example:8765/");
  assert.equal(result.config.hostId, "legacy-host");
});

test("runner config: missing URL is rejected with the variable name", () => {
  const { MOBILE_TESTING_HOST_ID, MOBILE_TESTING_RUNNER_JOB_TOKEN } = VALID;
  const result = parseRunnerConfig({
    MOBILE_TESTING_HOST_ID,
    MOBILE_TESTING_RUNNER_JOB_TOKEN
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("MOBILE_TESTING_RUNNER_CONTROL_URL")));
});

test("runner config: invalid URL is rejected", () => {
  const result = parseRunnerConfig({
    ...VALID,
    MOBILE_TESTING_RUNNER_CONTROL_URL: "not-a-url"
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("http")));
});

test("runner config: short token is rejected", () => {
  const result = parseRunnerConfig({
    ...VALID,
    MOBILE_TESTING_RUNNER_JOB_TOKEN: "short"
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("至少 16")));
});

test("runner config: missing host id is rejected unless a fallback is supplied", () => {
  const withoutHost = {
    MOBILE_TESTING_RUNNER_CONTROL_URL: VALID.MOBILE_TESTING_RUNNER_CONTROL_URL,
    MOBILE_TESTING_RUNNER_JOB_TOKEN: VALID.MOBILE_TESTING_RUNNER_JOB_TOKEN
  };
  const missing = parseRunnerConfig(withoutHost);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("HOST_ID")));

  const fallback = parseRunnerConfig(withoutHost, { fallbackHostId: "derived-host" });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.config.hostId, "derived-host");
});

test("runner config: center project path never enters the runner config", () => {
  const result = parseRunnerConfig({
    ...VALID,
    AOS_CENTER_PROJECT_ROOT: "/Users/louis/Documents/AOS/ESSO-GU"
  });
  assert.equal(result.ok, true);
  assert.equal("centerProjectRoot" in result.config, false);
  assert.equal(JSON.stringify(result.config).includes("/Users/louis"), false);
});
