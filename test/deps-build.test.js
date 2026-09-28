import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { platformArch } from "../dist/artemis/bootstrap.js";
import { buildDepsBundle } from "../dist/deps-build.js";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeRepo() {
  const repo = tmp("aos-build-repo-");
  fs.writeFileSync(path.join(repo, "uv.lock"), "lock-content");
  const binDir = path.join(repo, ".venv", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "python"), "");
  return repo;
}

function fakeRunner({ syncCode = 0, calls = [] } = {}) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    if (cmd === "tar") {
      const result = spawnSync(cmd, args, { cwd: opts.cwd });
      return { code: result.status ?? 1, stdout: "", stderr: "" };
    }
    if (args[0] === "--version") return { code: 0, stdout: "uv 0.11.21\n", stderr: "" };
    if (args[0] === "-V") return { code: 0, stdout: "Python 3.12.13\n", stderr: "" };
    if (args[0] === "sync") {
      fs.mkdirSync(opts.env.UV_CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(opts.env.UV_CACHE_DIR, "marker.txt"), "cache-marker");
      if (opts.env.UV_PROJECT_ENVIRONMENT) {
        fs.mkdirSync(opts.env.UV_PROJECT_ENVIRONMENT, { recursive: true });
      }
      return { code: syncCode, stdout: "", stderr: syncCode ? "sync-boom" : "" };
    }
    if (cmd === "git") return { code: 128, stdout: "", stderr: "not a git repository" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("deps build: produces archive + manifest + stamp", async () => {
  const serviceRoot = tmp("aos-build-svc-");
  const repo = makeFakeRepo();
  const outDir = path.join(serviceRoot, "dist-deps");
  const calls = [];

  const result = await buildDepsBundle({
    serviceRoot,
    repoDir: repo,
    outDir,
    exec: fakeRunner({ calls }),
    log: () => {}
  });

  assert.ok(fs.existsSync(result.archive), result.archive);
  assert.ok(fs.existsSync(`${result.archive}.sha256`));
  assert.equal(
    fs.readFileSync(`${result.archive}.sha256`, "utf-8").trim(),
    result.sha256
  );

  const extract = tmp("aos-build-extract-");
  const tar = spawnSync("tar", ["-xzf", result.archive, "-C", extract]);
  assert.equal(tar.status, 0);

  const manifest = JSON.parse(fs.readFileSync(path.join(extract, "manifest.json"), "utf-8"));
  assert.equal(manifest.platform.os, process.platform);
  assert.equal(manifest.platform.arch, platformArch());
  assert.equal(manifest.pythonVersion, "3.12.13");
  assert.equal(manifest.uv, "0.11.21");
  assert.equal(manifest.artemisCommit, "unknown");
  assert.equal(
    manifest.lockSha256,
    createHash("sha256").update("lock-content").digest("hex")
  );
  assert.ok(fs.existsSync(path.join(extract, "uv-cache", "marker.txt")));

  const stamp = JSON.parse(
    fs.readFileSync(path.join(repo, ".venv", ".aos-deps.json"), "utf-8")
  );
  assert.equal(stamp.source.type, "local-build");
  assert.equal(stamp.lockSha256, manifest.lockSha256);

  const syncs = calls.filter((call) => call.args[0] === "sync");
  assert.equal(syncs.length, 2);
  assert.ok(syncs[0].env.UV_PROJECT_ENVIRONMENT, "first sync fills the cache via a build venv");
  assert.ok(syncs[0].env.UV_CACHE_DIR);
  assert.ok(syncs[1].env.UV_CACHE_DIR);
});

test("deps build: --skip-sync reuses an existing cache", async () => {
  const serviceRoot = tmp("aos-build-svc-");
  const repo = makeFakeRepo();
  const workDir = path.join(serviceRoot, "work");
  fs.mkdirSync(path.join(workDir, "uv-cache"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "uv-cache", "marker.txt"), "pre-existing");

  const calls = [];
  const result = await buildDepsBundle({
    serviceRoot,
    repoDir: repo,
    outDir: path.join(serviceRoot, "out"),
    workDir,
    skipSync: true,
    exec: fakeRunner({ calls }),
    log: () => {}
  });

  assert.equal(calls.filter((call) => call.args[0] === "sync").length, 0);
  const extract = tmp("aos-build-extract-");
  spawnSync("tar", ["-xzf", result.archive, "-C", extract]);
  assert.equal(
    fs.readFileSync(path.join(extract, "uv-cache", "marker.txt"), "utf-8"),
    "pre-existing"
  );
});

test("deps build: uv sync failure aborts with the output tail", async () => {
  const serviceRoot = tmp("aos-build-svc-");
  const repo = makeFakeRepo();
  await assert.rejects(
    () =>
      buildDepsBundle({
        serviceRoot,
        repoDir: repo,
        outDir: path.join(serviceRoot, "out"),
        exec: fakeRunner({ syncCode: 1 }),
        log: () => {}
      }),
    /uv sync 失败/
  );
});

test("deps build: missing uv.lock is rejected", async () => {
  const serviceRoot = tmp("aos-build-svc-");
  const repo = tmp("aos-build-empty-");
  await assert.rejects(
    () => buildDepsBundle({ serviceRoot, repoDir: repo, exec: fakeRunner(), log: () => {} }),
    /uv\.lock/
  );
});
