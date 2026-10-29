import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeWebJob } from "../dist/runner/web-executors.js";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-exec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jobSpec(overrides = {}) {
  return {
    kind: "web-test",
    assignment: "auto",
    devicePinned: false,
    targetHostId: "host-1",
    deviceSerial: "emulator-5554",
    requirements: { platform: "android", deviceKind: "device" },
    deviceLeaseId: null,
    excelAssetId: "excel-1",
    packageAssetId: "package-1",
    materialsAssetId: null,
    scriptSetId: "scripts-1",
    executionMode: "maestro",
    caseFilter: { modules: [], caseIds: [] },
    retry: 0,
    allowStaleScript: false,
    allowPartialUnresolved: false,
    assetSnapshot: [],
    ...overrides
  };
}

function device(overrides = {}) {
  return { serial: "emulator-5554", platform: "android", kind: "device", ...overrides };
}

function xmlCase({ name, classname, time, body = "", selfClosing = false }) {
  const attrs = [
    name === undefined ? "" : ` name="${name}"`,
    classname === undefined ? "" : ` classname="${classname}"`,
    time === undefined ? "" : ` time="${time}"`
  ].join("");
  if (selfClosing || body === "") return `<testcase${attrs}/>`;
  return `<testcase${attrs}>${body}</testcase>`;
}

function junit(cases, testsuiteAttrs = ' tests="0"') {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `<testsuite name="maestro"${testsuiteAttrs}>`,
    ...cases,
    "</testsuite>",
    "</testsuites>"
  ].join("\n");
}

async function workspace(t, flowNames, options = {}) {
  const root = await tempDir(t);
  const jobDir = path.join(root, "work", "acme", "job-1");
  const flowsDir = options.flowsDir ?? path.join(jobDir, "flows");
  await mkdir(flowsDir, { recursive: true });
  for (const name of flowNames) {
    const target = path.join(flowsDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, options.contents?.[name] ?? "appId: acme.app\n---\n- launchApp\n");
  }
  return { root, jobDir, flowsDir };
}

function fakeExec(handler) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return handler(command, args, options, calls);
  };
  return { exec, calls };
}

function execWithJunit(content, result = { code: 0, stdout: "", stderr: "" }) {
  return fakeExec(async (command, args) => {
    const index = args.indexOf("--output");
    const output = args[index + 1];
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content);
    return result;
  });
}

test("executeWebJob: JUnit 三用例映射 PASS/FAIL/SKIP，任一失败任务 failed", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml", "flow-b.yaml", "flow-c.yaml"]);
  const { exec, calls } = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", classname: "flows", time: "1.5" }),
      xmlCase({
        name: "flow-b",
        classname: "flows",
        time: "2",
        body: "<failure message=\"boom\">Step failed: tapOn id=submit</failure>"
      }),
      xmlCase({ name: "flow-c", classname: "flows", time: "0.25", body: "<skipped/>" })
    ])
  );
  const env = { PATH: "/usr/bin" };

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env
  });

  assert.equal(result.status, "failed");
  assert.equal(result.cases.length, 3);
  const byId = new Map(result.cases.map((entry) => [entry.caseId, entry]));
  assert.equal(byId.get("flow-a").status, "PASS");
  assert.equal(byId.get("flow-a").durationMs, 1500);
  assert.equal(byId.get("flow-b").status, "FAIL");
  assert.match(byId.get("flow-b").failureReason, /tapOn id=submit/);
  assert.equal(byId.get("flow-c").status, "SKIP");
  assert.equal(result.cases.filter((entry) => entry.status === "SKIP").length, 1);
  assert.equal(new Date(result.startedAt).toISOString(), result.startedAt);
  assert.equal(new Date(result.finishedAt).toISOString(), result.finishedAt);
  assert.ok(new Date(result.finishedAt) >= new Date(result.startedAt));
  assert.equal(result.detail, null);
  assert.equal(calls.length, 1);
});

