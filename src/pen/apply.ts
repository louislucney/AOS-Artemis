import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { normalizeHexColor, parseCanonicalTokens } from "../figma/color.js";
import { normalizedText, parseStrings } from "../figma/strings.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { detectPenFailure, penEnvFrom, runPenInteractive, type PenExecFn } from "./cli.js";
import { ensurePenCli, type PenEnsureFn } from "./install.js";
import { loadPenDocument, PEN_HINT, penRelativePath, resolvePenTarget } from "./paths.js";
import { collectPenNodes, parsePenText } from "./read.js";
import { penVariableDefaultHex } from "./tokens.js";

export interface PenToolDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
}

export interface PenApplyTokensArgs {
  path?: string;
  tokensPath?: string;
  out?: string;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface PenApplyStringsArgs {
  path?: string;
  stringsPath?: string;
  out?: string;
  dryRun?: boolean;
  timeoutMs?: number;
}

interface ApplyRun {
  output: string;
  inPlace: boolean;
  existedBefore: boolean;
  log: string;
  elapsedMs: number;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function missingPenResult(): CallToolResult {
  return jsonResult(
    { ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: PEN_HINT },
    true
  );
}

function displayPath(runtime: Runtime, absolute: string): string {
  const relative = path.relative(runtime.project.rootDir, absolute);
  return relative.startsWith("..") ? absolute : relative;
}

function tempOutputPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.aos-${process.pid}-${Date.now()}.tmp`);
}

async function runEdits(
  runtime: Runtime,
  target: string,
  commands: string[],
  options: {
    out?: string;
    timeoutMs?: number;
    exec?: PenExecFn;
    cliPath?: string;
    env?: Record<string, string>;
  }
): Promise<{ ok: true; run: ApplyRun } | { ok: false; error: string; log: string }> {
  const inPlace = options.out === undefined;
  const output = inPlace
    ? tempOutputPath(target)
    : path.resolve(runtime.project.rootDir, options.out!);
  const existedBefore = fs.existsSync(output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const started = Date.now();
  const run = await runPenInteractive({
    input: target,
    output,
    commands,
    timeoutMs: options.timeoutMs,
    exec: options.exec,
    cliPath: options.cliPath,
    env: options.env
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
    return { ok: false, error: failure ?? "pen CLI 未产出文件（检查 .pen 输入与登录状态）", log: run.log };
  }
  return { ok: true, run: { output, inPlace, existedBefore, log: run.log, elapsedMs: Date.now() - started } };
}

function discardFailed(run: ApplyRun): void {
  if (!run.existedBefore) {
    try {
      fs.rmSync(run.output, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function commit(run: ApplyRun, target: string): string {
  if (!run.inPlace) return run.output;
  fs.renameSync(run.output, target);
  return target;
}

function themeFromKey(key: string): Record<string, string> {
  const theme: Record<string, string> = {};
  for (const part of key.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    theme[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return theme;
}

export async function penApplyTokens(
  runtime: Runtime,
  args: PenApplyTokensArgs,
  deps: PenToolDeps = {}
): Promise<CallToolResult> {
  try {
    const target = resolvePenTarget(runtime, args.path);
    if (!target) return missingPenResult();
    loadPenDocument(target);

    const designDir = path.join(runtime.configDirAbs, "design");
    const tokensPath = args.tokensPath
      ? path.resolve(runtime.project.rootDir, args.tokensPath)
      : path.join(designDir, "tokens.json");
    if (!fs.existsSync(tokensPath)) {
      return jsonResult(
        {
          ok: false,
          error: `tokens.json 不存在：${displayPath(runtime, tokensPath)}`,
          hint: "先运行 pen_import_tokens（或 figma_import_tokens）生成 tokens.json。"
        },
        true
      );
    }
    const tokens = parseCanonicalTokens(fs.readFileSync(tokensPath, "utf-8"));
    const variables: Record<string, { type: "color"; value: unknown }> = {};
    const expected: Record<string, string> = {};
    const skippedAliases: string[] = [];
    for (const token of tokens) {
      if (token.aliasOf || token.value.startsWith("{")) {
        skippedAliases.push(token.name);
        continue;
      }
      const base = token.modes.default ?? token.value;
      expected[token.name] = base;
      const themed = Object.entries(token.modes).filter(
        ([key, value]) => key !== "default" && typeof value === "string" && value.startsWith("#")
      );
      if (themed.length === 0) {
        variables[token.name] = { type: "color", value: base };
      } else {
        variables[token.name] = {
          type: "color",
          value: [
            { value: base },
            ...themed.map(([key, value]) => ({ value, theme: themeFromKey(key) }))
          ]
        };
      }
    }
    const names = Object.keys(variables);
    if (names.length === 0) {
      return jsonResult(
        { ok: false, error: "tokens.json 中没有可写回的颜色 token（别名 token 随基础值写入）" },
        true
      );
    }

    const command = `SetVariables(${JSON.stringify(variables)})`;
    const payloadBase = {
      source: penRelativePath(runtime, target),
      tokensFile: displayPath(runtime, tokensPath),
      variables: names.length,
      tokenNames: names.slice(0, 50),
      skippedAliases
    };
    if (args.dryRun === true) {
      return jsonResult({ ok: true, dryRun: true, ...payloadBase, command });
    }

    const env = penEnvFrom(runtime.project.dotenvValues, process.env);
    const ready = await (deps.ensure ?? ensurePenCli)({ env });
    if (!ready.ok) {
      return jsonResult({ ok: false, error: ready.error ?? "pen CLI 不可用", hint: ready.hint }, true);
    }

    const editResult = await runEdits(runtime, target, [command], {
      out: args.out,
      timeoutMs: args.timeoutMs,
      exec: deps.exec,
      cliPath: ready.path ?? undefined,
      env
    });
    if (!editResult.ok) {
      return jsonResult(
        { ok: false, error: `pen 写回失败: ${editResult.error}`, ...payloadBase, log: editResult.log.slice(-2000), hint: PEN_HINT },
        true
      );
    }
    const run = editResult.run;
    const doc = parsePenText(fs.readFileSync(run.output, "utf-8"));
    const mismatches: Array<{ name: string; expected: string; actual: string | null }> = [];
    for (const [name, expectedValue] of Object.entries(expected)) {
      const actual = penVariableDefaultHex(doc.variables?.[name], doc.variables ?? {});
      const wanted = normalizeHexColor(expectedValue);
      if (!actual || !wanted || actual !== wanted) {
        mismatches.push({ name, expected: wanted ?? expectedValue, actual });
      }
    }
    if (mismatches.length > 0) {
      discardFailed(run);
      return jsonResult(
        {
          ok: false,
          error: `写回校验失败（${mismatches.length} 个变量不一致），原文件未改动`,
          mismatches: mismatches.slice(0, 10),
          log: run.log.slice(-2000),
          hint: PEN_HINT
        },
        true
      );
    }
    const finalPath = commit(run, target);
    return jsonResult({
      ok: true,
      ...payloadBase,
      output: displayPath(runtime, finalPath),
      inPlace: run.inPlace,
      elapsedMs: run.elapsedMs
    });
  } catch (error) {
    return jsonResult({ ok: false, error: `pen 颜色 token 写回失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  }
}

