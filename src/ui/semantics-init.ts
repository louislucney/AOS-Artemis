import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";
import type { UiScreenSemantics, UiSemanticsFile } from "./semantics.js";

export type UiSemanticsInitErrorCode =
  | "contract-missing"
  | "contract-invalid"
  | "exists"
  | "write-failed";

export class UiSemanticsInitError extends Error {
  readonly code: UiSemanticsInitErrorCode;

  constructor(code: UiSemanticsInitErrorCode, message: string) {
    super(message);
    this.name = "UiSemanticsInitError";
    this.code = code;
  }
}

export interface UiSemanticsInitOptions {
  contractPath: string;
  outPath: string;
  /** 写进 source.contract 的可移植路径；缺省用 contractPath。 */
  contractRef?: string;
  force?: boolean;
  generatedAt?: string;
}

export interface UiSemanticsInitResult {
  path: string;
  screens: number;
  created: boolean;
  warnings: string[];
}

interface ContractScreenShape {
  id: string;
  name?: string;
  [key: string]: unknown;
}

function readContract(file: string): { raw: string; parsed: Record<string, unknown> } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT") {
      throw new UiSemanticsInitError("contract-missing", `contract not found: ${file}`);
    }
    throw new UiSemanticsInitError("contract-invalid", `cannot read contract ${file}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UiSemanticsInitError(
      "contract-invalid",
      `contract is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UiSemanticsInitError("contract-invalid", `contract root must be an object: ${file}`);
  }
  return { raw, parsed: parsed as Record<string, unknown> };
}

function contractScreens(parsed: Record<string, unknown>, file: string): ContractScreenShape[] {
  const screens = parsed.screens;
  if (!Array.isArray(screens)) {
    throw new UiSemanticsInitError("contract-invalid", `contract.screens must be an array: ${file}`);
  }
  return screens.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new UiSemanticsInitError(
        "contract-invalid",
        `contract.screens[${index}] must be an object: ${file}`
      );
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id === "") {
      throw new UiSemanticsInitError(
        "contract-invalid",
        `contract.screens[${index}].id must be a non-empty string: ${file}`
      );
    }
    const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : undefined;
    return { id, ...(name !== undefined ? { name } : {}) };
  });
}

function fingerprint(raw: string, parsed: Record<string, unknown>): string {
  const source = parsed.source;
  if (source !== null && typeof source === "object" && !Array.isArray(source)) {
    const value = (source as Record<string, unknown>).fingerprint;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return createHash("sha256").update(raw).digest("hex");
}

export function initUiSemantics(options: UiSemanticsInitOptions): UiSemanticsInitResult {
  const { raw, parsed } = readContract(options.contractPath);
  const screens = contractScreens(parsed, options.contractPath);
  const warnings: string[] = [];
  if (screens.length === 0) {
    warnings.push("contract has no screens; generated a draft with no screens");
  }
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const file: UiSemanticsFile = {
    version: 1,
    draft: true,
    generatedAt,
    source: {
      contract: options.contractRef ?? options.contractPath,
      contractFingerprint: fingerprint(raw, parsed)
    },
    screens: screens.map<UiScreenSemantics>((screen) => ({
      screenId: screen.id,
      ...(screen.name !== undefined ? { screenName: screen.name } : {}),
      regions: []
    }))
  };

  if (!options.force && fs.existsSync(options.outPath)) {
    throw new UiSemanticsInitError("exists", `output already exists: ${options.outPath} (use --force to overwrite)`);
  }
  if (options.force && fs.existsSync(options.outPath)) {
    fs.copyFileSync(options.outPath, `${options.outPath}.bak`);
  }
  try {
    writeFileAtomic(options.outPath, `${JSON.stringify(file, null, 2)}\n`);
  } catch (error) {
    throw new UiSemanticsInitError(
      "write-failed",
      `cannot write ${options.outPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { path: options.outPath, screens: screens.length, created: true, warnings };
}

export function defaultSemanticsPath(configDirAbs: string): string {
  return path.join(configDirAbs, "design", "ui-semantics.json");
}

export function defaultContractPath(configDirAbs: string): string {
  return path.join(configDirAbs, "design", "ui-contract.json");
}
