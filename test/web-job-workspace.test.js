import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { storeWebAsset } from "../dist/web/assets.js";
import {
  cleanupWebJobWorkspace,
  installWebPackage,
  prepareWebJobWorkspace,
  removeWebJobSecrets,
  verifySha256,
  WebJobWorkspaceError
} from "../dist/runner/web-job-workspace.js";

const TOKEN = "runner-job-token-0123456789abcdef";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeExec(handler) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return handler(command, args, options, calls);
  };
  return { exec, calls };
}

function asset(overrides) {
  return {
    kind: "package",
    filename: "app.apk",
    url: "http://center/asset",
    ...overrides
  };
}

test("prepareWebJobWorkspace: 首次下载写 CAS 与 job 目录，同 sha 第二次命中缓存只下载一次", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const workRoot = path.join(root, "work");
  const cacheRoot = path.join(root, "cache");
  const content = Buffer.from("apk-bytes-1");
  const digest = sha256(content);
  const downloads = [];
  const download = async (url) => {
    downloads.push(url);
    return content;
  };

  const first = await prepareWebJobWorkspace({
    jobId: "job-1",
    projectSlug: "acme",
    workRoot,
    cacheRoot,
    assets: [asset({ sha256: digest })],
    download,
    exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
  });
  const packagePath = first.files.get("package");
  assert.ok(packagePath);
  assert.deepEqual(await readFile(packagePath), content);
  assert.ok(packagePath.startsWith(first.jobDir));
  const cachePath = path.join(cacheRoot, "assets", digest);
  assert.deepEqual(await readFile(cachePath), content);
  assert.equal(downloads.length, 1);

  const second = await prepareWebJobWorkspace({
    jobId: "job-2",
    projectSlug: "acme",
    workRoot,
    cacheRoot,
    assets: [asset({ sha256: digest })],
    download,
    exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
  });
  assert.notEqual(second.jobDir, first.jobDir);
  assert.deepEqual(await readFile(second.files.get("package")), content);
  assert.equal(downloads.length, 1, "缓存命中不应重复下载");
});

test("prepareWebJobWorkspace: sha 不匹配抛 asset-sha-mismatch，缓存与 job 目录不落地", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const workRoot = path.join(root, "work");
  const cacheRoot = path.join(root, "cache");
  const content = Buffer.from("bad-content");

  await assert.rejects(
    prepareWebJobWorkspace({
      jobId: "job-bad",
      projectSlug: "acme",
      workRoot,
      cacheRoot,
      assets: [asset({ sha256: "0".repeat(64) })],
      download: async () => content,
      exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
    }),
    (error) => {
      assert.equal(error instanceof WebJobWorkspaceError, true);
      assert.equal(error.code, "asset-sha-mismatch");
      return true;
    }
  );
  const cacheEntries = fs.existsSync(cacheRoot) ? fs.readdirSync(path.join(cacheRoot, "assets")) : [];
  assert.deepEqual(cacheEntries, []);
  const jobDir = path.join(workRoot, "acme", "job-bad");
  assert.equal(fs.existsSync(jobDir), false);
  assert.equal(verifySha256(content, sha256(content)), true);
  assert.equal(verifySha256(content, "f".repeat(64)), false);
});

