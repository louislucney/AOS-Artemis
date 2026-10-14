import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

const FEATURES = [
  {
    key: "f-login-aaaaaaaa",
    name: "登录流程",
    caseCount: 12,
    screens: ["登录-输入", "登录-验证"],
    jsonPath: "/p/.artemis/design/case-sets/20261014T153000_登录流程.json",
    mdPath: "/p/.artemis/design/case-sets/20261014T153000_登录流程.md",
    xlsxPath: "/p/.artemis/design/case-sets/20261014T153000_登录流程.xlsx"
  }
];

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

test("MemoryStore: recordCaseSet 往返完整（features 嵌套、screens 数组）", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const record = await store.recordCaseSet({
    rootPath: "/w/p1",
    source: "figma:fileKey123",
    designName: "xx 设计稿",
    fingerprint: "abc123",
    basename: "20261014T153000_登录流程",
    createdAt: "2026-10-14T15:30:00.000Z",
    features: FEATURES
  });
  assert.ok(record.id);
  assert.equal(record.projectId, (await store.getProjectByPath("/w/p1")).id);
  assert.equal(record.createdAt, "2026-10-14T15:30:00.000Z");

  const listed = await store.listCaseSets("/w/p1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].features.length, 1);
  assert.deepEqual(listed[0].features[0].screens, ["登录-输入", "登录-验证"]);
  assert.equal(listed[0].features[0].caseCount, 12);
  assert.equal(listed[0].designName, "xx 设计稿");
  assert.equal(listed[0].fingerprint, "abc123");
  assert.equal(listed[0].basename, "20261014T153000_登录流程");
});

test("PostgresStore (pg-mem): recordCaseSet/listCaseSets 往返与新→旧排序、limit", async () => {
  const store = await makePgStore();
  await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
  await store.recordCaseSet({
    rootPath: "/w/p2",
    source: "pen:a.pen",
    basename: "b1",
    createdAt: "2026-10-14T10:00:00.000Z",
    features: FEATURES
  });
  await store.recordCaseSet({
    rootPath: "/w/p2",
    source: "pen:b.pen",
    basename: "b2",
    createdAt: "2026-10-14T12:00:00.000Z",
    features: FEATURES
  });
  await store.recordCaseSet({
    rootPath: "/w/p2",
    source: "pen:c.pen",
    basename: "b3",
    createdAt: "2026-10-14T14:00:00.000Z",
    features: FEATURES
  });

  const all = await store.listCaseSets("/w/p2");
  assert.deepEqual(all.map((record) => record.basename), ["b3", "b2", "b1"]);
  const limited = await store.listCaseSets("/w/p2", 2);
  assert.deepEqual(limited.map((record) => record.basename), ["b3", "b2"]);
  assert.equal(limited[0].features[0].name, "登录流程");
  assert.deepEqual(limited[0].features[0].screens, ["登录-输入", "登录-验证"]);
  assert.equal(limited[0].features[0].jsonPath, FEATURES[0].jsonPath);
});

test("listCaseSets: 项目隔离（不同 rootPath 不串）", async () => {
  const memory = new MemoryStore();
  await memory.upsertProject({ rootPath: "/w/a", name: "a" });
  await memory.upsertProject({ rootPath: "/w/b", name: "b" });
  await memory.recordCaseSet({ rootPath: "/w/a", source: "pen:a.pen", basename: "a1", features: FEATURES });
  assert.equal((await memory.listCaseSets("/w/a")).length, 1);
  assert.equal((await memory.listCaseSets("/w/b")).length, 0);
  assert.equal((await memory.listCaseSets("/w/unknown")).length, 0);

  const pg = await makePgStore();
  await pg.upsertProject({ rootPath: "/w/a", name: "a" });
  await pg.upsertProject({ rootPath: "/w/b", name: "b" });
  await pg.recordCaseSet({ rootPath: "/w/a", source: "pen:a.pen", basename: "a1", features: FEATURES });
  assert.equal((await pg.listCaseSets("/w/a")).length, 1);
  assert.equal((await pg.listCaseSets("/w/b")).length, 0);
});

test("recordCaseSet: 事务协议——失败时 BEGIN→ROLLBACK→release，不 COMMIT", async () => {
  const calls = [];
  let featureInserts = 0;
  const client = {
    async query(text) {
      calls.push(text);
      if (text.startsWith("INSERT INTO case_set_features")) {
        featureInserts += 1;
        if (featureInserts > 1) throw new Error("boom");
      }
      return { rows: [] };
    },
    release() {
      calls.push("release");
    }
  };
  const pool = {
    async query(text) {
      calls.push(`pool:${text}`);
      return { rows: [] };
    },
    async connect() {
      return client;
    }
  };
  const store = new PostgresStore(pool);

  await assert.rejects(
    store.recordCaseSet({
      rootPath: "/w/tx",
      source: "pen:tx.pen",
      basename: "b-tx",
      features: [FEATURES[0], { ...FEATURES[0] }]
    }),
    /boom/
  );
  assert.ok(calls.includes("BEGIN"), "BEGIN issued");
  assert.ok(calls.includes("ROLLBACK"), "ROLLBACK issued");
  assert.ok(!calls.includes("COMMIT"), "no COMMIT on failure");
  assert.equal(calls.at(-1), "release");
});
