import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { latestFeatures } from "../dist/workflow/case-selection.js";
import { projectArchive } from "../dist/workflow/project-archive.js";

const LLM_ENTRY = {
  name: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-123456"
};

const READINESS = {
  figma: { ready: false, missing: ["FIGMA_ACCESS_TOKEN"], detail: "缺 FIGMA_ACCESS_TOKEN", verified: false },
  pen: { ready: false, detail: "未检测到 pen 配置", verified: false },
  jira: { ready: false, missing: ["JIRA_BASE_URL"], site: null, email: null, detail: "缺 JIRA_BASE_URL", verified: false },
  llm: {
    ready: false,
    missing: [],
    name: null,
    model: null,
    baseUrl: null,
    key: null,
    detail: "未配置",
    verified: false
  },
  degraded: []
};

const FLOWS_FIXTURE = {
  fileKey: "abc123",
  screens: [
    { id: "s1", name: "首页", provenance: "explicit" },
    { id: "s2", name: "登录页" },
    { id: "s3", name: "订单", provenance: "inferred" }
  ],
  edges: [
    {
      from: { id: "s1", name: "首页" },
      to: { id: "s2", name: "登录页" },
      element: { id: "e1", name: "登录", type: "button" },
      trigger: "tap",
      actionType: "navigate",
      provenance: "explicit"
    },
    {
      from: { id: "s2", name: "登录页" },
      to: null,
      element: { id: "e2", name: "帮助", type: "button" },
      trigger: "tap",
      actionType: "unknown"
    }
  ],
  entryScreens: ["首页"],
  unresolvedDestinations: []
};

let dirCounter = 0;

function tempDir() {
  dirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `aos-archive-${process.pid}-${dirCounter}-`));
}

function stubRuntime(dir, { storeKind = "postgres", entry = LLM_ENTRY, jira } = {}) {
  return {
    configDirAbs: dir,
    project: { rootDir: dir, dotenvValues: {} },
    store: { kind: storeKind },
    async activeEntry() {
      return entry;
    },
    jiraConfig: () =>
      jira ?? { configured: false, missing: ["JIRA_BASE_URL"], siteUrl: null, email: null, apiToken: null }
  };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function baseDeps(overrides = {}) {
  return {
    listCaseSets: async () => [],
    listRuns: async () => [],
    readiness: async () => READINESS,
    ...overrides
  };
}

function writeFlows(dir, payload) {
  const design = path.join(dir, "design");
  fs.mkdirSync(design, { recursive: true });
  const file = path.join(design, "flows.json");
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function writeManifest(dir, name, content) {
  const runsDir = path.join(dir, "design", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function manifestFixture(runId, overrides = {}) {
  return {
    schemaVersion: 1,
    runId,
    source: "suite-run",
    startedAt: "2026-10-17T10:00:00.000Z",
    finishedAt: "2026-10-17T10:05:00.000Z",
    ok: true,
    error: null,
    tests: { path: "/p/a.json", sha256: null, generatedAt: null },
    options: {},
    preflight: null,
    apiErrorCatalog: null,
    summary: { total: 2, executed: 2, skipped: 0, passed: 1, failed: 1, flaky: 0, quarantinedFailed: 0 },
    gate: { result: "fail", exitCode: 1, reasons: [] },
    failureDomains: { environment: 1 },
    cases: [],
    ...overrides
  };
}

function featureRecord(jsonPath, overrides = {}) {
  return {
    key: "f-a",
    name: "登录",
    caseCount: 2,
    screens: ["首页"],
    jsonPath,
    mdPath: jsonPath.replace(/\.json$/, ".md"),
    xlsxPath: jsonPath.replace(/\.json$/, ".xlsx"),
    ...overrides
  };
}

function caseSetRecord(source, createdAt, features) {
  return {
    id: `set-${createdAt}`,
    projectId: null,
    createdAt,
    source,
    designName: null,
    fingerprint: null,
    basename: "basename",
    features
  };
}

function verdictCase(overrides = {}) {
  return {
    caseId: "c1",
    name: "用例c1",
    featureKey: "f-a",
    platform: "android",
    status: "failed",
    traceId: "t1",
    verdict: null,
    verdictAt: null,
    verdictNote: null,
    jiraIssueKey: null,
    ...overrides
  };
}

function runRecord(overrides = {}) {
  return {
    id: "run-1",
    createdAt: "2026-10-17T00:00:00.000Z",
    caseSetId: "set-1",
    featureKey: "f-a",
    featureName: "登录",
    platform: "android",
    device: "dev-1",
    cases: [],
    ...overrides
  };
}

function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

test("project_archive: 空项目 → 全段空态、degraded 空、readiness 注入回显", async () => {
  const dir = tempDir();
  const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.project, { name: path.basename(dir), root: dir, stacks: [] });
  assert.equal(payload.design, null);
  assert.deepEqual(payload.caseSets, {
    total: 0,
    imported: 0,
    generated: 0,
    features: 0,
    truncated: false,
    latest: []
  });
  assert.deepEqual(payload.runs, { total: 0, unreadable: 0, recent: [] });
  assert.deepEqual(payload.verdicts, {
    runsScanned: 0,
    caseDefects: 0,
    environment: 0,
    appDefects: 0,
    jiraKeys: 0
  });
  assert.deepEqual(payload.readiness, READINESS);
  assert.deepEqual(payload.degraded, []);
});

test("project_archive: deps.readiness 缺省 → staticReadiness 生效（llm 段反映 activeEntry）", async () => {
  const dir = tempDir();
  const deps = baseDeps();
  delete deps.readiness;
  const payload = payloadOf(await projectArchive(stubRuntime(dir, { entry: null }), deps));
  assert.equal(payload.readiness.llm.ready, false);
  assert.equal(payload.readiness.llm.detail, "未配置（aos_configure / 项目 .env）");
});

test("project_archive: 设计血统（来源/落盘时间/屏边数/provenance 构成）", async () => {
  const dir = tempDir();
  const flowsPath = writeFlows(dir, FLOWS_FIXTURE);
  const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));
  assert.deepEqual(payload.design, {
    source: "figma:abc123",
    savedAt: fs.statSync(flowsPath).mtime.toISOString(),
    screens: 3,
    edges: 2,
    entryScreens: 1,
    unresolved: 0,
    provenance: {
      screens: { explicit: 1, "legacy-unknown": 1, inferred: 1 },
      edges: { explicit: 1, "legacy-unknown": 1 }
    },
    warnings: { available: false, total: 0, byCode: {}, codes: [], stale: false }
  });
});

test("project_archive: design.warnings 摘要", async () => {
  const dir = tempDir();
  const flowsPath = writeFlows(dir, {
    ...FLOWS_FIXTURE,
    warnings: [
      { code: "pen-no-interactions", message: "未检测到原型交互" },
      { code: "pen-no-interactions", message: "另一屏同样未检测到原型交互" },
      { code: "screenshot-missing", message: "屏幕截图缺失" }
    ]
  });
  const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));
  assert.deepEqual(payload.design.warnings, {
    available: true,
    total: 3,
    byCode: { "pen-no-interactions": 2, "screenshot-missing": 1 },
    codes: ["pen-no-interactions", "screenshot-missing"],
    snapshotAt: fs.statSync(flowsPath).mtime.toISOString(),
    stale: false
  });
});

