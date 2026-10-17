import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { designToTest } from "../dist/workflow/design-to-test.js";

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
  assert.deepEqual(payload.steps[0], { step: "extract", source: "figma", screens: 2, edges: 1 });
  assert.deepEqual(payload.steps[1], { step: "generate", cases: 2, screens: 2, edges: 1 });
  assert.deepEqual(payload.steps[2], { step: "check", ok: true });

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
  assert.deepEqual(payload.steps[0], { step: "extract", source: "pen", screens: 3, edges: 2 });
  assert.deepEqual(payload.nextAction, {
    tool: "design_to_test",
    args: { reuseExistingFlows: true, run: true }
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
  assert.deepEqual(payload.steps[0], { step: "extract", reused: true, screens: 2, edges: 0 });
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
  assert.deepEqual(payload.suggestions, ["按提示用 figma_generate_tests 修正后重跑"]);
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
  assert.deepEqual(runStep, {
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
