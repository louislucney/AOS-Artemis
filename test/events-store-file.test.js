import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FileStore } from "../dist/db/file.js";
import { makeTempDir } from "./helpers.js";

async function makeFileStore(ledger, projectRoot) {
  process.env.AOS_LEDGER_DIR = ledger;
  const store = await FileStore.create();
  await store.upsertProject({ rootPath: projectRoot, name: "p1" });
  return store;
}

test("FileStore events: 重启后判重、seq 持久化、裁剪不复用 seq", async () => {
  const previousMax = process.env.AOS_EVENTS_MAX;
  const root = makeTempDir("aos-events-file-");
  const ledger = path.join(root, "ledger");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  try {
    const store = await makeFileStore(ledger, project);
    const first = await store.recordProjectEvent(project, {
      eventId: "e1",
      type: "case.result",
      caseId: "TC_1",
      status: "passed",
      payload: { a: 1 }
    });
    assert.equal(first.record.seq, 1);
    assert.equal(first.duplicate, false);
    await store.close();

    const reopened = await makeFileStore(ledger, project);
    const dup = await reopened.recordProjectEvent(project, {
      eventId: "e1",
      type: "case.result",
      caseId: "TC_1",
      status: "passed",
      payload: { a: 1 }
    });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.payloadMismatch, false);
    assert.equal(dup.record.id, first.record.id);

    process.env.AOS_EVENTS_MAX = "1";
    const second = await reopened.recordProjectEvent(project, {
      eventId: "e2",
      type: "log.entry",
      payload: { message: "x" }
    });
    assert.equal(second.record.seq, 2);
    await reopened.pruneProjectEvents(project);
    const third = await reopened.recordProjectEvent(project, {
      eventId: "e3",
      type: "log.entry",
      payload: { message: "y" }
    });
    assert.equal(third.record.seq, 3, "裁剪后 seq 不回收");

    const lines = fs
      .readFileSync(path.join(project, ".artemis", "ledger", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.seq), [2, 3]);
    await reopened.close();
  } finally {
    if (previousMax === undefined) delete process.env.AOS_EVENTS_MAX;
    else process.env.AOS_EVENTS_MAX = previousMax;
  }
});

test("FileStore events: 查询过滤、since 秒级、order、includePayload", async () => {
  const root = makeTempDir("aos-events-file-");
  const ledger = path.join(root, "ledger");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const store = await makeFileStore(ledger, project);
  try {
    const first = await store.recordProjectEvent(project, {
      eventId: "e1",
      type: "run.step",
      runId: "run-1",
      step: 1,
      payload: { note: "first" }
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.recordProjectEvent(project, {
      eventId: "e2",
      type: "case.result",
      runId: "run-1",
      caseId: "TC_2",
      status: "failed",
      payload: { note: "second" }
    });

    const byRun = await store.listProjectEvents(project, { runId: "run-1", order: "asc" });
    assert.deepEqual(byRun.map((event) => event.eventId), ["e1", "e2"]);
    assert.equal(byRun[0].payload, undefined);

    const withPayload = await store.listProjectEvents(project, {
      runId: "run-1",
      order: "asc",
      includePayload: true
    });
    assert.equal(withPayload[0].payload.note, "first");

    const sinceSeconds = await store.listProjectEvents(project, {
      since: new Date(Math.floor(Date.parse(first.record.receivedAt) / 1000) * 1000)
        .toISOString()
        .replace(".000Z", "Z"),
      order: "asc"
    });
    assert.equal(sinceSeconds.length >= 1, true);
    assert.equal(
      sinceSeconds.some((event) => event.eventId === "e2"),
      true,
      "秒级 since 不丢同秒事件"
    );

    const desc = await store.listProjectEvents(project, { order: "desc" });
    assert.equal(desc[0].eventId, "e2");
    assert.equal(await store.countProjectEvents(project), 2);
    assert.equal(second.record.runId, "run-1");

    const afterFirst = await store.listProjectEvents(project, {
      afterSeq: first.record.seq,
      order: "asc"
    });
    assert.deepEqual(afterFirst.map((event) => event.eventId), ["e2"]);
    await assert.rejects(
      () => store.listProjectEvents(project, { afterSeq: -1 }),
      /invalid afterSeq/
    );
  } finally {
    await store.close();
  }
});

test("FileStore events: 并发同 eventId 只接受一次，seq 唯一", async () => {
  const root = makeTempDir("aos-events-file-");
  const ledger = path.join(root, "ledger");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const store = await makeFileStore(ledger, project);
  try {
    const input = { eventId: "same", type: "log.entry", payload: { a: 1 } };
    const [left, right] = await Promise.all([
      store.recordProjectEvent(project, input),
      store.recordProjectEvent(project, input)
    ]);
    assert.equal([left, right].filter((result) => !result.duplicate).length, 1);
    assert.equal(left.record.id, right.record.id);

    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.recordProjectEvent(project, {
          eventId: `burst-${index}`,
          type: "log.entry",
          payload: { index }
        })
      )
    );
    const seqs = burst.map((result) => result.record.seq);
    assert.equal(new Set(seqs).size, seqs.length);
    const sorted = [...seqs].sort((a, b) => a - b);
    assert.equal(sorted[1] - sorted[0], 1);
  } finally {
    await store.close();
  }
});
