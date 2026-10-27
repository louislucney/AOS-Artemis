import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildResourceCalibration,
  traceFontScaleFromRun,
  tracePixelRatioFromRun
} from "../dist/ui/resource-calibration.js";
import { baseConfig, createImage, makeTempProject, toPng } from "./helpers.js";

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

function writePng(root, relative, width, height) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toPng(createImage(width, height)));
}

function runtimeFor(root) {
  return { configDirAbs: path.join(root, ".artemis"), project: { rootDir: root, config: { project: {} } } };
}

function designContract() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-28T00:00:00.000Z",
    source: { flows: "design/flows.json", designRoot: "design", fingerprint: "f".repeat(64) },
    summary: { extracted: 1, partial: 0, unverifiable: 0, "no-baseline": 0 },
    warnings: [],
    screens: [
      {
        id: "home",
        name: "Home",
        sourceFrameName: "Home",
        presentation: "screen",
        status: "extracted",
        geometry: { nodes: 6, withGeometry: 6, missingGeometry: 0 },
        tokens: {
          cornerRadius: [],
          colors: [],
          fontFamilies: [],
          fontSizes: [],
          fontWeights: [],
          spacing: []
        },
        components: [],
        texts: [
          {
            id: "pickup",
            content: "到店自取",
            fontFamily: "PingFang TC",
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 20,
            letterSpacing: 0,
            maxLines: 1,
            bbox: { x: 0, y: 0, width: 80, height: 20 },
            bboxSpace: "design-px",
            geometryStatus: "extracted"
          },
          {
            id: "title",
            content: "行動預點",
            fontFamily: "PingFang TC",
            fontSize: 20,
            fontWeight: 700,
            lineHeight: 28,
            letterSpacing: 0,
            maxLines: 1,
            bbox: { x: 0, y: 0, width: 100, height: 28 },
            bboxSpace: "design-px",
            geometryStatus: "extracted"
          },
          {
            id: "body",
            content: "選擇門市後開始點餐",
            fontFamily: "PingFang TC",
            fontSize: 14,
            fontWeight: 400,
            lineHeight: 20,
            letterSpacing: 0,
            maxLines: 2,
            bbox: { x: 0, y: 0, width: 200, height: 20 },
            bboxSpace: "design-px",
            geometryStatus: "extracted"
          }
        ],
        images: [
          {
            id: "avatar",
            name: "Avatar",
            source: "./avatar.png",
            assetKey: "avatar",
            fit: "cover",
            bbox: { x: 0, y: 0, width: 72, height: 72 },
            bboxSpace: "design-px",
            geometryStatus: "extracted"
          },
          {
            id: "hero",
            name: "Hero",
            source: "./hero.png",
            assetKey: "hero",
            fit: "cover",
            bbox: { x: 0, y: 0, width: 343, height: 160 },
            bboxSpace: "design-px",
            geometryStatus: "extracted"
          },
          {
            id: "banner",
            name: "Banner",
            source: "./banner.png",
            assetKey: "banner",
            fit: "cover",
            bbox: { x: 0, y: 0, width: 343, height: 120 },
            bboxSpace: "design-px",
            geometryStatus: "extracted"
          }
        ],
        render: null,
        renderScale: null,
        frameWidth: 375,
        warnings: []
      }
    ]
  };
}

function nativeDesignContract() {
  const contract = designContract();
  contract.screens[0].texts = [
    {
      id: "title",
      content: "行動預點",
      fontFamily: null,
      fontSize: 20,
      fontWeight: 700,
      lineHeight: null,
      letterSpacing: null,
      maxLines: null,
      bbox: { x: 0, y: 0, width: 100, height: 28 },
      bboxSpace: "design-px",
      geometryStatus: "extracted"
    }
  ];
  contract.screens[0].images = [
    {
      id: "hero",
      name: "Hero",
      source: "./hero.png",
      assetKey: "hero",
      fit: "cover",
      bbox: { x: 0, y: 0, width: 343, height: 160 },
      bboxSpace: "design-px",
      geometryStatus: "extracted"
    }
  ];
  return contract;
}

