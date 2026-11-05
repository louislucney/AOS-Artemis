import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWebRunnerCommand } from "../dist/runner/web-agent.js";
import {
  createDefaultWebJobExecutor,
  executedPayload,
  webRunnerChildEnv
} from "../dist/runner/web-job-runner.js";
import { zipBuffer } from "./fixtures/web-zip.mjs";

const TOKEN = "runner-job-token-0123456789abcdef";
const BASE = "http://center.local:8765";
const FLOW_ENTRIES = [
  [
    "flows/TC-1.yaml",
    "appId: com.acme.web\n---\n- launchApp\n- assertVisible: 登录\n# aos:manual step=2 reason=step-unparsed\n- takeScreenshot: aos-TC-1-step-2\n"
  ],
  ["flows/TC-2.yaml", "appId: com.acme.web\n---\n- launchApp\n"]
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-job-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jobSpec(overrides = {}) {
  return {
    kind: "web-test",
    assignment: "manual",
    devicePinned: true,
    targetHostId: "host-a",
    deviceSerial: "emulator-5554",
    requirements: { platform: "android", deviceKind: "device" },
    deviceLeaseId: "host-a:emulator-5554",
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
  return {
    serial: "emulator-5554",
    name: "Pixel 8",
    model: "Pixel 8",
    osVersion: "15",
    platform: "android",
    kind: "device",
    state: "device",
    ...overrides
  };
}

function task(id, overrides = {}) {
  return {
    id,
    deviceSerial: "emulator-5554",
    claimedHostId: "host-a",
    targetHostId: "host-a",
    ...overrides
  };
}

function jUnitXml(cases) {
  const body = cases.map((entry) => {
    const attrs = `name="${entry.name}" classname="flows" time="1"`;
    if (entry.failure === undefined) return `<testcase ${attrs}/>`;
    return `<testcase ${attrs}><failure message="${entry.failure}">boom</failure></testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `<testsuite name="maestro" tests="${cases.length}">`,
    ...body,
    "</testsuite>",
    "</testsuites>"
  ].join("\n");
}

function fakeExec({ junitCases }) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "unzip") {
      if (args[0] === "-Z1") {
        return { code: 0, stdout: `${FLOW_ENTRIES.map(([name]) => name).join("\n")}\n`, stderr: "" };
      }
      const dir = args[args.indexOf("-d") + 1];
      for (const [name, content] of FLOW_ENTRIES) {
        const target = path.join(dir, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "adb") {
      if (args.includes("devices")) {
        return { code: 0, stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (args.includes("pm")) {
        const pkg = args[args.length - 1];
        return { code: 0, stdout: `package:/data/app/${pkg}/base.apk\n`, stderr: "" };
      }
      if (args.includes("dumpsys")) {
        if (args.includes("power")) {
          return { code: 0, stdout: "mWakefulness=Awake\n", stderr: "" };
        }
        if (args.includes("window")) {
          return { code: 0, stdout: "mDreamingLockscreen=false\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        args.includes("logcat") ||
        args.includes("screencap") ||
        args.includes("pull") ||
        args.includes("rm")
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: "Success\npackage:com.acme.web\nversionName=1.2.3\n",
        stderr: ""
      };
    }
    if (command.includes("maestro")) {
      if (junitCases !== null) {
        const output = args[args.indexOf("--output") + 1];
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, jUnitXml(junitCases));
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: `unsupported: ${command}` };
  };
  return { exec, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** 假中心：按 URL 路由 spec / 资产 / 结果；记录每次请求（含 headers/body）。 */
function fakeCenter({ assets, uploads, resultStatus = 200 }) {
  const calls = [];
  const contents = new Map(assets.map((asset) => [asset.id, asset.buffer]));
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const record = {
      url: target,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body
    };
    calls.push(record);
    if (target.endsWith("/spec")) {
      return jsonResponse({
        ok: true,
        job: { id: "job-1", status: "claimed", deviceSerial: "emulator-5554" },
        spec: jobSpec(),
        assets: assets.map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          sha256: asset.sha256,
          filename: asset.filename,
          secret: asset.secret === true,
          downloadUrl: `/panel/api/jobs/job-1/assets/${asset.id}`
        }))
      });
    }
    const asset = assets.find((entry) => target.endsWith(`/assets/${entry.id}`));
    if (asset !== undefined) {
      return new Response(contents.get(asset.id), {
        status: 200,
        headers: { "x-aos-sha256": asset.sha256 }
      });
    }
    if (target.endsWith("/results")) {
      uploads.push(JSON.parse(String(record.body)));
      return jsonResponse({ ok: true }, resultStatus);
    }
    return jsonResponse({ ok: false, error: "not found" }, 404);
  };
  return { fetchImpl, calls };
}

async function setup(t) {
  const workRoot = await tempDir(t);
  const excel = Buffer.from("excel-bytes");
  const pkg = Buffer.from("apk-bytes");
  const scripts = zipBuffer(FLOW_ENTRIES);
  const assets = [
    { id: "excel-1", kind: "excel", filename: "cases.xlsx", buffer: excel },
    { id: "package-1", kind: "package", filename: "acme.apk", buffer: pkg },
    { id: "scripts-1", kind: "scripts", filename: "scripts.zip", buffer: scripts }
  ].map((asset) => ({ ...asset, sha256: sha256(asset.buffer) }));
  return { workRoot, assets };
}

function executorFor({ fetchImpl, exec, workRoot, hostId, instanceId, timeoutMs, env }) {
  return createDefaultWebJobExecutor({
    ...(hostId === undefined ? {} : { hostId }),
    ...(instanceId === undefined ? {} : { instanceId }),
    panelBaseUrl: BASE,
    runnerToken: TOKEN,
    workRoot,
    exec,
    env: env ?? {},
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

test("默认执行器：spec → 下载/解压/安装/Maestro → 上传 passed（Bearer + host 头）", async (t) => {
  const { workRoot, assets } = await setup(t);
  const uploads = [];
  const center = fakeCenter({ assets, uploads });
  const fake = fakeExec({ junitCases: [{ name: "TC-1" }, { name: "TC-2" }] });
  const execute = executorFor({
    fetchImpl: center.fetchImpl,
    exec: fake.exec,
    workRoot,
    hostId: "host-a",
    instanceId: "inst-a",
    env: {
      PATH: "/usr/bin",
      AOS_MAESTRO_PATH: "/opt/maestro",
      AOS_RUNNER_JOB_TOKEN: TOKEN,
      AOS_WEB_JOB_TIMEOUT_MS: "1234",
      MOBILE_TESTING_DATABASE_URL: "postgres://center",
      DEEPSEEK_API_KEY: "sk-secret",
      SOME_PASSWORD: "pw"
    }
  });

  const result = await execute({
    task: task("job-1"),
    rootPath: "/tmp/projects/acme",
    device: device()
  });

  assert.deepEqual(result, { status: "completed" });
  const specCall = center.calls.find((call) => call.url.endsWith("/spec"));
  assert.equal(specCall.url, `${BASE}/panel/api/jobs/job-1/spec`);
  assert.equal(specCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(specCall.headers["x-aos-host-id"], "host-a");
  assert.equal(specCall.headers["x-mobile-testing-instance-id"], "inst-a");

  const downloadCalls = center.calls.filter((call) => call.url.includes("/assets/"));
  assert.equal(downloadCalls.length, 3);
  assert.ok(downloadCalls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`));

  const adbCall = fake.calls.find((call) => call.command === "adb");
  assert.deepEqual(adbCall.args.slice(0, 6), [
    "-s",
    "emulator-5554",
    "install",
    "-r",
    "-d",
    "-t"
  ]);
  assert.equal(adbCall.options.timeoutMs, 300_000, "安装默认给 5 分钟");
  const maestroCall = fake.calls.find((call) => call.command.includes("maestro"));
  assert.equal(maestroCall.command, "/opt/maestro", "使用 AOS_MAESTRO_PATH 解析结果");
  assert.deepEqual(maestroCall.args.slice(0, 4), ["test", "--udid", "emulator-5554", "--format"]);
  assert.equal(maestroCall.options.timeoutMs, 1234, "超时取未脱敏 env 的 AOS_WEB_JOB_TIMEOUT_MS");
  assert.equal(maestroCall.options.env.AOS_WEB_JOB_TIMEOUT_MS, undefined);
  assert.equal(
    fs.existsSync(path.join(workRoot, "acme", "job-1")),
    false,
    "上传成功后清理 job 目录（缓存保留）"
  );
  const childEnv = fake.calls[0].options.env;
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.AOS_MAESTRO_PATH, "/opt/maestro");
  assert.equal(childEnv.AOS_WEB_JOB_TIMEOUT_MS, undefined);
  assert.equal(childEnv.AOS_RUNNER_JOB_TOKEN, undefined);
  assert.equal(childEnv.MOBILE_TESTING_DATABASE_URL, undefined);
  assert.equal(childEnv.DEEPSEEK_API_KEY, undefined);
  assert.equal(childEnv.SOME_PASSWORD, undefined);

  assert.equal(uploads.length, 1);
  const payload = uploads[0];
  assert.equal(payload.execution.status, "passed");
  assert.deepEqual(
    payload.execution.cases.map((entry) => [entry.caseId, entry.status, entry.assertionCount]),
    [
      ["TC-1", "PASS", 1],
      ["TC-2", "PASS", 0]
    ]
  );
  assert.deepEqual(payload.execution.cases[0].manualSteps, [
    { step: 2, reason: "step-unparsed" }
  ]);
  assert.deepEqual(payload.device, { serial: "emulator-5554", model: "Pixel 8", osVersion: "15" });
  assert.deepEqual(payload.package, {
    name: "com.acme.web",
    version: "1.2.3",
    filename: "acme.apk"
  });
  const uploadCall = center.calls.find((call) => call.url.endsWith("/results"));
  assert.equal(uploadCall.method, "POST");
  assert.equal(uploadCall.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(uploadCall.headers["x-aos-host-id"], "host-a");
  assert.equal(uploadCall.headers["x-mobile-testing-instance-id"], "inst-a");
  assert.equal(uploadCall.headers["content-type"], "application/json");
});

test("默认执行器：无 JUnit → 上传 execution.status=error，返回 failed；host 头取自任务", async (t) => {
  const { workRoot, assets } = await setup(t);
  const uploads = [];
  const center = fakeCenter({ assets, uploads });
  const fake = fakeExec({ junitCases: null });
  const execute = executorFor({
    fetchImpl: center.fetchImpl,
    exec: fake.exec,
    workRoot
  });

  const result = await execute({
    task: task("job-2", { claimedHostId: "host-b", targetHostId: "host-b" }),
    rootPath: "/tmp/projects/acme",
    device: device()
  });

  assert.deepEqual(result, { status: "failed", detail: "maestro-no-junit: exit=0" });
  const specCall = center.calls.find((call) => call.url.endsWith("/spec"));
  assert.equal(specCall.headers["x-aos-host-id"], "host-b");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].execution.status, "error");
  assert.deepEqual(uploads[0].execution.cases, []);
  assert.match(uploads[0].execution.detail, /maestro-no-junit/);
});

