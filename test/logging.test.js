import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import {
  appendChildLog,
  closeLogging,
  configureLogging,
  log,
  logDebug
} from "../dist/log.js";

function tmp() {
  return makeTempDir("aos-log-");
}

test("logger: writes timestamped leveled lines to the file sink", () => {
  const dir = tmp();
  const file = configureLogging({ logDir: dir, echo: false, level: "info" });
  assert.equal(file, path.join(dir, "aos-mcp.log"));

  log("hello 世界");
  logDebug("hidden at info level");
  log("careful", "warn");

  const content = fs.readFileSync(file, "utf-8");
  assert.match(content, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO {2}\[aos-mcp\] hello 世界$/m);
  assert.match(content, /WARN {2}\[aos-mcp\] careful/m);
  assert.ok(!content.includes("hidden at info level"));
  closeLogging();
});

test("logger: debug level reveals debug lines", () => {
  const dir = tmp();
  configureLogging({ logDir: dir, echo: false, level: "debug" });
  logDebug("visible now");
  assert.match(
    fs.readFileSync(path.join(dir, "aos-mcp.log"), "utf-8"),
    /DEBUG \[aos-mcp\] visible now/
  );
  closeLogging();
});

test("logger: child stderr goes to its own file", () => {
  const dir = tmp();
  configureLogging({ logDir: dir, echo: false });
  appendChildLog("child says hi");
  assert.match(
    fs.readFileSync(path.join(dir, "artemis-child.log"), "utf-8"),
    /\[artemis\] child says hi/
  );
  closeLogging();
});

test("logger: rotates to .1 when the file exceeds maxBytes", () => {
  const dir = tmp();
  const file = path.join(dir, "aos-mcp.log");
  fs.writeFileSync(file, "x".repeat(100));

  configureLogging({ logDir: dir, echo: false, maxBytes: 50 });
  log("after rotation");

  assert.ok(fs.existsSync(`${file}.1`), "expected rotation backup");
  assert.ok(!fs.readFileSync(file, "utf-8").includes("xxxx"));
  assert.match(fs.readFileSync(file, "utf-8"), /after rotation/);
  closeLogging();
});

test("logger: file sink can be disabled via AOS_LOG_DISABLE_FILE", () => {
  const previous = process.env.AOS_LOG_DISABLE_FILE;
  process.env.AOS_LOG_DISABLE_FILE = "1";
  try {
    const dir = tmp();
    const file = configureLogging({ logDir: dir, echo: false });
    assert.equal(file, null);
    log("no sink");
    assert.ok(!fs.existsSync(path.join(dir, "aos-mcp.log")));
    closeLogging();
  } finally {
    if (previous === undefined) delete process.env.AOS_LOG_DISABLE_FILE;
    else process.env.AOS_LOG_DISABLE_FILE = previous;
  }
});
