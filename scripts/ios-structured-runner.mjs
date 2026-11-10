#!/usr/bin/env node
/**
 * 最小 iOS 结构化动作 runner（Phase 2 原型）。
 *
 * 读取 Phase 1 tests.json 的 actions[]，在 iOS 模拟器/真机上按步执行：
 * 目标解析 → tap/type/wait → AX 稳定观测 → expect 断言。
 * 不调用 LLM。
 *
 * 示例：
 *   node scripts/ios-structured-runner.mjs \
 *     --project /Users/louis/Documents/AOS/ESSO-GU \
 *     --case TC_000001 \
 *     --device <simulator-udid> \
 *     --json
 */
import path from "node:path";
import process from "node:process";

import { defaultBuildRuntime } from "../dist/cli-runtime.js";
import { loadGeneratedCases, resolveCaseSelector } from "../dist/figma/design-store.js";
import { runStructuredIosCase } from "../dist/ios/structured-runner.js";
import { loadWebSecrets } from "../dist/web/llm/secrets.js";

function parseArgs(argv) {
  const args = {
    project: "",
    tests: "",
    case: "",
    device: "",
    stepTimeoutMs: undefined,
    pollMs: undefined,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      return argv[index] ?? "";
    };
    switch (token) {
      case "--project":
        args.project = next();
        break;
      case "--tests":
        args.tests = next();
        break;
      case "--case":
        args.case = next();
        break;
      case "--device":
        args.device = next();
        break;
      case "--step-timeout-ms":
        args.stepTimeoutMs = Number(next());
        break;
      case "--poll-ms":
        args.pollMs = Number(next());
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${token}`);
    }
  }
  if (!args.project) throw new Error("缺少 --project <dir>");
  if (!args.case) throw new Error("缺少 --case <caseId|semanticId|displayId>");
  if (!args.device) throw new Error("缺少 --device <simulator-udid>");
  return args;
}

function printHelp() {
  console.log(`最小 iOS 结构化动作 runner

必填：
  --project <dir>            项目根目录
  --case <id>                caseId / semanticId / displayId
  --device <udid>            iOS 模拟器 UDID 或真机 UDID（真机需 Appium/WDA 配置）
可选：
  --tests <path>             tests.json 路径（默认 <project>/.artemis/design/tests.json）
  --step-timeout-ms <n>      单步观测超时（默认 8000）
  --poll-ms <n>              观测轮询间隔（默认 150）
  --json                     JSON 输出
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDirAbs = path.join(path.resolve(args.project), ".artemis");
  const cases = loadGeneratedCases(
    configDirAbs,
    args.tests ? { testsPath: path.resolve(args.tests) } : {}
  );
  if (cases === null) {
    console.error(`无法读取 tests.json（${args.tests || path.join(configDirAbs, "design", "tests.json")}）`);
    process.exit(2);
  }
  const resolved = resolveCaseSelector(args.case, cases);
  if (!resolved.ok) {
    console.error(
      resolved.reason === "ambiguous"
        ? `用例选择器歧义：${args.case}（候选 ${resolved.candidates.join("、")}）`
        : `未找到用例：${args.case}`
    );
    process.exit(2);
  }
  const testCase = cases.find((entry) => entry.id === resolved.caseId);
  if (!testCase) {
    console.error(`未找到用例：${resolved.caseId}`);
    process.exit(2);
  }
  if (testCase.engine !== "native" || testCase.actions.length === 0) {
    console.error(
      `用例 ${testCase.id} 不是 native 结构化用例（engine=${testCase.engine ?? "null"}，actions=${testCase.actions.length}${testCase.engineReason ? `，reason=${testCase.engineReason}` : ""}）`
    );
    process.exit(2);
  }

  const bundle = await defaultBuildRuntime(path.resolve(args.project));
  let exitCode;
  try {
    const device = await bundle.runtime.iosDevice(args.device);
    if (device === null) {
      console.error(`iOS 设备不可用：${args.device}`);
      exitCode = 2;
    } else {
      const secrets = await loadWebSecrets({
        store: bundle.runtime.store,
        rootPath: bundle.runtime.project.rootDir,
        env: process.env
      }).catch(() => []);
      const resolveSecret = (ref) =>
        secrets.find((entry) => entry.alias.toLowerCase() === ref.toLowerCase())?.value ?? null;
      const result = await runStructuredIosCase({
        device,
        actions: testCase.actions,
        resolveSecret,
        ...(Number.isFinite(args.stepTimeoutMs) && args.stepTimeoutMs > 0
          ? { stepTimeoutMs: args.stepTimeoutMs }
          : {}),
        ...(Number.isFinite(args.pollMs) && args.pollMs > 0 ? { pollMs: args.pollMs } : {})
      });
      const payload = {
        caseId: testCase.id,
        name: testCase.name,
        engine: testCase.engine,
        status: result.status,
        steps: result.steps,
        ...(result.error === undefined ? {} : { error: result.error })
      };
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`case: ${payload.caseId} ${payload.name}`);
        for (const step of result.steps) {
          console.log(
            `[${step.status}] step ${step.index} ${step.action}${step.resolvedBy ? ` (${step.resolvedBy})` : ""}${step.error ? ` · ${step.error}` : ""}`
          );
        }
        console.log(`status: ${result.status}`);
      }
      exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
    }
  } finally {
    await bundle.dispose();
  }
  process.exit(exitCode ?? 2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
