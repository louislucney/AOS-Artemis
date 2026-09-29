import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizePlaceholders,
  canonicalTextToAndroid,
  collectFigmaTexts,
  deriveCanonicalKey,
  mergeStrings,
  parseStrings,
  platformKey,
  renderAndroidStrings,
  renderFlutterArb,
  scanHardcodedStrings,
  serializeStrings,
  writeResourceFile
} from "../dist/figma/strings.js";
import { STACK_PROFILES } from "../dist/projects/stack.js";

function figmaDoc() {
  return {
    id: "0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      {
        id: "p",
        name: "Page 1",
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
  };
}

function rec(overrides = {}) {
  return {
    nodeId: "t1",
    characters: "欢迎登录",
    canonicalText: "欢迎登录",
    screen: "Login",
    layer: "Title",
    element: "Title",
    placeholders: [],
    needsContext: false,
    needsRename: false,
    ...overrides
  };
}

function entry(overrides = {}) {
  return {
    key: "login.title",
    nodeId: "t1",
    screen: "Login",
    layer: "Title",
    sourceText: "欢迎登录",
    canonicalText: "欢迎登录",
    sourceFingerprint: "sha256:x",
    placeholders: [],
    lifecycle: "active",
    ...overrides
  };
}

test("canonicalizePlaceholders: positional and sequential placeholders fold to ICU", () => {
  assert.deepEqual(canonicalizePlaceholders("欢迎, %s"), {
    canonicalText: "欢迎, {arg1}",
    placeholders: ["arg1"]
  });
  assert.deepEqual(canonicalizePlaceholders("%1$s 已添加 %2$d 项"), {
    canonicalText: "{arg1} 已添加 {arg2} 项",
    placeholders: ["arg1", "arg2"]
  });
  assert.deepEqual(canonicalizePlaceholders("Hello {name}"), {
    canonicalText: "Hello {name}",
    placeholders: ["name"]
  });
});

test("collectFigmaTexts: screens, components, generic layers and mixed styles", () => {
  const records = collectFigmaTexts(figmaDoc());
  assert.equal(records.length, 4);

  const title = records.find((record) => record.nodeId === "t1");
  assert.equal(title.screen, "Login");
  assert.equal(title.key === undefined, true);
  assert.equal(title.needsRename, false);

  const generic = records.find((record) => record.nodeId === "t4");
  assert.equal(generic.needsRename, true);
  assert.equal(generic.screen, "Login");
  const hash = createHash("sha1").update("t4").digest("hex").slice(0, 6);
  assert.equal(deriveCanonicalKey(generic), `login.text_${hash}`);

  const mixed = records.find((record) => record.nodeId === "t5");
  assert.equal(mixed.needsContext, true);
  assert.deepEqual(mixed.placeholders, ["arg1"]);
});

test("keys: canonical derivation and per-stack casing", () => {
  assert.equal(deriveCanonicalKey(rec()), "login.title");
  assert.equal(platformKey("login.submit_button", "snake"), "login_submit_button");
  assert.equal(platformKey("login.submit_button", "camel"), "loginSubmitButton");
  assert.equal(platformKey("login.submit_button", "pascal"), "LoginSubmitButton");
  assert.equal(platformKey("login.submit_button", "kebab"), "login-submit-button");
});

test("merge: fresh import derives keys and lifecycle flags", () => {
  const merged = mergeStrings([], collectFigmaTexts(figmaDoc()));
  assert.equal(merged.entries.length, 4);
  assert.deepEqual(merged.unused, []);

  const title = merged.entries.find((item) => item.nodeId === "t1");
  assert.equal(title.key, "login.title");
  assert.equal(title.lifecycle, "active");

  const generic = merged.entries.find((item) => item.nodeId === "t4");
  assert.equal(generic.lifecycle, "needs_rename");

  const mixed = merged.entries.find((item) => item.nodeId === "t5");
  assert.equal(mixed.lifecycle, "needs_context");
});

test("merge: layer rename keeps the frozen key (nodeId mapping)", () => {
  const merged = mergeStrings(
    [entry()],
    [rec({ layer: "Title Renamed", element: "Title Renamed" })]
  );
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].key, "login.title");
  assert.equal(merged.entries[0].layer, "Title Renamed");
  assert.equal(merged.entries[0].lifecycle, "active");
});

test("merge: source text change yields source_changed with the key kept", () => {
  const merged = mergeStrings(
    [entry()],
    [rec({ characters: "欢迎", canonicalText: "欢迎" })]
  );
  assert.equal(merged.entries[0].key, "login.title");
  assert.equal(merged.entries[0].lifecycle, "source_changed");
  assert.deepEqual(merged.sourceChanged, ["login.title"]);
});

test("merge: node identity change rebinds the key and suggests migration", () => {
  const merged = mergeStrings(
    [
      entry({
        key: "login.submit",
        nodeId: "old-node",
        layer: "Submit",
        element: "Submit",
        sourceText: "登录",
        canonicalText: "登录"
      })
    ],
    [rec({ nodeId: "t2", layer: "Submit", element: "Submit", characters: "登录", canonicalText: "登录" })]
  );
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].key, "login.submit");
  assert.equal(merged.entries[0].nodeId, "t2");
  assert.equal(merged.migrations.length, 1);
  assert.equal(merged.migrations[0].fromKey, "login.submit");
  assert.deepEqual(merged.unused, []);
});

