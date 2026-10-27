import fs from "node:fs";
import path from "node:path";

import type { Bbox } from "../diff/engine.js";

export type UiRegionRole =
  | "header"
  | "category-list"
  | "product-list"
  | "search"
  | "banner"
  | "footer"
  | "group-header"
  | "unknown";

export interface UiViewport {
  width: number;
  height: number;
  scale?: number;
}

export type UiTaxonomyKind = "category" | "group-header" | "virtual";

export interface UiTaxonomyNode {
  id: string;
  label: string;
  kind: UiTaxonomyKind;
  aliases?: string[];
  children?: UiTaxonomyNode[];
  allowDuplicates?: boolean;
  expectedCount?: number;
}

export interface UiRegionSemantics {
  id: string;
  role: UiRegionRole;
  designBbox?: Bbox;
  deviceBbox?: Bbox;
  isDynamic?: boolean;
  dynamicAssets?: boolean;
  invariantTexts?: string[];
  dynamicExamples?: string[];
  dynamicPatterns?: string[];
  expectedAssets?: number;
  taxonomy?: UiTaxonomyNode[];
  allowedRoles?: UiRegionRole[];
  allowDuplicates?: boolean;
  expectedOccurrences?: number;
  expectedCount?: number;
}

export interface UiDataProfile {
  design: string;
  runtime: string;
  allowedDynamicFields: Array<"name" | "price" | "image" | "availability" | "order">;
}

export interface UiScreenSemantics {
  screenId: string;
  screenName?: string;
  viewport?: UiViewport;
  displayNames?: Record<string, string[]>;
  dataProfile?: UiDataProfile;
  regions: UiRegionSemantics[];
}

export interface UiSemanticsFile {
  version: 1;
  draft?: boolean;
  generatedAt?: string;
  source?: {
    contract?: string;
    contractFingerprint?: string;
    figma?: string;
    nodeId?: string;
    designFingerprint?: string;
  };
  screens: UiScreenSemantics[];
}

export interface UiSemanticsParseResult {
  file: UiSemanticsFile | null;
  errors: string[];
}

export interface UiSemanticsLoadResult extends UiSemanticsParseResult {
  path: string;
}

const ROLES = new Set<UiRegionRole>([
  "header",
  "category-list",
  "product-list",
  "search",
  "banner",
  "footer",
  "group-header",
  "unknown"
]);

const TAXONOMY_KINDS = new Set<UiTaxonomyKind>(["category", "group-header", "virtual"]);
const DYNAMIC_FIELDS = new Set(["name", "price", "image", "availability", "order"]);
const MAX_PATTERN_LENGTH = 200;
const MAX_TAXONOMY_DEPTH = 8;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0 || !Number.isInteger(number)) return null;
  return number;
}

function optionalBoolean(value: unknown, pathLabel: string, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    errors.push(`${pathLabel}: expected boolean`);
    return undefined;
  }
  return value;
}

