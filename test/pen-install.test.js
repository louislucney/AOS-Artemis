import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { managedPenBinPath } from "../dist/pen/cli.js";
import { ensurePenCli, penNodeTooOld } from "../dist/pen/install.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aos-pen-install-"));
}

function fakeExec({ onVersion, onNpm } = {}) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === "version") {
      if (onVersion) return onVersion({ command, args });
      return { code: null, stdout: "", stderr: "", error: "spawn pen ENOENT" };
    }
    if (args[0] === "install") {
      if (onNpm) return onNpm({ command, args, options });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  return { exec, calls };
}

function writeManagedBin(dir) {
  const bin = managedPenBinPath(dir, process.platform);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\n");
  return bin;
}

test("penNodeTooOld: 22.19 门槛", () => {
  assert.equal(penNodeTooOld("20.19.0"), true);
  assert.equal(penNodeTooOld("22.18.9"), true);
  assert.equal(penNodeTooOld("22.19.0"), false);
  assert.equal(penNodeTooOld("24.19.0"), false);
});

test("ensurePenCli: 显式路径与托管目录优先，不触发探测/安装", async () => {
  const explicit = await ensurePenCli({
    env: { AOS_PEN_CLI_PATH: "/opt/pen" },
    cliDir: tempDir(),
    exec: fakeExec().exec
  });
  assert.deepEqual(explicit, { ok: true, source: "env", path: "/opt/pen", installed: false });

  const dir = tempDir();
  const bin = writeManagedBin(dir);
  const { exec, calls } = fakeExec();
  const managed = await ensurePenCli({ env: {}, cliDir: dir, exec });
  assert.equal(managed.ok, true);
  assert.equal(managed.source, "managed");
  assert.equal(managed.path, bin);
  assert.equal(calls.length, 0);
});

test("ensurePenCli: PATH 已有 pen 时探测通过；缺失时自动安装到托管目录", async () => {
  const onVersion = async () => ({ code: 0, stdout: "pen 0.3.9\n", stderr: "" });
  const probe = fakeExec({ onVersion });
  const fromPath = await ensurePenCli({ env: {}, cliDir: tempDir(), exec: probe.exec });
  assert.equal(fromPath.ok, true);
  assert.equal(fromPath.source, "path");

  const dir = tempDir();
  const { exec, calls } = fakeExec({
    onNpm: () => {
      writeManagedBin(dir);
      return { code: 0, stdout: "added 1 package\n", stderr: "" };
    }
  });
  const installed = await ensurePenCli({ env: { AOS_PEN_VERSION: "0.3.9" }, cliDir: dir, exec, log: () => {} });
  assert.equal(installed.ok, true);
  assert.equal(installed.source, "installed");
  assert.equal(installed.installed, true);
  assert.equal(installed.path, managedPenBinPath(dir, process.platform));
  const npmCall = calls.find((call) => call.args[0] === "install");
  assert.ok(npmCall, "npm install 应被调用");
  assert.equal(npmCall.command, process.platform === "win32" ? "npm.cmd" : "npm");
  assert.ok(npmCall.args.includes("@pen.dev/cli@0.3.9"));
  assert.ok(npmCall.args.includes("--prefix"));
  assert.ok(npmCall.args.includes(dir));
});

test("ensurePenCli: 关闭自动安装、Node 门槛与失败冷却", async () => {
  const dir = tempDir();
  const blocked = await ensurePenCli({ env: {}, cliDir: dir, allowInstall: false, exec: fakeExec().exec });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /未安装/);

  const noInstallEnv = fakeExec();
  const disabled = await ensurePenCli({
    env: { AOS_PEN_NO_INSTALL: "1" },
    cliDir: tempDir(),
    exec: noInstallEnv.exec
  });
  assert.equal(disabled.ok, false);
  assert.equal(noInstallEnv.calls.length, 1, "仅探测一次，不安装");

  const oldNode = fakeExec();
  const gated = await ensurePenCli({ env: {}, cliDir: tempDir(), nodeVersion: "20.11.0", exec: oldNode.exec });
  assert.equal(gated.ok, false);
  assert.match(gated.error, /22\.19/);
  assert.equal(oldNode.calls.filter((call) => call.args[0] === "install").length, 0);

  const failDir = tempDir();
  const failing = fakeExec({ onNpm: () => ({ code: 1, stdout: "", stderr: "network down" }) });
  const first = await ensurePenCli({ env: {}, cliDir: failDir, exec: failing.exec, now: () => 1_000 });
  assert.equal(first.ok, false);
  assert.match(first.error, /自动安装失败/);
  const second = await ensurePenCli({ env: {}, cliDir: failDir, exec: failing.exec, now: () => 2_000 });
  assert.equal(second.ok, false);
  assert.match(second.error, /近期失败/);
  assert.equal(failing.calls.filter((call) => call.args[0] === "install").length, 1, "冷却期内不重试安装");
});
