import fs from "node:fs";
import path from "node:path";

export type StackId = "flutter" | "react-native" | "android-native" | "ios-native" | "web";

export interface StackDetection {
  id: StackId;
  displayName: string;
  reason: string;
  confidence: number;
}

export type CaseStyle = "kebab" | "snake" | "pascal" | "camel";

export interface NamingRules {
  assets: {
    style: CaseStyle;
    /** e.g. Android drawable icons use an `ic_` prefix. */
    prefix?: string;
    /** Preferred destination directory for imported assets. */
    preferredDir: string;
    note?: string;
  };
  componentFile: { style: CaseStyle; extension: string; preferredDir: string };
  testFile: { style: CaseStyle; suffix?: string; extension: string };
}

export interface StackProfile {
  id: StackId;
  displayName: string;
  /** Where design assets should live / be diffed against (gap analysis). */
  assetGlobs: string[];
  /** Where design tokens live (gap analysis color check). */
  tokenGlobs: string[];
  /** Locator conventions for generated tests. */
  locatorRules: string;
  /** Code layout conventions (M-D code generation). */
  codeRules: string;
  /** File naming conventions per artifact kind. */
  naming: NamingRules;
}

export const STACK_PROFILES: Record<StackId, StackProfile> = {
  flutter: {
    id: "flutter",
    displayName: "Flutter",
    assetGlobs: ["assets/**", "**/assets/**"],
    tokenGlobs: [
      "lib/theme/**",
      "lib/app/theme/**",
      "lib/**/theme.dart",
      "lib/**/tokens.dart",
      "lib/**/colors.dart"
    ],
    locatorRules: "ValueKey/Semantics(label)；find.byKey / find.bySemanticsLabel，文本兜底 find.text",
    codeRules: "lib/features/<feature>/ 结构；颜色/字体走 Theme.of(context)（design tokens）",
    naming: {
      assets: { style: "snake", preferredDir: "assets/images" },
      componentFile: { style: "snake", extension: ".dart", preferredDir: "lib/components" },
      testFile: { style: "snake", suffix: "_test", extension: ".dart" }
    }
  },
  "react-native": {
    id: "react-native",
    displayName: "React Native",
    assetGlobs: ["assets/**", "src/assets/**", "src/**/assets/**"],
    tokenGlobs: [
      "src/theme/**",
      "src/tokens/**",
      "**/tokens.json",
      "**/theme.json",
      "**/theme.ts",
      "**/theme.tsx",
      "**/tailwind.config.js",
      "**/tailwind.config.ts"
    ],
    locatorRules: "testID → accessibilityLabel → 可见文本；Detox/Maestro 优先 testID",
    codeRules: "src/components/**、src/screens/**；样式与色板引用 theme/tokens",
    naming: {
      assets: { style: "kebab", preferredDir: "src/assets" },
      componentFile: { style: "pascal", extension: ".tsx", preferredDir: "src/components" },
      testFile: { style: "kebab", extension: ".yaml" }
    }
  },
  "android-native": {
    id: "android-native",
    displayName: "Android (Kotlin/Java)",
    assetGlobs: [
      "app/src/main/res/drawable/**",
      "app/src/main/res/drawable-*/*",
      "app/src/main/res/raw/**",
      "app/src/main/assets/**"
    ],
    tokenGlobs: [
      "app/src/main/res/values/colors.xml",
      "app/src/main/res/values/themes.xml",
      "app/src/main/java/**/ui/theme/**",
      "app/src/main/kotlin/**/ui/theme/**"
    ],
    locatorRules: "resource-id / content-desc；Espresso withId / withContentDescription，文本兜底",
    codeRules: "Compose: app/src/main/{java,kotlin}/**/ui/<feature>；颜色走 MaterialTheme/tokens",
    naming: {
      assets: {
        style: "snake",
        prefix: "ic_",
        preferredDir: "app/src/main/res/drawable",
        note: "Android drawable 名称仅限 [a-z0-9_]；SVG 需转 Vector XML 或导出 PNG"
      },
      componentFile: { style: "pascal", extension: ".kt", preferredDir: "app/src/main/java/ui/components" },
      testFile: { style: "pascal", suffix: "Test", extension: ".kt" }
    }
  },
  "ios-native": {
    id: "ios-native",
    displayName: "iOS (Swift)",
    assetGlobs: ["**/*.xcassets/**", "Resources/**"],
    tokenGlobs: ["**/Colors.xcassets/**", "**/*.xcassets/**", "**/Assets.swift", "**/Theme.swift"],
    locatorRules: "accessibilityIdentifier；XCUITest 优先 identifier",
    codeRules: "SwiftUI/UIKit 视图层；颜色走 Asset Catalog/Theme",
    naming: {
      assets: {
        style: "snake",
        preferredDir: "Resources/Assets.xcassets",
        note: "推荐进 Asset Catalog（.imageset，Xcode 12+ 支持 SVG）"
      },
      componentFile: { style: "pascal", extension: ".swift", preferredDir: "ios/Components" },
      testFile: { style: "pascal", suffix: "UITests", extension: ".swift" }
    }
  },
  web: {
    id: "web",
    displayName: "Web",
    assetGlobs: ["public/**", "src/assets/**", "static/**"],
    tokenGlobs: [
      "**/tokens.json",
      "**/tokens.css",
      "**/theme.css",
      "**/variables.css",
      "**/tailwind.config.js",
      "**/tailwind.config.ts",
      "**/theme.ts"
    ],
    locatorRules: "data-testid → role+name；Playwright getByTestId / getByRole",
    codeRules: "src/components/**；样式走设计 tokens / CSS 变量",
    naming: {
      assets: { style: "kebab", preferredDir: "public/assets" },
      componentFile: { style: "pascal", extension: ".tsx", preferredDir: "src/components" },
      testFile: { style: "kebab", suffix: ".spec", extension: ".ts" }
    }
  }
};

