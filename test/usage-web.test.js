import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handleUsageRequest } from "../dist/usage/web.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const CATALOG = ["llm_list", "llm_switch", "aos_status", "aos_usage"];

function eventInput(overrides = {}) {
  return {
    tool: "llm_list",
    family: "native",
    ok: true,
    durationMs: 10,
    errorClass: null,
    errorSummary: null,
    signals: [],
    argKeys: [],
    traceId: null,
    ...overrides
  };
}

async function seedStore() {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/alpha", name: "alpha" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertProject({ rootPath: "/w/beta", name: "beta" });
  await store.recordUsageEvent(
    "/w/alpha",
    eventInput({ tool: "llm_list", durationMs: 5, at: new Date(NOW - 60_000).toISOString() })
  );
  await store.recordUsageEvent(
    "/w/alpha",
    eventInput({
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: '未知条目 "ghost-1"',
      durationMs: 9,
      argKeys: ["name"],
      at: new Date(NOW - 120_000).toISOString()
    })
  );
  await store.recordUsageEvent(
    "/w/alpha",
    eventInput({ tool: "llm_list", durationMs: 1, at: new Date(NOW - 3 * DAY).toISOString() })
  );
  await store.recordUsageEvent(
    "/w/beta",
    eventInput({ tool: "aos_status", durationMs: 2, at: new Date(NOW - 30_000).toISOString() })
  );
  return store;
}

function deps(store, extra = {}) {
  return {
    store,
    catalog: CATALOG,
    storageNote: "PostgreSQL 不可用，已降级为内存存储。",
    env: {},
    now: NOW,
    ...extra
  };
}

async function getJson(store, path, extra = {}) {
  const res = await handleUsageRequest(new URL(`http://localhost${path}`), deps(store, extra));
  assert.equal(res.status, 200, res.body);
  assert.match(res.contentType, /application\/json/);
  return JSON.parse(res.body);
}

test("usage web: HTML renders the four sections, storage badge and project switcher", async () => {
  const store = await seedStore();
  const res = await handleUsageRequest(
    new URL("http://localhost/usage?project=alpha"),
    deps(store)
  );
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/html/);
  const body = res.body;
  assert.ok(body.includes('id="overview"'));
  assert.ok(body.includes('id="tools"'));
  assert.ok(body.includes('id="signals"'));
  assert.ok(body.includes('id="events"'));
  assert.ok(body.includes("概览"));
  assert.ok(body.includes("工具表"));
  assert.ok(body.includes("信号面板"));
  assert.ok(body.includes("事件流水"));
  assert.ok(body.includes("存储：内存降级"));
  assert.ok(body.includes("PostgreSQL 不可用，已降级为内存存储。"));
  assert.ok(body.includes('<option value="/w/alpha" selected>alpha</option>'));
  assert.ok(body.includes('<option value="/w/beta">beta</option>'));
  assert.ok(body.includes('data-tool="llm_list"'));
  assert.ok(body.includes('data-zero-call="1"'));
  assert.ok(body.includes("aos_status"));
  assert.ok(!body.includes("aos_usage"));
  assert.ok(body.includes("未知条目 &lt;str&gt;"));
  assert.ok(!body.includes("<script"));
});

