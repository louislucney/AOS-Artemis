import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { designAssistedImport } from "../dist/workflow/design-enrich.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function project() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  return { dir, runtime, store };
}

async function writeExcel(file, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("APP");
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(file);
  return file;
}

test("design_assisted_import: 显式 Wireframe exact/near/unmapped + 报告预览", async () => {
  const { dir, runtime, store } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Login", "Login", "Login", "1.Click login", "1.Home", "0.1_Login/Register"],
    ["TC_02", "Login", "Forgot", "Forgot", "1.Click forgot", "1.See form", "0.5.Forgot Password"],
    ["TC_03", "Home", "Home", "Home", "1.Open home", "1.See home", "Homepage"],
    ["TC_04", "Home", "Home", "No wireframe", "1.See account", "1.See account", ""],
    ["TC_05", "Home", "Home", "Near homepage", "1.Open home", "1.See home", "1.0_Homepage"],
    ["TC_06", "Home", "Home", "URL wireframe", "1.Open home", "1.See home", "https://figma.com/design/abc"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(
    index,
    JSON.stringify({
      screens: [
        { id: "s1", name: "0.1_Login/Register", textHints: ["Login", "Continue"] },
        { id: "s2", name: "Homepage", textHints: ["Home"] },
        { id: "s3", name: "0.3.2_Register_Card Info (Smile Classic)", textHints: ["Unique code"] }
      ]
    })
  );

  const result = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report.mode, "preview");
  assert.equal(result.report.summary.rows, 6);
  assert.equal(result.report.summary.withWireframe, 4);
  assert.equal(result.report.summary.withoutWireframe, 2);
  assert.deepEqual(result.report.summary.screenStatus, {
    exact: 2,
    near: 1,
    ambiguous: 0,
    unmapped: 1
  });
  assert.deepEqual(result.report.summary.rowStatus, {
    matched: 2,
    review: 2,
    unmapped: 1,
    "no-wireframe": 1
  });
  assert.equal(result.report.summary.structuralCandidates, 1);
  const urlRow = result.report.rows.find((row) => row.caseId === "TC_06");
  assert.equal(urlRow.status, "review", "URL 被过滤后可用步骤文本做结构候选");
  assert.equal(urlRow.structural.matches[0].name, "Homepage");
  assert.ok(result.report.warnings.some((warning) => warning.includes("URL/文件路径")));
  assert.ok(result.artifacts, "默认落 mapping 报告");
  assert.ok(fs.existsSync(result.artifacts.jsonPath));
  assert.ok(fs.existsSync(result.artifacts.mdPath));
  assert.equal((await store.listCaseSets(runtime.project.rootDir)).length, 0, "预览不写用例集");
});

test("design_assisted_import: apply 生成 enriched 用例集（exact nodeId，不覆盖原 Excel）", async () => {
  const { dir, runtime, store } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Login", "Login", "Login", "1.Click login", "1.Home", "0.1_Login/Register"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(
    index,
    JSON.stringify({
      screens: [{ id: "s1", name: "0.1_Login/Register", textHints: ["Login"] }]
    })
  );
  const before = fs.readFileSync(excel);

  const result = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    apply: true
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.apply, "apply 返回用例集");
  assert.match(result.apply.sourceId, /\+design:/);
  const sets = await store.listCaseSets(runtime.project.rootDir);
  assert.equal(sets.length, 1);
  const document = JSON.parse(fs.readFileSync(sets[0].features[0].jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.deepEqual(flow.designRefs, {
    screens: ["0.1_Login/Register"],
    nodeIds: ["s1"]
  });
  assert.ok(flow.taskDesc.includes("设计引用：0.1_Login/Register(s1)"));
  assert.deepEqual(fs.readFileSync(excel), before, "原 Excel 不改");
});

test("design_assisted_import: overrides 人工确认回流并用于 apply", async () => {
  const { dir, runtime, store } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Login", "Forgot", "Forgot", "1.Click forgot", "1.See form", "0.5.Forgot Password"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(index, JSON.stringify({ screens: [{ id: "h1x", name: "Homepage" }] }));
  const overridesPath = path.join(dir, "enrich-overrides.json");

  const preview = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    overridesPath,
    saveOverrides: true,
    overrides: [
      {
        rowNumber: 2,
        screen: "0.5.Forgot Password",
        screenId: "h1",
        screenName: "Forgot Password",
        confirmedBy: "qa"
      }
    ]
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.report.summary.humanMapped, 1);
  const row = preview.report.rows[0];
  assert.equal(row.status, "matched");
  assert.equal(row.screens[0].matchedBy, "human");
  assert.equal(row.screens[0].design.id, "h1");
  assert.ok(fs.existsSync(overridesPath));

  const applied = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    overridesPath,
    apply: true
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const sets = await store.listCaseSets(runtime.project.rootDir);
  assert.equal(sets.length, 1);
  const document = JSON.parse(fs.readFileSync(sets[0].features[0].jsonPath, "utf8"));
  assert.deepEqual(document.flows[0].designRefs, {
    screens: ["0.5.Forgot Password"],
    nodeIds: ["h1"]
  });
});

