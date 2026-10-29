import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { executeWebJob } from "../dist/runner/web-executors.js";
import {
  installWebPackage,
  prepareWebJobWorkspace
} from "../dist/runner/web-job-workspace.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { saveExcelMapping } from "../dist/web/excel-mapping.js";
import { parseWebJobSpec, WebJobDispatchError } from "../dist/web/job-spec.js";
import {
  assignPendingWebJobs,
  createWebJob,
  reassignExpiredWebJobs
} from "../dist/web/jobs.js";
import { createWebProject } from "../dist/web/project-service.js";
import { ingestWebJobResult, readWebJobResult } from "../dist/web/results.js";
import { cellText } from "../dist/web/writeback.js";
import { workbookCopyPath } from "../dist/web/workbook.js";
import { zipBuffer } from "./fixtures/web-zip.mjs";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const RUNNER_TTL_MS = 90_000;
const LEASE_TTL_MS = 60_000;
const TOKEN = "runner-job-token-0123456789abcdef";
const PROJECT_SLUG = "acme";
const PACKAGE_NAME = "com.acme.web";
const PACKAGE_VERSION = "1.2.3";
const FLOW_ENTRIES = [
  ["flows/TC-1.yaml", "appId: com.acme.web\n---\n- launchApp\n- assertVisible: 登录\n"],
  ["flows/TC-2.yaml", "appId: com.acme.web\n---\n- launchApp\n- tapOn: 退出\n"]
];

/** 上传层原样使用执行器状态；runner 终态只在 Task 5 兜底写库时使用（error→failed）。 */
const RESULT_STATUS_FROM_EXECUTOR = {
  passed: "passed",
  partial: "partial",
  failed: "failed",
  error: "error"
};
const RUNNER_STATUS_FROM_EXECUTOR = {
  passed: "completed",
  partial: "partial",
  failed: "failed",
  error: "failed"
};

function toResultStatus(executorStatus) {
  const status = RESULT_STATUS_FROM_EXECUTOR[executorStatus];
  assert.ok(status, `未知执行器状态：${executorStatus}`);
  return status;
}

function toRunnerStatus(executorStatus) {
  const status = RUNNER_STATUS_FROM_EXECUTOR[executorStatus];
  assert.ok(status, `未知执行器状态：${executorStatus}`);
  return status;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function jUnitXml(cases) {
  const body = cases.map((entry) => {
    const attrs = `name="${entry.name}" classname="flows" time="${entry.seconds}"`;
    if (entry.failure === undefined) return `<testcase ${attrs}/>`;
    return `<testcase ${attrs}><failure message="${entry.failure}">Step failed</failure></testcase>`;
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

function makeTools(overrides = {}) {
  return {
    adb: true,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: true,
    devicectl: false,
    ...overrides
  };
}

function androidDevice(serial, model, osVersion) {
  return {
    serial,
    name: model,
    model,
    osVersion,
    platform: "android",
    kind: "device",
    state: "device"
  };
}

function webRunner({ hostId, serial, model, osVersion, lastSeenAt }) {
  return {
    hostId,
    name: `web-runner-${hostId}`,
    hostname: `${hostId}.local`,
    platforms: ["android"],
    devices: [androidDevice(serial, model, osVersion)],
    tools: makeTools(),
    artifactBaseUrl: null,
    version: "0.1.0",
    instanceId: `inst-${hostId}`,
    lastSeenAt
  };
}

/**
 * 假 exec：只路由本 E2E 需要的 unzip / adb / maestro，命令与参数都做精确断言。
 * maestro 在 `--output` 指定的位置写 JUnit；`flows/` 前缀由 unzip `-d` 决定落点。
 */
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
      return {
        code: 0,
        stdout: `Performing Streamed Install\nSuccess\npackage:${PACKAGE_NAME}\nversionName=${PACKAGE_VERSION}\n`,
        stderr: ""
      };
    }
    if (command === "maestro") {
      if (junitCases !== null) {
        const output = args[args.indexOf("--output") + 1];
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, jUnitXml(junitCases));
      }
      return { code: 0, stdout: "flows ok", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: `unsupported command: ${command}` };
  };
  return { exec, calls };
}

async function writeWorkbook(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.addRow(["用例编号", "用例名", "步骤", "期望结果"]);
  sheet.addRow(["TC-1", "登录", "1. 打开登录页", "1. 页面显示“登录”"]);
  sheet.addRow(["TC-2", "退出", "1. 点击退出", "1. 页面显示“退出”"]);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function loadSheet(filePath, sheetName = "用例") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  return sheet;
}

async function prepareProject(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-web-remote-e2e-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const store = new MemoryStore();
  const { rootPath } = await createWebProject({
    store,
    workspaceRoot: workspace,
    name: PROJECT_SLUG,
    platforms: ["android"],
    appPackage: PACKAGE_NAME
  });

  const workbookPath = await writeWorkbook(path.join(workspace, "cases.xlsx"));
  const excelBuffer = await readFile(workbookPath);
  const excel = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: excelBuffer
  });
  await saveExcelMapping({
    store,
    rootPath,
    assetId: excel.id,
    sheetName: "用例",
    columnMap: { caseId: "用例编号", steps: "步骤", expected: "期望结果" },
    createdBy: "e2e"
  });

  const pkg = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "acme.apk",
    buffer: Buffer.from("fake-apk-bytes")
  });
  const scripts = await storeWebAsset({
    store,
    rootPath,
    kind: "scripts",
    filename: "scripts.zip",
    buffer: zipBuffer(FLOW_ENTRIES),
    metadata: { sourceExcelAssetId: excel.id, packageAssetId: pkg.id }
  });

  return {
    workspace,
    store,
    rootPath,
    excel,
    pkg,
    scripts,
    originalSha: sha256(excelBuffer)
  };
}

