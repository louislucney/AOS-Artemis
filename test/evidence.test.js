import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { traceEvidence } from "../dist/artemis/evidence.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function textJson(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

class EvidenceProxy {
  constructor({ statusPayload = {}, searchResults = "", screenshots = {}, running = true } = {}) {
    this.statusPayload = statusPayload;
    this.searchResults = searchResults;
    this.screenshots = screenshots;
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
    if (name === "mobile_manage_task") return textJson(this.statusPayload);
    if (name === "mobile_inspect_trace" && args.action === "search") {
      return textJson({ results: this.searchResults });
    }
    if (name === "mobile_inspect_trace" && args.action === "view_step_screenshots") {
      const entry = this.screenshots[args.step_number];
      if (!entry) return textJson({ error: "no screenshots" });
      return textJson({
        after_screenshot: entry.post ?? null,
        before_screenshot: entry.pre ?? null
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

function failedStatus() {
  return {
    trace_id: "trace-1",
    status: "failed",
    error: "boom",
    stderr_log: "/logs/1/err.log",
    test_summary: {
      task_status: "failed",
      failed_items: [
        { item_text: "tap CTA", kind: "assert", evidence: "CTA not found" },
        { item_text: "assert two", kind: "assert", evidence: "second mismatch" }
      ]
    }
  };
}

function crashSummary() {
  return {
    id: "sig-1",
    kind: "java",
    package: "com.example.app",
    attribution: "package",
    exceptionClass: "java.lang.NullPointerException",
    message: "NPE",
    rootCauseClass: "java.lang.NullPointerException",
    topFrame: "com.example.Main.onCreate",
    signatureBasis: "basis",
    source: "crash-buffer",
    deviceSerial: null,
    occurredAt: null,
    capturedAt: "2026-10-01T00:00:00.000Z",
    occurrences: 2,
    outcomeCounts: { failed: 2 },
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z",
    traceIds: ["trace-1"]
  };
}

function seedCrash(runtime, crash) {
  fs.mkdirSync(runtime.crashStore.dirPath, { recursive: true });
  fs.writeFileSync(
    path.join(runtime.crashStore.dirPath, "index.json"),
    JSON.stringify({ version: 1, records: [crash] })
  );
}

test("traceEvidence: aggregates status, crashes, anchor and copies anchored screenshots", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const pre = path.join(shots, "pre.png");
  const post = path.join(shots, "post.png");
  fs.writeFileSync(pre, pngBytes());
  fs.writeFileSync(post, pngBytes());

  const proxy = new EvidenceProxy({
    statusPayload: failedStatus(),
    searchResults: "[Step 3] tap CTA\n[Step 5] other",
    screenshots: { 3: { pre, post } }
  });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  seedCrash(runtime, crashSummary());

  const bundle = await traceEvidence(runtime, { traceId: "trace-1" });
  assert.equal(bundle.ok, true);
  assert.equal(bundle.status, "failed");
  assert.equal(bundle.error, "boom");
  assert.equal(bundle.failedItems.length, 2);
  assert.equal(bundle.failedItems[1].evidence, "second mismatch");
  assert.equal(bundle.crashes.length, 1);
  assert.equal(bundle.crashes[0].id, "sig-1");
  assert.equal(bundle.anchor.stepNumber, 3);
  assert.ok(!bundle.degraded.some((entry) => entry.startsWith("no-run-outcome")));
  assert.ok(!bundle.degraded.some((entry) => entry.startsWith("anchor-")));

  const copied = bundle.artifacts.filter((artifact) => artifact.copied);
  assert.equal(copied.length, 2);
  assert.ok(copied.every((artifact) => fs.existsSync(artifact.path)));

  const references = bundle.artifacts.filter((artifact) => !artifact.copied);
  assert.ok(references.some((artifact) => artifact.path === "/logs/1/err.log"));
  assert.ok(fs.existsSync(path.join(bundle.dir, "manifest.json")));
});

test("traceEvidence: Flash-style task without run outcome degrades explicitly", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new EvidenceProxy({ statusPayload: { trace_id: "trace-1", status: "running" } });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const bundle = await traceEvidence(runtime, { traceId: "trace-1" });
  assert.equal(bundle.ok, true);
  assert.deepEqual(bundle.failedItems, []);
  assert.equal(bundle.anchor, null);
  assert.ok(bundle.degraded.includes("no-run-outcome"));
  assert.ok(bundle.degraded.includes("anchor-skipped"));
});

test("traceEvidence: missing trace and offline proxy degrade without throwing", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new EvidenceProxy({ running: false });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const bundle = await traceEvidence(runtime, { traceId: "ghost" });
  assert.equal(bundle.ok, false);
  assert.ok(bundle.degraded.includes("trace-status-missing"));
  assert.equal(bundle.dir, null);
});

test("traceEvidence: optional design diff reference succeeds or degrades", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new EvidenceProxy({
    statusPayload: { trace_id: "trace-1", status: "failed", test_summary: { failed_items: [{ evidence: "x" }] } },
    searchResults: "[Step 1] x",
    screenshots: {}
  });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const okRunner = async () => textJson({ ok: true, saved: { report: "/tmp/diff/report.json" } });
  const okBundle = await traceEvidence(runtime, {
    traceId: "trace-1",
    design: { figmaUrl: "https://www.figma.com/design/abc/File" },
    diffRunner: okRunner
  });
  assert.equal(okBundle.designDiff.ok, true);
  assert.equal(okBundle.designDiff.reportPath, "/tmp/diff/report.json");
  assert.ok(
    okBundle.artifacts.some(
      (artifact) => artifact.kind === "design-diff" && artifact.path === "/tmp/diff/report.json"
    )
  );

  const failingRunner = async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: "diff blew up" }) }],
    isError: true
  });
  const failedBundle = await traceEvidence(runtime, {
    traceId: "trace-1",
    design: { figmaUrl: "https://www.figma.com/design/abc/File" },
    diffRunner: failingRunner
  });
  assert.equal(failedBundle.designDiff.ok, false);
  assert.ok(failedBundle.degraded.includes("design-diff-failed"));
});

test("traceEvidence: fullTrace copies every anchor candidate step", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const files = {
    3: {
      pre: path.join(shots, "3-pre.png"),
      post: path.join(shots, "3-post.png")
    },
    5: {
      pre: path.join(shots, "5-pre.png"),
      post: path.join(shots, "5-post.png")
    }
  };
  for (const entry of Object.values(files)) {
    fs.writeFileSync(entry.pre, pngBytes());
    fs.writeFileSync(entry.post, pngBytes());
  }

  const proxy = new EvidenceProxy({
    statusPayload: failedStatus(),
    searchResults: "[Step 3] tap CTA\n[Step 5] other",
    screenshots: files
  });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const bundle = await traceEvidence(runtime, { traceId: "trace-1", fullTrace: true });
  const copied = bundle.artifacts.filter((artifact) => artifact.copied);
  assert.equal(copied.length, 4);
  assert.ok(copied.some((artifact) => artifact.path.endsWith("step-5-post.png")));
});