function writeRnFixture(root) {
  write(
    root,
    "package.json",
    JSON.stringify({ private: true, dependencies: { react: "19.0.0", "react-native": "0.78.0" } })
  );
  write(
    root,
    "src/theme/tokens.ts",
    `export const typography = {
  pickup: { fontFamily: "PingFang TC", fontSize: 14, lineHeight: 20, letterSpacing: 0, fontWeight: "600" },
  title: { fontFamily: "PingFang TC", fontSize: 20, lineHeight: 24, letterSpacing: 0, fontWeight: "700" },
  body: { fontFamily: "PingFang TC", fontSize: 14, lineHeight: 20, letterSpacing: 0, fontWeight: "400" }
};
`
  );
  write(
    root,
    "src/screens/Home.tsx",
    `import { Image, Text, View } from "react-native";
import { typography } from "../theme/tokens";

export function Home() {
  return (
    <View>
      <Image source={require("../../assets/avatar.png")} style={styles.avatar} resizeMode="cover" />
      <Image source={require("../../assets/hero.png")} style={styles.hero} resizeMode="contain" />
      <Image source={require("../../assets/banner.png")} style={styles.banner} resizeMode="cover" />
      <Text style={typography.pickup} numberOfLines={1}>到店自取</Text>
      <Text style={typography.title} numberOfLines={1}>行動預點</Text>
      <Text style={typography.body} numberOfLines={2}>選擇門市後開始點餐</Text>
    </View>
  );
}

const styles = {
  avatar: { width: 72, height: 72 },
  hero: { width: 343, height: 160 },
  banner: { width: 343, height: 120 }
};
`
  );
  writePng(root, "assets/avatar.png", 72, 72);
  writePng(root, "assets/avatar@2x.png", 144, 144);
  writePng(root, "assets/avatar@3x.png", 216, 216);
  writePng(root, "assets/hero.png", 343, 160);
  writePng(root, "assets/hero@2x.png", 686, 320);
  writePng(root, "assets/hero@3x.png", 1029, 480);
  writePng(root, "assets/banner.png", 343, 120);
  writePng(root, "assets/banner@2x.png", 686, 240);
}

function writeFlutterFixture(root) {
  write(
    root,
    "pubspec.yaml",
    `name: flutter_fixture
dependencies:
  flutter:
    sdk: flutter
flutter:
  assets:
    - assets/images/avatar.png
    - assets/images/hero.png
    - assets/images/banner.png
  fonts:
    - family: PingFang TC
      fonts:
        - asset: assets/fonts/PingFangTC-Regular.ttf
          weight: 400
        - asset: assets/fonts/PingFangTC-Semibold.ttf
          weight: 600
`
  );
  write(
    root,
    "lib/theme/tokens.dart",
    `import 'package:flutter/material.dart';

class AosTypography {
  static const pickup = TextStyle(
    fontFamily: 'PingFang TC',
    fontSize: 14,
    height: 20 / 14,
    fontWeight: FontWeight.w600,
    letterSpacing: 0,
  );
  static const title = TextStyle(
    fontFamily: 'PingFang TC',
    fontSize: 20,
    height: 28 / 20,
    fontWeight: FontWeight.w700,
    letterSpacing: 0,
  );
  static const body = TextStyle(
    fontFamily: 'PingFang TC',
    fontSize: 14,
    height: 1.2,
    fontWeight: FontWeight.w400,
    letterSpacing: 0,
  );
}
`
  );
  write(
    root,
    "lib/screens/home.dart",
    `import 'package:flutter/material.dart';
import '../theme/tokens.dart';

class Home extends StatelessWidget {
  const Home({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Image.asset('assets/images/avatar.png', width: 72, height: 72, fit: BoxFit.cover),
      Image.asset('assets/images/hero.png', width: 343, height: 160, fit: BoxFit.contain),
      Image.asset('assets/images/banner.png', width: 343, height: 120, fit: BoxFit.cover),
      Text('到店自取', style: AosTypography.pickup, maxLines: 1),
      Text('行動預點', style: AosTypography.title, maxLines: 1),
      Text('選擇門市後開始點餐', style: AosTypography.body, maxLines: 2),
    ]);
  }
}
`
  );
  writePng(root, "assets/images/avatar.png", 72, 72);
  writePng(root, "assets/images/2.0x/avatar.png", 144, 144);
  writePng(root, "assets/images/3.0x/avatar.png", 216, 216);
  writePng(root, "assets/images/hero.png", 343, 160);
  writePng(root, "assets/images/2.0x/hero.png", 686, 320);
  writePng(root, "assets/images/3.0x/hero.png", 1029, 480);
  writePng(root, "assets/images/banner.png", 343, 120);
  writePng(root, "assets/images/2.0x/banner.png", 686, 240);
  write(root, "assets/fonts/PingFangTC-Regular.ttf", "fixture");
  write(root, "assets/fonts/PingFangTC-Semibold.ttf", "fixture");
}

