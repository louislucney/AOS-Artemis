import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { uiContractFingerprint } from "../dist/ui/contract.js";
import { runUiLint } from "../dist/ui/lint.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, SuiteProxy } from "./helpers.js";

function writeContract(root, radii = [12, 16], screens = null, tokens = {}) {
  const design = path.join(root, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "ui-contract.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: { fingerprint: "fp-test" },
      screens: screens ?? [
        {
          id: "home",
          name: "Home",
          tokens: {
            cornerRadius: radii,
            colors: ["#112233", "#1F40B0FF"],
            fontSizes: [14, 16],
            fontWeights: ["600", "bold"],
            fontFamilies: ["SF Pro", "PingFang SC"],
            ...tokens
          }
        }
      ],
      summary: { extracted: 1, partial: 0, unverifiable: 0, "no-baseline": 0 },
      warnings: []
    })
  );
  return design;
}

function writeSource(root, file, content) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeScreenMap(root, entries) {
  const design = path.join(root, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "screen-map.json"),
    JSON.stringify({ version: 1, entries })
  );
}

test("ui-lint: contract radii pass, unregistered literal fails", () => {
  const root = makeTempDir("aos-ui-lint-");
  writeContract(root);
  writeSource(root, "app/src/Main.kt", "val ok = RoundedCornerShape(12.dp)\nval bad = RoundedCornerShape(99.dp)\n");
  const report = runUiLint({ rootDir: root });
  assert.equal(report.ok, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].file, "app/src/Main.kt");
  assert.equal(report.findings[0].rule, "radius");
  assert.equal(report.findings[0].value, 99);
  assert.equal(report.findings[0].line, 2);
  assert.deepEqual(report.contract.radii, [0, 12, 16]);
  assert.equal(report.allowlisted, 0);
});

test("ui-lint: color and font-size rules use contract tokens", () => {
  const root = makeTempDir("aos-ui-lint-tokens-");
  writeContract(root, [12], null, {
    colors: ["#112233", "#1F40B0FF"],
    fontSizes: [14, 16]
  });
  writeSource(
    root,
    "app/src/Theme.ts",
    [
      'const okHex = "#112233";',
      'const okAlpha = "#1F40B0FF";',
      'const badHex = "#ABCDEF";',
      "const okSize = { fontSize: 14 };",
      "const badSize = { fontSize: 15 };",
      ".rem { font-size: 1.5rem; }",
      ".px { font-size: 14px; }"
    ].join("\n")
  );
  const report = runUiLint({ rootDir: root });
  assert.equal(report.ok, false);
  assert.deepEqual(report.contract.colors, ["#112233ff", "#1f40b0ff"]);
  assert.deepEqual(report.contract.fontSizes, [14, 16]);
  const colors = report.findings.filter((finding) => finding.rule === "color");
  const sizes = report.findings.filter((finding) => finding.rule === "font-size");
  assert.deepEqual(
    colors.map((finding) => finding.value),
    ["#abcdef"]
  );
  assert.equal(colors[0].normalized, "#abcdefff");
  assert.deepEqual(
    sizes.map((finding) => finding.value),
    [15]
  );
});

test("ui-lint: font-weight rule normalizes names/numbers and respects allowlist", () => {
  const root = makeTempDir("aos-ui-lint-weights-");
  const design = writeContract(root, [12], null, {
    fontSizes: [14],
    fontWeights: ["600", "bold"]
  });
  writeSource(
    root,
    "app/src/Text.ts",
    [
      "const ok = { fontWeight: 600 };",
      "const okName = { fontWeight: 'bold' };",
      "const bad = { fontWeight: 500 };",
      ".fontWeight(.semibold)",
      ".fontWeight(.light)",
      "FontWeight.w700",
      "FontWeight.w900",
      "font-weight: 700;",
      "font-weight: 200;"
    ].join("\n")
  );
  const report = runUiLint({ rootDir: root });
  assert.deepEqual(report.contract.fontWeights, [600, 700]);
  const weights = report.findings.filter((finding) => finding.rule === "font-weight");
  assert.deepEqual(
    weights.map((finding) => finding.value).sort((left, right) => left - right),
    [200, 300, 500, 900]
  );

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Text.ts",
          rule: "font-weight",
          value: 500,
          owner: "qa",
          reason: "legacy",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const allowed = runUiLint({ rootDir: root });
  assert.equal(
    allowed.findings.find((finding) => finding.rule === "font-weight" && finding.value === 500)
      .allowlisted,
    true
  );
  assert.equal(
    allowed.findings.find((finding) => finding.rule === "font-weight" && finding.value === 300)
      .allowlisted,
    false
  );
});

