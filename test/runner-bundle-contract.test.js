import assert from "node:assert/strict";
import test from "node:test";

import { checkBundleFiles } from "../scripts/check-runner-bundle.mjs";

function validWinFiles() {
  return new Map([
    [
      "setup.cmd",
      [
        "@echo off",
        'set "AOS_LLM_FROM_CENTER=1"',
        'set "AOS_PEN_SKIP=1"',
        "node dist\\cli.js doctor --install-deps",
        ""
      ].join("\r\n")
    ],
    [
      "configure.cmd",
      [
        "set /p CENTER_URL=Center URL: ",
        "set /p CENTER_TOKEN=Runner token: ",
        "set /p HOST_ID=Host ID: ",
        ""
      ].join("\r\n")
    ],
    ["doctor.cmd", "node dist\\cli.js doctor\r\n"],
    ["runner.cmd", "node dist\\cli.js suite runner\r\n"],
    [
      "project/.env.example",
      [
        "MOBILE_TESTING_RUNNER_CONTROL_URL=http://center.example:8765",
        "MOBILE_TESTING_RUNNER_JOB_TOKEN=",
        "MOBILE_TESTING_HOST_ID=win-runner-01",
        ""
      ].join("\n")
    ],
    ["README.md", "LLM 由中心代理提供；runner 不填 key。\n"]
  ]);
}

test("runner bundle contract: valid Windows package passes", () => {
  const result = checkBundleFiles(validWinFiles(), "win32");
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("runner bundle contract: active LLM key in .env.example is rejected", () => {
  const files = validWinFiles();
  files.set(
    "project/.env.example",
    `${files.get("project/.env.example")}\nAOS_LLM_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n`
  );
  const result = checkBundleFiles(files, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("AOS_LLM_API_KEY")));
  assert.ok(result.errors.some((error) => error.includes("sk-")));
});

test("runner bundle contract: center project path in .env.example is rejected", () => {
  const files = validWinFiles();
  files.set(
    "project/.env.example",
    `${files.get("project/.env.example")}\nAOS_CENTER_PROJECT_ROOT=/Users/louis/Documents/AOS/ESSO-GU\n`
  );
  const result = checkBundleFiles(files, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("AOS_CENTER_PROJECT_ROOT")));
});

test("runner bundle contract: configure must not ask for a center project path", () => {
  const files = validWinFiles();
  files.set("configure.cmd", "set /p CENTER_ROOT=Center project root: \r\n");
  const result = checkBundleFiles(files, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("中心项目路径")));
});

test("runner bundle contract: setup must set center LLM and pen skip flags", () => {
  const files = validWinFiles();
  files.set("setup.cmd", "node dist\\cli.js doctor --install-deps\r\n");
  const result = checkBundleFiles(files, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("AOS_LLM_FROM_CENTER=1")));
  assert.ok(result.errors.some((error) => error.includes("AOS_PEN_SKIP=1")));
});

test("runner bundle contract: project/.env must not be packaged", () => {
  const files = validWinFiles();
  files.set("project/.env", "AOS_LLM_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n");
  const result = checkBundleFiles(files, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("project/.env")));
});

test("runner bundle contract: valid macOS package passes", () => {
  const files = new Map([
    [
      "setup.command",
      [
        "#!/bin/sh",
        "export AOS_LLM_FROM_CENTER=1",
        "export AOS_PEN_SKIP=1",
        "node dist/cli.js doctor --install-deps",
        ""
      ].join("\n")
    ],
    [
      "configure.command",
      ["printf \"Center URL: \"", "read CENTER_URL", "printf \"Runner token: \"", "read CENTER_TOKEN", ""].join("\n")
    ],
    ["doctor.command", "#!/bin/sh\nnode dist/cli.js doctor\n"],
    ["runner.command", "#!/bin/sh\nnode dist/cli.js suite runner\n"],
    [
      "project/.env.example",
      [
        "MOBILE_TESTING_RUNNER_CONTROL_URL=http://center.example:8765",
        "MOBILE_TESTING_RUNNER_JOB_TOKEN=",
        "MOBILE_TESTING_HOST_ID=mac-runner-01",
        ""
      ].join("\n")
    ],
    ["README.md", "LLM 由中心代理提供；runner 不填 key。\n"]
  ]);
  const result = checkBundleFiles(files, "darwin");
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("runner bundle contract: no direct PostgreSQL prompt", () => {
  const files = validWinFiles();
  files.set(
    "README.md",
    `${files.get("README.md")}\n直连中心 PG：MOBILE_TESTING_DATABASE_URL=postgres://center/db\n`
  );
  const result = checkBundleFiles(files, "win32");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("PostgreSQL")));
});
