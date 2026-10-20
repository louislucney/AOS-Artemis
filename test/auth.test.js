import assert from "node:assert/strict";
import test from "node:test";

import { authorizeRequest, isLoopbackHost, unauthorizedResponse } from "../dist/auth.js";

const TOKEN = "s3cr3t-token";
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

test("isLoopbackHost: accepts only 127.0.0.1 / ::1 / localhost (case-insensitive, fail-closed)", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST", "LocalHost"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  const nonLoopback = [
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "10.0.0.5",
    "example.local",
    "localhost.example.com",
    "127.0.0.10",
    "127.0.0.1 ",
    " localhost",
    "localhost\n",
    "",
    "::ffff:127.0.0.1"
  ];
  for (const host of nonLoopback) {
    assert.equal(isLoopbackHost(host), false, JSON.stringify(host));
  }
});

test("authorizeRequest: Bearer token, scheme case-insensitive", () => {
  assert.equal(authorizeRequest({ authorization: `Bearer ${TOKEN}`, token: TOKEN }), true);
  assert.equal(authorizeRequest({ authorization: `bearer ${TOKEN}`, token: TOKEN }), true);
  assert.equal(authorizeRequest({ authorization: `BEARER ${TOKEN}`, token: TOKEN }), true);
  assert.equal(authorizeRequest({ authorization: `  Bearer ${TOKEN}  `, token: TOKEN }), true);
  assert.equal(authorizeRequest({ authorization: "Bearer wrong-token", token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: "Bearer short", token: "much-longer-token" }), false);
});

test("authorizeRequest: Basic (password = token, username any/empty)", () => {
  assert.equal(authorizeRequest({ authorization: basic("alice", TOKEN), token: TOKEN }), true);
  assert.equal(authorizeRequest({ authorization: basic("", TOKEN), token: TOKEN }), true);
  assert.equal(authorizeRequest({ authorization: basic("alice", "nope"), token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: basic("alice", ""), token: TOKEN }), false);
});

test("authorizeRequest: missing / empty / malformed credentials are denied", () => {
  assert.equal(authorizeRequest({ authorization: undefined, token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: "", token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: "Bearer", token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: "Bearer ", token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: `Token ${TOKEN}`, token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: `Digest ${TOKEN}`, token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: "Basic", token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: "Basic @@not-base64@@", token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: `Basic ${Buffer.from(TOKEN).toString("base64")}`, token: TOKEN }), false);
  assert.equal(
    authorizeRequest({ authorization: `Basic ${Buffer.from(`alice:${TOKEN}`).toString("base64").slice(0, -1)}`, token: TOKEN }),
    false
  );
});

test("authorizeRequest: query token only honored when allowQueryToken is set", () => {
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: TOKEN, token: TOKEN, allowQueryToken: true }), true);
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: TOKEN, token: TOKEN, allowQueryToken: false }), false);
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: TOKEN, token: TOKEN }), false);
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: "wrong", token: TOKEN, allowQueryToken: true }), false);
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: null, token: TOKEN, allowQueryToken: true }), false);
});

test("authorizeRequest: empty token denies every credential", () => {
  assert.equal(authorizeRequest({ authorization: "Bearer x", token: "" }), false);
  assert.equal(authorizeRequest({ authorization: basic("alice", ""), token: "" }), false);
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: "x", token: "", allowQueryToken: true }), false);
  assert.equal(authorizeRequest({ authorization: undefined, queryToken: "", token: "", allowQueryToken: true }), false);
});

test("unauthorizedResponse: 401 with Basic challenge and JSON body", () => {
  const res = unauthorizedResponse("mobile-testing-mcp");
  assert.equal(res.status, 401);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.equal(res.headers["WWW-Authenticate"], 'Basic realm="mobile-testing-mcp"');
  assert.equal(res.body, '{"error":"unauthorized"}');
  assert.deepEqual(JSON.parse(res.body), { error: "unauthorized" });

  assert.equal(unauthorizedResponse("aos-artifact").headers["WWW-Authenticate"], 'Basic realm="aos-artifact"');
});
