import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compareBaseline, saveBaseline } from "../dist/diff/baseline.js";
import { baseConfig, createImage, fillRect, loadTestRuntime, makeTempProject, toPng } from "./helpers.js";

function textJson(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

class BaselineProxy {
  constructor({ shots = {}, serial = "emulator-5554", running = true } = {}) {
    this.shots = shots;
    this.serial = serial;
    this.running = running;
    this.calls = [];
  }

  isRunning() {
    return this.running;
  }

  async ensureStarted() {
    this.running = true;
  }

  async listTools() {
    return [];
  }

  async callTool(name, args) {
    this.calls.push({ name, args });
    if (name === "mobile_inspect_trace" && args.action === "view_step_screenshots") {
      const entry = this.shots[args.step_number];
      if (!entry) return textJson({ error: "no screenshot" });
      return textJson({
        device_serial: this.serial,
        step_number: args.step_number,
        before_screenshot: entry.pre ?? null,
        after_screenshot: entry.post ?? null
      });
    }
    return textJson({ ok: true });
  }

  status() {
    return {
      running: this.running,
      pid: this.running ? 1 : null,
      restarts: 0,
      lastError: null,
      stderrTail: [],
      fingerprint: null
    };
  }

  async markForRestart() {
    this.running = false;
  }

  async dispose() {
    this.running = false;
  }

  disposeSync() {
    this.running = false;
  }
}

function pagePng({ withSquare = true, width = 390, height = 844 } = {}) {
  const image = createImage(width, height);
  if (withSquare) fillRect(image, 40, 80, 120, 60, [30, 64, 175, 255]);
  return toPng(image);
}

async function setup({ serial = "emulator-5554" } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const shotPath = path.join(dir, "step-post.png");
  fs.writeFileSync(shotPath, pagePng({ withSquare: true }));
  const proxy = new BaselineProxy({ shots: { 2: { post: shotPath } }, serial });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  return { dir, shotPath, runtime };
}

const request = { caseId: "case-1", stepNumber: 2, traceId: "trace-1" };

test("saveBaseline: device bucket, image and full metadata", async () => {
  const { runtime } = await setup();
  const saved = await saveBaseline(runtime, request);

  assert.equal(saved.meta.serial, "emulator-5554");
  assert.equal(saved.meta.caseId, "case-1");
  assert.equal(saved.meta.stepNumber, 2);
  assert.equal(saved.meta.image, "post");
  assert.equal(saved.meta.width, 390);
  assert.equal(saved.meta.height, 844);
  assert.equal(saved.meta.dpi, null);
  assert.deepEqual(saved.meta.ignoreRegions, []);
  assert.ok(
    saved.dir.endsWith(path.join("baselines", "emulator-5554", "case-1", "step-2-post"))
  );
  assert.ok(fs.existsSync(path.join(saved.dir, "image.png")));
  assert.ok(fs.existsSync(path.join(saved.dir, "meta.json")));
});

test("compareBaseline: identical screens produce no regions", async () => {
  const { runtime } = await setup();
  await saveBaseline(runtime, request);

  const report = await compareBaseline(runtime, request);
  assert.equal(report.status, "ok");
  assert.deepEqual(report.summary, { regions: 0, new: 0, persisting: 0, fixed: 0 });
  assert.deepEqual(report.regions, []);
});

test("compareBaseline: new -> persisting -> fixed lifecycle is deterministic", async () => {
  const { runtime, shotPath } = await setup();
  await saveBaseline(runtime, request);

  fs.writeFileSync(shotPath, pagePng({ withSquare: false }));
  const first = await compareBaseline(runtime, request);
  assert.equal(first.status, "ok");
  assert.ok(first.summary.regions >= 1);
  assert.equal(first.summary.new, first.summary.regions);
  assert.equal(first.summary.persisting, 0);
  assert.equal(first.summary.fixed, 0);
  assert.ok(first.regions.every((region) => region.change === "new"));
  assert.ok(fs.existsSync(path.join(first.saved.dir, "last-diff.json")));

  const second = await compareBaseline(runtime, request);
  assert.equal(second.summary.new, 0);
  assert.equal(second.summary.persisting, first.summary.regions);
  assert.deepEqual(
    second.regions.map((region) => region.bbox),
    first.regions.map((region) => region.bbox)
  );

  fs.writeFileSync(shotPath, pagePng({ withSquare: true }));
  const third = await compareBaseline(runtime, request);
  assert.equal(third.summary.regions, 0);
  assert.equal(third.summary.fixed, first.summary.regions);
  assert.equal(third.summary.persisting, 0);
});

test("compareBaseline: resolution or dpi mismatch returns unmapped", async () => {
  const { runtime, shotPath } = await setup();
  await saveBaseline(runtime, { ...request, dpi: 420 });

  fs.writeFileSync(shotPath, pagePng({ width: 300, height: 600 }));
  const resolution = await compareBaseline(runtime, { ...request, dpi: 420 });
  assert.equal(resolution.status, "unmapped");
  assert.match(resolution.reason, /resolution-mismatch/);

  fs.writeFileSync(shotPath, pagePng({}));
  const dpi = await compareBaseline(runtime, { ...request, dpi: 480 });
  assert.equal(dpi.status, "unmapped");
  assert.match(dpi.reason, /dpi-mismatch/);

  const ok = await compareBaseline(runtime, { ...request, dpi: 420 });
  assert.equal(ok.status, "ok");
});

test("compareBaseline: stored ignoreRegions mask dynamic content", async () => {
  const { runtime, shotPath } = await setup();
  await saveBaseline(runtime, {
    ...request,
    ignoreRegions: [{ x: 30, y: 70, width: 140, height: 80 }]
  });

  fs.writeFileSync(shotPath, pagePng({ withSquare: false }));
  const report = await compareBaseline(runtime, request);
  assert.equal(report.status, "ok");
  assert.equal(report.summary.regions, 0);
});

test("compareBaseline: missing baseline reports no-baseline; serial falls back to default", async () => {
  const { runtime } = await setup({ serial: null });
  const report = await compareBaseline(runtime, request);
  assert.equal(report.status, "no-baseline");
  assert.equal(report.serial, "default");
  assert.equal(report.baseline, null);
});
