import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { figmaImportStrings } from "../dist/figma/import-strings.js";
import { loadStringContext } from "../dist/figma/strings.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

function pluralDocument() {
  return {
    name: "Plurals",
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
              name: "Cart",
              type: "FRAME",
              children: [
                {
                  id: "t1",
                  name: "Item Count",
                  type: "TEXT",
                  characters: "{count} 项",
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

function writeContext(dir, entries) {
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "string-context.json"),
    JSON.stringify({ version: 1, entries }, null, 2)
  );
}

function makeAndroidProject() {
  const dir = makeTempProject({ config: baseConfig() });
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), "android {}\n");
  return dir;
}

function makeFlutterProject() {
  const dir = makeTempProject({ config: baseConfig() });
  fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
  return dir;
}

function makeIosProject() {
  const dir = makeTempProject({ config: baseConfig() });
  fs.mkdirSync(path.join(dir, "ios", "Demo.xcodeproj"), { recursive: true });
  return dir;
}

const PLURAL_FORMS = {
  plural: {
    variable: "count",
    forms: { zero: "没有商品", one: "{count} 项", other: "{count} 项" }
  }
};

test("loadStringContext: validation errors are reported per key", () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeContext(dir, {
    "cart.item_count": PLURAL_FORMS,
    "bad.missing_other": { plural: { forms: { one: "{count} 项" } } },
    "bad.quantity": { plural: { variable: "count", forms: { other: "{count} 项", some: "x" } } },
    "bad.placeholder": { plural: { variable: "count", forms: { other: "{name} 件" } } }
  });

  const context = loadStringContext(path.join(dir, ".artemis"));
  assert.deepEqual([...context.contexts.keys()], ["cart.item_count"]);
  assert.equal(context.errors.length, 3);
  assert.ok(context.errors.some((line) => /other/.test(line)));
  assert.ok(context.errors.some((line) => /不支持的 quantity/.test(line)));
  assert.ok(context.errors.some((line) => /\{name\}/.test(line)));
});

