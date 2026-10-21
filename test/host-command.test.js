import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { runHostCommand } from "../dist/host-command.js";

async function makeStores() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  return [new MemoryStore(), pg];
}

function io() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line)
  };
}

test("host list 无 PG → exit 2 且提示 MOBILE_TESTING_DATABASE_URL", async () => {
  const out = io();
  const code = await runHostCommand(["list"], out, { env: {} });
  assert.equal(code, 2);
  assert.match(out.errors.join("\n"), /MOBILE_TESTING_DATABASE_URL/);
});

test("host register 写入 label/owner/expected 字段", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    const out = io();
    const code = await runHostCommand(
      [
        "register",
        "h1",
        "--label",
        "CI 主机",
        "--owner",
        "alice",
        "--expected-os",
        "darwin",
        "--expected-hostname",
        "mac-a"
      ],
      out,
      { store }
    );
    assert.equal(code, 0);
    const host = await store.getHost("h1");
    assert.equal(host.label, "CI 主机");
    assert.equal(host.owner, "alice");
    assert.equal(host.expectedOs, "darwin");
    assert.equal(host.expectedHostname, "mac-a");
    assert.ok(host.registeredAt);
    assert.equal(host.registeredBy, "cli");
  }
});

test("host register: 未知主机 → exit 2", async () => {
  for (const store of await makeStores()) {
    const out = io();
    const code = await runHostCommand(["register", "nope"], out, { store });
    assert.equal(code, 2);
    assert.match(out.errors.join("\n"), /未知主机/);
  }
});

test("host show 唯一 hostname 解析；歧义 hostname 报错列 id", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    await store.upsertHost({ id: "h2", hostname: "dup" });
    await store.upsertHost({ id: "h3", hostname: "dup" });

    const unique = io();
    assert.equal(await runHostCommand(["show", "mac-a"], unique, { store }), 0);
    const caseInsensitive = io();
    assert.equal(await runHostCommand(["show", "MAC-A"], caseInsensitive, { store }), 0);

    const ambiguous = io();
    assert.equal(await runHostCommand(["show", "dup"], ambiguous, { store }), 2);
    assert.match(ambiguous.errors.join("\n"), /不唯一/);
    assert.match(ambiguous.errors.join("\n"), /h2/);
    assert.match(ambiguous.errors.join("\n"), /h3/);
  }
});

test("host register 接受唯一 hostname（大小写不敏感）", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    const out = io();
    const code = await runHostCommand(["register", "Mac-A", "--owner", "bob"], out, { store });
    assert.equal(code, 0, out.errors.join("\n"));
    const host = await store.getHost("h1");
    assert.equal(host.owner, "bob");
    assert.equal(host.registeredBy, "cli");
  }
});

test("adopt-legacy --local 只认领本机存在的路径（dry-run 不写）", async () => {
  for (const store of await makeStores()) {
    const existing = await mkdtemp(join(tmpdir(), "aos-adopt-exists-"));
    const missing = join(tmpdir(), `aos-adopt-missing-${Date.now()}`);
    const p1 = await store.upsertProject({ rootPath: existing, name: "exists" });
    const p2 = await store.upsertProject({ rootPath: missing, name: "missing" });
    try {
      const out = io();
      const code = await runHostCommand(["adopt-legacy", "--local"], out, {
        store,
        env: { AOS_HOST_ID: "h1" }
      });
      assert.equal(code, 0);
      assert.ok(out.logs.some((line) => line.includes(existing)));
      assert.ok(!out.logs.some((line) => line.includes(missing)));

      const projects = await store.listProjects();
      assert.equal(projects.find((p) => p.id === p1.id).hostId, null);
      assert.equal(projects.find((p) => p.id === p2.id).hostId, null);
    } finally {
      await rm(existing, { recursive: true, force: true });
    }
  }
});

test("adopt-legacy --local --apply 只收养存在的路径，缺失路径保持 NULL", async () => {
  for (const store of await makeStores()) {
    const existing = await mkdtemp(join(tmpdir(), "aos-adopt-apply-"));
    const missing = join(tmpdir(), `aos-adopt-missing-${Date.now()}`);
    const p1 = await store.upsertProject({ rootPath: existing, name: "exists" });
    const p2 = await store.upsertProject({ rootPath: missing, name: "missing" });
    try {
      const out = io();
      const code = await runHostCommand(["adopt-legacy", "--local", "--apply"], out, {
        store,
        env: { AOS_HOST_ID: "h1" }
      });
      assert.equal(code, 0);

      const projects = await store.listProjects();
      assert.equal(projects.find((p) => p.id === p1.id).hostId, "h1");
      assert.equal(projects.find((p) => p.id === p2.id).hostId, null);

      const audit = await store.listAudit(existing);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].action, "adopt-legacy");
    } finally {
      await rm(existing, { recursive: true, force: true });
    }
  }
});

