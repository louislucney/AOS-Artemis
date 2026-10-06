import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServerForRuntime, inProcessToolCatalog } from "../dist/server.js";
import { aosUsage } from "../dist/tools/usage.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

const DAY = 86_400_000;

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
    at: new Date().toISOString(),
    ...overrides
  };
}

async function seed(runtime, dir, events) {
  for (const event of events) {
    await runtime.store.recordUsageEvent(dir, event, {});
  }
}

async function runtimeFor(overrides = {}) {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: true }),
    ...overrides
  });
  return { dir, runtime };
}

test("aos_usage summary: totals, percentiles, distributions and zero-call catalog", async () => {
  const { dir, runtime } = await runtimeFor();
  const base = Date.now() - 60_000;
  await seed(runtime, dir, [
    eventInput({ tool: "llm_list", durationMs: 5, at: new Date(base - 4000).toISOString() }),
    eventInput({
      tool: "llm_list",
      durationMs: 3,
      argKeys: ["sync"],
      at: new Date(base - 3000).toISOString()
    }),
    eventInput({
      tool: "mobile_run_task",
      family: "mobile",
      ok: false,
      durationMs: 9,
      errorClass: "artemis",
      errorSummary: "执行失败: x",
      at: new Date(base - 2000).toISOString()
    }),
    eventInput({
      tool: "figma_export_brief",
      family: "figma",
      durationMs: 1,
      at: new Date(base - 1000).toISOString()
    })
  ]);

  const payload = parseToolResult(await aosUsage(runtime, { action: "summary" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "summary");
  assert.deepEqual(payload.usage, { enabled: true, storage: "memory" });
  assert.deepEqual(payload.store, { kind: "memory", degraded: true });
  assert.deepEqual(payload.filters, {
    tool: null,
    status: null,
    days: null,
    since: null,
    limit: null
  });

  const summary = payload.summary;
  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 3);
  assert.equal(summary.error, 1);
  assert.equal(summary.successRate, 0.75);
  assert.equal(summary.p50, 3);
  assert.equal(summary.p95, 9);
  assert.deepEqual(
    summary.byTool.map((entry) => entry.tool),
    ["llm_list", "figma_export_brief", "mobile_run_task"]
  );
  assert.deepEqual(summary.byFamily, [
    { family: "native", count: 2 },
    { family: "figma", count: 1 },
    { family: "mobile", count: 1 }
  ]);
  assert.equal(
    summary.byDay.reduce((sum, entry) => sum + entry.count, 0),
    4
  );
  assert.ok(summary.zeroCallTools.includes("aos_status"));
  assert.ok(summary.zeroCallTools.includes("pen_agent"));
  assert.ok(summary.zeroCallTools.includes("mobile_diagnose"));
  assert.ok(!summary.zeroCallTools.includes("llm_list"));
  assert.ok(!summary.zeroCallTools.includes("aos_usage"));
});

test("aos_usage: tool/status/days filters flow into summary and events", async () => {
  const { dir, runtime } = await runtimeFor();
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const older = new Date(Date.now() - 3 * DAY).toISOString();
  await seed(runtime, dir, [
    eventInput({ tool: "llm_list", at: older }),
    eventInput({ tool: "llm_list", at: recent }),
    eventInput({
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: '未知条目 "ghost"',
      argKeys: ["name"],
      at: recent
    })
  ]);

  const byTool = parseToolResult(await aosUsage(runtime, { action: "summary", tool: "llm_list" }));
  assert.equal(byTool.summary.total, 2);
  assert.equal(byTool.filters.tool, "llm_list");

  const windowed = parseToolResult(
    await aosUsage(runtime, { action: "summary", tool: "llm_list", days: 1 })
  );
  assert.equal(windowed.summary.total, 1);
  assert.equal(windowed.filters.days, 1);
  assert.ok(windowed.filters.since);

  const errors = parseToolResult(await aosUsage(runtime, { action: "summary", status: "error" }));
  assert.equal(errors.summary.total, 1);
  assert.equal(errors.summary.byTool[0].tool, "llm_switch");
  assert.equal(errors.summary.successRate, 0);

  const events = parseToolResult(
    await aosUsage(runtime, { action: "events", tool: "llm_list", limit: 1 })
  );
  assert.equal(events.count, 1);
  assert.equal(events.events[0].at, recent);
  assert.deepEqual(events.filters, {
    tool: "llm_list",
    status: null,
    days: null,
    since: null,
    limit: 1
  });

  const okRecent = parseToolResult(
    await aosUsage(runtime, { action: "events", status: "ok", days: 1 })
  );
  assert.equal(okRecent.count, 1);
  assert.equal(okRecent.events[0].tool, "llm_list");
});

test("aos_usage events: newest-first ordering, fields and the 200 cap", async () => {
  const { dir, runtime } = await runtimeFor();
  const base = Date.now() - 10 * 60 * 1000;
  const fixtures = [];
  for (let index = 0; index < 205; index += 1) {
    fixtures.push(
      eventInput({
        tool: index % 2 === 0 ? "llm_list" : "aos_status",
        durationMs: index,
        at: new Date(base + index * 1000).toISOString()
      })
    );
  }
  await seed(runtime, dir, fixtures);

  const fallback = parseToolResult(await aosUsage(runtime, { action: "events" }));
  assert.equal(fallback.count, 100);

  const five = parseToolResult(await aosUsage(runtime, { action: "events", limit: 5 }));
  assert.equal(five.count, 5);
  assert.deepEqual(
    five.events.map((event) => event.durationMs),
    [204, 203, 202, 201, 200]
  );
  const sample = five.events[0];
  assert.equal(sample.tool, "llm_list");
  assert.equal(sample.family, "native");
  assert.equal(sample.ok, true);
  assert.equal(sample.errorClass, null);
  assert.equal(sample.errorSummary, null);
  assert.deepEqual(sample.signals, []);
  assert.deepEqual(sample.argKeys, []);
  assert.equal(sample.traceId, null);
  assert.ok(sample.id);
  assert.equal("projectId" in sample, false);

  const capped = parseToolResult(await aosUsage(runtime, { action: "events", limit: 500 }));
  assert.equal(capped.count, 200);
});

test("aos_usage signals: error classes, normalized clusters, codes, degradations, arg keys", async () => {
  const { dir, runtime } = await runtimeFor();
  const base = Date.now() - 60_000;
  await seed(runtime, dir, [
    eventInput({
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: '未知条目 "ghost-1"',
      durationMs: 2,
      argKeys: ["name"],
      at: new Date(base - 3000).toISOString()
    }),
    eventInput({
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: '未知条目 "phantom-2"',
      durationMs: 4,
      argKeys: ["name", "force"],
      signals: [{ code: "param_ignored", field: "model" }],
      at: new Date(base - 2000).toISOString()
    }),
    eventInput({
      tool: "mobile_run_task",
      family: "mobile",
      durationMs: 30,
      signals: [{ code: "vision_degraded" }, { code: "param_ignored", field: "serial" }],
      argKeys: ["task_desc"],
      at: new Date(base - 1000).toISOString()
    })
  ]);

  const payload = parseToolResult(await aosUsage(runtime, { action: "signals" }));
  assert.equal(payload.action, "signals");
  assert.deepEqual(payload.filters, {
    tool: null,
    status: null,
    days: null,
    since: null,
    limit: null
  });

  const signals = payload.signals;
  assert.deepEqual(signals.unclassified, [
    { template: "未知条目 <str>", count: 2, tools: ["llm_switch"] }
  ]);
  assert.ok(
    signals.errorClasses.some((entry) => entry.errorClass === "unknown" && entry.count === 2)
  );
  assert.ok(signals.errorClasses.some((entry) => entry.errorClass === null && entry.count === 1));
  assert.ok(
    signals.signalCodes.some(
      (entry) => entry.code === "param_ignored" && entry.field === "model" && entry.count === 1
    )
  );
  assert.ok(
    signals.signalCodes.some(
      (entry) => entry.code === "vision_degraded" && entry.field === null && entry.count === 1
    )
  );
  assert.deepEqual(signals.degradations, [
    { code: "param_ignored", count: 2 },
    { code: "vision_degraded", count: 1 }
  ]);
  assert.deepEqual(signals.argKeys, [
    { tool: "llm_switch", keys: [{ key: "name", count: 2 }, { key: "force", count: 1 }] },
    { tool: "mobile_run_task", keys: [{ key: "task_desc", count: 1 }] }
  ]);
});

test("aos_usage: AOS_USAGE=0 annotates disabled collection but keeps history", async () => {
  const { dir, runtime } = await runtimeFor({ baseEnv: { AOS_USAGE: "0" } });
  await seed(runtime, dir, [
    eventInput({ tool: "llm_list", at: new Date(Date.now() - 1000).toISOString() })
  ]);

  const summary = parseToolResult(await aosUsage(runtime, { action: "summary" }));
  assert.equal(summary.usage.enabled, false);
  assert.equal(summary.usage.storage, "memory");
  assert.match(summary.usage.note, /AOS_USAGE=0/);
  assert.match(summary.usage.note, /历史/);
  assert.equal(summary.summary.total, 1);

  const events = parseToolResult(await aosUsage(runtime, { action: "events" }));
  assert.equal(events.count, 1);
  assert.match(events.usage.note, /采集已关闭/);
});

test("aos_usage: empty store returns zeroed shapes and the zero-call catalog", async () => {
  const { runtime } = await runtimeFor({ proxy: new StubProxy({ running: false }) });

  const summary = parseToolResult(await aosUsage(runtime, { action: "summary" }));
  assert.equal(summary.summary.total, 0);
  assert.equal(summary.summary.successRate, 0);
  assert.equal(summary.summary.p50, null);
  assert.equal(summary.summary.p95, null);
  assert.deepEqual(summary.summary.byTool, []);
  assert.deepEqual(summary.summary.byFamily, []);
  assert.deepEqual(summary.summary.byDay, []);
  assert.ok(summary.summary.zeroCallTools.length > 0);
  assert.ok(summary.summary.zeroCallTools.includes("aos_status"));
  assert.ok(!summary.summary.zeroCallTools.includes("mobile_diagnose"));

  const signals = parseToolResult(await aosUsage(runtime, { action: "signals" }));
  assert.deepEqual(signals.signals, {
    errorClasses: [],
    unclassified: [],
    signalCodes: [],
    degradations: [],
    argKeys: []
  });

  const events = parseToolResult(await aosUsage(runtime, { action: "events" }));
  assert.equal(events.count, 0);
  assert.deepEqual(events.events, []);
});

test("aos_usage: zero-call catalog matches the in-process registry exactly", async () => {
  const { runtime } = await runtimeFor({ proxy: new StubProxy({ running: false }) });
  const payload = parseToolResult(await aosUsage(runtime, { action: "summary" }));
  const expected = inProcessToolCatalog()
    .filter((name) => name !== "aos_usage")
    .sort();
  assert.deepEqual(payload.summary.zeroCallTools, expected);
});

test("aos_usage: a failing mobile catalog never breaks the summary", async () => {
  const proxy = new StubProxy({ running: true });
  proxy.listTools = async () => {
    throw new Error("child down");
  };
  const { runtime } = await runtimeFor({ proxy });
  const payload = parseToolResult(await aosUsage(runtime, { action: "summary" }));
  assert.equal(payload.ok, true);
  assert.ok(payload.summary.zeroCallTools.includes("aos_status"));
  assert.ok(!payload.summary.zeroCallTools.includes("mobile_diagnose"));
});

test("aos_usage server: zod rejects limit over 200, zero days and unknown actions", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: false }) });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-tool-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const over = await client.callTool({
      name: "aos_usage",
      arguments: { action: "events", limit: 201 }
    });
    assert.equal(over.isError, true);
    assert.match(over.content[0].text, /参数校验失败/);

    const zeroDays = await client.callTool({ name: "aos_usage", arguments: { days: 0 } });
    assert.equal(zeroDays.isError, true);

    const badAction = await client.callTool({ name: "aos_usage", arguments: { action: "bogus" } });
    assert.equal(badAction.isError, true);

    const ok = await client.callTool({
      name: "aos_usage",
      arguments: { action: "events", limit: 200 }
    });
    assert.notEqual(ok.isError, true);
    const payload = JSON.parse(ok.content[0].text);
    assert.equal(payload.action, "events");
    assert.equal(payload.count, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
