import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, createImage, loadTestRuntime, makeTempDir, makeTempProject, SuiteProxy, toPng } from "./helpers.js";

function designDir(root) {
  const dir = path.join(root, ".artemis", "design");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeContract(root, screens = [{ id: "home", name: "Home" }]) {
  const dir = designDir(root);
  fs.writeFileSync(
    path.join(dir, "ui-contract.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: { fingerprint: "fp-contract" },
      screens,
      summary: { extracted: screens.length, partial: 0, unverifiable: 0, "no-baseline": 0 },
      warnings: []
    })
  );
  return dir;
}

function writeSemantics(root, regions, extra = {}) {
  const dir = designDir(root);
  const file = {
    version: 1,
    screens: [
      {
        screenId: "home",
        screenName: "Home",
        viewport: { width: 440, height: 956, scale: 3 },
        regions,
        ...extra
      }
    ]
  };
  fs.writeFileSync(path.join(dir, "ui-semantics.json"), JSON.stringify(file));
  return path.join(dir, "ui-semantics.json");
}

function writeSnapshot(root, payload, name = "snapshot.json") {
  const file = path.join(root, ".artemis", "design", name);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function text(value, x = 0, y = 0, visible = true) {
  return { text: value, x, y, width: 100, height: 20, visible };
}

async function withRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({}),
    store: new MemoryStore()
  });
  const run = async (args) => {
    const logs = [];
    const errors = [];
    const code = await runSuiteCommand(args, {
      buildRuntime: async () => ({ runtime, dispose: async () => {} }),
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line)
    });
    return { code, logs, errors, dir, runtime };
  };
  return { dir, runtime, run };
}

test("suite ui-parity: snapshot JSON exit 0 and counts", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["推薦", "咖啡飲品"] }
  ]);
  const snapshot = writeSnapshot(dir, {
    screen: "home",
    viewport: { width: 440, height: 956, scale: 3 },
    texts: [text("推薦"), text("咖啡飲品")]
  });
  const result = await run(["ui-parity", "--snapshot", snapshot, "--json"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  const payload = JSON.parse(result.logs.join("\n"));
  assert.equal(payload.verdict, "layout-compatible");
  assert.equal(payload.counts.invariant, 2);
  assert.equal(payload.counts.matched, 2);
  assert.equal(payload.snapshot.source, "file");
  assert.equal(payload.snapshot.space, "viewport");
});

test("suite ui-parity: infix truncation and zero invariant exit 1", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["每日精選咖啡"] }
  ]);
  const truncation = writeSnapshot(dir, {
    screen: "home",
    texts: [text("每...咖啡")]
  });
  const truncated = await run(["ui-parity", "--snapshot", truncation, "--json"]);
  assert.equal(truncated.code, 1);
  assert.equal(JSON.parse(truncated.logs.join("\n")).verdict, "truncated-labels");

  writeSemantics(dir, [{ id: "category-rail", role: "category-list" }]);
  const empty = await run(["ui-parity", "--snapshot", truncation, "--json"]);
  assert.equal(empty.code, 1);
  assert.equal(JSON.parse(empty.logs.join("\n")).verdict, "no-invariants");
});

test("suite ui-parity: unexpected text is warning but exit 0", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [{ id: "product-list", role: "product-list", invariantTexts: ["推薦"] }]);
  const snapshot = writeSnapshot(dir, {
    screen: "home",
    texts: [text("推薦"), text("多出來的區塊")]
  });
  const result = await run(["ui-parity", "--snapshot", snapshot, "--json"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  const payload = JSON.parse(result.logs.join("\n"));
  assert.equal(payload.counts.unexpected, 1);
  assert.ok(payload.findings.some((finding) => finding.kind === "unexpected-runtime-text"));
});

