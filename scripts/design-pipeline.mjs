#!/usr/bin/env node
/**
 * One-shot design pipeline: Figma URL → flows → gaps → tests → assets → brief.
 *
 *   node scripts/design-pipeline.mjs "<figma-url>" [--import] [--scaffold] [--project <dir>]
 *
 * Requires FIGMA_ACCESS_TOKEN (project .env or aos_configure). Without it the
 * first step fails with guidance.
 * Exit codes: 0 ok, 2 setup/token issue, 3 usage/infra error.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const argv = process.argv.slice(2);
const url = argv.find((arg) => !arg.startsWith("--"));
if (!url) {
  console.error('用法: node scripts/design-pipeline.mjs "<figma-url>" [--import] [--scaffold] [--project <dir>]');
  process.exit(3);
}
const projectIndex = argv.indexOf("--project");
const projectDir =
  projectIndex >= 0 && argv[projectIndex + 1]
    ? path.resolve(argv[projectIndex + 1])
    : (process.env.AOS_PROJECT_DIR ?? repoRoot);
const doImport = argv.includes("--import");
const doScaffold = argv.includes("--scaffold");

const parse = (result) => {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
};

const client = new Client({ name: "design-pipeline", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: { ...process.env, AOS_PROJECT_DIR: projectDir }
  })
);

const call = async (name, toolArgs) => {
  const result = await client.callTool({ name, arguments: toolArgs });
  const payload = parse(result);
  if (result.isError === true || (payload && payload.ok === false)) {
    console.error(`✗ ${name}:`, payload?.error ?? payload?.message ?? "unknown error");
    if (payload?.hint) console.error("  ", payload.hint);
    await client.close();
    process.exit(2);
  }
  return payload;
};

try {
  console.log(`项目: ${projectDir}`);

  const flows = await call("figma_extract_flows", { url });
  console.log(
    `① 流程: screens=${flows.counts.screens} edges=${flows.counts.edges} entries=[${flows.entryScreens.join(", ")}] unresolved=${flows.counts.unresolved}`
  );

  const gaps = await call("figma_gap_analysis", { url });
  console.log(
    `② 缺口: 栈=${gaps.detectedStacks?.[0]?.id ?? "未检测"} 缺失资源=${gaps.summary.missingAssets} 缺失色值=${gaps.summary.missingColors}${gaps.savedTo ? ` → ${gaps.savedTo}` : ""}`
  );

  const tests = await call("figma_generate_tests", { requireFullCoverage: true });
  console.log(
    `③ 测试: ${tests.counts.flows} 条用例${tests.savedTo ? ` → ${tests.savedTo.markdown}` : ""}`
  );
  if (tests.flows?.[0]) {
    console.log(
      `   示例: ${tests.flows[0].taskDesc.split("\n").slice(0, 2).join(" / ").slice(0, 150)}`
    );
  }

  const imported = await call("figma_import_assets", { url, dryRun: !doImport });
  console.log(`④ 资源(${doImport ? "写入" : "dryRun 预览"}): ${JSON.stringify(imported.counts)}`);
  if (!doImport) console.log("   正式导入请加 --import");
  else if (imported.savedTo) console.log(`   → ${imported.savedTo}`);

  const brief = await call("figma_export_brief", { url, scaffold: doScaffold });
  console.log(
    `⑤ 简报: ${brief.summary.screens} 屏 / ${brief.summary.components} 组件 / 栈=${brief.summary.stack ?? "-"}${brief.savedTo ? ` → ${brief.savedTo.markdown}` : ""}`
  );
  if (doScaffold && brief.scaffold) {
    console.log(`   组件骨架: ${brief.scaffold.count} 个（同内容跳过）`);
  }

  console.log("\n下一步：用 mobile_run_task 执行 tests.json 里的 flows[i].taskDesc");
} finally {
  await client.close();
}
