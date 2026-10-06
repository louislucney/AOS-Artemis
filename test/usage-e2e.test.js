import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryStore } from "../dist/db/memory.js";
import { closeLogging, configureLogging } from "../dist/log.js";
import { createServerForRuntime } from "../dist/server.js";
import { runUsageCommand } from "../dist/usage-command.js";
import { handleUsageRequest } from "../dist/usage/web.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, StubProxy } from "./helpers.js";

const CATALOG = ["llm_list", "aos_status", "aos_usage"];

function jsonOf(result) {
  return JSON.parse(result.content[0].text);
}

test("usage e2e: tool, CLI, web and audit log agree on the same event", async () => {
  const logDir = makeTempDir("aos-usage-e2e-log-");
  configureLogging({ logDir, echo: false });
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: true }),
    store,
    baseEnv: { AOS_MODEL_REFRESH_HOURS: "0" }
  });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-e2e-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const called = await client.callTool({ name: "llm_list", arguments: {} });
    assert.notEqual(called.isError, true);
    const known = await store.recordUsageEvent(dir, {
      tool: "aos_status",
      family: "native",
      ok: true,
      durationMs: 3,
      at: new Date(Date.now() - 60_000).toISOString()
    });

    const log = fs.readFileSync(path.join(logDir, "aos-mcp.log"), "utf-8");
    const logged = /tool=llm_list ok=true ms=(\d+) usage=([0-9a-f-]{36})/.exec(log);
    assert.ok(logged, log);
    const eventId = logged[2];
    const stored = await store.listUsageEvents(dir);
    assert.equal(stored.length, 2);
    const clientEvent = stored.find((event) => event.tool === "llm_list");
    assert.ok(clientEvent);
    assert.equal(clientEvent.id, eventId);

    const eventsView = jsonOf(
      await client.callTool({ name: "aos_usage", arguments: { action: "events" } })
    );
    assert.equal(eventsView.count, 2);
    assert.deepEqual(
      eventsView.events.map((event) => event.id).sort(),
      [eventId, known.id].sort()
    );
    const summaryView = jsonOf(await client.callTool({ name: "aos_usage", arguments: {} }));
    assert.equal(summaryView.summary.total, 2);
    assert.ok(
      summaryView.summary.byTool.some((row) => row.tool === "llm_list" && row.count === 1)
    );

    const cliLogs = [];
    const cliErrors = [];
    const cliCode = await runUsageCommand(["--json"], {
      store,
      env: {},
      cwd: dir,
      catalog: CATALOG,
      log: (line) => cliLogs.push(line),
      errorLog: (line) => cliErrors.push(line)
    });
    assert.equal(cliCode, 0);
    assert.deepEqual(cliErrors, []);
    const report = JSON.parse(cliLogs.at(-1));
    assert.equal(report.projects[0].rootPath, dir);
    assert.equal(report.projects[0].summary.total, 2);
    assert.ok(
      report.projects[0].summary.byTool.some((row) => row.tool === "llm_list" && row.count === 1)
    );

    const cliText = [];
    const textCode = await runUsageCommand([], {
      store,
      env: {},
      cwd: dir,
      catalog: CATALOG,
      log: (line) => cliText.push(line),
      errorLog: (line) => cliErrors.push(line)
    });
    assert.equal(textCode, 0);
    assert.ok(cliText.some((line) => line.includes("llm_list 1 次")));
    assert.ok(cliText.some((line) => line.startsWith("事件: 2")));

    const query = `?project=${encodeURIComponent(dir)}`;
    const webJson = await handleUsageRequest(new URL(`http://127.0.0.1/usage.json${query}`), {
      store,
      catalog: CATALOG,
      env: {}
    });
    assert.equal(webJson.status, 200);
    const view = JSON.parse(webJson.body);
    assert.equal(view.summary.total, 2);
    assert.deepEqual(
      view.events.items.map((event) => event.id).sort(),
      [eventId, known.id].sort()
    );
    const webHtml = await handleUsageRequest(new URL(`http://127.0.0.1/usage${query}`), {
      store,
      catalog: CATALOG,
      env: {}
    });
    assert.equal(webHtml.status, 200);
    assert.ok(webHtml.body.includes(eventId));
    assert.ok(webHtml.body.includes(known.id));
  } finally {
    closeLogging();
    await client.close();
    await server.close();
  }
});
