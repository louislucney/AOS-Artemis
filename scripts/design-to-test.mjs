#!/usr/bin/env node
// 设计→测试 一条链：读取设计图 → 理解交互 → 生成用例 → 静态校验 → 执行测试
//
// 最简单用法（推荐）：进到项目文件夹，直接跑——
//   cd <项目目录>
//   node <服务仓库>/scripts/design-to-test.mjs
//   它会自己认项目、自己找设计文件、问两三个问题，然后把五步串完。
//
// 高级用法（指定来源/设备，适合写脚本/CI）：
//   node scripts/design-to-test.mjs --figma "<url>" [--node-id <id>] --project <dir> [--device <serial>] [--no-run]
//   node scripts/design-to-test.mjs --pen "<路径.pen>" [--vision auto|true|false] --project <dir> [--device <serial>] [--no-run]
// 退出码: 0 全通过；1 测试执行有失败；2 流程错误（提取/生成/校验失败）；3 用法错误

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  const projectDir = flag("--project") ?? process.env.AOS_PROJECT_DIR ?? process.cwd();
  const device = flag("--device");
  const common = { projectDir, device, noRun: has("--no-run"), noCheck: has("--no-check") };

  if (!figma && !pen) return { simple: true, ...common };
  if (figma && pen) throw new Error("--figma 与 --pen 只能给一个");
  const nodeId = flag("--node-id");
  if (nodeId && !figma) throw new Error("--node-id 仅适用于 --figma");
  const vision = flag("--vision");
  const source = figma
    ? { kind: "figma", url: figma, ...(nodeId ? { nodeId } : {}) }
    : { kind: "pen", penPath: pen, ...(vision ? { vision } : {}) };
  return { source, ...common };
}

export function findDesignCandidates({ projectDir, pencilRoot = path.join(os.homedir(), ".pencil", "documents") }) {
  const found = [];
  const collect = (dir, tag) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".pen")) continue;
      const file = path.join(dir, entry);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) found.push({ path: file, mtime: stat.mtimeMs, tag });
      } catch {
        /* skip */
      }
    }
  };
  collect(path.join(projectDir, ".artemis", "design"), "项目内");
  try {
    for (const uuid of fs.readdirSync(pencilRoot)) collect(path.join(pencilRoot, uuid), ".pencil 文档");
  } catch {
    /* no pencil root */
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5)
    .map((entry) => ({
      path: entry.path,
      mtime: entry.mtime,
      label: `${entry.path}（${entry.tag}，改于 ${new Date(entry.mtime).toLocaleString("zh-CN", { hour12: false })}）`
    }));
}

export function listAdbDevices() {
  const run = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "adb-safe.mjs"), "devices", "--json"], {
    encoding: "utf-8",
    cwd: repoRoot,
    timeout: 30_000
  });
  try {
    const payload = JSON.parse(String(run.stdout ?? ""));
    if (payload.ok === true && Array.isArray(payload.entries)) {
      return payload.entries.filter((entry) => entry.state === "device").map((entry) => entry.serial);
    }
  } catch {
    /* fallthrough */
  }
  return [];
}

