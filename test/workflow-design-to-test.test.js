import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { designToTest, runnerInventoryEnv } from "../dist/workflow/design-to-test.js";
import { collectRunnerInventory } from "../dist/runner/inventory.js";

const LLM_ENTRY = {
  name: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-key"
};

const FIGMA_URL = "https://www.figma.com/file/AbC123/App";
const NO_FLOWS_QUESTION = "还没有设计流程——给 Figma 链接或 .pen 路径，或先跑一次设计提取";

let dirCounter = 0;

function tempPath() {
  dirCounter += 1;
  return path.join(os.tmpdir(), `aos-design-to-test-${process.pid}-${dirCounter}`);
}

function stubRuntime({ dir = tempPath(), dotenv = {} } = {}) {
  return {
    configDirAbs: dir,
    project: { rootDir: dir, dotenvValues: dotenv },
    async activeEntry() {
      return LLM_ENTRY;
    }
  };
}

function textResult(payload, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function withoutMs(step) {
  const { ms, ...rest } = step;
  assert.equal(typeof ms, "number", "step.ms 为实测数字");
  assert.ok(ms >= 0, "step.ms ≥ 0");
  return rest;
}

async function withFigmaToken(value, fn) {
  const previous = process.env.FIGMA_ACCESS_TOKEN;
  if (value === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
  else process.env.FIGMA_ACCESS_TOKEN = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = previous;
  }
}

function caseStub(caseId, traceId) {
  return {
    caseId,
    name: `用例 ${caseId}`,
    status: "passed",
    traceId,
    error: null,
    testSummary: null,
    failure: null,
    scriptProvenance: null,
    apiErrors: [],
    apiErrorsDegraded: null,
    evidence: { notesDir: null, stderrLog: null, stdoutLog: null },
    reset: null
  };
}

function failedCaseStub(caseId, traceId, overrides = {}) {
  return {
    ...caseStub(caseId, traceId),
    status: "failed",
    error: "known failure",
    ...overrides
  };
}

function reportStub(options) {
  return {
    ok: true,
    testsPath: options.testsPath,
    total: 2,
    executed: 2,
    skipped: 0,
    passed: 2,
    failed: 0,
    preflight: null,
    apiErrorCatalog: null,
    cases: [caseStub("F-1", "trace-a"), caseStub("F-2", "trace-b")]
  };
}

function makeDeps(overrides = {}) {
  const calls = { figma: [], pen: [], generate: [], list: 0, execute: [] };
  const designDirOf = (runtime) => path.join(runtime.configDirAbs, "design");
  const deps = {
    extractFigma: async (runtime, args) => {
      calls.figma.push(args);
      return textResult({
        ok: true,
        counts: { screens: 2, edges: 1 },
        savedTo: { json: path.join(designDirOf(runtime), "flows.json") }
      });
    },
    extractPen: async (runtime, args) => {
      calls.pen.push(args);
      return textResult({
        ok: true,
        counts: { screens: 3, edges: 2 },
        savedTo: { json: path.join(designDirOf(runtime), "flows.json") }
      });
    },
    generate: async (runtime, args) => {
      calls.generate.push(args);
      const dir = designDirOf(runtime);
      return textResult({
        ok: true,
        source: path.join(dir, "flows.json"),
        counts: { flows: 2, screens: 2, edges: 1 },
        savedTo: {
          json: path.join(dir, "tests.json"),
          markdown: path.join(dir, "tests.md"),
          xlsx: path.join(dir, "tests.xlsx")
        }
      });
    },
    gate: () => null,
    listDevices: async () => {
      calls.list += 1;
      return [];
    },
    execute: async (runtime, options) => {
      calls.execute.push(options);
      return reportStub(options);
    },
    setup: { chat: async () => "pong" },
    ...overrides
  };
  return { deps, calls };
}

test("figma happy：提取→生成→校验→nextAction（run 缺省 false）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, nodeId: "1:2" }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.deepEqual(calls.figma, [{ url: FIGMA_URL, nodeId: "1:2" }]);
  assert.equal(calls.pen.length, 0);
  assert.equal(calls.generate.length, 1);
  assert.deepEqual(calls.generate[0], {});
  assert.equal(calls.execute.length, 0);

  assert.equal(payload.steps.length, 3);
  assert.deepEqual(withoutMs(payload.steps[0]), { step: "extract", source: "figma", screens: 2, edges: 1, warnings: 0 });
  assert.deepEqual(withoutMs(payload.steps[1]), { step: "generate", cases: 2, screens: 2, edges: 1 });
  assert.deepEqual(withoutMs(payload.steps[2]), { step: "check", ok: true });

  assert.equal(payload.artifacts.tests, path.join(runtime.configDirAbs, "design", "tests.json"));
  assert.equal(payload.artifacts.flows, undefined);
  assert.deepEqual(payload.artifacts.savedTo, {
    json: path.join(runtime.configDirAbs, "design", "tests.json"),
    markdown: path.join(runtime.configDirAbs, "design", "tests.md"),
    xlsx: path.join(runtime.configDirAbs, "design", "tests.xlsx")
  });
  assert.deepEqual(payload.nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true }
  });
  assert.equal(payload.run, undefined);
});

