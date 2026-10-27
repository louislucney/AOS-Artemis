import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { makeTempDir } from "./helpers.js";

process.env.AOS_HTTP_USERS_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "aos-http-users-")),
  "http-users.json"
);

async function withServer(fn, env = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const workspace = makeTempDir("aos-events-http-");
  fs.mkdirSync(path.join(workspace, "demo"));
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store: new MemoryStore()
  });
  try {
    return await fn(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const EVENT = {
  eventId: "e-http-1",
  type: "case.result",
  caseId: "TC_1",
  status: "passed",
  payload: { note: "hello" }
};

test("events HTTP: POST/GET、幂等、400/404/413", async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/events/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(EVENT)
    });
    assert.equal(first.status, 202);
    const ack = await first.json();
    assert.equal(ack.accepted, true);
    assert.equal(ack.duplicate, false);
    assert.equal(ack.storage, "memory");
    assert.ok("degraded" in ack);

    const dup = await fetch(`${base}/events/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(EVENT)
    });
    assert.equal(dup.status, 202);
    const dupBody = await dup.json();
    assert.equal(dupBody.accepted, false);
    assert.equal(dupBody.duplicate, true);
    assert.equal(dupBody.serverId, ack.serverId);
    assert.equal(dupBody.receivedAt, ack.receivedAt);

    const list = await fetch(`${base}/events/demo?includePayload=false`);
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.returned, 1);
    assert.equal(listed.events[0].payload, undefined);
    assert.ok("storage" in listed && "degraded" in listed);

    const invalid = await fetch(`${base}/events/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "bad", type: "nope" })
    });
    assert.equal(invalid.status, 400);

    const traversal = await fetch(`${base}/events/bad%2Fname`, { method: "POST" });
    assert.equal(traversal.status, 400);

    const missing = await fetch(`${base}/events/missing`);
    assert.equal(missing.status, 404);

    const tooLarge = await fetch(`${base}/events/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "big", type: "log.entry", payload: { data: "x".repeat(70_000) } })
    });
    assert.equal(tooLarge.status, 413);
  });
});

test("events HTTP: AOS_HTTP_TOKEN 保护事件路由，健康检查豁免", async () => {
  await withServer(
    async (base) => {
      const denied = await fetch(`${base}/events/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(EVENT)
      });
      assert.equal(denied.status, 401);
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      const allowed = await fetch(`${base}/events/demo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token"
        },
        body: JSON.stringify(EVENT)
      });
      assert.equal(allowed.status, 202);
    },
    { AOS_HTTP_TOKEN: "test-token" }
  );
});

test("events HTTP: afterSeq 与 /poll 长轮询", async () => {
  await withServer(async (base) => {
    const post = (event) =>
      fetch(`${base}/events/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
    const first = await post(EVENT);
    assert.equal(first.status, 202);

    const listed = await (await fetch(`${base}/events/demo?order=asc`)).json();
    assert.equal(listed.returned, 1);
    assert.equal(listed.nextSeq, listed.events[0].seq);

    const empty = await (
      await fetch(`${base}/events/demo?afterSeq=${listed.nextSeq}&order=asc`)
    ).json();
    assert.equal(empty.returned, 0);
    assert.equal(empty.nextSeq, listed.nextSeq);

    const consumed = await (
      await fetch(`${base}/events/demo/poll?afterSeq=0&waitMs=0&consume=true`)
    ).json();
    assert.equal(consumed.returned, 1);
    assert.equal(consumed.events[0].consumedAt !== null, true);
    const unconsumed = await (await fetch(`${base}/events/demo?consumed=false`)).json();
    assert.equal(unconsumed.returned, 0);

    const pending = fetch(
      `${base}/events/demo/poll?afterSeq=${listed.nextSeq}&waitMs=1000&order=asc`
    );
    setTimeout(() => {
      void post({ ...EVENT, eventId: "e-http-2", payload: { note: "second" } });
    }, 50);
    const polled = await (await pending).json();
    assert.equal(polled.returned, 1);
    assert.equal(polled.events[0].eventId, "e-http-2");
    assert.equal(polled.nextSeq, polled.events[0].seq);

    const invalid = await fetch(`${base}/events/demo/poll?afterSeq=-1`);
    assert.equal(invalid.status, 400);

    const wrongMethod = await fetch(`${base}/events/demo/poll`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
  });
});

test("events HTTP: 默认 FileStore ack 不误报 degraded", async () => {
  const workspace = makeTempDir("aos-events-http-file-");
  const project = path.join(workspace, "demo");
  fs.mkdirSync(project);
  const store = await FileStore.create({ homeDir: path.join(workspace, "ledger-home") });
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/events/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(EVENT)
    });
    assert.equal(response.status, 202);
    const ack = await response.json();
    assert.equal(ack.storage, "file");
    assert.equal(ack.degraded, null);
  } finally {
    await handle.close();
  }
});

test("events HTTP: 配置损坏返回 400 project-config-invalid", async () => {
  const workspace = makeTempDir("aos-events-http-bad-");
  const project = path.join(workspace, "demo");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "aos.config.jsonc"), "{not-json");
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store: new MemoryStore()
  });
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/events/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(EVENT)
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "project-config-invalid");
  } finally {
    await handle.close();
  }
});
