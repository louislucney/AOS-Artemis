import { createHash } from "node:crypto";

import type { ProjectStore, WebAssetRecord } from "../db/types.js";
import { storeWebAsset } from "./assets.js";
import {
  generateScriptSet,
  type PreconditionMode,
  type ScriptAssertionRef,
  type ScriptGenCaseInput,
  type ScriptGenResult,
  type ScriptGenUnresolved,
  type ScriptPlatform
} from "./script-gen.js";
import { buildZip } from "./zip.js";

export const SCRIPT_SET_GENERATOR = "aos-web-script-gen";
export const SCRIPT_SET_GENERATOR_VERSION = 1;

export interface ScriptSetCaseSummary {
  caseId: string;
  status: ScriptGenResult["status"];
  flow: string | null;
  assertions: number;
  assertionTexts: ScriptAssertionRef[];
  confidence: ScriptGenResult["confidence"];
  unresolved: ScriptGenUnresolved[];
  warnings: string[];
}

export interface ScriptSetManifest {
  schemaVersion: 1;
  generator: typeof SCRIPT_SET_GENERATOR;
  generatorVersion: number;
  platform: ScriptPlatform;
  appId: string;
  sourceExcelAssetId: string;
  packageAssetId: string;
  preconditionMode: PreconditionMode;
  inferNavigationTap: boolean;
  includeSoftText: boolean;
  assertionDocHash: string;
  counts: {
    cases: number;
    ready: number;
    unresolved: number;
  };
  cases: ScriptSetCaseSummary[];
}

export interface ScriptSetBundleInput {
  appId: string;
  platform: ScriptPlatform;
  sourceExcelAssetId: string;
  packageAssetId: string;
  cases: ScriptGenCaseInput[];
  preconditionMode?: PreconditionMode;
  inferNavigationTap?: boolean;
  includeSoftText?: boolean;
  generatorVersion?: number;
}

export interface ScriptSetBundle {
  manifest: ScriptSetManifest;
  files: Array<{ path: string; content: string }>;
  zip: Buffer;
  sha256: string;
  ready: number;
  unresolved: number;
}

export type ScriptSetStoreErrorCode = "invalid-bundle" | "script-set-unusable";

export class ScriptSetStoreError extends Error {
  readonly code: ScriptSetStoreErrorCode;

  constructor(code: ScriptSetStoreErrorCode, message: string) {
    super(message);
    this.name = "ScriptSetStoreError";
    this.code = code;
  }
}

export interface StoreScriptSetInput {
  store: ProjectStore;
  rootPath: string;
  bundle: ScriptSetBundle;
  uploadedBy?: string | null;
}

export interface StoreScriptSetResult {
  asset: WebAssetRecord;
  created: boolean;
}

function assertionDocHash(cases: ScriptGenCaseInput[]): string {
  const canonical = cases
    .map((entry) => ({
      caseId: entry.caseId,
      steps: entry.steps,
      expected: entry.expected ?? null,
      preconditions: entry.preconditions ?? []
    }))
    .sort((left, right) => (left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, cases: canonical }))
    .digest("hex");
}

function allocateFlowPath(caseId: string, used: Set<string>): string {
  let base = caseId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  if (base === "" || base === "." || base === "..") base = "case";
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(name);
  return `flows/${name}.yaml`;
}

function metadataFor(bundle: ScriptSetBundle): Record<string, unknown> {
  return {
    origin: "generated",
    generatedBy: "aos",
    sourceExcelAssetId: bundle.manifest.sourceExcelAssetId,
    packageAssetId: bundle.manifest.packageAssetId,
    platform: bundle.manifest.platform,
    generatorVersion: bundle.manifest.generatorVersion,
    assertionDocHash: bundle.manifest.assertionDocHash,
    preconditionMode: bundle.manifest.preconditionMode,
    inferNavigationTap: bundle.manifest.inferNavigationTap,
    includeSoftText: bundle.manifest.includeSoftText,
    appId: bundle.manifest.appId,
    ready: bundle.ready,
    unresolved: bundle.unresolved
  };
}