test("ui-lint: font-family rule checks primary literals and skips generic/resource refs", () => {
  const root = makeTempDir("aos-ui-lint-families-");
  const design = writeContract(root, [12], null, {
    fontSizes: [14],
    fontWeights: ["600"],
    fontFamilies: ["SF Pro", "PingFang SC"]
  });
  writeSource(
    root,
    "app/src/Text.ts",
    [
      'const ok = { fontFamily: "SF Pro" };',
      "const ok2 = { fontFamily: 'PingFang SC' };",
      'const bad = { fontFamily: "Arial" };',
      '.custom("SF Pro", size: 14)',
      '.custom("Helvetica", size: 14)',
      'UIFont(name: "Arial", size: 14)',
      `const css = 'font-family: "SF Pro", sans-serif;';`,
      `const cssBad = 'font-family: "Arial", sans-serif;';`,
      `const cssGeneric = 'font-family: -apple-system, BlinkMacSystemFont, "Arial";';`,
      '<TextView android:fontFamily="sans-serif" />',
      '<TextView android:fontFamily="@font/custom" />',
      '<TextView android:fontFamily="Arial" />'
    ].join("\n")
  );
  const report = runUiLint({ rootDir: root });
  assert.deepEqual(report.contract.fontFamilies, ["pingfang sc", "sf pro"]);
  const families = report.findings.filter((finding) => finding.rule === "font-family");
  assert.equal(families.length, 5);
  assert.deepEqual(
    families.map((finding) => finding.normalized).sort(),
    ["arial", "arial", "arial", "arial", "helvetica"]
  );
  assert.equal(
    report.findings.some((finding) => finding.rule === "font-family" && finding.value === "sans-serif"),
    false,
    "通用族不命中"
  );
  assert.equal(
    report.findings.some((finding) => finding.rule === "font-family" && finding.value.includes("@font")),
    false,
    "Android 资源引用不命中"
  );

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Text.ts",
          rule: "font-family",
          value: "Arial",
          owner: "qa",
          reason: "legacy",
          expiresAt: "2099-01-01T00:00:00.000Z"
        },
        {
          file: "app/src/Text.ts",
          rule: "font-family",
          value: "Helvetica",
          owner: "qa",
          reason: "legacy",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const allowed = runUiLint({ rootDir: root });
  assert.equal(
    allowed.findings.filter((finding) => finding.rule === "font-family" && finding.allowlisted)
      .length,
    5
  );
});

test("ui-lint: Android/Compose leading-alpha colors normalize to contract", () => {
  const root = makeTempDir("aos-ui-lint-color-order-");
  writeContract(root, [12], null, { colors: ["#1F40B0FF"], fontSizes: [14] });
  writeSource(
    root,
    "app/src/Colors.kt",
    ["val ok = Color(0xFF1F40B0)", "val bad = Color(0xFFABCDEF)"].join("\n")
  );
  const report = runUiLint({ rootDir: root });
  assert.equal(report.ok, false);
  const colors = report.findings.filter((finding) => finding.rule === "color");
  assert.equal(colors.length, 1);
  assert.equal(colors[0].value, "0xffabcdef");
  assert.equal(colors[0].normalized, "#abcdefff");
});