test("pen happy：vision 透传（前置 pen 检查走 stub exec）", async () => {
  const runtime = stubRuntime();
  const penExecCalls = [];
  const { deps, calls } = makeDeps({
    setup: {
      chat: async () => "pong",
      exec: async (command, args) => {
        penExecCalls.push({ command, args });
        return { code: 0, stdout: "● Active\n", stderr: "" };
      },
      env: { AOS_PEN_CLI_PATH: "/opt/pen" }
    }
  });
  const result = await designToTest(runtime, { penPath: "/designs/app.pen", vision: "auto" }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.deepEqual(calls.pen, [{ path: "/designs/app.pen", vision: "auto" }]);
  assert.equal(calls.figma.length, 0);
  assert.deepEqual(penExecCalls, [{ command: "/opt/pen", args: ["status"] }]);
  assert.deepEqual(withoutMs(payload.steps[0]), { step: "extract", source: "pen", screens: 3, edges: 2, warnings: 0 });
  assert.deepEqual(payload.nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true }
  });
});

test("生成透传 maxFlows/maxDepth：显式提供的键原样传给 figma_generate_tests", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, maxFlows: 50, maxDepth: 12 },
    deps
  );

  assert.ok(!result.isError);
  assert.equal(payloadOf(result).ok, true);
  assert.deepEqual(calls.generate, [{ maxFlows: 50, maxDepth: 12 }]);
  assert.deepEqual(payloadOf(result).nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true, maxFlows: 50, maxDepth: 12 }
  });
});

test("生成透传仅带显式提供的键：未给 maxDepth 时不出现该键", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, maxFlows: 50 }, deps);

  assert.ok(!result.isError);
  assert.deepEqual(calls.generate, [{ maxFlows: 50 }]);
  assert.deepEqual(payloadOf(result).nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true, maxFlows: 50 }
  });
});

test("生成透传仅带 maxDepth 时：生成与 nextAction 都只携带 maxDepth", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, maxDepth: 12 }, deps);

  assert.ok(!result.isError);
  assert.equal(payloadOf(result).ok, true);
  assert.deepEqual(calls.generate, [{ maxDepth: 12 }]);
  assert.deepEqual(payloadOf(result).nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true, maxDepth: 12 }
  });
});

test("参数冲突/全缺 → isError 用法错误（不触提取/生成）", async () => {
  const runtime = stubRuntime();
  const { deps, calls } = makeDeps();
  const cases = [
    [{ figmaUrl: FIGMA_URL, penPath: "/designs/app.pen" }, "figmaUrl 与 penPath"],
    [{}, "缺少设计来源"],
    [{ penPath: "/designs/app.pen", nodeId: "1:2" }, "nodeId"],
    [{ figmaUrl: FIGMA_URL, vision: true }, "vision"]
  ];
  for (const [args, fragment] of cases) {
    const result = await designToTest(runtime, args, deps);
    assert.equal(result.isError, true, JSON.stringify(args));
    const payload = payloadOf(result);
    assert.equal(payload.ok, false);
    assert.ok(payload.error.includes("用法错误"), payload.error);
    assert.ok(payload.error.includes(fragment), payload.error);
  }
  assert.equal(calls.figma.length + calls.pen.length + calls.generate.length, 0);
});

