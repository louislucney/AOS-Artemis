import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExcelMappingRecord, ProjectStore, WebAssetRecord } from "../db/types.js";
import {
  CANONICAL_FIELD_LABELS,
  CANONICAL_FIELDS,
  ExcelMappingError,
  normalizeExcelHeader,
  readExcelHeaders,
  REQUIRED_CANONICAL_FIELDS,
  semanticFingerprint,
  suggestExcelMapping,
  type CanonicalField,
  type ExcelColumnMap,
  type ParsedExcelRejection
} from "./excel.js";

export type ExcelMappingServiceErrorCode =
  | "asset-not-found"
  | "asset-not-excel"
  | "asset-path-invalid"
  | "asset-file-missing"
  | "missing-asset-id"
  | "invalid-column-map"
  | "invalid-sheet";

const ERROR_STATUS: Record<ExcelMappingServiceErrorCode, number> = {
  "asset-not-found": 404,
  "asset-not-excel": 400,
  "asset-path-invalid": 400,
  "asset-file-missing": 404,
  "missing-asset-id": 400,
  "invalid-column-map": 400,
  "invalid-sheet": 400
};

export class ExcelMappingServiceError extends Error {
  readonly code: ExcelMappingServiceErrorCode;
  readonly status: number;

  constructor(code: ExcelMappingServiceErrorCode, message: string) {
    super(message);
    this.name = "ExcelMappingServiceError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/**
 * 映射语义指纹：工作表名 + 已确认映射的规范字段集合（排序）。
 * 与 `semanticFingerprint` 同源；列顺序/表头写法不参与，字段集合变化才换指纹。
 */
export function mappingFingerprint(sheetName: string, columnMap: ExcelColumnMap): string {
  const fields = CANONICAL_FIELDS.filter((field) => {
    const header = columnMap[field];
    return typeof header === "string" && header.trim() !== "";
  }).sort();
  return createHash("sha256")
    .update(JSON.stringify({ sheet: sheetName.trim(), fields }))
    .digest("hex");
}

export interface ExcelPreview {
  sheetName: string;
  headers: string[];
  suggested: ExcelColumnMap;
  fingerprint: string;
  rejectedPreview: ParsedExcelRejection[];
}

export interface PreviewExcelInput {
  store: ProjectStore;
  rootPath: string;
  assetId: string;
  sheetName?: string;
  headerRow?: number;
}

export interface SaveExcelMappingInput {
  store: ProjectStore;
  rootPath: string;
  assetId: string;
  sheetName: string;
  headerRow?: number;
  columnMap: unknown;
  createdBy?: string | null;
}

interface LoadedAsset {
  asset: WebAssetRecord;
  buffer: Buffer;
}

/**
 * 资产必须属于该项目、kind=excel，且 storagePath 位于项目 `.artemis` 内。
 * 越界路径直接拒绝（不读盘），缺失文件按 404 报告。
 */
async function loadExcelAsset(
  store: ProjectStore,
  rootPath: string,
  assetId: string
): Promise<LoadedAsset> {
  const asset = await store.getWebAsset(rootPath, assetId);
  if (!asset) {
    throw new ExcelMappingServiceError("asset-not-found", `未知资产 "${assetId}"`);
  }
  if (asset.kind !== "excel") {
    throw new ExcelMappingServiceError(
      "asset-not-excel",
      `资产 "${assetId}" 不是 Excel（kind=${asset.kind}）`
    );
  }
  const artemisRoot = path.resolve(rootPath, ".artemis");
  const storagePath = path.resolve(asset.storagePath);
  if (storagePath !== artemisRoot && !storagePath.startsWith(`${artemisRoot}${path.sep}`)) {
    throw new ExcelMappingServiceError(
      "asset-path-invalid",
      `资产存储路径不在项目 .artemis 目录内（拒绝读取）：${asset.storagePath}`
    );
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(storagePath);
  } catch {
    throw new ExcelMappingServiceError(
      "asset-file-missing",
      `资产文件缺失或不可读：${asset.filename}`
    );
  }
  return { asset, buffer };
}

export async function previewExcelAsset(input: PreviewExcelInput): Promise<ExcelPreview> {
  const { buffer } = await loadExcelAsset(input.store, input.rootPath, input.assetId);
  const { sheetName, headers } = await readExcelHeaders(buffer, {
    ...(input.sheetName === undefined ? {} : { sheetName: input.sheetName }),
    ...(input.headerRow === undefined ? {} : { headerRow: input.headerRow })
  });
  return {
    sheetName,
    headers,
    suggested: suggestExcelMapping(headers),
    fingerprint: semanticFingerprint(sheetName, headers),
    rejectedPreview: []
  };
}

/** 按表头文本（归一化后）校对用户映射，返回以工作表真实表头为准的映射。 */
export function validateExcelColumnMap(headers: string[], raw: unknown): ExcelColumnMap {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExcelMappingServiceError(
      "invalid-column-map",
      "columnMap 必须是「规范字段 → 表头文本」的对象"
    );
  }
  const normalizedHeaders = headers.map(normalizeExcelHeader);
  const used = new Map<number, CanonicalField>();
  const columnMap: ExcelColumnMap = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!(CANONICAL_FIELDS as readonly string[]).includes(field)) {
      throw new ExcelMappingServiceError(
        "invalid-column-map",
        `未知的规范字段："${field}"（可选：${CANONICAL_FIELDS.join("、")}）`
      );
    }
    if (typeof value !== "string") {
      throw new ExcelMappingServiceError(
        "invalid-column-map",
        `字段 "${field}" 的列名必须是字符串`
      );
    }
    const header = value.trim();
    if (header === "") continue;
    const index = normalizedHeaders.indexOf(normalizeExcelHeader(header));
    if (index === -1) {
      throw new ExcelMappingError(
        "column-not-found",
        `映射的列不存在："${header}"（${CANONICAL_FIELD_LABELS[field as CanonicalField]}）`
      );
    }
    const owner = used.get(index);
    if (owner !== undefined) {
      throw new ExcelMappingError(
        "duplicate-column",
        `同一列 "${headers[index]}" 被映射给 "${CANONICAL_FIELD_LABELS[owner]}" 和 "${CANONICAL_FIELD_LABELS[field as CanonicalField]}"`
      );
    }
    used.set(index, field as CanonicalField);
    columnMap[field as CanonicalField] = headers[index]!;
  }
  const missing = REQUIRED_CANONICAL_FIELDS.filter((field) => columnMap[field] === undefined);
  if (missing.length > 0) {
    throw new ExcelMappingError(
      "missing-required",
      `缺少必需列：${missing.map((field) => CANONICAL_FIELD_LABELS[field]).join("、")}`
    );
  }
  return columnMap;
}