test("executeWebJob: 按顶层 flow 统计硬断言条数并上报 assertionCount", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml", "flow-b.yaml"], {
    contents: {
      "flow-a.yaml":
        "appId: acme.app\n---\n- launchApp\n- assertVisible: 登录\n- assertNotVisible: 错误\n- assertTrue: ${true}\n",
      "flow-b.yaml": "appId: acme.app\n---\n- launchApp\n- tapOn: 退出\n"
    }
  });
  const { exec } = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", classname: "flows", time: "1" }),
      xmlCase({ name: "flow-b", classname: "flows", time: "1" })
    ])
  );
  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });
  const byId = new Map(result.cases.map((entry) => [entry.caseId, entry]));
  assert.equal(byId.get("flow-a").assertionCount, 3);
  assert.deepEqual(byId.get("flow-a").assertions, [
    { type: "visible", text: "登录" },
    { type: "notVisible", text: "错误" }
  ]);
  assert.equal(byId.get("flow-b").assertionCount, 0);
  assert.equal(byId.get("flow-b").assertions, undefined);
});

test("executeWebJob: maestro 命令参数、默认 15 分钟超时与 env 透传", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec, calls } = execWithJunit(junit([xmlCase({ name: "flow-a", selfClosing: true })]));
  const env = { PATH: "/usr/bin", AOS_MAESTRO: "1" };

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device({ serial: "R58M123ABC" }),
    exec,
    env
  });

  assert.equal(result.status, "passed");
  const call = calls[0];
  assert.equal(call.command, "maestro");
  assert.equal(call.args[0], "test");
  assert.equal(call.args[call.args.indexOf("--udid") + 1], "R58M123ABC");
  assert.ok(call.args.includes("--format"));
  assert.equal(call.args[call.args.indexOf("--format") + 1], "JUNIT");
  assert.equal(call.args[call.args.indexOf("--output") + 1], path.join(jobDir, "junit.xml"));
  assert.equal(call.args[call.args.indexOf("--debug-output") + 1], path.join(jobDir, "maestro"));
  assert.equal(call.args.at(-1), flowsDir + path.sep);
  assert.equal(call.options.timeoutMs, 900_000);
  assert.equal(call.options.env, env);
});

test("executeWebJob: 自定义超时（参数优先于环境变量）", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const first = execWithJunit(junit([xmlCase({ name: "flow-a", selfClosing: true })]));
  await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec: first.exec,
    env: { AOS_WEB_JOB_TIMEOUT_MS: "120000" }
  });
  assert.equal(first.calls[0].options.timeoutMs, 120_000);

  const second = execWithJunit(junit([xmlCase({ name: "flow-a", selfClosing: true })]));
  await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec: second.exec,
    env: { AOS_WEB_JOB_TIMEOUT_MS: "120000" },
    timeoutMs: 5_000
  });
  assert.equal(second.calls[0].options.timeoutMs, 5_000);
});

test("executeWebJob: 非零退出且无 JUnit 文件 → error，保留 stderr 摘要", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec } = fakeExec(async () => ({ code: 1, stdout: "", stderr: "maestro exploded: device offline" }));

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.deepEqual(result.cases, []);
  assert.match(result.detail, /device offline/);
  assert.match(result.detail, /exit=1/);
});

test("executeWebJob: 超时且无 JUnit → error 保留 timeout", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec } = fakeExec(async () => ({ code: null, stdout: "", stderr: "", error: "timeout" }));

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.match(result.detail, /timeout/);
});

test("executeWebJob: 非零退出但 JUnit 合法 → error，用例保留可见", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml", "flow-b.yaml"]);
  const { exec } = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", selfClosing: true }),
      xmlCase({ name: "flow-b", body: "<error>driver crashed</error>" })
    ]),
    { code: 1, stdout: "", stderr: "some flows failed" }
  );

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases.find((entry) => entry.caseId === "flow-a").status, "PASS");
  assert.equal(result.cases.find((entry) => entry.caseId === "flow-b").status, "ERROR");
  assert.match(result.detail, /maestro-exit:1/);
});

test("executeWebJob: 非零退出但 JUnit 全 PASS → error，不因用例全绿而假通过", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml", "flow-b.yaml"]);
  const { exec } = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", selfClosing: true }),
      xmlCase({ name: "flow-b", selfClosing: true })
    ]),
    { code: 2, stdout: "", stderr: "runner aborted after last case" }
  );

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.deepEqual(result.cases.map((entry) => entry.status), ["PASS", "PASS"]);
  assert.match(result.detail, /maestro-exit:2/);
});

