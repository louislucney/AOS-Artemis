import fs from "node:fs";
import path from "node:path";

export type StackId = "flutter" | "react-native" | "android-native" | "ios-native" | "web";

export interface StackEvidence {
  kind: "marker" | "dependency" | "config";
  /** 相对项目根的路径，或配置文件名。 */
  path: string;
  detail?: string;
}

export interface StackDetection {
  id: StackId;
  displayName: string;
  reason: string;
  confidence: number;
  evidence: StackEvidence[];
  /** config=显式覆盖；detected=文件/依赖推断。 */
  source: "detected" | "config";
  /** 多个互斥应用栈（如 Flutter + React Native）同时出现；需显式指定。 */
  ambiguous?: boolean;
}

export interface DetectProjectStacksOptions {
  /** `aos.config.jsonc` 的 project.stack；优先级最高。 */
  stack?: StackId[];
}

export interface StackDetectionReport {
  stacks: StackDetection[];
  source: "detected" | "config";
  warnings: string[];
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

/** M6 design-resource targets: generated strings/token files and key casing.
 * `stringsFile` may contain `{locale}` (code) and `{localeDir}` (Android dir suffix). */
export interface StackI18nRules {
  stringsFile: string;
  tokenFile: string | null;
  keyStyle: CaseStyle;
  plural: "plurals-xml" | "icu-arb" | "json-icu" | "stringsdict" | "unsupported";
  sourceLocale: string;
}

export interface StackProfile {
  id: StackId;
  displayName: string;
  /** Where design assets should live / be diffed against (gap analysis). */
  assetGlobs: string[];
  /** Where design tokens live (gap analysis color check). */
  tokenGlobs: string[];
  /** M6a/M6b generated-file targets and key conventions. */
  i18n: StackI18nRules;
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
    },
    i18n: {
      stringsFile: "lib/l10n/app_{locale}.arb",
      tokenFile: "lib/theme/aos_tokens.dart",
      keyStyle: "camel",
      plural: "icu-arb",
      sourceLocale: "zh"
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
    },
    i18n: {
      stringsFile: "src/i18n/{locale}.json",
      tokenFile: "src/theme/aos-tokens.ts",
      keyStyle: "camel",
      plural: "json-icu",
      sourceLocale: "zh"
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
    },
    i18n: {
      stringsFile: "app/src/main/res/values{localeDir}/aos_strings.xml",
      tokenFile: "app/src/main/res/values/aos_tokens.xml",
      keyStyle: "snake",
      plural: "plurals-xml",
      sourceLocale: "zh"
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
    },
    i18n: {
      stringsFile: "ios/{locale}.lproj/Localizable.strings",
      tokenFile: "ios/AosTokens.swift",
      keyStyle: "camel",
      plural: "stringsdict",
      sourceLocale: "zh"
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
    },
    i18n: {
      stringsFile: "src/locales/{locale}.json",
      tokenFile: "src/styles/aos-tokens.css",
      keyStyle: "camel",
      plural: "json-icu",
      sourceLocale: "zh"
    }
  }
};

export const STACK_IDS = Object.keys(STACK_PROFILES) as StackId[];

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

