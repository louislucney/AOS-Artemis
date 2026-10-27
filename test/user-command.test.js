import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { hashAuthToken, resolveRequestIdentity } from "../dist/auth.js";
import { readUserFile } from "../dist/auth/users.js";
import { makeTempDir } from "./helpers.js";
import { runUserCommand } from "../dist/user-command.js";

function cli() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    run: (argv) =>
      runUserCommand(argv, {
        log: (line) => lines.push(line),
        errorLog: (line) => errors.push(line)
      })
  };
}

function filePath() {
  return path.join(makeTempDir("aos-user-cli-"), "users.json");
}

function identityFromFile(file, token) {
  return resolveRequestIdentity({
    authorization: `Bearer ${token}`,
    staticToken: "",
    users: [],
    hashedUsers: readUserFile(file).users,
    fallbackRole: "admin"
  });
}

test("user CLI: add --json prints token once and stores only hash", () => {
  const file = filePath();
  const { run, lines, errors } = cli();
  assert.equal(run(["add", "alice", "--role", "admin", "--file", file, "--json"]), 0);
  assert.deepEqual(errors, []);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "add");
  assert.equal(payload.file, file);
  assert.deepEqual(payload.user, { name: "alice", role: "admin" });
  assert.match(payload.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(!fs.readFileSync(file, "utf-8").includes(payload.token));
  assert.deepEqual(identityFromFile(file, payload.token), {
    name: "alice",
    role: "admin",
    source: "user"
  });
});

test("user CLI: explicit token, list hides secrets, revoke/rotate take effect", () => {
  const file = filePath();
  const { run, lines, errors } = cli();
  assert.equal(
    run(["add", "bob", "--role", "dispatcher", "--token", "bob-token-12345678", "--file", file, "--json"]),
    0
  );
  assert.equal(JSON.parse(lines.at(-1)).token, "bob-token-12345678");
  const stored = fs.readFileSync(file, "utf-8");
  assert.ok(stored.includes(hashAuthToken("bob-token-12345678")));

  lines.length = 0;
  assert.equal(run(["list", "--file", file, "--json"]), 0);
  const listed = JSON.parse(lines[0]);
  assert.equal(listed.users.length, 1);
  assert.deepEqual(
    Object.keys(listed.users[0]).sort(),
    ["createdAt", "disabled", "name", "role", "updatedAt"]
  );
  assert.ok(!lines[0].includes("bob-token-12345678"));
  assert.ok(!lines[0].includes(hashAuthToken("bob-token-12345678")));

  lines.length = 0;
  assert.equal(run(["revoke", "bob", "--file", file, "--json"]), 0);
  assert.equal(JSON.parse(lines[0]).action, "revoke");
  assert.equal(identityFromFile(file, "bob-token-12345678"), null, "吊销后令牌失效");

  lines.length = 0;
  assert.equal(run(["enable", "bob", "--file", file, "--json"]), 0);
  assert.deepEqual(JSON.parse(lines[0]).user, {
    name: "bob",
    role: "dispatcher",
    disabled: false
  });
  assert.deepEqual(identityFromFile(file, "bob-token-12345678"), {
    name: "bob",
    role: "dispatcher",
    source: "user"
  }, "启用后原令牌恢复");

  lines.length = 0;
  assert.equal(run(["add", "carol", "--role", "viewer", "--file", file, "--json"]), 0);
  const carolToken = JSON.parse(lines[0]).token;

  lines.length = 0;
  assert.equal(run(["rotate", "carol", "--file", file, "--json"]), 0);
  const rotated = JSON.parse(lines[0]);
  assert.equal(rotated.user.name, "carol");
  assert.notEqual(rotated.token, carolToken);
  assert.equal(identityFromFile(file, carolToken), null, "旧令牌失效");
  assert.deepEqual(identityFromFile(file, rotated.token), {
    name: "carol",
    role: "viewer",
    source: "user"
  });
  assert.deepEqual(errors, []);

  lines.length = 0;
  assert.equal(run(["list", "--file", file]), 0);
  assert.match(lines[0], /用户（.*users\.json）：/);
  assert.ok(lines.some((line) => line.includes("bob") && line.includes("启用")));
  assert.ok(lines.some((line) => line.includes("carol") && line.includes("启用")));
});