test("adopt-legacy --host <id|hostname> --path <rootPath> 显式收养", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h9", hostname: "mac-nine" });
    const p = await store.upsertProject({ rootPath: "/w/app", name: "app" });
    const out = io();
    const code = await runHostCommand(
      ["adopt-legacy", "--host", "mac-nine", "--path", "/w/app", "--apply"],
      out,
      { store }
    );
    assert.equal(code, 0, out.errors.join("\n"));
    assert.equal((await store.listProjects()).find((x) => x.id === p.id).hostId, "h9");
  }
});

test("adopt-legacy --host 未知主机 → exit 2；--allow-unknown-host 才写入", async () => {
  for (const store of await makeStores()) {
    const p = await store.upsertProject({ rootPath: "/w/app", name: "app" });
    const blocked = io();
    assert.equal(
      await runHostCommand(["adopt-legacy", "--host", "h-future", "--path", "/w/app", "--apply"], blocked, {
        store
      }),
      2
    );
    assert.match(blocked.errors.join("\n"), /未知主机/);
    assert.equal((await store.listProjects()).find((x) => x.id === p.id).hostId, null);

    const allowed = io();
    assert.equal(
      await runHostCommand(
        [
          "adopt-legacy",
          "--host",
          "h-future",
          "--path",
          "/w/app",
          "--apply",
          "--allow-unknown-host"
        ],
        allowed,
        { store }
      ),
      0,
      allowed.errors.join("\n")
    );
    assert.equal((await store.listProjects()).find((x) => x.id === p.id).hostId, "h-future");
  }
});

test("adopt-legacy --host 歧义 hostname → exit 2 列 id（--allow-unknown-host 不绕）", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h2", hostname: "dup" });
    await store.upsertHost({ id: "h3", hostname: "dup" });
    await store.upsertProject({ rootPath: "/w/app", name: "app" });
    const out = io();
    const code = await runHostCommand(
      ["adopt-legacy", "--host", "dup", "--path", "/w/app", "--apply", "--allow-unknown-host"],
      out,
      { store }
    );
    assert.equal(code, 2);
    assert.match(out.errors.join("\n"), /不唯一/);
    assert.match(out.errors.join("\n"), /h2/);
    assert.match(out.errors.join("\n"), /h3/);
  }
});

test("adopt-legacy --json 不回显 figmaToken", async () => {
  for (const store of await makeStores()) {
    const existing = await mkdtemp(join(tmpdir(), "aos-adopt-json-"));
    try {
      await store.upsertProject({ rootPath: existing, name: "exists" });
      await store.setFigmaToken(existing, "fig-secret-token-123");
      for (const extra of [[], ["--apply"]]) {
        const out = io();
        const code = await runHostCommand(
          ["adopt-legacy", "--local", "--json", ...extra],
          out,
          { store, env: { AOS_HOST_ID: "h1" } }
        );
        assert.equal(code, 0, out.errors.join("\n"));
        const payload = out.logs.join("\n");
        assert.ok(!payload.includes("fig-secret-token-123"), payload);
        assert.ok(!payload.includes("figmaToken"), payload);
      }
    } finally {
      await rm(existing, { recursive: true, force: true });
    }
  }
});

test("adoptProjectHost: 目标 host 已有同路径 → false 且不重复建行", async () => {
  for (const store of await makeStores()) {
    const legacy = await store.upsertProject({ rootPath: "/w/dup", name: "legacy" });
    const hosted = await store.scopeHost("h1").upsertProject({ rootPath: "/w/dup", name: "hosted" });
    assert.equal(await store.adoptProjectHost({ projectId: legacy.id, hostId: "h1" }), false);
    const rows = (await store.listProjects()).filter((project) => project.rootPath === "/w/dup");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((project) => project.id === legacy.id).hostId, null);
    assert.equal(rows.find((project) => project.id === hosted.id).hostId, "h1");
  }
});

test("host 未知子命令 → exit 2 且不要求 PG", async () => {
  const out = io();
  const code = await runHostCommand(["bogus"], out, { env: {} });
  assert.equal(code, 2);
  assert.match(out.errors.join("\n"), /未知 host 子命令/);
  assert.ok(!out.errors.some((line) => line.includes("host 命令只支持中心 PG")));
});