test("figma 缺 token → needs-setup（非 isError；不提取/不生成）", async () => {
  await withFigmaToken(undefined, async () => {
    const runtime = stubRuntime();
    const { deps, calls } = makeDeps();
    const result = await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps);

    assert.ok(!result.isError);
    const payload = payloadOf(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.needs, "setup");
    assert.equal(payload.checks.length, 1);
    assert.equal(payload.checks[0].target, "figma");
    assert.deepEqual(payload.checks[0].missing, ["FIGMA_ACCESS_TOKEN"]);
    assert.ok(payload.checks[0].howTo.join("\n").includes("aos_configure"));
    assert.equal(calls.figma.length, 0);
    assert.equal(calls.generate.length, 0);
    assert.equal(calls.execute.length, 0);
  });
});

test("llm ping 失败 → needs-setup（checks 含 llm；不提取）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps({
    setup: {
      chat: async () => {
        throw new Error("socket hang up");
      }
    }
  });
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.needs, "setup");
  const llmCheck = payload.checks.find((check) => check.target === "llm");
  assert.ok(llmCheck, JSON.stringify(payload.checks));
  assert.ok(llmCheck.note.includes("socket hang up"));
  assert.equal(calls.figma.length, 0);
  assert.equal(calls.generate.length, 0);
});

test("reuseExistingFlows 无 flows.json → needs-info（问句逐字）", async () => {
  const runtime = stubRuntime();
  const { deps, calls } = makeDeps();
  const result = await designToTest(runtime, { reuseExistingFlows: true }, deps);

  assert.ok(!result.isError);
  assert.deepEqual(payloadOf(result), {
    ok: false,
    needs: "info",
    category: "no-flows",
    questions: [NO_FLOWS_QUESTION]
  });
  assert.equal(calls.figma.length + calls.pen.length + calls.generate.length, 0);
});

test("reuseExistingFlows 有 flows.json → 跳过提取（steps 标 reused）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-design-to-test-reuse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const designDir = path.join(dir, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        { id: "s1", name: "首页", childNames: [], textHints: [] },
        { id: "s2", name: "详情", childNames: [], textHints: [] }
      ],
      edges: [],
      entryScreens: ["首页"],
      unresolvedDestinations: []
    })
  );

  const runtime = stubRuntime({ dir });
  const { deps, calls } = makeDeps();
  const result = await designToTest(runtime, { reuseExistingFlows: true }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(calls.figma.length + calls.pen.length, 0);
  assert.deepEqual(withoutMs(payload.steps[0]), { step: "extract", reused: true, screens: 2, edges: 0, warnings: 0 });
  assert.equal(payload.artifacts.flows, path.join(designDir, "flows.json"));
  assert.equal(payload.nextAction.args.reuseExistingFlows, true);
});

test("提取失败 → failedStep:extract（detail 透传 + 建议）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  deps.extractFigma = async (runtime_, args) => {
    calls.figma.push(args);
    return textResult({ ok: false, error: "流程图解析失败: 401 Unauthorized" }, true);
  };
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "extract");
  assert.ok(payload.detail.includes("401 Unauthorized"));
  assert.ok(Array.isArray(payload.suggestions) && payload.suggestions.length > 0);
  assert.equal(calls.generate.length, 0);
});

test("gate 失败 → failedStep:check（detail + 修正建议）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const gateCalls = [];
  const { deps, calls } = makeDeps({
    gate: (preflight) => {
      gateCalls.push(preflight);
      return "流程未完整覆盖：未硬覆盖屏幕 1";
    }
  });
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "check");
  assert.equal(payload.detail, "流程未完整覆盖：未硬覆盖屏幕 1");
  assert.deepEqual(payload.suggestions, ["按提示用 figma_generate_tests 修正后重跑；路径被截断时可用 maxFlows/maxDepth 加大上限重试"]);
  assert.equal(gateCalls.length, 1);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.execute.length, 0);
});