test("usage web: /usage.json exposes the stable machine-readable contract", async () => {
  const store = await seedStore();
  const payload = await getJson(store, "/usage.json?project=alpha");
  assert.equal(payload.ok, true);
  assert.equal(payload.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(payload.usage, { enabled: true, storage: "memory", note: null });
  assert.equal(payload.store.kind, "memory");
  assert.equal(payload.store.degraded, true);
  assert.equal(payload.store.note, "PostgreSQL 不可用，已降级为内存存储。");
  assert.deepEqual(payload.filters, {
    project: "alpha",
    projectRoot: "/w/alpha",
    tool: null,
    status: null,
    days: null,
    since: null,
    limit: 100,
    offset: 0,
    refresh: null
  });
  assert.equal(payload.project.name, "alpha");
  assert.equal(payload.project.rootPath, "/w/alpha");
  assert.deepEqual(payload.projects.map((project) => project.name).sort(), ["alpha", "beta"]);
  assert.equal("figmaToken" in payload.projects[0], false);
  assert.equal(payload.summary.total, 3);
  assert.equal(payload.summary.ok, 2);
  assert.equal(payload.summary.error, 1);
  assert.deepEqual(payload.summary.zeroCallTools, ["aos_status"]);
  assert.deepEqual(payload.signals.unclassified, [
    { template: "未知条目 <str>", count: 1, tools: ["llm_switch"] }
  ]);
  assert.deepEqual(payload.signals.degradations, []);
  assert.equal(payload.events.total, 3);
  assert.equal(payload.events.count, 3);
  assert.equal(payload.events.limit, 100);
  assert.equal(payload.events.offset, 0);
  assert.deepEqual(
    payload.events.items.map((event) => event.tool),
    ["llm_list", "llm_switch", "llm_list"]
  );
  assert.equal(payload.events.items[0].at, new Date(NOW - 60_000).toISOString());
  assert.equal("projectId" in payload.events.items[0], false);
  const listRow = payload.tools.find((row) => row.tool === "llm_list");
  assert.deepEqual(listRow, {
    tool: "llm_list",
    count: 2,
    ok: 2,
    error: 0,
    successRate: 1,
    p50: 1,
    p95: 5,
    lastCallAt: new Date(NOW - 60_000).toISOString(),
    zeroCall: false
  });
  const zeroRow = payload.tools.find((row) => row.tool === "aos_status");
  assert.equal(zeroRow.zeroCall, true);
  assert.equal(zeroRow.count, 0);
  assert.ok(payload.tools.every((row) => row.tool !== "aos_usage"));
});

test("usage web: project/tool/status/days/limit/offset filters", async () => {
  const store = await seedStore();
  const byName = await getJson(store, "/usage.json?project=alpha");
  assert.equal(byName.summary.total, 3);
  const byRoot = await getJson(store, "/usage.json?project=%2Fw%2Falpha");
  assert.equal(byRoot.summary.total, 3);
  const fallback = await getJson(store, "/usage.json");
  assert.equal(fallback.project.name, "beta");
  assert.equal(fallback.summary.total, 1);

  const toolFiltered = await getJson(store, "/usage.json?project=alpha&tool=llm_list");
  assert.equal(toolFiltered.summary.total, 2);
  assert.deepEqual(toolFiltered.summary.zeroCallTools, ["aos_status", "llm_switch"]);

  const errors = await getJson(store, "/usage.json?project=alpha&status=error");
  assert.equal(errors.summary.total, 1);
  assert.equal(errors.events.items[0].tool, "llm_switch");

  const windowed = await getJson(store, "/usage.json?project=alpha&days=1");
  assert.equal(windowed.summary.total, 2);
  assert.equal(windowed.filters.days, 1);
  assert.ok(windowed.filters.since);

  const page1 = await getJson(store, "/usage.json?project=alpha&days=1&limit=1");
  assert.equal(page1.events.total, 2);
  assert.equal(page1.events.count, 1);
  assert.equal(page1.events.items[0].at, new Date(NOW - 60_000).toISOString());
  const page2 = await getJson(store, "/usage.json?project=alpha&days=1&limit=1&offset=1");
  assert.equal(page2.events.count, 1);
  assert.equal(page2.events.items[0].tool, "llm_switch");

  const clamped = await getJson(store, "/usage.json?project=alpha&limit=999");
  assert.equal(clamped.events.limit, 200);

  const invalid = await getJson(
    store,
    "/usage.json?project=alpha&status=bogus&days=0&limit=0&offset=-2"
  );
  assert.equal(invalid.summary.total, 3);
  assert.equal(invalid.filters.status, null);
  assert.equal(invalid.filters.days, null);
  assert.equal(invalid.filters.limit, 100);
  assert.equal(invalid.filters.offset, 0);

  const missing = await handleUsageRequest(
    new URL("http://localhost/usage.json?project=ghost"),
    deps(store)
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: '未知项目 "ghost"' });
});

