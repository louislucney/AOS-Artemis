import assert from "node:assert/strict";
import test from "node:test";

import {
  alignFeatureRuns,
  normalizeDesignSource,
  normalizeFeatureName
} from "../dist/panel/feature-alignment.js";

function makeRun(overrides = {}) {
  return {
    caseSetId: "set-1",
    featureKey: "f-1",
    featureName: "登录流程",
    passed: 0,
    total: 0,
    flaky: 0,
    finishedAt: "2026-10-01T00:00:00.000Z",
    cases: [],
    ...overrides
  };
}

function makeSet(id, source, features) {
  return { id, source, features };
}

function makeProject(name, rootPath, { runs = [], sets = null } = {}) {
  return { name, rootPath, runs, sets };
}

function featureProject(name, features) {
  const sets = [];
  const runs = [];
  features.forEach((feature, index) => {
    const setId = `${name}-set-${index}`;
    const featureKey = `${name}-key-${index}`;
    sets.push(makeSet(setId, feature.source, [{ key: featureKey, name: feature.name }]));
    runs.push(
      makeRun({
        caseSetId: setId,
        featureKey,
        featureName: feature.name,
        passed: feature.passed ?? 0,
        total: feature.total ?? 0,
        finishedAt: feature.finishedAt ?? "2026-10-01T00:00:00.000Z"
      })
    );
  });
  return makeProject(name, `/work/${name.toLowerCase()}`, { runs, sets });
}

test("normalizeDesignSource strips the figma decoration and keeps the file key", () => {
  assert.equal(normalizeDesignSource("figma:ABC123 (登录流程.fig)", "/work/a"), "figma:ABC123");
  assert.equal(normalizeDesignSource("figma:ABC123", "/work/a"), "figma:ABC123");
  assert.equal(
    normalizeDesignSource("figma:ABC123 (登录流程.fig)", "/work/a"),
    normalizeDesignSource("figma:ABC123 (交付版.fig)", "/work/b")
  );
});

test("normalizeDesignSource relativizes absolute paths against the project root", () => {
  assert.equal(
    normalizeDesignSource("/work/a/.artemis/design/Flows.JSON", "/work/a"),
    ".artemis/design/flows.json"
  );
  assert.equal(
    normalizeDesignSource("/work/a/.artemis/design/flows.json", "/work/a"),
    normalizeDesignSource("/work/b/.artemis/design/flows.json", "/work/b")
  );
});

test("normalizeDesignSource keeps separator-bearing relative paths independent of root", () => {
  assert.equal(
    normalizeDesignSource(".artemis/design/flows.json", "/work/a"),
    ".artemis/design/flows.json"
  );
  assert.equal(
    normalizeDesignSource(".artemis/design/Flows.JSON", "/work/b"),
    ".artemis/design/flows.json"
  );
  assert.equal(
    normalizeDesignSource(".artemis/design/flows.json", "/work/a"),
    normalizeDesignSource(".artemis/design/flows.json", "/work/b")
  );
  assert.equal(normalizeDesignSource("Sub\\Login.pen", "/work/a"), "sub/login.pen");
});

test("normalizeDesignSource keeps out-of-root and cross-drive paths as lowercased originals", () => {
  assert.equal(normalizeDesignSource("/Other/Flows.JSON", "/work/a"), "/other/flows.json");
  assert.equal(
    normalizeDesignSource("C:\\Other\\Flows.JSON", "D:\\proj"),
    "c:\\other\\flows.json"
  );
});

test("normalizeDesignSource normalizes pen sources even when they carry separators", () => {
  assert.equal(normalizeDesignSource("pen:Sub\\Login.PEN", "/work/a"), "pen:sub/login.pen");
  assert.equal(normalizeDesignSource("pen:Sub/Login.PEN", "/work/a"), "pen:sub/login.pen");
  assert.equal(normalizeDesignSource("pen: Sub/Login.PEN", "/work/a"), "pen:sub/login.pen");
  assert.notEqual(
    normalizeDesignSource("pen:sub/login.pen", "/work/a"),
    normalizeDesignSource("/work/a/sub/login.pen", "/work/a")
  );
});

test("normalizeDesignSource lowercases unknown forms and never matches url against path", () => {
  assert.equal(normalizeDesignSource("Custom-Source", "/work/a"), "custom-source");
  assert.notEqual(
    normalizeDesignSource("figma:ABC123", "/work/a"),
    normalizeDesignSource("/work/a/.artemis/design/flows.json", "/work/a")
  );
});

test("normalizeFeatureName applies NFC, trim, whitespace folding and lower case", () => {
  assert.equal(normalizeFeatureName("  CAFE\u0301   Flow\tTest  "), "café flow test");
  assert.equal(
    normalizeFeatureName("Café Flow Test"),
    normalizeFeatureName("  CAFE\u0301   Flow\tTest  ")
  );
});

test("normalizeFeatureName leaves CJK content unchanged apart from whitespace folding", () => {
  assert.equal(normalizeFeatureName("登录流程"), "登录流程");
  assert.equal(normalizeFeatureName("  登录   流程  "), "登录 流程");
});