test("ui-lint: allowlist rule scopes color/font-size; legacy entries stay radius-only", () => {
  const root = makeTempDir("aos-ui-lint-rule-allow-");
  const design = writeContract(root, [12], null, { colors: ["#112233"], fontSizes: [14] });
  writeSource(
    root,
    "app/src/Theme.ts",
    ['const bad = "#ABCDEF";', "const size = { fontSize: 15 };"].join("\n")
  );
  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Theme.ts",
          rule: "color",
          value: "#abcdef",
          owner: "qa",
          reason: "legacy color",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const scoped = runUiLint({ rootDir: root });
  assert.equal(scoped.findings.find((finding) => finding.rule === "color").allowlisted, true);
  assert.equal(scoped.findings.find((finding) => finding.rule === "font-size").allowlisted, false);
  assert.equal(scoped.ok, false);

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Theme.ts",
          value: 15,
          owner: "qa",
          reason: "legacy numeric entry",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const legacy = runUiLint({ rootDir: root });
  assert.equal(
    legacy.findings.find((finding) => finding.rule === "font-size").allowlisted,
    false,
    "缺 rule 的旧条目仍只作用于圆角"
  );
});

test("ui-lint: allowlist with owner/reason/expiry suppresses finding", () => {
  const root = makeTempDir("aos-ui-lint-allow-");
  const design = writeContract(root);
  writeSource(root, "app/src/Main.kt", "val bad = RoundedCornerShape(99.dp)\n");
  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Main.kt",
          value: 99,
          owner: "qa",
          reason: "legacy card",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const report = runUiLint({ rootDir: root });
  assert.equal(report.ok, true);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].allowlisted, true);
  assert.equal(report.allowlisted, 1);

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Main.kt",
          value: 99,
          owner: "qa",
          reason: "legacy card",
          expiresAt: "2000-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const expired = runUiLint({ rootDir: root });
  assert.equal(expired.ok, false);
  assert.equal(expired.findings[0].allowlisted, false);
  assert.match(expired.warnings.join("\n"), /已过期/);
});

test("ui-lint: missing contract is a hard error", () => {
  const root = makeTempDir("aos-ui-lint-missing-");
  assert.throws(() => runUiLint({ rootDir: root }), /ui-contract/);
});

test("ui-lint: --require-complete blocks non-extracted screens", () => {
  const root = makeTempDir("aos-ui-lint-complete-");
  writeContract(root, [12], [
    { id: "home", name: "Home", status: "extracted", tokens: { cornerRadius: [12] } },
    { id: "detail", name: "Detail", status: "no-baseline", tokens: { cornerRadius: [12] } }
  ]);
  writeSource(root, "app/src/A.kt", "val a = RoundedCornerShape(12.dp)\n");
  const normal = runUiLint({ rootDir: root });
  assert.equal(normal.ok, true);
  assert.equal(normal.contract.incomplete.length, 1);
  const strict = runUiLint({ rootDir: root, requireComplete: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.contract.incomplete[0].id, "detail");
  assert.equal(strict.contract.incomplete[0].status, "no-baseline");
});

test("ui-lint: allowlist expiration is reported and can fail CI", () => {
  const root = makeTempDir("aos-ui-lint-expiry-");
  const design = writeContract(root);
  writeSource(root, "app/src/A.kt", "val a = RoundedCornerShape(99.dp)\n");
  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/A.kt",
          value: 99,
          owner: "qa",
          reason: "legacy",
          expiresAt: "2026-10-26T00:00:00.000Z"
        }
      ]
    })
  );
  const now = () => Date.parse("2026-10-23T00:00:00.000Z");
  const report = runUiLint({ rootDir: root, now });
  assert.equal(report.ok, true);
  assert.equal(report.allowlist.expiring.length, 1);
  assert.equal(report.allowlist.expiring[0].daysLeft, 3);
  assert.match(report.warnings.join("\n"), /即将过期/);
  const strict = runUiLint({ rootDir: root, now, failOnExpiring: true });
  assert.equal(strict.ok, false);
});

