import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { penImportTokens } from "../dist/pen/tokens.js";
import { penImportStrings } from "../dist/pen/strings.js";
import { penExportBrief } from "../dist/pen/brief.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

const PEN_SAMPLE = `{
  // pen.dev 文档允许注释
  "version": "2.19",
  "themes": { "Mode": ["Light", "Dark"] },
  "variables": {
    "color.bg": { "type": "color", "value": [{ "value": "#FFFFFF" }, { "value": "#111111", "theme": { "Mode": "Dark" } }] },
    "color.brand.primary": { "type": "color", "value": "#3B82F6" },
    "color.brand.primaryAlpha": { "type": "color", "value": "$color.brand.primary" },
    "radius.card": { "type": "number", "value": 12 },
    "space.gap": { "type": "number", "value": 8 }
  },
  "children": [
    {
      "id": "screen-home", "type": "frame", "name": "Home", "x": 0, "y": 0, "width": 390, "height": 844,
      "fill": "$color.bg", "layout": "vertical", "gap": 8, "padding": [16, 16, 16, 16],
      "children": [
        { "id": "title", "type": "text", "name": "Title", "content": "欢迎登录", "fill": "$color.bg", "fontFamily": "Inter", "fontSize": 24, "fontWeight": "700" },
        {
          "id": "cta-bg", "type": "rectangle", "name": "CTA Background", "width": 200, "height": 48, "cornerRadius": 8,
          "fill": "#3B82F6",
          "effect": { "type": "shadow", "shadowType": "outer", "offset": { "x": 0, "y": 2 }, "blur": 4, "color": "#00000040" }
        },
        {
          "id": "card-def", "type": "frame", "name": "Card", "reusable": true, "width": 300, "height": 120,
          "cornerRadius": "$radius.card", "layout": "none",
          "children": [{ "id": "card-title", "type": "text", "name": "Card Title", "content": "卡片标题" }]
        },
        { "id": "card-1", "type": "ref", "ref": "card-def", "x": 16, "y": 200 }
      ]
    },
    {
      "id": "screen-profile", "type": "frame", "name": "Profile", "x": 500, "y": 0, "width": 390, "height": 844,
      "children": [{ "id": "welcome", "type": "text", "name": "Frame 427", "content": "你好, %s" }]
    }
  ]
}`;

function makePenProject({ extraFiles = {} } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "demo.pen"), PEN_SAMPLE, "utf-8");
  for (const [relative, content] of Object.entries(extraFiles)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf-8");
  }
  return dir;
}

test("pen_import_tokens: 变量名即 token、modes/别名/usage、幂等与 updated", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const first = parseToolResult(await penImportTokens(runtime, {}));
  assert.equal(first.ok, true);
  assert.equal(first.stack, "flutter");
  assert.equal(first.counts.penColorVariables, 3);
  assert.equal(first.counts.new, 3);
  assert.equal(first.counts.skippedNonColor, 2);
  assert.deepEqual(first.skippedByType, { number: 2 });

  const canonical = JSON.parse(fs.readFileSync(path.join(dir, ".artemis", "design", "tokens.json"), "utf-8"));
  assert.equal(canonical.color.bg.$value, "#FFFFFFFF");
  assert.deepEqual(canonical.color.bg.$extensions.aos.modes, {
    default: "#FFFFFFFF",
    "Mode=Dark": "#111111FF"
  });
  assert.equal(canonical.color.brand.primary.$value, "#3B82F6FF");
  assert.equal(canonical.color.brand.primaryAlpha.$value, "{color.brand.primary}");
  assert.equal(canonical.color.brand.primaryAlpha.$extensions.aos.aliasOf, "color.brand.primary");

  const byName = new Map(first.tokens.map((token) => [token.name, token]));
  assert.equal(byName.get("color.bg").usageCount, 2);
  assert.equal(byName.get("color.brand.primary").usageCount, 1);

  const dart = fs.readFileSync(path.join(dir, "lib", "theme", "aos_tokens.dart"), "utf-8");
  assert.match(dart, /Color\(0xFFFFFFFF\)/);
  assert.match(dart, /Color\(0xFF3B82F6\)/);

  const second = parseToolResult(await penImportTokens(runtime, {}));
  assert.equal(second.counts.unchanged, 3);
  assert.equal(second.stackFile.action, "unchanged");

  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "demo.pen"),
    PEN_SAMPLE.replace("#3B82F6", "#EF4444"),
    "utf-8"
  );
  const third = parseToolResult(await penImportTokens(runtime, {}));
  assert.equal(third.counts.updated, 1);
  assert.equal(third.actions.find((action) => action.name === "color.brand.primary").action, "updated");
  const updated = JSON.parse(fs.readFileSync(path.join(dir, ".artemis", "design", "tokens.json"), "utf-8"));
  assert.equal(updated.color.brand.primary.$value, "#EF4444FF");
});

