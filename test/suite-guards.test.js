import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function runCli(runtime, args) {
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(args, {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line)
  });
  return { code, logs, errors };
}

test("suite guards: runner stays PG-only; backfill rejects memory but allows file ledger", async () => {
  const dir = makeTempProject({ config: baseConfig() });

  const memoryRuntime = await loadTestRuntime(dir, { store: new MemoryStore() });
  let result = await runCli(memoryRuntime.runtime, ["runner"]);
  assert.equal(result.code, 2);
  assert.ok(result.errors.join("\n").includes("需要中心 PG"));

  result = await runCli(memoryRuntime.runtime, ["backfill", "--dry-run"]);
  assert.equal(result.code, 2);
  assert.ok(result.errors.join("\n").includes("会话内存"));

  const ledgerHome = join(dir, ".ledger-home");
  await mkdir(ledgerHome, { recursive: true });
  const fileStore = await FileStore.create({ homeDir: ledgerHome });
  const fileRuntime = await loadTestRuntime(dir, { store: fileStore });

  result = await runCli(fileRuntime.runtime, ["runner"]);
  assert.equal(result.code, 2);
  assert.ok(result.errors.join("\n").includes("文件台账不支持多进程"));

  result = await runCli(fileRuntime.runtime, ["backfill", "--dry-run"]);
  assert.equal(result.code, 0);
});