test("project_archive: 坏 flows.json → design null＋degraded", async () => {
  const dir = tempDir();
  const design = path.join(dir, "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(path.join(design, "flows.json"), "{not json");
  const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));
  assert.equal(payload.design, null);
  assert.deepEqual(payload.degraded, ["flows.json 存在但不可解析（已略过设计血统）"]);
});

test("project_archive: pen 源 flows → design.source=pen:<path>", async () => {
  const dir = tempDir();
  const { fileKey, ...rest } = FLOWS_FIXTURE;
  writeFlows(dir, { ...rest, source: "pen:design/app.pen" });
  const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));
  assert.equal(payload.design.source, "pen:design/app.pen");
  assert.equal(payload.design.screens, 3);
});

test("project_archive: 批次清单（字段回显；坏件计 unreadable；非 run-* 不计）", async () => {
  const dir = tempDir();
  writeManifest(
    dir,
    "run-20261018T000003-c.json",
    manifestFixture("run-c", { gate: { result: "pass", exitCode: 0, reasons: [] } })
  );
  writeManifest(dir, "run-20261018T000002-b.json", manifestFixture("run-b"));
  writeManifest(dir, "run-20261018T000001-a.json", "{broken");
  writeManifest(dir, "not-a-manifest.json", manifestFixture("run-x"));
  writeManifest(dir, "run-20261018T000004-d.json", manifestFixture("run-d", { schemaVersion: 99 }));
  writeManifest(dir, "run-20261018T000000-e.json", manifestFixture("run-e", { failureDomains: undefined }));

  const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));
  assert.equal(payload.runs.total, 5);
  assert.equal(payload.runs.unreadable, 3);
  assert.equal(payload.runs.recent.length, 2);
  assert.deepEqual(payload.runs.recent[0], {
    runId: "run-c",
    source: "suite-run",
    startedAt: "2026-10-17T10:00:00.000Z",
    finishedAt: "2026-10-17T10:05:00.000Z",
    total: 2,
    passed: 1,
    failed: 1,
    gate: "pass",
    exitCode: 0,
    failureDomains: { environment: 1 }
  });
  assert.equal(payload.runs.recent[1].runId, "run-b");
  assert.equal(payload.runs.recent[1].gate, "fail");
});