test("alignFeatureRuns groups same-source same-name features across projects", () => {
  const alpha = makeProject("alpha", "/work/alpha", {
    sets: [
      makeSet("a-set", "/work/alpha/.artemis/design/flows.json", [
        { key: "a-key", name: "Login Flow" }
      ])
    ],
    runs: [
      makeRun({
        caseSetId: "a-set",
        featureKey: "a-key",
        featureName: "Login Flow",
        passed: 4,
        total: 8,
        flaky: 1,
        finishedAt: "2026-10-01T02:00:00.000Z",
        cases: [
          { status: "passed", verdict: null },
          { status: "failed", verdict: "app-defect" },
          { status: "failed", verdict: null },
          { status: "error", verdict: null }
        ]
      })
    ]
  });
  const bravo = makeProject("bravo", "/work/bravo", {
    sets: [
      makeSet("b-set", "/work/bravo/.artemis/design/flows.json", [
        { key: "b-key", name: "  login   FLOW " }
      ])
    ],
    runs: [
      makeRun({
        caseSetId: "b-set",
        featureKey: "b-key",
        featureName: "  login   FLOW ",
        finishedAt: "2026-10-03T00:00:00.000Z"
      })
    ]
  });

  const { groups, unmatched } = alignFeatureRuns([bravo, alpha]);

  assert.equal(unmatched, 0);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sourceLabel, "/work/alpha/.artemis/design/flows.json");
  assert.equal(groups[0].displayName, "Login Flow");
  assert.deepEqual(groups[0].entries, [
    {
      project: "alpha",
      featureKey: "a-key",
      passRate: 0.5,
      runs: 1,
      flaky: 1,
      pendingVerdicts: 2,
      latestAt: "2026-10-01T02:00:00.000Z"
    },
    {
      project: "bravo",
      featureKey: "b-key",
      passRate: null,
      runs: 1,
      flaky: 0,
      pendingVerdicts: 0,
      latestAt: "2026-10-03T00:00:00.000Z"
    }
  ]);
});

test("alignFeatureRuns reports single-project keys as unmatched without grouping", () => {
  const solo = makeProject("solo", "/work/solo", {
    sets: [makeSet("s", "figma:KEY", [{ key: "k", name: "登录流程" }])],
    runs: [makeRun({ caseSetId: "s", featureKey: "k" })]
  });

  const { groups, unmatched } = alignFeatureRuns([solo]);

  assert.deepEqual(groups, []);
  assert.equal(unmatched, 1);
});

test("alignFeatureRuns keeps the same name under different sources apart", () => {
  const one = makeProject("one", "/work/one", {
    sets: [makeSet("s1", "figma:ONE", [{ key: "k1", name: "登录流程" }])],
    runs: [makeRun({ caseSetId: "s1", featureKey: "k1" })]
  });
  const two = makeProject("two", "/work/two", {
    sets: [makeSet("s2", "figma:TWO", [{ key: "k2", name: "登录流程" }])],
    runs: [makeRun({ caseSetId: "s2", featureKey: "k2" })]
  });

  const { groups, unmatched } = alignFeatureRuns([one, two]);

  assert.deepEqual(groups, []);
  assert.equal(unmatched, 2);
});

test("alignFeatureRuns keeps different names under the same source apart", () => {
  const one = makeProject("one", "/work/one", {
    sets: [makeSet("s1", "figma:ONE", [{ key: "k1", name: "登录流程" }])],
    runs: [makeRun({ caseSetId: "s1", featureKey: "k1" })]
  });
  const two = makeProject("two", "/work/two", {
    sets: [makeSet("s2", "figma:ONE", [{ key: "k2", name: "注册流程" }])],
    runs: [makeRun({ caseSetId: "s2", featureKey: "k2" })]
  });

  const { groups, unmatched } = alignFeatureRuns([one, two]);

  assert.deepEqual(groups, []);
  assert.equal(unmatched, 2);
});

test("alignFeatureRuns sums runs of the same feature within a project", () => {
  const alpha = makeProject("alpha", "/work/alpha", {
    sets: [
      makeSet("s", "figma:KEY", [{ key: "k", name: "登录流程" }]),
      makeSet("s9", "figma:KEY", [{ key: "k9", name: "登录流程" }])
    ],
    runs: [
      makeRun({
        caseSetId: "s",
        featureKey: "k",
        passed: 1,
        total: 2,
        flaky: 1,
        finishedAt: "2026-10-01T01:00:00.000Z"
      }),
      makeRun({
        caseSetId: "s",
        featureKey: "k",
        passed: 3,
        total: 4,
        flaky: 2,
        finishedAt: "2026-10-05T00:00:00.000Z",
        cases: [{ status: "failed", verdict: null }]
      }),
      makeRun({
        caseSetId: "s9",
        featureKey: "k9",
        passed: 2,
        total: 2,
        finishedAt: "2026-10-02T00:00:00.000Z"
      })
    ]
  });
  const bravo = makeProject("bravo", "/work/bravo", {
    sets: [makeSet("s2", "figma:KEY", [{ key: "k2", name: "登录流程" }])],
    runs: [makeRun({ caseSetId: "s2", featureKey: "k2" })]
  });

  const { groups, unmatched } = alignFeatureRuns([alpha, bravo]);

  assert.equal(unmatched, 0);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entries[0], {
    project: "alpha",
    featureKey: "k",
    passRate: 6 / 8,
    runs: 3,
    flaky: 3,
    pendingVerdicts: 1,
    latestAt: "2026-10-05T00:00:00.000Z"
  });
});