test("prepareWebJobWorkspace: 中途失败删除已写 secret 与半成品 job 目录", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const workRoot = path.join(root, "work");
  const cacheRoot = path.join(root, "cache");
  const secret = Buffer.from("secret-first");
  const secretSha = sha256(secret);
  const good = Buffer.from("good-package");
  const goodSha = sha256(good);
  const downloads = [];

  await assert.rejects(
    prepareWebJobWorkspace({
      jobId: "job-fail",
      projectSlug: "acme",
      workRoot,
      cacheRoot,
      assets: [
        asset({
          kind: "materials",
          filename: "secret.txt",
          sha256: secretSha,
          url: "http://center/secret.txt",
          secret: true
        }),
        asset({
          kind: "package",
          filename: "app.apk",
          sha256: goodSha,
          url: "http://center/app.apk"
        }),
        asset({
          kind: "excel",
          filename: "x.xlsx",
          sha256: "f".repeat(64),
          url: "http://center/x.xlsx"
        })
      ],
      download: async (url) => {
        downloads.push(url);
        return url.endsWith("secret.txt") ? secret : good;
      },
      exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
    }),
    (error) => {
      assert.equal(error.code, "asset-sha-mismatch");
      return true;
    }
  );
  const jobDir = path.join(workRoot, "acme", "job-fail");
  assert.equal(fs.existsSync(path.join(jobDir, "secrets")), false, "secret 必须随失败清理");
  assert.equal(fs.existsSync(jobDir), false, "半成品 job 目录一并清理");
  assert.deepEqual(
    fs.readdirSync(path.join(cacheRoot, "assets")),
    [goodSha],
    "已校验缓存保留；secret 不进入缓存"
  );
  assert.equal(await removeWebJobSecrets(jobDir), true);
});

test("prepareWebJobWorkspace: 缓存内容损坏时重新下载并覆盖", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const workRoot = path.join(root, "work");
  const cacheRoot = path.join(root, "cache");
  const content = Buffer.from("fresh-content");
  const digest = sha256(content);
  await mkdir(path.join(cacheRoot, "assets"), { recursive: true });
  await writeFile(path.join(cacheRoot, "assets", digest), "corrupt");
  let downloads = 0;

  const prepared = await prepareWebJobWorkspace({
    jobId: "job-repair",
    projectSlug: "acme",
    workRoot,
    cacheRoot,
    assets: [asset({ sha256: digest })],
    download: async () => {
      downloads += 1;
      return content;
    },
    exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
  });
  assert.equal(downloads, 1);
  assert.deepEqual(await readFile(prepared.files.get("package")), content);
  assert.deepEqual(await readFile(path.join(cacheRoot, "assets", digest)), content);
});

test("prepareWebJobWorkspace: secret materials 只写 0600 jobDir/secrets，不进 CAS，清理后删除", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const workRoot = path.join(root, "work");
  const cacheRoot = path.join(root, "cache");
  const secret = Buffer.from("账号:secret");
  const digest = sha256(secret);
  let downloads = 0;

  const prepared = await prepareWebJobWorkspace({
    jobId: "job-secret",
    projectSlug: "acme",
    workRoot,
    cacheRoot,
    assets: [
      asset({ kind: "materials", filename: "账号.txt", sha256: digest, secret: true })
    ],
    download: async () => {
      downloads += 1;
      return secret;
    },
    exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
  });
  const secretPath = prepared.files.get("materials");
  assert.ok(secretPath.startsWith(path.join(prepared.jobDir, "secrets")));
  const info = await stat(secretPath);
  assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual(await readFile(secretPath), secret);
  assert.equal(downloads, 1);
  const cacheEntries = fs.existsSync(path.join(cacheRoot, "assets"))
    ? fs.readdirSync(path.join(cacheRoot, "assets"))
    : [];
  assert.deepEqual(cacheEntries, []);
  assert.equal(await removeWebJobSecrets(prepared.jobDir), true);
  assert.equal(fs.existsSync(path.join(prepared.jobDir, "secrets")), false);

  const cleaned = await cleanupWebJobWorkspace({
    workRoot,
    completedJobIds: ["job-secret"]
  });
  assert.deepEqual(cleaned.removed.map((entry) => path.basename(entry)), ["job-secret"]);
  assert.equal(fs.existsSync(prepared.jobDir), false);
  assert.equal(fs.existsSync(secretPath), false);
});

test("cleanupWebJobWorkspace: 跳过符号链接目录，不删除 workRoot 外的内容", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const workRoot = path.join(root, "work");
  const projectDir = path.join(workRoot, "acme");
  const outside = path.join(root, "outside");
  await mkdir(projectDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(projectDir, "job-link"));

  const cleaned = await cleanupWebJobWorkspace({
    workRoot,
    completedJobIds: ["job-link"]
  });
  assert.deepEqual(cleaned.removed, []);
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
});