/** 傻瓜模式：自己认项目、找设计文件、问最少的问题，然后调用 runPipeline。 */
export async function runSimpleMode({ projectDir, options = {}, deps, ask, log, errorLog, pencilRoot }) {
  if (
    !fs.existsSync(path.join(projectDir, ".artemis")) &&
    !fs.existsSync(path.join(projectDir, "aos.config.jsonc")) &&
    !fs.existsSync(path.join(projectDir, ".env"))
  ) {
    errorLog(`这里看起来不是项目文件夹：${projectDir}`);
    errorLog("请先 cd 到项目目录（或用 --project <dir> 指定）再跑一次。");
    return 2;
  }

  log(`项目: ${projectDir}`);
  let source = options.source ?? null;

  const flowsPath = path.join(projectDir, ".artemis", "design", "flows.json");
  if (source === null && fs.existsSync(flowsPath)) {
    let screens = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
      if (Array.isArray(parsed.screens)) screens = parsed.screens.length;
    } catch {
      /* unreadable */
    }
    const answer = (await ask(`① 发现已有设计流程${screens !== null ? `（${screens} 屏）` : ""}——直接用它生成用例？（回车=用 / r=重新读设计图）`)).trim().toLowerCase();
    if (answer !== "r") source = null;
    else source = await resolveDesignSource({ projectDir, ask, log, errorLog, pencilRoot });
  } else if (source === null) {
    source = await resolveDesignSource({ projectDir, ask, log, errorLog, pencilRoot });
  }
  if (source === "cancelled") return 2;

  let device = options.device ?? null;
  let noRun = options.noRun === true;
  if (!noRun && device === null) {
    const devices = await deps.listDevices();
    if (devices.length === 1) {
      const answer = (await ask(`⑤ 连设备执行测试吗？设备：${devices[0]}（回车=跑 / n=先不跑）`)).trim().toLowerCase();
      device = answer === "n" ? null : devices[0];
    } else if (devices.length > 1) {
      const lines = devices.map((serial, index) => `   ${index + 1}) ${serial}`).join("\n");
      const answer = (await ask(`⑤ 发现 ${devices.length} 台设备：\n${lines}\n   用哪台？（回车=先不跑 / 输入编号）`)).trim();
      const index = Number.parseInt(answer, 10);
      device = Number.isInteger(index) && index >= 1 && index <= devices.length ? devices[index - 1] : null;
    } else {
      log("⑤ 没发现已连接的 Android 设备——本次先只到校验；之后可手动跑（命令见下）。");
    }
    if (device === null) noRun = true;
  }

  log("");
  const code = await runPipeline({ options: { source, projectDir, device, noRun, noCheck: false }, deps, log, errorLog });
  if (code === 0) log(noRun ? "✅ 完成：用例已生成并通过校验。" : "✅ 完成：用例已生成、校验通过、测试已执行。");
  else if (code === 1) log("⚠️ 测试执行有失败——看上面的用例结果与 .artemis/traces 轨迹。");
  else log("✗ 中途出错——按上面的提示处理后，重跑同一条命令即可。");
  return code;
}

export function normalizeInputTarget(input) {
  let value = String(input ?? "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\\ /g, " ");
}

async function resolveDesignSource({ projectDir, ask, log, errorLog, pencilRoot }) {
  const candidates = findDesignCandidates({ projectDir, ...(pencilRoot ? { pencilRoot } : {}) });
  if (candidates.length === 0) {
    const answer = normalizeInputTarget(
      await ask("没找到 .pen 设计文件。粘贴 Figma 链接（http 开头），或把 .pen 文件拖进来（自动变成路径）：")
    );
    if (answer === "") {
      errorLog("没有设计来源，没法继续。");
      return "cancelled";
    }
    return answer.startsWith("http") ? { kind: "figma", url: answer } : { kind: "pen", penPath: answer };
  }
  const lines = candidates.map((entry, index) => `   ${index + 1}) ${entry.label}`).join("\n");
  const answer = normalizeInputTarget(
    await ask(`发现 ${candidates.length} 个设计文件，用哪个？\n${lines}\n（回车=1 / 或粘贴 Figma 链接 / 或直接拖入 .pen 文件）`)
  );
  if (answer.startsWith("http")) return { kind: "figma", url: answer };
  const index = answer === "" ? 1 : Number.parseInt(answer, 10);
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
    errorLog("没看懂选择；按默认取第 1 个。");
    return { kind: "pen", penPath: candidates[0].path };
  }
  return { kind: "pen", penPath: candidates[index - 1].path };
}