function dependencyNames(packageJson: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (packageJson === null) return names;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = packageJson[field];
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function dependencyVersion(
  packageJson: Record<string, unknown> | null,
  name: string
): string | null {
  if (packageJson === null) return null;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = packageJson[field];
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
    const value = (deps as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 纯 Dart 包也有 pubspec.yaml；只有声明 Flutter 才算 Flutter 项目。 */
function hasFlutterDeclaration(rootDir: string, warnings: string[]): boolean {
  const file = path.join(rootDir, "pubspec.yaml");
  if (!fs.existsSync(file)) return false;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    warnings.push(`pubspec.yaml 存在但不可读：${errorText(error)}`);
    return false;
  }
  if (/^\s*flutter\s*:/m.test(text) || /sdk\s*:\s*flutter\b/m.test(text)) return true;
  warnings.push("pubspec.yaml 未声明 Flutter（按纯 Dart 包处理）");
  return false;
}

function readPackageJson(rootDir: string, warnings: string[]): Record<string, unknown> | null {
  const file = path.join(rootDir, "package.json");
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    warnings.push(`package.json 解析失败：${errorText(error)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push("package.json 根节点不是对象");
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** 返回相对项目根的 xcodeproj/xcworkspace 路径；与原检测口径一致（≤2 层）。 */
function findXcodeProject(rootDir: string): string | null {
  const ignored = new Set([
    "node_modules",
    "dist",
    "build",
    ".git",
    ".gradle",
    "Pods",
    "DerivedData",
    "vendor"
  ]);
  const projectEntry = (dir: string): string | null => {
    try {
      const entry = fs
        .readdirSync(dir)
        .find((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
      return entry === undefined ? null : path.relative(rootDir, path.join(dir, entry));
    } catch {
      return null;
    }
  };
  const walk = (dir: string, depth: number): string | null => {
    if (depth === 0) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      const found = projectEntry(child);
      if (found !== null) return found;
      const nested = walk(child, depth - 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  return projectEntry(rootDir) ?? walk(rootDir, 2);
}

function configDetection(id: StackId): StackDetection {
  return {
    id,
    displayName: STACK_PROFILES[id].displayName,
    reason: "aos.config.jsonc project.stack",
    confidence: 1,
    evidence: [{ kind: "config", path: "aos.config.jsonc", detail: id }],
    source: "config"
  };
}

/** 检测项目技术栈并附带证据；override（project.stack）优先于文件推断。
 * 单仓单应用按根目录 marker/依赖判断；不做 monorepo/棕色地推断。 */
export function detectProjectStacksDetailed(
  rootDir: string,
  options: DetectProjectStacksOptions = {}
): StackDetectionReport {
  const warnings: string[] = [];
  const requested = options.stack ?? [];
  const invalid = requested.filter((id) => !STACK_IDS.includes(id));
  if (invalid.length > 0) {
    throw new Error(`未知技术栈：${invalid.join(", ")}（可选：${STACK_IDS.join(", ")}）`);
  }
  if (requested.length > 0) {
    return {
      stacks: [...new Set(requested)].map((id) => configDetection(id)),
      source: "config",
      warnings
    };
  }

  const detections: StackDetection[] = [];
  const isFlutter = hasFlutterDeclaration(rootDir, warnings);
  if (isFlutter) {
    detections.push({
      id: "flutter",
      displayName: STACK_PROFILES.flutter.displayName,
      reason: "pubspec.yaml (flutter)",
      confidence: 0.95,
      evidence: [{ kind: "marker", path: "pubspec.yaml", detail: "flutter" }],
      source: "detected"
    });
  }

  const packageJson = readPackageJson(rootDir, warnings);
  const dependencySet = dependencyNames(packageJson);
  const rnVersion = dependencyVersion(packageJson, "react-native");
  const expoVersion = dependencyVersion(packageJson, "expo");
  const isExpo = expoVersion !== null;
  const isReactNative = rnVersion !== null || isExpo;
  if (isReactNative) {
    const evidence: StackEvidence[] = [];
    if (rnVersion !== null) {
      evidence.push({ kind: "dependency", path: "package.json", detail: `react-native@${rnVersion}` });
    }
    if (expoVersion !== null) {
      evidence.push({ kind: "dependency", path: "package.json", detail: `expo@${expoVersion}` });
    }
    detections.push({
      id: "react-native",
      displayName: STACK_PROFILES["react-native"].displayName,
      reason: isExpo ? "expo dependency" : "react-native dependency",
      confidence: 0.9,
      evidence,
      source: "detected"
    });
  }

  if (!isFlutter && !isReactNative) {
    const androidMarker = ["settings.gradle", "settings.gradle.kts", "app/build.gradle"].find(
      (relative) => fs.existsSync(path.join(rootDir, relative))
    );
    if (androidMarker !== undefined) {
      detections.push({
        id: "android-native",
        displayName: STACK_PROFILES["android-native"].displayName,
        reason: "Gradle project (app/settings)",
        confidence: 0.85,
        evidence: [{ kind: "marker", path: androidMarker }],
        source: "detected"
      });
    }
    const xcode = findXcodeProject(rootDir);
    if (xcode !== null) {
      detections.push({
        id: "ios-native",
        displayName: STACK_PROFILES["ios-native"].displayName,
        reason: "xcodeproj/xcworkspace (≤2 层目录)",
        confidence: 0.8,
        evidence: [{ kind: "marker", path: xcode }],
        source: "detected"
      });
    }
  }

  if (packageJson !== null && !isFlutter && !isReactNative) {
    const webDeps = WEB_DEPS.filter((dep) => dependencySet.has(dep));
    if (webDeps.length > 0) {
      detections.push({
        id: "web",
        displayName: STACK_PROFILES.web.displayName,
        reason: "frontend dependency in package.json",
        confidence: 0.7,
        evidence: webDeps.map((dep) => ({
          kind: "dependency",
          path: "package.json",
          detail: `${dep}@${dependencyVersion(packageJson, dep) ?? "unknown"}`
        })),
        source: "detected"
      });
    }
  }

  if (isFlutter && isReactNative) {
    for (const detection of detections) detection.ambiguous = true;
    warnings.push("检测到 Flutter 与 React Native 同时存在：单仓单应用下无法确定主栈，请用 project.stack 显式指定");
  }

  return {
    stacks: detections.sort((a, b) => b.confidence - a.confidence),
    source: "detected",
    warnings
  };
}

export function detectProjectStacks(
  rootDir: string,
  options: DetectProjectStacksOptions = {}
): StackDetection[] {
  return detectProjectStacksDetailed(rootDir, options).stacks;
}

export function primaryProfile(detections: StackDetection[]): StackProfile | null {
  return detections.length > 0 ? STACK_PROFILES[detections[0]!.id] : null;
}

export function skippedStacksWarning(
  detections: StackDetection[],
  profile: StackProfile | null
): string | null {
  if (!profile) return null;
  const skipped = detections.filter((detection) => detection.id !== profile.id);
  if (skipped.length === 0) return null;
  return `检测到多个技术栈：本次仅按主栈 ${profile.displayName} 产出，跳过 ${skipped
    .map((detection) => detection.displayName)
    .join("、")}（全栈分别产出为 backlog）。`;
}

export function skippedStacksWarnings(
  detections: StackDetection[],
  profile: StackProfile | null
): string[] {
  const warning = skippedStacksWarning(detections, profile);
  return warning ? [warning] : [];
}
