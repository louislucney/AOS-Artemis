#!/usr/bin/env node
// 设计→测试 一条链：读取设计图 → 理解交互 → 生成用例 → 静态校验 → 执行测试
//
// 用法:
//   node scripts/design-to-test.mjs --figma "<figma-url>" [--node-id <id>] --project <dir> [--device <serial>] [--no-run]
//   node scripts/design-to-test.mjs --pen "<路径.pen>" [--vision auto|true|false] --project <dir> [--device <serial>] [--no-run]
// 选项:
//   --node-id <id>  仅 Figma：覆盖 URL 中的 node-id
//   --vision <mode> 仅 pen：交互元素视觉识别（auto|true|false，默认 auto）
//   --project <dir> 目标项目根（默认 AOS_PROJECT_DIR 或 cwd）
//   --device <s>    设备 serial（Android/adb；不传则只到校验并给出执行命令）
//   --no-check      跳过静态校验（suite check）
//   --no-run        只到校验，不执行测试
// 退出码: 0 全通过；1 测试执行有失败；2 流程错误（提取/生成/校验失败）；3 用法错误

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const message = (error) => (error instanceof Error ? error.message : String(error));

export function parsePipelineArgs(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const has = (name) => argv.includes(name);
  if (has("--help") || has("-h")) return { help: true };

  const figma = flag("--figma");
  const pen = flag("--pen");
  if (figma && pen) throw new Error("--figma 与 --pen 只能给一个");
  if (!figma && !pen) throw new Error("需要 --figma <url> 或 --pen <路径> 之一");
  const nodeId = flag("--node-id");
  if (nodeId && !figma) throw new Error("--node-id 仅适用于 --figma");
  const vision = flag("--vision");
  const source = figma
    ? { kind: "figma", url: figma, ...(nodeId ? { nodeId } : {}) }
    : { kind: "pen", penPath: pen, ...(vision ? { vision } : {}) };

  return {
    source,
    projectDir: flag("--project") ?? process.env.AOS_PROJECT_DIR ?? process.cwd(),
    device: flag("--device"),
    noRun: has("--no-run"),
    noCheck: has("--no-check")
  };
}

export async function runPipeline({ options, deps, log, errorLog }) {
  const { source, projectDir, device, noRun, noCheck } = options;

  const extractName = source.kind === "figma" ? "figma_extract_flows" : "pen_extract_flows";
  const extractArgs =
    source.kind === "figma"
      ? { url: source.url, ...(source.nodeId ? { nodeId: source.nodeId } : {}) }
      : { penPath: source.penPath, ...(source.vision ? { vision: source.vision } : {}) };
  let flows;
  try {
    flows = await deps.callTool(extractName, extractArgs);
  } catch (error) {
    errorLog(`✗ ① 设计提取失败: ${message(error)}`);
    return 2;
  }
  if (!flows || flows.ok === false) {
    errorLog(`✗ ① 设计提取失败: ${flows?.error ?? "无响应"}`);
    return 2;
  }
  log(
    `① 设计: screens=${flows.counts?.screens ?? "?"} edges=${flows.counts?.edges ?? "?"} entries=[${(flows.entryScreens ?? []).join(", ")}]`
  );

  let tests;
  try {
    tests = await deps.callTool("figma_generate_tests", {});
  } catch (error) {
    errorLog(`✗ ③ 用例生成失败: ${message(error)}`);
    return 2;
  }
  if (!tests || tests.ok === false) {
    errorLog(`✗ ③ 用例生成失败: ${tests?.error ?? "无响应"}`);
    return 2;
  }
  const hardGaps = tests.coverage
    ? (tests.coverage.uncoveredScreens?.length ?? 0) + (tests.coverage.uncoveredEdges?.length ?? 0)
    : null;
  log(
    `③ 用例: ${tests.counts?.flows ?? "?"} 条${hardGaps !== null ? `，硬覆盖缺口 ${hardGaps}` : ""}${tests.savedTo?.markdown ? ` → ${tests.savedTo.markdown}` : ""}`
  );

  if (!noCheck) {
    const checkCode = await deps.runCli(["suite", "check", "--project", projectDir]);
    if (checkCode !== 0) {
      errorLog(`✗ ④ 静态校验未通过（exit ${checkCode}）；修正后重跑（或用 --no-check 跳过）`);
      return 2;
    }
    log("④ 校验: 通过");
  } else {
    log("④ 校验: 跳过（--no-check）");
  }

  if (noRun) {
    log("⑤ 执行: 跳过（--no-run）");
    return 0;
  }
  if (!device) {
    log("⑤ 执行: 未提供 --device；手工执行:");
    log(`   node dist/cli.js suite run --project "${projectDir}" --device <serial>`);
    return 0;
  }
  const runCode = await deps.runCli(["suite", "run", "--project", projectDir, "--device", device]);
  log(`⑤ 执行: exit ${runCode}`);
  return runCode === 0 ? 0 : runCode === 2 ? 2 : 1;
}

function usage() {
  console.log(`设计→测试 一条链：读取设计图 → 理解交互 → 生成用例 → 静态校验 → 执行测试

用法:
  node scripts/design-to-test.mjs --figma "<url>" [--node-id <id>] --project <dir> [--device <serial>] [--no-run]
  node scripts/design-to-test.mjs --pen "<路径.pen>" [--vision auto|true|false] --project <dir> [--device <serial>] [--no-run]

说明:
  - ①+② 提取设计流程（Figma 原型连线=explicit；pen 无交互数据时画板推断，vision 可做交互元素识别）；
  - ③ figma_generate_tests 落三件套（tests.json/md/xlsx + case-sets）；
  - ④ suite check 静态校验（三件套/真实数据/覆盖硬门禁，不连设备）；
  - ⑤ 传 --device 时执行 suite run；不传则给出执行命令。

退出码: 0 全通过；1 测试执行有失败；2 流程错误（提取/生成/校验失败）；3 用法错误`);
}

function parseJsonResult(result) {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  let options;
  try {
    options = parsePipelineArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`用法错误: ${message(error)}`);
    usage();
    return 3;
  }
  if (options.help) {
    usage();
    return 0;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "design-to-test", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      env: { ...process.env, AOS_PROJECT_DIR: options.projectDir }
    })
  );
  const deps = {
    callTool: async (name, toolArgs) => {
      const result = await client.callTool({ name, arguments: toolArgs });
      const payload = parseJsonResult(result);
      if (payload === null && result.isError === true) {
        throw new Error("工具返回错误（无结构化输出）");
      }
      return payload;
    },
    runCli: async (cliArgs) => {
      const run = spawnSync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), ...cliArgs], {
        stdio: "inherit",
        cwd: repoRoot
      });
      return run.status ?? 2;
    }
  };
  try {
    console.log(`项目: ${options.projectDir}`);
    return await runPipeline({ options, deps, log: console.log, errorLog: console.error });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