test("project_archive: 用例库（导入/生成/truncated）＋与 latestFeatures 交叉锁定", async () => {
  const dir = tempDir();
  const sets = [
    caseSetRecord("figma:x", "2026-10-17T00:00:00.000Z", [featureRecord("/p/a.json")]),
    caseSetRecord("imported:qa.xlsx@1234abcd", "2026-10-16T00:00:00.000Z", [
      featureRecord("/p/old.json", { key: "f-a", name: "登录旧" }),
      featureRecord("/p/b.json", { key: "imp-b", name: "账户", caseCount: 3 })
    ])
  ];
  const payload = payloadOf(
    await projectArchive(stubRuntime(dir), baseDeps({ listCaseSets: async () => sets }))
  );
  assert.deepEqual(payload.caseSets, {
    total: 2,
    imported: 1,
    generated: 1,
    features: 2,
    truncated: false,
    latest: [
      { feature: "登录", cases: 2, provenance: "生成自 figma:x", createdAt: "2026-10-17T00:00:00.000Z" },
      { feature: "账户", cases: 3, provenance: "导入自 qa.xlsx@1234abcd", createdAt: "2026-10-16T00:00:00.000Z" }
    ]
  });
  const expected = latestFeatures(sets).map((entry) => ({
    feature: entry.feature,
    cases: entry.cases,
    provenance: entry.provenance
  }));
  const actual = payload.caseSets.latest.map(({ feature, cases, provenance }) => ({
    feature,
    cases,
    provenance
  }));
  assert.deepEqual(actual, expected, "latest 与 latestFeatures 口径一致");

  const many = Array.from({ length: 200 }, (_, index) =>
    caseSetRecord(`figma:${index}`, `2026-10-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`, [
      featureRecord(`/p/${index}.json`, { key: `f-${index}`, name: `F${index}` })
    ])
  );
  const bigPayload = payloadOf(
    await projectArchive(stubRuntime(dir), baseDeps({ listCaseSets: async () => many }))
  );
  assert.equal(bigPayload.caseSets.truncated, true);
  assert.equal(bigPayload.caseSets.latest.length, 10);
});

test("project_archive: 裁决与 Jira（含无 verdict 的自动关联 key）", async () => {
  const dir = tempDir();
  const runs = [
    runRecord({
      id: "run-1",
      createdAt: "2026-10-17T00:00:00.000Z",
      cases: [
        verdictCase({
          caseId: "c1",
          verdict: "app-defect",
          verdictAt: "2026-10-17T00:00:00.000Z",
          jiraIssueKey: "AOS-1"
        }),
        verdictCase({ caseId: "c2", verdict: "case-defect", verdictAt: "2026-10-17T00:00:00.000Z" }),
        verdictCase({ caseId: "c3", status: "passed", verdict: null, jiraIssueKey: "AOS-9" })
      ]
    }),
    runRecord({
      id: "run-2",
      createdAt: "2026-10-16T00:00:00.000Z",
      cases: [
        verdictCase({
          caseId: "c4",
          verdict: "execution-deviation",
          verdictAt: "2026-10-16T00:00:00.000Z",
          jiraIssueKey: "AOS-1"
        })
      ]
    })
  ];
  const payload = payloadOf(
    await projectArchive(stubRuntime(dir), baseDeps({ listRuns: async () => runs }))
  );
  assert.deepEqual(payload.verdicts, {
    runsScanned: 2,
    caseDefects: 1,
    environment: 1,
    appDefects: 1,
    jiraKeys: 2
  });
});

test("project_archive: store 抛错 → 对应段 null＋degraded，其余照常 ok:true", async () => {
  const dir = tempDir();
  const payload = payloadOf(
    await projectArchive(
      stubRuntime(dir),
      baseDeps({
        listCaseSets: async () => {
          throw new Error("pg down");
        },
        listRuns: async () => {
          throw new Error("pg down");
        }
      })
    )
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.caseSets, null);
  assert.equal(payload.verdicts, null);
  assert.deepEqual(payload.degraded, ["用例库读取降级：pg down", "裁决摘要读取降级：pg down"]);
});

test("project_archive: 内存 store 降级 → degraded 明示且数据不丢", async () => {
  const dir = tempDir();
  const sets = [caseSetRecord("figma:x", "2026-10-17T00:00:00.000Z", [featureRecord("/p/a.json")])];
  const payload = payloadOf(
    await projectArchive(
      stubRuntime(dir, { storeKind: "memory" }),
      baseDeps({ listCaseSets: async () => sets })
    )
  );
  assert.equal(payload.caseSets.total, 1);
  assert.deepEqual(payload.degraded, [
    "登记读自会话内存（未配置持久台账），用例库/裁决数据可能不完整"
  ]);
});

test("project_archive: 只读——禁网＋目录快照不变", async () => {
  const dir = tempDir();
  writeFlows(dir, FLOWS_FIXTURE);
  writeManifest(dir, "run-20261018T000001-a.json", manifestFixture("run-a"));
  const before = snapshot(dir);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("测试禁网");
  };
  try {
    const payload = payloadOf(await projectArchive(stubRuntime(dir), baseDeps()));
    assert.equal(payload.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(snapshot(dir), before);
});