test("prepareWebJobWorkspace: excel 原件只落 attachments，不解析", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const excel = Buffer.from("xlsx-original");
  const digest = sha256(excel);
  const prepared = await prepareWebJobWorkspace({
    jobId: "job-excel",
    projectSlug: "acme",
    workRoot: path.join(root, "work"),
    cacheRoot: path.join(root, "cache"),
    assets: [asset({ kind: "excel", filename: "cases.xlsx", sha256: digest })],
    download: async () => excel,
    exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
  });
  const excelPath = prepared.files.get("excel");
  assert.ok(excelPath.startsWith(path.join(prepared.jobDir, "attachments")));
  assert.deepEqual(await readFile(excelPath), excel);
  assert.equal(prepared.flowsDir, null);
});

test("prepareWebJobWorkspace: scripts zip 先扫描条目再解压到 flows（5s 超时）", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const zip = Buffer.from("fake-zip");
  const digest = sha256(zip);
  const { exec, calls } = fakeExec((command, args) => {
    if (args[0] === "-Z1") {
      return { code: 0, stdout: "flows/login.yaml\nflows/cart.yaml\n", stderr: "" };
    }
    const dir = args[args.indexOf("-d") + 1];
    fs.mkdirSync(path.join(dir, "flows"), { recursive: true });
    fs.writeFileSync(path.join(dir, "flows", "login.yaml"), "appId: demo\n");
    return { code: 0, stdout: "", stderr: "" };
  });

  const prepared = await prepareWebJobWorkspace({
    jobId: "job-scripts",
    projectSlug: "acme",
    workRoot: path.join(root, "work"),
    cacheRoot: path.join(root, "cache"),
    assets: [asset({ kind: "scripts", filename: "scripts.zip", sha256: digest })],
    download: async () => zip,
    exec
  });
  assert.ok(prepared.flowsDir);
  assert.equal(prepared.flowsDir, path.join(prepared.jobDir, "flows"));
  assert.match(await readFile(path.join(prepared.flowsDir, "flows", "login.yaml"), "utf-8"), /appId/);
  const extract = calls.find((call) => call.args[0] === "-o");
  assert.ok(extract);
  assert.equal(extract.command, "unzip");
  assert.equal(extract.options.timeoutMs, 5000);
});

