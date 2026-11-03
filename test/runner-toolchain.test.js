import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleRunnerToolchainRequest } from "../dist/panel/toolchain-route.js";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-toolchain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "node.zip"), "node-bytes");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          platform: "win32-x64",
          tool: "node",
          name: "Node.js test",
          filename: "node.zip",
          size: 10,
          sha256: "abc",
          sourceUrl: "https://example.invalid/node.zip",
          downloadUrl: "/panel/runner-toolchain?file=node.zip"
        }
      ]
    })
  );
  return dir;
}

test("runner toolchain: JSON、HTML 与文件下载", async (t) => {
  const dir = setup(t);
  const json = await handleRunnerToolchainRequest(
    new URL("http://x/panel/runner-toolchain"),
    dir,
    "application/json"
  );
  assert.equal(json.status, 200);
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.entries[0].tool, "node");

  const html = await handleRunnerToolchainRequest(
    new URL("http://x/panel/runner-toolchain"),
    dir,
    "text/html"
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /Windows x64/);
  assert.match(html.body, /Node\.js/);

  const file = await handleRunnerToolchainRequest(
    new URL("http://x/panel/runner-toolchain?file=node.zip"),
    dir,
    "application/json"
  );
  assert.equal(file.status, 200);
  assert.equal(file.streamPath, path.join(dir, "files", "node.zip"));
  assert.equal(file.extraHeaders?.["Content-Disposition"], 'attachment; filename="node.zip"');

  const unknown = await handleRunnerToolchainRequest(
    new URL("http://x/panel/runner-toolchain?file=missing.zip"),
    dir,
    "application/json"
  );
  assert.equal(unknown.status, 404);
});

test("runner toolchain: 未构建返回 404", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-toolchain-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const response = await handleRunnerToolchainRequest(
    new URL("http://x/panel/runner-toolchain"),
    dir,
    "application/json"
  );
  assert.equal(response.status, 404);
});