test("figma_import_strings: confirmed plural resolves needs_context into <plurals>", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "PluralAndroid1";
    const restore = stubFigma(pluralDocument(), fileKey);
    const dir = makeAndroidProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

    try {
      const first = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(first.counts.needsContext, 1);
      assert.equal(first.counts.pluralized, 0);
      const resourcePath = path.join(dir, "app/src/main/res/values/aos_strings.xml");
      assert.ok(!fs.readFileSync(resourcePath, "utf-8").includes("cart_item_count"));

      writeContext(dir, { "cart.item_count": PLURAL_FORMS });
      const second = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(second.counts.needsContext, 0);
      assert.equal(second.counts.pluralized, 1);
      assert.deepEqual(second.stringContext.pluralKeys, ["cart.item_count"]);
      assert.deepEqual(second.stringContext.errors, []);
      assert.deepEqual(second.entries[0].plural, { variable: "count", quantities: ["zero", "one", "other"] });

      const content = fs.readFileSync(resourcePath, "utf-8");
      assert.ok(!content.includes(`<string name="cart_item_count"`), "plural key is not emitted as <string>");
      assert.match(content, /<plurals name="cart_item_count">/);
      const zero = content.indexOf('quantity="zero"');
      const one = content.indexOf('quantity="one"');
      const other = content.indexOf('quantity="other"');
      assert.ok(zero >= 0 && zero < one && one < other, "quantities keep canonical order");
      assert.match(content, /<item quantity="one">%1\$d 项<\/item>/);
      assert.match(content, /<item quantity="zero">没有商品<\/item>/);

      const third = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(third.resources[0].action, "unchanged");
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: flutter arb gets ICU plural and int metadata", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "PluralFlutter1";
    const restore = stubFigma(pluralDocument(), fileKey);
    const dir = makeFlutterProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    writeContext(dir, { "cart.item_count": PLURAL_FORMS });

    try {
      const payload = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(payload.counts.pluralized, 1);
      const arb = JSON.parse(
        fs.readFileSync(path.join(dir, "lib/l10n/app_zh.arb"), "utf-8")
      );
      assert.equal(
        arb.cartItemCount,
        "{count, plural, zero {没有商品} one {{count} 项} other {{count} 项}}"
      );
      assert.deepEqual(arb["@cartItemCount"], { placeholders: { count: { type: "int" } } });
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: iOS writes .stringsdict and keeps it out of .strings", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "PluralIos1";
    const restore = stubFigma(pluralDocument(), fileKey);
    const dir = makeIosProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    writeContext(dir, { "cart.item_count": PLURAL_FORMS });

    try {
      const payload = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      const paths = payload.resources.map((resource) => resource.path);
      assert.deepEqual(paths, ["ios/zh-Hans.lproj/Localizable.strings", "ios/zh-Hans.lproj/Localizable.stringsdict"]);
      assert.equal(payload.resources[1].action, "written");

      const strings = fs.readFileSync(path.join(dir, "ios/zh-Hans.lproj/Localizable.strings"), "utf-8");
      assert.ok(!strings.includes("cartItemCount"));

      const stringsdict = fs.readFileSync(path.join(dir, "ios/zh-Hans.lproj/Localizable.stringsdict"), "utf-8");
      assert.match(stringsdict, /<key>cartItemCount<\/key>/);
      assert.match(stringsdict, /<key>NSStringLocalizedFormatKey<\/key>\s*<string>%#@count@<\/string>/);
      assert.match(stringsdict, /<key>NSStringFormatSpecTypeKey<\/key>\s*<string>NSStringPluralRuleType<\/string>/);
      assert.match(stringsdict, /<key>NSStringFormatValueTypeKey<\/key>\s*<string>d<\/string>/);
      assert.match(stringsdict, /<key>one<\/key>\s*<string>%d 项<\/string>/);
      assert.match(stringsdict, /<key>zero<\/key>\s*<string>没有商品<\/string>/);

      const second = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(second.resources[1].action, "unchanged");
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: unmatched and invalid context entries are surfaced, not applied", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "PluralContextBad1";
    const restore = stubFigma(pluralDocument(), fileKey);
    const dir = makeAndroidProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    writeContext(dir, {
      "cart.item_count": PLURAL_FORMS,
      "no.such.key": PLURAL_FORMS,
      "bad.entry": { plural: { forms: { one: "x" } } }
    });

    try {
      const payload = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      assert.equal(payload.counts.pluralized, 1);
      assert.deepEqual(payload.stringContext.unmatched, ["no.such.key"]);
      assert.equal(payload.stringContext.errors.length, 1);
      assert.match(payload.stringContext.errors[0], /bad\.entry/);
      assert.match(payload.hint, /string-context\.json/);
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: iOS stringsdict 跨 .lproj 冲突 → 不覆盖用户条目", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "PluralIosConflict";
    const restore = stubFigma(pluralDocument(), fileKey);
    const dir = makeIosProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    writeContext(dir, { "cart.item_count": PLURAL_FORMS });
    fs.mkdirSync(path.join(dir, "ios/en.lproj"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ios/en.lproj/Localizable.stringsdict"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "<dict>",
        "  <key>cartItemCount</key>",
        "  <dict>",
        "    <key>NSStringLocalizedFormatKey</key>",
        "    <string>%#@count@</string>",
        "    <key>count</key>",
        "    <dict>",
        "      <key>other</key>",
        "      <string>%d custom items</string>",
        "    </dict>",
        "  </dict>",
        "</dict>",
        "</plist>"
      ].join("\n")
    );
    try {
      const payload = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      const stringsdictResource = payload.resources.find((resource) =>
        resource.path.endsWith(".stringsdict")
      );
      assert.deepEqual(
        stringsdictResource.conflicts.map((conflict) => conflict.key),
        ["cartItemCount"]
      );
      assert.equal(
        fs.existsSync(path.join(dir, "ios/zh-Hans.lproj/Localizable.stringsdict")),
        false
      );
    } finally {
      restore();
    }
  });
});

test("figma_import_strings: iOS stringsdict 保留人工添加的额外条目", async () => {
  await withFigmaEnv(async () => {
    const fileKey = "PluralIosMerge";
    const restore = stubFigma(pluralDocument(), fileKey);
    const dir = makeIosProject();
    const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
    writeContext(dir, { "cart.item_count": PLURAL_FORMS });
    fs.mkdirSync(path.join(dir, "ios/zh-Hans.lproj"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ios/zh-Hans.lproj/Localizable.stringsdict"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "<dict>",
        "  <key>legacyCount</key>",
        "  <dict>",
        "    <key>NSStringLocalizedFormatKey</key>",
        "    <string>%#@n@</string>",
        "    <key>n</key>",
        "    <dict>",
        "      <key>other</key>",
        "      <string>%d legacy</string>",
        "    </dict>",
        "  </dict>",
        "</dict>",
        "</plist>"
      ].join("\n")
    );
    try {
      const payload = parseToolResult(
        await figmaImportStrings(runtime, { url: `https://www.figma.com/design/${fileKey}/Demo` })
      );
      const written = fs.readFileSync(
        path.join(dir, "ios/zh-Hans.lproj/Localizable.stringsdict"),
        "utf-8"
      );
      assert.match(written, /<key>legacyCount<\/key>/);
      assert.match(written, /<key>cartItemCount<\/key>/);
      assert.deepEqual(
        payload.resources.find((resource) => resource.path.endsWith(".stringsdict")).conflicts,
        []
      );
    } finally {
      restore();
    }
  });
});