test("executeWebJob: 超时但 JUnit 全 PASS → error，保留 timeout 与用例", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec } = execWithJunit(
    junit([xmlCase({ name: "flow-a", selfClosing: true })]),
    { code: null, stdout: "", stderr: "", error: "timeout" }
  );

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].status, "PASS");
  assert.match(result.detail, /maestro-exit:timeout/);
});

test("executeWebJob: 无 JUnit 时保留 exec 错误（spawn 失败）", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec } = fakeExec(async () => ({
    code: null,
    stdout: "",
    stderr: "",
    error: "spawn maestro ENOENT"
  }));

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.match(result.detail, /maestro-no-junit/);
  assert.match(result.detail, /spawn maestro ENOENT/);
});

test("executeWebJob: 子目录 subflows 不算用例，但 runFlow 引用的断言计入顶层用例", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const subflowsDir = path.join(flowsDir, "subflows");
  await mkdir(subflowsDir, { recursive: true });
  await writeFile(
    path.join(subflowsDir, "helper.yaml"),
    "appId: acme.app\n---\n- tapOn: Next\n- assertVisible: 子流程断言\n"
  );
  await writeFile(
    path.join(flowsDir, "flow-a.yaml"),
    "appId: acme.app\n---\n- launchApp\n- runFlow: subflows/helper.yaml\n"
  );
  const { exec } = execWithJunit(junit([xmlCase({ name: "flow-a", selfClosing: true })]));

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.cases.map((entry) => entry.caseId), ["flow-a"]);
  assert.equal(result.cases[0].assertionCount, 1, "runFlow 子流程的断言计入顶层用例");
  assert.deepEqual(result.cases[0].assertions, [{ type: "visible", text: "子流程断言" }]);
  assert.equal(result.detail, null);
});

test("executeWebJob: runFlow 越界与循环引用不放大断言", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const subflowsDir = path.join(flowsDir, "subflows");
  await mkdir(subflowsDir, { recursive: true });
  await writeFile(
    path.join(subflowsDir, "helper.yaml"),
    "appId: acme.app\n---\n- assertVisible: 子流程断言\n- runFlow: ../flow-a.yaml\n"
  );
  await writeFile(
    path.join(flowsDir, "flow-a.yaml"),
    "appId: acme.app\n---\n- launchApp\n- runFlow: subflows/helper.yaml\n- runFlow: ../outside.yaml\n"
  );
  await writeFile(path.join(jobDir, "outside.yaml"), "appId: acme.app\n---\n- assertVisible: 越界断言\n");
  const { exec } = execWithJunit(junit([xmlCase({ name: "flow-a", selfClosing: true })]));
  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });
  assert.equal(result.cases[0].assertionCount, 1);
  assert.deepEqual(result.cases[0].assertions, [{ type: "visible", text: "子流程断言" }]);
});

test("executeWebJob: 无 scriptSetId / 无 yaml / flowsDir 越界 → error 且不执行命令", async (t) => {
  const { root, jobDir } = await workspace(t, ["flow-a.yaml"]);
  const emptyDir = path.join(jobDir, "empty-flows");
  await mkdir(emptyDir, { recursive: true });
  await writeFile(path.join(emptyDir, "notes.txt"), "not a flow");

  const noScript = fakeExec(async () => ({ code: 0, stdout: "", stderr: "" }));
  const missingScript = await executeWebJob({
    jobSpec: jobSpec({ scriptSetId: null }),
    jobDir,
    flowsDir: emptyDir,
    device: device(),
    exec: noScript.exec,
    env: {}
  });
  assert.equal(missingScript.status, "error");
  assert.match(missingScript.detail, /script-set/);
  assert.equal(noScript.calls.length, 0);

  const noFlows = fakeExec(async () => ({ code: 0, stdout: "", stderr: "" }));
  const empty = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir: emptyDir,
    device: device(),
    exec: noFlows.exec,
    env: {}
  });
  assert.equal(empty.status, "error");
  assert.match(empty.detail, /no-flow-files/);
  assert.equal(noFlows.calls.length, 0);

  const outsideDir = path.join(root, "outside-flows");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "flow-a.yaml"), "appId: acme.app\n");
  const outside = fakeExec(async () => ({ code: 0, stdout: "", stderr: "" }));
  const escaped = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir: outsideDir,
    device: device(),
    exec: outside.exec,
    env: {}
  });
  assert.equal(escaped.status, "error");
  assert.match(escaped.detail, /flows-outside-job/);
  assert.equal(outside.calls.length, 0);
});

