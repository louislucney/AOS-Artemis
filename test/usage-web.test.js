import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
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
    storageNote: "PostgreSQL 不可用，会话数据仅当前进程可见。",
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

test("usage web: AOS_PANEL_EXCLUDE_PROJECTS hides projects but explicit URL still works", async () => {
  const store = await seedStore();
  const env = { AOS_PANEL_EXCLUDE_PROJECTS: "beta" };
  const payload = await getJson(store, "/usage.json", { env });
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].name, "alpha");
  assert.equal(payload.excludedProjects, 1);

  const explicit = await getJson(store, "/usage.json?project=beta", { env });
  assert.equal(explicit.project.name, "beta", "显式项目仍可访问");
  assert.equal(explicit.projects.length, 1, "项目选择器仍只列可见项目");

  const html = await handleUsageRequest(new URL("http://localhost/usage"), deps(store, { env }));
  assert.match(html.body, /已按 <code>AOS_PANEL_EXCLUDE_PROJECTS<\/code> 隐藏 1 个项目/);
  assert.doesNotMatch(html.body, /<option value="beta"><\/option>/, "隐藏项目不出现在 datalist");
});

test("usage web: HTML 四段、页面内存储标注与项目切换器", async () => {
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
  assert.ok(body.includes("存储：会话内存"));
  assert.ok(body.includes("PostgreSQL 不可用，会话数据仅当前进程可见。"));
  assert.match(body, /data-console="shell"/, "统计页套用控制台外壳");
  assert.match(body, /aria-current="page"[^>]*>使用统计</, "使用统计为当前导航项");
  assert.ok(body.includes('list="usage-project-options"'), "可搜索项目组合框");
  assert.ok(body.includes('<option value="alpha"></option>'));
  assert.ok(body.includes('<option value="beta"></option>'));
  assert.ok(body.includes('name="project" value="alpha"'), "当前项目回显（名称提交）");
  assert.ok(body.includes('data-tool="llm_list"'));
  assert.ok(body.includes('data-zero-call="1"'));
  assert.match(body, /<details class="c-details">[\s\S]{0,200}零调用工具（\d+）/, "零调用工具折叠为目录");
  assert.match(body, /<time datetime="/, "事件/最近调用时间相对化");
  assert.match(body, /c-table-wrap/, "表格横向滚动容器（对齐 CSDC）");
  assert.match(body, /<div class="c-table-wrap"><table class="c-table"><caption>事件流水<\/caption>/, "事件流水表也含容器（390 不整页溢出）");
  assert.ok(!body.includes("记录底座："), "顶栏不再有存储状态胶囊");
  assert.match(body, />成功<\/option>[\s\S]*>失败<\/option>/, "筛选词中文化（成功/失败）");
  assert.match(body, /独立统计进程（控制台总览：/, "独立进程不渲染死链，改为说明");

  const htmlWithPanel = await handleUsageRequest(
    new URL("http://localhost/usage?project=alpha"),
    deps(store, { panelUrl: "/panel" })
  );
  assert.match(htmlWithPanel.body, /<a href="\/panel">← 回到控制台<\/a>/, "同进程时给回链");
  assert.doesNotMatch(htmlWithPanel.body, /独立统计进程（控制台总览/, "有回链不重复说明");
  assert.ok(body.includes("aos_status"));
  assert.ok(!body.includes("aos_usage"));
  assert.ok(body.includes("未知条目 &lt;str&gt;"));
  assert.ok(body.includes("console-shortcuts"));
  assert.ok(!body.includes("fetch("), "无业务脚本（usage 只读）");
  assert.match(body, /<th scope="col">/, "usage 表格补 scope");
  assert.match(body, /<caption>/, "usage 表格补 caption");
  assert.match(body, /c-badge/, "usage 徽章并入 CSDC 组件");
  assert.match(body, /c-stat/, "usage 指标卡并入 CSDC 组件");
});

test("usage web: /usage.json exposes the stable machine-readable contract", async () => {
  const store = await seedStore();
  const payload = await getJson(store, "/usage.json?project=alpha");
  assert.equal(payload.ok, true);
  assert.equal(payload.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(payload.usage, { enabled: true, storage: "memory", note: null });
  assert.equal(payload.store.kind, "memory");
  assert.equal(payload.store.degraded, true);
  assert.equal(payload.store.note, "PostgreSQL 不可用，会话数据仅当前进程可见。");
  assert.deepEqual(payload.filters, {
    project: "alpha",
    projectRoot: "/w/alpha",
    hostId: null,
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

test("usage web: 项目切换＝可搜索组合框（datalist＋名称提交可解析）", async () => {
  const store = await seedStore();
  const html = await handleUsageRequest(new URL("http://localhost/usage?project=alpha"), deps(store));
  assert.equal(html.status, 200);
  assert.match(html.body, /list="usage-project-options"/, "可搜索组合框");
  assert.match(html.body, /<option value="alpha"><\/option>/, "候选含 alpha");
  assert.match(html.body, /<option value="beta"><\/option>/, "候选含 beta");
  assert.match(html.body, /placeholder="输入名称筛选（2 个项目）"/);
  assert.doesNotMatch(html.body, /<select name="project">/, "旧 select 移除");

  const betaHtml = await handleUsageRequest(new URL("http://localhost/usage?project=beta"), deps(store));
  assert.match(betaHtml.body, /name="project" value="beta"/, "按名称提交仍可解析（回显当前项目）");
});

test("usage web: refresh adds the HTML meta refresh and the JSON filter field", async () => {
  const store = await seedStore();
  const html = await handleUsageRequest(
    new URL("http://localhost/usage?project=alpha&refresh=30"),
    deps(store)
  );
  assert.equal(html.status, 200);
  assert.ok(html.body.includes("DOMParser"), "refresh=30 走局部轮询（不再整页刷新）");
  assert.ok(!html.body.includes('http-equiv="refresh"'), "无 meta 刷新");
  assert.match(html.body, /class="c-brand"><a href="\/usage"/, "独立统计页品牌指向 /usage");
  assert.ok(!html.body.includes('role="search"'), "独立统计页不做指向 /panel 的全局搜索");
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
  assert.ok(html.body.includes("存储：会话内存"));
  assert.ok(html.body.includes("会话内存：数据仅当前进程内有效，重启后丢失。"));
  assert.ok(!html.body.includes("0.0%"), "0 事件成功率显示 —（不再 0.0%）");
  assert.match(html.body, /成功率<\/div><div class="c-stat-value">—<\/div>/, "成功率空态 —");

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

test("usage web: 未归属 legacy 路径与主机行同路径 → 409 候选主机（不 500）", async () => {
  const store = new MemoryStore();
  await store.upsertHost({ id: "h-a", hostname: "mac-a", osPlatform: "darwin" });
  await store.upsertProject({ rootPath: "/w/shared", name: "legacy-app" });
  await store.scopeHost("h-a").upsertProject({ rootPath: "/w/shared", name: "app" });

  const res = await handleUsageRequest(
    new URL("http://localhost/usage.json?project=legacy-app"),
    deps(store)
  );
  assert.equal(res.status, 409, res.body);
  assert.match(res.contentType, /application\/json/);
  const payload = JSON.parse(res.body);
  assert.match(payload.error, /跨主机重复/);
  assert.ok(payload.candidates.some((candidate) => candidate.hostId === "h-a"));
  assert.ok(payload.candidates.some((candidate) => candidate.hostId === null));
  assert.deepEqual(
    payload.candidates.map((candidate) => candidate.rootPath),
    ["/w/shared", "/w/shared"]
  );
});

test("usage web: 同 rootPath 两主机按 host 作用域读事件（不再 AmbiguousProjectError）", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  const a = store.scopeHost("h-a");
  const b = store.scopeHost("h-b");
  await a.upsertProject({ rootPath: "/w/shared", name: "shared-a" });
  await b.upsertProject({ rootPath: "/w/shared", name: "shared-b" });
  await a.recordUsageEvent(
    "/w/shared",
    eventInput({ tool: "llm_list", at: new Date(NOW - 60_000).toISOString() })
  );
  await b.recordUsageEvent(
    "/w/shared",
    eventInput({ tool: "aos_status", at: new Date(NOW - 30_000).toISOString() })
  );

  const first = await getJson(store, "/usage.json?project=shared-a");
  assert.equal(first.project.name, "shared-a");
  assert.deepEqual(first.events.items.map((event) => event.tool), ["llm_list"]);
  const second = await getJson(store, "/usage.json?project=shared-b");
  assert.equal(second.project.name, "shared-b");
  assert.deepEqual(second.events.items.map((event) => event.tool), ["aos_status"]);

  const fallback = await getJson(store, "/usage.json");
  assert.equal(fallback.summary.total, 1, "缺省项目取最新注册的一行且不抛歧义");
  const ambiguousPath = await handleUsageRequest(
    new URL("http://localhost/usage?project=%2Fw%2Fshared"),
    deps(store)
  );
  assert.equal(ambiguousPath.status, 409, "同路径多主机不再任取一行");
  const pathPayload = JSON.parse(ambiguousPath.body);
  assert.deepEqual(
    pathPayload.candidates.map((candidate) => candidate.hostId).sort(),
    ["h-a", "h-b"]
  );
});

test("usage web: ?host 作用域读事件，分页/筛选链接保留 host（下一页仍 200）", async () => {
  const store = new MemoryStore();
  await store.upsertHost({ id: "h-a", hostname: "mac-a", osPlatform: "darwin" });
  await store.upsertHost({ id: "h-b", hostname: "mac-b", osPlatform: "linux" });
  const a = store.scopeHost("h-a");
  const b = store.scopeHost("h-b");
  await a.upsertProject({ rootPath: "/w/shared", name: "shared" });
  await b.upsertProject({ rootPath: "/w/shared", name: "shared" });
  await a.recordUsageEvent(
    "/w/shared",
    eventInput({ tool: "llm_list", at: new Date(NOW - 60_000).toISOString() })
  );
  await b.recordUsageEvent(
    "/w/shared",
    eventInput({ tool: "aos_status", at: new Date(NOW - 90_000).toISOString() })
  );
  await b.recordUsageEvent(
    "/w/shared",
    eventInput({ tool: "aos_status", at: new Date(NOW - 30_000).toISOString() })
  );

  const scopedPath = "/usage?host=h-b&project=%2Fw%2Fshared&limit=1";
  const res = await handleUsageRequest(new URL(`http://localhost${scopedPath}`), deps(store));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /name="host" value="h-b"/, "筛选表单保留 host");
  assert.match(res.body, /下一页/, "两页事件产生下一页链接");
  const nextHrefRaw = /<a href="([^"]+)">下一页<\/a>/.exec(res.body)?.[1];
  assert.ok(nextHrefRaw, "下一页链接存在");
  const nextHref = nextHrefRaw.replaceAll("&amp;", "&");
  const nextUrl = new URL(nextHref, "http://localhost");
  assert.equal(nextUrl.searchParams.get("host"), "h-b");
  assert.equal(nextUrl.searchParams.get("project"), "/w/shared");

  const next = await handleUsageRequest(new URL(nextHref, "http://localhost"), deps(store));
  assert.equal(next.status, 200, next.body);
  const nextEvents = next.body.split('<section id="events">')[1] ?? "";
  assert.match(nextEvents, /data-tool="aos_status"/);
  assert.doesNotMatch(nextEvents, /data-tool="llm_list"/, "只显示 h-b 事件");
  const prevHrefRaw = /<a href="([^"]+)">上一页<\/a>/.exec(next.body)?.[1];
  assert.ok(prevHrefRaw, "第二页出现上一页链接");
  assert.equal(
    new URL(prevHrefRaw.replaceAll("&amp;", "&"), "http://localhost").searchParams.get("host"),
    "h-b"
  );

  const resetHrefRaw = /<a class="reset" href="([^"]+)"/.exec(res.body)?.[1];
  assert.ok(resetHrefRaw);
  assert.equal(
    new URL(resetHrefRaw.replaceAll("&amp;", "&"), "http://localhost").searchParams.get("host"),
    "h-b"
  );

  const json = await getJson(store, "/usage.json?host=h-b&project=%2Fw%2Fshared");
  assert.equal(json.project.hostId, "h-b");
  assert.equal(json.filters.hostId, "h-b");
  assert.deepEqual(json.events.items.map((event) => event.tool), ["aos_status", "aos_status"]);

  const ambiguous = await handleUsageRequest(
    new URL("http://localhost/usage.json?project=%2Fw%2Fshared"),
    deps(store)
  );
  assert.equal(ambiguous.status, 409, "未带 host 的同路径仍 409");
});

