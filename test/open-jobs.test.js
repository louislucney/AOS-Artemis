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