/** Split any layer/file name into lowercase words (handles camelCase + separators). */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function toCase(name: string, style: CaseStyle): string {
  const parts = words(name);
  if (parts.length === 0) return "asset";
  switch (style) {
    case "snake":
      return parts.join("_");
    case "kebab":
      return parts.join("-");
    case "pascal":
      return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
    case "camel":
      return parts[0]! + parts.slice(1).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
  }
}

const ICON_WORDS = new Set(["icon", "ic", "logo", "glyph"]);

/** Format an imported asset filename for the detected stack, e.g.:
 *  Android: "Home Icon" → ic_home.svg (prefix + snake, redundant icon word dropped)
 *  RN:      "Home Icon" → home-icon.svg; Flutter: home_icon.svg */
export function formatAssetFilename(
  name: string,
  profile: StackProfile | null,
  extension = "svg"
): string {
  const rules = profile?.naming.assets;
  let parts = words(name);
  if (rules?.prefix && parts.length > 1 && ICON_WORDS.has(parts[parts.length - 1]!)) {
    parts = parts.slice(0, -1);
  }
  const base = parts.length > 0 ? parts.join(rules?.style === "snake" ? "_" : "-") : "asset";
  return `${rules?.prefix ?? ""}${base}.${extension}`;
}

export function formatComponentFileName(name: string, profile: StackProfile | null): string {
  const rules = profile?.naming.componentFile ?? {
    style: "pascal" as const,
    extension: ".tsx",
    preferredDir: "src/components"
  };
  return `${toCase(name, rules.style)}${rules.extension}`;
}

export function formatTestFileName(name: string, profile: StackProfile | null): string {
  const rules = profile?.naming.testFile ?? { style: "kebab" as const, extension: ".yaml" };
  return `${toCase(name, rules.style)}${rules.suffix ?? ""}${rules.extension}`;
}

const WEB_DEPS = ["react", "vue", "next", "nuxt", "svelte", "@angular/core", "vite", "astro"];

/** Detect the project's development stack(s) from well-known marker files.
 * Ordering is by confidence; wrapper projects (RN/Flutter inside android/) do
 * not trigger the native checks. */
export function detectProjectStacks(rootDir: string): StackDetection[] {
  const exists = (relative: string): boolean => fs.existsSync(path.join(rootDir, relative));
  const readJson = (relative: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(rootDir, relative), "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };
  const hasXcodeProject = (): boolean => {
    try {
      return fs
        .readdirSync(path.join(rootDir, "ios"))
        .some((entry) => entry.endsWith(".xcodeproj") || entry.endsWith(".xcworkspace"));
    } catch {
      return false;
    }
  };

  const detections: StackDetection[] = [];

  const isFlutter = exists("pubspec.yaml");
  if (isFlutter) {
    detections.push({
      id: "flutter",
      displayName: STACK_PROFILES.flutter.displayName,
      reason: "pubspec.yaml",
      confidence: 0.95
    });
  }

  const packageJson = readJson("package.json");
  const dependencyNames = packageJson
    ? [
        ...Object.keys((packageJson.dependencies as Record<string, unknown>) ?? {}),
        ...Object.keys((packageJson.devDependencies as Record<string, unknown>) ?? {})
      ]
    : [];
  const isExpo = dependencyNames.includes("expo");
  const isReactNative = dependencyNames.includes("react-native") || isExpo;
  if (isReactNative) {
    detections.push({
      id: "react-native",
      displayName: STACK_PROFILES["react-native"].displayName,
      reason: isExpo ? "expo dependency" : "react-native dependency",
      confidence: 0.9
    });
  }

  if (!isFlutter && !isReactNative) {
    const isNativeAndroid =
      exists("settings.gradle") || exists("settings.gradle.kts") || exists("app/build.gradle");
    if (isNativeAndroid) {
      detections.push({
        id: "android-native",
        displayName: STACK_PROFILES["android-native"].displayName,
        reason: "Gradle project (app/settings)",
        confidence: 0.85
      });
    }
    if (hasXcodeProject()) {
      detections.push({
        id: "ios-native",
        displayName: STACK_PROFILES["ios-native"].displayName,
        reason: "ios/*.xcodeproj",
        confidence: 0.8
      });
    }
  }

  if (packageJson && !isReactNative && WEB_DEPS.some((dep) => dependencyNames.includes(dep))) {
    detections.push({
      id: "web",
      displayName: STACK_PROFILES.web.displayName,
      reason: "frontend dependency in package.json",
      confidence: 0.7
    });
  }

  return detections.sort((a, b) => b.confidence - a.confidence);
}

export function primaryProfile(detections: StackDetection[]): StackProfile | null {
  return detections.length > 0 ? STACK_PROFILES[detections[0]!.id] : null;
}