test("usage web: PostgreSQL 未知 host → 404（不静默显示零项目）", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  await store.upsertHost({ id: "h-a", hostname: "mac-a", osPlatform: "darwin" });
  await store.scopeHost("h-a").upsertProject({ rootPath: "/w/app", name: "app" });

  const unknown = await handleUsageRequest(
    new URL("http://localhost/usage.json?host=ghost&project=%2Fw%2Fapp"),
    deps(store)
  );
  assert.equal(unknown.status, 404, unknown.body);
  assert.match(JSON.parse(unknown.body).error, /未知主机 "ghost"/);

  const known = await getJson(store, "/usage.json?host=h-a&project=%2Fw%2Fapp");
  assert.equal(known.project.hostId, "h-a");
});

test("usage web: 同名多项目 → 409 候选（不再静默取第一个）", async () => {
  const store = new MemoryStore();
  await store.upsertHost({ id: "h-a", hostname: "mac-a", osPlatform: "darwin" });
  await store.scopeHost("h-a").upsertProject({ rootPath: "/w/a/app", name: "app" });
  await store.scopeHost("h-a").upsertProject({ rootPath: "/w/b/app", name: "app" });

  const res = await handleUsageRequest(
    new URL("http://localhost/usage.json?project=app"),
    deps(store)
  );
  assert.equal(res.status, 409, res.body);
  const payload = JSON.parse(res.body);
  assert.deepEqual(
    payload.candidates.map((candidate) => candidate.rootPath).sort(),
    ["/w/a/app", "/w/b/app"]
  );
});

