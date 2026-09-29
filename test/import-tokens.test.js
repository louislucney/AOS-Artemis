import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { figmaImportTokens } from "../dist/figma/import-tokens.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

function figmaDocument(colors) {
  return {
    name: "Design",
    document: {
      id: "0",
      name: "Doc",
      type: "DOCUMENT",
      children: [
        {
          id: "p",
          name: "Page",
          type: "CANVAS",
          children: colors.map((color, index) => ({
            id: `f${index}`,
            name: color.name,
            type: "FRAME",
            fills: [{ type: "SOLID", color: color.rgba, opacity: color.opacity ?? 1 }]
          }))
        }
      ]
    }
  };
}

function stubFigma(payloads, fileKey) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (!href.includes(`/files/${fileKey}`)) throw new Error(`unexpected fetch: ${href}`);
    return new Response(JSON.stringify(payloads), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function withFigmaEnv(fn) {
  const previous = process.env.FIGMA_ACCESS_TOKEN;
  process.env.FIGMA_ACCESS_TOKEN = "test-token";
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = previous;
  }
}

test("figma_import_tokens: canonical + flutter token file, idempotent, alpha preserved", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "TokenFileA1";
    const doc = figmaDocument([
      { name: "CTA Button", rgba: { r: 0.23, g: 0.51, b: 0.96 } },
      { name: "Scrim", rgba: { r: 0, g: 0, b: 0 }, opacity: 0.5 }
    ]);
    const restore = stubFigma(doc, fileKey);
    const dir = makeTempProject({ config: baseConfig() });
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

    try {
      const first = parseToolResult(
        await figmaImportTokens(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(first.ok, true);
      assert.equal(first.stack, "flutter");
      assert.equal(first.counts.tokens, 2);
      assert.equal(first.counts.new, 2);

      const tokensPath = path.join(dir, ".artemis", "design", "tokens.json");
      const canonical = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
      assert.equal(canonical.color.brand.cta_button.$value, "#3B82F5FF");
      assert.equal(canonical.color.surface.scrim.$value, "#00000080");
      assert.deepEqual(canonical.color.surface.scrim.$extensions.aos.modes, {
        default: "#00000080"
      });

      const dartPath = path.join(dir, "lib", "theme", "aos_tokens.dart");
      assert.match(fs.readFileSync(dartPath, "utf-8"), /Color\(0x80000000\)/);

      const second = parseToolResult(
        await figmaImportTokens(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(second.counts.new, 0);
      assert.equal(second.counts.unchanged, 2);
      assert.equal(second.stackFile.action, "unchanged");
    } finally {
      restore();
    }
  });
});

test("figma_import_tokens: dryRun writes nothing; enforcement=block on hardcoded colors", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "TokenFileB2";
    const doc = figmaDocument([{ name: "CTA Button", rgba: { r: 0.1, g: 0.2, b: 0.3 } }]);
    const restore = stubFigma(doc, fileKey);
    const dir = makeTempProject({ config: baseConfig() });
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

    try {
      const preview = parseToolResult(
        await figmaImportTokens(runtime, {
          url: `https://www.figma.com/design/${fileKey}/Demo`,
          dryRun: true
        })
      );
      assert.equal(preview.dryRun, true);
      assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "tokens.json")));

      fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(dir, "lib", "main.dart"), "const c = Color(0xFF123456);\n");
      const blocked = await figmaImportTokens(runtime, {
        url: `https://www.figma.com/design/${fileKey}/Demo`,
        enforcement: "block"
      });
      assert.equal(blocked.isError, true);
      const payload = parseToolResult(blocked);
      assert.equal(payload.blocked, true);
      assert.ok(payload.hardcodedColors.total >= 1);
    } finally {
      restore();
    }
  });
});

test("figma_import_tokens: unmanaged target file is not overwritten without overwrite", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "TokenFileC3";
    const doc = figmaDocument([{ name: "CTA Button", rgba: { r: 0.1, g: 0.2, b: 0.3 } }]);
    const restore = stubFigma(doc, fileKey);
    const dir = makeTempProject({ config: baseConfig() });
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
    fs.mkdirSync(path.join(dir, "lib", "theme"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib", "theme", "aos_tokens.dart"), "// hand-written\n");
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

    try {
      const payload = parseToolResult(
        await figmaImportTokens(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(payload.stackFile.action, "skipped_unmanaged");
      assert.equal(
        fs.readFileSync(path.join(dir, "lib", "theme", "aos_tokens.dart"), "utf-8"),
        "// hand-written\n"
      );
    } finally {
      restore();
    }
  });
});
