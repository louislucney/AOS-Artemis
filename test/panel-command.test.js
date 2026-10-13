import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runPanelCommand } from "../dist/panel-command.js";
import { makeTempDir } from "./helpers.js";

function runCli(args, deps = {}) {
  const logs = [];
  const errors = [];
  return runPanelCommand(args, {
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    ...deps
  }).then((code) => ({ code, logs, errors }));
}

test("panel --web: serves /panel on an ephemeral port and closes cleanly", async () => {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-panel-cli-");
  fs.mkdirSync(path.join(dir, "ws-app"), { recursive: true });
  let handle = null;
  const { code, logs, errors } = await runCli(["--web", "--port", "0", "--workspace", dir], {
    store,
    waitForShutdown: async (webHandle) => {
      handle = webHandle;
      const html = await fetch(webHandle.url);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /多项目总览/);

      const res = await fetch(`http://127.0.0.1:${webHandle.port}/panel.json`);
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.view, "overview");
      assert.ok(payload.projects.some((row) => row.name === "ws-app"));

      const detail = await fetch(
        `http://127.0.0.1:${webHandle.port}/panel.json?project=ws-app`
      );
      const detailPayload = await detail.json();
      assert.equal(detailPayload.view, "project");
      assert.equal(detailPayload.deep, null, "独立 CLI 进程无深探层");

      const missing = await fetch(`http://127.0.0.1:${webHandle.port}/other`);
      assert.equal(missing.status, 404);

      await webHandle.close();
      await assert.rejects(fetch(webHandle.url));
    }
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.ok(handle !== null);
  assert.ok(logs.some((line) => line.includes(`http://127.0.0.1:${handle.port}/panel`)));
  assert.ok(logs.some((line) => line.includes("按 Ctrl-C 停止")));
});

test("panel --web: port conflict exits 2 with a clear message", async () => {
  const store = new MemoryStore();
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  try {
    let waitCalled = false;
    const { code, errors } = await runCli(["--web", "--port", String(port)], {
      store,
      waitForShutdown: async () => {
        waitCalled = true;
      }
    });
    assert.equal(code, 2);
    assert.equal(waitCalled, false);
    assert.ok(errors.some((line) => line.includes(`端口 ${port}`) && line.includes("占用")));
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
});

test("panel help and parameter errors", async () => {
  const store = new MemoryStore();
  const help = await runCli(["help"], { store });
  assert.equal(help.code, 0);
  assert.ok(help.logs.some((line) => line.includes("aos-mcp panel")));

  const bare = await runCli([], { store });
  assert.equal(bare.code, 2);

  const unknown = await runCli(["nope"], { store });
  assert.equal(unknown.code, 2);
  assert.ok(unknown.errors.some((line) => line.includes("未知参数")));

  const badPort = await runCli(["--web", "--port", "abc"], { store });
  assert.equal(badPort.code, 2);
  assert.ok(badPort.errors.some((line) => line.includes("--port")));

  const missingValue = await runCli(["--web", "--workspace"], { store });
  assert.equal(missingValue.code, 2);
  assert.ok(missingValue.errors.some((line) => line.includes("--workspace")));
});
