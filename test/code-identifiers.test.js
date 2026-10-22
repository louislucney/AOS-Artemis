import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractCodeIdentifierHints,
  scanCodeIdentifierHints
} from "../dist/figma/code-identifiers.js";

test("code identifiers: React Native testID + Text", () => {
  const hints = extractCodeIdentifierHints(
    '<Text testID="loginButton">登录</Text>',
    "App.tsx"
  );
  assert.deepEqual(hints.map((hint) => [hint.text, hint.identifier]), [["登录", "loginButton"]]);
});

test("code identifiers: SwiftUI / Flutter / Android XML", () => {
  assert.deepEqual(
    extractCodeIdentifierHints(
      'Text("登录").accessibilityIdentifier("loginButton")',
      "Login.swift"
    ).map((hint) => hint.identifier),
    ["loginButton"]
  );
  assert.deepEqual(
    extractCodeIdentifierHints("Text('登录', key: Key('loginButton'))", "login.dart").map(
      (hint) => hint.identifier
    ),
    ["loginButton"]
  );
  assert.deepEqual(
    extractCodeIdentifierHints(
      '<Button android:id="@+id/login_button" android:text="登录" />',
      "login.xml"
    ).map((hint) => hint.identifier),
    ["login_button"]
  );
});

test("code identifiers: no pairing when text is far away or identifier is human label", () => {
  assert.deepEqual(
    extractCodeIdentifierHints(
      '<View testID="loginButton" />\n\n\n\n\n\n<Text>登录</Text>',
      "App.tsx"
    ),
    []
  );
  assert.deepEqual(
    extractCodeIdentifierHints('<Text testID="Button">登录</Text>', "App.tsx"),
    []
  );
});

test("code identifiers: scan skips ignored dirs and unsupported files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-code-identifiers-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(root, "src", "App.tsx"),
      '<Text testID="loginButton">登录</Text>',
      "utf-8"
    );
    await writeFile(
      join(root, "node_modules", "pkg", "ignored.tsx"),
      '<Text testID="ignoredButton">忽略</Text>',
      "utf-8"
    );
    const result = scanCodeIdentifierHints(root);
    assert.equal(result.scannedFiles, 1);
    assert.deepEqual(result.hints.map((hint) => hint.identifier), ["loginButton"]);
    assert.equal(result.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
