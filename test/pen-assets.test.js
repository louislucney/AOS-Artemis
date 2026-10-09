import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseExportedPaths, penImportAssets, resolveImportTimeoutMs } from "../dist/pen/assets.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

const ASSET_PEN = `{
  // pen.dev 文档允许注释
  "version": "2.20",
  "children": [
    {
      "id": "screen-home", "type": "frame", "name": "Home", "width": 390, "height": 844,
      "children": [
        { "id": "hero", "type": "frame", "name": "Hero Banner", "width": 358, "height": 200 },
        { "id": "star", "type": "path", "name": "Star Icon", "width": 24, "height": 24, "geometry": "M0 0l10 10" },
        { "id": "bad", "type": "frame", "name": "Frame 427", "width": 40, "height": 40 }
      ]
    }
  ]
}`;

function makePenProject({ extraFiles = {}, pen = ASSET_PEN } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "demo.pen"), pen, "utf-8");
  for (const [relative, content] of Object.entries(extraFiles)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf-8");
  }
  return dir;
}

function makeFakePen({ missingIds = [], sameContent = false, error = null, version = "pen 0.3.10" } = {}) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input ?? "", timeoutMs: options.timeoutMs });
    if (args[0] === "version") return { code: 0, stdout: `${version}\n`, stderr: "" };
    if (error) return { code: null, stdout: "", stderr: "", error };
    const output = args[args.indexOf("-o") + 1];
    fs.writeFileSync(output, "saved\n");
    const printed = [];
    for (const line of (options.input ?? "").split("\n")) {
      const match = /^execute\(\{ input: (.*) \}\)$/.exec(line);
      if (!match) continue;
      const expression = JSON.parse(match[1]);
      const exportMatch = /^Export\((\[.*\]), ("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"), \{ scale: (\d+) \}\)$/.exec(
        expression
      );
      if (!exportMatch) continue;
      const ids = JSON.parse(exportMatch[1]);
      const format = JSON.parse(exportMatch[2]);
      const dir = JSON.parse(exportMatch[3]);
      const scale = Number(exportMatch[4]);
      fs.mkdirSync(dir, { recursive: true });
      for (const id of ids) {
        if (missingIds.includes(id)) continue;
        const ext = format === "jpeg" ? "jpeg" : format;
        const content = sameContent ? Buffer.from("same-image") : Buffer.from(`img:${id}:${scale}`);
        const file = path.join(dir, `${id}.${ext}`);
        fs.writeFileSync(file, content);
        printed.push(file);
      }
    }
    const stdout = `pen > OK\n## Print output\n${printed
      .map((file) => `Exported ${file}`)
      .join("\n")}\nSaved ${output}\nGoodbye.\n`;
    return { code: 0, stdout, stderr: "" };
  };
  return { exec, calls };
}

const deps = (fake) => ({
  exec: fake.exec,
  ensure: async () => ({ ok: true, source: "path", path: "/fake/pen", installed: false })
});

