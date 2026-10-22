import assert from "node:assert/strict";
import test from "node:test";

import { FIGMA_NATIVE_TOOLS } from "../dist/tools/native-tools/figma.js";

function schemaOf(name) {
  const tool = FIGMA_NATIVE_TOOLS.find((entry) => entry.name === name);
  assert.ok(tool, `${name} defined`);
  return tool.schema;
}

test("figma_generate_tests: maxFlows 上限 1000（大体量视觉探索路径需全量收敛）", () => {
  const schema = schemaOf("figma_generate_tests");
  assert.equal(schema.safeParse({ maxFlows: 300 }).success, true);
  assert.equal(schema.safeParse({ maxFlows: 1000 }).success, true);
  assert.equal(schema.safeParse({ maxFlows: 1001 }).success, false);
  assert.equal(schema.safeParse({ maxFlows: 0 }).success, false);
  assert.equal(schema.safeParse({ maxFlows: 2.5 }).success, false);
  assert.equal(schema.safeParse({ maxDepth: 50 }).success, true);
  assert.equal(schema.safeParse({ maxDepth: 51 }).success, false);
});

test("figma_generate_tests: saveArtifacts 可关闭 md/xlsx/caseSets", () => {
  const schema = schemaOf("figma_generate_tests");
  assert.equal(
    schema.safeParse({ saveArtifacts: { markdown: false, xlsx: false, caseSets: false } }).success,
    true
  );
  assert.equal(schema.safeParse({ saveArtifacts: { markdown: true } }).success, true);
  assert.equal(schema.safeParse({ saveArtifacts: { markdown: "no" } }).success, false);
});
