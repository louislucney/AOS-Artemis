import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProjectStore } from "../dist/db/index.js";

async function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("createProjectStore: no URL → file ledger, data persists across restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-default-"));
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  try {
    await withEnv({ MOBILE_TESTING_DATABASE_URL: "", AOS_LEDGER_DIR: home }, async () => {
      let result = await createProjectStore();
      assert.equal(result.kind, "file");
      assert.equal(result.degraded, false);
      assert.ok(result.reason?.includes("文件台账"));

      await result.store.upsertProject({ rootPath: root, name: "demo" });
      await result.store.recordTask({ rootPath: root, traceId: "t1", status: "submitted" });
      await result.store.close();

      result = await createProjectStore();
      assert.equal(result.kind, "file");
      assert.equal((await result.store.listTasks(root)).length, 1);
      await result.store.close();
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("createProjectStore: 仅有废弃 AOS_DATABASE_URL → 文件台账并提示改名", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-default-"));
  try {
    await withEnv(
      {
        MOBILE_TESTING_DATABASE_URL: "",
        AOS_DATABASE_URL: "postgres://127.0.0.1:1/none",
        AOS_LEDGER_DIR: home
      },
      async () => {
        const result = await createProjectStore();
        assert.equal(result.kind, "file");
        assert.ok(result.reason?.includes("AOS_DATABASE_URL"), "提示旧变量名");
        assert.ok(result.reason?.includes("MOBILE_TESTING_DATABASE_URL"), "提示新变量名");
        await result.store.close();
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("createProjectStore: PG failure falls back to file ledger with honest reason", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-default-"));
  try {
    await withEnv(
      { MOBILE_TESTING_DATABASE_URL: "postgres://127.0.0.1:1/none", AOS_LEDGER_DIR: home },
      async () => {
        const result = await createProjectStore();
        assert.equal(result.kind, "file");
        assert.equal(result.degraded, false);
        assert.ok(result.reason?.includes("文件台账"));
        assert.ok(result.reason?.includes("不自动回流"));
        await result.store.close();
      }
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "createProjectStore: unwritable ledger → memory (degraded, honest)",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "aos-default-"));
    const locked = join(home, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o555);
    try {
      await withEnv({ MOBILE_TESTING_DATABASE_URL: "", AOS_LEDGER_DIR: locked }, async () => {
        const result = await createProjectStore();
        assert.equal(result.kind, "memory");
        assert.equal(result.degraded, true);
        assert.ok(result.reason?.includes("不会持久"));
      });
    } finally {
      await chmod(locked, 0o755);
      await rm(home, { recursive: true, force: true });
    }
  }
);

test("hydrate: case-set archive self-heals idempotently (file ledger)", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-default-"));
  const root = join(home, "proj");
  const setsDir = join(root, ".artemis", "design", "case-sets");
  await mkdir(setsDir, { recursive: true });
  await writeFile(
    join(setsDir, "20261018_login.json"),
    JSON.stringify({ source: "figma", features: [{ key: "login", name: "登录" }], flows: [{ screen: "S1" }, { screen: "S2" }] }),
    "utf8"
  );
  await writeFile(
    join(setsDir, "20261018_order.json"),
    JSON.stringify({
      source: "figma",
      features: [{ key: "order", name: "下单", screens: ["Cart", "Pay"] }],
      flows: [{ screens: ["Cart", "Pay", "Extra"] }]
    }),
    "utf8"
  );
  await writeFile(join(setsDir, "20261018_bad.json"), "{not json", "utf8");
  try {
    await withEnv({ MOBILE_TESTING_DATABASE_URL: "", AOS_LEDGER_DIR: home }, async () => {
      let result = await createProjectStore();
      const sets = await result.store.listCaseSets(root);
      assert.equal(sets.length, 2);
      const login = sets.find((set) => set.features[0].key === "login");
      const order = sets.find((set) => set.features[0].key === "order");
      assert.equal(login.features[0].caseCount, 2);
      assert.deepEqual(login.features[0].screens, ["S1", "S2"], "无 features[0].screens 时回退 flows 并集");
      assert.deepEqual(order.features[0].screens, ["Cart", "Pay"], "优先归档 features[0].screens，不被用例覆盖放大");
      const audit = await result.store.listAudit(root, { domain: "registry" });
      assert.ok(audit.some((event) => event.action === "hydrate.registered"));
      await result.store.close();

      result = await createProjectStore();
      assert.equal((await result.store.listCaseSets(root)).length, 2);
      await result.store.close();
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
