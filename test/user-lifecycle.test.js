import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hashAuthToken,
  parseAuthUsers,
  resolveRequestIdentity
} from "../dist/auth.js";
import {
  addStoredUser,
  defaultUsersFile,
  HttpUserDirectory,
  listStoredUsers,
  readUserFile,
  revokeStoredUser,
  rotateStoredUser,
  writeUserFile
} from "../dist/auth/users.js";
import { makeTempDir } from "./helpers.js";

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function usersPath() {
  return path.join(makeTempDir("aos-users-"), "http-users.json");
}

function identityWith(token, users) {
  return resolveRequestIdentity({
    authorization: `Bearer ${token}`,
    staticToken: "",
    users: [],
    hashedUsers: users,
    fallbackRole: "admin"
  });
}

test("users file: add stores only SHA-256, 0600, list hides secrets", () => {
  const file = usersPath();
  const added = addStoredUser(file, { name: "alice", role: "admin" });
  assert.match(added.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(added.user.tokenSha256, added.token);
  assert.equal(added.user.tokenSha256, hashAuthToken(added.token));

  const raw = fs.readFileSync(file, "utf-8");
  assert.ok(!raw.includes(added.token), "文件不得包含明文令牌");
  assert.ok(raw.includes(added.user.tokenSha256));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "用户文件权限 0600");
  }

  const listed = listStoredUsers(file);
  assert.deepEqual(
    listed.map((user) => ({ name: user.name, role: user.role, disabled: user.disabled })),
    [{ name: "alice", role: "admin", disabled: undefined }]
  );
  assert.deepEqual(identityWith(added.token, listed), {
    name: "alice",
    role: "admin",
    source: "user"
  });
  assert.equal(identityWith("wrong-token-1234567890", listed), null, "错误令牌被拒绝");
});

test("users file: reject duplicates, invalid role/token, and malformed records", () => {
  const file = usersPath();
  const first = addStoredUser(file, { name: "alice", role: "viewer", token: "alice-token-123456" });
  assert.throws(() => addStoredUser(file, { name: "alice", role: "viewer" }), /用户已存在/);
  assert.throws(
    () => addStoredUser(file, { name: "bob", role: "root" }),
    /role 必须是 viewer\/dispatcher\/maintainer\/admin/
  );
  assert.throws(
    () => addStoredUser(file, { name: "bob", role: "viewer", token: "short" }),
    /token 至少 16 字符/
  );
  assert.throws(
    () => addStoredUser(file, { name: "bob", role: "viewer", token: first.token }),
    /令牌已被其他用户使用/
  );

  fs.writeFileSync(file, "{not-json");
  assert.match(readUserFile(file).errors[0], /不是合法 JSON/);

  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      users: [
        { name: "a", role: "viewer", tokenSha256: "a".repeat(64) },
        { name: "a", role: "admin", tokenSha256: "b".repeat(64) },
        { name: "b", role: "viewer", tokenSha256: "a".repeat(64) }
      ]
    })
  );
  const errors = readUserFile(file).errors.join("；");
  assert.match(errors, /用户名字重复：a/);
  assert.match(errors, /用户令牌 hash 重复：b/);

  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      users: [{ name: "c", role: "viewer", tokenSha256: "not-a-hash" }]
    })
  );
  assert.match(readUserFile(file).errors.join("；"), /64 位十六进制/);
});

test("users file: revoke disables (hot-reload identity), rotate invalidates old token", () => {
  const file = usersPath();
  const alice = addStoredUser(file, { name: "alice", role: "maintainer" });

  const revoked = revokeStoredUser(file, "alice");
  assert.equal(revoked?.disabled, true);
  assert.equal(identityWith("wrong-token-1234567890", listStoredUsers(file)), null);
  assert.equal(revokedStoredIdentity(file, alice.token), null, "吊销后令牌立即失效");
  assert.equal(revokeStoredUser(file, "nobody"), null);

  const bob = addStoredUser(file, { name: "bob", role: "dispatcher" });
  const rotated = rotateStoredUser(file, "bob");
  assert.ok(rotated);
  assert.notEqual(rotated.token, bob.token);
  assert.deepEqual(revokedStoredIdentity(file, bob.token), null, "旧令牌失效");
  assert.deepEqual(revokedStoredIdentity(file, rotated.token), {
    name: "bob",
    role: "dispatcher",
    source: "user"
  });
  assert.equal(rotateStoredUser(file, "nobody"), null);

  const missing = revokeStoredUser(file, "alice");
  assert.equal(missing?.disabled, true, "重复吊销幂等");
});