test("run:true 无设备 → needs-setup(device)（howTo 含 adb-safe devices/doctor）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, run: true }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "setup");
  assert.equal(payload.checks.length, 1);
  assert.equal(payload.checks[0].target, "device");
  const howTo = payload.checks[0].howTo.join("\n");
  assert.ok(howTo.includes("scripts/adb-safe.mjs devices"));
  assert.ok(howTo.includes("doctor"));
  assert.equal(calls.list, 1);
  assert.equal(calls.execute.length, 0);
});

test("run:true 多设备 → needs-info（候选列表，不执行）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  deps.listDevices = async () => {
    calls.list += 1;
    return [
      { serial: "emulator-5554", platform: "android" },
      { serial: "00008110-000C1234", platform: "ios" }
    ];
  };
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, run: true }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "info");
  assert.equal(payload.category, "device-ambiguous");
  assert.ok(payload.questions[0].includes("2"));
  assert.ok(payload.context.some((line) => line.includes("emulator-5554")));
  assert.ok(payload.context.some((line) => line.includes("00008110-000C1234")));
  assert.equal(calls.execute.length, 0);
});

test("run:true 唯一在线设备自动选用并回显", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  deps.listDevices = async () => {
    calls.list += 1;
    return [{ serial: "emulator-5554", platform: "android" }];
  };
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, run: true }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  const runStep = payload.steps.find((step) => step.step === "run");
  assert.equal(runStep.device, "emulator-5554");
  assert.equal(calls.execute[0].deviceSerial, "emulator-5554");
  assert.equal(calls.list, 1);
});

test("run:true happy → steps 回显 run（cases/source/device）+ execute 收到正确 options", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, run: true, device: "emulator-5554" },
    deps
  );

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(calls.list, 0, "显式 device 不盘点设备");

  const runStep = payload.steps.find((step) => step.step === "run");
  assert.deepEqual(withoutMs(runStep), {
    step: "run",
    cases: 2,
    source: path.join(runtime.configDirAbs, "design", "flows.json"),
    device: "emulator-5554"
  });

  assert.equal(calls.execute.length, 1);
  const options = calls.execute[0];
  assert.equal(options.testsPath, path.join(runtime.configDirAbs, "design", "tests.json"));
  assert.equal(options.deviceSerial, "emulator-5554");
  assert.equal(options.apiErrors, true);
  assert.equal(options.failOnApiErrors, false);
  assert.equal(options.stopOnFailure, false);

  assert.equal(payload.run.device, "emulator-5554");
  assert.equal(payload.run.total, 2);
  assert.equal(payload.run.executed, 2);
  assert.equal(payload.run.passed, 2);
  assert.equal(payload.run.failed, 0);
  assert.equal(payload.run.ok, true);
  assert.equal(payload.run.gate, "passed");
  assert.deepEqual(payload.run.traceIds, ["trace-a", "trace-b"]);
  assert.equal(payload.nextAction, undefined);
});

test("run 缺省时 nextAction 回显 device", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps();
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, device: "emulator-5554" }, deps);

  const payload = payloadOf(result);
  assert.deepEqual(payload.nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true, device: "emulator-5554" }
  });
});

test("run:true 走共享批次执行：写批次清单 + 登记 + quarantine 不计门禁", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-design-to-test-batch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const designDir = path.join(dir, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "quarantine.json"),
    JSON.stringify({
      entries: [
        {
          caseId: "F-1",
          owner: "alice",
          signedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    })
  );

  const runtime = stubRuntime({ dir, dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const recorded = [];
  runtime.store = {
    recordSuiteRun: async (input) => {
      recorded.push(input);
      return { id: "run-db-1" };
    }
  };
  const { deps, calls } = makeDeps();
  deps.execute = async (runtime_, options) => {
    calls.execute.push(options);
    return {
      ...reportStub(options),
      passed: 1,
      failed: 1,
      cases: [caseStub("F-2", "trace-b"), failedCaseStub("F-1", "trace-a", { quarantined: true })]
    };
  };

  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, run: true, device: "emulator-5554" },
    deps
  );

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.run.failed, 1);
  assert.equal(payload.run.gate, "passed", "隔离失败不计门禁");
  assert.equal(calls.execute[0].quarantinedCaseIds instanceof Set, true);
  assert.equal(calls.execute[0].quarantinedCaseIds.has("F-1"), true);

  const runsDir = path.join(designDir, "runs");
  const files = fs.readdirSync(runsDir).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  const manifestPath = path.join(runsDir, files[0]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  assert.equal(manifest.source, "design_to_test");
  assert.equal(manifest.summary.quarantinedFailed, 1);
  assert.deepEqual(manifest.options.quarantinedCaseIds, ["F-1"]);
  assert.equal(payload.artifacts.runManifest, manifestPath);

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].run.trigger, "design_to_test");
  assert.equal(recorded[0].run.device, "emulator-5554");
  assert.equal(recorded[0].cases[1].quarantined, true);
});

