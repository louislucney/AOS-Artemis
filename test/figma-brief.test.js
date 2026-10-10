import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import {
  briefAccessibility,
  detectAndroidPackage,
  renderBriefMarkdown,
  scaffoldComponentSkeleton
} from "../dist/figma/brief.js";
import { STACK_PROFILES } from "../dist/projects/stack.js";

function tmp() {
  return makeTempDir("aos-brief-");
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("scaffold: react-native skeleton path and content", () => {
  const skeleton = scaffoldComponentSkeleton("Home Button", {
    profile: STACK_PROFILES["react-native"],
    propertyNames: ["State", "Size"]
  });
  assert.equal(skeleton.relativePath, "src/components/HomeButton.tsx");
  assert.match(skeleton.content, /export function HomeButton/);
  assert.match(skeleton.content, /HomeButtonProps/);
  assert.match(skeleton.content, /变体属性: State, Size/);
});

test("scaffold: flutter / android / ios / web / generic skeletons", () => {
  const flutter = scaffoldComponentSkeleton("Home Button", { profile: STACK_PROFILES.flutter });
  assert.equal(flutter.relativePath, "lib/components/home_button.dart");
  assert.match(flutter.content, /class HomeButton extends StatelessWidget/);

  const android = scaffoldComponentSkeleton("Home Button", {
    profile: STACK_PROFILES["android-native"],
    packageName: "com.acme.app"
  });
  assert.equal(android.relativePath, "app/src/main/java/com/acme/app/ui/components/HomeButton.kt");
  assert.match(android.content, /package com.acme.app.ui.components/);

  const androidNoPackage = scaffoldComponentSkeleton("Home Button", {
    profile: STACK_PROFILES["android-native"]
  });
  assert.equal(androidNoPackage.relativePath, "app/src/main/java/ui/components/HomeButton.kt");
  assert.match(androidNoPackage.content, /TODO: 改为应用实际包名/);

  const ios = scaffoldComponentSkeleton("Home Button", { profile: STACK_PROFILES["ios-native"] });
  assert.equal(ios.relativePath, "ios/Components/HomeButton.swift");
  assert.match(ios.content, /struct HomeButton: View/);

  const web = scaffoldComponentSkeleton("Home Button", { profile: STACK_PROFILES.web });
  assert.equal(web.relativePath, "src/components/HomeButton.tsx");

  const generic = scaffoldComponentSkeleton("Home Button", { profile: null });
  assert.equal(generic.relativePath, "src/components/HomeButton.tsx");
});

test("detectAndroidPackage: manifest package then gradle namespace", () => {
  const root = tmp();
  write(
    root,
    "app/src/main/AndroidManifest.xml",
    '<manifest package="com.acme.app"><application/></manifest>'
  );
  assert.equal(detectAndroidPackage(root), "com.acme.app");

  const gradleRoot = tmp();
  write(gradleRoot, "app/build.gradle.kts", 'android { namespace = "io.demo.app" }');
  assert.equal(detectAndroidPackage(gradleRoot), "io.demo.app");

  assert.equal(detectAndroidPackage(tmp()), null);
});

test("renderBriefMarkdown: sections, tokens and next steps", () => {
  const markdown = renderBriefMarkdown({
    sourceUrl: "https://www.figma.com/design/ABC/File",
    fileKey: "ABC",
    fileName: "File",
    generatedAt: "2026-09-29T00:00:00Z",
    stack: {
      id: "react-native",
      displayName: "React Native",
      codeRules: "src/components/**",
      locatorRules: "testID",
      componentDir: "src/components",
      componentExample: "HomeButton.tsx"
    },
    screens: [{ page: "Page 1", name: "Home", suggestedRoute: "/" }],
    suggestedRoutes: ["/"],
    designSystem: {
      colors: [{ hex: "#FF0000", usageCount: 3, sampleLayers: ["CTA"] }],
      typography: [
        { fontFamily: "Inter", fontSize: 16, fontWeight: 600, lineHeight: 22, usageCount: 2 }
      ],
      spacingScale: [{ value: 8, usageCount: 5 }],
      borderRadius: [{ value: 12, usageCount: 2 }],
      shadows: []
    },
    components: [
      {
        id: "1:1",
        name: "Button",
        type: "COMPONENT_SET",
        propertyNames: ["State"],
        variantCount: 2,
        sampleVariants: ["State=Hover"]
      }
    ],
    flowSummary: { screens: 2, edges: 3, entryScreens: ["Home"] },
    gapSummary: { missingAssets: 4, missingColors: 2 },
    accessibility: [],
    nextSteps: ["运行 figma_import_assets 导入缺失资源"]
  });

  assert.match(markdown, /# 构建简报：File/);
  assert.match(markdown, /技术栈: React Native/);
  assert.match(markdown, /\| `#FF0000` \| 3 \| CTA \|/);
  assert.match(markdown, /## 2. 页面与路由/);
  assert.match(markdown, /Button \| COMPONENT_SET/);
  assert.match(markdown, /## 4. 交互流程概览/);
  assert.match(markdown, /## 5. 资源缺口/);
  assert.match(markdown, /## 6. 编码约定/);
  assert.match(markdown, /## 7\. 建议下一步/, "without a11y entries the next-steps section keeps its number");
  assert.match(markdown, /1\. 运行 figma_import_assets/);
});

test("renderBriefMarkdown: a11y suggestions section with renumbered next steps", () => {
  const markdown = renderBriefMarkdown({
    sourceUrl: "pen:design.pen",
    fileKey: "design.pen",
    fileName: "design.pen",
    generatedAt: "2026-10-10T00:00:00Z",
    stack: null,
    screens: [{ page: "pen", name: "Home", suggestedRoute: "/" }],
    suggestedRoutes: ["/"],
    designSystem: {
      colors: [],
      typography: [],
      spacingScale: [],
      borderRadius: [],
      shadows: []
    },
    components: [],
    accessibility: [
      { screen: "Home", text: "Buy now", identifier: "buyNow", source: "observed", hits: 2 }
    ],
    flowSummary: null,
    gapSummary: null,
    nextSteps: ["按第 1 节 tokens 实现组件"]
  });

  assert.match(markdown, /## 7\. 无障碍标识建议（a11y）/);
  assert.match(markdown, /\| Home \| Buy now \| `buyNow` \| observed \| 2 \|/);
  assert.match(markdown, /## 8\. 建议下一步/);
});

test("briefAccessibility: reads screen-map elements sorted", () => {
  const dir = tmp();
  write(
    dir,
    ".artemis/design/screen-map.json",
    JSON.stringify({
      version: 1,
      entries: [],
      elements: [
        {
          screen: "B",
          text: "二",
          observedLabel: "二",
          identifier: "er",
          confidence: 1,
          source: "observed",
          hits: 1,
          traces: [],
          lastSeenAt: "t"
        },
        {
          screen: "A",
          text: "一",
          observedLabel: "一",
          identifier: "yi",
          confidence: 1,
          source: "manual",
          hits: 3,
          traces: [],
          lastSeenAt: "t"
        }
      ]
    })
  );

  assert.deepEqual(briefAccessibility(path.join(dir, ".artemis")), [
    { screen: "A", text: "一", identifier: "yi", source: "manual", hits: 3 },
    { screen: "B", text: "二", identifier: "er", source: "observed", hits: 1 }
  ]);
  assert.deepEqual(briefAccessibility(path.join(dir, "missing")), []);
});