test("pen_import_assets: Flutter 倍率集写入、身份命名与报告", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const fake = makeFakePen();

  const payload = parseToolResult(
    await penImportAssets(runtime, { ids: ["star", "bad"] }, deps(fake))
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "pen");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.penCliVersion, "0.3.10");
  assert.equal(payload.vector, "unsupported");
  assert.equal(payload.counts.written, 6);
  assert.equal(payload.counts.assets, 2);
  assert.equal(payload.counts.files, 6);
  assert.deepEqual(payload.session.scales, [1, 2, 3]);
  assert.equal(payload.session.commands, 3);

  const interactive = fake.calls.filter((call) => call.args[0] === "interactive");
  assert.equal(interactive.length, 1, "单会话：1 次 CLI 进程");
  const commandLines = interactive[0].input.split("\n").filter((line) => line.startsWith("execute("));
  assert.equal(commandLines.length, 3, "命令数 = 倍率数");
  for (const line of commandLines) {
    assert.ok(line.includes('\\"star\\",\\"bad\\"'), "单条命令携带全部 ids");
  }

  assert.equal(
    fs.readFileSync(path.join(dir, "assets", "images", "star_icon.png"), "utf-8"),
    "img:star:1"
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "assets", "images", "2.0x", "star_icon.png"), "utf-8"),
    "img:star:2"
  );
  const dirtyNames = ["", "2.0x/", "3.0x/"].map(
    (prefix) => fs.readdirSync(path.join(dir, "assets", "images", prefix)).find((name) => name.startsWith("asset_"))
  );
  assert.equal(dirtyNames[0], dirtyNames[1], "身份命名：多倍率同名");
  assert.equal(dirtyNames[0], dirtyNames[2], "身份命名：多倍率同名");

  const reportPath = path.join(dir, ".artemis", "design", "import-report.pen.json");
  assert.equal(payload.savedTo, reportPath);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.vector, "unsupported");
  assert.equal(report.results.find((entry) => entry.sourceId === "star").sourceId, "star");
});

test("pen_import_assets: 幂等（同内容 unchanged）与 dryRun 不写盘", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const first = parseToolResult(await penImportAssets(runtime, { ids: ["star"] }, deps(makeFakePen())));
  assert.equal(first.counts.written, 3);

  const second = parseToolResult(await penImportAssets(runtime, { ids: ["star"] }, deps(makeFakePen())));
  assert.equal(second.counts.unchanged, 3);
  assert.equal(second.counts.written ?? 0, 0);

  fs.rmSync(path.join(dir, "assets"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, ".artemis", "design", "import-report.pen.json"), { force: true });
  const preview = parseToolResult(
    await penImportAssets(runtime, { ids: ["star"], dryRun: true }, deps(makeFakePen()))
  );
  assert.equal(preview.dryRun, true);
  assert.equal(preview.counts.planned, 3);
  assert.ok(!fs.existsSync(path.join(dir, "assets")));
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "import-report.pen.json")));
});

test("pen_import_assets: 同内容去重与 duplicate_of（batch hash）", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(
    await penImportAssets(runtime, { ids: ["star", "bad"] }, deps(makeFakePen({ sameContent: true })))
  );
  assert.equal(payload.counts.written, 1);
  assert.equal(payload.counts.duplicate, 5);
  const duplicate = payload.results.find((entry) => entry.status === "duplicate");
  assert.equal(duplicate.duplicateOf, "assets/images/star_icon.png");
});

test("pen_import_assets: 缺产物记 export-no-output + 批次告警；全缺报错", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const partial = parseToolResult(
    await penImportAssets(runtime, { ids: ["star", "bad"] }, deps(makeFakePen({ missingIds: ["star"] })))
  );
  assert.equal(partial.ok, true);
  assert.equal(partial.counts.error, 3);
  assert.ok(partial.warnings.some((line) => line.includes("部分缺")));
  const failed = partial.results.filter((entry) => entry.status === "error");
  assert.ok(failed.every((entry) => entry.error === "export-no-output"));

  const allMissing = await penImportAssets(
    runtime,
    { ids: ["star", "bad"] },
    deps(makeFakePen({ missingIds: ["star", "bad"] }))
  );
  assert.equal(allMissing.isError, true);
  const body = parseToolResult(allMissing);
  assert.ok(body.error.includes("未产出任何导出文件"));
  assert.ok(body.timeoutMs >= 60_000);
});

test("pen_import_assets: 未知 id 预校验失败且不调用 CLI", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const fake = makeFakePen();

  const result = await penImportAssets(runtime, { ids: ["star", "nope"] }, deps(fake));
  assert.equal(result.isError, true);
  assert.ok(parseToolResult(result).error.includes("nope"));
  assert.equal(fake.calls.length, 0);
});