function parseBbox(value: unknown): Bbox | null {
  if (!isObject(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function normalizedKey(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function normalizeUiText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = nonEmptyString(entry);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

function parseViewport(value: unknown, pathLabel: string, errors: string[]): UiViewport | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${pathLabel}: viewport must be an object`);
    return undefined;
  }
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  const scale = value.scale === undefined ? undefined : finiteNumber(value.scale);
  if (width === null || width <= 0) errors.push(`${pathLabel}.viewport.width: expected > 0`);
  if (height === null || height <= 0) errors.push(`${pathLabel}.viewport.height: expected > 0`);
  if (value.scale !== undefined && (typeof scale !== "number" || scale <= 0)) {
    errors.push(`${pathLabel}.viewport.scale: expected > 0`);
  }
  if (width === null || height === null || width <= 0 || height <= 0) return undefined;
  return {
    width,
    height,
    ...(typeof scale === "number" && scale > 0 ? { scale } : {})
  };
}

function parseDisplayNames(value: unknown, pathLabel: string, errors: string[]): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${pathLabel}: displayNames must be an object`);
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const label = key.trim();
    const aliases = stringList(raw);
    if (label === "" || aliases === null || aliases.length === 0) {
      errors.push(`${pathLabel}.displayNames[${JSON.stringify(key)}]: expected non-empty string[]`);
      continue;
    }
    out[label] = aliases;
  }
  return out;
}

function parseDataProfile(value: unknown, pathLabel: string, errors: string[]): UiDataProfile | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${pathLabel}: dataProfile must be an object`);
    return undefined;
  }
  const design = nonEmptyString(value.design);
  const runtime = nonEmptyString(value.runtime);
  if (design === null) errors.push(`${pathLabel}.dataProfile.design: expected non-empty string`);
  if (runtime === null) errors.push(`${pathLabel}.dataProfile.runtime: expected non-empty string`);
  if (!Array.isArray(value.allowedDynamicFields)) {
    errors.push(`${pathLabel}.dataProfile.allowedDynamicFields: expected array`);
    return undefined;
  }
  const fields: UiDataProfile["allowedDynamicFields"] = [];
  for (const [index, entry] of value.allowedDynamicFields.entries()) {
    const field = nonEmptyString(entry);
    if (field === null || !DYNAMIC_FIELDS.has(field)) {
      errors.push(
        `${pathLabel}.dataProfile.allowedDynamicFields[${index}]: expected one of ${[...DYNAMIC_FIELDS].join(", ")}`
      );
      continue;
    }
    fields.push(field as UiDataProfile["allowedDynamicFields"][number]);
  }
  if (design === null || runtime === null) return undefined;
  return { design, runtime, allowedDynamicFields: fields };
}

interface TaxonomyState {
  ids: Set<string>;
  labels: Set<string>;
}

function parseTaxonomyNode(
  value: unknown,
  pathLabel: string,
  state: TaxonomyState,
  depth: number,
  errors: string[]
): UiTaxonomyNode | null {
  if (depth > MAX_TAXONOMY_DEPTH) {
    errors.push(`${pathLabel}: taxonomy depth exceeds ${MAX_TAXONOMY_DEPTH}`);
    return null;
  }
  if (!isObject(value)) {
    errors.push(`${pathLabel}: expected taxonomy node object`);
    return null;
  }
  const id = nonEmptyString(value.id);
  const label = nonEmptyString(value.label);
  const kind = nonEmptyString(value.kind) as UiTaxonomyKind | null;
  if (id === null) errors.push(`${pathLabel}.id: expected non-empty string`);
  if (label === null) errors.push(`${pathLabel}.label: expected non-empty string`);
  if (kind === null || !TAXONOMY_KINDS.has(kind)) {
    errors.push(`${pathLabel}.kind: expected category | group-header | virtual`);
  }
  if (id !== null) {
    if (state.ids.has(id)) errors.push(`${pathLabel}.id: duplicate taxonomy id ${JSON.stringify(id)}`);
    else state.ids.add(id);
  }
  if (label !== null) {
    const key = normalizedKey(label);
    if (state.labels.has(key)) {
      errors.push(`${pathLabel}.label: duplicate taxonomy label ${JSON.stringify(label)}`);
    } else {
      state.labels.add(key);
    }
  }
  const aliases = value.aliases === undefined ? undefined : stringList(value.aliases);
  if (value.aliases !== undefined && aliases === null) {
    errors.push(`${pathLabel}.aliases: expected non-empty string[]`);
  }
  const allowDuplicates = optionalBoolean(value.allowDuplicates, `${pathLabel}.allowDuplicates`, errors);
  const expectedCount = value.expectedCount === undefined ? undefined : nonNegativeInteger(value.expectedCount);
  if (value.expectedCount !== undefined && expectedCount === null) {
    errors.push(`${pathLabel}.expectedCount: expected non-negative integer`);
  }
  let children: UiTaxonomyNode[] | undefined;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || value.children.length === 0) {
      errors.push(`${pathLabel}.children: expected non-empty array`);
    } else {
      children = [];
      for (const [index, child] of value.children.entries()) {
        const parsed = parseTaxonomyNode(
          child,
          `${pathLabel}.children[${index}]`,
          state,
          depth + 1,
          errors
        );
        if (parsed !== null) children.push(parsed);
      }
    }
  }
  if (kind === "group-header" && (children === undefined || children.length === 0)) {
    errors.push(`${pathLabel}: group-header must have children`);
  }
  if (id === null || label === null || kind === null || !TAXONOMY_KINDS.has(kind)) return null;
  return {
    id,
    label,
    kind,
    ...(aliases !== null && aliases !== undefined ? { aliases } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(allowDuplicates !== undefined ? { allowDuplicates } : {}),
    ...(expectedCount !== null && expectedCount !== undefined ? { expectedCount } : {})
  };
}

function parseTaxonomy(value: unknown, pathLabel: string, errors: string[]): UiTaxonomyNode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${pathLabel}.taxonomy: expected array`);
    return undefined;
  }
  const state: TaxonomyState = { ids: new Set(), labels: new Set() };
  const out: UiTaxonomyNode[] = [];
  for (const [index, entry] of value.entries()) {
    const node = parseTaxonomyNode(entry, `${pathLabel}.taxonomy[${index}]`, state, 0, errors);
    if (node !== null) out.push(node);
  }
  return out;
}