test("ui-lint: --changed only scans working tree changes", () => {
  const root = makeTempDir("aos-ui-lint-changed-");
  writeContract(root);
  writeSource(root, "app/src/A.kt", "val a = RoundedCornerShape(12.dp)\n");
  writeSource(root, "app/src/B.kt", "val b = RoundedCornerShape(99.dp)\n");
  const git = (args) =>
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
      cwd: root,
      stdio: "ignore"
    });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  writeSource(root, "app/src/A.kt", "val a = RoundedCornerShape(99.dp)\n");
  const all = runUiLint({ rootDir: root });
  assert.equal(all.findings.length, 2, "全量扫描同时命中 A/B");
  const changed = runUiLint({ rootDir: root, changed: true });
  assert.equal(changed.findings.length, 1);
  assert.equal(changed.findings[0].file, "app/src/A.kt");
  assert.equal(changed.scanned.files, 1);

  const outside = makeTempDir("aos-ui-lint-nogit-");
  writeContract(outside);
  writeSource(outside, "app/src/A.kt", "val a = RoundedCornerShape(99.dp)\n");
  assert.throws(() => runUiLint({ rootDir: outside, changed: true }), /git 仓库/);
});

test("ui-lint: per-screen scoping uses explicit screen-map file mapping", () => {
  const root = makeTempDir("aos-ui-lint-per-screen-");
  writeContract(root, [12], [
    {
      id: "home",
      name: "Home",
      status: "extracted",
      tokens: {
        cornerRadius: [12],
        colors: ["#112233"],
        fontSizes: [14],
        fontWeights: ["600"],
        fontFamilies: ["SF Pro"]
      }
    },
    {
      id: "detail",
      name: "Detail",
      status: "extracted",
      tokens: {
        cornerRadius: [16],
        colors: ["#445566"],
        fontSizes: [18],
        fontWeights: ["700"],
        fontFamilies: ["PingFang SC"]
      }
    }
  ]);
  writeSource(
    root,
    "app/src/Home.kt",
    [
      "val okRadius = RoundedCornerShape(12.dp)",
      "val leakedRadius = RoundedCornerShape(16.dp)",
      'val leakedColor = Color("#445566")',
      "val leakedSize = { fontSize: 18 }",
      "val leakedWeight = { fontWeight: 700 }",
      'val leakedFamily = { fontFamily: "PingFang SC" }'
    ].join("\n")
  );
  writeSource(
    root,
    "app/src/Detail.kt",
    ["val ok = RoundedCornerShape(16.dp)", 'val color = Color("#445566")'].join("\n")
  );
  writeSource(root, "app/src/Shared.kt", "val shared = RoundedCornerShape(12.dp)\n");
  writeScreenMap(root, [
    { design: { screen: "Home" }, code: { file: "app/src/Home.kt" }, source: "manual" },
    { design: { screen: "Detail" }, code: { file: "app/src/Detail.kt" }, source: "manual" }
  ]);

  const global = runUiLint({ rootDir: root });
  assert.equal(global.ok, true, "默认仍按全局并集");
  assert.equal(global.mapping.screens.mapped, 2);
  assert.deepEqual(global.mapping.screens.unmapped, []);
  assert.equal(global.mapping.files.scoped, 2);
  assert.equal(global.mapping.files.globalFallback, 1);

  const scoped = runUiLint({ rootDir: root, perScreen: true });
  assert.equal(scoped.ok, false);
  assert.equal(scoped.findings.every((finding) => finding.file === "app/src/Home.kt"), true);
  assert.deepEqual(
    scoped.findings.map((finding) => finding.rule).sort(),
    ["color", "font-family", "font-size", "font-weight", "radius"]
  );
  for (const finding of scoped.findings) {
    assert.equal(finding.scope, "screen");
    assert.deepEqual(finding.screens, ["Home"]);
  }
  assert.deepEqual(
    scoped.findings.find((finding) => finding.rule === "radius").allowed,
    [0, 12]
  );
  assert.ok(
    scoped.warnings.some((warning) => warning.includes("1 个文件无显式映射")),
    "未映射文件回退全局并报告"
  );
});

