import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { aosStatus } from "../dist/tools/llm.js";
import { isBuildStale } from "../dist/util.js";
import {
  baseConfig,
  loadTestRuntime,
  makeTempDir,
  makeTempProject,
  parseToolResult,
  StubProxy
} from "./helpers.js";

test("isBuildStale: compares module mtime against process start (with tolerance)", () => {
  const missing = pathToFileURL(path.join(makeTempDir("aos-stale-"), "missing.js")).href;
  assert.equal(isBuildStale(missing, Date.now()), false);

  const file = path.join(makeTempDir("aos-stale-"), "mod.js");
  fs.writeFileSync(file, "// module");
  const url = pathToFileURL(file).href;
  const mtime = fs.statSync(file).mtimeMs;

  assert.equal(isBuildStale(url, mtime - 10_000), true, "module newer than process start");
  assert.equal(isBuildStale(url, mtime + 10_000), false, "process start after module");
  assert.equal(isBuildStale(url, mtime - 1_000), false, "within tolerance window");

  fs.utimesSync(file, new Date(mtime + 60_000), new Date(mtime + 60_000));
  assert.equal(isBuildStale(url, mtime), true, "rebuilt after process start");
});

test("aos_status: exposes build freshness and stays fresh right after build", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await aosStatus(runtime));

  assert.equal(payload.ok, true);
  assert.equal(typeof payload.build.stale, "boolean");
  assert.equal(payload.build.stale, false, "test process starts after the build");
  assert.match(payload.build.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.build.note, undefined);
});

test("aos_status: stale 动态反映重建（不再缓存启动时的值）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const moduleFile = path.join(makeTempDir("aos-stale-mod-"), "runtime.js");
  fs.writeFileSync(moduleFile, "// module");
  const moduleUrl = pathToFileURL(moduleFile).href;
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy(), buildModuleUrl: moduleUrl });

  const before = parseToolResult(await aosStatus(runtime));
  assert.equal(before.build.stale, false);

  const mtime = fs.statSync(moduleFile).mtimeMs;
  fs.utimesSync(moduleFile, new Date(mtime + 60_000), new Date(mtime + 60_000));
  const after = parseToolResult(await aosStatus(runtime));
  assert.equal(after.build.stale, true, "同进程内重建 dist 后 stale 应为 true");
  assert.equal(typeof after.build.note, "string");
});