test("run:true 套件未执行（report.ok:false）→ failedStep:run（不再顶层 ok:true）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps();
  deps.execute = async (runtime_, options) => ({
    ...reportStub(options),
    ok: false,
    total: 2,
    executed: 0,
    skipped: 2,
    passed: 0,
    failed: 0,
    cases: [],
    error: "Appium 不可达：ECONNREFUSED 127.0.0.1:4723"
  });

  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, run: true, device: "emulator-5554" },
    deps
  );

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "run");
  assert.ok(payload.detail.includes("ECONNREFUSED"));
  assert.ok(Array.isArray(payload.suggestions) && payload.suggestions.length > 0);
  assert.equal(payload.run, undefined);
});

test("run:true execute 抛错 → failedStep:run（detail 透传）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps();
  deps.execute = async () => {
    throw new Error("artemis 子进程不可用");
  };

  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, run: true, device: "emulator-5554" },
    deps
  );

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "run");
  assert.ok(payload.detail.includes("artemis 子进程不可用"));
  assert.ok(Array.isArray(payload.suggestions) && payload.suggestions.length > 0);
});

test("run:true 用例失败但已执行 → 顶层仍 ok:true（run.ok/gate 反映）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps();
  deps.execute = async (runtime_, options) => ({
    ...reportStub(options),
    passed: 1,
    failed: 1,
    cases: [caseStub("F-2", "trace-b"), failedCaseStub("F-1", "trace-a")]
  });

  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, run: true, device: "emulator-5554" },
    deps
  );

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.run.ok, true);
  assert.equal(payload.run.gate, "failed");
  assert.equal(payload.run.failed, 1);
});

test("run:true 设备盘点抛错 → needs-setup(device) 带失败注记", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  deps.listDevices = async () => {
    calls.list += 1;
    throw new Error("adb server 未启动");
  };

  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL, run: true }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "setup");
  assert.equal(payload.checks[0].target, "device");
  assert.ok((payload.checks[0].note ?? "").includes("adb server 未启动"));
  assert.equal(calls.execute.length, 0);
});

test("run:true 执行前写服务日志（用例/来源/设备），且早于 execute", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps, calls } = makeDeps();
  const events = [];
  deps.log = (line) => events.push({ line, executes: calls.execute.length });

  const result = await designToTest(
    runtime,
    { figmaUrl: FIGMA_URL, run: true, device: "emulator-5554" },
    deps
  );

  assert.ok(!result.isError);
  assert.equal(events.length >= 1, true);
  assert.equal(events[0].executes, 0, "日志必须早于执行");
  assert.ok(events[0].line.includes("2 条"), events[0].line);
  assert.ok(events[0].line.includes("emulator-5554"), events[0].line);
  assert.ok(
    events[0].line.includes(path.join(runtime.configDirAbs, "design", "flows.json")),
    events[0].line
  );
});

test("设备盘点 env：合并 iosEnvironment、项目 .env 与 deviceHosts.adbHost", () => {
  const runtime = {
    project: {
      config: { deviceHosts: { android: { adbHost: "10.0.0.5:5037" } } },
      dotenvValues: { AOS_RUNNER_DEVICES: "emulator-5554" },
      resolver: { getValue: () => ({ value: null, source: null }) }
    },
    iosEnvironment: () => ({
      AOS_APPIUM_URL: "http://127.0.0.1:4723",
      AOS_RUNNER_DEVICES: "emulator-5554"
    })
  };

  const env = runnerInventoryEnv(runtime);
  assert.equal(env.ADB_SERVER_SOCKET, "tcp:10.0.0.5:5037");
  assert.equal(env.AOS_RUNNER_DEVICES, "emulator-5554");
  assert.equal(env.AOS_APPIUM_URL, "http://127.0.0.1:4723");
});

