import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zodToJsonSchema } from "zod-to-json-schema";

import { bridgeState, startBridge, stopBridge } from "../dist/figma/bridge.js";
import { handleFigmaTool } from "../dist/figma/registry.js";
import { FIGMA_TOOLS } from "../dist/figma/tool-defs.js";
import { store } from "../dist/vendor/design-context-bridge/figma-bridge/store.js";
import { startFigmaBridge } from "../dist/vendor/design-context-bridge/figma-bridge/ws-server.js";
import { fetchFile } from "../dist/vendor/design-context-bridge/figma-rest/client.js";

const EXPECTED_TOOLS = [
  "get_current_selection",
  "get_current_page",
  "get_all_pages",
  "get_frame_by_name",
  "get_component_definitions",
  "get_selected_colors",
  "get_selected_texts",
  "get_variables",
  "get_selected_spacing",
  "get_selected_interactions",
  "get_node_info",
  "get_nodes_info",
  "scan_nodes_by_types",
  "get_file_from_url",
  "get_node_from_url",
  "extract_design_system",
  "analyze_structure",
  "get_component_variants",
  "export_image",
  "find_assets"
];

test("figma tool surface: exactly the vendored 20 tools with valid zod schemas", () => {
  const names = FIGMA_TOOLS.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());

  for (const tool of FIGMA_TOOLS) {
    assert.ok(tool.description.length > 10, `${tool.name} needs a description`);
    const schema = zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" });
    assert.equal(schema.type, "object", `${tool.name} schema must be an object`);
  }
});

test("figma tool schemas: required fields and enums preserved", () => {
  const byName = new Map(FIGMA_TOOLS.map((tool) => [tool.name, tool]));
  const schemaFor = (name) =>
    zodToJsonSchema(byName.get(name).schema, { target: "jsonSchema7", $refStrategy: "none" });

  assert.deepEqual(schemaFor("get_frame_by_name").required, ["name"]);
  assert.deepEqual(schemaFor("scan_nodes_by_types").required, ["types"]);
  assert.deepEqual(schemaFor("get_nodes_info").required, ["ids"]);
  assert.deepEqual(schemaFor("export_image").required, ["url"]);
  assert.deepEqual(schemaFor("export_image").properties.format.enum, ["svg", "png", "jpg"]);
  assert.deepEqual(schemaFor("get_variables").properties.type.enum, [
    "COLOR",
    "FLOAT",
    "STRING",
    "BOOLEAN"
  ]);
  // rejection path through the adapter
  const parsed = byName.get("get_frame_by_name").schema.safeParse({});
  assert.equal(parsed.success, false);
});

test("figma store: temp files are namespaced (aos-mcp-figma prefix)", () => {
  const selectionPath = join(tmpdir(), "aos-mcp-figma-selection.json");
  const legacyPath = join(tmpdir(), "design-context-bridge-selection.json");
  fs.rmSync(selectionPath, { force: true });
  store.setContext({ selection: [{ id: "1:1", name: "SeededFrame", type: "FRAME" }] });
  assert.ok(fs.existsSync(selectionPath), "namespaced store file should exist");
  assert.ok(!fs.existsSync(legacyPath), "must not write the stock dcb file");
});

test("figma adapter: plugin-mode handler reads the seeded bridge store", async () => {
  store.setContext({
    selection: [{ id: "2:2", name: "AdapterFrame", type: "FRAME" }],
    selectedColors: [],
    selectedTexts: [],
    selectedSpacing: [],
    selectedInteractions: []
  });
  const result = await handleFigmaTool("get_current_selection", {});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /AdapterFrame/);

  const bad = await handleFigmaTool("get_frame_by_name", {});
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /参数校验失败/);
});

test("figma bridge: loopback listener, CORS policy, EADDRINUSE skip", async () => {
  const first = await startFigmaBridge({ port: 0 });
  assert.equal(first.ok, true);
  assert.equal(first.status, "listening");
  assert.ok(first.port > 0);
  const base = `http://127.0.0.1:${first.port}`;

  const update = await fetch(`${base}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "null" },
    body: JSON.stringify({ selection: [{ id: "3:3", name: "BridgeFrame" }] })
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).ok, true);
  assert.equal(update.headers.get("access-control-allow-origin"), "null");

  const requests = await fetch(`${base}/requests`);
  assert.deepEqual(await requests.json(), []);

  const allowedPreflight = await fetch(`${base}/update`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000" }
  });
  assert.equal(allowedPreflight.status, 204);
  assert.equal(
    allowedPreflight.headers.get("access-control-allow-origin"),
    "http://localhost:3000"
  );

  const evilPreflight = await fetch(`${base}/update`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" }
  });
  assert.equal(evilPreflight.status, 403);

  const evilPost = await fetch(`${base}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: "{}"
  });
  assert.equal(evilPost.status, 403);

  const second = await startFigmaBridge({ port: first.port });
  assert.equal(second.ok, false);
  assert.equal(second.status, "skipped_occupied");

  await first.close();
});

test("figma bridge wrapper: state transitions and close", async () => {
  const started = await startBridge({ port: 0 });
  assert.equal(started.status, "listening");
  assert.equal(bridgeState().status, "listening");
  await stopBridge();
  assert.equal(bridgeState().status, "not_started");
});

test("REST client without a token gives actionable guidance", async () => {
  const previous = process.env.FIGMA_ACCESS_TOKEN;
  delete process.env.FIGMA_ACCESS_TOKEN;
  try {
    await assert.rejects(() => fetchFile("abc123"), /aos_configure/);
  } finally {
    if (previous !== undefined) process.env.FIGMA_ACCESS_TOKEN = previous;
  }
});
