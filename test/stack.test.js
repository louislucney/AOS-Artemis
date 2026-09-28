import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectProjectStacks,
  primaryProfile,
  STACK_PROFILES
} from "../dist/projects/stack.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aos-stack-"));
}

function write(root, relative, content = "") {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("detects Flutter from pubspec.yaml", () => {
  const root = tmp();
  write(root, "pubspec.yaml", "name: app\n");
  write(root, "lib/main.dart", "void main() {}");

  const stacks = detectProjectStacks(root);
  assert.equal(stacks[0].id, "flutter");
  assert.ok(primaryProfile(stacks).assetGlobs.includes("assets/**"));
});

test("detects React Native and does not misclassify its android/ folder", () => {
  const root = tmp();
  write(
    root,
    "package.json",
    JSON.stringify({ dependencies: { "react-native": "0.78.0", react: "19.0.0" } })
  );
  write(root, "android/settings.gradle");
  write(root, "app/App.tsx");

  const stacks = detectProjectStacks(root);
  assert.equal(stacks[0].id, "react-native");
  assert.ok(!stacks.some((stack) => stack.id === "android-native"), "RN wrapper is not native");
  assert.ok(!stacks.some((stack) => stack.id === "web"), "react dep alone must not trigger web");
});

test("detects Expo as React Native", () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ dependencies: { expo: "54.0.0" } }));
  assert.equal(detectProjectStacks(root)[0].id, "react-native");
});

test("detects native Android from root gradle files", () => {
  const root = tmp();
  write(root, "settings.gradle.kts");
  write(root, "app/build.gradle");

  const stacks = detectProjectStacks(root);
  assert.equal(stacks[0].id, "android-native");
  assert.ok(
    primaryProfile(stacks).assetGlobs.some((glob) => glob.includes("res/drawable")),
    "native profile scans res/drawable"
  );
});

test("detects iOS from an xcodeproj", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "ios", "App.xcodeproj"), { recursive: true });
  assert.equal(detectProjectStacks(root)[0].id, "ios-native");
});

test("detects Web from frontend dependencies", () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
  assert.equal(detectProjectStacks(root)[0].id, "web");
});

test("unknown project yields no detections", () => {
  assert.deepEqual(detectProjectStacks(tmp()), []);
  assert.equal(primaryProfile([]), null);
});

test("profiles expose locator and code rules per stack", () => {
  for (const profile of Object.values(STACK_PROFILES)) {
    assert.ok(profile.locatorRules.length > 10, `${profile.id} locator rules`);
    assert.ok(profile.codeRules.length > 10, `${profile.id} code rules`);
    assert.ok(profile.assetGlobs.length > 0, `${profile.id} asset globs`);
    assert.ok(profile.tokenGlobs.length > 0, `${profile.id} token globs`);
  }
});