test("resource calibration: RN image density/fit and text line-height/text-scale", (t) => {
  const root = makeTempProject({ config: baseConfig() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRnFixture(root);
  write(
    root,
    "src/screens/AAA.tsx",
    `import { Text } from "react-native";
import { typography } from "../theme/tokens";
export function Other() {
  return <Text style={typography.title} numberOfLines={1}>到店自取</Text>;
}
`
  );
  write(
    root,
    ".artemis/design/screen-map.json",
    JSON.stringify({
      version: 1,
      entries: [{ design: { screen: "Home" }, code: { file: "src/screens/Home.tsx" } }],
      elements: []
    })
  );
  const report = buildResourceCalibration(runtimeFor(root), designContract(), {
    device: { nativeUnit: "pt", pixelRatio: 3, fontScale: 1.3 }
  });

  assert.equal(report.mode, "report-only");
  assert.equal(report.stacks[0].id, "react-native");
  assert.equal(report.stacks[0].source, "detected");
  assert.deepEqual(
    {
      total: report.images.total,
      match: report.images.match,
      mismatch: report.images.mismatch,
      upscale: report.images.upscale
    },
    { total: 3, match: 1, mismatch: 1, upscale: 1 }
  );
  assert.deepEqual(
    {
      total: report.texts.total,
      match: report.texts.match,
      mismatch: report.texts.mismatch
    },
    { total: 3, match: 2, mismatch: 1 }
  );
  const title = report.items.find((item) => item.kind === "text" && item.designId === "title");
  assert.equal(title.status, "mismatch");
  assert.match(title.issues.join("\n"), /line-height 24 != 28/);
  assert.equal(title.deviceStatus, "text-scale");
  const banner = report.items.find((item) => item.kind === "image" && item.designId === "banner");
  assert.equal(banner.status, "upscale");
  assert.ok(banner.notes.some((note) => note.includes("variants 1/2")));
  const pickup = report.items.find((item) => item.kind === "text" && item.designId === "pickup");
  assert.equal(pickup.status, "match");
  assert.match(pickup.codeRef, /src\/screens\/Home\.tsx:\d+$/, pickup.codeRef);
});

test("tracePixelRatioFromRun: median of valid step scales; invalid -> null", () => {
  assert.equal(tracePixelRatioFromRun({ steps: [{ scale: 3 }, { scale: 3 }, { scale: 2 }] }), 3);
  assert.equal(tracePixelRatioFromRun({ steps: [{ scale: 2 }, { scale: 3 }] }), 2.5);
  assert.equal(tracePixelRatioFromRun({ steps: [{ scale: 0 }, { scale: null }, {}] }), null);
  assert.equal(tracePixelRatioFromRun({ steps: [] }), null);
  assert.equal(tracePixelRatioFromRun(null), null);
  assert.equal(traceFontScaleFromRun({ fontScale: 1.3 }), 1.3);
  assert.equal(traceFontScaleFromRun({ device: { fontScale: 1.15 } }), 1.15);
  assert.equal(traceFontScaleFromRun({}), null);
  assert.equal(traceFontScaleFromRun({ fontScale: 0 }), null);
});

test("resource calibration: Flutter font-weight substitution and height multiplier", (t) => {
  const root = makeTempProject({ config: baseConfig() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFlutterFixture(root);
  const report = buildResourceCalibration(runtimeFor(root), designContract(), {
    device: { nativeUnit: "dp", pixelRatio: 3, fontScale: 1 }
  });

  assert.equal(report.stacks[0].id, "flutter");
  assert.deepEqual(
    {
      total: report.images.total,
      match: report.images.match,
      mismatch: report.images.mismatch,
      upscale: report.images.upscale
    },
    { total: 3, match: 1, mismatch: 1, upscale: 1 }
  );
  assert.equal(report.texts.match, 1);
  assert.equal(report.texts.mismatch, 1);
  assert.equal(report.texts.fontWeightSubstituted, 1);
  const title = report.items.find((item) => item.kind === "text" && item.designId === "title");
  assert.equal(title.status, "font-weight-substituted");
  const body = report.items.find((item) => item.kind === "text" && item.designId === "body");
  assert.equal(body.status, "mismatch");
  assert.match(body.issues.join("\n"), /line-height 16\.8 != 20/);
});

test("resource calibration: no stack is explicit unverifiable, not guessed", (t) => {
  const root = makeTempProject({ config: baseConfig() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = buildResourceCalibration(runtimeFor(root), designContract());
  assert.equal(report.stacks.length, 0);
  assert.equal(report.images.total, 3);
  assert.equal(report.images.unverifiable, 3);
  assert.equal(report.texts.total, 3);
  assert.equal(report.texts.unverifiable, 3);
  assert.ok(report.warnings.some((warning) => warning.includes("未检测到技术栈")));
  assert.ok(report.items.every((item) => item.status === "unverifiable"));
});

test("resource calibration: Android XML native text/image best effort", (t) => {
  const root = makeTempProject({ config: baseConfig() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "app/build.gradle", "// fixture\n");
  writePng(root, "app/src/main/res/drawable-xhdpi/hero.png", 686, 320);
  writePng(root, "app/src/main/res/drawable-xxhdpi/hero.png", 1029, 480);
  write(
    root,
    "app/src/main/res/layout/home.xml",
    `<LinearLayout>
  <TextView android:text="行動預點" android:textSize="20sp" android:textStyle="bold"
    android:fontFamily="sans-serif" android:lineSpacingExtra="8dp" android:maxLines="1" />
  <ImageView android:src="@drawable/hero" android:layout_width="343dp"
    android:layout_height="160dp" android:scaleType="centerCrop" />
</LinearLayout>
`
  );
  const report = buildResourceCalibration(runtimeFor(root), nativeDesignContract(), {
    device: { pixelRatio: 3 }
  });
  assert.equal(report.stacks[0].id, "android-native");
  assert.equal(report.texts.match, 1);
  assert.equal(report.images.match, 1);
  assert.ok(
    report.items.find((item) => item.kind === "image").notes.some((note) => note.includes("variants 2/3")),
    JSON.stringify(report.items)
  );
  const title = report.items.find((item) => item.kind === "text" && item.designId === "title");
  assert.equal(title.status, "match");
  assert.ok(title.notes.includes("native-font-weight-unverified"));
});

test("resource calibration: iOS SwiftUI native text/image best effort", (t) => {
  const root = makeTempProject({ config: baseConfig() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "App.xcodeproj"), { recursive: true });
  write(
    root,
    "Assets.xcassets/hero.imageset/Contents.json",
    JSON.stringify({
      images: [
        { filename: "hero.png", idiom: "universal", scale: "1x" },
        { filename: "hero@2x.png", idiom: "universal", scale: "2x" },
        { filename: "hero@3x.png", idiom: "universal", scale: "3x" }
      ],
      info: { author: "xcode", version: 1 }
    })
  );
  writePng(root, "Assets.xcassets/hero.imageset/hero.png", 343, 160);
  writePng(root, "Assets.xcassets/hero.imageset/hero@2x.png", 686, 320);
  writePng(root, "Assets.xcassets/hero.imageset/hero@3x.png", 1029, 480);
  write(
    root,
    "App/HomeView.swift",
    `import SwiftUI

struct HomeView: View {
  var body: some View {
    VStack {
      Text("行動預點").font(.system(size: 20, weight: .bold))
      Image("hero").resizable().scaledToFill().frame(width: 343, height: 160)
    }
  }
}
`
  );
  const report = buildResourceCalibration(runtimeFor(root), nativeDesignContract(), {
    device: { pixelRatio: 3 }
  });
  assert.equal(report.stacks[0].id, "ios-native");
  assert.equal(report.texts.match, 1);
  assert.equal(report.images.match, 1);
});

test("resource calibration: RN i18n key resolves through strings.json", (t) => {
  const root = makeTempProject({ config: baseConfig() });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "package.json",
    JSON.stringify({ private: true, dependencies: { react: "19.0.0", "react-native": "0.78.0" } })
  );
  write(
    root,
    "src/theme/tokens.ts",
    `export const typography = {
  pickup: { fontFamily: "PingFang TC", fontSize: 14, lineHeight: 20, letterSpacing: 0, fontWeight: "600" }
};
`
  );
  write(
    root,
    "src/screens/I18n.tsx",
    `import { Text } from "react-native";
import { typography } from "../theme/tokens";
export function I18n() {
  return <Text style={typography.pickup} numberOfLines={1}>{t("home.pickup")}</Text>;
}
`
  );
  write(
    root,
    ".artemis/design/strings.json",
    JSON.stringify({
      version: 1,
      sourceLocale: "zh",
      entries: [{ key: "home.pickup", sourceText: "到店自取", lifecycle: "active" }]
    })
  );
  const contract = designContract();
  contract.screens[0].texts = contract.screens[0].texts.filter((text) => text.id === "pickup");
  contract.screens[0].images = [];
  const report = buildResourceCalibration(runtimeFor(root), contract);
  assert.equal(report.texts.match, 1);
  const pickup = report.items.find((item) => item.kind === "text");
  assert.equal(pickup.status, "match");
  assert.match(pickup.codeRef, /src\/screens\/I18n\.tsx/);
});
