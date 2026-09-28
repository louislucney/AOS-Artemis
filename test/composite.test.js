import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareDesignAndDevice, extractDeviceImage } from "../dist/tools/composite.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

test("extractDeviceImage: MCP image content block", () => {
  const image = extractDeviceImage({
    content: [{ type: "image", data: "QUJD", mimeType: "image/png" }]
  });
  assert.equal(image.data, "QUJD");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.note, "tool image block");
});

test("extractDeviceImage: text payload referencing a local file path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-shot-"));
  const file = path.join(dir, "screen.png");
  fs.writeFileSync(file, Buffer.from("fake-png-bytes"));

  const fromJson = extractDeviceImage({
    content: [{ type: "text", text: JSON.stringify({ screenshot_path: file }) }]
  });
  assert.equal(fromJson.note, `local file ${file}`);
  assert.equal(Buffer.from(fromJson.data, "base64").toString(), "fake-png-bytes");

  const fromPlainText = extractDeviceImage({
    content: [{ type: "text", text: `Screenshot saved to file://${file}` }]
  });
  assert.equal(Buffer.from(fromPlainText.data, "base64").toString(), "fake-png-bytes");
});

test("extractDeviceImage: returns null when nothing image-like is present", () => {
  assert.equal(
    extractDeviceImage({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
    null
  );
});

test("compare_design_and_device: missing Figma token returns actionable guidance", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });

  const previous = process.env.FIGMA_ACCESS_TOKEN;
  delete process.env.FIGMA_ACCESS_TOKEN;
  try {
    const result = await compareDesignAndDevice(runtime, {
      figmaUrl: "https://www.figma.com/design/ABC123/File?node-id=1-2"
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /aos_configure/);
  } finally {
    if (previous !== undefined) process.env.FIGMA_ACCESS_TOKEN = previous;
  }
});

test("compare_design_and_device: URL without node-id is rejected before any fetch", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });

  const result = await compareDesignAndDevice(runtime, {
    figmaUrl: "https://www.figma.com/design/ABC123/File"
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /node-id/);
});