test("ui-lint: require-mapping demands explicit mapping for extracted screens", () => {
  const root = makeTempDir("aos-ui-lint-require-mapping-");
  writeContract(root, [12], [
    { id: "home", name: "Home", status: "extracted", tokens: { cornerRadius: [12] } },
    { id: "detail", name: "Detail", status: "extracted", tokens: { cornerRadius: [16] } }
  ]);
  writeSource(root, "app/src/Shared.kt", "val shared = RoundedCornerShape(12.dp)\n");
  writeScreenMap(root, [
    { design: { screen: "Home" }, code: { file: "app/src/Shared.kt" }, source: "manual" }
  ]);

  const report = runUiLint({ rootDir: root, requireMapping: true });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.mapping.screens.unmapped.map((screen) => screen.name),
    ["Detail"]
  );
  assert.ok(report.warnings.some((warning) => warning.includes("--require-mapping")));

  const relaxed = runUiLint({ rootDir: root });
  assert.equal(relaxed.ok, true, "默认不要求映射覆盖");
});

test("ui-lint: component mapping and heuristic candidates are reported with confidence", () => {
  const root = makeTempDir("aos-ui-lint-component-");
  writeContract(root, [12], [
    { id: "home", name: "Home", status: "extracted", tokens: { cornerRadius: [12] } }
  ]);
  writeSource(
    root,
    "app/src/HomeView.swift",
    ["struct HomeView: View {", "  var body: some View { RoundedRectangle(cornerRadius: 16) }", "}"]
      .join("\n")
  );
  writeScreenMap(root, [
    { design: { screen: "Home" }, code: { component: "HomeView" }, source: "manual" }
  ]);
  const component = runUiLint({ rootDir: root, perScreen: true, requireMapping: true });
  assert.equal(component.mapping.files.scoped, 1);
  assert.equal(component.mapping.screens.mapped, 1);
  assert.equal(component.mapping.mappings[0].usedForScoping, true);
  assert.equal(
    component.findings.some((finding) => finding.scope === "screen" && finding.value === 16),
    true
  );

  const heuristicRoot = makeTempDir("aos-ui-lint-heuristic-");
  writeContract(heuristicRoot, [12], [
    { id: "home", name: "Home", status: "extracted", tokens: { cornerRadius: [12] } }
  ]);
  writeSource(
    heuristicRoot,
    "app/src/Home.kt",
    ["class Home {", "  val radius = RoundedCornerShape(16.dp)", "}"].join("\n")
  );
  const heuristic = runUiLint({ rootDir: heuristicRoot, perScreen: true });
  const candidate = heuristic.mapping.mappings.find(
    (entry) => entry.source === "heuristic" && entry.screenId === "home"
  );
  assert.ok(candidate, "屏幕名与文件/类名匹配时给出启发式候选");
  assert.equal(candidate.confidence, 0.5);
  assert.equal(candidate.usedForScoping, false);
  assert.equal(heuristic.mapping.files.heuristic, 1);
  assert.equal(heuristic.findings[0].scope, undefined, "启发式不参与逐屏收窄");
  assert.ok(heuristic.warnings.some((warning) => warning.includes("启发式候选")));
});