export async function penApplyStrings(
  runtime: Runtime,
  args: PenApplyStringsArgs,
  deps: PenToolDeps = {}
): Promise<CallToolResult> {
  try {
    const target = resolvePenTarget(runtime, args.path);
    if (!target) return missingPenResult();
    const doc = loadPenDocument(target);

    const designDir = path.join(runtime.configDirAbs, "design");
    const stringsPath = args.stringsPath
      ? path.resolve(runtime.project.rootDir, args.stringsPath)
      : path.join(designDir, "strings.json");
    if (!fs.existsSync(stringsPath)) {
      return jsonResult(
        {
          ok: false,
          error: `strings.json 不存在：${displayPath(runtime, stringsPath)}`,
          hint: "先运行 pen_import_strings（或 figma_import_strings）生成 strings.json。"
        },
        true
      );
    }
    const strings = parseStrings(fs.readFileSync(stringsPath, "utf-8"));
    const textIds = new Set<string>();
    for (const node of collectPenNodes(doc)) {
      if (node.type === "text" && typeof node.id === "string") textIds.add(node.id);
    }

    const commands: string[] = [];
    const applied: string[] = [];
    const notFound: string[] = [];
    const expected = new Map<string, string>();
    for (const entry of strings.entries) {
      if (!entry.nodeId || !textIds.has(entry.nodeId)) {
        notFound.push(entry.key);
        continue;
      }
      commands.push(`Update(${JSON.stringify(entry.nodeId)}, {content: ${JSON.stringify(entry.sourceText)}})`);
      applied.push(entry.key);
      expected.set(entry.nodeId, entry.sourceText);
    }
    if (commands.length === 0) {
      return jsonResult(
        { ok: false, error: "strings.json 没有可写回的文本（nodeId 与 .pen 文本节点不匹配）", notFound: notFound.slice(0, 20) },
        true
      );
    }

    const payloadBase = {
      source: penRelativePath(runtime, target),
      stringsFile: displayPath(runtime, stringsPath),
      entries: applied.length,
      keys: applied.slice(0, 50),
      notFound: notFound.slice(0, 20)
    };
    if (args.dryRun === true) {
      return jsonResult({ ok: true, dryRun: true, ...payloadBase, commandCount: commands.length, commands: commands.slice(0, 3) });
    }

    const env = penEnvFrom(runtime.project.dotenvValues, process.env);
    const ready = await (deps.ensure ?? ensurePenCli)({ env });
    if (!ready.ok) {
      return jsonResult({ ok: false, error: ready.error ?? "pen CLI 不可用", hint: ready.hint }, true);
    }

    const editResult = await runEdits(runtime, target, commands, {
      out: args.out,
      timeoutMs: args.timeoutMs,
      exec: deps.exec,
      cliPath: ready.path ?? undefined,
      env
    });
    if (!editResult.ok) {
      return jsonResult(
        { ok: false, error: `pen 写回失败: ${editResult.error}`, ...payloadBase, log: editResult.log.slice(-2000), hint: PEN_HINT },
        true
      );
    }
    const run = editResult.run;
    const outDoc = parsePenText(fs.readFileSync(run.output, "utf-8"));
    const outTexts = new Map<string, string>();
    for (const node of collectPenNodes(outDoc)) {
      if (node.type === "text" && typeof node.id === "string" && typeof node.content === "string") {
        outTexts.set(node.id, node.content);
      }
    }
    const mismatches: Array<{ nodeId: string; expected: string; actual: string | null }> = [];
    for (const [nodeId, text] of expected) {
      const actual = outTexts.get(nodeId) ?? null;
      if (actual === null || normalizedText(actual) !== normalizedText(text)) {
        mismatches.push({ nodeId, expected: text, actual });
      }
    }
    if (mismatches.length > 0) {
      discardFailed(run);
      return jsonResult(
        {
          ok: false,
          error: `写回校验失败（${mismatches.length} 个文本不一致），原文件未改动`,
          mismatches: mismatches.slice(0, 10),
          log: run.log.slice(-2000),
          hint: PEN_HINT
        },
        true
      );
    }
    const finalPath = commit(run, target);
    return jsonResult({
      ok: true,
      ...payloadBase,
      output: displayPath(runtime, finalPath),
      inPlace: run.inPlace,
      elapsedMs: run.elapsedMs
    });
  } catch (error) {
    return jsonResult({ ok: false, error: `pen 文案写回失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  }
}