test("pen_import_tokens: dryRun 不落盘；非本工具文件不覆盖；enforcement=block", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const preview = parseToolResult(await penImportTokens(runtime, { dryRun: true }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.stackFile.action, "planned");
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "tokens.json")));

  fs.mkdirSync(path.join(dir, "lib", "theme"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "theme", "aos_tokens.dart"), "// hand-written\n");
  const unmanaged = parseToolResult(await penImportTokens(runtime, {}));
  assert.equal(unmanaged.stackFile.action, "skipped_unmanaged");

  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "foo.dart"), "const c = Color(0xFF123456);\n");
  const blocked = await penImportTokens(runtime, { enforcement: "block" });
  assert.equal(blocked.isError, true);
  assert.equal(parseToolResult(blocked).blocked, true);
});

test("pen_import_strings: 冻结 key、reusable 组件上下文、资源写入与 source_changed", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const first = parseToolResult(await penImportStrings(runtime, {}));
  assert.equal(first.ok, true);
  assert.deepEqual(first.stacks, ["flutter"]);
  const byKey = new Map(first.entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("home.title").sourceText, "欢迎登录");
  assert.equal(byKey.get("card.card_title").sourceText, "卡片标题");
  const profileEntry = first.entries.find((entry) => entry.screen === "Profile");
  assert.equal(profileEntry.lifecycle, "needs_rename");
  assert.deepEqual(profileEntry.placeholders, ["arg1"]);

  const arb = JSON.parse(fs.readFileSync(path.join(dir, "lib", "l10n", "app_zh.arb"), "utf-8"));
  assert.equal(arb.homeTitle, "欢迎登录");
  assert.equal(arb.cardCardTitle, "卡片标题");

  const second = parseToolResult(await penImportStrings(runtime, {}));
  assert.equal(second.counts.newKeys, 0);
  assert.equal(second.counts.sourceChanged, 0);
  assert.equal(second.resources[0].action, "unchanged");

  fs.rmSync(path.join(dir, "lib", "l10n", "app_zh.arb"));
  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "demo.pen"),
    PEN_SAMPLE.replace("欢迎登录", "欢迎回来"),
    "utf-8"
  );
  const third = parseToolResult(await penImportStrings(runtime, {}));
  assert.equal(third.counts.sourceChanged, 1);
  const changed = third.entries.find((entry) => entry.key === "home.title");
  assert.equal(changed.sourceText, "欢迎回来");
  assert.equal(changed.lifecycle, "source_changed");
  const regenerated = JSON.parse(fs.readFileSync(path.join(dir, "lib", "l10n", "app_zh.arb"), "utf-8"));
  assert.equal(regenerated.homeTitle, "欢迎回来");
});

test("pen_import_strings: 既有翻译冲突可见且不被覆盖", async () => {
  const dir = makePenProject({
    extraFiles: { "lib/l10n/app_zh.arb": `${JSON.stringify({ homeTitle: "旧值" }, null, 2)}\n` }
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await penImportStrings(runtime, {}));
  assert.equal(payload.counts.conflicts, 1);
  const conflict = payload.resources[0].conflicts.find((entry) => entry.key === "homeTitle");
  assert.equal(conflict.existing, "旧值");
  const arb = JSON.parse(fs.readFileSync(path.join(dir, "lib", "l10n", "app_zh.arb"), "utf-8"));
  assert.equal(arb.homeTitle, "旧值");
});

test("pen_export_brief: 屏幕/路由/组件/tokens 摘要与 scaffold", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await penExportBrief(runtime, { scaffold: true }));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.screens, 2);
  assert.equal(payload.summary.components, 1);
  assert.equal(payload.summary.colors, 2);
  assert.ok(payload.brief.suggestedRoutes.includes("/"));
  assert.ok(payload.brief.suggestedRoutes.includes("/profile"));
  assert.equal(payload.brief.designSystem.colors[0].hex, "#FFFFFFFF");
  assert.equal(payload.brief.designSystem.colors[0].usageCount, 2);
  assert.equal(payload.brief.designSystem.typography[0].fontFamily, "Inter");
  assert.ok(payload.brief.designSystem.shadows.length >= 1);

  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));
  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, /# 构建简报/);
  assert.match(markdown, /pen_import_tokens/);

  assert.equal(payload.scaffold.count, 1);
  assert.ok(fs.existsSync(path.join(dir, "lib", "components", "card.dart")));
});