test("ui-lint: partial screen mapping falls back to global without pretending coverage", () => {
  const root = makeTempDir("aos-ui-lint-partial-map-");
  writeContract(root, [12], [
    { id: "home", name: "Home", status: "partial", tokens: { cornerRadius: [12] } }
  ]);
  writeSource(root, "app/src/Home.kt", "val ok = RoundedCornerShape(12.dp)\n");
  writeScreenMap(root, [
    { design: { screen: "Home" }, code: { file: "app/src/Home.kt" }, source: "manual" }
  ]);
  const report = runUiLint({ rootDir: root, perScreen: true, requireMapping: true });
  assert.equal(report.mapping.files.scoped, 0);
  assert.equal(report.mapping.files.explicit, 1);
  assert.equal(report.mapping.mappings[0].usedForScoping, false);
  assert.equal(report.mapping.screens.unmapped[0].status, "partial");
  assert.equal(report.mapping.screens.unmapped[0].explicit, true);
  assert.equal(report.mapping.screens.mapped, 0, "partial 屏不计入逐屏覆盖");
  assert.equal(report.findings.length, 0);
  assert.equal(report.ok, true, "require-mapping 只硬性要求 extracted 屏");
});

test("ui-lint: contract fingerprint detects design source drift (P7)", () => {
  const root = makeTempDir("aos-ui-lint-fingerprint-");
  const design = writeContract(root, [12]);
  const flowsPath = path.join(design, "flows.json");
  fs.writeFileSync(flowsPath, JSON.stringify({ screens: [{ id: "home", name: "Home" }] }));
  fs.mkdirSync(path.join(design, "pen", "screens"), { recursive: true });
  fs.writeFileSync(path.join(design, "pen", "screens", "home.pen"), "{}");
  const fingerprint = uiContractFingerprint(flowsPath, design);
  const contractPath = path.join(design, "ui-contract.json");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
  contract.source = {
    flows: ".artemis/design/flows.json",
    designRoot: ".artemis/design",
    fingerprint
  };
  fs.writeFileSync(contractPath, JSON.stringify(contract));
  writeSource(root, "app/src/Main.kt", "val ok = RoundedCornerShape(12.dp)\n");

  const current = runUiLint({ rootDir: root, failOnStaleContract: true });
  assert.equal(current.contract.fingerprintStatus, "current");
  assert.equal(current.ok, true);
  assert.equal(current.warnings.some((warning) => warning.includes("契约指纹过期")), false);

  fs.writeFileSync(flowsPath, JSON.stringify({ screens: [{ id: "home", name: "Home changed" }] }));
  const stale = runUiLint({ rootDir: root, failOnStaleContract: true });
  assert.equal(stale.contract.fingerprintStatus, "stale");
  assert.equal(stale.ok, false, "--fail-on-stale-contract 命中");
  assert.equal(stale.findings.length, 0);
  assert.ok(stale.warnings.some((warning) => warning.includes("契约指纹过期")));

  const relaxed = runUiLint({ rootDir: root });
  assert.equal(relaxed.contract.fingerprintStatus, "stale");
  assert.equal(relaxed.ok, true, "默认只告警、不改门禁");

  fs.rmSync(flowsPath);
  const unverifiable = runUiLint({ rootDir: root, failOnStaleContract: true });
  assert.equal(unverifiable.contract.fingerprintStatus, "unverifiable");
  assert.equal(unverifiable.ok, false);
  assert.ok(unverifiable.warnings.some((warning) => warning.includes("无法校验")));
});