test("design_assisted_import: 同名多 id → ambiguous，不静默取第一个；override 后可 apply", async () => {
  const { dir, runtime, store } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Home", "Home", "Homepage", "1.Open home", "1.See home", "Homepage"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(
    index,
    JSON.stringify({
      screens: [
        { id: "h1", name: "Homepage", textHints: ["Home"] },
        { id: "h2", name: "Homepage", textHints: ["Home"] }
      ]
    })
  );

  const preview = await designAssistedImport(runtime, { excelPath: excel, screenIndexPath: index });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.report.summary.screenStatus, {
    exact: 0,
    near: 0,
    ambiguous: 1,
    unmapped: 0
  });
  const screen = preview.report.rows[0].screens[0];
  assert.equal(screen.status, "ambiguous");
  assert.equal(screen.design, null);
  assert.equal(screen.candidates.length, 2);

  const blocked = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    apply: true
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.category, "excel-mapping-no-exact");
  assert.equal((await store.listCaseSets(runtime.project.rootDir)).length, 0);

  const applied = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    apply: true,
    overrides: [
      { rowNumber: 2, screen: "Homepage", screenId: "h2", screenName: "Homepage" }
    ]
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const sets = await store.listCaseSets(runtime.project.rootDir);
  assert.equal(sets.length, 1);
  const document = JSON.parse(fs.readFileSync(sets[0].features[0].jsonPath, "utf8"));
  assert.deepEqual(document.flows[0].designRefs.nodeIds, ["h2"]);
});

test("design_assisted_import: 屏级 override（省略 rowNumber）复用到所有行并持久化", async () => {
  const { dir, runtime, store } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Home", "Home", "Homepage 1", "1.Open home", "1.See home", "Homepage"],
    ["TC_02", "Home", "Home", "Homepage 2", "1.Open home", "1.See home", "Homepage"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(
    index,
    JSON.stringify({
      screens: [
        { id: "h1", name: "Homepage" },
        { id: "h2", name: "Homepage" }
      ]
    })
  );
  const overridesPath = path.join(dir, "enrich-overrides.json");

  const applied = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    apply: true,
    overridesPath,
    saveOverrides: true,
    overrides: [{ screen: "Homepage", screenId: "h2", screenName: "Homepage" }]
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.report.summary.humanMapped, 2);
  const sets = await store.listCaseSets(runtime.project.rootDir);
  assert.equal(sets.length, 1);
  const document = JSON.parse(fs.readFileSync(sets[0].features[0].jsonPath, "utf8"));
  assert.deepEqual(
    document.flows.flatMap((flow) => flow.designRefs.nodeIds),
    ["h2", "h2"]
  );
  const saved = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].rowNumber, undefined);

  const reused = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    overridesPath
  });
  assert.equal(reused.ok, true, JSON.stringify(reused));
  assert.equal(reused.report.summary.humanMapped, 2);
});

test("design_assisted_import: 可疑模板/全 near/requireAllMapped → needs-info", async () => {
  const { dir, runtime } = await project();
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(index, JSON.stringify({ screens: [{ id: "h1", name: "Homepage" }] }));

  const urlExcel = await writeExcel(path.join(dir, "url.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Wireframe"],
    ["TC_01", "Home", "Home", "URL", "https://figma.com/design/abc"]
  ]);
  const urlPreview = await designAssistedImport(runtime, {
    excelPath: urlExcel,
    screenIndexPath: index
  });
  assert.equal(urlPreview.ok, true, JSON.stringify(urlPreview));
  assert.equal(urlPreview.needsInfo.category, "excel-wireframe-unresolved");

  const nearExcel = await writeExcel(path.join(dir, "near.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Home", "Home", "Near", "1.Open home", "1.See home", "1.0_Homepage"]
  ]);
  const nearApply = await designAssistedImport(runtime, {
    excelPath: nearExcel,
    screenIndexPath: index,
    apply: true
  });
  assert.equal(nearApply.ok, false);
  assert.equal(nearApply.needs, "info");
  assert.equal(nearApply.category, "excel-mapping-no-exact");

  const nearAllowed = await designAssistedImport(runtime, {
    excelPath: nearExcel,
    screenIndexPath: index,
    apply: true,
    allowNear: true,
    requireAllMapped: true
  });
  assert.equal(nearAllowed.ok, true, JSON.stringify(nearAllowed));
  assert.ok(nearAllowed.apply, "allowNear 且 requireAllMapped 时全 near 可 apply");

  const unmappedExcel = await writeExcel(path.join(dir, "unmapped.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Wireframe"],
    ["TC_01", "Login", "Login", "Unmapped", "0.5.Forgot Password"]
  ]);
  const unmappedApply = await designAssistedImport(runtime, {
    excelPath: unmappedExcel,
    screenIndexPath: index,
    apply: true,
    requireAllMapped: true
  });
  assert.equal(unmappedApply.ok, false);
  assert.equal(unmappedApply.needs, "info");
  assert.equal(unmappedApply.category, "excel-mapping-review");
});