function sameMetadata(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(right);
  return keys.every((key) => String(left[key] ?? "") === String(right[key] ?? ""));
}

export function buildScriptSetBundle(input: ScriptSetBundleInput): ScriptSetBundle {
  const generatorVersion = input.generatorVersion ?? SCRIPT_SET_GENERATOR_VERSION;
  const generated = generateScriptSet({
    appId: input.appId,
    platform: input.platform,
    cases: input.cases,
    options: {
      preconditionMode: input.preconditionMode,
      inferNavigationTap: input.inferNavigationTap,
      includeSoftText: input.includeSoftText
    }
  });
  const used = new Set<string>();
  const files: Array<{ path: string; content: string }> = [];
  const cases: ScriptSetCaseSummary[] = [];
  for (const entry of generated.cases) {
    const flow = entry.status === "ready" ? allocateFlowPath(entry.caseId, used) : null;
    if (flow !== null && entry.yaml !== null) {
      files.push({ path: flow, content: entry.yaml });
    }
    cases.push({
      caseId: entry.caseId,
      status: entry.status,
      flow,
      assertions: entry.assertions,
      assertionTexts: entry.assertionTexts,
      confidence: entry.confidence,
      unresolved: entry.unresolved,
      warnings: entry.warnings
    });
  }
  const manifest: ScriptSetManifest = {
    schemaVersion: 1,
    generator: SCRIPT_SET_GENERATOR,
    generatorVersion,
    platform: input.platform,
    appId: input.appId,
    sourceExcelAssetId: input.sourceExcelAssetId,
    packageAssetId: input.packageAssetId,
    preconditionMode: input.preconditionMode ?? "strict",
    inferNavigationTap: input.inferNavigationTap === true,
    includeSoftText: input.includeSoftText === true,
    assertionDocHash: assertionDocHash(input.cases),
    counts: {
      cases: generated.cases.length,
      ready: generated.ready,
      unresolved: generated.unresolved
    },
    cases
  };
  const manifestFile = {
    path: "manifest.json",
    content: `${JSON.stringify(manifest, null, 2)}\n`
  };
  const allFiles = [manifestFile, ...files];
  const zip = buildZip(allFiles);
  return {
    manifest,
    files: allFiles,
    zip,
    sha256: createHash("sha256").update(zip).digest("hex"),
    ready: generated.ready,
    unresolved: generated.unresolved
  };
}

export async function storeScriptSet(input: StoreScriptSetInput): Promise<StoreScriptSetResult> {
  const sourceExcelAssetId = input.bundle.manifest.sourceExcelAssetId.trim();
  const packageAssetId = input.bundle.manifest.packageAssetId.trim();
  if (sourceExcelAssetId === "" || packageAssetId === "") {
    throw new ScriptSetStoreError(
      "invalid-bundle",
      "脚本集必须同时绑定 sourceExcelAssetId 与 packageAssetId"
    );
  }
  if (input.bundle.ready === 0) {
    throw new ScriptSetStoreError(
      "script-set-unusable",
      `没有 ready 用例（unresolved=${input.bundle.unresolved}），拒绝写脚本集`
    );
  }
  const metadata = metadataFor(input.bundle);
  const existing = (await input.store.listWebAssets(input.rootPath, "scripts")).find(
    (asset) => asset.sha256 === input.bundle.sha256 && sameMetadata(asset.metadata ?? {}, metadata)
  );
  if (existing !== undefined) {
    return { asset: existing, created: false };
  }
  const asset = await storeWebAsset({
    store: input.store,
    rootPath: input.rootPath,
    kind: "scripts",
    filename: `aos-scripts-${input.bundle.manifest.platform}-${input.bundle.sha256.slice(0, 12)}.zip`,
    buffer: input.bundle.zip,
    metadata,
    uploadedBy: input.uploadedBy ?? null
  });
  return { asset, created: true };
}
