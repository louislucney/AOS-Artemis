import assert from "node:assert/strict";
import test from "node:test";

import { JobManager, JobQueueFullError } from "../dist/open/jobs.js";

function manager(overrides = {}) {
  let now = 1_000_000;
  const jobs = new JobManager({
    maxQueue: 2,
    maxConcurrent: 1,
    jobTimeoutMs: 60_000,
    retentionMs: 120_000,
    now: () => now,
    ...overrides
  });
  return { jobs, advance: (ms) => { now += ms; }, now: () => now };
}

test("jobs: queue -> claim -> complete", () => {
  const { jobs } = manager();
  const job = jobs.create();
  assert.equal(job.status, "queued");
  const claimed = jobs.claimNext();
  assert.equal(claimed?.id, job.id);
  assert.equal(jobs.get(job.id)?.status, "running");
  jobs.complete(job.id, "/tmp/out.zip");
  assert.equal(jobs.get(job.id)?.status, "done");
  assert.equal(jobs.get(job.id)?.artifactPath, "/tmp/out.zip");
});

test("jobs: queue limit and concurrency", () => {
  const { jobs } = manager();
  jobs.create();
  jobs.create();
  assert.throws(() => jobs.create(), JobQueueFullError);
  const first = jobs.claimNext();
  assert.ok(first);
  assert.equal(jobs.claimNext(), null, "maxConcurrent=1");
  jobs.complete(first.id, "/tmp/a.zip");
  const second = jobs.claimNext();
  assert.ok(second);
});

test("jobs: timeout fails running job", () => {
  const { jobs, advance } = manager();
  const job = jobs.create();
  jobs.claimNext();
  advance(61_000);
  assert.equal(jobs.tick(), 1);
  const failed = jobs.get(job.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error?.code, "job_timeout");
});

test("jobs: timeout is progress-aware (setStep renews the window)", () => {
  const { jobs, advance } = manager();
  const job = jobs.create();
  jobs.claimNext();
  advance(40_000);
  jobs.setStep(job.id, "generating");
  advance(40_000);
  assert.equal(jobs.tick(), 0, "40s since last progress < 60s timeout");
  advance(30_000);
  assert.equal(jobs.tick(), 1, "70s since last progress > 60s timeout");
  assert.equal(jobs.get(job.id)?.error?.code, "job_timeout");
});

test("jobs: snapshot/restore marks queued/running jobs interrupted", () => {
  const { jobs } = manager({ maxConcurrent: 2 });
  const running = jobs.create();
  const done = jobs.create();
  jobs.claimNext();
  jobs.claimNext();
  jobs.complete(done.id, "/tmp/done.zip");
  const snapshot = jobs.snapshot();
  assert.equal(snapshot.length, 2);

  const restored = new JobManager({
    maxQueue: 2,
    maxConcurrent: 1,
    jobTimeoutMs: 60_000,
    retentionMs: 120_000,
    initial: snapshot
  });
  const interrupted = restored.get(running.id);
  assert.equal(interrupted?.status, "failed");
  assert.equal(interrupted?.error?.code, "job_interrupted");
  assert.equal(restored.get(done.id)?.status, "done");
  assert.equal(restored.get(done.id)?.artifactPath, "/tmp/done.zip");
});

test("jobs: retention calls onExpire for removed job", () => {
  const expired = [];
  const { jobs, advance } = manager({ onExpire: (id) => expired.push(id) });
  const job = jobs.create();
  jobs.claimNext();
  jobs.complete(job.id, "/tmp/a.zip");
  advance(121_000);
  assert.equal(jobs.tick(), 1);
  assert.deepEqual(expired, [job.id]);
});

test("jobs: cancel queued and running", () => {
  const { jobs } = manager();
  const queued = jobs.create();
  jobs.cancel(queued.id);
  assert.equal(jobs.get(queued.id)?.status, "cancelled");

  const running = jobs.create();
  jobs.claimNext();
  jobs.cancel(running.id);
  assert.equal(jobs.get(running.id)?.status, "running");
  assert.equal(jobs.cancelRequested(running.id), true);
});

test("jobs: retention expires terminal jobs", () => {
  const { jobs, advance } = manager();
  const job = jobs.create();
  jobs.claimNext();
  jobs.complete(job.id, "/tmp/a.zip");
  advance(121_000);
  assert.deepEqual(jobs.tick(), 1);
  assert.equal(jobs.get(job.id), null);
});