test("prepareWebJobWorkspace: scripts 条目越界（.. / 绝对路径）拒绝解压", async (t) => {
  const root = await tempDir(t, "aos-web-job-ws-");
  const zip = Buffer.from("fake-zip");
  const digest = sha256(zip);
  for (const entry of ["../evil.yaml", "/etc/passwd", "flows/../../evil.yaml"]) {
    const { exec, calls } = fakeExec((command, args) =>
      args[0] === "-Z1"
        ? { code: 0, stdout: `${entry}\n`, stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    );
    await assert.rejects(
      prepareWebJobWorkspace({
        jobId: "job-escape",
        projectSlug: "acme",
        workRoot: path.join(root, "work"),
        cacheRoot: path.join(root, "cache"),
        assets: [asset({ kind: "scripts", filename: "scripts.zip", sha256: digest })],
        download: async () => zip,
        exec
      }),
      (error) => {
        assert.equal(error.code, "script-extract-failed");
        return true;
      }
    );
    assert.equal(calls.some((call) => call.args[0] === "-o"), false);
  }
});

test("installWebPackage: Android 走 adb install -r，失败返回 typed reason", async () => {
  const ok = fakeExec(() => ({ code: 0, stdout: "Performing Streamed Install\nSuccess\n", stderr: "" }));
  const result = await installWebPackage({
    platform: "android",
    deviceSerial: "emulator-5554",
    packagePath: "/tmp/app.apk",
    exec: ok.exec,
    env: { PATH: "/bin" }
  });
  assert.deepEqual(result, { ok: true, packageName: null, version: null });
  assert.deepEqual(ok.calls[0].args, ["-s", "emulator-5554", "install", "-r", "/tmp/app.apk"]);
  assert.equal(ok.calls[0].command, "adb");

  const failed = fakeExec(() => ({ code: 1, stdout: "", stderr: "Failure [INSTALL_FAILED_INVALID_APK]" }));
  const failure = await installWebPackage({
    platform: "android",
    deviceSerial: "emulator-5554",
    packagePath: "/tmp/app.apk",
    exec: failed.exec
  });
  assert.deepEqual(failure, { ok: false, reason: "install-failed" });
});

test("installWebPackage: iOS 模拟器走 simctl，真机走 devicectl", async () => {
  const simulator = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  const simResult = await installWebPackage({
    platform: "ios",
    deviceSerial: "SIM-UDID",
    packagePath: "/tmp/App.app",
    exec: simulator.exec
  });
  assert.equal(simResult.ok, true);
  assert.equal(simulator.calls[0].command, "xcrun");
  assert.deepEqual(simulator.calls[0].args, ["simctl", "install", "SIM-UDID", "/tmp/App.app"]);

  const real = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  const realResult = await installWebPackage({
    platform: "ios",
    deviceSerial: "REAL-UDID",
    packagePath: "/tmp/App.ipa",
    deviceKind: "device",
    exec: real.exec
  });
  assert.equal(realResult.ok, true);
  assert.deepEqual(real.calls[0].args, [
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    "REAL-UDID",
    "/tmp/App.ipa"
  ]);

  const unsupported = await installWebPackage({
    platform: "windows",
    deviceSerial: "x",
    packagePath: "/tmp/app",
    exec: fakeExec(() => ({ code: 0, stdout: "", stderr: "" })).exec
  });
  assert.deepEqual(unsupported, { ok: false, reason: "unsupported-platform" });

  const badSerial = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  assert.deepEqual(
    await installWebPackage({
      platform: "android",
      deviceSerial: "bad serial;rm -rf /",
      packagePath: "/tmp/app.apk",
      exec: badSerial.exec
    }),
    { ok: false, reason: "invalid-device-serial" }
  );
  assert.equal(badSerial.calls.length, 0);

  const outside = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  assert.deepEqual(
    await installWebPackage({
      platform: "android",
      deviceSerial: "emulator-5554",
      packagePath: "/tmp/outside.apk",
      jobDir: "/tmp/job-1",
      exec: outside.exec
    }),
    { ok: false, reason: "invalid-package-path" }
  );
  assert.equal(outside.calls.length, 0);
});

async function makeJob(store, rootPath, jobSpec, status = "claimed", hostId = null) {
  await store.upsertProject({ rootPath, name: path.basename(rootPath) });
  await store.createWebProject({
    rootPath,
    name: path.basename(rootPath),
    normalizedName: path.basename(rootPath),
    platforms: ["android"]
  });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    jobSpec,
    deviceSerial: "emulator-5554",
    ...(hostId === null ? {} : { targetHostId: hostId })
  });
  if (status !== "pending") {
    await store.updateRegressionTask(rootPath, task.id, { status });
  }
  return task;
}

test("getWebJobById: Memory/File/PG 全局按 id 取任务与项目根路径", async (t) => {
  const root = await tempDir(t, "aos-web-job-get-");
  const rootPath = path.join(root, "acme");
  await mkdir(rootPath, { recursive: true });
  const spec = { kind: "web-test", assetSnapshot: [] };

  const memory = new MemoryStore();
  const memoryTask = await makeJob(memory, rootPath, spec);
  assert.equal((await memory.getWebJobById(memoryTask.id)).rootPath, rootPath);
  assert.equal((await memory.getWebJobById(memoryTask.id)).task.id, memoryTask.id);
  assert.equal(await memory.getWebJobById("missing"), null);

  const home = path.join(root, "ledger");
  const file = await FileStore.create({ homeDir: home });
  const fileTask = await makeJob(file, rootPath, spec);
  const found = await file.getWebJobById(fileTask.id);
  assert.equal(found.rootPath, rootPath);
  assert.equal(found.task.id, fileTask.id);
  assert.equal(await file.getWebJobById("missing"), null);

  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  const pgTask = await makeJob(pg, rootPath, spec);
  const pgFound = await pg.getWebJobById(pgTask.id);
  assert.equal(pgFound.rootPath, rootPath);
  assert.equal(pgFound.task.id, pgTask.id);
  assert.equal(await pg.getWebJobById("missing"), null);
});

