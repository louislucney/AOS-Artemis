import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse as parseJsonc } from "jsonc-parser";

import { runInstall, upsertJsoncFile } from "../dist/install.js";
import { makeTempProject } from "./helpers.js";

const service = "/svc/dist/index.js";
const SERVER = "mobile-testing";
const silent = () => {};

test("install local: writes all four project-level configs", () => {
  const dir = makeTempProject({});
  const code = runInstall(["--project", dir, "--service", service], { log: silent });
  assert.equal(code, 0);

  const claude = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(claude.mcpServers[SERVER].command, "node");
  assert.deepEqual(claude.mcpServers[SERVER].args, [path.resolve(service)]);
  assert.equal(claude.mcpServers[SERVER].env.AOS_PROJECT_DIR, dir);

  const cursor = JSON.parse(fs.readFileSync(path.join(dir, ".cursor/mcp.json"), "utf-8"));
  assert.deepEqual(cursor.mcpServers[SERVER], claude.mcpServers[SERVER]);

  const vscode = JSON.parse(fs.readFileSync(path.join(dir, ".vscode/mcp.json"), "utf-8"));
  assert.equal(vscode.servers[SERVER].command, "node");
  assert.deepEqual(vscode.servers[SERVER].args, [path.resolve(service)]);

  const opencode = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf-8"));
  assert.equal(opencode.mcp[SERVER].type, "local");
  assert.deepEqual(opencode.mcp[SERVER].command, ["node", path.resolve(service)]);
  assert.equal(opencode.mcp[SERVER].environment.AOS_PROJECT_DIR, dir);
  assert.equal(opencode.mcp[SERVER].enabled, true);
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
  assert.equal(parsed.mcpServers[SERVER].command, "node");
});

test("install local: conflicting existing entry requires --force", () => {
  const dir = makeTempProject({});
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { [SERVER]: { command: "old" } } }, null, 2)
  );
  runInstall(["--project", dir, "--targets", "claude", "--service", service], { log: silent });
  let parsed = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(parsed.mcpServers[SERVER].command, "old");

  runInstall(
    ["--project", dir, "--targets", "claude", "--service", service, "--force"],
    { log: silent }
  );
  parsed = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(parsed.mcpServers[SERVER].command, "node");
});

test("install local: removes legacy aos and android-testing entries", () => {
  const dir = makeTempProject({});
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          aos: { command: "node", args: ["legacy.js"] },
          "android-testing": { command: "node", args: ["older.js"] },
          other: { command: "foo" }
        }
      },
      null,
      2
    )
  );
  runInstall(["--project", dir, "--targets", "claude", "--service", service], { log: silent });
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
  assert.equal(parsed.mcpServers.aos, undefined);
  assert.equal(parsed.mcpServers["android-testing"], undefined);
  assert.equal(parsed.mcpServers.other.command, "foo");
  assert.equal(parsed.mcpServers[SERVER].command, "node");
});

