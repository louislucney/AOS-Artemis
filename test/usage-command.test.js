import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runUsageCommand } from "../dist/usage-command.js";

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
      signals: [{ code: "vision_degraded" }, { code: "param_ignored", field: "name" }],
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

async function runCli(args, options = {}) {
  const logs = [];
  const errors = [];
  const code = await runUsageCommand(args, {
    env: {},
    catalog: CATALOG,
    now: () => NOW,
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    ...options
  });
  return { code, logs, errors };
}

test("usage: default text summary shows overview, tools, zero-call and signals", async () => {
  const store = await seedStore();
  const { code, logs, errors } = await runCli([], { store, cwd: "/w/alpha" });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.ok(logs.some((line) => line.startsWith("使用统计 · alpha")));
  assert.ok(logs.some((line) => line.startsWith("存储: 内存降级")));
  assert.ok(logs.some((line) => line.includes("独立 CLI 进程无法读取其他进程的内存事件")));
  assert.ok(
    logs.some(
      (line) =>
        line.startsWith("事件: 3") && line.includes("成功率 66.7%") && line.includes("p50") && line.includes("p95")
    )
  );
  assert.ok(logs.some((line) => line.startsWith("工具:")));
  assert.ok(logs.some((line) => line.includes("llm_list 2 次")));
  assert.ok(logs.some((line) => line.startsWith("零调用:") && line.includes("aos_status")));
  assert.ok(logs.some((line) => line.startsWith("信号:")));
  assert.ok(logs.some((line) => line.includes("错误类: unknown 1")));
  assert.ok(logs.some((line) => line.includes("未分类错误:") && line.includes("未知条目 <str>")));
  assert.ok(logs.some((line) => line.includes("警告码:") && line.includes("param_ignored:name ×1")));
  assert.ok(logs.some((line) => line.includes("降级:") && line.includes("vision_degraded ×1")));
  assert.ok(logs.some((line) => line.includes("参数键:") && line.includes("llm_switch=[name]")));
});

test("usage --json: stable report fields reuse aggregate shapes", async () => {
  const store = await seedStore();
  const { code, logs } = await runCli(["--json"], { store, cwd: "/w/alpha" });
  assert.equal(code, 0);
  const payload = JSON.parse(logs.at(-1));
  assert.equal(payload.ok, true);
  assert.equal(payload.generatedAt, new Date(NOW).toISOString());
  assert.equal(payload.days, 7);
  assert.equal(payload.since, new Date(NOW - 7 * DAY).toISOString());
  assert.deepEqual(payload.usage, { enabled: true, note: null });
  assert.equal(payload.store.kind, "memory");
  assert.equal(payload.store.degraded, true);
  assert.match(payload.store.note, /内存/);
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].name, "alpha");
  assert.equal(payload.projects[0].rootPath, "/w/alpha");
  assert.equal(payload.projects[0].summary.total, 3);
  assert.equal(payload.projects[0].summary.successRate, 2 / 3);
  assert.deepEqual(payload.projects[0].summary.zeroCallTools, ["aos_status"]);
  assert.deepEqual(payload.projects[0].signals.unclassified, [
    { template: "未知条目 <str>", count: 1, tools: ["llm_switch"] }
  ]);
  assert.deepEqual(payload.totals.summary, payload.projects[0].summary);
  assert.deepEqual(payload.totals.signals, payload.projects[0].signals);
});

test("usage --all: covers every registered project plus totals", async () => {
  const store = await seedStore();
  const json = await runCli(["--all", "--json"], { store, cwd: "/w/alpha" });
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.logs.at(-1));
  assert.deepEqual(
    payload.projects.map((view) => view.name).sort(),
    ["alpha", "beta"]
  );
  assert.equal(payload.totals.summary.total, 4);
  assert.equal(payload.totals.summary.ok, 3);
  assert.equal(payload.totals.summary.error, 1);

  const text = await runCli(["--all"], { store, cwd: "/w/alpha" });
  assert.equal(text.code, 0);
  assert.ok(text.logs.some((line) => line.startsWith("使用统计 · 全部项目")));
  assert.ok(text.logs.some((line) => line.startsWith("事件合计: 4")));
  assert.ok(text.logs.some((line) => line.includes("alpha (/w/alpha)") && line.includes("3 次")));
  assert.ok(text.logs.some((line) => line.includes("beta (/w/beta)") && line.includes("1 次")));
});

