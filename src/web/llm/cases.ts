import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore, WebAssetRecord } from "../../db/types.js";
import { REAL_DATA_CLAUSE } from "../../figma/data-policy.js";
import { findExcelMapping } from "../excel-mapping.js";
import {
  parseExcel,
  readExcelHeaders,
  semanticFingerprint,
  suggestExcelMapping
} from "../excel.js";
import type { WebJobSpec } from "../job-spec.js";
import type { LlmWorkerCase } from "./worker.js";

function insideAssets(rootPath: string, storagePath: string): string {
  const assetsRoot = path.resolve(rootPath, ".artemis", "web", "assets");
  const target = path.resolve(rootPath, storagePath);
  const relative = path.relative(assetsRoot, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`资产路径不在项目资产目录内：${storagePath}`);
  }
  return target;
}

function taskDescOf(input: {
  name: string;
  steps: string[];
  expected: string | null;
  preconditions: string[];
  testData: string | null;
}): string {
  return [
    REAL_DATA_CLAUSE,
    `用例：${input.name}`,
    input.preconditions.length > 0 ? `前置：${input.preconditions.join("；")}` : null,
    `步骤：${input.steps.join(" ")}`,
    input.expected === null || input.expected.trim() === ""
      ? null
      : `预期：${input.expected}`,
    ...(input.testData === null || input.testData.trim() === ""
      ? []
      : ["【测试数据】", ...input.testData.split(/\r?\n/).map((line) => `- ${line}`)])
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** 从 job 的 Excel 资产解析 LLM 用例（module/caseId 过滤由 worker 统一做）。 */
export async function loadLlmCases(input: {
  store: ProjectStore;
  rootPath: string;
  job: { spec: Pick<WebJobSpec, "excelAssetId"> };
}): Promise<LlmWorkerCase[]> {
  const excel = await input.store.getWebAsset(input.rootPath, input.job.spec.excelAssetId);
  if (excel === null || excel.kind !== "excel") {
    throw new Error(`Excel 资产不存在或类型错误：${input.job.spec.excelAssetId}`);
  }
  const storagePath = insideAssets(input.rootPath, excel.storagePath);
  const buffer = await readFile(storagePath);
  const format = excel.metadata?.format === "csv" ? ("csv" as const) : undefined;
  const headers = await readExcelHeaders(buffer, format === undefined ? {} : { format });
  const fingerprint = semanticFingerprint(headers.sheetName, headers.headers);
  const saved = await findExcelMapping(input.store, input.rootPath, excel.id, fingerprint);
  const mapping = saved?.columnMap ?? suggestExcelMapping(headers.headers);
  const parsed = await parseExcel(buffer, {
    sheetName: headers.sheetName,
    mapping,
    ...(format === undefined ? {} : { format })
  });
  return parsed.cases.map((entry) => ({
    caseId: entry.caseId,
    ...(entry.name.trim() === "" ? {} : { name: entry.name }),
    module: entry.module,
    expected: entry.expected,
    taskDesc: taskDescOf({
      name: entry.name,
      steps: entry.steps,
      expected: entry.expected,
      preconditions: entry.preconditions,
      testData: entry.testData
    })
  }));
}

export async function packageFilename(
  store: ProjectStore,
  rootPath: string,
  assetId: string
): Promise<WebAssetRecord | null> {
  const asset = await store.getWebAsset(rootPath, assetId);
  return asset !== null && asset.kind === "package" ? asset : null;
}