test("设备盘点 env：ADB_SERVER_SOCKET 以运行时解析（env/.env）优先于 deviceHosts", () => {
  const runtime = {
    project: {
      config: { deviceHosts: { android: { adbHost: "10.0.0.5:5037" } } },
      dotenvValues: { ADB_SERVER_SOCKET: "127.0.0.1:5038" },
      resolver: {
        getValue: (key) =>
          key === "ADB_SERVER_SOCKET"
            ? { value: "127.0.0.1:5038", source: "dotenv" }
            : { value: null, source: null }
      }
    },
    iosEnvironment: () => ({})
  };

  const env = runnerInventoryEnv(runtime);
  assert.equal(env.ADB_SERVER_SOCKET, "tcp:127.0.0.1:5038");
});

test("设备盘点 env 真正到达 adb：deviceHosts.adbHost → ADB_SERVER_SOCKET 子进程环境", async () => {
  const runtime = {
    project: {
      config: { deviceHosts: { android: { adbHost: "10.0.0.5:5037" } } },
      dotenvValues: {},
      resolver: { getValue: () => ({ value: null, source: null }) }
    },
    iosEnvironment: () => ({ AOS_APPIUM_URL: "http://127.0.0.1:4723" })
  };
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      code: 0,
      stdout: "List of devices attached\nemulator-5554\tdevice\n",
      stderr: ""
    };
  };

  const inventory = await collectRunnerInventory({
    exec,
    platform: "linux",
    env: runnerInventoryEnv(runtime)
  });

  assert.deepEqual(inventory.devices.map((device) => device.serial), ["emulator-5554"]);
  const devicesCall = calls.find((call) => call.args[0] === "devices");
  assert.ok(devicesCall, "adb devices 被调用");
  assert.equal(devicesCall.options.env.ADB_SERVER_SOCKET, "tcp:10.0.0.5:5037");
  assert.equal(devicesCall.options.env.AOS_APPIUM_URL, "http://127.0.0.1:4723");
});

test("generate 返回 0 条用例：failedStep:generate（不静默成功）", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps({
    generate: async (runtime, args) => {
      void runtime;
      void args;
      return textResult({ ok: true, counts: { flows: 0, screens: 0, edges: 0 } });
    }
  });
  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "generate");
  assert.ok(String(payload.detail).includes("没有生成任何用例"));
});

test("design_to_test: extract warnings 进入最终响应（含 pen-no-interactions）", async () => {
  const runtime = stubRuntime({ dotenv: { PEN_CLI_KEY: "pen_test" } });
  const warnings = [
    { code: "pen-no-interactions", message: "未检测到交互线索，跳转按画板排布推断" },
    { code: "vision-unavailable", message: "未启用视觉识别", details: ["model 不支持图像"] }
  ];
  const { deps } = makeDeps();
  deps.extractPen = async () =>
    textResult({ ok: true, counts: { screens: 2, edges: 0, warnings: 2 }, warnings });

  const result = await designToTest(runtime, { penPath: "/designs/app.pen" }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.warnings, warnings);
  assert.deepEqual(payload.designWarnings, {
    available: true,
    total: 2,
    byCode: { "pen-no-interactions": 1, "vision-unavailable": 1 },
    codes: ["pen-no-interactions", "vision-unavailable"],
    bySource: { extract: 2, flows: 0 }
  });
  assert.deepEqual(withoutMs(payload.steps[0]), {
    step: "extract",
    source: "pen",
    screens: 2,
    edges: 0,
    warnings: 2
  });
});