test("merge: two live nodes with the same derived key get a suffix", () => {
  const merged = mergeStrings(
    [],
    [rec({ nodeId: "a1" }), rec({ nodeId: "a2", layer: "Title", element: "Title" })]
  );
  assert.equal(merged.entries.length, 2);
  const keys = merged.entries.map((item) => item.key).sort();
  assert.deepEqual(keys, ["login.title", "login.title_2"]);
  assert.equal(merged.entries.find((item) => item.key === "login.title_2").lifecycle, "needs_rename");
  assert.equal(merged.migrations.length, 1);
});

test("merge: identical text in a different context suggests reuse", () => {
  const merged = mergeStrings(
    [],
    [
      rec({ nodeId: "b1" }),
      rec({ nodeId: "b2", screen: "Profile", layer: "Submit", element: "Submit" })
    ]
  );
  assert.equal(merged.reuseSuggestions.length, 1);
  assert.equal(merged.reuseSuggestions[0].reuseOf, "login.title");
  assert.equal(merged.reuseSuggestions[0].text, "欢迎登录");
});

test("merge: vanished nodes keep entries and are reported unused", () => {
  const merged = mergeStrings([entry()], []);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].lifecycle, "unused");
  assert.deepEqual(merged.unused, ["login.title"]);
});

test("strings file: serialize/parse round-trip is deterministic", () => {
  const merged = mergeStrings([], collectFigmaTexts(figmaDoc()));
  const text = serializeStrings(merged.entries, "zh");
  const parsed = parseStrings(text);
  assert.equal(parsed.sourceLocale, "zh");
  assert.deepEqual(parsed.entries, merged.entries);
  assert.equal(serializeStrings(parsed.entries, "zh"), text);
});

test("android conversion: positional placeholders, %, quotes and XML escaping", () => {
  assert.equal(canonicalTextToAndroid("欢迎, {arg1}"), "欢迎, %1$s");
  assert.equal(canonicalTextToAndroid("已节省 50%"), "已节省 50%%");
  assert.equal(canonicalTextToAndroid("It's"), "It\\'s");
  assert.equal(canonicalTextToAndroid("a < b & c"), "a &lt; b &amp; c");
});

test("renderAndroidStrings: additive write, conflicts with user files, idempotency", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-strings-android-"));
  const profile = STACK_PROFILES["android-native"];
  const entries = [
    entry(),
    entry({
      key: "login.submit",
      nodeId: "t2",
      layer: "Submit",
      sourceText: "登录",
      canonicalText: "登录"
    })
  ];

  const first = renderAndroidStrings(profile, entries, dir, "");
  assert.equal(first.relativePath, "app/src/main/res/values/aos_strings.xml");
  assert.equal(first.action, "written");
  assert.match(first.content, /<string name="login_title">欢迎登录<\/string>/);
  writeResourceFile(dir, first);

  const second = renderAndroidStrings(profile, entries, dir, "");
  assert.equal(second.action, "unchanged");

  fs.mkdirSync(path.join(dir, "app/src/main/res/values"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "app/src/main/res/values/strings.xml"),
    '<resources><string name="login_submit">其他</string></resources>'
  );
  const third = renderAndroidStrings(profile, entries, dir, "");
  assert.equal(third.conflicts.length, 1);
  assert.equal(third.conflicts[0].key, "login_submit");
  assert.ok(!third.content.includes("login_submit"), "user-owned conflicting key is not regenerated");

  const fourth = renderAndroidStrings(profile, [entries[0]], dir, "");
  assert.match(fourth.content, /login_title/, "previously generated keys are preserved");
});

test("renderFlutterArb: metadata for placeholders, conflicts, idempotency", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-strings-flutter-"));
  const profile = STACK_PROFILES.flutter;
  const entries = [
    entry({
      key: "login.welcome",
      nodeId: "t5",
      layer: "Welcome",
      sourceText: "欢迎, %s",
      canonicalText: "欢迎, {arg1}",
      placeholders: ["arg1"]
    })
  ];

  const first = renderFlutterArb(profile, entries, dir, "zh");
  assert.equal(first.relativePath, "lib/l10n/app_zh.arb");
  const arb = JSON.parse(first.content);
  assert.equal(arb.loginWelcome, "欢迎, {arg1}");
  assert.equal(arb["@loginWelcome"].placeholders.arg1.type, "String");
  writeResourceFile(dir, first);
  assert.equal(renderFlutterArb(profile, entries, dir, "zh").action, "unchanged");

  fs.mkdirSync(path.join(dir, "lib/l10n"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib/l10n/app_zh.arb"), '{"loginWelcome":"已有翻译"}');
  const conflict = renderFlutterArb(profile, entries, dir, "zh");
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(JSON.parse(conflict.content).loginWelcome, "已有翻译");
});

test("scanHardcodedStrings: android layout literals and flutter Text literals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-strings-scan-"));
  fs.mkdirSync(path.join(dir, "app/src/main/res/layout"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "app/src/main/res/layout/activity.xml"),
    '<TextView android:text="登录" android:hint="@string/hint" />'
  );
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "lib/main.dart"),
    "Text('登录');\nText(\"Hello $name\");\nText(label);\n"
  );

  const android = scanHardcodedStrings(dir, "android-native");
  assert.deepEqual(android.map((hit) => hit.text), ["登录"]);
  const flutter = scanHardcodedStrings(dir, "flutter");
  assert.deepEqual(flutter.map((hit) => hit.text), ["登录"]);
});