export async function runPipeline({ options, deps, log, errorLog }) {
  const { source = null, projectDir, device, noRun, noCheck } = options;

  if (source !== null) {
    const extractName = source.kind === "figma" ? "figma_extract_flows" : "pen_extract_flows";
    const extractArgs =
      source.kind === "figma"
        ? { url: source.url, ...(source.nodeId ? { nodeId: source.nodeId } : {}) }
        : { penPath: source.penPath, ...(source.vision ? { vision: source.vision } : {}) };
    let flows;
    try {
      flows = await deps.callTool(extractName, extractArgs);
    } catch (error) {
      errorLog(`✗ ① 读设计图失败: ${message(error)}`);
      return 2;
    }
    if (!flows || flows.ok === false) {
      errorLog(`✗ ① 读设计图失败: ${flows?.error ?? "无响应"}`);
      return 2;
    }
    log(
      `① 设计图: ${flows.counts?.screens ?? "?"} 屏 / ${flows.counts?.edges ?? "?"} 个跳转，入口 [${(flows.entryScreens ?? []).join(", ")}]`
    );
  } else {
    log("① 设计图: 复用已有 flows.json（如需重读，加 r 重跑）");
  }

  let tests;
  try {
    tests = await deps.callTool("figma_generate_tests", {});
  } catch (error) {
    errorLog(`✗ ③ 生成用例失败: ${message(error)}`);
    return 2;
  }
  if (!tests || tests.ok === false) {
    errorLog(`✗ ③ 生成用例失败: ${tests?.error ?? "无响应"}`);
    return 2;
  }
  const hardGaps = tests.coverage
    ? (tests.coverage.uncoveredScreens?.length ?? 0) + (tests.coverage.uncoveredEdges?.length ?? 0)
    : null;
  log(
    `③ 用例: ${tests.counts?.flows ?? "?"} 条${hardGaps !== null ? `（硬覆盖缺口 ${hardGaps}）` : ""}${tests.savedTo?.markdown ? ` → ${tests.savedTo.markdown}` : ""}`
  );

  if (!noCheck) {
    const checkCode = await deps.runCli(["suite", "check", "--project", projectDir]);
    if (checkCode !== 0) {
      errorLog("✗ ④ 校验没通过；按上面提示修正后重跑（或加 --no-check 跳过）。");
      return 2;
    }
    log("④ 校验: 通过");
  } else {
    log("④ 校验: 跳过（--no-check）");
  }

  if (noRun || device === null) {
    log(noRun ? "⑤ 执行: 本次不跑。以后想跑：" : "⑤ 执行: 没给设备，先不跑。以后想跑：");
    log(`   node dist/cli.js suite run --project "${projectDir}" --device <设备号>`);
    return 0;
  }
  const runCode = await deps.runCli(["suite", "run", "--project", projectDir, "--device", device]);
  log(`⑤ 执行: exit ${runCode}`);
  return runCode === 0 ? 0 : runCode === 2 ? 2 : 1;
}

function usage() {
  console.log(`设计→测试 一条链：读设计图 → 懂交互 → 出用例 → 做校验 → 跑测试

最简单用法（推荐）：
  cd <项目目录>
  node <服务仓库>/scripts/design-to-test.mjs
  它会自己认项目、自己找设计文件、问两三个问题，然后把五步串完。

高级用法（指定来源/设备）：
  node scripts/design-to-test.mjs --figma "<url>" [--node-id <id>] --project <dir> [--device <serial>] [--no-run]
  node scripts/design-to-test.mjs --pen "<路径.pen>" [--vision auto|true|false] --project <dir> [--device <serial>] [--no-run]

说明:
  ①+② 提取设计流程（Figma 原型连线最准；pen 无交互数据时画板推断，--vision 可做交互元素识别）
  ③ figma_generate_tests 落三件套（tests.json/md/xlsx + case-sets）
  ④ suite check 静态校验（三件套/真实数据/覆盖硬门禁，不连设备）
  ⑤ 传 --device 或确认设备后执行 suite run

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

  let clientPromise = null;
  const ensureClient = async () => {
    if (clientPromise === null) {
      clientPromise = (async () => {
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
        return client;
      })();
    }
    return clientPromise;
  };
  const deps = {
    callTool: async (name, toolArgs) => {
      const client = await ensureClient();
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
    },
    listDevices: async () => listAdbDevices()
  };

  try {
    if (options.simple === true) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await runSimpleMode({
          projectDir: options.projectDir,
          options,
          deps,
          ask: (question) => rl.question(`${question} `),
          log: console.log,
          errorLog: console.error
        });
      } finally {
        rl.close();
      }
    }
    console.log(`项目: ${options.projectDir}`);
    return await runPipeline({ options, deps, log: console.log, errorLog: console.error });
  } finally {
    if (clientPromise !== null) {
      const client = await clientPromise;
      await client.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