async function withRunnerServer(t, fn) {
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
  const workspace = await tempDir(t, "aos-web-job-http-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  try {
    return await fn({ base: `http://127.0.0.1:${handle.port}`, store, rootPath, workspace });
  } finally {
    await handle.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("GET /panel/api/jobs/:id/spec 与 assets：runner token 鉴权、404 隔离、字节流下载", async (t) => {
  await withRunnerServer(t, async ({ base, store, rootPath }) => {
    const excel = Buffer.from("excel-original");
    const pkg = Buffer.from("apk-content-42");
    const excelAsset = await storeWebAsset({
      store,
      rootPath,
      kind: "excel",
      filename: "cases.xlsx",
      buffer: excel
    });
    const packageAsset = await storeWebAsset({
      store,
      rootPath,
      kind: "package",
      filename: "app.apk",
      buffer: pkg
    });
    const extra = await storeWebAsset({
      store,
      rootPath,
      kind: "materials",
      filename: "extra.txt",
      buffer: Buffer.from("not-in-job")
    });
    const spec = {
      kind: "web-test",
      assignment: "auto",
      devicePinned: false,
      targetHostId: null,
      deviceSerial: null,
      requirements: { platform: "android", deviceKind: "any" },
      deviceLeaseId: null,
      excelAssetId: excelAsset.id,
      packageAssetId: packageAsset.id,
      materialsAssetId: null,
      scriptSetId: null,
      executionMode: "maestro",
      caseFilter: { modules: [], caseIds: [] },
      retry: 0,
      allowStaleScript: false,
      allowPartialUnresolved: false,
      assetSnapshot: [
        {
          kind: "excel",
          id: excelAsset.id,
          sha256: sha256(excel),
          filename: "cases.xlsx"
        },
        {
          kind: "package",
          id: packageAsset.id,
          sha256: sha256(pkg),
          filename: "app.apk"
        }
      ]
    };
    const task = await makeJob(store, rootPath, spec, "claimed", "host-1");
    const auth = {
      authorization: `Bearer ${TOKEN}`,
      "x-aos-host-id": "host-1"
    };

    const unauthorized = await fetch(`${base}/panel/api/jobs/${task.id}/spec`);
    assert.equal(unauthorized.status, 401);
    const wrong = await fetch(`${base}/panel/api/jobs/${task.id}/spec`, {
      headers: { authorization: "Bearer wrong-token" }
    });
    assert.equal(wrong.status, 401);

    const missingHost = await fetch(`${base}/panel/api/jobs/${task.id}/spec`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(missingHost.status, 403);
    const wrongHost = await fetch(`${base}/panel/api/jobs/${task.id}/spec`, {
      headers: { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "host-other" }
    });
    assert.equal(wrongHost.status, 403);
    assert.equal(
      (await fetch(`${base}/panel/api/jobs/${task.id}/assets/${packageAsset.id}`, {
        headers: { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": "host-other" }
      })).status,
      403
    );

    const response = await fetch(`${base}/panel/api/jobs/${task.id}/spec`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.job.id, task.id);
    assert.equal("rootPath" in body.job, false, "spec 响应不得泄漏项目路径");
    assert.equal(body.spec.packageAssetId, packageAsset.id);
    assert.deepEqual(
      body.assets.map((entry) => entry.id).sort(),
      [excelAsset.id, packageAsset.id].sort()
    );
    const packageEntry = body.assets.find((entry) => entry.id === packageAsset.id);
    assert.equal(packageEntry.downloadUrl, `/panel/api/jobs/${task.id}/assets/${packageAsset.id}`);
    assert.equal(packageEntry.sha256, sha256(pkg));

    const download = await fetch(`${base}${packageEntry.downloadUrl}`, { headers: auth });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-length"), String(pkg.length));
    assert.equal(download.headers.get("x-aos-sha256"), sha256(pkg));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pkg);

    assert.equal(
      (await fetch(`${base}/panel/api/jobs/${task.id}/assets/${extra.id}`, { headers: auth })).status,
      404,
      "不在 job snapshot 内的资产不可下载"
    );
    assert.equal(
      (await fetch(`${base}/panel/api/jobs/${task.id}/assets/missing`, { headers: auth })).status,
      404
    );
    assert.equal(
      (await fetch(`${base}/panel/api/jobs/unknown-job/spec`, { headers: auth })).status,
      404
    );
  });
});

test("GET /panel/api/jobs/:id/assets/:assetId 拒绝 storagePath 逃逸与跨项目资产", async (t) => {
  await withRunnerServer(t, async ({ base, store, rootPath, workspace }) => {
    const outside = path.join(workspace, "outside.bin");
    await writeFile(outside, "outside");
    const escaped = await store.createWebAsset({
      rootPath,
      kind: "materials",
      filename: "escape.txt",
      sha256: sha256(Buffer.from("outside")),
      size: 7,
      storagePath: outside
    });
    const otherRoot = path.join(workspace, "other");
    await mkdir(otherRoot, { recursive: true });
    await store.upsertProject({ rootPath: otherRoot, name: "other" });
    const other = await store.createWebAsset({
      rootPath: otherRoot,
      kind: "materials",
      filename: "other.txt",
      sha256: sha256(Buffer.from("other")),
      size: 5,
      storagePath: path.join(otherRoot, "materials.txt")
    });
    const spec = {
      kind: "web-test",
      assetSnapshot: [
        { kind: "materials", id: escaped.id, sha256: escaped.sha256, filename: escaped.filename },
        { kind: "materials", id: other.id, sha256: other.sha256, filename: other.filename }
      ]
    };
    const task = await makeJob(store, rootPath, spec, "claimed", "host-1");
    const auth = {
      authorization: `Bearer ${TOKEN}`,
      "x-aos-host-id": "host-1"
    };
    assert.equal(
      (await fetch(`${base}/panel/api/jobs/${task.id}/assets/${escaped.id}`, { headers: auth })).status,
      404
    );
    assert.equal(
      (await fetch(`${base}/panel/api/jobs/${task.id}/assets/${other.id}`, { headers: auth })).status,
      404
    );
  });
});

test("GET /panel/api/jobs/*：AOS_RUNNER_JOB_TOKEN 未设置返回 503，不回退管理员令牌", async (t) => {
  await withRunnerServer(t, async ({ base, store, rootPath }) => {
    const asset = await storeWebAsset({
      store,
      rootPath,
      kind: "materials",
      filename: "m.txt",
      buffer: Buffer.from("m")
    });
    const task = await makeJob(store, rootPath, {
      kind: "web-test",
      assetSnapshot: [
        { kind: "materials", id: asset.id, sha256: asset.sha256, filename: asset.filename }
      ]
    });
    const previous = process.env.AOS_RUNNER_JOB_TOKEN;
    delete process.env.AOS_RUNNER_JOB_TOKEN;
    try {
      const response = await fetch(`${base}/panel/api/jobs/${task.id}/spec`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, "runner-token-unset");

      process.env.AOS_RUNNER_JOB_TOKEN = "short";
      const shortToken = await fetch(`${base}/panel/api/jobs/${task.id}/spec`, {
        headers: { authorization: "Bearer short", "x-aos-host-id": "host-1" }
      });
      assert.equal(shortToken.status, 503);
      assert.equal((await shortToken.json()).code, "runner-token-too-short");
    } finally {
      process.env.AOS_RUNNER_JOB_TOKEN = previous;
    }
  });
});