test("suite ui-parity: usage and precondition errors exit 2", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [{ id: "category-rail", role: "category-list", invariantTexts: ["推薦"] }]);
  const snapshot = writeSnapshot(dir, { screen: "home", texts: [text("推薦")] });

  assert.equal((await run(["ui-parity", "--json"])).code, 2);
  assert.equal((await run(["ui-parity", "--trace", "t1", "--json"])).code, 2);
  assert.equal((await run(["ui-parity", "--snapshot", snapshot, "--screen", "missing", "--json"])).code, 2);
  assert.equal((await run(["ui-parity", "--snapshot", snapshot, "--contract", ".artemis/design/missing.json", "--json"])).code, 2);
  assert.equal((await run(["ui-parity", "--snapshot", snapshot, "--region", "missing", "--json"])).code, 2);

  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "ui-semantics.json"),
    JSON.stringify({
      version: 1,
      screens: [{ screenId: "dead", regions: [{ id: "category-rail", role: "category-list", invariantTexts: ["推薦"] }] }]
    })
  );
  assert.equal((await run(["ui-parity", "--snapshot", snapshot, "--json"])).code, 2);
});

test("suite ui-parity: trace uses content space and screenshot viewport", async () => {
  const { dir, runtime, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    {
      id: "category-rail",
      role: "category-list",
      invariantTexts: ["推薦", "咖啡飲品"]
    }
  ]);
  const traceId = "trace-ui-parity";
  const traceDir = runtime.traceDir(traceId);
  fs.mkdirSync(path.join(traceDir, "shots"), { recursive: true });
  fs.writeFileSync(path.join(traceDir, "shots", "step-2.png"), toPng(createImage(300, 600)));
  fs.writeFileSync(
    path.join(traceDir, "run.json"),
    JSON.stringify({
      steps: [
        {
          step: 2,
          shot: "shots/step-2.png",
          postShot: "shots/step-2.png",
          scale: 2,
          texts: [
            { text: "推薦", x: 10, y: 10, width: 80, height: 20 },
            { text: "咖啡飲品", x: 10, y: 400, width: 80, height: 20 }
          ]
        }
      ]
    })
  );
  const result = await run(["ui-parity", "--trace", traceId, "--step", "2", "--region", "category-rail", "--json"]);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.logs.join("\n"));
  assert.equal(payload.snapshot.source, "trace");
  assert.equal(payload.snapshot.space, "content");
  assert.equal(payload.snapshot.viewport.width, 300);
  assert.equal(payload.snapshot.viewport.height, 600);
  assert.equal(payload.counts.unverified, 1);
  assert.equal(payload.counts.offscreen, 1);
  assert.equal(payload.counts.matched, 0);
});

test("suite ui-parity: baseline update, suppression and new finding", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["推薦", "咖啡飲品"] }
  ]);
  const snapshot = writeSnapshot(dir, { screen: "home", texts: [text("推薦")] });
  const baseline = path.join(dir, ".artemis", "design", "ui-parity-baseline.json");

  const updated = await run([
    "ui-parity", "--snapshot", snapshot, "--region", "category-rail", "--update-baseline", "--json"
  ]);
  assert.equal(updated.code, 1);
  assert.equal(fs.existsSync(baseline), true);

  const suppressed = await run([
    "ui-parity", "--snapshot", snapshot, "--region", "category-rail", "--baseline", baseline, "--json"
  ]);
  assert.equal(suppressed.code, 0, suppressed.errors.join("\n"));
  const suppressedPayload = JSON.parse(suppressed.logs.join("\n"));
  assert.equal(suppressedPayload.baseline.baselined, 1);
  assert.equal(suppressedPayload.findings[0].baselined, true);

  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["推薦", "咖啡飲品", "茶瓦納"] }
  ]);
  const fresh = await run([
    "ui-parity", "--snapshot", snapshot, "--region", "category-rail", "--baseline", baseline, "--json"
  ]);
  assert.equal(fresh.code, 1);
  const freshPayload = JSON.parse(fresh.logs.join("\n"));
  assert.ok(freshPayload.findings.some((finding) => finding.designText === "茶瓦納" && finding.baselined !== true));

  const bad = path.join(dir, ".artemis", "design", "bad-baseline.json");
  fs.writeFileSync(bad, "{broken");
  const badResult = await run([
    "ui-parity", "--snapshot", snapshot, "--baseline", bad, "--json"
  ]);
  assert.equal(badResult.code, 2);
});