function parseRegion(
  value: unknown,
  pathLabel: string,
  seenRegionIds: Set<string>,
  errors: string[]
): UiRegionSemantics | null {
  if (!isObject(value)) {
    errors.push(`${pathLabel}: expected region object`);
    return null;
  }
  const id = nonEmptyString(value.id);
  if (id === null) {
    errors.push(`${pathLabel}.id: expected non-empty string`);
  } else if (seenRegionIds.has(id)) {
    errors.push(`${pathLabel}.id: duplicate region id ${JSON.stringify(id)}`);
  } else {
    seenRegionIds.add(id);
  }
  const role = nonEmptyString(value.role) as UiRegionRole | null;
  if (role === null || !ROLES.has(role)) {
    errors.push(`${pathLabel}.role: expected one of ${[...ROLES].join(", ")}`);
  }
  const designBbox = value.designBbox === undefined ? undefined : parseBbox(value.designBbox);
  if (value.designBbox !== undefined && designBbox === null) {
    errors.push(`${pathLabel}.designBbox: expected finite x/y and width/height > 0`);
  }
  const deviceBbox = value.deviceBbox === undefined ? undefined : parseBbox(value.deviceBbox);
  if (value.deviceBbox !== undefined && deviceBbox === null) {
    errors.push(`${pathLabel}.deviceBbox: expected finite x/y and width/height > 0`);
  }
  const isDynamic = optionalBoolean(value.isDynamic, `${pathLabel}.isDynamic`, errors);
  const dynamicAssets = optionalBoolean(value.dynamicAssets, `${pathLabel}.dynamicAssets`, errors);
  const invariantTexts = value.invariantTexts === undefined ? undefined : stringList(value.invariantTexts);
  if (value.invariantTexts !== undefined && invariantTexts === null) {
    errors.push(`${pathLabel}.invariantTexts: expected non-empty string[]`);
  }
  const dynamicExamples = value.dynamicExamples === undefined ? undefined : stringList(value.dynamicExamples);
  if (value.dynamicExamples !== undefined && dynamicExamples === null) {
    errors.push(`${pathLabel}.dynamicExamples: expected non-empty string[]`);
  }
  if (invariantTexts !== null && invariantTexts !== undefined && dynamicExamples !== null && dynamicExamples !== undefined) {
    const invariants = new Set(invariantTexts.map(normalizedKey));
    for (const [index, example] of dynamicExamples.entries()) {
      if (invariants.has(normalizedKey(example))) {
        errors.push(
          `${pathLabel}.dynamicExamples[${index}]: overlaps invariantTexts (${JSON.stringify(example)})`
        );
      }
    }
  }
  let dynamicPatterns: string[] | undefined;
  if (value.dynamicPatterns !== undefined) {
    if (!Array.isArray(value.dynamicPatterns)) {
      errors.push(`${pathLabel}.dynamicPatterns: expected string[]`);
    } else {
      dynamicPatterns = [];
      for (const [index, entry] of value.dynamicPatterns.entries()) {
        const source = nonEmptyString(entry);
        if (source === null) {
          errors.push(`${pathLabel}.dynamicPatterns[${index}]: expected non-empty string`);
          continue;
        }
        if (source.length > MAX_PATTERN_LENGTH) {
          errors.push(
            `${pathLabel}.dynamicPatterns[${index}]: exceeds ${MAX_PATTERN_LENGTH} characters`
          );
          continue;
        }
        try {
          new RegExp(source, "u");
        } catch (error) {
          errors.push(
            `${pathLabel}.dynamicPatterns[${index}]: invalid regex (${error instanceof Error ? error.message : String(error)})`
          );
          continue;
        }
        dynamicPatterns.push(source);
      }
    }
  }
  const expectedAssets = value.expectedAssets === undefined ? undefined : nonNegativeInteger(value.expectedAssets);
  if (value.expectedAssets !== undefined && expectedAssets === null) {
    errors.push(`${pathLabel}.expectedAssets: expected non-negative integer`);
  }
  const expectedOccurrences =
    value.expectedOccurrences === undefined ? undefined : nonNegativeInteger(value.expectedOccurrences);
  if (value.expectedOccurrences !== undefined && expectedOccurrences === null) {
    errors.push(`${pathLabel}.expectedOccurrences: expected non-negative integer`);
  }
  const expectedCount = value.expectedCount === undefined ? undefined : nonNegativeInteger(value.expectedCount);
  if (value.expectedCount !== undefined && expectedCount === null) {
    errors.push(`${pathLabel}.expectedCount: expected non-negative integer`);
  }
  const allowDuplicates = optionalBoolean(value.allowDuplicates, `${pathLabel}.allowDuplicates`, errors);
  let allowedRoles: UiRegionRole[] | undefined;
  if (value.allowedRoles !== undefined) {
    if (!Array.isArray(value.allowedRoles)) {
      errors.push(`${pathLabel}.allowedRoles: expected role[]`);
    } else {
      allowedRoles = [];
      for (const [index, entry] of value.allowedRoles.entries()) {
        const roleValue = nonEmptyString(entry) as UiRegionRole | null;
        if (roleValue === null || !ROLES.has(roleValue)) {
          errors.push(`${pathLabel}.allowedRoles[${index}]: expected a valid role`);
          continue;
        }
        allowedRoles.push(roleValue);
      }
    }
  }
  const taxonomy = parseTaxonomy(value.taxonomy, pathLabel, errors);
  if (id === null || role === null || !ROLES.has(role)) return null;
  return {
    id,
    role,
    ...(designBbox !== null && designBbox !== undefined ? { designBbox } : {}),
    ...(deviceBbox !== null && deviceBbox !== undefined ? { deviceBbox } : {}),
    ...(isDynamic !== undefined ? { isDynamic } : {}),
    ...(dynamicAssets !== undefined ? { dynamicAssets } : {}),
    ...(invariantTexts !== null && invariantTexts !== undefined ? { invariantTexts } : {}),
    ...(dynamicExamples !== null && dynamicExamples !== undefined ? { dynamicExamples } : {}),
    ...(dynamicPatterns !== undefined ? { dynamicPatterns } : {}),
    ...(expectedAssets !== null && expectedAssets !== undefined ? { expectedAssets } : {}),
    ...(taxonomy !== undefined ? { taxonomy } : {}),
    ...(allowedRoles !== undefined ? { allowedRoles } : {}),
    ...(allowDuplicates !== undefined ? { allowDuplicates } : {}),
    ...(expectedOccurrences !== null && expectedOccurrences !== undefined ? { expectedOccurrences } : {}),
    ...(expectedCount !== null && expectedCount !== undefined ? { expectedCount } : {})
  };
}