function revokedStoredIdentity(file, token) {
  return identityWith(token, listStoredUsers(file));
}

test("users file: invalid content keeps last valid snapshot; deletion clears users", () => {
  const file = usersPath();
  const alice = addStoredUser(file, { name: "alice", role: "admin" });
  const directory = new HttpUserDirectory(file, []);
  assert.deepEqual(directory.initialize(), []);
  assert.equal(directory.snapshot().hashed.length, 1);

  fs.writeFileSync(file, "{broken");
  const broken = directory.snapshot();
  assert.equal(broken.hashed.length, 1, "非法更新保留上一次有效用户");
  assert.deepEqual(identityWith(alice.token, broken.hashed), {
    name: "alice",
    role: "admin",
    source: "user"
  });
  assert.match(broken.errors[0], /保留上次有效用户/);

  fs.rmSync(file);
  const removed = directory.snapshot();
  assert.deepEqual(removed.hashed, []);
  assert.deepEqual(removed.errors, [], "文件删除视为未配置用户");

  writeUserFile(file, [
    { name: "bob", role: "viewer", tokenSha256: hashAuthToken("bob-token-12345678") }
  ]);
  const restored = directory.snapshot();
  assert.deepEqual(
    restored.hashed.map((user) => [user.name, user.role]),
    [["bob", "viewer"]],
    "文件重新出现后热加载"
  );
});

test("users file: default path honours env override", () => {
  assert.equal(defaultUsersFile({}), path.join(os.homedir(), ".aos", "http-users.json"));
  assert.equal(
    defaultUsersFile({ AOS_HTTP_USERS_FILE: "/tmp/custom-users.json" }),
    path.resolve("/tmp/custom-users.json")
  );
  assert.equal(
    defaultUsersFile({ AOS_HTTP_USERS_FILE: "relative-users.json" }),
    path.resolve("relative-users.json")
  );
});

test("auth: hashed users participate in identity resolution", () => {
  const plain = parseAuthUsers(
    JSON.stringify([{ name: "inline", token: "inline-token-123456", role: "viewer" }])
  ).users;
  const hashed = [
    { name: "file", role: "maintainer", tokenSha256: hashAuthToken("file-token-12345678") },
    {
      name: "gone",
      role: "admin",
      tokenSha256: hashAuthToken("gone-token-12345678"),
      disabled: true
    }
  ];
  const resolve = (authorization) =>
    resolveRequestIdentity({
      authorization,
      staticToken: "",
      users: plain,
      hashedUsers: hashed,
      fallbackRole: "admin"
    });

  assert.deepEqual(resolve(`Bearer file-token-12345678`), {
    name: "file",
    role: "maintainer",
    source: "user"
  });
  assert.deepEqual(resolve(basic("someone", "file-token-12345678")), {
    name: "file",
    role: "maintainer",
    source: "user"
  });
  assert.deepEqual(resolve("Bearer inline-token-123456"), {
    name: "inline",
    role: "viewer",
    source: "user"
  });
  assert.equal(resolve("Bearer gone-token-12345678"), null, "disabled 用户不参与匹配");
  assert.equal(
    resolveRequestIdentity({
      authorization: undefined,
      staticToken: "",
      users: [],
      hashedUsers: hashed.filter((user) => user.disabled !== true),
      fallbackRole: "admin"
    }) === null,
    true,
    "仅有 hashed 用户时也视为启用认证"
  );
});