test("suite ui-parity: half-screen coverage exits 1 and missing semantics exits 2", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  const invariants = Array.from({ length: 27 }, (_, index) => `分類${index + 1}`);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: invariants }
  ]);
  const snapshot = writeSnapshot(dir, {
    screen: "home",
    texts: invariants.map((value, index) => text(value, 0, index * 20, index < 14))
  });
  const half = await run(["ui-parity", "--snapshot", snapshot, "--json"]);
  assert.equal(half.code, 1);
  const payload = JSON.parse(half.logs.join("\n"));
  assert.equal(payload.verdict, "insufficient-coverage");
  assert.equal(payload.counts.matched, 14);
  assert.equal(payload.counts.offscreen, 13);

  fs.rmSync(path.join(dir, ".artemis", "design", "ui-semantics.json"));
  const missing = await run(["ui-parity", "--snapshot", snapshot, "--json"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("缺少 ui-semantics")));
});

test("suite ui-parity: 300-text trace is content-space and offscreen is not matched", async () => {
  const { dir, runtime, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["text-299"] }
  ]);
  const traceId = "trace-ui-parity-large";
  const traceDir = runtime.traceDir(traceId);
  fs.mkdirSync(path.join(traceDir, "shots"), { recursive: true });
  fs.writeFileSync(path.join(traceDir, "shots", "step-3.png"), toPng(createImage(300, 600)));
  const texts = Array.from({ length: 300 }, (_, index) => ({
    text: `text-${index}`,
    x: 10,
    y: index * 20,
    width: 80,
    height: 20
  }));
  fs.writeFileSync(
    path.join(traceDir, "run.json"),
    JSON.stringify({
      steps: [{ step: 3, shot: "shots/step-3.png", postShot: "shots/step-3.png", scale: 3, texts }]
    })
  );
  const result = await run([
    "ui-parity", "--trace", traceId, "--step", "3", "--region", "category-rail", "--json"
  ]);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.logs.join("\n"));
  assert.equal(payload.snapshot.space, "content");
  assert.equal(payload.snapshot.viewport.width, 300);
  assert.equal(payload.snapshot.viewport.height, 600);
  assert.equal(payload.counts.matched, 0);
  assert.equal(payload.counts.offscreen, 1);
});

test("suite ui-parity: relative paths and visual-text override", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["每日精選咖啡"] }
  ]);
  const snapshot = writeSnapshot(dir, {
    screen: "home",
    texts: [text("每日精選咖啡")]
  });
  const relative = await run([
    "ui-parity",
    "--contract", ".artemis/design/ui-contract.json",
    "--semantics", ".artemis/design/ui-semantics.json",
    "--snapshot", ".artemis/design/snapshot.json",
    "--json"
  ]);
  assert.equal(relative.code, 0, relative.errors.join("\n"));

  const visual = writeSnapshot(dir, {
    texts: [text("每...咖啡")]
  }, "visual.json");
  const visualRun = await run([
    "ui-parity", "--snapshot", snapshot, "--visual-text", visual, "--json"
  ]);
  assert.equal(visualRun.code, 1);
  assert.equal(JSON.parse(visualRun.logs.join("\n")).verdict, "truncated-labels");
});

test("suite ui-parity: baseline relative path and unwritable path", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["推薦", "咖啡飲品"] }
  ]);
  const snapshot = writeSnapshot(dir, { screen: "home", texts: [text("推薦")] });
  const relativeBaseline = ".artemis/design/ui-parity-baseline.json";
  const updated = await run([
    "ui-parity", "--snapshot", snapshot, "--region", "category-rail",
    "--baseline", relativeBaseline, "--update-baseline", "--json"
  ]);
  assert.equal(updated.code, 1);
  assert.ok(fs.existsSync(path.join(dir, relativeBaseline)));

  const blocker = path.join(dir, ".artemis", "design", "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const unwritable = await run([
    "ui-parity", "--snapshot", snapshot, "--region", "category-rail",
    "--baseline", ".artemis/design/blocker/ui-parity-baseline.json",
    "--update-baseline", "--json"
  ]);
  assert.equal(unwritable.code, 2);
});

test("suite help mentions ui-parity", async () => {
  const logs = [];
  const code = await runSuiteCommand(["help"], { log: (line) => logs.push(line) });
  assert.equal(code, 0);
  assert.ok(logs.some((line) => line.includes("suite ui-parity")));
});

