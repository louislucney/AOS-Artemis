import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { runUiLint } from "../dist/ui/lint.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, SuiteProxy } from "./helpers.js";

function writeContract(root, radii = [12, 16]) {
  const design = path.join(root, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "ui-contract.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: { fingerprint: "fp-test" },
      screens: [{ id: "home", name: "Home", tokens: { cornerRadius: radii } }],
      summary: { extracted: 1, partial: 0, unverifiable: 0, "no-baseline": 0 },
      warnings: []
    })
  );
  return design;
}

function writeSource(root, file, content) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

test("ui-lint: contract radii pass, unregistered literal fails", () => {
  const root = makeTempDir("aos-ui-lint-");
  writeContract(root);
  writeSource(root, "app/src/Main.kt", "val ok = RoundedCornerShape(12.dp)\nval bad = RoundedCornerShape(99.dp)\n");
  const report = runUiLint({ rootDir: root });
  assert.equal(report.ok, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].file, "app/src/Main.kt");
  assert.equal(report.findings[0].value, 99);
  assert.equal(report.findings[0].line, 2);
  assert.deepEqual(report.contract.radii, [0, 12, 16]);
  assert.equal(report.allowlisted, 0);
});

test("ui-lint: allowlist with owner/reason/expiry suppresses finding", () => {
  const root = makeTempDir("aos-ui-lint-allow-");
  const design = writeContract(root);
  writeSource(root, "app/src/Main.kt", "val bad = RoundedCornerShape(99.dp)\n");
  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Main.kt",
          value: 99,
          owner: "qa",
          reason: "legacy card",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const report = runUiLint({ rootDir: root });
  assert.equal(report.ok, true);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].allowlisted, true);
  assert.equal(report.allowlisted, 1);

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Main.kt",
          value: 99,
          owner: "qa",
          reason: "legacy card",
          expiresAt: "2000-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const expired = runUiLint({ rootDir: root });
  assert.equal(expired.ok, false);
  assert.equal(expired.findings[0].allowlisted, false);
  assert.match(expired.warnings.join("\n"), /已过期/);
});

test("ui-lint: missing contract is a hard error", () => {
  const root = makeTempDir("aos-ui-lint-missing-");
  assert.throws(() => runUiLint({ rootDir: root }), /ui-contract/);
});

test("ui-lint: --changed only scans working tree changes", () => {
  const root = makeTempDir("aos-ui-lint-changed-");
  writeContract(root);
  writeSource(root, "app/src/A.kt", "val a = RoundedCornerShape(12.dp)\n");
  writeSource(root, "app/src/B.kt", "val b = RoundedCornerShape(99.dp)\n");
  const git = (args) =>
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
      cwd: root,
      stdio: "ignore"
    });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  writeSource(root, "app/src/A.kt", "val a = RoundedCornerShape(99.dp)\n");
  const all = runUiLint({ rootDir: root });
  assert.equal(all.findings.length, 2, "全量扫描同时命中 A/B");
  const changed = runUiLint({ rootDir: root, changed: true });
  assert.equal(changed.findings.length, 1);
  assert.equal(changed.findings[0].file, "app/src/A.kt");
  assert.equal(changed.scanned.files, 1);

  const outside = makeTempDir("aos-ui-lint-nogit-");
  writeContract(outside);
  writeSource(outside, "app/src/A.kt", "val a = RoundedCornerShape(99.dp)\n");
  assert.throws(() => runUiLint({ rootDir: outside, changed: true }), /git 仓库/);
});

test("suite ui-lint: CLI JSON + exit 1/0 + missing contract exit 2", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({}),
    store: new MemoryStore()
  });
  const design = writeContract(dir);
  writeSource(dir, "app/src/Main.kt", "val bad = RoundedCornerShape(99.dp)\n");
  const run = async (args) => {
    const logs = [];
    const errors = [];
    const code = await runSuiteCommand(args, {
      buildRuntime: async () => ({ runtime, dispose: async () => {} }),
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line)
    });
    return { code, logs, errors };
  };

  const first = await run(["ui-lint", "--json"]);
  assert.equal(first.code, 1);
  const payload = JSON.parse(first.logs.join("\n"));
  assert.equal(payload.ok, false);
  assert.equal(payload.findings[0].value, 99);

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Main.kt",
          value: 99,
          owner: "qa",
          reason: "legacy",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const allowed = await run(["ui-lint", "--json"]);
  assert.equal(allowed.code, 0);
  assert.equal(JSON.parse(allowed.logs.join("\n")).allowlisted, 1);

  fs.rmSync(path.join(design, "ui-contract.json"));
  const missing = await run(["ui-lint"]);
  assert.equal(missing.code, 2);
  assert.match(missing.errors.join("\n"), /ui-contract/);
});
