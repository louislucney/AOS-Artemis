import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { figmaImportStrings } from "../dist/figma/import-strings.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

function figmaTextsDocument() {
  return {
    name: "Strings Design",
    document: {
      id: "0",
      name: "Doc",
      type: "DOCUMENT",
      children: [
        {
          id: "p",
          name: "Page",
          type: "CANVAS",
          children: [
            {
              id: "s1",
              name: "Login",
              type: "FRAME",
              children: [
                { id: "t1", name: "Title", type: "TEXT", characters: "欢迎登录" },
                { id: "t2", name: "Submit", type: "TEXT", characters: "登录" },
                {
                  id: "t3",
                  name: "Frame 427",
                  type: "FRAME",
                  children: [{ id: "t4", name: "Text", type: "TEXT", characters: "注册" }]
                }
              ]
            },
            {
              id: "s2",
              name: "Profile",
              type: "FRAME",
              children: [
                {
                  id: "t5",
                  name: "Welcome",
                  type: "TEXT",
                  characters: "欢迎, %s",
                  characterStyleOverrides: [1, 0]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

function stubFigma(payload, fileKey) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (!href.includes(`/files/${fileKey}`)) throw new Error(`unexpected fetch: ${href}`);
    return new Response(JSON.stringify(payload), {
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

function makeAndroidProject() {
  const dir = makeTempProject({ config: baseConfig() });
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), "android {}\n");
  return dir;
}

test("figma_import_strings: android resources, lifecycle flags, idempotent re-import", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "StringsFileA1";
    const restore = stubFigma(figmaTextsDocument(), fileKey);
    const dir = makeAndroidProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

    try {
      const first = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(first.ok, true);
      assert.deepEqual(first.stacks, ["android-native"]);
      assert.equal(first.counts.designTexts, 4);
      assert.equal(first.counts.newKeys, 4);
      assert.equal(first.counts.needsRename, 1);
      assert.equal(first.counts.needsContext, 1);

      const resourcePath = path.join(dir, "app/src/main/res/values/aos_strings.xml");
      const content = fs.readFileSync(resourcePath, "utf-8");
      assert.match(content, /<string name="login_title">欢迎登录<\/string>/);
      assert.match(content, /<string name="login_submit">登录<\/string>/);
      assert.match(content, /<string name="login_text_[0-9a-f]{6}">注册<\/string>/);
      assert.ok(!content.includes("profile_welcome"), "needs_context entries are not written");

      const stringsPath = path.join(dir, ".artemis", "design", "strings.json");
      const strings = JSON.parse(fs.readFileSync(stringsPath, "utf-8"));
      assert.equal(strings.sourceLocale, "zh");
      assert.equal(strings.entries.length, 4);

      const second = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(second.counts.newKeys, 0);
      assert.equal(second.resources[0].action, "unchanged");
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: react-native writes src/i18n JSON", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "StringsFileC3";
    const restore = stubFigma(figmaTextsDocument(), fileKey);
    const dir = makeTempProject({ config: baseConfig() });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { "react-native": "0.74.0" } })
    );
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

    try {
      const payload = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.deepEqual(payload.stacks, ["react-native"]);
      assert.equal(payload.resources[0].path, "src/i18n/zh.json");
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, "src/i18n/zh.json"), "utf-8"));
      assert.equal(parsed.loginTitle, "欢迎登录");
      assert.ok(!("profileWelcome" in parsed), "needs_context entries are not written");
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: conflicts are reported, resolved via resolutions.json, block enforcement", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "StringsFileB2";
    const restore = stubFigma(figmaTextsDocument(), fileKey);
    const dir = makeAndroidProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    const valuesDir = path.join(dir, "app/src/main/res/values");
    fs.mkdirSync(valuesDir, { recursive: true });
    fs.writeFileSync(
      path.join(valuesDir, "strings.xml"),
      '<resources><string name="login_submit">其他</string></resources>'
    );

    try {
      const conflict = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(conflict.counts.conflicts, 1);
      assert.equal(conflict.resources[0].conflicts[0].key, "login_submit");
      const entry = conflict.entries.find((item) => item.key === "login.submit");
      assert.equal(entry.lifecycle, "conflict");

      const blocked = await figmaImportStrings(runtime, {
        url: `https://www.figma.com/design/${fileKey}/Demo`,
        enforcement: "block"
      });
      assert.equal(blocked.isError, true);

      fs.writeFileSync(
        path.join(dir, ".artemis", "design", "resolutions.json"),
        JSON.stringify({ conflicts: { login_submit: { resolvedAt: "2026-09-29T00:00:00.000Z" } } })
      );
      const resolved = parseToolResult(
        await figmaImportStrings(runtime, {
          url: `https://www.figma.com/design/${fileKey}/Demo`,
          enforcement: "block"
        })
      );
      assert.equal(resolved.counts.conflicts, 0);
      assert.equal(resolved.counts.resolved, 1);
    } finally {
      restore();
    }
  });
});
