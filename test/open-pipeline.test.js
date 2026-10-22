import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

import { runOpenJob } from "../dist/open/pipeline.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function generatedCase() {
  return {
    id: "case-1",
    displayId: "TC_000001",
    name: "登录页 → 首页",
    screens: ["登录页", "首页"],
    steps: ["点击「登录」，验证进入「首页」"],
    preconditions: ["打开应用并停留在「登录页」"],
    taskDesc: "打开应用…",
    continuation: false,
    startScreen: "登录页",
    prelude: [],
    expectations: [
      { screen: "首页", hints: [], provenance: "explicit", confidence: "high", kind: "assert" }
    ],
    preflight: { screen: "登录页", hints: [] },
    module: "登录"
  };
}

function staticGraph() {
  return {
    screens: [
      { id: "1:1", name: "登录页", suggestedRoute: "/login", childNames: [], textHints: [] },
      { id: "1:2", name: "首页", suggestedRoute: "/home", childNames: [], textHints: [] }
    ],
    edges: [
      {
        from: { id: "1:1", name: "登录页" },
        to: { id: "1:2", name: "首页" },
        element: { id: "9:1", name: "箭头", type: "line" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NAVIGATE",
        provenance: "inferred",
        confidence: "low"
      }
    ],
    entryScreens: ["登录页"],
    unresolvedDestinations: []
  };
}

function deps({ cases = [generatedCase()] } = {}) {
  return {
    extractFigma: async (runtime) => {
      const design = join(runtime.configDirAbs, "design");
      await mkdir(join(design, "screens", "figma-ABC123"), { recursive: true });
      await writeFile(
        join(design, "flows.json"),
        JSON.stringify({
          schemaVersion: 3,
          screens: staticGraph().screens,
          edges: staticGraph().edges,
          entryScreens: staticGraph().entryScreens,
          unresolvedDestinations: [],
          warnings: [{ code: "static-flow-inferred", message: "静态稿推断" }]
        }),
        "utf-8"
      );
      await writeFile(join(design, "flow-map.md"), "# 设计流程（静态稿推断）\n", "utf-8");
      await writeFile(join(design, "screens", "figma-ABC123", "1-1.png"), PNG);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
    generate: async (runtime) => {
      const design = join(runtime.configDirAbs, "design");
      await mkdir(design, { recursive: true });
      await writeFile(join(design, "tests.json"), JSON.stringify({ flows: cases }), "utf-8");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    }
  };
}

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 18);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf-8");
    const data = buffer.subarray(offset + 30 + nameLength + extra, offset + 30 + nameLength + extra + size);
    entries.push({ name, data });
    offset += 30 + nameLength + extra + size;
  }
  return entries;
}

test("pipeline: static figma produces design.md, cases.xlsx, screens and meta.json", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "aos-open-pipeline-"));
  try {
    const result = await runOpenJob(
      {
        source: "figma",
        figmaUrl: "https://www.figma.com/design/ABC123/demo",
        figmaToken: "tok",
        llm: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" }
      },
      workDir,
      deps()
    );
    const entries = zipEntries(await readFile(result.zipPath));
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      ["cases.xlsx", "design.md", "meta.json", "screens/figma-ABC123/1-1.png"].sort()
    );
    const design = entries.find((entry) => entry.name === "design.md");
    assert.match(design.data.toString("utf-8"), /设计流程（静态稿推断）/);
    const meta = JSON.parse(entries.find((entry) => entry.name === "meta.json").data.toString("utf-8"));
    assert.equal(meta.model, "m");
    assert.equal(meta.counts.cases, 1);
    assert.equal(result.counts.screens, 2);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("pipeline: pen source uses host pen readiness and packaged screenshots", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "aos-open-pipeline-"));
  try {
    const penFile = join(workDir, "input.pen");
    await writeFile(penFile, "{}", "utf-8");
    const result = await runOpenJob(
      { source: "pen", penFile, llm: null },
      workDir,
      {
        ...deps(),
        penReady: async () => ({ ok: true }),
        extractPen: async (runtime) => {
          const design = join(runtime.configDirAbs, "design");
          await mkdir(join(design, "screens", "pen-demo"), { recursive: true });
          await writeFile(
            join(design, "flows.json"),
            JSON.stringify({ screens: staticGraph().screens, edges: staticGraph().edges, warnings: [] }),
            "utf-8"
          );
          await writeFile(join(design, "flow-map.md"), "# pen 设计理解\n", "utf-8");
          await writeFile(join(design, "screens", "pen-demo", "1.png"), PNG);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
        }
      }
    );
    const entries = zipEntries(await readFile(result.zipPath));
    assert.ok(entries.some((entry) => entry.name === "screens/pen-demo/1.png"));
    assert.equal(result.counts.screens, 2);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("pipeline: staticFallback is passed to extraction", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "aos-open-pipeline-"));
  try {
    let captured = null;
    const base = deps();
    const extract = base.extractFigma;
    base.extractFigma = async (runtime, args, deps2) => {
      captured = args;
      return extract(runtime, args, deps2);
    };
    await runOpenJob(
      {
        source: "figma",
        figmaUrl: "https://www.figma.com/design/ABC123/demo",
        staticFallback: false,
        llm: null
      },
      workDir,
      base
    );
    assert.equal(captured.staticFallback, false);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("pipeline: bad template fails with template_invalid", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "aos-open-pipeline-"));
  const template = join(workDir, "bad.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("模版").addRow(["用例编号"]);
    await workbook.xlsx.writeFile(template);
    await assert.rejects(
      () =>
        runOpenJob(
          {
            source: "figma",
            figmaUrl: "https://www.figma.com/design/ABC123/demo",
            templatePath: template,
            llm: null
          },
          workDir,
          deps()
        ),
      (error) => error.code === "template_invalid"
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("pipeline: empty case list fails with no_cases", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "aos-open-pipeline-"));
  try {
    await assert.rejects(
      () =>
        runOpenJob(
          {
            source: "figma",
            figmaUrl: "https://www.figma.com/design/ABC123/demo",
            llm: null
          },
          workDir,
          deps({ cases: [] })
        ),
      (error) => error.code === "no_cases"
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