test("pen_import_assets: iOS imageset 与 Contents.json（非矢量不写 properties）", async () => {
  const dir = makePenProject({ extraFiles: { "Demo.xcodeproj/project.pbxproj": "// xcode\n" } });
  fs.rmSync(path.join(dir, "pubspec.yaml"));
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await penImportAssets(runtime, { ids: ["star"] }, deps(makeFakePen())));
  assert.equal(payload.detectedStacks[0].id, "ios-native");
  assert.equal(payload.counts.written, 4);

  const imageset = path.join(dir, "Resources", "Assets.xcassets", "star_icon.imageset");
  assert.ok(fs.existsSync(path.join(imageset, "star_icon.png")));
  assert.ok(fs.existsSync(path.join(imageset, "star_icon@2x.png")));
  assert.ok(fs.existsSync(path.join(imageset, "star_icon@3x.png")));
  const contents = JSON.parse(fs.readFileSync(path.join(imageset, "Contents.json"), "utf-8"));
  assert.equal(contents.images.length, 3);
  assert.deepEqual(
    contents.images.map((entry) => entry.scale),
    ["1x", "2x", "3x"]
  );
  assert.ok(!("properties" in contents), "非矢量不写 properties");
});

test("pen_import_assets: jpeg 单倍率（densities:false）与扩展名 .jpeg", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(
    await penImportAssets(runtime, { ids: ["star"], format: "jpeg", densities: false }, deps(makeFakePen()))
  );
  assert.equal(payload.format, "jpeg");
  assert.equal(payload.counts.written, 1);
  assert.ok(fs.existsSync(path.join(dir, "assets", "images", "star_icon.jpeg")));
});

test("pen_import_assets: 超时熔断（错误分类 + 会话超时入响应）", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const fake = makeFakePen({ error: "timeout" });

  const result = await penImportAssets(runtime, { ids: ["star"] }, deps(fake));
  assert.equal(result.isError, true);
  const body = parseToolResult(result);
  assert.ok(body.error.includes("超时"));
  const interactive = fake.calls.find((call) => call.args[0] === "interactive");
  assert.ok(interactive.timeoutMs >= 60_000, "会话级超时传入 CLI");
});

test("pen_import_assets: ensure 失败给出指引", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const result = await penImportAssets(
    runtime,
    { ids: ["star"] },
    {
      ensure: async () => ({ ok: false, source: null, path: null, installed: false, error: "pen CLI 不可用", hint: "安装指引" })
    }
  );
  assert.equal(result.isError, true);
  const body = parseToolResult(result);
  assert.equal(body.error, "pen CLI 不可用");
  assert.equal(body.hint, "安装指引");
});

test("resolveImportTimeoutMs: 显式/AOS_PEN_IMPORT_TIMEOUT_MS/自适应与上下限", () => {
  const base = { AOS_PEN_TIMEOUT_MS: "120000" };
  assert.equal(resolveImportTimeoutMs(undefined, base, 3), 120_000);
  assert.equal(resolveImportTimeoutMs(undefined, base, 30), 60_000 + 30 * 5_000);
  assert.equal(resolveImportTimeoutMs(undefined, { ...base, AOS_PEN_IMPORT_TIMEOUT_MS: "300000" }, 30), 300_000);
  assert.equal(resolveImportTimeoutMs(200_000, { ...base, AOS_PEN_IMPORT_TIMEOUT_MS: "300000" }, 3), 200_000);
  assert.equal(resolveImportTimeoutMs(1_000, base, 3), 5_000);
  assert.equal(resolveImportTimeoutMs(99_999_999, base, 3), 30 * 60_000);
});

test("parseExportedPaths: 仅接受 base 目录内的 Exported 绝对路径", () => {
  const base = "/tmp/aos-probe";
  const log = [
    "pen > OK",
    `Exported ${base}/s2/abc.png   `,
    "Exported /somewhere/else/abc.png",
    "Exported relative.png",
    `Exported ${base}/s3/def.webp`
  ].join("\n");
  assert.deepEqual(parseExportedPaths(log, base), [`${base}/s2/abc.png`, `${base}/s3/def.webp`]);
});
