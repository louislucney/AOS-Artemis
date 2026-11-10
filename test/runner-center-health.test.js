import assert from "node:assert/strict";
import test from "node:test";

import { checkCenterHealth } from "../dist/runner/control/health.js";

test("checkCenterHealth: ok 返回 service/version 并去掉尾斜杠", async () => {
  let seen = "";
  const result = await checkCenterHealth({
    baseUrl: "http://192.168.1.10:8765///",
    fetchImpl: async (url) => {
      seen = String(url);
      return new Response(JSON.stringify({ ok: true, service: "mobile-testing-mcp", version: "0.3.0" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(seen, "http://192.168.1.10:8765/healthz");
  assert.equal(result.ok, true);
  assert.equal(result.service, "mobile-testing-mcp");
  assert.equal(result.version, "0.3.0");
  assert.equal(result.error, undefined);
});

test("checkCenterHealth: HTTP 失败与 ok!=true 不伪装成连通", async () => {
  const httpError = await checkCenterHealth({
    baseUrl: "http://10.0.0.9:8765",
    fetchImpl: async () => new Response("down", { status: 503 })
  });
  assert.equal(httpError.ok, false);
  assert.match(httpError.error, /HTTP 503/);

  const notOk = await checkCenterHealth({
    baseUrl: "http://10.0.0.9:8765",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: false, service: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });
  assert.equal(notOk.ok, false);
  assert.match(notOk.error, /ok!=true/);
});

test("checkCenterHealth: 网络错误带底层 cause", async () => {
  const failure = new TypeError("fetch failed");
  Object.assign(failure, {
    cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:8765"), {
      code: "ECONNREFUSED"
    })
  });
  const result = await checkCenterHealth({
    baseUrl: "http://10.0.0.9:8765",
    fetchImpl: async () => {
      throw failure;
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch failed/);
  assert.match(result.error, /ECONNREFUSED/);
  assert.equal(result.url, "http://10.0.0.9:8765/healthz");
});