test("usage web: refresh adds the HTML meta refresh and the JSON filter field", async () => {
  const store = await seedStore();
  const html = await handleUsageRequest(
    new URL("http://localhost/usage?project=alpha&refresh=30"),
    deps(store)
  );
  assert.equal(html.status, 200);
  assert.ok(html.body.includes('<meta http-equiv="refresh" content="30">'));
  const payload = await getJson(store, "/usage.json?project=alpha&refresh=30");
  assert.equal(payload.filters.refresh, 30);
  const off = await handleUsageRequest(
    new URL("http://localhost/usage?project=alpha&refresh=bogus"),
    deps(store)
  );
  assert.ok(!off.body.includes('http-equiv="refresh"'));
});

test("usage web: AOS_USAGE=0 shows the disabled note but keeps history", async () => {
  const store = await seedStore();
  const env = { AOS_USAGE: "0" };
  const html = await handleUsageRequest(
    new URL("http://localhost/usage?project=alpha"),
    deps(store, { env })
  );
  assert.ok(html.body.includes("采集已关闭（AOS_USAGE=0）"));
  const payload = await getJson(store, "/usage.json?project=alpha", { env });
  assert.equal(payload.usage.enabled, false);
  assert.match(payload.usage.note, /采集已关闭/);
  assert.equal(payload.summary.total, 3);
});

test("usage web: AOS_USAGE_WEB=0 turns both routes into 404", async () => {
  const store = await seedStore();
  const env = { AOS_USAGE_WEB: "0" };
  for (const path of ["/usage", "/usage.json"]) {
    const res = await handleUsageRequest(
      new URL(`http://localhost${path}?project=alpha`),
      deps(store, { env })
    );
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), { error: "not found" });
  }
});

test("usage web: empty store and project without events render empty states", async () => {
  const empty = new MemoryStore();
  const html = await handleUsageRequest(
    new URL("http://localhost/usage"),
    deps(empty, { storageNote: null })
  );
  assert.equal(html.status, 200);
  assert.ok(html.body.includes("暂无已注册项目"));
  assert.ok(html.body.includes("暂无事件"));
  assert.ok(html.body.includes("存储：内存降级"));
  assert.ok(html.body.includes("内存降级：数据仅当前进程内有效，重启后丢失。"));

  const payload = await getJson(empty, "/usage.json");
  assert.equal(payload.project, null);
  assert.equal(payload.summary.total, 0);
  assert.equal(payload.summary.p50, null);
  assert.deepEqual(payload.summary.zeroCallTools, ["aos_status", "llm_list", "llm_switch"]);
  assert.deepEqual(payload.events, { total: 0, count: 0, limit: 100, offset: 0, items: [] });

  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/quiet", name: "quiet" });
  const quiet = await getJson(store, "/usage.json?project=quiet");
  assert.equal(quiet.summary.total, 0);
  assert.deepEqual(quiet.summary.zeroCallTools, ["aos_status", "llm_list", "llm_switch"]);
  assert.ok(quiet.tools.every((row) => row.zeroCall));
  assert.ok(quiet.tools.some((row) => row.tool === "llm_list"));
});

test("usage web: HTML escapes injected strings", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/xss", name: "<b>bad</b>" });
  await store.recordUsageEvent(
    "/w/xss",
    eventInput({
      ok: false,
      errorClass: "unknown",
      errorSummary: '<script>alert("x")</script>',
      at: new Date(NOW).toISOString()
    })
  );
  const res = await handleUsageRequest(
    new URL("http://localhost/usage?project=%2Fw%2Fxss"),
    deps(store)
  );
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes("<script>alert"));
  assert.ok(!res.body.includes("<b>bad</b>"));
  assert.ok(res.body.includes("&lt;script&gt;"));
  assert.ok(res.body.includes("&lt;b&gt;bad&lt;/b&gt;"));
});

test("usage web: unknown path returns 404", async () => {
  const store = await seedStore();
  const res = await handleUsageRequest(new URL("http://localhost/other"), deps(store));
  assert.equal(res.status, 404);
});
