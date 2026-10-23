import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compareParityDocs, readParityDoc } from "../dist/figma/parity.js";
import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject } from "./helpers.js";

function makeDoc(overrides = {}) {
  return {
    designFingerprint: "design-1",
    flowsFingerprint: "flows-1",
    flows: [
      {
        id: "case-1",
        semanticId: "sem-1",
        displayId: "TC_1",
        name: "Home → Checkout",
        screens: ["Home", "Checkout"],
        humanSteps: ["点击「购买」"],
        steps: ["点击「购买」（设计元素：CTA）"],
        preconditions: ["已登录"],
        expectations: [{ screen: "Checkout", hints: ["支付"], kind: "assert" }],
        testData: [],
        section: "Home",
        module: "购买",
        taskDesc: "android task",
        ...overrides
      }
    ]
  };
}

function writeDoc(dir, name, doc) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

test("parity: 忽略机器层差异，人类层一致即通过", () => {
  const dir = makeTempDir("aos-parity-");
  const a = readParityDoc(writeDoc(dir, "a.json", makeDoc()));
  const b = readParityDoc(
    writeDoc(
      dir,
      "b.json",
      makeDoc({
        steps: ["点击「购买」（design element: CTA；a11y: buy）"],
        taskDesc: "ios task",
        displayId: "TC_1"
      })
    )
  );
  const report = compareParityDocs(a, b);
  assert.equal(report.ok, true);
  assert.deepEqual(report.diffs, []);
});

test("parity: 人类步骤/预期/屏幕差异与缺失用例可见", () => {
  const dir = makeTempDir("aos-parity-diff-");
  const a = readParityDoc(writeDoc(dir, "a.json", makeDoc()));
  const b = readParityDoc(
    writeDoc(
      dir,
      "b.json",
      makeDoc({ humanSteps: ["点击「立即购买」"], screens: ["Home"] })
    )
  );
  const report = compareParityDocs(a, b);
  assert.equal(report.ok, false);
  assert.ok(report.diffs.some((diff) => diff.field === "humanSteps"));
  assert.ok(report.diffs.some((diff) => diff.field === "screens"));

  const missingDoc = makeDoc();
  missingDoc.flows = [];
  const missing = readParityDoc(writeDoc(dir, "missing.json", missingDoc));
  assert.equal(compareParityDocs(a, missing).diffs.some((diff) => diff.kind === "missing"), true);
});

test("parity: design/flows 指纹不一致单独报告", () => {
  const dir = makeTempDir("aos-parity-fp-");
  const a = readParityDoc(writeDoc(dir, "a.json", makeDoc()));
  const b = readParityDoc(
    writeDoc(dir, "b.json", { ...makeDoc(), designFingerprint: "design-2", flowsFingerprint: "flows-2" })
  );
  const report = compareParityDocs(a, b);
  assert.equal(report.ok, false);
  assert.ok(report.diffs.some((diff) => diff.field === "designFingerprint"));
  assert.ok(report.diffs.some((diff) => diff.field === "flowsFingerprint"));
});

test("suite parity CLI: JSON 报告与退出码", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { store: new MemoryStore() });
  const a = writeDoc(dir, "a.json", makeDoc());
  const b = writeDoc(dir, "b.json", makeDoc({ humanSteps: ["点击「立即购买」"] }));
  const logs = [];
  const code = await runSuiteCommand(["parity", "--a", a, "--b", b, "--json"], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: () => {}
  });
  assert.equal(code, 1);
  const report = JSON.parse(logs.join("\n"));
  assert.equal(report.ok, false);
});

test("parity: reconciliation / generation 参数不同报告 profile 差异", () => {
  const dir = makeTempDir("aos-parity-profile-");
  const a = readParityDoc(writeDoc(dir, "a.json", { ...makeDoc(), reconciliationFingerprint: "r-a", generation: { maxFlows: 24, maxDepth: 30 } }));
  const b = readParityDoc(writeDoc(dir, "b.json", { ...makeDoc(), reconciliationFingerprint: null, generation: { maxFlows: 10, maxDepth: 30 } }));
  const report = compareParityDocs(a, b);
  assert.equal(report.ok, false);
  assert.ok(report.diffs.some((diff) => diff.kind === "profile" && diff.field === "reconciliationFingerprint"));
  assert.ok(report.diffs.some((diff) => diff.kind === "profile" && diff.field === "generation"));
});

test("parity: semanticId 重复时显式报告 duplicate，不静默合并", () => {
  const dir = makeTempDir("aos-parity-dup-");
  const doc = makeDoc();
  doc.flows.push({ ...makeDoc().flows[0], id: "case-2", name: "第二条同路径用例" });
  const a = readParityDoc(writeDoc(dir, "a.json", doc));
  const b = readParityDoc(writeDoc(dir, "b.json", doc));
  const report = compareParityDocs(a, b);
  assert.equal(report.ok, false);
  assert.ok(report.diffs.some((diff) => diff.kind === "duplicate"));
});

test("parity: tests.json 与同目录 flows.json 指纹不一致报告 stale", () => {
  const dir = makeTempDir("aos-parity-stale-");
  fs.writeFileSync(
    path.join(dir, "flows.json"),
    JSON.stringify({
      screens: [{ id: "s1", name: "Home", childNames: [], textHints: [] }],
      edges: [],
      entryScreens: ["Home"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const a = readParityDoc(writeDoc(dir, "a.json", { ...makeDoc(), flowsFingerprint: "old-fp" }));
  const b = readParityDoc(writeDoc(dir, "b.json", { ...makeDoc(), flowsFingerprint: "old-fp" }));
  const report = compareParityDocs(a, b);
  assert.equal(report.ok, false);
  assert.ok(report.diffs.some((diff) => diff.field === "flowsFingerprintStale"));
});