test("executeWebJob: executionMode=llm → llm-execution-not-wired，不执行也不伪造 PASS", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec, calls } = fakeExec(async () => ({ code: 0, stdout: "", stderr: "" }));

  const result = await executeWebJob({
    jobSpec: jobSpec({ executionMode: "llm" }),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.deepEqual(result, {
    status: "error",
    cases: [],
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    detail: "llm-execution-not-wired"
  });
  assert.equal(calls.length, 0);
});

test("executeWebJob: 截图/日志路径只取 jobDir 内真实文件", async (t) => {
  const { root, jobDir, flowsDir } = await workspace(t, ["flow-a.yaml", "flow-b.yaml"]);
  const debugDir = path.join(jobDir, "maestro");
  const screensDir = path.join(debugDir, "screens");
  await writeFile(path.join(root, "outside-flow-a.png"), "png");

  const { exec } = fakeExec(async (command, args) => {
    const output = args[args.indexOf("--output") + 1];
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      junit([
        xmlCase({ name: "flow-a", selfClosing: true }),
        xmlCase({ name: "flow-b", selfClosing: true })
      ])
    );
    await mkdir(screensDir, { recursive: true });
    await writeFile(path.join(screensDir, "flow-a.png"), "png");
    await writeFile(path.join(screensDir, "unrelated.png"), "png");
    fs.symlinkSync(path.join(root, "outside-flow-a.png"), path.join(screensDir, "flow-a-link.png"));
    await writeFile(path.join(debugDir, "maestro.log"), "log");
    return { code: 0, stdout: "", stderr: "" };
  });

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "passed");
  const byId = new Map(result.cases.map((entry) => [entry.caseId, entry]));
  const a = byId.get("flow-a");
  assert.deepEqual(a.screenshotPaths, [path.join(screensDir, "flow-a.png")]);
  assert.equal(a.logPath, path.join(debugDir, "maestro.log"));
  const b = byId.get("flow-b");
  assert.equal(b.screenshotPaths, undefined);
  assert.equal(b.logPath, path.join(debugDir, "maestro.log"));
  for (const entry of result.cases) {
    for (const file of entry.screenshotPaths ?? []) {
      assert.ok(file.startsWith(jobDir + path.sep));
    }
    if (entry.logPath) assert.ok(entry.logPath.startsWith(jobDir + path.sep));
  }
});

test("executeWebJob: 未匹配 testcase 变 ERROR 合成 id，不静默丢弃", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec } = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", selfClosing: true }),
      xmlCase({ name: "mystery-flow", classname: "flows", selfClosing: true })
    ])
  );

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "failed");
  const mystery = result.cases.find((entry) => entry.name === "mystery-flow");
  assert.ok(mystery);
  assert.equal(mystery.status, "ERROR");
  assert.match(mystery.caseId, /^unmatched:/);
  assert.match(result.detail, /unmatched-testcase/);
});

test("executeWebJob: 重复 caseId 首个生效，后续标记；重复 flow 文件同样告警", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml", "flow-a.yml"]);
  const { exec } = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", selfClosing: true }),
      xmlCase({ name: "flow-a", selfClosing: true })
    ])
  );

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });

  assert.equal(result.status, "failed");
  const first = result.cases.find((entry) => entry.caseId === "flow-a");
  assert.equal(first.status, "PASS");
  const synthetic = result.cases.filter((entry) => /^duplicate:/.test(entry.caseId));
  assert.equal(synthetic.length, 2);
  assert.ok(synthetic.every((entry) => entry.status === "ERROR"));
  assert.match(result.detail, /duplicate/);
});

