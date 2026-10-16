#!/usr/bin/env node
// 巡检各项目 .artemis/design 的用例产物是否满足三件套与真实数据硬门禁。
// 口径与 `suite check` 完全一致：逐项目调用 `node dist/cli.js suite check --project <dir> --json`。
//
// 用法: node scripts/audit-legacy-tests.mjs [--json] [--help] <项目根或工作区目录> [...]
//   - 参数本身是项目（含 aos.config.jsonc/.artemis/.env）→ 直接巡检；
//     否则扫描其一级子目录寻找项目。
//   - md-only 识别基于默认 configDir（.artemis）；自定义 artemis.configDir 的项目请直传项目根。
// 退出码: 0=全部通过/无可巡检项；1=存在需处理的遗留项；2=用法错误/未发现项目/CLI 未构建。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function usage() {
  console.log(`用例产物巡检（口径 = suite check 三件套/真实数据/覆盖硬门禁）

用法:
  node scripts/audit-legacy-tests.mjs [--json] <项目根或工作区目录> [...]

说明:
  - 目录本身是项目 → 直接巡检；否则扫描其一级子目录寻找项目（工作区用法）。
  - md-only 识别基于默认 configDir（.artemis）。
  - 重生成 = 在对应项目内重跑 MCP 工具 figma_generate_tests（save 默认写三件套 + 【真实数据】条款）。

退出码: 0=全部通过/无可巡检项；1=存在需处理的遗留项；2=用法错误/未发现项目/CLI 未构建。`);
}

function isProjectDir(dir) {
  return (
    fs.existsSync(path.join(dir, "aos.config.jsonc")) ||
    fs.existsSync(path.join(dir, ".artemis")) ||
    fs.existsSync(path.join(dir, ".env"))
  );
}

function discover(inputs) {
  const found = [];
  const seen = new Set();
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) {
      console.error(`路径不存在：${input}`);
      process.exit(2);
    }
    const candidates = isProjectDir(abs)
      ? [abs]
      : fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => path.join(abs, entry.name))
          .filter(isProjectDir);
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
  }
  return found;
}

function categoriesOf(issue) {
  const categories = [];
  if (/缺少配套 tests\.xlsx/.test(issue)) categories.push("缺 tests.xlsx");
  if (/tests\.xlsx 早于 tests\.json/.test(issue)) categories.push("tests.xlsx 过期（早于 tests.json）");
  if (/缺少真实数据约束/.test(issue)) categories.push("缺【真实数据】标记");
  if (/流程未完整覆盖/.test(issue)) categories.push("流程覆盖不完整");
  if (/流程覆盖校验不可用|缺 flows\.json/.test(issue)) categories.push("缺 flows.json（无法判定覆盖）");
  if (categories.length === 0) categories.push(`其他：${String(issue).slice(0, 80)}`);
  return categories;
}

function parseJsonLoose(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function classify(dir) {
  const designDir = path.join(dir, ".artemis", "design");
  const hasJson = fs.existsSync(path.join(designDir, "tests.json"));
  const hasMd = fs.existsSync(path.join(designDir, "tests.md"));
  if (!hasJson) {
    if (hasMd) {
      return { dir, status: "needs-work", categories: ["md-only（无 tests.json）"], cases: null, checkExit: null };
    }
    return { dir, status: "skipped", categories: [], cases: null, checkExit: null };
  }

  const run = spawnSync(process.execPath, [cliPath, "suite", "check", "--project", dir, "--json"], {
    encoding: "utf-8",
    cwd: repoRoot,
    timeout: 60_000
  });
  const data = parseJsonLoose(run.stdout);
  if (data === null) {
    const detail = String(run.stderr || run.stdout || "无输出").trim().slice(0, 200);
    return {
      dir,
      status: "needs-work",
      categories: [`check 执行异常（exit ${run.status ?? "?"}）`],
      cases: null,
      checkExit: run.status ?? null,
      issue: detail
    };
  }
  if (data.ok === true) {
    return { dir, status: "pass", categories: [], cases: typeof data.cases === "number" ? data.cases : null, checkExit: run.status ?? null };
  }
  if (typeof data.error === "string" && data.error !== "") {
    return {
      dir,
      status: "needs-work",
      categories: [`用例文件不可读：${data.error.slice(0, 120)}`],
      cases: null,
      checkExit: run.status ?? null
    };
  }
  return {
    dir,
    status: "needs-work",
    categories: categoriesOf(data.issue),
    cases: typeof data.cases === "number" ? data.cases : null,
    checkExit: run.status ?? null,
    issue: typeof data.issue === "string" ? data.issue : null
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }
  const json = args.includes("--json");
  const inputs = args.filter((arg) => arg !== "--json");
  if (inputs.length === 0) {
    usage();
    return 2;
  }
  if (!fs.existsSync(cliPath)) {
    console.error(`CLI 未构建：缺少 ${cliPath}（请先在服务仓库运行 npm run build）`);
    return 2;
  }

  const projects = discover(inputs);
  if (projects.length === 0) {
    console.error("未发现项目（目录本身或一级子目录需含 aos.config.jsonc/.artemis/.env）");
    return 2;
  }

  const results = projects.map(classify);
  const pass = results.filter((entry) => entry.status === "pass").length;
  const needsWork = results.filter((entry) => entry.status === "needs-work").length;
  const skipped = results.filter((entry) => entry.status === "skipped").length;
  const ok = needsWork === 0;

  if (json) {
    console.log(
      JSON.stringify(
        { ok, scanned: results.length, pass, needsWork, skipped, projects: results },
        null,
        2
      )
    );
  } else {
    console.log("用例产物巡检（口径 = suite check：三件套 / 真实数据 / 流程覆盖硬门禁）");
    console.log(`扫描 ${results.length} 个项目：通过 ${pass} · 需处理 ${needsWork} · 跳过 ${skipped}`);
    console.log("");
    for (const entry of results.filter((item) => item.status === "needs-work")) {
      console.log(`[需处理] ${entry.dir}`);
      console.log(`         问题: ${entry.categories.join("；")}`);
      console.log(`         复核: node dist/cli.js suite check --project "${entry.dir}"`);
    }
    for (const entry of results.filter((item) => item.status === "pass")) {
      console.log(`[通过]   ${entry.dir}${entry.cases !== null ? `（用例 ${entry.cases}）` : ""}`);
    }
    if (needsWork > 0) {
      console.log("");
      console.log("重生成 = 在对应项目内重跑 MCP 工具 figma_generate_tests（save 默认写三件套 + 【真实数据】条款）。");
    }
  }
  return ok ? 0 : 1;
}

process.exitCode = main();
