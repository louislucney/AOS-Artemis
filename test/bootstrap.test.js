import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  depsStatus,
  ensureArtemisDeps,
  hasVenv,
  readDepsStamp,
  resolveDepsSource
} from "../dist/artemis/bootstrap.js";

const silent = () => {};

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function lockShaOf(repo) {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(repo, "uv.lock")))
    .digest("hex");
}

function makeRepo({ withVenv = false, stamp = null, lockContent = "lock-content" } = {}) {
  const repo = tmp("aos-dep-repo-");
  fs.writeFileSync(path.join(repo, "uv.lock"), lockContent);
  if (withVenv) {
    const binDir = path.join(repo, ".venv", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "python"), "#!/bin/sh\n");
  }
  if (stamp) {
    fs.writeFileSync(
      path.join(repo, ".venv", ".aos-deps.json"),
      JSON.stringify(stamp, null, 2)
    );
  }
  return repo;
}

function currentArch() {
  return process.arch === "x64" ? "x86_64" : process.arch;
}

function makeBundle({ os = process.platform, arch = currentArch(), lockSha = null } = {}) {
  const root = tmp("aos-dep-bundle-");
  fs.mkdirSync(path.join(root, "uv-cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "uv-cache", "marker.txt"), "cache-marker");
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      schema: 1,
      platform: { os, arch },
      pythonVersion: "3.12.14",
      uv: "0.11.21",
      lockSha256: lockSha,
      createdAt: new Date().toISOString()
    })
  );
  const archive = path.join(root, "bundle.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", root, "uv-cache", "manifest.json"]);
  assert.equal(packed.status, 0);
  const sha = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  return { archive, sha };
}

/** Real tar extraction; uv commands are stubbed.
 * offlineCode/onlineCode control the two sync flavors; probe uses offline. */
function makeExec({ offlineCode = 0, onlineCode = 0, record } = {}) {
  return async (cmd, args, opts) => {
    record?.push({ cmd, args, env: opts.env });
    if (cmd === "tar") {
      const result = spawnSync(cmd, args, { cwd: opts.cwd });
      return { code: result.status ?? 1, stderrTail: "" };
    }
    if (args[0] === "--version") return { code: 0, stderrTail: "" };
    if (args[0] === "python") return { code: 0, stderrTail: "" };
    if (args[0] === "sync") {
      const offline = args.includes("--offline");
      const code = offline ? offlineCode : onlineCode;
      if (code === 0) {
        const binDir = path.join(opts.cwd, ".venv", "bin");
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, "python"), "#!/bin/sh\n");
      }
      return { code, stderrTail: code ? (offline ? "offline-boom" : "online-boom") : "" };
    }
    return { code: 0, stderrTail: "" };
  };
}

test("deps: missing venv + no source → skipped with guidance", async () => {
  const repo = makeRepo();
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: null,
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec(),
    log: silent
  });
  assert.equal(result.status, "skipped");
  assert.match(result.message, /uv sync/);
  assert.equal(depsStatus(repo).status, "missing");
});

test("deps: unmanaged venv is adopted when the offline probe succeeds", async () => {
  const repo = makeRepo({ withVenv: true });
  const calls = [];
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: null,
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec({ record: calls }),
    log: silent
  });
  assert.equal(result.status, "ready");
  assert.match(result.message, /纳入托管/);
  const stamp = readDepsStamp(repo);
  assert.equal(stamp.source.type, "adopted");
  assert.equal(stamp.lockSha256, lockShaOf(repo));
  assert.ok(calls.some((call) => call.args.includes("--offline")));
});

test("deps: ready stamp short-circuits without running uv", async () => {
  const repo = makeRepo({ withVenv: true });
  fs.writeFileSync(
    path.join(repo, ".venv", ".aos-deps.json"),
    JSON.stringify({
      schema: 1,
      lockSha256: lockShaOf(repo),
      source: { type: "bundle" },
      installedAt: new Date().toISOString()
    })
  );
  const calls = [];
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: null,
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec({ record: calls }),
    log: silent
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 0);
  assert.equal(depsStatus(repo).status, "ready");
});

test("deps: stale venv + fresh bundle → offline update and stamp rewrite", async () => {
  const repo = makeRepo({
    withVenv: true,
    stamp: {
      schema: 1,
      lockSha256: "old-lock-sha",
      source: { type: "bundle" },
      installedAt: new Date().toISOString()
    }
  });
  assert.equal(depsStatus(repo).status, "stale");
  const { archive, sha } = makeBundle({ lockSha: lockShaOf(repo) });
  const calls = [];
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec({ record: calls }),
    log: silent
  });
  assert.equal(result.status, "installed", result.message);
  const stamp = readDepsStamp(repo);
  assert.equal(stamp.source.type, "bundle");
  assert.equal(stamp.lockSha256, lockShaOf(repo));
  const sync = calls.find((call) => call.args[0] === "sync" && call.args.includes("--offline"));
  assert.ok(sync, "expected an offline sync");
  assert.equal(depsStatus(repo).status, "ready");
});

