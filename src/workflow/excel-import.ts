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
import { storeWebAsset } from "../web/assets.js";
import { LEGACY_COLUMN_ALIASES } from "../web/excel-columns.js";
import { detectDesignContext, type DesignContextSummary } from "./design-context.js";
import { readCaseSheet, type CaseSheet } from "./excel.js";

export interface ImportColumns {
  name?: string;
  steps?: string;
  expected?: string;
  preconditions?: string;
  module?: string;
  section?: string;
  displayId?: string;
  testData?: string;
  wireframe?: string;
  relatedTc?: string;
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

/** Excel 导入时的设计上下文检查结果；用于在导入响应/控制台提示“有设计图但未关联”。 */
export interface DesignImportContext {
  available: boolean;
  sources: string[];
  excelImages: number;
  designRefs: number;
  /** 实际识别/覆盖到的模板列（null = 未映射）。 */
  columns: {
    section: string | null;
    wireframe: string | null;
    relatedTc: string | null;
  };
  warnings: string[];
  nextAction: string | null;
}

export interface DesignRowMapping {
  screens: string[];
  /** 与 screens 对齐；空字符串表示该屏只做名称映射、没有 node id。 */
  nodeIds: string[];
}

export type ImportResult =
  | {
      ok: true;
      status: "imported" | "skipped";
      sourceId: string;
      sets: ImportedSet[];
      sourceCopy: string;
      warnings: string[];
      design?: DesignImportContext;
    }
  | { ok: false; error: string };

type Field = keyof ImportColumns;

const FIELDS: Field[] = [
  "name",
  "steps",
  "expected",
  "preconditions",
  "module",
  "section",
  "displayId",
  "testData",
  "wireframe",
  "relatedTc"
];

const COLUMN_ALIASES_BY_FIELD: Record<Field, readonly string[]> = {
  name: LEGACY_COLUMN_ALIASES.name,
  steps: LEGACY_COLUMN_ALIASES.steps,
  expected: LEGACY_COLUMN_ALIASES.expected,
  preconditions: LEGACY_COLUMN_ALIASES.preconditions,
  module: LEGACY_COLUMN_ALIASES.module,
  section: ["section", "sections", "子功能", "二级模块", "分区"],
  displayId: LEGACY_COLUMN_ALIASES.caseId,
  testData: LEGACY_COLUMN_ALIASES.testData,
  wireframe: [
    "wireframe",
    "wireframes",
    "designrefs",
    "designscreens",
    "设计引用",
    "设计屏",
    "线框图",
    "设计稿"
  ],
  relatedTc: ["relatedtc", "related", "relatedcases", "关联用例", "关联"]
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
  /** Excel 可见 `Wireframe`/设计引用列解析出的设计屏名。 */
  designRefs?: { screens: string[]; nodeIds?: string[] };
  /** Excel `Related TC` 列解析出的关联用例编号。 */
  relatedCases?: string[];
  openQuestions?: string[];
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function columnIndexes(sheet: CaseSheet, overrides: ImportColumns): Record<Field, number | null> {
  const normalized = sheet.headers.map(normalizeHeader);
  const resolve = (aliases: readonly string[]): number | null => {
    const found = normalized.findIndex((header) => aliases.some((alias) => header === normalizeHeader(alias)));
    return found === -1 ? null : found;
  };
  const indexes = {} as Record<Field, number | null>;
  for (const field of FIELDS) {
    const override = overrides[field];
    indexes[field] =
      override === undefined ? resolve(COLUMN_ALIASES_BY_FIELD[field]) : resolve([override]);
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

function visibleTaskDesc(taskDesc: string): string {
  return taskDesc
    .split("\n")
    .filter((line) => line.trim() !== REAL_DATA_CLAUSE)
    .join("\n")
    .trim();
}

function looksLikeNonScreenValue(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^[A-Za-z]:\\/.test(value) ||
    /^(?:\.{0,2}\/|\/)/.test(value) ||
    /\.(?:png|jpe?g|webp|gif|pen|fig|pdf)$/i.test(value)
  );
}

/** Excel `Wireframe` 列：换行分隔的设计屏名；少数单元格有 `)0.` 粘连。
 * URL/文件路径/图片名不是屏名：显式丢弃并记 warning，不写进 designRefs。 */
export function parseDesignScreens(value: string, warnings: string[]): string[] {
  const normalized = value.replace(/\r/g, "").replace(/\)0\./g, ")\n0.");
  const screens: string[] = [];
  for (const entry of normalized.split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
    if (looksLikeNonScreenValue(entry)) {
      warnings.push(`Wireframe 值看起来是 URL/文件路径而不是设计屏名，已忽略：${entry}`);
      continue;
    }
    if (!screens.includes(entry)) screens.push(entry);
  }
  return screens;
}

function parseRelatedCases(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;\n\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ];
}

function normalizeFeatureName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderImportedMarkdown(cases: ImportedCase[], meta: { source: string; importedAt: string }): string {
  const lines = [
    "# 导入测试用例集",
    "",
    `> 来源: ${meta.source}`,
    `> 导入时间: ${meta.importedAt}`,
    "> 执行约束：所有用例的 taskDesc 已自动附带【真实数据】条款（数据须经被测应用真实请求链路准备，禁止伪造/写死页面或数据）；此处为人类可读视图，执行请用 tests.json 的 taskDesc。",
    ""
  ];
  cases.forEach((testCase, index) => {
    lines.push(`## ${index + 1}. ${testCase.name}`, "");
    if (testCase.preconditions.length > 0) {
      lines.push(`- 前置：${testCase.preconditions.join("；")}`);
    }
    lines.push(`- 模块：${testCase.screens[0] ?? ""}`, "");
    for (const step of testCase.steps) lines.push(`- ${step}`);
    lines.push("", "```mobile_run_task", visibleTaskDesc(testCase.taskDesc), "```", "");
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
    const hit = fs
      .readdirSync(dir)
      .find(
        (name) =>
          name.endsWith(`_${baseName}.source.xlsx`) || name.endsWith(`_${baseName}.source.csv`)
      );
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
function summarizeDesignContext(
  context: DesignContextSummary,
  excelImages: number,
  designRefs: number,
  columns: DesignImportContext["columns"]
): DesignImportContext {
  const sources = context.sources.length > 0 ? context.sources.join("、") : "无";
  const hasContract =
    context.flows || context.uiContract || context.penScreens > 0 || context.screenshots > 0;
  const warnings: string[] = [];
  if (excelImages > 0) {
    warnings.push(
      `Excel 含 ${excelImages} 张图片；导入不会自动把内嵌图片作为设计基线。若这些是设计图，请提供 Figma/.pen 设计源，或把图片放到 .artemis/design/screens/。`
    );
  }
  if (context.referenceAssets > 0) {
    warnings.push(
      `检测到 ${context.referenceAssets} 个参考图资产；参考图只是视觉参考，不会自动变成可校验的 UI 契约（需 .pen/Figma flows 生成 ui-contract）。`
    );
  }
  if (hasContract && designRefs === 0) {
    warnings.push(
      `检测到设计基线（${sources}），但 Excel 未提供「设计引用」列；导入用例只能按「模块」名与设计屏名做 UI 对比，无法逐行关联设计屏。`
    );
  }
  if (columns.wireframe !== null && designRefs === 0) {
    warnings.push(
      "已识别 Wireframe/设计引用列，但没有解析出有效设计屏名；请检查该列内容，或用 columns 显式指定正确表头。"
    );
  }
  if (columns.section !== null && columns.wireframe === null) {
    warnings.push(
      "已识别 Section 列但未识别 Wireframe/设计引用列；Section 只用于拆集，不会自动关联设计屏。"
    );
  }
  return {
    available: context.available,
    sources: context.sources,
    excelImages,
    designRefs,
    columns,
    warnings,
    nextAction: hasContract
      ? "node dist/cli.js suite run --ui-diff --fail-on-ui"
      : context.available || excelImages > 0
        ? "提供 Figma/.pen 设计源后运行 design_to_test 或 suite ui-contract"
        : null
  };
}

export async function importTestDocument(
  runtime: Runtime,
  args: {
    excelPath: string;
    columns?: ImportColumns;
    sourceName?: string;
    /** 设计辅助 enrich：加入 source id，避免覆盖普通导入集。 */
    sourceIdSuffix?: string;
    /** 按 Excel 物理行号注入设计屏/node id（行号从 1 开始，表头为 1）。 */
    designRefsByRow?: Map<number, DesignRowMapping>;
  },
  deps: { readSheet?: typeof readCaseSheet } = {}
): Promise<ImportResult> {
  const excelPath = path.resolve(runtime.project.rootDir, args.excelPath);
  const referenceAssets = await runtime.store
    .listWebAssets(runtime.project.rootDir, "reference")
    .catch(() => []);
  const designContext = detectDesignContext(runtime, {
    referenceAssets: referenceAssets.length
  });
  let sha8: string;
  try {
    sha8 = createHash("sha256").update(fs.readFileSync(excelPath)).digest("hex").slice(0, 8);
  } catch (error) {
    return { ok: false, error: `无法读取测试文档：${errorMessage(error)}` };
  }
  const baseName = (args.sourceName ?? "").trim() || path.basename(excelPath);
  const documentSlug = slug(path.parse(baseName).name);
  const sourceId = `imported:${baseName}@${sha8}${args.sourceIdSuffix ?? ""}`;
  const dir = caseSetsDir(runtime.configDirAbs);
  const skipped = await existingSets(runtime, sourceId);
  if (skipped) {
    return {
      ok: true,
      status: "skipped",
      sourceId,
      sets: skipped,
      sourceCopy: findSourceCopy(dir, baseName),
      warnings: [],
      design: summarizeDesignContext(designContext, 0, 0, {
        section: null,
        wireframe: null,
        relatedTc: null
      })
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

  const mappedColumn = (field: Field): string | null =>
    indexes[field] === null ? null : (sheet.headers[indexes[field]!] ?? null);
  const designColumns = {
    section: mappedColumn("section"),
    wireframe: mappedColumn("wireframe"),
    relatedTc: mappedColumn("relatedTc")
  };
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
    section: string;
    displayId: string;
    testData: string;
    designScreens: string[];
    relatedTc: string;
  }> = [];
  const rowIssues: string[] = [];
  const wireframeWarnings: string[] = [];
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
      module: pick(cells, "module") || path.parse(baseName).name,
      section: pick(cells, "section"),
      displayId: pick(cells, "displayId"),
      testData: pick(cells, "testData"),
      designScreens: parseDesignScreens(pick(cells, "wireframe"), wireframeWarnings),
      relatedTc: pick(cells, "relatedTc")
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
    {
      featureName: string;
      module: string;
      rows: Array<(typeof drafts)[number]>;
    }
  >();
  for (const draft of drafts) {
    const featureName = normalizeFeatureName(draft.section || draft.module);
    const key = `${draft.module}\u0000${featureName}`;
    const group = groups.get(key) ?? { featureName, module: draft.module, rows: [] };
    group.rows.push(draft);
    groups.set(key, group);
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
  importWarnings.push(...wireframeWarnings);
  let designRefsCount = 0;
  try {
    for (const { featureName, rows } of groups.values()) {
      const featureSlug = slug(featureName);
      const featureKey =
        featureSlug === documentSlug
          ? `imp-${documentSlug}`
          : `imp-${documentSlug}-${featureSlug}`;
      const cases: ImportedCase[] = rows.map((row) => {
        const mapped = args.designRefsByRow?.get(row.rowNumber);
        const designScreens = mapped?.screens ?? row.designScreens;
        const designNodeIds = mapped?.nodeIds ?? [];
        const rawRelatedCases = parseRelatedCases(row.relatedTc);
        const jiraLikeRelated = rawRelatedCases.filter((entry) =>
          /^[A-Z][A-Z0-9]+-\d+$/.test(entry)
        );
        const relatedCases = rawRelatedCases.filter((entry) => !jiraLikeRelated.includes(entry));
        if (jiraLikeRelated.length > 0) {
          importWarnings.push(
            `第 ${row.rowNumber} 行 Related TC 值像 Jira 单号（${jiraLikeRelated.join("、")}），未写入 relatedCases；请确认该列语义或改用 columns 映射。`
          );
        }
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
        const explicitDesignRefs = hidden?.designRefs?.trim() ?? "";
        const designRefLine =
          explicitDesignRefs ||
          designScreens
            .map((screen, index) => {
              const nodeId = designNodeIds[index] ?? "";
              return nodeId === "" ? screen : `${screen}(${nodeId})`;
            })
            .join("、");
        if (designRefLine !== "") designRefsCount += 1;
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
              ...(designRefLine !== "" ? [`设计引用：${designRefLine}`] : [])
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
          screens: designScreens.length > 0 ? designScreens : [featureName],
          ...(designScreens.length > 0
            ? { designRefs: { screens: designScreens, nodeIds: designNodeIds } }
            : {}),
          steps,
          expectations,
          feature: featureKey,
          displayId: row.displayId || caseId,
          module: row.module,
          section: featureName,
          testData,
          ...(relatedCases.length > 0 ? { relatedCases } : {}),
          openQuestions: []
        };
      });
      allCases.push(...cases);
      const screens = [...new Set(cases.flatMap((entry) => entry.screens))];
      const stem = caseSetStem(featureName, now, taken);
      taken.add(stem);
      const saved = await saveCaseSetFiles(casesDir, stem, {
        json:
          JSON.stringify(
            {
              meta: { source: sourceId, importedAt, feature: featureName, featureKey },
              source: sourceId,
              features: [{ key: featureKey, name: featureName, screens }],
              counts: { flows: cases.length, screens: screens.length, edges: 0 },
              flows: cases
            },
            null,
            2
          ) + "\n",
        markdown: renderImportedMarkdown(cases, { source: sourceId, importedAt }),
        xlsx: await renderTestsWorkbook(
          cases as unknown as GeneratedTest[],
          { source: sourceId, generatedAt: importedAt, counts: { cases: cases.length, screens: screens.length, edges: 0 } }
        )
      });
      createdFiles.push(saved.jsonPath, saved.mdPath, saved.xlsxPath);
      sets.push({
        feature: featureName,
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
  const sourceExtension = path.extname(excelPath).toLowerCase() === ".csv" ? ".csv" : ".xlsx";
  const sourceCopy = path.join(
    casesDir,
    `${stamp}_${baseName.replace(/[/\\:*?"<>|\s]+/g, "-")}.source${sourceExtension}`
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
      basename: path.parse(baseName).name,
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
      summary: `导入 ${path.parse(baseName).name}（${sets.length} 功能）`,
      refs: { file: excelPath, caseSetId: inserted.id }
    });
    try {
      const buffer = fs.readFileSync(sourceCopy);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const existing = await runtime.store
        .listWebAssets(runtime.project.rootDir, "excel")
        .catch(() => []);
      if (!existing.some((asset) => asset.sha256 === sha256)) {
        await storeWebAsset({
          store: runtime.store,
          rootPath: runtime.project.rootDir,
          kind: "excel",
          filename: path.basename(excelPath),
          buffer,
          uploadedBy: "import",
          metadata: {
            source: "case-set-import",
            sourceId,
            sourceCopy,
            caseSetId: inserted.id
          }
        });
      }
    } catch (error) {
      importWarnings.push(`用例已导入，但登记为 Web 测试资产失败：${errorMessage(error)}`);
    }
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

  const design = summarizeDesignContext(
    designContext,
    sheet.imageCount ?? 0,
    designRefsCount,
    designColumns
  );
  return {
    ok: true,
    status: "imported",
    sourceId,
    sets,
    sourceCopy,
    warnings: [...importWarnings, ...design.warnings],
    design
  };
}
