import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProject, resolveProject } from "../dist/config/loader.js";
import { baseConfig, makeTempProject } from "./helpers.js";

test("discovery: AOS_CONFIG wins over cwd", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const other = makeTempProject({ config: baseConfig() });
  const resolution = resolveProject({
    env: { AOS_CONFIG: path.join(dir, "aos.config.jsonc") },
    cwd: other
  });
  assert.equal(resolution.rootDir, dir);
  assert.equal(resolution.configPath, path.join(dir, "aos.config.jsonc"));
});

test("discovery: AOS_PROJECT_DIR is honored", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const resolution = resolveProject({ env: { AOS_PROJECT_DIR: dir }, cwd: os.tmpdir() });
  assert.equal(resolution.rootDir, dir);
  assert.equal(resolution.configPath, path.join(dir, "aos.config.jsonc"));
});

test("discovery: AOS_PROJECT_DIR without config yields null config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-mcp-noconfig-"));
  const resolution = resolveProject({ env: { AOS_PROJECT_DIR: dir }, cwd: os.tmpdir() });
  assert.equal(resolution.rootDir, dir);
  assert.equal(resolution.configPath, null);
});

test("discovery: walks upward from cwd", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const nested = path.join(dir, "apps", "nested");
  fs.mkdirSync(nested, { recursive: true });
  const resolution = resolveProject({ env: {}, cwd: nested });
  assert.equal(resolution.rootDir, dir);
  assert.equal(resolution.configPath, path.join(dir, "aos.config.jsonc"));
});

test("jsonc comments and trailing commas parse", () => {
  const raw = `{
    // a comment
    "llm": {
      "profiles": { "p": { "provider": "openai", "model": "gpt-4o" }, },
    },
    "artemis": { "repo": "../a" },
  }`;
  const dir = makeTempProject({ config: raw });
  const project = loadProject({ cwd: dir, env: {} });
  assert.equal(project.config.llm.profiles.p.provider, "openai");
  assert.equal(path.isAbsolute(project.config.artemis.repo), true);
  assert.equal(project.config.artemis.configDir, ".artemis");
});

test("missing config is optional: project resolves with null config", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aos-mcp-empty-"));
  const project = loadProject({ cwd: empty, env: { AOS_PROJECT_DIR: empty } });
  assert.equal(project.configPath, null);
  assert.equal(Object.keys(project.config.llm.profiles).length, 0);
  assert.ok(path.isAbsolute(project.config.artemis.repo));
  assert.equal(project.config.artemis.configDir, ".artemis");
});

test("process env wins over dotenv for key resolution", () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "GEMINI_API_KEY=from-dotenv-123456\n"
  });
  const project = loadProject({
    cwd: dir,
    env: { GEMINI_API_KEY: "from-env-abcdef" }
  });
  const hit = project.resolver.getValue("GEMINI_API_KEY");
  assert.equal(hit.value, "from-env-abcdef");
  assert.equal(hit.source, "env");

  const project2 = loadProject({ cwd: dir, env: {} });
  const hit2 = project2.resolver.getValue("GEMINI_API_KEY");
  assert.equal(hit2.value, "from-dotenv-123456");
  assert.equal(hit2.source, "dotenv");
});

test("invalid jsonc reports parse error", () => {
  const dir = makeTempProject({ config: '{ "llm": ' });
  assert.throws(() => loadProject({ cwd: dir, env: {} }), /Invalid JSONC/);
});