test("deps: stale venv + outdated bundle → online fallback (allowed by default)", async () => {
  const repo = makeRepo({
    withVenv: true,
    stamp: {
      schema: 1,
      lockSha256: "old-lock-sha",
      source: { type: "bundle" },
      installedAt: new Date().toISOString()
    }
  });
  const { archive, sha } = makeBundle({ lockSha: "bundle-old-lock-sha" });
  const calls = [];
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec({ record: calls }),
    log: silent
  });
  assert.equal(result.status, "installed", result.message);
  assert.match(result.message, /依赖包已过期/);
  const online = calls.find((call) => call.args[0] === "sync" && !call.args.includes("--offline"));
  assert.ok(online, "expected an online sync fallback");
  assert.equal(readDepsStamp(repo).source.type, "online");
});

test("deps: outdated bundle + AOS_DEPS_NO_ONLINE → hard failure", async () => {
  const repo = makeRepo({
    withVenv: true,
    stamp: {
      schema: 1,
      lockSha256: "old-lock-sha",
      source: { type: "bundle" },
      installedAt: new Date().toISOString()
    }
  });
  const { archive, sha } = makeBundle({ lockSha: "bundle-old-lock-sha" });
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    allowOnline: false,
    exec: makeExec(),
    log: silent
  });
  assert.equal(result.status, "failed");
  assert.match(result.message, /已禁用在线回退/);
  assert.match(result.message, /artemis-deps\.sh build/);
});

test("deps: offline install failure falls back to online when allowed", async () => {
  const repo = makeRepo();
  const { archive, sha } = makeBundle({ lockSha: lockShaOf(repo) });
  const calls = [];
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec({ offlineCode: 1, onlineCode: 0, record: calls }),
    log: silent
  });
  assert.equal(result.status, "installed", result.message);
  const offline = calls.find((call) => call.args[0] === "sync" && call.args.includes("--offline"));
  const online = calls.find((call) => call.args[0] === "sync" && !call.args.includes("--offline"));
  assert.ok(offline, "offline attempt expected");
  assert.ok(online, "online fallback expected");
});

test("deps: offline failure + AOS_DEPS_NO_ONLINE → hard failure", async () => {
  const repo = makeRepo();
  const { archive, sha } = makeBundle({ lockSha: lockShaOf(repo) });
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    allowOnline: false,
    exec: makeExec({ offlineCode: 1 }),
    log: silent
  });
  assert.equal(result.status, "failed");
  assert.match(result.message, /离线安装失败/);
});

test("deps: install from a local bundle writes a bundle stamp", async () => {
  const repo = makeRepo();
  const { archive, sha } = makeBundle({ lockSha: lockShaOf(repo) });
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec(),
    log: silent
  });
  assert.equal(result.status, "installed", result.message);
  assert.equal(hasVenv(repo), true);
  const stamp = readDepsStamp(repo);
  assert.equal(stamp.source.type, "bundle");
  assert.equal(stamp.source.sha256, sha);
  assert.equal(stamp.lockSha256, lockShaOf(repo));
});

test("deps: sha256 mismatch fails before any uv/tar work", async () => {
  const repo = makeRepo();
  const { archive } = makeBundle();
  const calls = [];
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: "deadbeef" },
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec({ record: calls }),
    log: silent
  });
  assert.equal(result.status, "failed");
  assert.match(result.message, /校验失败/);
  assert.equal(
    calls.filter((call) => call.args[0] === "sync" || call.cmd === "tar").length,
    0
  );
});

test("deps: platform mismatch is rejected with a clear message", async () => {
  const repo = makeRepo();
  const { archive, sha } = makeBundle({ os: "linux", arch: "x86_64" });
  const result = await ensureArtemisDeps({
    repoDir: repo,
    source: { url: archive, sha256: sha },
    cacheRoot: tmp("aos-dep-cache-"),
    exec: makeExec(),
    log: silent
  });
  if (process.platform === "linux" && currentArch() === "x86_64") {
    assert.notEqual(result.status, "failed");
  } else {
    assert.equal(result.status, "failed");
    assert.match(result.message, /平台不匹配/);
  }
});

test("deps: resolveDepsSource prefers env over config", () => {
  const config = {
    llm: { profiles: {} },
    artemis: { repo: "", depsUrl: "https://cfg/bundle.tar.gz", depsSha256: "cfg-sha" }
  };
  assert.deepEqual(resolveDepsSource(config, {}), {
    url: "https://cfg/bundle.tar.gz",
    sha256: "cfg-sha"
  });
  assert.deepEqual(
    resolveDepsSource(config, {
      AOS_ARTEMIS_DEPS_URL: "https://env/bundle.tar.gz",
      AOS_ARTEMIS_DEPS_SHA256: "env-sha"
    }),
    { url: "https://env/bundle.tar.gz", sha256: "env-sha" }
  );
  assert.equal(resolveDepsSource({ llm: { profiles: {} }, artemis: { repo: "" } }, {}), null);
});
