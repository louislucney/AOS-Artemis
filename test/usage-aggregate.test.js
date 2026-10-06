import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_DEGRADATION_CODES,
  USAGE_EVENT_LIST_MAX,
  normalizeUsageErrorTemplate,
  usageEvents,
  usageSignals,
  usageSummary
} from "../dist/usage/aggregate.js";

function event(overrides = {}) {
  return {
    id: "e0",
    projectId: "p1",
    at: "2026-03-01T10:00:00.000Z",
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

test("usage aggregate: empty input yields zeroed deterministic shapes", () => {
  assert.deepEqual(usageSummary([]), {
    total: 0,
    ok: 0,
    error: 0,
    successRate: 0,
    p50: null,
    p95: null,
    byTool: [],
    byFamily: [],
    byDay: [],
    zeroCallTools: []
  });
  assert.deepEqual(usageSummary([], ["b", "a", "a"]).zeroCallTools, ["a", "b"]);
  assert.deepEqual(usageSignals([]), {
    errorClasses: [],
    unclassified: [],
    signalCodes: [],
    degradations: [],
    argKeys: []
  });
  assert.deepEqual(usageEvents([]), []);
});

test("usage aggregate: single event and zero-call tools from catalog", () => {
  const single = event({
    id: "s1",
    tool: "pen_export",
    family: "pen",
    durationMs: 7,
    at: "2026-03-04T23:10:00.000Z"
  });
  assert.deepEqual(usageSummary([single], ["llm_list", "pen_export", "pen_export"]), {
    total: 1,
    ok: 1,
    error: 0,
    successRate: 1,
    p50: 7,
    p95: 7,
    byTool: [
      { tool: "pen_export", count: 1, ok: 1, error: 0, successRate: 1, p50: 7, p95: 7 }
    ],
    byFamily: [{ family: "pen", count: 1 }],
    byDay: [{ day: "2026-03-04", count: 1 }],
    zeroCallTools: ["llm_list"]
  });
  assert.deepEqual(usageSignals([single]).errorClasses, [{ errorClass: null, count: 1 }]);
  assert.deepEqual(usageSummary([single]).zeroCallTools, []);
});

test("usage aggregate: nearest-rank p50/p95 and success rate on known samples", () => {
  const sample4 = [
    event({ id: "p1", durationMs: 5 }),
    event({ id: "p2", durationMs: 1 }),
    event({ id: "p3", durationMs: 9 }),
    event({
      id: "p4",
      durationMs: 3,
      ok: false,
      errorClass: "internal",
      errorSummary: "boom"
    })
  ];
  const summary4 = usageSummary(sample4);
  assert.equal(summary4.total, 4);
  assert.equal(summary4.ok, 3);
  assert.equal(summary4.error, 1);
  assert.equal(summary4.successRate, 0.75);
  assert.equal(summary4.p50, 3);
  assert.equal(summary4.p95, 9);
  assert.deepEqual(
    summary4.byTool.map((entry) => [entry.tool, entry.p50, entry.p95]),
    [["llm_list", 3, 9]]
  );

  const sample3 = [
    event({ id: "r1", durationMs: 1 }),
    event({ id: "r2", durationMs: 2 }),
    event({ id: "r3", durationMs: 100 })
  ];
  assert.equal(usageSummary(sample3).p50, 2);
  assert.equal(usageSummary(sample3).p95, 100);

  const sample2 = [event({ id: "q1", durationMs: 4 }), event({ id: "q2", durationMs: 8 })];
  assert.equal(usageSummary(sample2).p50, 4);
  assert.equal(usageSummary(sample2).p95, 8);
});

test("usage aggregate: tool, family and UTC day distributions with stable ties", () => {
  const events = [
    event({ id: "d1", tool: "llm_list", family: "native", at: "2026-03-01T10:00:00.000Z" }),
    event({ id: "d2", tool: "llm_list", family: "native", at: "2026-03-01T23:59:59.000Z" }),
    event({
      id: "d3",
      tool: "mobile_run_task",
      family: "mobile",
      ok: false,
      errorClass: "artemis",
      errorSummary: "x",
      at: "2026-03-02T00:30:00.000Z"
    }),
    event({
      id: "d4",
      tool: "figma_export_brief",
      family: "figma",
      durationMs: 20,
      at: "2026-03-02T12:00:00.000Z"
    })
  ];
  const summary = usageSummary(events);
  assert.deepEqual(
    summary.byTool.map((entry) => [entry.tool, entry.count, entry.ok, entry.error, entry.successRate]),
    [
      ["llm_list", 2, 2, 0, 1],
      ["figma_export_brief", 1, 1, 0, 1],
      ["mobile_run_task", 1, 0, 1, 0]
    ]
  );
  assert.deepEqual(summary.byFamily, [
    { family: "native", count: 2 },
    { family: "figma", count: 1 },
    { family: "mobile", count: 1 }
  ]);
  assert.deepEqual(summary.byDay, [
    { day: "2026-03-01", count: 2 },
    { day: "2026-03-02", count: 2 }
  ]);
  assert.deepEqual(
    usageSummary(events, [
      "llm_list",
      "figma_export_brief",
      "mobile_run_task",
      "pen_inspect",
      "aos_usage"
    ]).zeroCallTools,
    ["aos_usage", "pen_inspect"]
  );
});

test("usage aggregate: normalization replaces numbers, hex ids, uuids, paths, quotes, tokens", () => {
  assert.equal(
    normalizeUsageErrorTemplate("失败 code 404 于 2026-03-01"),
    "失败 code <num> 于 <num>-<num>-<num>"
  );
  assert.equal(normalizeUsageErrorTemplate("trace 7f3a9b2c missing"), "trace <hex> missing");
  assert.equal(
    normalizeUsageErrorTemplate("会话 123e4567-e89b-12d3-a456-426614174000 不存在"),
    "会话 <uuid> 不存在"
  );
  assert.equal(
    normalizeUsageErrorTemplate("读取 /Users/louis/proj/src/index.ts 失败"),
    "读取 /<path> 失败"
  );
  assert.equal(
    normalizeUsageErrorTemplate('未知条目 "ghost" 与 \'x1\''),
    "未知条目 <str> 与 <str>"
  );
  assert.equal(
    normalizeUsageErrorTemplate("key sk-abcdefghijklmnopqrstuvwx123456 rejected"),
    "key <token> rejected"
  );
  assert.equal(normalizeUsageErrorTemplate("   "), "<no-summary>");
  assert.equal(normalizeUsageErrorTemplate(null), "<no-summary>");
});

test("usage aggregate: unknown errors cluster by normalized template, sorted by count", () => {
  const events = [
    event({
      id: "c1",
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: '未知条目 "ghost-1"',
      at: "2026-03-01T00:00:00.000Z"
    }),
    event({
      id: "c2",
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: '未知条目 "phantom-2"',
      at: "2026-03-01T00:01:00.000Z"
    }),
    event({
      id: "c3",
      tool: "mobile_run_task",
      family: "mobile",
      ok: false,
      errorClass: "unknown",
      errorSummary: "trace 7f3a9b2c not found",
      at: "2026-03-01T00:02:00.000Z"
    }),
    event({
      id: "c4",
      tool: "mobile_run_task",
      family: "mobile",
      ok: false,
      errorClass: "unknown",
      errorSummary: "trace 91ab34cd not found",
      at: "2026-03-01T00:03:00.000Z"
    }),
    event({
      id: "c5",
      tool: "aos_status",
      ok: false,
      errorClass: null,
      errorSummary: "完全不同的失败",
      at: "2026-03-01T00:04:00.000Z"
    }),
    event({
      id: "c6",
      tool: "aos_status",
      ok: false,
      errorClass: null,
      errorSummary: null,
      at: "2026-03-01T00:05:00.000Z"
    }),
    event({
      id: "c7",
      tool: "llm_list",
      ok: false,
      errorClass: "internal",
      errorSummary: "内部错误",
      at: "2026-03-01T00:06:00.000Z"
    })
  ];
  const { unclassified, errorClasses } = usageSignals(events);
  assert.deepEqual(unclassified, [
    { template: "trace <hex> not found", count: 2, tools: ["mobile_run_task"] },
    { template: "未知条目 <str>", count: 2, tools: ["llm_switch"] },
    { template: "<no-summary>", count: 1, tools: ["aos_status"] },
    { template: "完全不同的失败", count: 1, tools: ["aos_status"] }
  ]);
  assert.deepEqual(errorClasses, [
    { errorClass: "unknown", count: 4 },
    { errorClass: null, count: 2 },
    { errorClass: "internal", count: 1 }
  ]);
});

test("usage aggregate: signal code+field distribution keeps unknown codes verbatim", () => {
  const events = [
    event({
      id: "w1",
      tool: "mobile_run_task",
      family: "mobile",
      signals: [{ code: "param_ignored", field: "model" }, { code: "vision_degraded" }]
    }),
    event({
      id: "w2",
      tool: "mobile_run_task",
      family: "mobile",
      signals: [
        { code: "param_ignored", field: "model" },
        { code: "param_ignored", field: "serial" },
        { code: "new_unknown_code" },
        { code: "lossless_fallback" }
      ]
    })
  ];
  const { signalCodes, degradations } = usageSignals(events);
  assert.deepEqual(signalCodes, [
    { code: "param_ignored", field: "model", count: 2 },
    { code: "lossless_fallback", field: null, count: 1 },
    { code: "new_unknown_code", field: null, count: 1 },
    { code: "param_ignored", field: "serial", count: 1 },
    { code: "vision_degraded", field: null, count: 1 }
  ]);
  assert.deepEqual(degradations, [
    { code: "param_ignored", count: 3 },
    { code: "lossless_fallback", count: 1 },
    { code: "vision_degraded", count: 1 }
  ]);
  assert.equal(USAGE_DEGRADATION_CODES.length, 8);
  assert.ok(USAGE_DEGRADATION_CODES.includes("skipped_unmanaged"));
  assert.ok(!USAGE_DEGRADATION_CODES.includes("new_unknown_code"));
});

test("usage aggregate: per-tool arg key frequency counts each key once per event", () => {
  const events = [
    event({ id: "k1", tool: "llm_switch", argKeys: ["name", "name", "model"] }),
    event({ id: "k2", tool: "llm_switch", argKeys: ["name"] }),
    event({
      id: "k3",
      tool: "mobile_run_task",
      family: "mobile",
      argKeys: ["device_serial", "task_desc"]
    })
  ];
  assert.deepEqual(usageSignals(events).argKeys, [
    {
      tool: "llm_switch",
      keys: [
        { key: "name", count: 2 },
        { key: "model", count: 1 }
      ]
    },
    {
      tool: "mobile_run_task",
      keys: [
        { key: "device_serial", count: 1 },
        { key: "task_desc", count: 1 }
      ]
    }
  ]);
});

test("usage aggregate: events filter matches store semantics, newest first", () => {
  const events = [
    event({ id: "f1", tool: "llm_list", at: "2026-03-01T00:00:00.000Z" }),
    event({
      id: "f2",
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: "x",
      at: "2026-03-01T00:01:00.000Z"
    }),
    event({ id: "f3", tool: "llm_list", at: "2026-03-02T00:00:00.000Z" }),
    event({ id: "f4", tool: "mobile_run_task", family: "mobile", at: "2026-03-02T00:01:00.000Z" })
  ];
  assert.deepEqual(usageEvents(events).map((entry) => entry.id), ["f4", "f3", "f2", "f1"]);
  assert.deepEqual(usageEvents(events, { tool: "llm_list" }).map((entry) => entry.id), [
    "f3",
    "f1"
  ]);
  assert.deepEqual(usageEvents(events, { status: "error" }).map((entry) => entry.id), ["f2"]);
  assert.deepEqual(usageEvents(events, { status: "ok" }).map((entry) => entry.id), [
    "f4",
    "f3",
    "f1"
  ]);
  assert.deepEqual(
    usageEvents(events, { since: "2026-03-01T00:01:00.000Z" }).map((entry) => entry.id),
    ["f4", "f3", "f2"]
  );
  assert.deepEqual(
    usageEvents(events, { until: "2026-03-01T00:01:00.000Z" }).map((entry) => entry.id),
    ["f2", "f1"]
  );
  assert.deepEqual(
    usageEvents(events, {
      since: "2026-03-02T00:00:00.000Z",
      until: "2026-03-02T00:01:00.000Z"
    }).map((entry) => entry.id),
    ["f4", "f3"]
  );
  assert.deepEqual(usageEvents(events, { limit: 2 }).map((entry) => entry.id), ["f4", "f3"]);
  assert.deepEqual(usageEvents(events, { limit: -1 }).map((entry) => entry.id), [
    "f4",
    "f3",
    "f2",
    "f1"
  ]);

  const tied = [
    event({ id: "a", at: "2026-03-01T00:00:00.000Z" }),
    event({ id: "b", at: "2026-03-01T00:00:00.000Z" })
  ];
  assert.deepEqual(usageEvents(tied).map((entry) => entry.id), ["b", "a"]);
});

test("usage aggregate: events limit defaults to 100 and caps at 200", () => {
  const many = [];
  for (let index = 0; index < 205; index += 1) {
    many.push(
      event({
        id: `m${String(index).padStart(3, "0")}`,
        at: new Date(Date.UTC(2026, 2, 1, 0, 0, index)).toISOString()
      })
    );
  }
  const capped = usageEvents(many, { limit: 1000 });
  assert.equal(USAGE_EVENT_LIST_MAX, 200);
  assert.equal(capped.length, 200);
  assert.equal(capped[0].id, "m204");
  assert.equal(capped[capped.length - 1].id, "m005");
  assert.equal(usageEvents(many).length, 100);
  assert.equal(usageEvents(many, { limit: 0 }).length, 100);
  assert.equal(usageEvents(many, { limit: 250 }).length, 200);
});

test("usage aggregate: outputs are order-independent and stable", () => {
  const events = [
    event({
      id: "z1",
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: "trace 7f3a9b2c not found",
      signals: [{ code: "param_ignored", field: "model" }],
      argKeys: ["name", "model"],
      at: "2026-03-02T00:00:00.000Z"
    }),
    event({
      id: "z2",
      tool: "llm_switch",
      ok: false,
      errorClass: "unknown",
      errorSummary: "trace 91ab34cd not found",
      signals: [{ code: "param_ignored", field: "model" }],
      argKeys: ["name"],
      at: "2026-03-02T00:00:00.000Z"
    }),
    event({ id: "z3", tool: "figma_export_brief", family: "figma", durationMs: 30 }),
    event({ id: "z4", tool: "pen_inspect", family: "pen", durationMs: 5 })
  ];
  const reversed = [...events].reverse();
  assert.deepEqual(usageSummary(reversed), usageSummary(events));
  assert.deepEqual(usageSignals(reversed), usageSignals(events));
  assert.deepEqual(
    usageEvents(reversed).map((entry) => entry.id),
    usageEvents(events).map((entry) => entry.id)
  );
  assert.deepEqual(
    usageEvents(reversed).map((entry) => entry.id),
    ["z2", "z1", "z4", "z3"]
  );
});