test("suite ui-lint: --per-screen/--require-mapping drive JSON and exit codes", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({}),
    store: new MemoryStore()
  });
  writeContract(dir, [12], [
    { id: "home", name: "Home", status: "extracted", tokens: { cornerRadius: [12] } },
    { id: "detail", name: "Detail", status: "extracted", tokens: { cornerRadius: [16] } }
  ]);
  writeSource(dir, "app/src/Home.kt", "val leaked = RoundedCornerShape(16.dp)\n");
  writeSource(dir, "app/src/Shared.kt", "val shared = RoundedCornerShape(12.dp)\n");
  writeScreenMap(dir, [
    { design: { screen: "Home" }, code: { file: "app/src/Home.kt" }, source: "manual" }
  ]);
  const run = async (args) => {
    const logs = [];
    const errors = [];
    const code = await runSuiteCommand(args, {
      buildRuntime: async () => ({ runtime, dispose: async () => {} }),
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line)
    });
    return { code, logs, errors };
  };

  const global = await run(["ui-lint", "--json"]);
  assert.equal(global.code, 0, "默认全局并集不报 16");
  const globalPayload = JSON.parse(global.logs.join("\n"));
  assert.equal(globalPayload.mapping.screens.mapped, 1);
  assert.equal(globalPayload.mapping.screens.unmapped[0].name, "Detail");
  assert.equal(globalPayload.mapping.files.scoped, 1);
  assert.equal(globalPayload.mapping.files.explicit, 1);
  assert.equal(globalPayload.mapping.files.globalFallback, 1);

  const scoped = await run(["ui-lint", "--per-screen", "--json"]);
  assert.equal(scoped.code, 1);
  const scopedPayload = JSON.parse(scoped.logs.join("\n"));
  assert.equal(scopedPayload.findings[0].rule, "radius");
  assert.equal(scopedPayload.findings[0].scope, "screen");
  assert.deepEqual(scopedPayload.findings[0].screens, ["Home"]);
  assert.deepEqual(scopedPayload.findings[0].allowed, [0, 12]);

  const strict = await run(["ui-lint", "--per-screen", "--require-mapping", "--json"]);
  assert.equal(strict.code, 1);
  const strictPayload = JSON.parse(strict.logs.join("\n"));
  assert.equal(strictPayload.ok, false);
  assert.ok(strictPayload.warnings.some((warning) => warning.includes("--require-mapping")));

  const text = await run(["ui-lint", "--per-screen", "--require-mapping"]);
  assert.equal(text.code, 1);
  assert.ok(text.logs.some((line) => line.includes("逐屏映射: screen-map")));
  assert.ok(text.errors.some((line) => line.includes("--require-mapping")));

  const stale = await run(["ui-lint", "--fail-on-stale-contract", "--json"]);
  assert.equal(stale.code, 1);
  assert.equal(
    JSON.parse(stale.logs.join("\n")).contract.fingerprintStatus,
    "unverifiable"
  );

  const badBudget = await run(["ui-lint", "--max-total-bytes", "0"]);
  assert.equal(badBudget.code, 2);
  assert.ok(badBudget.errors.some((line) => line.includes("--max-total-bytes")));
});

test("suite ui-lint: CLI JSON + exit 1/0 + missing contract exit 2", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({}),
    store: new MemoryStore()
  });
  const design = writeContract(dir);
  writeSource(dir, "app/src/Main.kt", "val bad = RoundedCornerShape(99.dp)\n");
  const run = async (args) => {
    const logs = [];
    const errors = [];
    const code = await runSuiteCommand(args, {
      buildRuntime: async () => ({ runtime, dispose: async () => {} }),
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line)
    });
    return { code, logs, errors };
  };

  const first = await run(["ui-lint", "--json"]);
  assert.equal(first.code, 1);
  const payload = JSON.parse(first.logs.join("\n"));
  assert.equal(payload.ok, false);
  assert.equal(payload.findings[0].rule, "radius");
  assert.equal(payload.findings[0].value, 99);

  fs.writeFileSync(
    path.join(design, "ui-lint-allowlist.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          file: "app/src/Main.kt",
          value: 99,
          owner: "qa",
          reason: "legacy",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  const allowed = await run(["ui-lint", "--json"]);
  assert.equal(allowed.code, 0);
  assert.equal(JSON.parse(allowed.logs.join("\n")).allowlisted, 1);

  writeContract(dir, [12], [
    { id: "home", name: "Home", status: "no-baseline", tokens: { cornerRadius: [12] } }
  ]);
  const incomplete = await run(["ui-lint", "--require-complete", "--json"]);
  assert.equal(incomplete.code, 1);
  assert.equal(JSON.parse(incomplete.logs.join("\n")).contract.incomplete.length, 1);

  fs.rmSync(path.join(design, "ui-contract.json"));
  const missing = await run(["ui-lint"]);
  assert.equal(missing.code, 2);
  assert.match(missing.errors.join("\n"), /ui-contract/);
});
