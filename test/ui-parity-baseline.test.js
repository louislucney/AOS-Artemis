import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  baselineEntryKey,
  loadUiParityBaseline,
  partitionByBaseline,
  writeUiParityBaseline
} from "../dist/ui/parity-baseline.js";
import { makeTempDir } from "./helpers.js";

test("baselineEntryKey is stable, normalized and role-aware", () => {
  const a = baselineEntryKey({
    tool: "ui-parity",
    screenId: "Home",
    kind: "missing-invariant",
    text: " 咖啡飲品 ",
    role: "category-list"
  });
  const b = baselineEntryKey({
    tool: "ui-parity",
    screenId: "home",
    kind: "missing-invariant",
    text: "咖啡飲品",
    role: "category-list"
  });
  assert.equal(a, b);
  assert.notEqual(
    a,
    baselineEntryKey({
      tool: "ui-parity",
      screenId: "home",
      kind: "missing-invariant",
      text: "咖啡飲品",
      role: "header"
    })
  );
});

test("loadUiParityBaseline returns errors for missing/invalid files", () => {
  const root = makeTempDir("aos-ui-baseline-");
  const missing = loadUiParityBaseline(path.join(root, "missing.json"));
  assert.ok(missing.errors.length > 0);
  assert.match(missing.errors[0], /not found/);

  const broken = path.join(root, "broken.json");
  fs.writeFileSync(broken, "{broken");
  const invalid = loadUiParityBaseline(broken);
  assert.ok(invalid.errors.length > 0);

  const wrongVersion = path.join(root, "wrong.json");
  fs.writeFileSync(wrongVersion, JSON.stringify({ version: 2, entries: [] }));
  assert.ok(loadUiParityBaseline(wrongVersion).errors.length > 0);
});

test("writeUiParityBaseline is atomic, deduplicated and sorted", () => {
  const root = makeTempDir("aos-ui-baseline-");
  const file = path.join(root, "nested", "ui-parity-baseline.json");
  const entries = [
    { tool: "ui-parity", screenId: "home", kind: "truncated-label", text: "每日精選咖啡" },
    { tool: "ui-parity", screenId: "home", kind: "truncated-label", text: "每日精選咖啡" },
    { tool: "ui-parity", screenId: "home", kind: "missing-invariant", text: "咖啡飲品" }
  ];
  writeUiParityBaseline(file, entries);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.text),
    ["咖啡飲品", "每日精選咖啡"]
  );
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("partitionByBaseline suppresses only matching keys", () => {
  const file = {
    version: 1,
    entries: [
      {
        tool: "ui-parity",
        screenId: "home",
        kind: "missing-invariant",
        text: "咖啡飲品",
        role: "category-list"
      }
    ]
  };
  const findings = [
    {
      kind: "missing-invariant",
      severity: "error",
      text: "缺少设计元素：咖啡飲品",
      designText: "咖啡飲品",
      role: "category-list"
    },
    {
      kind: "truncated-label",
      severity: "error",
      text: "分类/标签被截断：每日精選咖啡",
      designText: "每日精選咖啡",
      runtimeText: "每...咖啡",
      role: "category-list"
    }
  ];
  const result = partitionByBaseline(findings, file, { screenId: "home", tool: "ui-parity" });
  assert.equal(result.baselined.length, 1);
  assert.equal(result.baselined[0].designText, "咖啡飲品");
  assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].designText, "每日精選咖啡");
});
