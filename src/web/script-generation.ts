import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore, WebAssetRecord } from "../db/types.js";
import { errorMessage } from "../util.js";
import { findExcelMapping } from "./excel-mapping.js";
import {
  parseExcel,
  readExcelHeaders,
  semanticFingerprint,
  suggestExcelMapping
} from "./excel.js";
import {
  buildScriptSetBundle,
  storeScriptSet,
  ScriptSetStoreError,
  type ScriptSetBundle,
  type ScriptSetManifest
} from "./script-set.js";
import { isValidAppId, type PreconditionMode, type ScriptPlatform } from "./script-gen.js";

export type ScriptGenerationErrorCode =
  | "project-not-found"
  | "project-archived"
  | "platform-not-supported"
  | "asset-not-found"
  | "asset-kind-mismatch"
  | "asset-path-invalid"
  | "excel-unreadable"
  | "no-cases"
  | "app-id-missing"
  | "app-id-invalid";

export class ScriptGenerationError extends Error {
  readonly code: ScriptGenerationErrorCode;

  constructor(code: ScriptGenerationErrorCode, message: string) {
    super(message);
    this.name = "ScriptGenerationError";
    this.code = code;
  }
}

export interface GenerateScriptSetInput {
  store: ProjectStore;
  rootPath: string;
  excelAssetId: string;
  packageAssetId: string;
  platform: ScriptPlatform;
  /** 缺省用 Web 项目的 appPackage。 */
  appId?: string | null;
  preconditionMode?: PreconditionMode;
  inferNavigationTap?: boolean;
  includeSoftText?: boolean;
  dryRun?: boolean;
  uploadedBy?: string | null;
}

export interface GenerateScriptSetResult {
  dryRun: boolean;
  appId: string;
  platform: ScriptPlatform;
  manifest: ScriptSetManifest;
  ready: number;
  unresolved: number;
  asset: WebAssetRecord | null;
  created: boolean;
  bundle: ScriptSetBundle;
}

function assertInsideAssets(rootPath: string, storagePath: string): void {
  const assetsRoot = path.resolve(rootPath, ".artemis", "web", "assets");
  const target = path.resolve(storagePath);
  const relative = path.relative(assetsRoot, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ScriptGenerationError(
      "asset-path-invalid",
      `资产路径不在项目资产目录内：${storagePath}`
    );
  }
}

async function loadAsset(
  store: ProjectStore,
  rootPath: string,
  assetId: string,
  kind: "excel" | "package"
): Promise<WebAssetRecord> {
  const asset = await store.getWebAsset(rootPath, assetId);
  if (asset === null) {
    throw new ScriptGenerationError("asset-not-found", `未知 ${kind} 资产：${assetId}`);
  }
  if (asset.kind !== kind) {
    throw new ScriptGenerationError(
      "asset-kind-mismatch",
      `资产 ${assetId} 的类型是 ${asset.kind}，需要 ${kind}`
    );
  }
  return asset;
}

export async function generateScriptSetForProject(
  input: GenerateScriptSetInput
): Promise<GenerateScriptSetResult> {
  const webProject = await input.store.getWebProject(input.rootPath);
  if (webProject === null) {
    throw new ScriptGenerationError(
      "project-not-found",
      `不是托管 Web 项目：${input.rootPath}`
    );
  }
  if (webProject.status !== "active") {
    throw new ScriptGenerationError(
      "project-archived",
      `项目已归档（status=${webProject.status}）：${webProject.name}`
    );
  }
  if (!webProject.platforms.includes(input.platform)) {
    throw new ScriptGenerationError(
      "platform-not-supported",
      `项目未声明平台 ${input.platform}（已声明：${webProject.platforms.join("、")}）`
    );
  }

  const excel = await loadAsset(input.store, input.rootPath, input.excelAssetId, "excel");
  const pkg = await loadAsset(input.store, input.rootPath, input.packageAssetId, "package");
  assertInsideAssets(input.rootPath, excel.storagePath);

  let buffer: Buffer;
  try {
    buffer = await readFile(excel.storagePath);
  } catch (error) {
    throw new ScriptGenerationError(
      "excel-unreadable",
      `无法读取 Excel 资产 ${excel.id}：${errorMessage(error)}`
    );
  }

  const format = excel.metadata.format === "csv" ? ("csv" as const) : undefined;
  try {
    const headers = await readExcelHeaders(buffer, format === undefined ? {} : { format });
    const fingerprint = semanticFingerprint(headers.sheetName, headers.headers);
    const saved = await findExcelMapping(input.store, input.rootPath, excel.id, fingerprint);
    const mapping = saved?.columnMap ?? suggestExcelMapping(headers.headers);
    const parsed = await parseExcel(buffer, {
      sheetName: headers.sheetName,
      mapping,
      ...(format === undefined ? {} : { format })
    });
    if (parsed.cases.length === 0) {
      throw new ScriptGenerationError(
        "no-cases",
        `Excel 没有可用用例（拒绝 ${parsed.rejected.length} 行）`
      );
    }

    const appId = (input.appId ?? "").trim() || (webProject.appPackage ?? "").trim();
    if (appId === "") {
      throw new ScriptGenerationError(
        "app-id-missing",
        "缺少 appId：请传 --app-id 或在项目里填写应用包名"
      );
    }
    if (!isValidAppId(appId, input.platform)) {
      throw new ScriptGenerationError(
        "app-id-invalid",
        `appId 不符合 ${input.platform} 格式：${appId}`
      );
    }

    const bundle = buildScriptSetBundle({
      appId,
      platform: input.platform,
      sourceExcelAssetId: excel.id,
      packageAssetId: pkg.id,
      cases: parsed.cases.map((entry) => ({
        caseId: entry.caseId,
        steps: entry.steps,
        expected: entry.expected,
        preconditions: entry.preconditions
      })),
      ...(input.preconditionMode === undefined
        ? {}
        : { preconditionMode: input.preconditionMode }),
      ...(input.inferNavigationTap === undefined
        ? {}
        : { inferNavigationTap: input.inferNavigationTap }),
      ...(input.includeSoftText === undefined
        ? {}
        : { includeSoftText: input.includeSoftText })
    });

    if (input.dryRun === true) {
      return {
        dryRun: true,
        appId,
        platform: input.platform,
        manifest: bundle.manifest,
        ready: bundle.ready,
        unresolved: bundle.unresolved,
        asset: null,
        created: false,
        bundle
      };
    }

    const stored = await storeScriptSet({
      store: input.store,
      rootPath: input.rootPath,
      bundle,
      uploadedBy: input.uploadedBy ?? null
    });
    return {
      dryRun: false,
      appId,
      platform: input.platform,
      manifest: bundle.manifest,
      ready: bundle.ready,
      unresolved: bundle.unresolved,
      asset: stored.asset,
      created: stored.created,
      bundle
    };
  } catch (error) {
    if (error instanceof ScriptGenerationError || error instanceof ScriptSetStoreError) {
      throw error;
    }
    throw new ScriptGenerationError(
      "excel-unreadable",
      `解析 Excel 失败：${errorMessage(error)}`
    );
  }
}
