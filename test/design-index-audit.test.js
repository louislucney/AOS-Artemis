import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { auditDesignIndex } from "../dist/workflow/design-index-audit.js";
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

test("design_index_audit: nodes 类型过滤/重复 id/重名屏/落盘报告", async () => {
  const { dir, runtime } = await project();
  const index = writeJson(path.join(dir, "index.json"), {
    nodes: [
      { id: "1:1", name: "Homepage", type: "FRAME", textHints: ["Home"] },
      { id: "1:1", name: "Homepage", type: "FRAME", elements: [{ label: "Search" }] },
      { id: "", name: "Broken Screen", type: "FRAME" },
      { id: "1:3", name: "Al", type: "FRAME" },
      { id: "1:4", name: "Not A Frame", type: "TEXT" }
    ]
  });
  const outPath = path.join(dir, "audit.json");

  const result = await auditDesignIndex(runtime, { screenIndexPath: index, outPath });
  assert.equal(result.ok, true, JSON.stringify(result));
  const report = result.report;
  assert.equal(report.source.kind, "screen-index");
  assert.equal(report.source.screens, 2);
  assert.equal(report.integrity.entries, 5);
  assert.equal(report.integrity.filteredEntries, 3);
  assert.equal(report.integrity.emptyIds, 1);
  assert.equal(report.integrity.shortNames, 1);
  assert.equal(report.integrity.wrongTypes, 1);
  assert.deepEqual(report.integrity.duplicateIds, { count: 1, samples: ["1:1"] });
  assert.deepEqual(report.integrity.duplicateNames, { count: 1, samples: ["Homepage"] });
  assert.equal(report.integrity.textHintScreens, 1);
  assert.equal(report.integrity.elementScreens, 1);
  assert.deepEqual(result.artifacts, { jsonPath: outPath });
  assert.equal(JSON.parse(fs.readFileSync(outPath, "utf8")).source.screens, 2);
});

test("design_index_audit: 显式索引与 flows 交叉比对 id/名称重叠", async () => {
  const { dir, runtime } = await project();
  const index = writeJson(path.join(dir, "index.json"), {
    screens: [
      { id: "a", name: "Screen A" },
      { id: "b", name: "Screen B" },
      { id: "c", name: "Screen C" }
    ]
  });
  const designDir = path.join(runtime.configDirAbs, "design");
  writeJson(path.join(designDir, "flows.json"), {
    screens: [
      { id: "a", name: "Screen A" },
      { id: "b", name: "Screen B" },
      { id: "d", name: "Screen D" }
    ]
  });

  const result = await auditDesignIndex(runtime, { screenIndexPath: index, save: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  const cross = result.report.crossSource;
  assert.ok(cross);
  assert.equal(cross.kind, "flows");
  assert.equal(cross.idOverlap, 2);
  assert.equal(cross.nameOverlap, 2);
  assert.deepEqual(cross.onlyInIndex, { count: 1, samples: ["Screen C"] });
  assert.deepEqual(cross.onlyInReference, { count: 1, samples: ["Screen D"] });
});

test("design_index_audit: Excel Wireframe 覆盖率 exact/near/unmapped + 未引用屏", async () => {
  const { dir, runtime } = await project();
  const index = writeJson(path.join(dir, "index.json"), {
    screens: [
      { id: "h1", name: "Homepage" },
      { id: "s1", name: "Settings" },
      { id: "p1", name: "Profile" }
    ]
  });
  const excel = await writeExcel(path.join(dir, "cases.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe"],
    ["TC_01", "Home", "Home", "Homepage", "1.Open", "1.See", "Homepage"],
    ["TC_02", "Settings", "Settings", "Near", "1.Open", "1.See", "Settings Page"],
    ["TC_03", "Settings", "Settings", "Unknown", "1.Open", "1.See", "0.5.Unknown"],
    ["TC_04", "Settings", "Settings", "No wireframe", "1.Open", "1.See", ""]
  ]);

  const result = await auditDesignIndex(runtime, {
    screenIndexPath: index,
    excelPath: excel,
    save: false
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const coverage = result.report.excel;
  assert.ok(coverage);
  assert.equal(coverage.rows, 4);
  assert.equal(coverage.withWireframe, 3);
  assert.equal(coverage.withoutWireframe, 1);
  assert.equal(coverage.uniqueScreens, 3);
  assert.equal(coverage.exact, 1);
  assert.equal(coverage.near, 1);
  assert.equal(coverage.ambiguous, 0);
  assert.equal(coverage.unmapped, 1);
  assert.deepEqual(coverage.needsReview, []);
  assert.equal(coverage.screensNotReferenced, 2);
  assert.equal(coverage.unmatched[0].screen, "0.5.Unknown");
  assert.ok(result.report.warnings.some((warning) => warning.includes("1 个屏未映射")));
});

test("design_index_audit: 缺索引显式失败", async () => {
  const { dir, runtime } = await project();
  const result = await auditDesignIndex(runtime, {
    screenIndexPath: path.join(dir, "missing.json"),
    save: false
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /设计屏索引不存在/);
});