test("design_to_test: reuseExistingFlows 读取 flows.json warnings", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-design-to-test-reuse-warnings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const designDir = path.join(dir, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        { id: "s1", name: "首页", childNames: [], textHints: [] },
        { id: "s2", name: "详情", childNames: [], textHints: [] }
      ],
      edges: [],
      entryScreens: ["首页"],
      unresolvedDestinations: [],
      warnings: [
        { code: "pen-no-interactions", message: "未检测到交互线索" },
        { code: "screenshot-missing", message: "首页截图缺失" }
      ]
    })
  );

  const runtime = stubRuntime({ dir });
  const { deps } = makeDeps();
  const result = await designToTest(runtime, { reuseExistingFlows: true }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.warnings, [
    { code: "pen-no-interactions", message: "未检测到交互线索" },
    { code: "screenshot-missing", message: "首页截图缺失" }
  ]);
  assert.equal(payload.designWarnings.available, true);
  assert.equal(payload.designWarnings.total, 2);
  assert.deepEqual(payload.designWarnings.codes, ["pen-no-interactions", "screenshot-missing"]);
  assert.deepEqual(payload.designWarnings.bySource, { flows: 2 });
  assert.ok(!Number.isNaN(Date.parse(payload.designWarnings.snapshotAt)));
  assert.equal(withoutMs(payload.steps[0]).warnings, 2);
});

test("design_to_test: artifacts.flowMap 指向 design/flow-map.md", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-design-to-test-flow-map-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const designDir = path.join(dir, "design");
  fs.mkdirSync(designDir, { recursive: true });
  const flowMapPath = path.join(designDir, "flow-map.md");
  fs.writeFileSync(flowMapPath, "# 流程地图\n");

  const runtime = stubRuntime({ dir, dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps();
  const payload = payloadOf(await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps));
  assert.equal(payload.ok, true);
  assert.equal(payload.artifacts.flowMap, flowMapPath);

  const bare = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const barePayload = payloadOf(await designToTest(bare, { figmaUrl: FIGMA_URL }, makeDeps().deps));
  assert.equal(barePayload.ok, true);
  assert.equal(barePayload.artifacts.flowMap, undefined);
});

test("design_to_test: check 失败响应也携带已获得的 warnings", async () => {
  const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_test" } });
  const { deps } = makeDeps({ gate: () => "流程未完整覆盖：未硬覆盖屏幕 1" });
  deps.extractFigma = async () =>
    textResult({
      ok: true,
      counts: { screens: 1, edges: 0, warnings: 1 },
      warnings: [{ code: "flow-graph-empty", message: "未发现可用流程" }]
    });

  const result = await designToTest(runtime, { figmaUrl: FIGMA_URL }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedStep, "check");
  assert.deepEqual(payload.warnings, [{ code: "flow-graph-empty", message: "未发现可用流程" }]);
  assert.equal(payload.designWarnings.available, true);
  assert.equal(payload.designWarnings.total, 1);
  assert.deepEqual(payload.designWarnings.codes, ["flow-graph-empty"]);
});

test("design_to_test: extract 与 flows.json 重复警告去重（extract 优先）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-design-to-test-dedupe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const duplicate = { code: "pen-no-interactions", message: "未检测到交互线索" };
  const runtime = stubRuntime({ dir, dotenv: { PEN_CLI_KEY: "pen_test" } });
  const { deps } = makeDeps();
  deps.extractPen = async (runtime_) => {
    const designDir = path.join(runtime_.configDirAbs, "design");
    fs.mkdirSync(designDir, { recursive: true });
    fs.writeFileSync(
      path.join(designDir, "flows.json"),
      JSON.stringify({
        schemaVersion: 3,
        screens: [],
        edges: [],
        entryScreens: [],
        unresolvedDestinations: [],
        warnings: [duplicate]
      })
    );
    return textResult({
      ok: true,
      counts: { screens: 1, edges: 0, warnings: 1 },
      warnings: [duplicate]
    });
  };

  const result = await designToTest(runtime, { penPath: "/designs/app.pen" }, deps);

  assert.ok(!result.isError);
  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.warnings, [duplicate], "同 code+message 只保留一条");
  assert.deepEqual(payload.designWarnings.bySource, { extract: 1, flows: 0 });
  assert.equal(payload.designWarnings.total, 1, "total 为去重后条数");
  assert.equal(withoutMs(payload.steps[0]).warnings, 1);
});
