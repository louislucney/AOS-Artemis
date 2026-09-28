import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse as parseJsonc } from "jsonc-parser";

import { runInstall, upsertJsoncFile } from "../dist/install.js";
import { makeTempProject } from "./helpers.js";

const service = "/svc/dist/index.js";
const silent = () => {};

test("install local: writes all four project-level configs", () => {
  const dir = makeTempProject({});
  const code = runInstall(["--project", dir, "--service", service], { log: silent });
  assert.equal(code, 0);

  const claude = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(claude.mcpServers.aos.command, "node");
  assert.deepEqual(claude.mcpServers.aos.args, [service]);
  assert.equal(claude.mcpServers.aos.env.AOS_PROJECT_DIR, dir);

  const cursor = JSON.parse(fs.readFileSync(path.join(dir, ".cursor/mcp.json"), "utf-8"));
  assert.deepEqual(cursor.mcpServers.aos, claude.mcpServers.aos);

  const vscode = JSON.parse(fs.readFileSync(path.join(dir, ".vscode/mcp.json"), "utf-8"));
  assert.equal(vscode.servers.aos.command, "node");
  assert.deepEqual(vscode.servers.aos.args, [service]);

  const opencode = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf-8"));
  assert.equal(opencode.mcp.aos.type, "local");
  assert.deepEqual(opencode.mcp.aos.command, ["node", service]);
  assert.equal(opencode.mcp.aos.environment.AOS_PROJECT_DIR, dir);
  assert.equal(opencode.mcp.aos.enabled, true);
});

test("install local: idempotent (second run leaves files unchanged)", () => {
  const dir = makeTempProject({});
  runInstall(["--project", dir, "--service", service], { log: silent });
  const before = fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8");
  runInstall(["--project", dir, "--service", service], { log: silent });
  const after = fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8");
  assert.equal(before, after);
});

test("install local: preserves unrelated servers and comments", () => {
  const dir = makeTempProject({});
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    `{
  // keep this comment
  "mcpServers": {
    "other": { "command": "foo" }
  }
}\n`
  );
  runInstall(["--project", dir, "--targets", "claude", "--service", service], { log: silent });
  const text = fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8");
  assert.match(text, /keep this comment/);
  const parsed = parseJsonc(text);
  assert.equal(parsed.mcpServers.other.command, "foo");
  assert.equal(parsed.mcpServers.aos.command, "node");
});

test("install local: conflicting existing entry requires --force", () => {
  const dir = makeTempProject({});
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { aos: { command: "old" } } }, null, 2)
  );
  runInstall(["--project", dir, "--targets", "claude", "--service", service], { log: silent });
  let parsed = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(parsed.mcpServers.aos.command, "old");

  runInstall(
    ["--project", dir, "--targets", "claude", "--service", service, "--force"],
    { log: silent }
  );
  parsed = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(parsed.mcpServers.aos.command, "node");
});

test("install local: carries explicit tool-path env vars into client config", () => {
  const dir = makeTempProject({});
  const previousAdb = process.env.ARTEMIS_ADB_PATH;
  const previousDb = process.env.AOS_DATABASE_URL;
  process.env.ARTEMIS_ADB_PATH = "/opt/android/platform-tools/adb";
  process.env.AOS_DATABASE_URL = "postgres://u:p@127.0.0.1:5433/aos";
  try {
    runInstall(["--project", dir, "--targets", "claude", "--service", service], { log: silent });
    const claude = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
    assert.equal(
      claude.mcpServers.aos.env.ARTEMIS_ADB_PATH,
      "/opt/android/platform-tools/adb"
    );
    assert.equal(
      claude.mcpServers.aos.env.AOS_DATABASE_URL,
      "postgres://u:p@127.0.0.1:5433/aos"
    );
  } finally {
    if (previousAdb === undefined) delete process.env.ARTEMIS_ADB_PATH;
    else process.env.ARTEMIS_ADB_PATH = previousAdb;
    if (previousDb === undefined) delete process.env.AOS_DATABASE_URL;
    else process.env.AOS_DATABASE_URL = previousDb;
  }
});

test("install docker: docker exec with project workdir", () => {
  const dir = makeTempProject({});
  runInstall(
    ["--project", dir, "--targets", "opencode", "--mode", "docker", "--container", "aos-mcp-test"],
    { log: silent }
  );
  const opencode = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf-8"));
  const command = opencode.mcp.aos.command;
  assert.deepEqual(command.slice(0, 5), [
    "docker",
    "exec",
    "-i",
    "-w",
    `/workspace/${path.basename(dir)}`
  ]);
  assert.ok(command.includes("aos-mcp-test"));
  assert.ok(command.includes("/app/dist/index.js"));
});

test("install http: remote entries with per-project URL", () => {
  const dir = makeTempProject({});
  runInstall(["--project", dir, "--mode", "http", "--url", "http://10.0.0.5:8765/"], {
    log: silent
  });
  const claude = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(claude.mcpServers.aos.type, "http");
  assert.equal(
    claude.mcpServers.aos.url,
    `http://10.0.0.5:8765/mcp/${path.basename(dir)}`
  );

  const opencode = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf-8"));
  assert.equal(opencode.mcp.aos.type, "remote");
  assert.equal(opencode.mcp.aos.url, claude.mcpServers.aos.url);

  const vscode = JSON.parse(fs.readFileSync(path.join(dir, ".vscode/mcp.json"), "utf-8"));
  assert.equal(vscode.servers.aos.type, "http");
});

test("install: invalid JSONC leaves the file untouched", () => {
  const dir = makeTempProject({});
  const file = path.join(dir, ".mcp.json");
  fs.writeFileSync(file, "{ not json ");
  const status = upsertJsoncFile(file, ["mcpServers", "aos"], { command: "node" }, false);
  assert.equal(status, "invalid");
  assert.equal(fs.readFileSync(file, "utf-8"), "{ not json ");
});