export async function saveExcelMapping(input: SaveExcelMappingInput): Promise<ExcelMappingRecord> {
  const sheetName = typeof input.sheetName === "string" ? input.sheetName.trim() : "";
  if (sheetName === "") {
    throw new ExcelMappingServiceError("invalid-sheet", "缺少 sheetName（工作表名）");
  }
  const { buffer } = await loadExcelAsset(input.store, input.rootPath, input.assetId);
  const loaded = await readExcelHeaders(buffer, {
    sheetName,
    ...(input.headerRow === undefined ? {} : { headerRow: input.headerRow })
  });
  const columnMap = validateExcelColumnMap(loaded.headers, input.columnMap);
  return input.store.saveExcelMapping({
    rootPath: input.rootPath,
    assetId: input.assetId,
    sheetName: loaded.sheetName,
    headerFingerprint: mappingFingerprint(loaded.sheetName, columnMap),
    columnMap,
    createdBy: input.createdBy ?? null
  });
}

export async function findExcelMapping(
  store: ProjectStore,
  rootPath: string,
  assetId: string,
  headerFingerprint: string
): Promise<ExcelMappingRecord | null> {
  return store.findExcelMapping(rootPath, assetId, headerFingerprint);
}

export async function listExcelMappings(
  store: ProjectStore,
  rootPath: string,
  assetId?: string
): Promise<ExcelMappingRecord[]> {
  return store.listExcelMappings(rootPath, assetId);
}