test("默认执行器：结果上传失败抛错（Task 5 回池，不冒充成功）", async (t) => {
  const { workRoot, assets } = await setup(t);
  const uploads = [];
  const center = fakeCenter({ assets, uploads, resultStatus: 500 });
  const fake = fakeExec({ junitCases: [{ name: "TC-1" }] });
  const execute = executorFor({ fetchImpl: center.fetchImpl, exec: fake.exec, workRoot });

  await assert.rejects(
    execute({ task: task("job-3"), rootPath: "/tmp/projects/acme", device: device() }),
    /web-job-result-upload-failed: 500/
  );
  assert.equal(uploads.length, 1);
});

test("默认执行器：spec 401 抛错（不回退/不本地假成功）", async (t) => {
  const workRoot = await tempDir(t);
  const execute = executorFor({
    fetchImpl: async () => jsonResponse({ ok: false, error: "unauthorized" }, 401),
    exec: fakeExec({ junitCases: [] }).exec,
    workRoot
  });
  await assert.rejects(
    execute({ task: task("job-4"), rootPath: "/tmp/projects/acme", device: device() }),
    /web-job-spec-failed: 401/
  );
});

test("web-runner 启动：缺中心基址/RUNNER_JOB_TOKEN 明确 exit 2", async () => {
  const missingBase = [];
  const codeBase = await runWebRunnerCommand(
    ["--once"],
    { log: () => {}, errorLog: (line) => missingBase.push(line) },
    { env: {} }
  );
  assert.equal(codeBase, 2);
  assert.match(missingBase.join("\n"), /MOBILE_TESTING_PANEL_BASE_URL|--panel-base-url/);

  const missingToken = [];
  const codeToken = await runWebRunnerCommand(
    ["--once", "--panel-base-url", BASE],
    { log: () => {}, errorLog: (line) => missingToken.push(line) },
    { env: {} }
  );
  assert.equal(codeToken, 2);
  assert.match(
    missingToken.join("\n"),
    /MOBILE_TESTING_RUNNER_JOB_TOKEN|AOS_RUNNER_JOB_TOKEN/
  );
});

