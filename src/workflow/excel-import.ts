import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { caseSetStem, caseSetsDir, saveCaseSetFiles } from "../figma/case-sets.js";
import { REAL_DATA_CLAUSE } from "../figma/data-policy.js";
import { recordAuditSafe } from "../db/audit-event.js";
import { humanStepsHashFromParts, renderTestsWorkbook } from "../figma/test-xlsx.js";
import type { GeneratedTest } from "../figma/test-gen.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { readCaseSheet, type CaseSheet } from "./excel.js";

export interface ImportColumns {
  name?: string;
  steps?: string;
  expected?: string;
  preconditions?: string;
  module?: string;
  displayId?: string;
  testData?: string;
}

export interface ImportedSet {
  feature: string;
  featureKey: string;
  stem: string;
  jsonPath: string;
  mdPath: string;
  xlsxPath: string;
  caseCount: number;
}

export type ImportResult =
  | {
      ok: true;
      status: "imported" | "skipped";
      sourceId: string;
      sets: ImportedSet[];
      sourceCopy: string;
      warnings: string[];
    }
  | { ok: false; error: string };

type Field = keyof ImportColumns;

const FIELDS: Field[] = [
  "name",
  "steps",
  "expected",
  "preconditions",
  "module",
  "displayId",
  "testData"
];

const COLUMN_ALIASES: Record<Field, string[]> = {
  name: ["用例名", "用例名称", "标题", "case", "casename", "name", "title"],
  steps: ["步骤", "操作步骤", "测试步骤", "steps", "step", "操作"],
  expected: ["预期", "预期结果", "期望结果", "期望", "expected", "expectation", "result"],
  preconditions: ["前置", "前置条件", "前置假设", "preconditions", "precondition"],
  module: ["模块", "功能", "功能模块", "所属模块", "module", "feature"],
  displayId: ["用例编号", "展示编号", "displayid", "caseid", "编号"],
  testData: ["测试数据", "testdata", "data"]
};

