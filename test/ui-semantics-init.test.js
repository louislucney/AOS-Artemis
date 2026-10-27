import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { initUiSemantics, UiSemanticsInitError } from "../dist/ui/semantics-init.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, SuiteProxy } from "./helpers.js";

function writeContract(root, screens = [{ id: "home", name: "首頁" }, { id: "detail", name: "詳情" }]) {
  const design = path.join(root, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "ui-contract.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: { fingerprint: "fp-contract" },
      screens,
      summary: { extracted: screens.length, partial: 0, unverifiable: 0, "no-baseline": 0 },
      warnings: []
    })
  );
  return design;
}

function initArgs(root, extra = {}) {
  return {
    contractPath: path.join(root, ".artemis", "design", "ui-contract.json"),
    outPath: path.join(root, ".artemis", "design", "ui-semantics.json"),
    contractRef: ".artemis/design/ui-contract.json",
    generatedAt: "2026-10-26T00:00:00.000Z",
    ...extra
  };
}

test("initUiSemantics writes a draft screen skeleton from contract", () => {
  const root = makeTempDir("aos-ui-semantics-init-");
  writeContract(root);
  const result = initUiSemantics(initArgs(root));
  assert.equal(result.created, true);
  assert.equal(result.screens, 2);
  assert.deepEqual(result.warnings, []);
  const file = JSON.parse(fs.readFileSync(result.path, "utf-8"));
  assert.equal(file.version, 1);
  assert.equal(file.draft, true);
  assert.equal(file.generatedAt, "2026-10-26T00:00:00.000Z");
  assert.equal(file.source.contract, ".artemis/design/ui-contract.json");
  assert.equal(file.source.contractFingerprint, "fp-contract");
  assert.deepEqual(
    file.screens.map((screen) => [screen.screenId, screen.screenName, screen.regions.length]),
    [
      ["home", "首頁", 0],
      ["detail", "詳情", 0]
    ]
  );
});

test("initUiSemantics refuses to overwrite without force, keeps .bak with force", () => {
  const root = makeTempDir("aos-ui-semantics-init-");
  writeContract(root);
  const first = initUiSemantics(initArgs(root));
  const original = fs.readFileSync(first.path, "utf-8");

  assert.throws(
    () => initUiSemantics(initArgs(root)),
    (error) =>
      error instanceof UiSemanticsInitError &&
      error.code === "exists" &&
      /already exists/.test(error.message)
  );
  assert.equal(fs.readFileSync(first.path, "utf-8"), original);

  const forced = initUiSemantics(initArgs(root, { force: true, generatedAt: "2026-10-27T00:00:00.000Z" }));
  assert.equal(forced.created, true);
  assert.equal(fs.existsSync(`${first.path}.bak`), true);
  assert.equal(fs.readFileSync(`${first.path}.bak`, "utf-8"), original);
  assert.equal(JSON.parse(fs.readFileSync(first.path, "utf-8")).generatedAt, "2026-10-27T00:00:00.000Z");
});

test("initUiSemantics fails closed on missing/bad contract and warns on empty screens", () => {
  const root = makeTempDir("aos-ui-semantics-init-");
  assert.throws(
    () => initUiSemantics(initArgs(root)),
    (error) => error instanceof UiSemanticsInitError && error.code === "contract-missing"
  );

  const design = writeContract(root, []);
  const empty = initUiSemantics(initArgs(root));
  assert.equal(empty.screens, 0);
  assert.equal(empty.warnings.length, 1);
  assert.match(empty.warnings[0], /no screens/);

  fs.writeFileSync(path.join(design, "ui-contract.json"), "{broken");
  assert.throws(
    () => initUiSemantics(initArgs(root)),
    (error) => error instanceof UiSemanticsInitError && error.code === "contract-invalid"
  );
});

test("suite ui-semantics init: JSON output, overwrite guard and force", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({}),
    store: new MemoryStore()
  });
  writeContract(dir);
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

  const first = await run(["ui-semantics", "init", "--json"]);
  assert.equal(first.code, 0, first.errors.join("\n"));
  const payload = JSON.parse(first.logs.join("\n"));
  assert.equal(payload.screens, 2);
  assert.equal(payload.created, true);
  assert.equal(payload.path, path.join(dir, ".artemis", "design", "ui-semantics.json"));
  assert.equal(fs.existsSync(payload.path), true);

  const second = await run(["ui-semantics", "init", "--json"]);
  assert.equal(second.code, 2);
  assert.ok(second.errors.some((line) => line.includes("already exists")));

  const forced = await run(["ui-semantics", "init", "--force", "--json"]);
  assert.equal(forced.code, 0);
  assert.ok(fs.existsSync(`${payload.path}.bak`));

  const missing = await run(["ui-semantics", "init", "--contract", ".artemis/design/missing.json", "--json"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("missing")));

  const badAction = await run(["ui-semantics", "nope"]);
  assert.equal(badAction.code, 2);
});

test("suite help mentions ui-semantics", async () => {
  const logs = [];
  const code = await runSuiteCommand(["help"], { log: (line) => logs.push(line) });
  assert.equal(code, 0);
  assert.ok(logs.some((line) => line.includes("ui-semantics init")));
});