test("user CLI: text output for add/rotate shows token once", () => {
  const file = filePath();
  const { run, lines } = cli();
  assert.equal(run(["add", "dave", "--role", "maintainer", "--file", file]), 0);
  assert.match(lines[0], /已添加用户 dave（角色 maintainer \/ 维护）/);
  assert.match(lines[1], /令牌（仅显示一次，请立即保存）：/);
  assert.equal(run(["rotate", "dave", "--file", file]), 0);
  assert.match(lines.at(-2), /已轮换用户 dave 的令牌/);
  assert.match(lines.at(-1), /新令牌（仅显示一次/);
  assert.equal(run(["list", "--file", file]), 0);
  assert.ok(lines.some((line) => line.includes("dave") && line.includes("状态=启用")));
});

test("user CLI: enable/role and last-admin guard", () => {
  const file = filePath();
  const { run, lines, errors } = cli();
  assert.equal(
    run(["add", "alice", "--role", "admin", "--token", "alice-token-123456", "--file", file]),
    0
  );
  assert.equal(
    run(["add", "bob", "--role", "admin", "--token", "bob-token-12345678", "--file", file]),
    0
  );

  assert.equal(run(["revoke", "alice", "--file", file]), 0, "还剩一个管理员，可吊销");
  assert.equal(run(["revoke", "bob", "--file", file]), 1, "最后一个启用管理员受保护");
  assert.match(errors.at(-1), /最后一个启用的管理员/);
  assert.deepEqual(identityFromFile(file, "bob-token-12345678"), {
    name: "bob",
    role: "admin",
    source: "user"
  });
  assert.equal(
    run(["revoke", "bob", "--file", file, "--allow-last-admin"]),
    0,
    "--allow-last-admin 显式放行"
  );

  assert.equal(run(["enable", "alice", "--file", file]), 0);
  assert.equal(run(["enable", "bob", "--file", file]), 0);
  assert.equal(run(["role", "bob", "--role", "viewer", "--file", file]), 0);
  assert.deepEqual(identityFromFile(file, "bob-token-12345678"), {
    name: "bob",
    role: "viewer",
    source: "user"
  });
  assert.equal(run(["role", "alice", "--role", "viewer", "--file", file]), 1, "降级最后管理员受保护");
  assert.match(errors.at(-1), /最后一个启用的管理员/);
  assert.equal(
    run(["role", "alice", "--role", "viewer", "--file", file, "--allow-last-admin"]),
    0,
    "显式放行降级"
  );

  assert.equal(run(["role", "alice", "--role", "root", "--file", file]), 1, "非法 role 1");
  assert.equal(run(["role", "nobody", "--role", "viewer", "--file", file]), 1, "用户不存在 1");
  assert.equal(run(["enable", "nobody", "--file", file]), 1, "用户不存在 1");

  lines.length = 0;
  assert.equal(run(["list", "--file", file]), 0);
  assert.ok(lines.some((line) => line.includes("alice") && line.includes("角色=viewer")));
  assert.ok(lines.some((line) => line.includes("bob") && line.includes("角色=viewer")));
});

test("user CLI: usage and failure exit codes", () => {
  const file = filePath();
  const { run, errors } = cli();
  assert.equal(run([]), 2, "缺子命令 2");
  assert.equal(run(["bogus", "--file", file]), 2, "未知子命令 2");
  assert.equal(run(["add", "alice", "--file", file]), 2, "add 缺 role 2");
  assert.equal(run(["add", "--role", "admin", "--file", file]), 2, "add 缺 name 2");
  assert.equal(run(["revoke", "--file", file]), 2, "revoke 缺 name 2");
  assert.equal(run(["rotate", "--file", file]), 2, "rotate 缺 name 2");
  assert.equal(run(["add", "alice", "--role", "root", "--file", file]), 1, "非法 role 1");
  assert.equal(run(["revoke", "nobody", "--file", file]), 1, "用户不存在 1");
  assert.equal(run(["rotate", "nobody", "--file", file]), 1, "用户不存在 1");
  assert.ok(errors.some((line) => line.includes("用户不存在：nobody")));

  fs.writeFileSync(file, "{broken");
  assert.equal(run(["list", "--file", file]), 1, "文件非法 1");
  assert.equal(run(["add", "alice", "--role", "admin", "--file", file]), 1, "文件非法拒绝写入 1");

  const help = cli();
  assert.equal(help.run(["help"]), 0);
  assert.ok(help.lines.some((line) => line.includes("user add <name>")));
  assert.equal(help.run(["--help"]), 0);
});