test("install local: carries explicit tool-path env vars into client config", () => {
  const dir = makeTempProject({});
  const previousAdb = process.env.ARTEMIS_ADB_PATH;
  const previousDb = process.env.AOS_DATABASE_URL;
  const previousProxy = process.env.NODE_USE_ENV_PROXY;
  process.env.ARTEMIS_ADB_PATH = "/opt/android/platform-tools/adb";
  process.env.AOS_DATABASE_URL = "postgres://u:p@127.0.0.1:5433/aos";
  process.env.NODE_USE_ENV_PROXY = "1";
  try {
    runInstall(["--project", dir, "--targets", "claude", "--service", service], { log: silent });
    const claude = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
    assert.equal(
      claude.mcpServers[SERVER].env.ARTEMIS_ADB_PATH,
      "/opt/android/platform-tools/adb"
    );
    assert.equal(
      claude.mcpServers[SERVER].env.AOS_DATABASE_URL,
      "postgres://u:p@127.0.0.1:5433/aos"
    );
    assert.equal(claude.mcpServers[SERVER].env.NODE_USE_ENV_PROXY, "1");
  } finally {
    if (previousAdb === undefined) delete process.env.ARTEMIS_ADB_PATH;
    else process.env.ARTEMIS_ADB_PATH = previousAdb;
    if (previousDb === undefined) delete process.env.AOS_DATABASE_URL;
    else process.env.AOS_DATABASE_URL = previousDb;
    if (previousProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = previousProxy;
  }
});

test("install docker: docker exec with project workdir", () => {
  const dir = makeTempProject({});
  runInstall(
    ["--project", dir, "--targets", "opencode", "--mode", "docker", "--container", "aos-mcp-test"],
    { log: silent }
  );
  const opencode = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf-8"));
  const command = opencode.mcp[SERVER].command;
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
  assert.equal(claude.mcpServers[SERVER].type, "http");
  assert.equal(
    claude.mcpServers[SERVER].url,
    `http://10.0.0.5:8765/mcp/${path.basename(dir)}`
  );

  const opencode = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf-8"));
  assert.equal(opencode.mcp[SERVER].type, "remote");
  assert.equal(opencode.mcp[SERVER].url, claude.mcpServers[SERVER].url);

  const vscode = JSON.parse(fs.readFileSync(path.join(dir, ".vscode/mcp.json"), "utf-8"));
  assert.equal(vscode.servers[SERVER].type, "http");
});

test("install: invalid JSONC leaves the file untouched", () => {
  const dir = makeTempProject({});
  const file = path.join(dir, ".mcp.json");
  fs.writeFileSync(file, "{ not json ");
  const status = upsertJsoncFile(file, ["mcpServers", SERVER], { command: "node" }, false);
  assert.equal(status, "invalid");
  assert.equal(fs.readFileSync(file, "utf-8"), "{ not json ");
});

test("install docker: Codex snippet keeps command out of args", () => {
  const dir = makeTempProject({});
  const lines = [];
  runInstall(
    ["--project", dir, "--targets", "opencode", "--mode", "docker", "--container", "aos-mcp-test"],
    { log: (line) => lines.push(line) }
  );
  const argsLine = lines.find((line) => line.trim().startsWith("args = "));
  assert.ok(argsLine, "Codex snippet lists args");
  const args = JSON.parse(argsLine.trim().slice("args = ".length));
  assert.equal(args[0], "exec");
  assert.ok(!args.includes("docker"));
  assert.ok(args.includes("aos-mcp-test"));
});


test("install --help: prints usage, writes nothing, exits 0", () => {
  const dir = makeTempProject({});
  const logs = [];
  const code = runInstall(["--project", dir, "--help"], { log: (line) => logs.push(line) });
  assert.equal(code, 0);
  assert.ok(logs.some((line) => line.includes("Usage:")));
  assert.ok(logs.some((line) => line.includes("--targets")));
  assert.equal(fs.existsSync(path.join(dir, "opencode.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".mcp.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".cursor")), false);
});

test("install: unknown flags and invalid values fail fast without writing", () => {
  const dir = makeTempProject({});
  const logs = [];
  const log = (line) => logs.push(line);

  assert.equal(runInstall(["--project", dir, "--bogus"], { log }), 1);
  assert.ok(logs.some((line) => line.includes("未知参数 --bogus")));

  assert.equal(runInstall(["--project", dir, "--targets", "claude,foo"], { log }), 1);
  assert.ok(logs.some((line) => line.includes("未知 target: foo")));

  assert.equal(runInstall(["--project", dir, "--mode", "cloud"], { log }), 1);
  assert.ok(logs.some((line) => line.includes("未知 mode: cloud")));

  assert.equal(runInstall(["--project"], { log }), 1);
  assert.ok(logs.some((line) => line.includes("--project 需要值")));

  assert.equal(fs.existsSync(path.join(dir, "opencode.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".mcp.json")), false);
});
