import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadJobs, saveJobs } from "../dist/open/job-store.js";

function snapshot(overrides = {}) {
  return {
    id: "job-1",
    status: "done",
    step: "done",
    createdAt: "2026-10-22T00:00:00.000Z",
    finishedAt: "2026-10-22T00:01:00.000Z",
    error: null,
    artifactPath: "/tmp/result.zip",
    cancelRequested: false,
    createdAtMs: 1_000,
    startedAtMs: 2_000,
    finishedAtMs: 3_000,
    lastProgressAtMs: 2_500,
    ...overrides
  };
}

test("job-store: save/load roundtrip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aos-job-store-"));
  try {
    const file = join(dir, "jobs.json");
    saveJobs(file, [snapshot()]);
    assert.deepEqual(loadJobs(file), [snapshot()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("job-store: missing or corrupt file returns empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aos-job-store-"));
  try {
    assert.deepEqual(loadJobs(join(dir, "missing.json")), []);
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, "{not json", "utf-8");
    assert.deepEqual(loadJobs(corrupt), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