interface ImportedCase {
  id: string;
  name: string;
  preconditions: string[];
  taskDesc: string;
  screens: string[];
  steps: string[];
  expectations: Array<Record<string, unknown>>;
  feature: string;
  displayId?: string;
  module?: string;
  section?: string;
  testData?: string[];
  openQuestions?: string[];
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function columnIndexes(sheet: CaseSheet, overrides: ImportColumns): Record<Field, number | null> {
  const normalized = sheet.headers.map(normalizeHeader);
  const resolve = (aliases: string[]): number | null => {
    const found = normalized.findIndex((header) => aliases.some((alias) => header === normalizeHeader(alias)));
    return found === -1 ? null : found;
  };
  const indexes = {} as Record<Field, number | null>;
  for (const field of FIELDS) {
    const override = overrides[field];
    indexes[field] =
      override === undefined ? resolve(COLUMN_ALIASES[field]) : resolve([override]);
  }
  return indexes;
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned === "" ? "set" : cleaned;
}

function renderImportedMarkdown(cases: ImportedCase[], meta: { source: string; importedAt: string }): string {
  const lines = [
    "# 导入测试用例集",
    "",
    `> 来源: ${meta.source}`,
    `> 导入时间: ${meta.importedAt}`,
    ""
  ];
  cases.forEach((testCase, index) => {
    lines.push(`## ${index + 1}. ${testCase.name}`, "");
    if (testCase.preconditions.length > 0) {
      lines.push(`- 前置：${testCase.preconditions.join("；")}`);
    }
    lines.push(`- 模块：${testCase.screens[0] ?? ""}`, "");
    for (const step of testCase.steps) lines.push(`- ${step}`);
    lines.push("", "```mobile_run_task", testCase.taskDesc, "```", "");
  });
  return lines.join("\n");
}

function cleanupFiles(files: string[]): void {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function findSourceCopy(dir: string, baseName: string): string {
  try {
    const hit = fs.readdirSync(dir).find((name) => name.endsWith(`_${baseName}.source.xlsx`));
    return hit ? path.join(dir, hit) : "";
  } catch {
    return "";
  }
}

async function existingSets(runtime: Runtime, sourceId: string): Promise<ImportedSet[] | null> {
  try {
    const sets = await runtime.store.listCaseSets(runtime.project.rootDir, 200);
    const record = sets.find((entry) => entry.source === sourceId);
    if (record) {
      return record.features.map((feature) => ({
        feature: feature.name,
        featureKey: feature.key,
        stem: path.basename(feature.jsonPath, ".json"),
        jsonPath: feature.jsonPath,
        mdPath: feature.mdPath,
        xlsxPath: feature.xlsxPath,
        caseCount: feature.caseCount
      }));
    }
  } catch {
    /* 登记不可用：退回文件 meta 扫描 */
  }
  const dir = caseSetsDir(runtime.configDirAbs);
  try {
    const found: ImportedSet[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const jsonPath = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
          meta?: { source?: unknown; feature?: unknown; featureKey?: unknown };
          flows?: unknown;
        };
        if (parsed.meta?.source !== sourceId) continue;
        const stem = name.slice(0, -".json".length);
        found.push({
          feature: typeof parsed.meta.feature === "string" ? parsed.meta.feature : stem,
          featureKey: typeof parsed.meta.featureKey === "string" ? parsed.meta.featureKey : stem,
          stem,
          jsonPath,
          mdPath: path.join(dir, `${stem}.md`),
          xlsxPath: path.join(dir, `${stem}.xlsx`),
          caseCount: Array.isArray(parsed.flows) ? parsed.flows.length : 0
        });
      } catch {
        /* 跳过不可读文件 */
      }
    }
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

/** 把 Excel 测试文档导入用例库：按模块拆集、三件套归档、登记；同内容幂等 skip。 */
export async function importTestDocument(
  runtime: Runtime,
  args: { excelPath: string; columns?: ImportColumns },
  deps: { readSheet?: typeof readCaseSheet } = {}
): Promise<ImportResult> {
  const excelPath = path.resolve(runtime.project.rootDir, args.excelPath);
  let sha8: string;
  try {
    sha8 = createHash("sha256").update(fs.readFileSync(excelPath)).digest("hex").slice(0, 8);
  } catch (error) {
    return { ok: false, error: `无法读取测试文档：${errorMessage(error)}` };
  }
  const baseName = path.basename(excelPath);
  const documentSlug = slug(path.parse(excelPath).name);
  const sourceId = `imported:${baseName}@${sha8}`;
  const dir = caseSetsDir(runtime.configDirAbs);
  const skipped = await existingSets(runtime, sourceId);
  if (skipped) {
    return {
      ok: true,
      status: "skipped",
      sourceId,
      sets: skipped,
      sourceCopy: findSourceCopy(dir, baseName),
      warnings: []
    };
  }

  let sheet: CaseSheet;
  try {
    sheet = await (deps.readSheet ?? readCaseSheet)(excelPath);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  const indexes = columnIndexes(sheet, args.columns ?? {});
  if (indexes.name === null || indexes.steps === null) {
    const missing = [
      indexes.name === null ? "用例名" : null,
      indexes.steps === null ? "步骤" : null
    ].filter((entry): entry is string => entry !== null);
    const headers = sheet.headers.filter((header) => header !== "").join("、");
    return {
      ok: false,
      error: `缺少必需列：${missing.join("、")}；当前表头：${headers === "" ? "（空）" : headers}`
    };
  }

  const pick = (cells: string[], field: Field): string => {
    const index = indexes[field];
    return index === null ? "" : (cells[index] ?? "").trim();
  };
  const drafts: Array<{
    rowNumber: number;
    name: string;
    steps: string;
    expected: string;
    preconditions: string;
    module: string;
    displayId: string;
    testData: string;
  }> = [];
  const rowIssues: string[] = [];
  sheet.rows.forEach((cells, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const name = pick(cells, "name");
    const steps = pick(cells, "steps");
    if (name === "" && steps === "") return;
    if (name === "") {
      rowIssues.push(`第 ${rowNumber} 行缺少用例名`);
      return;
    }
    if (steps === "") {
      rowIssues.push(`第 ${rowNumber} 行缺少步骤`);
      return;
    }
    drafts.push({
      rowNumber,
      name,
      steps,
      expected: pick(cells, "expected"),
      preconditions: pick(cells, "preconditions"),
      module: pick(cells, "module") || path.parse(excelPath).name,
      displayId: pick(cells, "displayId"),
      testData: pick(cells, "testData")
    });
  });
  if (rowIssues.length > 0) {
    return { ok: false, error: rowIssues.slice(0, 3).join("；") };
  }
  if (drafts.length === 0) {
    return { ok: false, error: "测试文档没有有效用例行（表头下的数据为空）" };
  }

  const groups = new Map<
    string,
    Array<{
      rowNumber: number;
      name: string;
      steps: string;
      expected: string;
      preconditions: string;
      displayId: string;
      testData: string;
    }>
  >();
  for (const draft of drafts) {
    const bucket = groups.get(draft.module) ?? [];
    bucket.push(draft);
    groups.set(draft.module, bucket);
  }

  const now = new Date();
  const importedAt = now.toISOString();
  const casesDir = dir;
  fs.mkdirSync(casesDir, { recursive: true });
  const taken = new Set<string>();
  try {
    for (const name of fs.readdirSync(casesDir)) {
      if (name.endsWith(".json")) taken.add(name.slice(0, -".json".length));
    }
  } catch {
    /* 目录不存在：全新 */
  }

  const sets: ImportedSet[] = [];
  const allCases: ImportedCase[] = [];
  const createdFiles: string[] = [];
  const importWarnings: string[] = [];
  try {
    for (const [module, rows] of groups) {
      const moduleSlug = slug(module);
      const featureKey = moduleSlug === documentSlug ? `imp-${documentSlug}` : `imp-${documentSlug}-${moduleSlug}`;
      const cases: ImportedCase[] = rows.map((row) => {
        const steps: string[] = [];
        const expectations: Array<Record<string, unknown>> = [];
        if (row.expected !== "") {
          steps.push(`执行「${row.steps}」，应出现「${row.expected}」`);
          expectations.push({ kind: "assert", text: row.expected });
        } else {
          steps.push(`探索：${row.steps}`);
          expectations.push({ kind: "explore" });
        }
        const preconditions = row.preconditions === "" ? [] : [row.preconditions];
        const testData =
          row.testData === "" || row.testData === "n/a（无显式数据）" || row.testData === "—"
            ? []
            : row.testData
                .split(/\r?\n/)
                .map((entry) => entry.replace(/^-\s*/, "").trim())
                .filter((entry) => entry !== "");
        const executor = sheet.executor ?? new Map();
        const hidden =
          row.displayId === ""
            ? undefined
            : (executor.get(`display:${row.displayId}`) ?? executor.get(`case:${row.displayId}`));
        const reusable =
          hidden !== undefined &&
          hidden.taskDesc.trim() !== "" &&
          hidden.humanStepsHash ===
            humanStepsHashFromParts(row.steps, preconditions, row.expected, row.testData);
        const taskDesc = reusable
          ? hidden.taskDesc
          : [
              REAL_DATA_CLAUSE,
              `用例：${row.name}`,
              preconditions.length > 0 ? `前置：${preconditions.join("；")}` : null,
              `步骤：${row.steps}`,
              row.expected !== "" ? `预期：${row.expected}` : null,
              ...(testData.length > 0 ? ["【测试数据】", ...testData.map((item) => `- ${item}`)] : []),
              ...(hidden?.designRefs ? [`设计引用：${hidden.designRefs}`] : [])
            ]
              .filter((line): line is string => line !== null)
              .join("\n");
        if (hidden !== undefined && !reusable) {
          importWarnings.push(`第 ${row.rowNumber} 行步骤已编辑：执行描述按人类步骤重建，保留原 caseId`);
        }
        const caseId = hidden?.caseId?.trim() || `imp-${sha8}-${row.rowNumber}`;
        return {
          id: caseId,
          name: row.name,
          preconditions,
          taskDesc,
          screens: [module],
          steps,
          expectations,
          feature: featureKey,
          displayId: row.displayId || caseId,
          module,
          section: module,
          testData,
          openQuestions: []
        };
      });
      allCases.push(...cases);
      const stem = caseSetStem(module, now, taken);
      taken.add(stem);
      const saved = await saveCaseSetFiles(casesDir, stem, {
        json:
          JSON.stringify(
            {
              meta: { source: sourceId, importedAt, feature: module, featureKey },
              source: sourceId,
              features: [{ key: featureKey, name: module, screens: [module] }],
              counts: { flows: cases.length, screens: 1, edges: 0 },
              flows: cases
            },
            null,
            2
          ) + "\n",
        markdown: renderImportedMarkdown(cases, { source: sourceId, importedAt }),
        xlsx: await renderTestsWorkbook(
          cases as unknown as GeneratedTest[],
          { source: sourceId, generatedAt: importedAt, counts: { cases: cases.length, screens: 1, edges: 0 } }
        )
      });
      createdFiles.push(saved.jsonPath, saved.mdPath, saved.xlsxPath);
      sets.push({
        feature: module,
        featureKey,
        stem,
        jsonPath: saved.jsonPath,
        mdPath: saved.mdPath,
        xlsxPath: saved.xlsxPath,
        caseCount: cases.length
      });
    }
  } catch (error) {
    cleanupFiles(createdFiles);
    return { ok: false, error: `归档失败（已回滚本地归档）：${errorMessage(error)}` };
  }

  const stamp = importedAt.slice(0, 19).replace(/[-:]/g, "");
  const sourceCopy = path.join(
    casesDir,
    `${stamp}_${baseName.replace(/[/\\:*?"<>|\s]+/g, "-")}.source.xlsx`
  );
  try {
    if (!fs.existsSync(sourceCopy)) {
      fs.copyFileSync(excelPath, sourceCopy);
      createdFiles.push(sourceCopy);
    }
  } catch (error) {
    cleanupFiles(createdFiles);
    return { ok: false, error: `源文件副本写入失败（已回滚本地归档）：${errorMessage(error)}` };
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        sourceId,
        cases: allCases.map((entry) => ({
          id: entry.id,
          name: entry.name,
          steps: entry.steps,
          taskDesc: entry.taskDesc
        }))
      })
    )
    .digest("hex");
  try {
    const inserted = await runtime.store.recordCaseSet({
      rootPath: runtime.project.rootDir,
      source: sourceId,
      designName: null,
      fingerprint,
      basename: path.parse(excelPath).name,
      createdAt: importedAt,
      features: sets.map((set) => ({
        key: set.featureKey,
        name: set.feature,
        caseCount: set.caseCount,
        screens: [set.feature],
        jsonPath: set.jsonPath,
        mdPath: set.mdPath,
        xlsxPath: set.xlsxPath
      }))
    });
    await recordAuditSafe(runtime.store, runtime.project.rootDir, {
      domain: "import",
      action: "excel.imported",
      result: "ok",
      summary: `导入 ${path.parse(excelPath).name}（${sets.length} 功能）`,
      refs: { file: excelPath, caseSetId: inserted.id }
    });
  } catch (error) {
    cleanupFiles(createdFiles);
    await recordAuditSafe(runtime.store, runtime.project.rootDir, {
      domain: "import",
      action: "excel.imported",
      result: "failed",
      summary: `导入失败：${errorMessage(error)}`,
      refs: { file: excelPath }
    });
    return { ok: false, error: `用例集登记失败（已回滚本地归档）：${errorMessage(error)}` };
  }

  return { ok: true, status: "imported", sourceId, sets, sourceCopy, warnings: importWarnings };
}