function parseScreen(value: unknown, pathLabel: string, seenScreenIds: Set<string>, errors: string[]): UiScreenSemantics | null {
  if (!isObject(value)) {
    errors.push(`${pathLabel}: expected screen object`);
    return null;
  }
  const screenId = nonEmptyString(value.screenId);
  if (screenId === null) {
    errors.push(`${pathLabel}.screenId: expected non-empty string`);
  } else if (seenScreenIds.has(screenId)) {
    errors.push(`${pathLabel}.screenId: duplicate screenId ${JSON.stringify(screenId)}`);
  } else {
    seenScreenIds.add(screenId);
  }
  const screenName = value.screenName === undefined ? undefined : nonEmptyString(value.screenName);
  if (value.screenName !== undefined && screenName === null) {
    errors.push(`${pathLabel}.screenName: expected non-empty string`);
  }
  const viewport = parseViewport(value.viewport, pathLabel, errors);
  const displayNames = parseDisplayNames(value.displayNames, pathLabel, errors);
  const dataProfile = parseDataProfile(value.dataProfile, pathLabel, errors);
  const regions: UiRegionSemantics[] = [];
  if (value.regions !== undefined) {
    if (!Array.isArray(value.regions)) {
      errors.push(`${pathLabel}.regions: expected array`);
    } else {
      const seenRegionIds = new Set<string>();
      for (const [index, entry] of value.regions.entries()) {
        const region = parseRegion(entry, `${pathLabel}.regions[${index}]`, seenRegionIds, errors);
        if (region !== null) regions.push(region);
      }
    }
  }
  if (screenId === null) return null;
  return {
    screenId,
    ...(screenName !== null && screenName !== undefined ? { screenName } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    ...(displayNames !== undefined ? { displayNames } : {}),
    ...(dataProfile !== undefined ? { dataProfile } : {}),
    regions
  };
}

function parseSource(value: unknown, pathLabel: string, errors: string[]): UiSemanticsFile["source"] | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${pathLabel}: source must be an object`);
    return undefined;
  }
  const out: NonNullable<UiSemanticsFile["source"]> = {};
  for (const key of ["contract", "contractFingerprint", "figma", "nodeId", "designFingerprint"] as const) {
    const entry = value[key];
    if (entry === undefined) continue;
    const text = nonEmptyString(entry);
    if (text === null) {
      errors.push(`${pathLabel}.source.${key}: expected non-empty string`);
      continue;
    }
    out[key] = text;
  }
  return out;
}

export function parseUiSemantics(raw: string): UiSemanticsParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      file: null,
      errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  if (!isObject(data)) {
    return { file: null, errors: ["root: expected object"] };
  }
  const errors: string[] = [];
  if (data.version !== 1) errors.push("version: expected 1");
  const draft = optionalBoolean(data.draft, "draft", errors);
  const generatedAt = data.generatedAt === undefined ? undefined : nonEmptyString(data.generatedAt);
  if (data.generatedAt !== undefined && generatedAt === null) {
    errors.push("generatedAt: expected non-empty string");
  }
  const source = parseSource(data.source, "root", errors);
  const screens: UiScreenSemantics[] = [];
  if (!Array.isArray(data.screens)) {
    errors.push("screens: expected array");
  } else {
    const seenScreenIds = new Set<string>();
    for (const [index, entry] of data.screens.entries()) {
      const screen = parseScreen(entry, `screens[${index}]`, seenScreenIds, errors);
      if (screen !== null) screens.push(screen);
    }
  }
  if (errors.length > 0) return { file: null, errors };
  return {
    file: {
      version: 1,
      ...(draft !== undefined ? { draft } : {}),
      ...(generatedAt !== null && generatedAt !== undefined ? { generatedAt } : {}),
      ...(source !== undefined ? { source } : {}),
      screens
    },
    errors: []
  };
}

export function loadUiSemantics(
  configDirAbs: string,
  options?: { path?: string }
): UiSemanticsLoadResult {
  const filePath = options?.path
    ? path.isAbsolute(options.path)
      ? options.path
      : path.join(configDirAbs, options.path)
    : path.join(configDirAbs, "design", "ui-semantics.json");
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file: null, path: filePath, errors: [] };
    return {
      file: null,
      path: filePath,
      errors: [`read ${filePath}: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  const parsed = parseUiSemantics(raw);
  return { ...parsed, path: filePath };
}

