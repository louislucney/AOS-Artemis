import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mergeWarnings,
  normalizeWarnings,
  readFlowsWarnings,
  readTestsWarnings,
  resolveDesignWarnings,
  summarizeWarnings
} from "../dist/design/warnings.js";

function tempConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-design-warnings-"));
  fs.mkdirSync(path.join(dir, "design"), { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test("normalizeWarnings: preserves valid screen/case scope, drops invalid", () => {
  const warnings = normalizeWarnings([
    {
      code: "scoped",
      message: "m",
      scope: { screens: ["Home", "", 1], caseIds: ["case-1", null] }
    },
    { code: "bad-scope", message: "m", scope: "bad" },
    { code: "empty-scope", message: "m", scope: { screens: [] } }
  ]);
  assert.deepEqual(warnings[0].scope, { screens: ["Home"], caseIds: ["case-1"] });
  assert.equal(warnings[1].scope, undefined);
  assert.equal(warnings[2].scope, undefined);
});

test("readFlowsWarnings: 读取数组并丢弃坏条目", () => {
  const dir = tempConfigDir();
  try {
    const flowsPath = path.join(dir, "design", "flows.json");
    writeJson(flowsPath, {
      warnings: [{ code: "pen-no-interactions", message: "x" }, { bad: true }]
    });
    const read = readFlowsWarnings(dir);
    assert.equal(read.available, true);
    assert.equal(read.warnings.length, 1);
    assert.equal(read.warnings[0].code, "pen-no-interactions");
    assert.equal(read.warnings[0].message, "x");
    assert.ok(read.snapshotAt, "snapshotAt should be present");
    assert.ok(!Number.isNaN(Date.parse(read.snapshotAt)), `snapshotAt should be ISO: ${read.snapshotAt}`);

    const missing = readFlowsWarnings(tempConfigDir());
    assert.deepEqual(missing, { warnings: [], snapshotAt: null, available: false });

    const broken = tempConfigDir();
    fs.writeFileSync(path.join(broken, "design", "flows.json"), "{not-json");
    assert.deepEqual(readFlowsWarnings(broken), { warnings: [], snapshotAt: null, available: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDesignWarnings: tests 快照优先，flows 回退，缺省 none", () => {
  const both = tempConfigDir();
  const flowsOnly = tempConfigDir();
  const none = tempConfigDir();
  const custom = tempConfigDir();
  try {
    writeJson(path.join(both, "design", "flows.json"), {
      warnings: [{ code: "flow-warn", message: "f" }]
    });
    writeJson(path.join(both, "design", "tests.json"), {
      designWarnings: [{ code: "test-warn", message: "t" }]
    });
    const testsRead = readTestsWarnings(both);
    assert.equal(testsRead.available, true);
    assert.deepEqual(testsRead.warnings.map((warning) => warning.code), ["test-warn"]);

    const preferred = resolveDesignWarnings(both);
    assert.equal(preferred.source, "tests");
    assert.deepEqual(preferred.warnings.map((warning) => warning.code), ["test-warn"]);
    assert.equal(preferred.summary.available, true);
    assert.equal(preferred.summary.total, 1);
    assert.equal(preferred.summary.snapshotAt, preferred.snapshotAt);
    assert.equal(preferred.stale, false);

    const flowsPreferred = resolveDesignWarnings(both, { prefer: "flows" });
    assert.equal(flowsPreferred.source, "flows");
    assert.deepEqual(flowsPreferred.warnings.map((warning) => warning.code), ["flow-warn"]);

    writeJson(path.join(flowsOnly, "design", "flows.json"), {
      warnings: [{ code: "flow-warn", message: "f" }]
    });
    const fallback = resolveDesignWarnings(flowsOnly);
    assert.equal(fallback.source, "flows");
    assert.deepEqual(fallback.warnings.map((warning) => warning.code), ["flow-warn"]);

    const testsPath = path.join(custom, "custom-tests.json");
    writeJson(testsPath, { designWarnings: [{ code: "custom-warn", message: "c" }] });
    const customRead = resolveDesignWarnings(custom, { testsPath });
    assert.equal(customRead.source, "tests");
    assert.deepEqual(customRead.warnings.map((warning) => warning.code), ["custom-warn"]);

    const missing = resolveDesignWarnings(none);
    assert.equal(missing.source, "none");
    assert.equal(missing.snapshotAt, null);
    assert.equal(missing.stale, false);
    assert.deepEqual(missing.warnings, []);
    assert.equal(missing.summary.available, false);
    assert.equal(missing.summary.total, 0);
    assert.deepEqual(missing.summary.codes, []);
  } finally {
    for (const dir of [both, flowsOnly, none, custom]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("resolveDesignWarnings: 缺少字段视为不可用，显式空数组才是 0 条", () => {
  const missingField = tempConfigDir();
  const emptySnapshot = tempConfigDir();
  const flowsNoWarnings = tempConfigDir();
  try {
    writeJson(path.join(missingField, "design", "flows.json"), {
      warnings: [{ code: "flow-warn", message: "flows 有效" }]
    });
    writeJson(path.join(missingField, "design", "tests.json"), { flows: [] });
    assert.equal(readTestsWarnings(missingField).available, false, "缺 designWarnings 字段不可用");
    const fallback = resolveDesignWarnings(missingField);
    assert.equal(fallback.source, "flows");
    assert.equal(fallback.summary.available, true);
    assert.equal(fallback.summary.total, 1);
    assert.deepEqual(fallback.warnings.map((warning) => warning.code), ["flow-warn"]);

    writeJson(path.join(emptySnapshot, "design", "flows.json"), {
      warnings: [{ code: "flow-warn", message: "flows 有效" }]
    });
    writeJson(path.join(emptySnapshot, "design", "tests.json"), { designWarnings: [] });
    assert.equal(readTestsWarnings(emptySnapshot).available, true, "显式空数组仍可用");
    const explicitEmpty = resolveDesignWarnings(emptySnapshot);
    assert.equal(explicitEmpty.source, "tests");
    assert.equal(explicitEmpty.summary.available, true);
    assert.equal(explicitEmpty.summary.total, 0);

    writeJson(path.join(flowsNoWarnings, "design", "flows.json"), { screens: [] });
    const flows = readFlowsWarnings(flowsNoWarnings);
    assert.equal(flows.available, false, "缺 warnings 字段不可用");
    assert.equal(flows.snapshotAt, null);
    assert.deepEqual(flows.warnings, []);
    const none = resolveDesignWarnings(flowsNoWarnings);
    assert.equal(none.source, "none");
    assert.equal(none.summary.available, false);
  } finally {
    for (const dir of [missingField, emptySnapshot, flowsNoWarnings]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("resolveDesignWarnings: tests 早于 flows 时 stale=true", () => {
  const dir = tempConfigDir();
  try {
    const testsPath = path.join(dir, "design", "tests.json");
    const flowsPath = path.join(dir, "design", "flows.json");
    writeJson(testsPath, { designWarnings: [{ code: "test-warn", message: "t" }] });
    writeJson(flowsPath, { warnings: [{ code: "flow-warn", message: "f" }] });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(flowsPath, future, future);

    const stale = resolveDesignWarnings(dir);
    assert.equal(stale.source, "tests");
    assert.equal(stale.stale, true);
    assert.equal(stale.summary.stale, true);

    const freshFlows = resolveDesignWarnings(dir, { prefer: "flows" });
    assert.equal(freshFlows.source, "flows");
    assert.equal(freshFlows.stale, false);

    const base = Date.now();
    const flowsTime = new Date(base + 60_000);
    const testsTime = new Date(base + 120_000);
    fs.utimesSync(flowsPath, flowsTime, flowsTime);
    fs.utimesSync(testsPath, testsTime, testsTime);
    const fresh = resolveDesignWarnings(dir);
    assert.equal(fresh.source, "tests");
    assert.equal(fresh.stale, false, "tests 快照晚于 flows 时不算陈旧");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWarnings: code+message 去重、稳定序、bySource 计数", () => {
  const merged = mergeWarnings([
    {
      source: "flows",
      warnings: [
        { code: "a", message: "m1" },
        { code: "b", message: "m2" }
      ]
    },
    {
      source: "tests",
      warnings: [
        { code: "b", message: "m2", details: ["duplicate"] },
        { code: "b", message: "different-message" },
        { code: "c", message: "m3" }
      ]
    }
  ]);
  assert.deepEqual(
    merged.warnings.map((warning) => `${warning.code}:${warning.message}`),
    ["a:m1", "b:m2", "b:different-message", "c:m3"]
  );
  assert.equal(merged.warnings[1].details, undefined, "首次出现的条目胜出");
  assert.deepEqual(merged.bySource, { flows: 2, tests: 2 });
  assert.equal(
    Object.values(merged.bySource).reduce((total, count) => total + count, 0),
    merged.warnings.length,
    "bySource 各来源计数之和应等于去重后总数"
  );

  const empty = mergeWarnings([{ source: "flows", warnings: [] }, { source: "tests", warnings: [] }]);
  assert.deepEqual(empty.warnings, []);
  assert.deepEqual(empty.bySource, { flows: 0, tests: 0 });
});

test("summarizeWarnings: total/byCode/codes", () => {
  const summary = summarizeWarnings(
    [
      { code: "b", message: "1" },
      { code: "a", message: "2" },
      { code: "b", message: "3" }
    ],
    { snapshotAt: "2026-01-01T00:00:00.000Z", stale: true }
  );
  assert.equal(summary.available, true);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byCode, { b: 2, a: 1 });
  assert.deepEqual(summary.codes, ["b", "a"]);
  assert.equal(summary.snapshotAt, "2026-01-01T00:00:00.000Z");
  assert.equal(summary.stale, true);

  assert.deepEqual(summarizeWarnings([]), {
    available: true,
    total: 0,
    byCode: {},
    codes: []
  });
});