test("suite ui-parity: no-invariants is not suppressed by an empty/explicit baseline", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  writeSemantics(dir, [{ id: "category-rail", role: "category-list" }]);
  const snapshot = writeSnapshot(dir, { screen: "home", texts: [text("推薦")] });
  const baseline = path.join(dir, ".artemis", "design", "ui-parity-baseline.json");
  fs.writeFileSync(baseline, JSON.stringify({ version: 1, entries: [] }));

  const auto = await run(["ui-parity", "--snapshot", snapshot, "--json"]);
  assert.equal(auto.code, 1);
  assert.equal(JSON.parse(auto.logs.join("\n")).verdict, "no-invariants");

  const explicit = await run([
    "ui-parity", "--snapshot", snapshot, "--baseline", baseline, "--json"
  ]);
  assert.equal(explicit.code, 1);
  assert.equal(JSON.parse(explicit.logs.join("\n")).verdict, "no-invariants");
});

test("suite ui-parity: draft semantics is exit 1 even with invariants", async () => {
  const { dir, run } = await withRuntime();
  writeContract(dir);
  const semanticsPath = writeSemantics(dir, [
    { id: "category-rail", role: "category-list", invariantTexts: ["推薦"] }
  ]);
  const file = JSON.parse(fs.readFileSync(semanticsPath, "utf-8"));
  file.draft = true;
  fs.writeFileSync(semanticsPath, JSON.stringify(file));
  const snapshot = writeSnapshot(dir, { screen: "home", texts: [text("推薦")] });
  const result = await run(["ui-parity", "--snapshot", snapshot, "--json"]);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.logs.join("\n"));
  assert.equal(payload.verdict, "no-invariants");
  assert.ok(payload.warnings.some((warning) => warning.includes("draft")));
});

test("suite ui-parity: trace step screen resolves without --screen", async () => {
  const { dir, runtime, run } = await withRuntime();
  writeContract(dir, [{ id: "home", name: "Home" }, { id: "detail", name: "Detail" }]);
  writeSemantics(dir, [{ id: "category-rail", role: "category-list", invariantTexts: ["推薦"] }]);
  const traceId = "trace-ui-parity-screen";
  const traceDir = runtime.traceDir(traceId);
  fs.mkdirSync(path.join(traceDir, "shots"), { recursive: true });
  fs.writeFileSync(path.join(traceDir, "shots", "step-2.png"), toPng(createImage(200, 200)));
  fs.writeFileSync(
    path.join(traceDir, "run.json"),
    JSON.stringify({
      steps: [
        {
          step: 2,
          screen: "Home",
          shot: "shots/step-2.png",
          postShot: "shots/step-2.png",
          scale: 1,
          texts: [{ text: "推薦", x: 10, y: 10, width: 80, height: 20 }]
        }
      ]
    })
  );
  const result = await run(["ui-parity", "--trace", traceId, "--step", "2", "--json"]);
  assert.notEqual(result.code, 2, result.errors.join("\n"));
  assert.equal(JSON.parse(result.logs.join("\n")).screenId, "home");
});

test("suite ui-parity: long trace screen summary falls back to contract name", async () => {
  const { dir, runtime, run } = await withRuntime();
  writeContract(dir, [{ id: "mop", name: "到店自取_MOP" }]);
  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "ui-semantics.json"),
    JSON.stringify({
      version: 1,
      screens: [
        {
          screenId: "mop",
          screenName: "到店自取_MOP",
          regions: [{ id: "category-rail", role: "category-list", invariantTexts: ["推薦"] }]
        }
      ]
    })
  );
  const traceId = "trace-ui-parity-summary";
  const traceDir = runtime.traceDir(traceId);
  fs.mkdirSync(path.join(traceDir, "shots"), { recursive: true });
  fs.writeFileSync(path.join(traceDir, "shots", "step-2.png"), toPng(createImage(200, 200)));
  fs.writeFileSync(
    path.join(traceDir, "run.json"),
    JSON.stringify({
      steps: [
        {
          step: 2,
          screen: "STBTW UAT | 到店自取 | 內用點餐 | 店外取餐 | 車道取餐 | 嘉義高鐵門市",
          shot: "shots/step-2.png",
          postShot: "shots/step-2.png",
          scale: 1,
          texts: [{ text: "推薦", x: 10, y: 10, width: 80, height: 20 }]
        }
      ]
    })
  );
  const result = await run(["ui-parity", "--trace", traceId, "--step", "2", "--json"]);
  assert.notEqual(result.code, 2, result.errors.join("\n"));
  assert.equal(JSON.parse(result.logs.join("\n")).screenId, "mop");
});