test("usage --project: selects by name/root and rejects unknown names", async () => {
  const store = await seedStore();
  const beta = await runCli(["--project", "beta", "--json"], { store, cwd: "/w/alpha" });
  assert.equal(beta.code, 0);
  assert.equal(JSON.parse(beta.logs.at(-1)).projects[0].name, "beta");
  assert.equal(JSON.parse(beta.logs.at(-1)).projects[0].summary.total, 1);

  const byRoot = await runCli(["--project", "/w/beta", "--json"], { store, cwd: "/w/alpha" });
  assert.equal(byRoot.code, 0);
  assert.equal(JSON.parse(byRoot.logs.at(-1)).projects[0].rootPath, "/w/beta");

  const unknown = await runCli(["--project", "ghost"], { store, cwd: "/w/alpha" });
  assert.equal(unknown.code, 2);
  assert.ok(
    unknown.errors.some((line) => line.includes('未知项目 "ghost"') && line.includes("alpha"))
  );

  const conflict = await runCli(["--all", "--project", "beta"], { store, cwd: "/w/alpha" });
  assert.equal(conflict.code, 2);
  assert.ok(conflict.errors.some((line) => line.includes("不能同时使用")));
});

test("usage --days: filters the window and validates the value", async () => {
  const store = await seedStore();
  const week = await runCli(["--json"], { store, cwd: "/w/alpha" });
  assert.equal(JSON.parse(week.logs.at(-1)).projects[0].summary.total, 3);
  const day = await runCli(["--json", "--days", "1"], { store, cwd: "/w/alpha" });
  assert.equal(JSON.parse(day.logs.at(-1)).projects[0].summary.total, 2);
  for (const bad of ["0", "-1", "abc"]) {
    const invalid = await runCli(["--days", bad], { store, cwd: "/w/alpha" });
    assert.equal(invalid.code, 2);
    assert.ok(invalid.errors.some((line) => line.includes("--days")));
  }
});

test("usage: AOS_USAGE=0 annotates disabled collection but keeps history", async () => {
  const store = await seedStore();
  const env = { AOS_USAGE: "0" };
  const text = await runCli([], { store, cwd: "/w/alpha", env });
  assert.equal(text.code, 0);
  assert.ok(text.logs.some((line) => line.includes("采集已关闭")));
  assert.ok(text.logs.some((line) => line.startsWith("事件: 3")));

  const json = await runCli(["--json"], { store, cwd: "/w/alpha", env });
  const payload = JSON.parse(json.logs.at(-1));
  assert.equal(payload.usage.enabled, false);
  assert.match(payload.usage.note, /采集已关闭/);
  assert.equal(payload.projects[0].summary.total, 3);
});

test("usage: createStore fallback surfaces the degraded storage note", async () => {
  const store = await seedStore();
  const { code, logs } = await runCli(["--json"], {
    cwd: "/w/alpha",
    createStore: async () => ({ store, degraded: true, reason: "未配置 AOS_DATABASE_URL：" })
  });
  assert.equal(code, 0);
  const payload = JSON.parse(logs.at(-1));
  assert.equal(payload.store.degraded, true);
  assert.ok(payload.store.note.startsWith("未配置 AOS_DATABASE_URL："));
  assert.ok(payload.store.note.includes("独立 CLI 进程无法读取其他进程的内存事件"));
});

test("usage --web: serves /usage on an ephemeral port and closes cleanly", async () => {
  const store = await seedStore();
  let handle = null;
  const { code, logs, errors } = await runCli(["--web", "--port", "0"], {
    store,
    waitForShutdown: async (webHandle) => {
      handle = webHandle;
      const html = await fetch(`${webHandle.url}?project=alpha`);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /使用统计/);
      const res = await fetch(`http://127.0.0.1:${webHandle.port}/usage.json?project=alpha`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).summary.total, 3);
      await webHandle.close();
      await assert.rejects(fetch(`${webHandle.url}?project=alpha`));
    }
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.ok(handle !== null);
  assert.ok(logs.some((line) => line.includes(`http://127.0.0.1:${handle.port}/usage`)));
  assert.ok(logs.some((line) => line.includes("按 Ctrl-C 停止")));
  await assert.rejects(fetch(`${handle.url}?project=alpha`));
});

test("usage --web: port conflict exits 2 with a clear message", async () => {
  const store = new MemoryStore();
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  try {
    let waitCalled = false;
    const { code, errors } = await runCli(["--web", "--port", String(port)], {
      store,
      waitForShutdown: async () => {
        waitCalled = true;
      }
    });
    assert.equal(code, 2);
    assert.equal(waitCalled, false);
    assert.ok(errors.some((line) => line.includes(`端口 ${port}`) && line.includes("占用")));
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
});

test("usage help and parameter errors", async () => {
  const store = new MemoryStore();
  const help = await runCli(["help"], { store });
  assert.equal(help.code, 0);
  assert.ok(help.logs.some((line) => line.includes("aos-mcp usage")));

  const bogus = await runCli(["bogus"], { store });
  assert.equal(bogus.code, 2);
  assert.ok(bogus.errors.some((line) => line.includes('未知参数 "bogus"')));

  const missing = await runCli(["--project"], { store });
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("--project 需要一个值")));
});
