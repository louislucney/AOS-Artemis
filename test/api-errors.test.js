import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  loadApiErrorCatalog,
  matchApiErrors,
  readApiErrorsArtifact
} from "../dist/artemis/api-errors.js";
import { makeTempDir } from "./helpers.js";

function writeCatalog(dir, codes) {
  const designDir = path.join(dir, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "error-codes.json"), JSON.stringify({ version: 1, codes }));
}

const LOGCAT = [
  "10-02 04:11:40.000  1000  1000 I OkHttp  : --> GET /orders",
  "10-02 04:11:42.319  1000  1000 E Api     : HTTP 401 Unauthorized for /orders",
  "10-02 04:11:42.320  1000  1000 I Auth    : AuthInterceptor redirect -> LoginActivity",
  "10-02 04:11:50.000  1000  1000 E Api     : HTTP 401 Unauthorized for /profile"
].join("\n");

test("api-errors: catalog validation reports bad entries and keeps valid ones", () => {
  const dir = makeTempDir("aos-api-err-");
  writeCatalog(dir, {
    AUTH_401: {
      match: "HTTP\\s*401",
      handler: "relogin",
      expect: "跳转登录页",
      handledPattern: "AuthInterceptor"
    },
    BAD_MATCH: { match: "(" },
    BAD_TYPE: { match: 42 },
    BAD_HANDLED: { match: "x", handledPattern: "(" }
  });
  const catalog = loadApiErrorCatalog(dir);
  assert.deepEqual([...catalog.rules.keys()], ["AUTH_401"]);
  assert.equal(catalog.errors.length, 3);
  assert.ok(catalog.errors.some((line) => line.includes("正则非法")));

  const missing = loadApiErrorCatalog(makeTempDir("aos-api-err-"));
  assert.equal(missing.rules.size, 0);
  assert.deepEqual(missing.errors, []);
});

test("api-errors: matching counts, samples and three verdicts", () => {
  const dir = makeTempDir("aos-api-err-");
  writeCatalog(dir, {
    AUTH_401: {
      match: "HTTP\\s*401",
      handler: "relogin",
      expect: "跳转登录页",
      handledPattern: "AuthInterceptor"
    },
    ORDER_500: { match: "HTTP\\s*500", expect: "通用错误页" }
  });
  const catalog = loadApiErrorCatalog(dir);

  const handled = matchApiErrors(LOGCAT, catalog.rules);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].code, "AUTH_401");
  assert.equal(handled[0].verdict, "handled");
  assert.equal(handled[0].handled, true);
  assert.equal(handled[0].count, 2);
  assert.equal(handled[0].firstAt, "10-02 04:11:42.319");
  assert.match(handled[0].sample, /HTTP 401/);

  const unhandledCatalog = loadApiErrorCatalog(dir);
  const unhandled = matchApiErrors(
    "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized",
    unhandledCatalog.rules
  );
  assert.equal(unhandled[0].verdict, "unhandled");
  assert.equal(unhandled[0].handled, false);

  const order = matchApiErrors(
    "10-02 04:11:42.319  1000  1000 E Api: HTTP 500 for /orders",
    catalog.rules
  );
  assert.equal(order.length, 1);
  assert.equal(order[0].code, "ORDER_500");
  assert.equal(order[0].verdict, "observed");
  assert.equal(order[0].handled, null);

  assert.deepEqual(matchApiErrors("", catalog.rules), []);
});

test("api-errors: artifact roundtrip", () => {
  const dir = makeTempDir("aos-api-err-");
  fs.writeFileSync(
    path.join(dir, "api-errors.json"),
    JSON.stringify({
      traceId: "t1",
      serial: "emulator-5554",
      window: { startMs: 1, endMs: 2 },
      source: "logcat",
      degraded: null,
      errors: []
    })
  );
  const artifact = readApiErrorsArtifact(dir);
  assert.equal(artifact.traceId, "t1");
  assert.equal(readApiErrorsArtifact(makeTempDir("aos-api-err-")), null);
});
