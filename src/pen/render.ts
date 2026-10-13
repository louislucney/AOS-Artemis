import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { detectPenFailure, runPenInteractive, type PenExecFn } from "./cli.js";
import { ensurePenCli, type PenEnsureFn } from "./install.js";

export interface PenScreenRenderInput {
  target: string;
  screenIds: string[];
  env: Record<string, string>;
  /** 输出目录（调用方决定：视觉/截图流程先落私有临时目录，校验后原子入库）。 */
  outDir?: string;
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
  timeoutMs?: number;
}

export interface PenScreenRenderResult {
  ok: boolean;
  dir: string | null;
  /** screenId → absolute PNG path (scale 1, render coordinate system). */
  files: Map<string, string>;
  missing: string[];
  error?: string;
  log?: string;
}

/** Render each screen frame of a `.pen` to a 1x PNG through one interactive
 * pen CLI session (`Export([ids], "png", dir, { scale: 1 })`), reusing the
 * same session mechanism as `pen_import_assets`. */
export async function renderPenScreens(input: PenScreenRenderInput): Promise<PenScreenRenderResult> {
  const screenIds = [...new Set(input.screenIds.filter((id) => id.trim() !== ""))];
  if (screenIds.length === 0) {
    return { ok: true, dir: null, files: new Map(), missing: [] };
  }
  const ready = await (input.ensure ?? ensurePenCli)({ env: input.env });
  if (!ready.ok) {
    return {
      ok: false,
      dir: null,
      files: new Map(),
      missing: screenIds,
      error: ready.error ?? "pen CLI 不可用"
    };
  }
  const outDir = input.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "aos-pen-vision-"));
  fs.mkdirSync(outDir, { recursive: true });
  const expression = `Export(${JSON.stringify(screenIds)}, "png", ${JSON.stringify(outDir)}, { scale: 1 })`;
  const sessionFile = `session-${process.pid}-${randomBytes(3).toString("hex")}.pen`;
  const run = await runPenInteractive({
    input: input.target,
    output: path.join(outDir, sessionFile),
    commands: [`execute({ input: ${JSON.stringify(expression)} })`],
    timeoutMs: input.timeoutMs,
    exec: input.exec,
    cliPath: ready.path ?? undefined,
    env: input.env
  });
  const failure = detectPenFailure(run.result, run.log);
  const files = new Map<string, string>();
  const missing: string[] = [];
  for (const id of screenIds) {
    const file = path.join(outDir, `${id}.png`);
    if (fs.existsSync(file)) files.set(id, file);
    else missing.push(id);
  }
  if (failure && missing.length === screenIds.length) {
    return { ok: false, dir: outDir, files, missing, error: failure, log: run.log };
  }
  return { ok: true, dir: outDir, files, missing, log: run.log };
}