export function semanticsForScreen(
  file: UiSemanticsFile | null,
  screenIdOrName: string
): UiScreenSemantics | null {
  if (file === null) return null;
  const query = screenIdOrName.trim();
  if (query === "") return null;
  const exact = file.screens.find((screen) => screen.screenId === query);
  if (exact !== undefined) return exact;
  const normalized = query.toLowerCase();
  const byId = file.screens.find((screen) => screen.screenId.toLowerCase() === normalized);
  if (byId !== undefined) return byId;
  return (
    file.screens.find(
      (screen) => typeof screen.screenName === "string" && screen.screenName.trim().toLowerCase() === normalized
    ) ?? null
  );
}

function compact(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function numberTokens(value: string): string[] {
  return value.match(/\d+(?:\.\d+)?/g) ?? [];
}

export function matchesDynamicExample(caseText: string, example: string): boolean {
  const left = compact(caseText);
  const right = compact(example);
  if (left === "" || right === "") return false;

  const exampleNumbers = numberTokens(right);
  if (exampleNumbers.length > 0) {
    const caseNumbers = new Set(numberTokens(left));
    return exampleNumbers.some((number) => caseNumbers.has(number));
  }

  if (left.length < 3 || right.length < 3) return false;
  return left.includes(right) || right.includes(left);
}

export function matchesDynamicPattern(text: string, patterns: readonly string[]): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const normalized = normalizeUiText(text);
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.trim() === "") continue;
    try {
      if (new RegExp(pattern, "u").test(normalized)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
