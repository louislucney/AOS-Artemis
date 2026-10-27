import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeRequest,
  isLoopbackHost,
  parseAuthUsers,
  resolveRequestIdentity,
  unauthorizedResponse
} from "../dist/auth.js";

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

test("parseAuthUsers: valid users, fail-closed errors and duplicates", () => {
  const valid = parseAuthUsers(
    JSON.stringify([
      { name: "alice", token: "alice-token-123456", role: "admin" },
      { name: "bob", token: "bob-token-12345678", role: "viewer" }
    ])
  );
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.users, [
    { name: "alice", token: "alice-token-123456", role: "admin" },
    { name: "bob", token: "bob-token-12345678", role: "viewer" }
  ]);

  assert.match(parseAuthUsers("not-json").errors[0], /不是合法 JSON/);
  assert.match(parseAuthUsers("{}").errors[0], /必须是数组/);
  const invalid = parseAuthUsers(
    JSON.stringify([
      { name: "", token: "short", role: "root" },
      { name: "alice", token: "alice-token-123456", role: "admin" },
      { name: "alice", token: "alice-token-123456", role: "admin" }
    ])
  );
  assert.ok(invalid.errors.some((entry) => entry.includes("缺 name")));
  assert.ok(invalid.errors.some((entry) => entry.includes("token 至少 16")));
  assert.ok(invalid.errors.some((entry) => entry.includes("role 必须是")));
  assert.ok(invalid.errors.some((entry) => entry.includes("名字重复")));
  assert.ok(invalid.errors.some((entry) => entry.includes("令牌重复")));
});

test("resolveRequestIdentity: static/user/anonymous and no-match", () => {
  const users = parseAuthUsers(
    JSON.stringify([{ name: "alice", token: "alice-token-123456", role: "maintainer" }])
  ).users;
  const staticIdentity = resolveRequestIdentity({
    authorization: `Bearer ${TOKEN}`,
    staticToken: TOKEN,
    users,
    fallbackRole: "admin",
    staticActor: "ops"
  });
  assert.deepEqual(staticIdentity, { name: "ops", role: "admin", source: "static" });

  const userIdentity = resolveRequestIdentity({
    authorization: basic("alice", "alice-token-123456"),
    staticToken: TOKEN,
    users,
    fallbackRole: "admin"
  });
  assert.deepEqual(userIdentity, {
    name: "alice",
    role: "maintainer",
    source: "user"
  });

  assert.equal(
    resolveRequestIdentity({
      authorization: "Bearer wrong-token-xxxx",
      staticToken: TOKEN,
      users,
      fallbackRole: "admin"
    }),
    null
  );
  assert.deepEqual(
    resolveRequestIdentity({
      authorization: undefined,
      staticToken: "",
      users: [],
      fallbackRole: "viewer"
    }),
    { name: "anonymous", role: "viewer", source: "anonymous" }
  );
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