test("design_assisted_import: 逐屏 delta 复用未变屏，设计屏变化只重算该屏", async () => {
  const { dir, runtime } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Wireframe"],
    ["TC_01", "Home", "Home", "Screens", "Screen A\nScreen B"]
  ]);
  const index = path.join(dir, "screen-index.json");
  const writeIndex = (bHints) =>
    fs.writeFileSync(
      index,
      JSON.stringify({
        screens: [
          { id: "a", name: "Screen A", textHints: ["A"] },
          { id: "b", name: "Screen B", textHints: bHints }
        ]
      })
    );
  writeIndex(["B"]);

  const first = await designAssistedImport(runtime, { excelPath: excel, screenIndexPath: index });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.report.delta.reused, 0);
  assert.equal(first.report.delta.remapped, 2);
  assert.equal(first.report.delta.added, 2);

  const second = await designAssistedImport(runtime, { excelPath: excel, screenIndexPath: index });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.report.delta.reused, 2);
  assert.equal(second.report.delta.remapped, 0);

  writeIndex(["B changed"]);
  const third = await designAssistedImport(runtime, { excelPath: excel, screenIndexPath: index });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.report.delta.reused, 1);
  assert.equal(third.report.delta.remapped, 1);
});

test("design_assisted_import: 无 flows 时回退 ui-contract 屏索引", async () => {
  const { dir, runtime } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Wireframe"],
    ["TC_01", "Home", "Home", "Home", "Homepage"]
  ]);
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "ui-contract.json"),
    JSON.stringify({ screens: [{ id: "h1", name: "Homepage" }] })
  );

  const result = await designAssistedImport(runtime, { excelPath: excel });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report.source.designIndexKind, "ui-contract");
  assert.equal(result.report.rows[0].screens[0].design.id, "h1");
});

test("design_assisted_import: llmMapping=auto 仅对 unmapped 候选做封闭映射", async () => {
  const { dir, runtime } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Login", "Forgot", "Forgot", "1.Click forgot", "1.See form", "0.5.Forgot Password"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(
    index,
    JSON.stringify({ screens: [{ id: "h1", name: "Forgot Password", textHints: ["Forgot"] }] })
  );
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return JSON.stringify([
      { screen: "0.5.Forgot Password", screenId: "h1", confidence: 0.95, reason: "candidate" }
    ]);
  };

  const result = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    threshold: 0.9,
    llmMapping: "auto",
    chat
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.report.summary.llmMapped, 1);
  assert.equal(result.report.summary.llmCalls, 1);
  const match = result.report.rows[0].screens[0];
  assert.equal(match.matchedBy, "llm");
  assert.equal(match.status, "near");
  assert.equal(match.design.id, "h1");

  const off = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    threshold: 0.9,
    chat
  });
  assert.equal(off.report.summary.llmMapped, 0, "默认 off");
  assert.equal(off.report.summary.llmCalls, 0);
});

test("design_assisted_import: save:false 不落盘；缺设计索引显式失败", async () => {
  const { dir, runtime } = await project();
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Wireframe"],
    ["TC_01", "Login", "Login", "Login", "0.1_Login/Register"]
  ]);
  const index = path.join(dir, "screen-index.json");
  fs.writeFileSync(
    index,
    JSON.stringify({ screens: [{ id: "s1", name: "0.1_Login/Register" }] })
  );

  const preview = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: index,
    save: false
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.artifacts, null);

  const missing = await designAssistedImport(runtime, {
    excelPath: excel,
    screenIndexPath: path.join(dir, "missing.json")
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /设计屏索引不存在/);
});