test("executeWebJob: SKIP+PASS → partial；全 PASS → passed；零用例 → error", async (t) => {
  const pass = await workspace(t, ["flow-a.yaml", "flow-b.yaml"]);
  const partialExec = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", selfClosing: true }),
      xmlCase({ name: "flow-b", body: "<skipped/>" })
    ])
  );
  const partial = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir: pass.jobDir,
    flowsDir: pass.flowsDir,
    device: device(),
    exec: partialExec.exec,
    env: {}
  });
  assert.equal(partial.status, "partial");

  const allPassExec = execWithJunit(
    junit([
      xmlCase({ name: "flow-a", selfClosing: true }),
      xmlCase({ name: "flow-b", selfClosing: true })
    ])
  );
  const passed = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir: pass.jobDir,
    flowsDir: pass.flowsDir,
    device: device(),
    exec: allPassExec.exec,
    env: {}
  });
  assert.equal(passed.status, "passed");

  const empty = await workspace(t, ["flow-a.yaml"]);
  const emptyExec = execWithJunit(junit([]));
  const noCases = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir: empty.jobDir,
    flowsDir: empty.flowsDir,
    device: device(),
    exec: emptyExec.exec,
    env: {}
  });
  assert.equal(noCases.status, "error");
  assert.match(noCases.detail, /junit/);
});

test("executeWebJob: 拒绝 DTD/ENTITY、畸形 XML 与超过 2MB 的 JUnit", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);

  const dtdExec = execWithJunit(
    '<!DOCTYPE testsuites [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuites><testsuite>' +
      xmlCase({ name: "flow-a", body: "<failure>&xxe;</failure>" }) +
      "</testsuite></testsuites>"
  );
  const dtd = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec: dtdExec.exec,
    env: {}
  });
  assert.equal(dtd.status, "error");
  assert.deepEqual(dtd.cases, []);
  assert.match(dtd.detail, /junit-(dtd|invalid)/);

  const malformedExec = execWithJunit('<testsuites><testsuite><testcase name="flow-a" time="1">');
  const malformed = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec: malformedExec.exec,
    env: {}
  });
  assert.equal(malformed.status, "error");
  assert.match(malformed.detail, /junit/);

  const padding = "x".repeat(2 * 1024 * 1024 + 16);
  const hugeExec = execWithJunit(
    junit([xmlCase({ name: "flow-a", body: `<failure>${padding}</failure>` })])
  );
  const huge = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device(),
    exec: hugeExec.exec,
    env: {}
  });
  assert.equal(huge.status, "error");
  assert.match(huge.detail, /junit-too-large/);
});

test("executeWebJob: 非法设备 serial 不执行命令", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["flow-a.yaml"]);
  const { exec, calls } = fakeExec(async () => ({ code: 0, stdout: "", stderr: "" }));

  const result = await executeWebJob({
    jobSpec: jobSpec(),
    jobDir,
    flowsDir,
    device: device({ serial: "--format" }),
    exec,
    env: {}
  });

  assert.equal(result.status, "error");
  assert.match(result.detail, /invalid-device-serial/);
  assert.equal(calls.length, 0);
});

test("executeWebJob: caseIds 只跑指定 flow；modules 暂不支持 → typed error", async (t) => {
  const { jobDir, flowsDir } = await workspace(t, ["TC-1.yaml", "TC-2.yaml"]);
  const { exec } = execWithJunit(junit([xmlCase({ name: "TC-1" })]));
  const filtered = await executeWebJob({
    jobSpec: jobSpec({ caseFilter: { modules: [], caseIds: ["TC-1"] } }),
    jobDir,
    flowsDir,
    device: device(),
    exec,
    env: {}
  });
  assert.equal(filtered.status, "passed");
  assert.deepEqual(filtered.cases.map((entry) => entry.caseId), ["TC-1"]);

  const noMatch = await executeWebJob({
    jobSpec: jobSpec({ caseFilter: { modules: [], caseIds: ["TC-404"] } }),
    jobDir,
    flowsDir,
    device: device(),
    exec: fakeExec(async () => ({ code: 0, stdout: "", stderr: "" })).exec,
    env: {}
  });
  assert.equal(noMatch.status, "error");
  assert.equal(noMatch.detail, "case-filter-no-match");

  const modules = await executeWebJob({
    jobSpec: jobSpec({ caseFilter: { modules: ["登录"], caseIds: [] } }),
    jobDir,
    flowsDir,
    device: device(),
    exec: fakeExec(async () => ({ code: 0, stdout: "", stderr: "" })).exec,
    env: {}
  });
  assert.equal(modules.status, "error");
  assert.equal(modules.detail, "case-filter-modules-unsupported");
});