test("webRunnerChildEnv: Windows Path 归一到 PATH", () => {
  const child = webRunnerChildEnv({
    Path: "C:\\Windows\\system32",
    Temp: "C:\\Temp",
    "AOS_MAESTRO_PATH": "C:\\maestro\\maestro.bat",
    MOBILE_TESTING_RUNNER_JOB_TOKEN: "secret"
  });
  assert.equal(child.PATH, "C:\\Windows\\system32");
  assert.equal(child.TEMP, "C:\\Temp");
  assert.equal(child.AOS_MAESTRO_PATH, "C:\\maestro\\maestro.bat");
  assert.equal(child.MOBILE_TESTING_RUNNER_JOB_TOKEN, undefined);
});

test("webRunnerChildEnv: 只保留工具/PATH 白名单，剔除令牌/DB/KEY", () => {
  const child = webRunnerChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    AOS_MAESTRO_PATH: "/opt/maestro",
    MAESTRO_CLI_NO_ANALYTICS: "1",
    ANDROID_HOME: "/sdk",
    LC_ALL: "zh_CN.UTF-8",
    AOS_RUNNER_JOB_TOKEN: "secret",
    MOBILE_TESTING_DATABASE_URL: "postgres://center",
    OPENAI_API_KEY: "sk",
    GITHUB_TOKEN: "gh",
    DB_PASSWORD: "pw",
    UNRELATED: "x"
  });
  assert.deepEqual(child, {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    AOS_MAESTRO_PATH: "/opt/maestro",
    MAESTRO_CLI_NO_ANALYTICS: "1",
    ANDROID_HOME: "/sdk",
    LC_ALL: "zh_CN.UTF-8"
  });
});


test("executedPayload: l2Screenshots 开启时上传 PASS 用例最终截图", async (t) => {
  const dir = await tempDir(t);
  const shot = path.join(dir, "shot.png");
  await writeFile(shot, Buffer.from("fake-png"));
  const executed = {
    status: "passed",
    cases: [
      { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 10, screenshotPaths: [shot] }
    ],
    startedAt: "2026-10-29T01:00:00.000Z",
    finishedAt: "2026-10-29T01:01:00.000Z",
    detail: null
  };
  const device = { serial: "emulator-5554", model: "Pixel 7", osVersion: "14" };
  const pkg = { name: "com.acme.app", version: "1.0.0", filename: "app.apk" };

  const enabled = await executedPayload(executed, dir, device, pkg, {
    l2Screenshots: true,
    executionMode: "maestro"
  });
  assert.deepEqual(enabled.execution.cases[0].screenshot, {
    filename: "shot.png",
    base64: Buffer.from("fake-png").toString("base64")
  });

  const disabled = await executedPayload(executed, dir, device, pkg, {
    l2Screenshots: false,
    executionMode: "maestro"
  });
  assert.equal(disabled.execution.cases[0].screenshot, undefined);
});