function dispatchInput(ctx, overrides = {}) {
  return {
    store: ctx.store,
    rootPath: ctx.rootPath,
    assignment: "auto",
    requirements: { platform: "android", deviceKind: "device", deviceModel: ["Pixel 8"] },
    excelAssetId: ctx.excel.id,
    packageAssetId: ctx.pkg.id,
    scriptSetId: ctx.scripts.id,
    executionMode: "maestro",
    caseFilter: { modules: [], caseIds: [] },
    nowMs: NOW,
    runnerTtlMs: RUNNER_TTL_MS,
    reservationTtlMs: LEASE_TTL_MS,
    ...overrides
  };
}

test("远程 Web 任务端到端：下发选机 → 领取 → 下载/安装/Maestro → 结果写回 → 等待/回池/钉设备告警", async (t) => {
  const previous = new Map();
  for (const [key, value] of Object.entries({
    AOS_RUNNER_JOB_TOKEN: TOKEN,
    AOS_HTTP_TOKEN: undefined,
    AOS_HTTP_USERS: undefined,
    AOS_HTTP_ALLOW_INSECURE: undefined
  })) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const ctx = await prepareProject(t);
  const { store, rootPath } = ctx;

  assert.equal(toResultStatus("passed"), "passed");
  assert.equal(toResultStatus("error"), "error");
  assert.equal(toRunnerStatus("error"), "failed");

  // 两台执行机：host-a 初始离线，host-b 在线（auto 只能选 host-b）。
  await store.upsertWebRunner(
    webRunner({
      hostId: "host-a",
      serial: "emulator-5554",
      model: "Pixel 7",
      osVersion: "14",
      lastSeenAt: iso(NOW - 300_000)
    })
  );
  await store.upsertWebRunner(
    webRunner({
      hostId: "host-b",
      serial: "emulator-5556",
      model: "Pixel 8",
      osVersion: "15",
      lastSeenAt: iso(NOW)
    })
  );
  const runners = await store.listWebRunners();
  assert.deepEqual(runners.map((entry) => entry.hostId).sort(), ["host-a", "host-b"]);

  const job1 = await createWebJob(dispatchInput(ctx));
  assert.equal(job1.pendingReason, null);
  assert.deepEqual(job1.assignment && {
    hostId: job1.assignment.hostId,
    deviceSerial: job1.assignment.deviceSerial
  }, { hostId: "host-b", deviceSerial: "emulator-5556" });
  assert.equal(job1.task.status, "pending");
  assert.equal(job1.task.targetHostId, "host-b");
  assert.equal(job1.task.deviceSerial, "emulator-5556");
  assert.equal(job1.task.deviceLeaseId, "host-b:emulator-5556");
  const leases = await store.listDeviceLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].taskId, job1.task.id);
  assert.ok(Date.parse(leases[0].expiresAt) > NOW);

  // 同设备第二条任务：manual 钉设备 → 立即拒绝；auto → 建 pending 等待。
  await assert.rejects(
    createWebJob(
      dispatchInput(ctx, {
        assignment: "manual",
        devicePinned: true,
        targetHostId: "host-b",
        deviceSerial: "emulator-5556"
      })
    ),
    (error) => {
      assert.ok(error instanceof WebJobDispatchError);
      assert.equal(error.code, "device-busy");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal((await store.listDeviceLeases()).length, 1, "被拒绝的任务不得新增租约");

  const job2 = await createWebJob(dispatchInput(ctx, { nowMs: NOW + 1_000 }));
  assert.equal(job2.assignment, null);
  assert.equal(job2.task.status, "pending");
  assert.equal(job2.task.targetHostId, null);
  assert.equal(job2.task.deviceSerial, null);
  const job2Spec = parseWebJobSpec(job2.task.jobSpec);
  assert.equal(job2Spec.assignmentError.code, "device-busy");
  assert.match(job2.pendingReason, /占用|busy/i);

  // runner 领取（claim 需要本任务的有效租约）。
  const claimed = await store.claimWebJob({
    runnerId: "runner-b",
    hostId: "host-b",
    deviceSerial: "emulator-5556",
    instanceId: "inst-host-b",
    nowMs: NOW + 2_000
  });
  assert.ok(claimed);
  assert.equal(claimed.task.id, job1.task.id);
  assert.equal(claimed.task.status, "claimed");
  assert.equal(claimed.task.claimedHostId, "host-b");
  const spec = parseWebJobSpec(claimed.task.jobSpec);
  assert.ok(spec);
  await store.updateRegressionTask(rootPath, job1.task.id, {
    status: "running",
    startedAt: iso(NOW + 2_000)
  });

  // 中心 spec / 资产端点（runner token + 主机绑定）。
  const server = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: ctx.workspace, store });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "host-b" };

  const wrongHost = await fetch(`${base}/panel/api/jobs/${job1.task.id}/spec`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "host-a" }
  });
  assert.equal(wrongHost.status, 403);
  const unauthenticated = await fetch(`${base}/panel/api/jobs/${job1.task.id}/spec`);
  assert.equal(unauthenticated.status, 401);

  const specResponse = await fetch(`${base}/panel/api/jobs/${job1.task.id}/spec`, { headers });
  assert.equal(specResponse.status, 200);
  const specBody = await specResponse.json();
  assert.deepEqual(
    specBody.assets.map((entry) => entry.kind).sort(),
    ["excel", "package", "scripts"]
  );
  assert.ok(specBody.assets.every((entry) => entry.secret === false));
  assert.equal(Object.hasOwn(specBody.job, "rootPath"), false);
  assert.equal(specBody.job.deviceSerial, "emulator-5556");

  const download = async (url) => {
    const response = await fetch(`${base}${url}`, { headers });
    assert.equal(response.status, 200, `资产下载失败：${url}`);
    assert.ok(response.headers.get("x-aos-sha256"));
    return Buffer.from(await response.arrayBuffer());
  };
  const workspaceRoot = path.join(ctx.workspace, "runner-work");
  const prepared = await prepareWebJobWorkspace({
    jobId: job1.task.id,
    projectSlug: PROJECT_SLUG,
    workRoot: workspaceRoot,
    cacheRoot: path.join(ctx.workspace, "runner-cache"),
    assets: specBody.assets.map((entry) => ({
      kind: entry.kind,
      sha256: entry.sha256,
      filename: entry.filename,
      url: entry.downloadUrl,
      secret: entry.secret
    })),
    download,
    exec: fakeExec({ junitCases: [] }).exec,
    env: {}
  });
  assert.ok(prepared.flowsDir);
  assert.deepEqual(prepared.warnings, []);
  assert.ok(fs.existsSync(path.join(prepared.flowsDir, "TC-1.yaml")));
  assert.ok(fs.existsSync(path.join(prepared.flowsDir, "TC-2.yaml")));
  assert.deepEqual(
    await readFile(prepared.files.get("scripts")),
    zipBuffer(FLOW_ENTRIES)
  );
  assert.equal(sha256(await readFile(prepared.files.get("package"))), ctx.pkg.sha256);

  const fake = fakeExec({
    junitCases: [
      { name: "TC-1", seconds: "1.2" },
      { name: "TC-2", seconds: "0.8", failure: "按钮不存在" }
    ]
  });
  const install = await installWebPackage({
    platform: "android",
    deviceSerial: "emulator-5556",
    packagePath: prepared.files.get("package"),
    jobDir: prepared.jobDir,
    exec: fake.exec,
    env: {}
  });
  assert.deepEqual(install, {
    ok: true,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION
  });
  const adbCall = fake.calls.find((call) => call.command === "adb");
  assert.deepEqual(adbCall.args.slice(0, 4), ["-s", "emulator-5556", "install", "-r"]);

  const executed = await executeWebJob({
    jobSpec: spec,
    jobDir: prepared.jobDir,
    flowsDir: prepared.flowsDir,
    device: { serial: "emulator-5556", platform: "android", kind: "device" },
    exec: fake.exec,
    env: {},
    timeoutMs: 60_000
  });
  assert.equal(executed.status, "failed");
  assert.deepEqual(
    executed.cases.map((entry) => [entry.caseId, entry.status, entry.assertionCount]),
    [
      ["TC-1", "PASS", 1],
      ["TC-2", "FAIL", 0]
    ]
  );
  const maestroCall = fake.calls.find((call) => call.command === "maestro");
  assert.deepEqual(maestroCall.args.slice(0, 6), [
    "test",
    "--udid",
    "emulator-5556",
    "--format",
    "JUNIT",
    "--output"
  ]);
  assert.equal(maestroCall.args.at(-1), `${prepared.flowsDir}${path.sep}`);

  // 结果上传：executor 状态 → runner 终态 → 结果契约状态（Task 9 接线口径）。
  const uploaded = {
    execution: {
      status: toResultStatus(executed.status),
      cases: executed.cases.map((entry) => ({
        caseId: entry.caseId,
        name: entry.name,
        status: entry.status,
        durationMs: entry.durationMs,
        traceId: `trace-${entry.caseId}`,
        ...(entry.assertionCount === undefined ? {} : { assertionCount: entry.assertionCount }),
        ...(entry.failureReason === undefined ? {} : { failureReason: entry.failureReason })
      })),
      startedAt: executed.startedAt,
      finishedAt: executed.finishedAt,
      detail: executed.detail
    },
    device: { serial: "emulator-5556", model: "Pixel 8", osVersion: "15" },
    package: {
      name: install.packageName ?? "",
      version: install.version ?? "",
      filename: "acme.apk"
    },
    startedAt: executed.startedAt,
    finishedAt: executed.finishedAt,
    evidence: executed.cases
      .flatMap((entry) => entry.screenshotPaths ?? [])
      .map((file) => path.relative(prepared.jobDir, file))
  };
  assert.equal(uploaded.execution.status, "failed");

  const summary = await ingestWebJobResult({
    store,
    jobId: job1.task.id,
    payload: uploaded,
    actor: "host-b"
  });
  assert.equal(summary.taskStatus, "failed");
  assert.equal(summary.dbStatus, "failed");
  assert.equal(summary.writebackStatus, "written");
  assert.deepEqual(summary.gate, {
    result: "failed",
    total: 2,
    passed: 1,
    failed: 1,
    errors: 0,
    skipped: 0
  });
  assert.equal(summary.idempotent, false);
  assert.equal(summary.writtenCells.length, 12);
  assert.deepEqual(summary.warnings, []);

  const copyPath = workbookCopyPath(rootPath, ctx.excel.id);
  const sheet = await loadSheet(copyPath);
  for (const [column, header] of [
    ["I", "执行｜结果"],
    ["J", "执行｜设备与系统"],
    ["K", "执行｜安装包"],
    ["L", "执行｜开始时间"],
    ["M", "执行｜结束时间"],
    ["N", "执行｜traceId"]
  ]) {
    assert.equal(cellText(sheet.getCell(`${column}1`)), header);
  }
  assert.equal(cellText(sheet.getCell("I2")), "PASS");
  assert.equal(cellText(sheet.getCell("I3")), "FAIL");
  assert.equal(cellText(sheet.getCell("J2")), "Pixel 8 / 15");
  assert.equal(cellText(sheet.getCell("K2")), `${PACKAGE_NAME} ${PACKAGE_VERSION} acme.apk`);
  assert.equal(cellText(sheet.getCell("L2")), executed.startedAt);
  assert.equal(cellText(sheet.getCell("M2")), executed.finishedAt);
  assert.equal(cellText(sheet.getCell("N2")), "trace-TC-1");
  assert.equal(sha256(await readFile(ctx.excel.storagePath)), ctx.originalSha, "原件 sha256 必须不变");

  const resultDoc = await readWebJobResult(rootPath, job1.task.id);
  assert.ok(resultDoc);
  assert.equal(resultDoc.taskStatus, "failed");
  assert.deepEqual(resultDoc.device, { serial: "emulator-5556", model: "Pixel 8", osVersion: "15" });
  assert.equal(resultDoc.execution.cases.length, 2);
  assert.equal(resultDoc.writebackStatus, "written");

  const finished = await store.getRegressionTask(rootPath, job1.task.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.deviceSerial, "emulator-5556", "终态保留设备身份");
  assert.equal(finished.deviceLeaseId, null, "结果入库清空租约 id");

  await store.releaseDeviceLeases({ hostId: "host-b", taskId: job1.task.id });
  assert.equal((await store.listDeviceLeases()).length, 0);

  // 执行器 error（无 JUnit）→ 上传 error → taskStatus error / dbStatus failed（不降级）。
  const jobError = await createWebJob(
    dispatchInput(ctx, {
      assignment: "manual",
      devicePinned: true,
      targetHostId: "host-b",
      deviceSerial: "emulator-5556",
      nowMs: NOW + 3_000
    })
  );
  assert.ok(jobError.assignment);
  const claimedError = await store.claimWebJob({
    runnerId: "runner-b",
    hostId: "host-b",
    deviceSerial: "emulator-5556",
    instanceId: "inst-host-b",
    nowMs: NOW + 3_500
  });
  assert.ok(claimedError);
  await store.updateRegressionTask(rootPath, jobError.task.id, {
    status: "running",
    startedAt: iso(NOW + 4_000)
  });
  const errorSpec = parseWebJobSpec(claimedError.task.jobSpec);
  assert.ok(errorSpec);
  const errorExec = fakeExec({ junitCases: null });
  const errored = await executeWebJob({
    jobSpec: errorSpec,
    jobDir: prepared.jobDir,
    flowsDir: prepared.flowsDir,
    device: { serial: "emulator-5556", platform: "android", kind: "device" },
    exec: errorExec.exec,
    env: {},
    timeoutMs: 60_000
  });
  assert.equal(errored.status, "error");
  assert.deepEqual(errored.cases, []);
  assert.match(errored.detail, /maestro-no-junit/);

  const errorSummary = await ingestWebJobResult({
    store,
    jobId: jobError.task.id,
    payload: {
      execution: {
        status: toResultStatus(errored.status),
        cases: [],
        startedAt: errored.startedAt,
        finishedAt: errored.finishedAt,
        detail: errored.detail
      },
      device: { serial: "emulator-5556", model: "Pixel 8", osVersion: "15" },
      package: { name: PACKAGE_NAME, version: PACKAGE_VERSION, filename: "acme.apk" },
      startedAt: errored.startedAt,
      finishedAt: errored.finishedAt
    },
    actor: "host-b"
  });
  assert.equal(errorSummary.taskStatus, "error");
  assert.equal(errorSummary.dbStatus, "failed");
  assert.equal(errorSummary.gate.result, "error");
  assert.equal(errorSummary.writtenCells.length, 0);
  const errorDoc = await readWebJobResult(rootPath, jobError.task.id);
  assert.equal(errorDoc.taskStatus, "error");
  assert.equal((await store.getRegressionTask(rootPath, jobError.task.id)).status, "failed");
  await store.releaseDeviceLeases({ hostId: "host-b", taskId: jobError.task.id });
  assert.equal((await store.listDeviceLeases()).length, 0);

  // 等待任务在设备空闲后补绑。
  const T1 = NOW + 5_000;
  await store.upsertWebRunner(
    webRunner({
      hostId: "host-b",
      serial: "emulator-5556",
      model: "Pixel 8",
      osVersion: "15",
      lastSeenAt: iso(T1)
    })
  );
  const bound = await assignPendingWebJobs({
    store,
    nowMs: T1,
    runnerTtlMs: RUNNER_TTL_MS,
    reservationTtlMs: LEASE_TTL_MS
  });
  assert.equal(bound, 1);
  const job2Bound = await store.getRegressionTask(rootPath, job2.task.id);
  assert.equal(job2Bound.status, "pending");
  assert.equal(job2Bound.targetHostId, "host-b");
  assert.equal(job2Bound.deviceSerial, "emulator-5556");
  assert.equal(job2Bound.deviceLeaseId, "host-b:emulator-5556");

  const job3 = await createWebJob(dispatchInput(ctx, { nowMs: T1 + 1_000 }));
  assert.equal(job3.assignment, null, "唯一在线设备被占用 → 等待");
  assert.equal(job3.task.status, "pending");

  // 预占超时 + 执行机离线 → 回池并改派到另一台执行机。
  const T2 = T1 + RUNNER_TTL_MS + 1_000;
  await store.upsertWebRunner(
    webRunner({
      hostId: "host-a",
      serial: "emulator-5554",
      model: "Pixel 7",
      osVersion: "14",
      lastSeenAt: iso(T2)
    })
  );
  const processed = await reassignExpiredWebJobs({
    store,
    nowMs: T2,
    leaseTtlMs: LEASE_TTL_MS,
    runnerTtlMs: RUNNER_TTL_MS
  });
  assert.ok(processed >= 1);
  const job2Reassigned = await store.getRegressionTask(rootPath, job2.task.id);
  assert.equal(job2Reassigned.status, "pending");
  assert.equal(job2Reassigned.targetHostId, "host-a");
  assert.equal(job2Reassigned.deviceSerial, "emulator-5554");
  assert.equal(job2Reassigned.deviceLeaseId, "host-a:emulator-5554");
  const job2ReassignedSpec = parseWebJobSpec(job2Reassigned.jobSpec);
  assert.equal(job2ReassignedSpec.reassignCount, 1);
  assert.equal(job2ReassignedSpec.assignmentError, null);
  const reassignedLeases = await store.listDeviceLeases();
  assert.deepEqual(
    reassignedLeases.map((entry) => [entry.hostId, entry.serial, entry.taskId]),
    [["host-a", "emulator-5554", job2.task.id]]
  );
  const job3Waiting = await store.getRegressionTask(rootPath, job3.task.id);
  assert.equal(job3Waiting.status, "pending");
  assert.equal(job3Waiting.deviceSerial, null);

  // 手动钉住设备（执行机离线）→ 无限等待，只告警不计改派。
  const job4 = await createWebJob(
    dispatchInput(ctx, {
      assignment: "manual",
      devicePinned: true,
      targetHostId: "host-b",
      deviceSerial: "emulator-5556",
      nowMs: T2 + 1_000
    })
  );
  assert.equal(job4.assignment, null);
  assert.equal(job4.task.status, "pending");
  assert.equal(job4.task.targetHostId, "host-b");
  assert.equal(job4.task.deviceSerial, "emulator-5556");
  assert.equal(job4.task.deviceLeaseId, null);
  assert.match(job4.pendingReason, /离线|offline/i);

  let job4State = job4.task;
  for (const offset of [2_000, 3_000]) {
    await reassignExpiredWebJobs({
      store,
      nowMs: T2 + offset,
      leaseTtlMs: LEASE_TTL_MS,
      runnerTtlMs: RUNNER_TTL_MS
    });
    job4State = await store.getRegressionTask(rootPath, job4.task.id);
  }
  const job4Spec = parseWebJobSpec(job4State.jobSpec);
  assert.equal(job4State.status, "pending");
  assert.equal(job4State.targetHostId, "host-b");
  assert.equal(job4State.deviceSerial, "emulator-5556");
  assert.equal(job4State.deviceLeaseId, null);
  assert.equal(job4Spec.reassignCount ?? 0, 0, "钉设备等待不计改派");
  assert.equal(job4Spec.pinnedWaitCount, 2);
  assert.equal(job4Spec.assignmentError.code, "host-offline");
  assert.match(job4Spec.assignmentError.message, /第 2 次检查，不计改派/);
  assert.equal(
    (await store.listDeviceLeases()).filter((entry) => entry.hostId === "host-b").length,
    0,
    "等待中的钉设备不得占租约"
  );
});
