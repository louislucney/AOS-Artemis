import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { detectPenFailure, penEnvFrom, runPenExport, type PenExecFn } from "./cli.js";
import { ensurePenCli, type PenEnsureFn } from "./install.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";

export interface PenExportArgs {
  path?: string;
  out?: string;
  format?: "png" | "jpeg" | "webp" | "pdf";
  scale?: number;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface PenToolDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penExport(
  runtime: Runtime,
  args: PenExportArgs,
  deps: PenToolDeps = {}
): Promise<CallToolResult> {
  try {
    const target = resolvePenTarget(runtime, args.path);
    if (!target) {
      return jsonResult(
        { ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: PEN_HINT },
        true
      );
    }
    loadPenDocument(target);
    const format = args.format ?? "png";
    const scale = Math.min(Math.max(Math.trunc(args.scale ?? 2), 1), 4);
    const output = args.out
      ? path.resolve(runtime.project.rootDir, args.out)
      : path.join(runtime.configDirAbs, "design", "pen", `${path.basename(target, ".pen")}.${format}`);

    const payload: Record<string, unknown> = {
      ok: true,
      dryRun: args.dryRun === true,
      source: penRelativePath(runtime, target),
      output: penRelativePath(runtime, output),
      format,
      scale
    };
    if (args.dryRun === true) {
      return jsonResult({ ...payload, command: ["pen", "--in", target, "--export", output, "--export-scale", String(scale), ...(format !== "png" ? ["--export-type", format] : [])] });
    }

    const env = penEnvFrom(runtime.project.dotenvValues, process.env);
    const ready = await (deps.ensure ?? ensurePenCli)({ env });
    if (!ready.ok) {
      return jsonResult({ ok: false, error: ready.error ?? "pen CLI 不可用", hint: ready.hint }, true);
    }

    const existedBefore = fs.existsSync(output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const started = Date.now();
    const run = await runPenExport({
      input: target,
      output,
      format,
      scale,
      timeoutMs: args.timeoutMs,
      exec: deps.exec,
      cliPath: ready.path ?? undefined,
      env
    });
    const failure = detectPenFailure(run.result, run.log);
    if (failure || !run.saved) {
      if (!existedBefore) {
        try {
          fs.rmSync(output, { force: true });
        } catch {
          /* best effort */
        }
      }
      return jsonResult(
        {
          ok: false,
          error: failure ?? "pen CLI 未产出导出文件（检查 .pen 内容与登录状态）",
          source: penRelativePath(runtime, target),
          log: run.log.slice(-2000),
          hint: PEN_HINT
        },
        true
      );
    }

    payload.bytes = fs.statSync(output).size;
    payload.elapsedMs = Date.now() - started;
    payload.command = ["pen", "--in", target, "--export", output, "--export-scale", String(scale), ...(format !== "png" ? ["--export-type", format] : [])];
    return jsonResult(payload);
  } catch (error) {
    return jsonResult({ ok: false, error: `pen 导出失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  }
}
