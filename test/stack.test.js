import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import {
  detectProjectStacks,
  formatAssetFilename,
  formatComponentFileName,
  formatTestFileName,
  primaryProfile,
  STACK_PROFILES,
  toCase
} from "../dist/projects/stack.js";

function tmp() {
  return makeTempDir("aos-stack-");
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
    assert.ok(profile.naming.assets.preferredDir.length > 0, `${profile.id} asset dir`);
  }
});

test("naming: toCase handles camelCase and separators", () => {
  assert.equal(toCase("Home Button", "snake"), "home_button");
  assert.equal(toCase("Home Button", "kebab"), "home-button");
  assert.equal(toCase("home_button", "pascal"), "HomeButton");
  assert.equal(toCase("home-button", "camel"), "homeButton");
});

test("naming: asset filenames follow stack conventions", () => {
  // Android: ic_ prefix + snake_case, redundant "icon" word dropped
  assert.equal(formatAssetFilename("home-icon", STACK_PROFILES["android-native"]), "ic_home.svg");
  // Flutter: snake_case
  assert.equal(formatAssetFilename("home-icon", STACK_PROFILES.flutter), "home_icon.svg");
  // React Native / Web: kebab-case
  assert.equal(formatAssetFilename("home-icon", STACK_PROFILES["react-native"]), "home-icon.svg");
  assert.equal(formatAssetFilename("cart", STACK_PROFILES.web), "cart.svg");
  // No profile → kebab default
  assert.equal(formatAssetFilename("Home Icon", null), "home-icon.svg");
  // Extension follows the export format
  assert.equal(formatAssetFilename("cart", STACK_PROFILES.flutter, "png"), "cart.png");
});

test("naming: component and test filenames follow stack conventions", () => {
  assert.equal(formatComponentFileName("Home Button", STACK_PROFILES["react-native"]), "HomeButton.tsx");
  assert.equal(formatComponentFileName("Home Button", STACK_PROFILES.flutter), "home_button.dart");
  assert.equal(formatComponentFileName("Home Button", STACK_PROFILES["android-native"]), "HomeButton.kt");
  assert.equal(formatComponentFileName("Home Button", STACK_PROFILES["ios-native"]), "HomeButton.swift");

  assert.equal(formatTestFileName("home checkout", STACK_PROFILES["react-native"]), "home-checkout.yaml");
  assert.equal(formatTestFileName("home checkout", STACK_PROFILES.flutter), "home_checkout_test.dart");
  assert.equal(formatTestFileName("home checkout", STACK_PROFILES["android-native"]), "HomeCheckoutTest.kt");
  assert.equal(formatTestFileName("home checkout", STACK_PROFILES.web), "home-checkout.spec.ts");
});