test("alignFeatureRuns skips unmapped runs without inflating unmatched", () => {
  const alpha = makeProject("alpha", "/work/alpha", {
    sets: [makeSet("s", "figma:KEY", [{ key: "k", name: "登录流程" }])],
    runs: [
      makeRun({ caseSetId: null }),
      makeRun({ featureKey: null }),
      makeRun({ caseSetId: "missing" }),
      makeRun({ caseSetId: "s", featureKey: "ghost", featureName: null }),
      makeRun({ caseSetId: "s", featureKey: "k", passed: 1, total: 2 })
    ]
  });
  const bravo = makeProject("bravo", "/work/bravo", {
    sets: [makeSet("s2", "figma:KEY", [{ key: "k2", name: "登录流程" }])],
    runs: [makeRun({ caseSetId: "s2", featureKey: "k2" })]
  });
  const charlie = makeProject("charlie", "/work/charlie", {
    sets: null,
    runs: [makeRun({ caseSetId: "s", featureKey: "k" })]
  });

  const { groups, unmatched } = alignFeatureRuns([alpha, bravo, charlie]);

  assert.equal(unmatched, 0);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[0].entries[0].project, "alpha");
  assert.equal(groups[0].entries[0].runs, 1);
  assert.equal(groups[0].entries[0].passRate, 0.5);
});

test("alignFeatureRuns falls back to run.featureName when the case set lacks the key", () => {
  const alpha = makeProject("alpha", "/work/alpha", {
    sets: [makeSet("s", "figma:KEY", [{ key: "other", name: "别的流程" }])],
    runs: [makeRun({ caseSetId: "s", featureKey: "k", featureName: "注册流程", passed: 1, total: 1 })]
  });
  const bravo = makeProject("bravo", "/work/bravo", {
    sets: [makeSet("s2", "figma:KEY", [{ key: "z", name: "注册流程" }])],
    runs: [makeRun({ caseSetId: "s2", featureKey: "z", featureName: "注册流程", passed: 1, total: 2 })]
  });

  const { groups, unmatched } = alignFeatureRuns([alpha, bravo]);

  assert.equal(unmatched, 0);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].displayName, "注册流程");
  assert.equal(groups[0].entries.length, 2);
});

test("alignFeatureRuns prefers the frozen case set name over run.featureName", () => {
  const alpha = makeProject("alpha", "/work/alpha", {
    sets: [makeSet("s", "figma:KEY", [{ key: "k", name: "冻结名" }])],
    runs: [makeRun({ caseSetId: "s", featureKey: "k", featureName: "漂移名", passed: 1, total: 1 })]
  });
  const bravo = makeProject("bravo", "/work/bravo", {
    sets: [makeSet("s2", "figma:KEY", [{ key: "z", name: "冻结名" }])],
    runs: [makeRun({ caseSetId: "s2", featureKey: "z", featureName: "冻结名", passed: 1, total: 2 })]
  });

  const { groups } = alignFeatureRuns([alpha, bravo]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].displayName, "冻结名");
});

test("alignFeatureRuns sorts groups by project count, pass rate range, then name", () => {
  const alpha = featureProject("A", [
    { source: "figma:sA", name: "alpha", passed: 1, total: 1 },
    { source: "figma:sB", name: "bravo", passed: 4, total: 4 },
    { source: "figma:sC", name: "charlie", passed: 1, total: 2 },
    { source: "figma:sD", name: "delta" },
    { source: "figma:sE", name: "echo", passed: 1, total: 2 }
  ]);
  const bravo = featureProject("B", [
    { source: "figma:sA", name: "alpha", passed: 1, total: 1 },
    { source: "figma:sB", name: "bravo", passed: 1, total: 2 },
    { source: "figma:sC", name: "charlie", passed: 1, total: 2 },
    { source: "figma:sD", name: "delta" },
    { source: "figma:sE", name: "echo", passed: 1, total: 2 }
  ]);
  const charlie = featureProject("C", [{ source: "figma:sA", name: "alpha", passed: 1, total: 1 }]);

  const { groups, unmatched } = alignFeatureRuns([charlie, bravo, alpha]);

  assert.equal(unmatched, 0);
  assert.deepEqual(
    groups.map((group) => [group.displayName, group.entries.length]),
    [
      ["alpha", 3],
      ["bravo", 2],
      ["charlie", 2],
      ["delta", 2],
      ["echo", 2]
    ]
  );
});
